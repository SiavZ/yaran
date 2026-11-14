//! A std `TcpListener` stand-in for the org Worker's machine routes (W5 config, W6 events).
//!
//! Verifies every request's 02 signature against the shared fixture key, validates every
//! events body as 02's `EventBatch`, serves a scripted `MachineConfig`, and answers
//! `POST /v1/machine/events` from a script (accept-all once the script is empty).
//!
//! - Test-only; one thread per mock, one request per connection (`Connection: close`).
//!
//! <module-headers:begin>
//! Uses:
//! tests/support/mock_worker.rs
//! ├── yaran-core::cloud::protocol
//! ├── yaran-core::cloud::protocol::machine
//! ├── yaran-core::cloud::protocol::rules
//! └── yaran-core::cloud::protocol::signing
//! External: ring, serde_json, std
//!
//! Used by:
//! tests/support/mock_worker.rs
//! └── crate
//! <module-headers:end>

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ring::signature::{ED25519, Ed25519KeyPair, UnparsedPublicKey};
use serde_json::{Value, json};
use yaran_core::cloud::protocol::Validate;
use yaran_core::cloud::protocol::machine::EventBatch;
use yaran_core::cloud::protocol::rules::b64url_decode;
use yaran_core::cloud::protocol::signing::{RequestParts, canonical_string};

pub const MACHINE_ID: &str = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b";

/// How the mock answers one `POST /v1/machine/events`.
#[derive(Clone, Debug)]
pub enum Answer {
    Accept,
    AcceptAsDuplicates,
    AcceptPushOff,
    /// Status, error code, optional `Retry-After` seconds, optional `details`.
    Error(u16, &'static str, Option<u64>, Option<Value>),
    /// Read the request and never answer.
    Hang,
}

#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub verified: bool,
    pub at: Instant,
    /// The parsed events body (`Null` for GET).
    pub body: Value,
}

pub struct MockWorker {
    pub base: String,
    pub seen: Arc<Mutex<Vec<Seen>>>,
    pub answers: Arc<Mutex<VecDeque<Answer>>>,
    pub config: Arc<Mutex<Value>>,
}

fn fixture(path: &str) -> Value {
    let full = format!(
        "{}/../../cloud/protocol/fixtures/{path}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(full).expect("fixture")).expect("json")
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

/// The 02 test machine key's PKCS#8 v2 bytes (`fixtures/sig/machine-request.json`).
pub fn machine_key_pkcs8() -> Vec<u8> {
    unhex(
        fixture("sig/machine-request.json")["pkcs8_v2_hex"]
            .as_str()
            .unwrap(),
    )
}

/// The 02 test machine key (`fixtures/sig/machine-request.json`).
pub fn machine_key() -> (Ed25519KeyPair, Vec<u8>) {
    let f = fixture("sig/machine-request.json");
    let key = Ed25519KeyPair::from_pkcs8(&machine_key_pkcs8()).expect("pkcs8");
    let public = b64url_decode(f["public_key"].as_str().unwrap()).expect("public key");
    (key, public)
}

/// 02's own `MachineConfig` fixture, spaced for tests.
pub fn machine_config() -> Value {
    let mut config = fixture("api/MachineConfig.json")["valid"][0]["value"].clone();
    config["events"]["min_interval_ms"] = json!(0);
    config
}

impl MockWorker {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("addr");
        let mock = Self {
            base: format!("http://{addr}"),
            seen: Arc::default(),
            answers: Arc::default(),
            config: Arc::new(Mutex::new(machine_config())),
        };
        let (seen, answers, config) =
            (mock.seen.clone(), mock.answers.clone(), mock.config.clone());
        let public = machine_key().1;
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (seen, answers, config, public) = (
                    seen.clone(),
                    answers.clone(),
                    config.clone(),
                    public.clone(),
                );
                std::thread::spawn(move || serve(stream, &seen, &answers, &config, &public));
            }
        });
        mock
    }

    pub fn script(&self, answers: impl IntoIterator<Item = Answer>) {
        self.answers.lock().unwrap().extend(answers);
    }

    pub fn posts(&self) -> Vec<Seen> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.method == "POST")
            .cloned()
            .collect()
    }

    pub fn config_gets(&self) -> usize {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.method == "GET")
            .count()
    }

    pub fn wait_for_posts(&self, n: usize) -> Vec<Seen> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let posts = self.posts();
            if posts.len() >= n {
                return posts;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {n} posts, saw {}",
                posts.len()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

fn serve(
    stream: TcpStream,
    seen: &Mutex<Vec<Seen>>,
    answers: &Mutex<VecDeque<Answer>>,
    config: &Mutex<Value>,
    public: &[u8],
) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok();
    let mut parts = line.split_whitespace();
    let (method, path) = (
        parts.next().unwrap_or("").to_string(),
        parts.next().unwrap_or("").to_string(),
    );
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    let header = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    };
    let len: usize = header("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0; len];
    reader.read_exact(&mut body).ok();
    let verified = (|| {
        let parts = RequestParts {
            method: &method,
            path: &path,
            host: &header("host")?,
            protocol: header("yaran-protocol")?.parse().ok()?,
            machine_id: Some(&header("yaran-machine-id")?),
        };
        let canonical = canonical_string(
            &parts,
            header("yaran-timestamp")?.parse().ok()?,
            &header("yaran-nonce")?,
            &body,
        )
        .ok()?;
        let signature = b64url_decode(&header("yaran-signature")?)?;
        UnparsedPublicKey::new(&ED25519, public)
            .verify(canonical.as_bytes(), &signature)
            .ok()
    })()
    .is_some();
    let parsed = if method == "POST" {
        let batch: EventBatch = serde_json::from_slice(&body).expect("body is an EventBatch");
        batch.validate().expect("EventBatch validates");
        serde_json::from_slice(&body).unwrap()
    } else {
        Value::Null
    };
    let ids: Vec<Value> = parsed["events"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|e| e["id"].clone())
        .collect();
    seen.lock().unwrap().push(Seen {
        method: method.clone(),
        path: path.clone(),
        verified,
        at: Instant::now(),
        body: parsed,
    });
    let answer = if method == "GET" {
        Answer::Accept
    } else {
        answers
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Answer::Accept)
    };
    let (status, extra, out) = match (method.as_str(), answer) {
        ("GET", _) => (200, String::new(), config.lock().unwrap().clone()),
        (_, Answer::Accept) => (
            202,
            String::new(),
            json!({"accepted": ids, "duplicates": [], "push_enabled": true}),
        ),
        (_, Answer::AcceptAsDuplicates) => (
            202,
            String::new(),
            json!({"accepted": [], "duplicates": ids, "push_enabled": true}),
        ),
        (_, Answer::AcceptPushOff) => (
            202,
            String::new(),
            json!({"accepted": ids, "duplicates": [], "push_enabled": false}),
        ),
        (_, Answer::Error(status, code, retry_after, details)) => {
            let mut error = json!({"code": code, "message": format!("mock says {code}"), "retryable": retry_after.is_some()});
            if let Some(d) = details {
                error["details"] = d;
            }
            let extra = retry_after
                .map(|s| format!("Retry-After: {s}\r\n"))
                .unwrap_or_default();
            (
                status,
                extra,
                json!({"error": error, "request_id": "req-1"}),
            )
        }
        (_, Answer::Hang) => {
            std::thread::sleep(Duration::from_secs(30));
            return;
        }
    };
    let out = out.to_string();
    let response = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{out}",
        out.len()
    );
    let mut stream = reader.into_inner();
    let _ = stream.write_all(response.as_bytes());
}
