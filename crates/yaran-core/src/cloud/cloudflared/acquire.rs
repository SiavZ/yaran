//! Getting the cloudflared binary yaran will run: the managed, pinned and double-hashed
//! download, or the user's own binary checked against the version floor.
//!
//! The managed binary lives at `<cloud dir>/bin/cloudflared-<version>`, mode 0700, in a
//! 0700 directory, and is re-hashed before every start. A missing or tampered binary is
//! downloaded again; any mismatch deletes every temp file and fails closed.
//!
//! - Blocking network and disk I/O: called only on the leg's supervisor thread.
//! - Trust boundary: the downloaded bytes. Nothing is made executable before both hashes
//!   (asset, then extracted binary) match the generated pin.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/cloudflared/acquire.rs
//! ├── cloud::cloudflared::acquire::tests
//! ├── cloud::cloudflared::pins
//! ├── cloud::cloudflared::targz
//! ├── cloud::cloudflared::version
//! └── file_modes
//! External: ring, std, ureq
//!
//! Used by:
//! cloud/cloudflared/acquire.rs
//! ├── cloud::cloudflared
//! ├── cloud::cloudflared::acquire::tests
//! ├── cloud::leg
//! ├── cloud::leg::tests
//! ├── cloud::leg_outcome::tests
//! ├── cloud::leg_run
//! └── cloud::leg_start
//! <module-headers:end>

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::pins::{AssetKind, Pin, UNPINNED};
use super::version::{self, CfVersion, VersionRefusal};

/// Where release assets are downloaded from; `<base>/<version>/<asset>`.
pub const DOWNLOAD_BASE: &str = "https://github.com/cloudflare/cloudflared/releases/download";
/// Cap on a downloaded asset.
pub const MAX_ASSET_BYTES: u64 = 150 * 1024 * 1024;
/// Cap on the binary extracted from an archive.
pub const MAX_BINARY_BYTES: u64 = 200 * 1024 * 1024;
/// ureq 3.3 has no per-read idle timeout, so the body read is capped as a whole.
const BODY_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Why there is no binary to run. Every variant fails closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BinaryUnavailable {
    UnsupportedTarget,
    NotPinned {
        version: String,
    },
    HashMismatch {
        what: &'static str,
        expected: String,
        actual: String,
    },
    Download(String),
    TooLarge,
    Archive(String),
    Io(String),
    Cancelled,
    Missing {
        path: String,
    },
    TooOld {
        found: CfVersion,
    },
    Unparseable {
        output: String,
    },
    ProbeFailed {
        detail: String,
    },
}

impl std::fmt::Display for BinaryUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let min = version::MIN_VERSION;
        match self {
            Self::UnsupportedTarget => f.write_str(
                "yaran has no pinned cloudflared for this platform; set [cloud] cloudflared_path \
                 to a cloudflared you installed",
            ),
            Self::NotPinned { version } => write!(
                f,
                "this build carries no verified checksums for cloudflared {version}, so yaran will \
                 not download it; set [cloud] cloudflared_path to a cloudflared you installed"
            ),
            Self::HashMismatch {
                what,
                expected,
                actual,
            } => write!(
                f,
                "the downloaded cloudflared {what} did not match its pinned checksum (expected \
                 {expected}, got {actual}) and was deleted; set [cloud] cloudflared_path to use \
                 your own binary"
            ),
            Self::Download(e) => write!(f, "downloading cloudflared failed ({e})"),
            Self::TooLarge => f.write_str("the cloudflared download was larger than yaran accepts"),
            Self::Archive(e) => write!(f, "the cloudflared archive was refused: {e}"),
            Self::Io(e) => write!(f, "storing cloudflared failed ({e})"),
            Self::Cancelled => f.write_str("the cloudflared download was cancelled"),
            Self::Missing { path } => write!(
                f,
                "[cloud] cloudflared_path names {path}, which cannot be run; fix the path or empty \
                 it to use yaran's managed cloudflared"
            ),
            Self::TooOld { found } => write!(
                f,
                "the configured cloudflared is version {found}, below the minimum {min} needed \
                 for per-route Cloudflare Access enforcement and the VULN-170057 fix; upgrade it \
                 or empty [cloud] cloudflared_path to use yaran's managed cloudflared"
            ),
            Self::Unparseable { output } => write!(
                f,
                "the configured cloudflared did not report a version yaran understands ({output}), \
                 so it is not run; empty [cloud] cloudflared_path to use yaran's managed cloudflared"
            ),
            Self::ProbeFailed { detail } => write!(
                f,
                "the configured cloudflared could not be asked for its version ({detail}); empty \
                 [cloud] cloudflared_path to use yaran's managed cloudflared"
            ),
        }
    }
}

impl From<VersionRefusal> for BinaryUnavailable {
    fn from(refusal: VersionRefusal) -> Self {
        match refusal {
            VersionRefusal::TooOld { found } => Self::TooOld { found },
            VersionRefusal::Unparseable { output } => Self::Unparseable { output },
            VersionRefusal::ProbeFailed { detail } => Self::ProbeFailed { detail },
        }
    }
}

fn io_err(e: std::io::Error) -> BinaryUnavailable {
    BinaryUnavailable::Io(e.to_string())
}

/// The binary to spawn, and an optional warning to post once for this start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Acquired {
    pub path: PathBuf,
    pub warning: Option<String>,
}

/// Download progress; `total` is the `Content-Length` when the server sent one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub done: u64,
    pub total: Option<u64>,
}

/// Where and how the managed path downloads.
#[derive(Debug, Clone)]
pub struct ManagedSource {
    pub base_url: String,
    pub request_timeout: Duration,
}

/// The user's own binary: it must exist and report a version at or above the floor.
pub fn user_binary(path: &str) -> Result<Acquired, BinaryUnavailable> {
    let bin = PathBuf::from(path);
    if !bin.is_file() {
        return Err(BinaryUnavailable::Missing {
            path: path.to_string(),
        });
    }
    let probed = version::probe_user_binary(&bin)?;
    let warning = probed.outside_support_window.then(|| {
        format!(
            "the configured cloudflared {} is more than a year older than yaran's pinned release, \
             outside Cloudflare's support window; upgrade it soon",
            probed.version
        )
    });
    Ok(Acquired { path: bin, warning })
}

/// The managed binary: re-hash what is on disk, download it again when missing or wrong.
/// `progress` answers `false` to cancel the download.
pub fn managed_binary(
    cloud_dir: &Path,
    pin: &Pin,
    version: &str,
    source: &ManagedSource,
    progress: &mut dyn FnMut(Progress) -> bool,
) -> Result<PathBuf, BinaryUnavailable> {
    if pin.asset_sha256 == UNPINNED || pin.binary_sha256 == UNPINNED {
        return Err(BinaryUnavailable::NotPinned {
            version: version.to_string(),
        });
    }
    let bin_dir = cloud_dir.join("bin");
    crate::file_modes::create_private_dir_all(&bin_dir).map_err(io_err)?;
    let target = bin_dir.join(format!("cloudflared-{version}"));
    if target.is_file() && sha256_file(&target).map_err(io_err)? == pin.binary_sha256 {
        return Ok(target);
    }
    let _ = fs::remove_file(&target);
    let part = bin_dir.join(format!("cloudflared-{version}.part"));
    let extracted = bin_dir.join(format!("cloudflared-{version}.bin.part"));
    let result = download_and_verify(pin, version, source, &part, &extracted, progress);
    let staged = match (result, pin.kind) {
        (Ok(()), AssetKind::Raw) => part.clone(),
        (Ok(()), AssetKind::Tgz) => extracted.clone(),
        (Err(e), _) => {
            let _ = fs::remove_file(&part);
            let _ = fs::remove_file(&extracted);
            return Err(e);
        }
    };
    let finish = || -> std::io::Result<()> {
        fs::set_permissions(
            &staged,
            fs::Permissions::from_mode(crate::file_modes::PRIVATE_EXEC_MODE),
        )?;
        fs::rename(&staged, &target)
    };
    let finished = finish();
    let _ = fs::remove_file(&part);
    let _ = fs::remove_file(&extracted);
    finished.map_err(io_err)?;
    remove_older(&bin_dir, &target);
    Ok(target)
}

fn download_and_verify(
    pin: &Pin,
    version: &str,
    source: &ManagedSource,
    part: &Path,
    extracted: &Path,
    progress: &mut dyn FnMut(Progress) -> bool,
) -> Result<(), BinaryUnavailable> {
    let url = format!(
        "{}/{version}/{}",
        source.base_url.trim_end_matches('/'),
        pin.asset
    );
    let asset_hash = download(&url, source, part, progress)?;
    check("archive", pin.asset_sha256, &asset_hash)?;
    match pin.kind {
        AssetKind::Raw => check("binary", pin.binary_sha256, &asset_hash),
        AssetKind::Tgz => {
            let mut out = private_create(extracted).map_err(io_err)?;
            let archive = fs::File::open(part).map_err(io_err)?;
            super::targz::extract_cloudflared(archive, &mut out, MAX_BINARY_BYTES).map_err(
                |e| match e {
                    super::targz::TarError::TooLarge => BinaryUnavailable::TooLarge,
                    other => BinaryUnavailable::Archive(other.to_string()),
                },
            )?;
            out.sync_all().map_err(io_err)?;
            check(
                "binary",
                pin.binary_sha256,
                &sha256_file(extracted).map_err(io_err)?,
            )
        }
    }
}

fn check(what: &'static str, expected: &str, actual: &str) -> Result<(), BinaryUnavailable> {
    if expected.eq_ignore_ascii_case(actual) {
        Ok(())
    } else {
        Err(BinaryUnavailable::HashMismatch {
            what,
            expected: expected.to_string(),
            actual: actual.to_string(),
        })
    }
}

/// Stream `url` into a fresh 0600 `part` file, hashing as it goes, and answer the hash.
fn download(
    url: &str,
    source: &ManagedSource,
    part: &Path,
    progress: &mut dyn FnMut(Progress) -> bool,
) -> Result<String, BinaryUnavailable> {
    let loopback = url.starts_with("http://127.0.0.1");
    let mut builder = ureq::Agent::config_builder()
        .timeout_connect(Some(source.request_timeout))
        .timeout_recv_response(Some(source.request_timeout))
        .timeout_recv_body(Some(BODY_TIMEOUT))
        .https_only(!loopback)
        .http_status_as_error(false);
    if loopback {
        builder = builder.proxy(None);
    }
    let agent: ureq::Agent = builder.build().into();
    let response = agent
        .get(url)
        .call()
        .map_err(|e| BinaryUnavailable::Download(e.to_string()))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(BinaryUnavailable::Download(format!(
            "HTTP {status} from {url}"
        )));
    }
    let total = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if total.is_some_and(|t| t > MAX_ASSET_BYTES) {
        return Err(BinaryUnavailable::TooLarge);
    }
    let mut reader = response.into_body().into_reader();
    let _ = fs::remove_file(part);
    let mut out = private_create(part).map_err(io_err)?;
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = 0u64;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| BinaryUnavailable::Download(e.to_string()))?;
        if n == 0 {
            break;
        }
        done += n as u64;
        if done > MAX_ASSET_BYTES {
            return Err(BinaryUnavailable::TooLarge);
        }
        hash.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(io_err)?;
        if !progress(Progress { done, total }) {
            return Err(BinaryUnavailable::Cancelled);
        }
    }
    if total.is_some_and(|t| t != done) {
        return Err(BinaryUnavailable::Download(
            "the download was truncated".into(),
        ));
    }
    out.sync_all().map_err(io_err)?;
    Ok(hex(hash.finish().as_ref()))
}

fn private_create(path: &Path) -> std::io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(crate::file_modes::PRIVATE_FILE_MODE)
        .open(path)
}

/// Remove every other `cloudflared-*` file in the managed directory.
fn remove_older(bin_dir: &Path, keep: &Path) {
    let Ok(entries) = fs::read_dir(bin_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if path != keep && name.to_string_lossy().starts_with("cloudflared-") {
            let _ = fs::remove_file(path);
        }
    }
}

/// Lowercase hex SHA-256 of a file.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            return Ok(hex(hash.finish().as_ref()));
        }
        hash.update(&buf[..n]);
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
#[path = "acquire_tests.rs"]
mod tests;
