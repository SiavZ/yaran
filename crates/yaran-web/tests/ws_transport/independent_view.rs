use super::*;

/// Independently rendered phone input never changes a desktop's shared grid.
#[tokio::test]
async fn an_independent_phone_view_types_and_reopens_without_changing_the_desktop_grid() {
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
    for attempt in 0..2 {
        let (mut phone, _) = tokio_tungstenite::connect_async(format!("{url}?independent_view=1"))
            .await
            .unwrap();
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
        let marker = format!("independent-phone-{attempt}");
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
