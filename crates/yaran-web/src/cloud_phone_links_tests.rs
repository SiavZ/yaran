//! The phone routes' decisions: when a direct add-machine code and a phone link target
//! exist, and the sentence a person gets when they do not.
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! cloud_phone_links_tests.rs
//! ├── cloud_phone_links
//! └── yaran-core::cloud::protocol::links
//! External: axum, serde_json, std, tokio
//!
//! Used by:
//! cloud_phone_links_tests.rs
//! └── cloud_phone_links
//! ```
//! <module-headers:end>

use axum::http::StatusCode;
use serde_json::json;
use yaran_core::cloud::protocol::links::{
    AgentLink, AgentLinkTarget, agent_link_url, parse_add_machine_uri,
};

use super::*;

const TS: &str = "laptop.tail1234.ts.net";
const ORG: &str = "https://cp.example.com";
const MID: &str = "0b5f9a8e-6d0e-4f43-9a51-1d6f7d9b1c2a";
const CALLBACK: &str = "https://apps.example.org/auth/callback";

/// Over a transport yaran knows is HTTPS.
fn https(host: &str) -> Arrived {
    Arrived {
        host: Some(host.to_string()),
        https: true,
    }
}

/// Over plain HTTP (or HTTPS yaran cannot vouch for).
fn plain(host: &str) -> Arrived {
    Arrived {
        https: false,
        ..https(host)
    }
}

fn paired() -> Paired {
    Paired {
        org_url: ORG.into(),
        machine_id: MID.into(),
        hostname: "laptop-ada.example.com".into(),
        made_at: "2026-11-17T09:00:00Z".into(),
    }
}

async fn body(resp: Response) -> (StatusCode, serde_json::Value) {
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn the_machine_code_names_the_https_host_the_request_arrived_on() {
    let (status, v) = body(machine_qr(&https(TS), None).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["host"], TS);
    let uri = v["uri"].as_str().unwrap();
    assert_eq!(parse_add_machine_uri(uri).as_deref(), Some(TS));
    assert!(v["svg"].as_str().unwrap().contains("<svg"));
}

#[test]
fn the_machine_code_is_refused_off_a_proven_https_dns_name() {
    let code = |arrived: Arrived, paired: Option<&Paired>| {
        machine_qr(&arrived, paired).err().map(|r| r.code)
    };
    assert_eq!(code(plain(TS), None), Some("not_https"), "plain HTTP");
    for host in [
        "localhost",
        "127.0.0.1",
        "100.101.102.103",
        "laptop.tail1234.ts.net:8443",
        "Laptop.ts.net",
        "laptop",
    ] {
        assert_eq!(code(https(host), None), Some("not_a_public_host"), "{host}");
    }
    let none = Arrived {
        host: None,
        https: true,
    };
    assert_eq!(code(none, None), Some("not_a_public_host"));
    let p = paired();
    assert_eq!(
        code(https("laptop-ada.example.com"), Some(&p)),
        Some("cloud_hostname"),
        "a host cannot be both an org machine and a direct one"
    );
    // A paired machine still offers its direct code on another HTTPS name.
    assert!(machine_qr(&https(TS), Some(&p)).is_ok());
}

#[test]
fn the_not_https_sentence_says_what_to_do_and_trusts_no_forwarded_header() {
    let refusal = direct_host(&plain(TS), None).unwrap_err();
    assert!(
        refusal.message.contains("tailscale serve"),
        "{}",
        refusal.message
    );
    assert!(!refusal.message.to_ascii_lowercase().contains("x-forwarded"));
}

/// Every target handed to the browser builds a link the strict parser accepts.
fn builds(v: &serde_json::Value) -> String {
    let t = &v["target"];
    let target = match t["kind"].as_str().unwrap() {
        "org" => AgentLinkTarget::Org {
            org_url: t["orgUrl"].as_str().unwrap().into(),
            machine_id: t["machineId"].as_str().unwrap().into(),
        },
        _ => AgentLinkTarget::Direct {
            host: t["host"].as_str().unwrap().into(),
        },
    };
    let link = AgentLink {
        target,
        agent_id: "s1".into(),
        tab_id: Some("t2".into()),
    };
    agent_link_url(v["publisher_domain"].as_str().unwrap(), &link).expect("a valid link")
}

#[test]
fn an_org_that_names_a_domain_gets_the_org_form_wherever_the_page_is() {
    let p = paired();
    let org: OrgDomain = Ok(Some("apps.example.org".into()));
    let v = link_target(&plain("localhost"), Some(&p), Some(&org), &[]).unwrap();
    assert_eq!(
        v,
        json!({ "publisher_domain": "apps.example.org", "target": { "kind": "org", "orgUrl": ORG, "machineId": MID } })
    );
    assert_eq!(
        builds(&v),
        format!("https://apps.example.org/open#o=https%3A%2F%2Fcp.example.com&m={MID}&a=s1&t=t2")
    );
}

#[test]
fn a_direct_link_needs_the_machine_own_domain_and_a_proven_https_host() {
    let callbacks = vec![CALLBACK.to_string()];
    let v = link_target(&https(TS), None, None, &callbacks).unwrap();
    assert_eq!(
        v,
        json!({ "publisher_domain": "apps.example.org", "target": { "kind": "direct", "host": TS } })
    );
    assert_eq!(
        builds(&v),
        format!("https://apps.example.org/open#d={TS}&a=s1&t=t2")
    );
    let refused = link_target(&plain(TS), None, None, &callbacks).unwrap_err();
    assert_eq!(refused.code, "not_https");
}

#[test]
fn with_no_domain_configured_there_is_no_link_and_the_sentence_says_why() {
    for callbacks in [
        vec![],
        vec!["https://<publisher-domain>/auth/callback".to_string()],
        vec![
            "https://a.example.org/auth/callback".to_string(),
            "https://b.example.org/auth/callback".to_string(),
        ],
    ] {
        let r = link_target(&https(TS), None, None, &callbacks).unwrap_err();
        assert_eq!(r.code, "no_publisher_domain");
        assert!(r.message.contains("app_callback_urls"), "{}", r.message);
    }
    // Paired, but the org names none (an older control plane) and the machine none.
    let p = paired();
    let r = link_target(&https(TS), Some(&p), Some(&Ok(None)), &[]).unwrap_err();
    assert_eq!(r.code, "no_publisher_domain");
    assert!(r.message.contains("APP_CALLBACK_URLS"), "{}", r.message);
    // Paired and the org unreachable: the direct form still serves when it can,
    let down: OrgDomain = Err("the network is down".into());
    let callbacks = vec![CALLBACK.to_string()];
    let v = link_target(&https(TS), Some(&p), Some(&down), &callbacks).unwrap();
    assert_eq!(v["target"]["kind"], "direct");
    // and when it cannot, the refusal names both reasons.
    let r = link_target(&plain(TS), Some(&p), Some(&down), &callbacks).unwrap_err();
    assert!(
        r.message.contains("the network is down") && r.message.contains("HTTPS"),
        "{}",
        r.message
    );
}

/// A credentials file that answers each read from a script, then repeats its last line.
fn reads(script: Vec<Option<Paired>>) -> impl Fn() -> Option<Paired> {
    let script = std::sync::Mutex::new(std::collections::VecDeque::from(script));
    move || {
        let mut s = script.lock().unwrap();
        if s.len() > 1 {
            s.pop_front().unwrap()
        } else {
            s.front().cloned().flatten()
        }
    }
}

fn pairing_b() -> Paired {
    Paired {
        org_url: "https://cp2.example.com".into(),
        machine_id: "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b".into(),
        hostname: "laptop-ada.example2.com".into(),
        made_at: "2026-11-17T10:00:00Z".into(),
    }
}

/// W5 that answers each pairing's own domain and counts its calls.
fn w5(calls: &std::sync::atomic::AtomicUsize) -> impl Fn(&Paired) -> OrgDomain + '_ {
    move |p| {
        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(Some(if p.org_url == ORG {
            "apps.example.org".into()
        } else {
            "apps2.example.org".into()
        }))
    }
}

#[test]
fn a_re_pair_during_w5_is_retried_and_answers_only_for_the_new_pairing() {
    let cache = DomainCache::new(None);
    let calls = std::sync::atomic::AtomicUsize::new(0);
    // A before W5, B after it (the file was replaced while W5 was out), then B steadily.
    let (who, domain) = pairing_and_domain(
        reads(vec![Some(paired()), Some(pairing_b())]),
        w5(&calls),
        &cache,
    );
    assert_eq!(who, Some(pairing_b()));
    assert_eq!(domain, Some(Ok(Some("apps2.example.org".into()))));
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    // Nothing was cached under A.
    assert_eq!(
        cache
            .lock()
            .unwrap()
            .as_ref()
            .map(|(k, _, d)| (k.clone(), d.clone())),
        Some((pairing_b(), Some("apps2.example.org".into())))
    );
}

#[test]
fn a_pairing_that_keeps_changing_is_refused_in_words_and_never_cached() {
    let cache = DomainCache::new(None);
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let flip = vec![
        Some(paired()),
        Some(pairing_b()),
        Some(paired()),
        Some(pairing_b()),
        Some(pairing_b()),
    ];
    let (who, domain) = pairing_and_domain(reads(flip), w5(&calls), &cache);
    assert_eq!(who, Some(pairing_b()));
    assert!(
        matches!(domain, Some(Err(ref why)) if why.contains("pairing changed")),
        "{domain:?}"
    );
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert!(cache.lock().unwrap().is_none());
    // And the refusal reaches the person as the org sentence, never an org link for either pairing.
    let refused =
        link_target(&plain("laptop.local"), who.as_ref(), domain.as_ref(), &[]).unwrap_err();
    assert!(
        refused.message.contains("pairing changed"),
        "{}",
        refused.message
    );
}

#[test]
fn a_cached_answer_is_never_reused_for_a_different_pairing() {
    let cache = DomainCache::new(None);
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let (_, a) = pairing_and_domain(reads(vec![Some(paired())]), w5(&calls), &cache);
    assert_eq!(a, Some(Ok(Some("apps.example.org".into()))));
    let (_, again) = pairing_and_domain(reads(vec![Some(paired())]), w5(&calls), &cache);
    assert_eq!(again, a);
    assert_eq!(
        calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "a hit for the same pairing asks nobody"
    );
    let (who, b) = pairing_and_domain(reads(vec![Some(pairing_b())]), w5(&calls), &cache);
    assert_eq!(
        (who, b),
        (
            Some(pairing_b()),
            Some(Ok(Some("apps2.example.org".into())))
        )
    );
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    // A re-pair of the same machine id at a new time is a different pairing too.
    let mut repaired = paired();
    repaired.made_at = "2026-11-18T00:00:00Z".into();
    pairing_and_domain(reads(vec![Some(repaired)]), w5(&calls), &cache);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 3);
}

#[test]
fn a_cache_hit_is_not_answered_when_the_pairing_moves_before_the_reply() {
    let cache = DomainCache::new(None);
    let calls = std::sync::atomic::AtomicUsize::new(0);
    pairing_and_domain(reads(vec![Some(paired())]), w5(&calls), &cache);
    // Cache hit for A, but the file says B by the time the answer would go out.
    let (who, domain) = pairing_and_domain(
        reads(vec![Some(paired()), Some(pairing_b())]),
        w5(&calls),
        &cache,
    );
    assert_eq!(
        (who, domain),
        (
            Some(pairing_b()),
            Some(Ok(Some("apps2.example.org".into())))
        )
    );
}

#[test]
fn unpaired_asks_nobody() {
    let cache = DomainCache::new(None);
    let calls = std::sync::atomic::AtomicUsize::new(0);
    assert_eq!(
        pairing_and_domain(reads(vec![None]), w5(&calls), &cache),
        (None, None)
    );
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
}
