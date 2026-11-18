//! The phone app's direct machines against the real router: a CLI token presented as
//! the session cookie, `cli-login`'s `cookie_name`, and the add-machine code's HTTPS rule.

use super::*;

/// The phone app holds a direct machine's CLI token natively and presents it as
/// the session cookie `cli-login` names (`cookie_name`, from the port the listener
/// is bound to). That cookie must be a session for HTTP, the events socket and a
/// PTY socket, and must still end on `cli-logout`, on the web's Sign out and on a
/// password change, closing the sockets it held with 4401. Nothing here relaxes a
/// rule: under `require = "everywhere"` the same requests without it are refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cli_token_presented_as_the_session_cookie_is_a_session_everywhere() {
    let server = Serve::start(Yaran::with_password("require = \"everywhere\"")).await;
    let base = format!("http://{}", server.addr);
    let client = reqwest::Client::new();
    let cli_login = || async {
        let reply = client
            .post(format!("{base}/api/v1/auth/cli-login"))
            .json(&json!({ "password": PASSWORD, "label": "yaran phone" }))
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), 200);
        assert!(reply.headers().get("set-cookie").is_none());
        let body: Value = reply.json().await.unwrap();
        assert_eq!(body["expires_at"], Value::Null);
        assert_eq!(
            body["cookie_name"],
            json!(format!("yaran_session_{}", server.addr.port())),
            "the name of the cookie this listener reads"
        );
        let token = body["token"].as_str().unwrap().to_string();
        let cookie = format!("{}={token}", body["cookie_name"].as_str().unwrap());
        (token, cookie)
    };
    let projects = |cookie: Option<String>| {
        let mut request = client.get(format!("{base}/api/v1/projects"));
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        async move { request.send().await.unwrap().status().as_u16() }
    };
    assert_eq!(projects(None).await, 401, "everywhere needs a session");

    let (token, cookie) = cli_login().await;
    assert_eq!(projects(Some(cookie.clone())).await, 200);
    let created = client
        .post(format!("{base}/api/v1/terminals"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 201);
    let tid = created.json::<Value>().await.unwrap()["terminal_id"]
        .as_str()
        .unwrap()
        .to_string();
    let pty = format!("/ws/terminals/{tid}/pty");
    assert_eq!(server.ws_close_code(&pty, &[], None).await, Some(4401));
    let mut events = server.connect("/ws/events", &[], Some(&cookie)).await;
    let mut terminal = server.connect(&pty, &[], Some(&cookie)).await;
    assert_eq!(
        wait_close(&mut events, Duration::from_millis(500)).await,
        None
    );
    assert_eq!(
        wait_close(&mut terminal, Duration::from_millis(500)).await,
        None
    );

    // cli-logout with the bearer ends the cookie and the sockets it held.
    let out = client
        .post(format!("{base}/api/v1/auth/cli-logout"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(out.status(), 204);
    assert_eq!(
        wait_close(&mut events, Duration::from_secs(3)).await,
        Some(4401)
    );
    assert_eq!(
        wait_close(&mut terminal, Duration::from_secs(3)).await,
        Some(4401)
    );
    assert_eq!(projects(Some(cookie)).await, 401);

    // The web's Sign out, sent with the cookie, ends the CLI token too.
    let (token, cookie) = cli_login().await;
    let out = client
        .post(format!("{base}/api/v1/auth/logout"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(out.status(), 204);
    assert_eq!(projects(Some(cookie)).await, 401);
    let bearer = client
        .get(format!("{base}/api/v1/projects"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(bearer.status(), 401, "the same session, however it travels");

    // A password change ends it.
    let (_, cookie) = cli_login().await;
    let change = client
        .post(format!("{base}/api/v1/auth/password"))
        .header("cookie", &cookie)
        .json(&json!({ "current": PASSWORD, "new": OTHER_PASSWORD }))
        .send()
        .await
        .unwrap();
    assert_eq!(change.status(), 204);
    assert_eq!(projects(Some(cookie)).await, 401);
}

/// `cookie_name` is additive: the harness's listener port names it, and the
/// command line's own parser (which reads only `token`) is untouched.
#[tokio::test]
async fn cli_login_names_the_cookie_of_the_port_it_arrived_on() {
    let yaran = Yaran::with_password("");
    let login = yaran.cli_login(NETWORK, PASSWORD).await;
    assert_eq!(login.status, StatusCode::OK, "{}", login.body);
    let body = login.json();
    assert_eq!(body["cookie_name"], json!("yaran_session_3890"));
    assert!(body["token"].as_str().is_some_and(|t| !t.is_empty()));
}

/// The direct add-machine code exists only where yaran itself knows the browser
/// used HTTPS: a forged `X-Forwarded-Proto` on plain HTTP is refused with the
/// sentence, a Funnel-marked request (an HTTPS path yaran vouches for) gets the
/// code for the Host it named, and the link target refuses with no domain.
#[tokio::test]
async fn the_machine_code_needs_a_transport_yaran_knows_is_https() {
    let yaran = Yaran::start("");
    let ts = "laptop.tail1234.ts.net";
    let plain = yaran
        .send(
            THIS_MACHINE,
            Req::new(Method::GET, "/api/v1/phone/machine-qr")
                .header("x-forwarded-proto", "https")
                .header("host", ts),
        )
        .await;
    assert_eq!(plain.status, StatusCode::CONFLICT, "{}", plain.body);
    assert_eq!(plain.error().as_deref(), Some("not_https"));
    assert!(
        plain.json()["message"]
            .as_str()
            .unwrap()
            .contains("tailscale serve")
    );
    let funnel = |path: &str| {
        Req::new(Method::GET, path)
            .header("tailscale-funnel-request", "?1")
            .header("x-forwarded-for", "198.51.100.30")
            .header("host", ts)
    };
    let code = yaran
        .send(THIS_MACHINE, funnel("/api/v1/phone/machine-qr"))
        .await;
    assert_eq!(code.status, StatusCode::OK, "{}", code.body);
    assert_eq!(
        code.json()["uri"],
        json!("yaranapp://add-machine?u=https%3A%2F%2Flaptop.tail1234.ts.net")
    );
    // The build under test has no publisher domain unless publisher.json names
    // one; either way the answer is a target or the no-domain refusal, never a
    // made-up domain.
    let target = yaran
        .send(THIS_MACHINE, funnel("/api/v1/phone/link-target"))
        .await;
    match target.status {
        StatusCode::OK => assert_eq!(
            target.json()["target"],
            json!({ "kind": "direct", "host": ts })
        ),
        StatusCode::CONFLICT => assert_eq!(target.error().as_deref(), Some("no_publisher_domain")),
        other => panic!("{other}: {}", target.body),
    }
}

/// The phone app admits a machine's page only when its status says the served page hands
/// sign-in to the app (`native_auth_ui`). The flag is the same for every client, signed in
/// or not, and changes nothing else in the answer: it is compatibility, not authorization.
/// It is `true` only for a binary whose frontend was built from this source; a Rust-only
/// build (`YARAN_DISABLE_UI_BUILD`) reusing an old `web/dist` says `false`, so this test
/// asserts whichever this binary proves, and the unit test in `auth::status_answer` pins both.
#[tokio::test]
async fn the_status_tells_the_phone_its_page_signs_in_natively() {
    // The flag is read from build.rs's state file; this marker is the env stamp of the same run.
    let proven =
        yaran_web::web_assets::ui_build_state() == yaran_web::web_assets::UiBuildState::Built;
    let yaran = Yaran::with_password("require = \"everywhere\"");
    for class in [NETWORK, TAILNET, THIS_MACHINE] {
        let status = yaran.status(class, None).await;
        assert_eq!(status["native_auth_ui"], json!(proven), "{status}");
        assert_eq!(status["signed_in"], json!(false), "{status}");
    }
    let open = Yaran::start("");
    assert_eq!(
        open.status(NETWORK, None).await["native_auth_ui"],
        json!(proven)
    );
}
