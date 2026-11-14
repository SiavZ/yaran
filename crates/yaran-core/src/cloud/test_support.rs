//! Test doubles for Yaran Cloud: a loopback mock Worker, sample claim and credentials
//! records, and a signature verifier that checks requests against 02's canonical string.
//!
//! Compiled only for tests and the `test-support` feature (a dev-dependency feature of
//! yaran-tui and yaran-web), so none of it ships. Nothing here talks to a real control
//! plane: the mock binds `127.0.0.1:0` and answers from a handler closure.
//!
//! - The mock serves one request per connection (`Connection: close`) on its own thread
//!   and stops when dropped.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/test_support.rs
//! ├── cloud::credentials
//! ├── cloud::paths
//! ├── cloud::protocol::machine
//! ├── cloud::protocol::meta
//! ├── cloud::protocol::rules
//! └── cloud::protocol::signing
//! External: ring, serde_json, std
//!
//! Used by:
//! cloud/test_support.rs
//! ├── cloud
//! ├── cloud::cli::tests
//! ├── cloud::credentials::tests
//! ├── cloud::login_session
//! ├── cloud::machine_api::tests
//! ├── cloud::signed_request
//! ├── cloud::status
//! ├── yaran-core[test cloud_login]
//! ├── yaran-core[test cloud_machine_api]
//! ├── yaran-core[test cloud_push_emitter]
//! ├── yaran-tui::app::cloud_tests
//! ├── yaran-web::cloud_ingress_tests
//! ├── yaran-web::cloud_phone_routes
//! └── yaran-web::cloud_routes::tests
//! <module-headers:end>

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use ring::rand::SystemRandom;
use ring::signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey};

use crate::cloud::credentials::{Credentials, HandoffConsentKey};
use crate::cloud::paths::CloudPaths;
use crate::cloud::protocol::machine::{ClaimResponse, MachineAccess, TunnelCredentials};
use crate::cloud::protocol::meta::OrgRef;
use crate::cloud::protocol::rules::b64url_decode;
use crate::cloud::protocol::signing::{self, RequestParts};

pub const SAMPLE_ORG: &str = "https://cloud.example.com";
pub const SAMPLE_MACHINE_ID: &str = "0b5b0f9e-6a49-4c8b-9a0e-2f8f8c8f0a11";
pub const SAMPLE_TUNNEL_ID: &str = "7d1e3c2a-1b4f-4e8a-9c3d-5a6b7c8d9e0f";
pub const SAMPLE_HOSTNAME: &str = "laptop-sam.machines.example.com";

/// A schema-valid claim answer for `org_url`.
pub fn sample_claim(org_url: &str) -> ClaimResponse {
    ClaimResponse {
        machine_id: SAMPLE_MACHINE_ID.into(),
        machine_name: "laptop".into(),
        hostname: SAMPLE_HOSTNAME.into(),
        url: format!("https://{SAMPLE_HOSTNAME}"),
        origin_port: 3890,
        tunnel: TunnelCredentials {
            id: SAMPLE_TUNNEL_ID.into(),
            token: "tunnel-token-secret-1".into(),
            token_version: 1,
        },
        access: MachineAccess {
            team_domain: "team.cloudflareaccess.com".into(),
            aud: "a".repeat(64),
        },
        owner_email: "sam@example.com".into(),
        user_slug: "sam".into(),
        org: OrgRef {
            name: "Example Org".into(),
            url: org_url.into(),
        },
        protocol: 1,
    }
}

/// A fresh PKCS#8 machine key.
pub fn new_key_pkcs8() -> Vec<u8> {
    Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
        .expect("keygen")
        .as_ref()
        .to_vec()
}

/// Sample credentials for `org_url`, with a real key.
pub fn sample_credentials(org_url: &str) -> Credentials {
    let consent = HandoffConsentKey::generate(1).expect("consent key");
    Credentials::from_claim(
        &sample_claim(org_url),
        &new_key_pkcs8(),
        &consent,
        "2026-11-14T12:00:00Z".into(),
    )
}

/// Write sample credentials into `paths` and return them.
pub fn pair_sample(paths: &CloudPaths, org_url: &str) -> Credentials {
    let creds = sample_credentials(org_url);
    crate::cloud::credentials::update(paths, |_| Ok(Some(creds.clone()))).expect("write");
    creds
}

/// One request the mock received.
#[derive(Clone, Debug, Default)]
pub struct RecordedRequest {
    pub method: String,
    /// Path without the query.
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl RecordedRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }

    /// Whether the SIG headers verify under `public_key` (02 §7).
    pub fn signature_verifies(&self, public_key: &[u8]) -> bool {
        let (Some(protocol), Some(ts), Some(nonce), Some(sig), Some(host)) = (
            self.header("Yaran-Protocol"),
            self.header("Yaran-Timestamp"),
            self.header("Yaran-Nonce"),
            self.header("Yaran-Signature"),
            self.header("Host"),
        ) else {
            return false;
        };
        let parts = RequestParts {
            method: &self.method,
            path: &self.path,
            host,
            protocol: protocol.parse().unwrap_or(0),
            machine_id: self.header("Yaran-Machine-Id"),
        };
        let Ok(canonical) =
            signing::canonical_string(&parts, ts.parse().unwrap_or(0), nonce, &self.body)
        else {
            return false;
        };
        let Some(sig) = b64url_decode(sig) else {
            return false;
        };
        UnparsedPublicKey::new(&ED25519, public_key)
            .verify(canonical.as_bytes(), &sig)
            .is_ok()
    }
}

/// What the mock answers.
#[derive(Clone, Debug)]
pub struct MockResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl MockResponse {
    pub fn json(status: u16, body: serde_json::Value) -> Self {
        Self {
            status,
            headers: vec![("Yaran-Request-Id".into(), "req-mock-1".into())],
            body: body.to_string(),
        }
    }

    /// A 02 §4 error envelope.
    pub fn error(status: u16, code: &str, message: &str) -> Self {
        Self::json(
            status,
            serde_json::json!({
                "error": {"code": code, "message": message, "retryable": false},
                "request_id": "req-mock-1"
            }),
        )
    }
}

type Handler = dyn Fn(&RecordedRequest) -> MockResponse + Send + Sync;

/// A std-thread HTTP/1.1 server on loopback standing in for the org Worker.
pub struct MockWorker {
    pub addr: SocketAddr,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MockWorker {
    pub fn start(
        handler: impl Fn(&RecordedRequest) -> MockResponse + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock worker");
        listener.set_nonblocking(true).expect("nonblocking");
        let addr = listener.local_addr().expect("addr");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let handler: Arc<Handler> = Arc::new(handler);
        let thread = {
            let (requests, stop) = (Arc::clone(&requests), Arc::clone(&stop));
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((stream, _)) => serve(stream, &handler, &requests),
                        Err(_) => std::thread::sleep(Duration::from_millis(5)),
                    }
                }
            })
        };
        Self {
            addr,
            requests,
            stop,
            thread: Some(thread),
        }
    }

    /// `http://127.0.0.1:<port>`, the transport base for `MachineApi::with_test_transport`.
    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for MockWorker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn serve(stream: TcpStream, handler: &Arc<Handler>, log: &Mutex<Vec<RecordedRequest>>) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let mut it = line.split_whitespace();
    let method = it.next().unwrap_or_default().to_string();
    let target = it.next().unwrap_or_default().to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target, String::new()),
    };
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let len = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; len];
    let _ = reader.read_exact(&mut body);
    let req = RecordedRequest {
        method,
        path,
        query,
        headers,
        body,
    };
    let resp = handler(&req);
    log.lock().unwrap().push(req);
    let mut out = format!(
        "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        resp.status,
        resp.body.len()
    );
    for (k, v) in &resp.headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    out.push_str(&resp.body);
    let mut stream = reader.into_inner();
    let _ = stream.write_all(out.as_bytes());
    let _ = stream.flush();
}

/// The public key of a PKCS#8 document.
pub fn public_key_of(pkcs8: &[u8]) -> Vec<u8> {
    Ed25519KeyPair::from_pkcs8(pkcs8)
        .expect("pkcs8")
        .public_key()
        .as_ref()
        .to_vec()
}
