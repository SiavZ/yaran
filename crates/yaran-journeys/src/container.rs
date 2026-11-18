//! What every container a journey starts has in common: it is created, started,
//! read and removed through the `docker` CLI, and it carries the suite's
//! labels, a name reaper, a log buffer, and ports published one way.
//!
//! PORTS ARE PUBLISHED ON THE HOST'S LOOPBACK ONLY. A port published with no
//! host address binds every host interface, and Docker's own firewall rules
//! sit in front of the host's, so for the length of a run an unauthenticated
//! yaran, the relays and chromedriver would be reachable from the local
//! network. Every published port here binds `127.0.0.1` on an ephemeral host
//! port instead, and [`ContainerRequest::publish_loopback`] is the one place
//! that says so.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt as _, AsyncRead, AsyncWriteExt as _, BufReader};
use tokio::process::Command;

use crate::image::{LABEL, Reaper};
use crate::run::{RUN_LABEL, run_id};
use crate::util::{LogBuffer, container_logs, suffix};

/// When a started container counts as ready.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Ready {
    /// Once its output contains this text.
    Log(&'static str),
    /// After this long.
    After(Duration),
}

/// A container about to be created: `docker create` flags, an image, a
/// command, and files copied in before it starts.
#[derive(Debug)]
pub(crate) struct ContainerRequest {
    image: String,
    name: String,
    reaper: Reaper,
    logs: LogBuffer,
    args: Vec<String>,
    cmd: Vec<String>,
    files: Vec<(String, Vec<u8>)>,
}

impl ContainerRequest {
    /// A container of `image`, named for this journey and `kind`, labelled as
    /// this run's, with its log buffer recorded against the running journey.
    /// Its reaper exists from here on, so a start cancelled at any point still
    /// removes whatever Docker made.
    pub(crate) fn new(kind: &str, image: String) -> Self {
        let name = format!("yaran-journeys-{kind}-{}", suffix());
        let args = vec![
            "--name".to_string(),
            name.clone(),
            "--label".to_string(),
            format!("{LABEL}=1"),
            "--label".to_string(),
            format!("{RUN_LABEL}={}", run_id()),
            // An init process as PID 1, so the container's own process (often a
            // shell) gets its signals and the container stops at once.
            "--init".to_string(),
        ];
        Self {
            image,
            reaper: Reaper(name.clone()),
            logs: container_logs(&name),
            name,
            args,
            cmd: Vec::new(),
            files: Vec::new(),
        }
    }

    /// The container's name.
    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    /// One `docker create` flag and its value.
    pub(crate) fn arg(mut self, flag: &str, value: impl Into<String>) -> Self {
        self.args.push(flag.to_string());
        self.args.push(value.into());
        self
    }

    /// An environment variable for the container.
    pub(crate) fn env(self, key: &str, value: impl std::fmt::Display) -> Self {
        self.arg("--env", format!("{key}={value}"))
    }

    /// Publish exactly `ports`, each on `127.0.0.1` with an ephemeral host port.
    pub(crate) fn publish_loopback(self, ports: &[u16]) -> Self {
        ports.iter().fold(self, |request, port| {
            request.arg("--publish", format!("127.0.0.1::{port}/tcp"))
        })
    }

    /// Join another container's network namespace. Such a container publishes
    /// nothing (a namespace that is not its own cannot publish).
    pub(crate) fn share_namespace_of(self, container_id: &str) -> Self {
        self.arg("--network", format!("container:{container_id}"))
    }

    /// Bind-mount `source` on the host read-only at `target`.
    pub(crate) fn mount_read_only(self, source: &str, target: &str) -> Self {
        // `--mount` is CSV: quoting the field keeps a comma in the path a path.
        let source = format!("\"source={}\"", source.replace('"', "\"\""));
        self.arg(
            "--mount",
            format!("type=bind,{source},target={target},readonly"),
        )
    }

    /// The command the image's entrypoint is given.
    pub(crate) fn cmd(mut self, cmd: Vec<String>) -> Self {
        self.cmd = cmd;
        self
    }

    /// Copy `bytes` into the container at `path` before it starts.
    pub(crate) fn copy_to(mut self, path: impl Into<String>, bytes: Vec<u8>) -> Self {
        self.files.push((path.into(), bytes));
        self
    }

    /// Create the container, copy its files in, start it, follow its output
    /// into its log buffer, and wait until it is `ready`, for at most `within`.
    pub(crate) async fn start(self, ready: Ready, within: Duration) -> Result<Container, String> {
        let mut create = vec!["create".to_string()];
        create.extend(self.args);
        create.push(self.image);
        create.extend(self.cmd);
        let id = docker(&create, None).await?;
        let container = Container {
            id,
            name: self.name,
            logs: self.logs,
            _reaper: self.reaper,
        };
        if !self.files.is_empty() {
            let into = format!("{}:/", container.id);
            docker(&["cp", "-", into.as_str()], Some(tar(&self.files))).await?;
        }
        docker(&["start", container.id.as_str()], None).await?;
        follow_logs(&container.id, container.logs.clone())?;
        match ready {
            Ready::After(pause) => tokio::time::sleep(pause).await,
            Ready::Log(needle) => container.wait_ready(needle, within).await?,
        }
        Ok(container)
    }
}

/// A running container. Removed when dropped, whatever state it reached.
#[derive(Debug)]
pub(crate) struct Container {
    id: String,
    name: String,
    logs: LogBuffer,
    _reaper: Reaper,
}

impl Container {
    /// The container's id.
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    /// Everything the container has printed so far, both streams.
    pub(crate) fn logs(&self) -> String {
        self.logs.text()
    }

    /// The host port Docker published `container_port` on (on loopback).
    pub(crate) async fn host_port(&self, container_port: u16) -> Result<u16, String> {
        let listed = docker(
            &["port", self.id.as_str(), &format!("{container_port}/tcp")],
            None,
        )
        .await?;
        listed
            .lines()
            .find_map(|line| line.trim().strip_prefix("127.0.0.1:")?.parse().ok())
            .ok_or_else(|| format!("no loopback binding in {listed:?}"))
    }

    /// Whether the container is running right now.
    pub(crate) async fn is_running(&self) -> bool {
        docker(
            &[
                "container",
                "inspect",
                "--format",
                "{{.State.Running}}",
                self.id.as_str(),
            ],
            None,
        )
        .await
        .is_ok_and(|running| running == "true")
    }

    /// Run `argv` in the container and collect what it did. `Err` only when
    /// the `docker` CLI itself cannot be run.
    pub(crate) async fn exec(&self, argv: &[&str]) -> Result<std::process::Output, String> {
        Command::new("docker")
            .arg("exec")
            .arg(&self.id)
            .args(argv)
            .output()
            .await
            .map_err(|err| format!("run docker exec: {err}"))
    }

    /// Wait until the output contains `needle`, failing early if the container
    /// stops first.
    async fn wait_ready(&self, needle: &str, within: Duration) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            if self.logs.text().contains(needle) {
                return Ok(());
            }
            if !self.is_running().await {
                return Err(format!(
                    "{} stopped before it printed {needle:?}",
                    self.name
                ));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!(
                    "{} did not print {needle:?} within {within:?}",
                    self.name
                ));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}

/// Run `docker args`, feeding it `stdin`, and return its trimmed stdout, or
/// what it said on stderr when it fails.
async fn docker<S: AsRef<str>>(args: &[S], stdin: Option<Vec<u8>>) -> Result<String, String> {
    let args: Vec<&str> = args.iter().map(AsRef::as_ref).collect();
    let mut child = Command::new("docker")
        .args(&args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| format!("run docker (is Docker installed and running?): {err}"))?;
    if let (Some(bytes), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(&bytes)
            .await
            .map_err(|err| format!("write to docker {}: {err}", args[0]))?;
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|err| format!("wait for docker {}: {err}", args[0]))?;
    if !output.status.success() {
        return Err(format!(
            "docker {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Follow container `id`'s output, both streams, into `logs` line by line,
/// from its first line. The follower ends when the container is removed.
fn follow_logs(id: &str, logs: LogBuffer) -> Result<(), String> {
    let mut child = Command::new("docker")
        .args(["logs", "--follow", id])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| format!("run docker logs: {err}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    tokio::spawn(async move {
        tokio::join!(copy_lines(stdout, &logs), copy_lines(stderr, &logs));
        let _ = child.wait().await;
    });
    Ok(())
}

async fn copy_lines(from: impl AsyncRead + Unpin, into: &LogBuffer) {
    let mut from = BufReader::new(from);
    let mut line = Vec::new();
    while from.read_until(b'\n', &mut line).await.is_ok_and(|n| n > 0) {
        into.push(&String::from_utf8_lossy(&line));
        line.clear();
    }
}

/// `files` as a tar archive of plain files (mode 0644, owned by root, paths
/// relative to `/`), which `docker cp - <id>:/` unpacks, creating any parent
/// directory the image lacks.
pub(crate) fn tar(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut archive = Vec::new();
    for (path, bytes) in files {
        let name = path.trim_start_matches('/');
        assert!(
            name.len() <= 100,
            "{path} is too long for a plain tar header"
        );
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[100..107].copy_from_slice(b"0000644");
        header[108..115].copy_from_slice(b"0000000");
        header[116..123].copy_from_slice(b"0000000");
        header[124..135].copy_from_slice(format!("{:011o}", bytes.len()).as_bytes());
        header[136..147].copy_from_slice(b"00000000000");
        header[148..156].fill(b' ');
        header[156] = b'0';
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        let sum: u32 = header.iter().map(|&b| u32::from(b)).sum();
        header[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
        archive.extend_from_slice(&header);
        archive.extend_from_slice(bytes);
        archive.resize(archive.len().next_multiple_of(512), 0);
    }
    archive.resize(archive.len() + 1024, 0);
    archive
}

/// The host side of every port binding of a container, as Docker reports it:
/// `(container port, host ip, host port)`. For the test that proves nothing is
/// published beyond loopback.
///
/// # Panics
///
/// When `docker container inspect` cannot run or does not print JSON.
pub async fn published_bindings(container_id: &str) -> Vec<(String, String, String)> {
    let output = Command::new("docker")
        .args([
            "container",
            "inspect",
            "--format",
            "{{json .NetworkSettings.Ports}}",
            container_id,
        ])
        .output()
        .await
        .expect("docker container inspect");
    let ports: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("the inspected ports are JSON");
    let mut bindings = Vec::new();
    if let Some(map) = ports.as_object() {
        for (port, list) in map {
            for binding in list.as_array().into_iter().flatten() {
                bindings.push((
                    port.clone(),
                    binding["HostIp"].as_str().unwrap_or_default().to_string(),
                    binding["HostPort"].as_str().unwrap_or_default().to_string(),
                ));
            }
        }
    }
    bindings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tar_archive_unpacks_to_the_files_with_their_parents() {
        let dir = std::env::temp_dir().join(format!("yaran-journeys-tar-{}", suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        let files = vec![
            (
                "/journey/seed.d/10-journey.sh".to_string(),
                b"echo hi\n".to_vec(),
            ),
            ("/etc/empty".to_string(), Vec::new()),
            ("/data/big".to_string(), vec![b'x'; 1500]),
        ];
        let archive = dir.join("files.tar");
        std::fs::write(&archive, tar(&files)).unwrap();
        let status = std::process::Command::new("tar")
            .arg("-xf")
            .arg(&archive)
            .arg("-C")
            .arg(&dir)
            .status()
            .expect("run tar");
        assert!(status.success());
        for (path, bytes) in &files {
            let unpacked = dir.join(path.trim_start_matches('/'));
            assert_eq!(&std::fs::read(&unpacked).unwrap(), bytes, "{path}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
