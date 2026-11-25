use super::*;

/// Independently rendered phone input never changes a desktop's shared grid.
#[tokio::test]
async fn mobile_views_type_and_reopen_without_changing_the_desktop_grid() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let (addr, _tmp) = boot().await;
    let url = format!("ws://{addr}/ws/sessions/s1/pty");
    let (mut desktop, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let desktop_hello = next_event_frame(&mut desktop, "connected", Duration::from_secs(8))
        .await
        .unwrap();
    desktop
        .send(Message::Text(r#"{"rows":40,"cols":120}"#.into()))
        .await
        .unwrap();
    next_event_frame(&mut desktop, "size", Duration::from_secs(8))
        .await
        .unwrap();

    // The query is asserted again on every reopen. Even a stale client resize,
    // including the legacy takeover spelling, must not touch the desktop.
    for (case, (query, user_agent)) in [
        ("?independent_view=1", None),
        ("", Some("YaranApp/1.2.0 (android; phone)")),
        ("?independent_view=0", Some("YaranApp/1.2.0 (ios; tablet)")),
        (
            "",
            Some("Mozilla/5.0 (Linux; Android 17) Mobile Safari/537.36"),
        ),
        (
            "?independent_view=0",
            Some("Mozilla/5.0 (iPhone) Mobile Safari/604.1"),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        for attempt in 0..2 {
            let mut request = format!("{url}{query}").into_client_request().unwrap();
            if let Some(user_agent) = user_agent {
                request
                    .headers_mut()
                    .insert("user-agent", user_agent.parse().unwrap());
            }
            let (mut phone, _) = tokio_tungstenite::connect_async(request).await.unwrap();
            let hello = next_event_frame(&mut phone, "connected", Duration::from_secs(8))
                .await
                .unwrap();
            assert_eq!(
                (hello["rows"].as_u64(), hello["cols"].as_u64()),
                (Some(40), Some(120))
            );
            phone
                .send(Message::Text(
                    r#"{"rows":20,"cols":40,"takeover":true}"#.into(),
                ))
                .await
                .unwrap();
            let marker = format!("independent-phone-{case}-{attempt}");
            phone
                .send(Message::Binary(format!("{marker}\n").into_bytes().into()))
                .await
                .unwrap();
            let echoed = accumulate_until(&mut desktop, &marker, Duration::from_secs(8)).await;
            assert!(
                String::from_utf8_lossy(&echoed).contains(&marker),
                "phone input must reach the same live PTY"
            );
            // A new handshake is a barrier after the echoed input and reports the
            // actual PTY grid and current holder, rather than remembered proposals.
            let (mut probe, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            let after = next_event_frame(&mut probe, "connected", Duration::from_secs(8))
                .await
                .unwrap();
            assert_eq!(
                (after["rows"].as_u64(), after["cols"].as_u64()),
                (Some(40), Some(120))
            );
            assert_eq!(after["owner"], desktop_hello["id"]);
            probe.close(None).await.unwrap();
            phone.close(None).await.unwrap();
        }
    }
}
