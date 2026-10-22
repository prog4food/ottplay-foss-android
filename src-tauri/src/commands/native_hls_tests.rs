use super::*;
use std::sync::atomic::AtomicU64;

#[derive(Clone, Default)]
struct Lab {
    calls: Arc<Mutex<Vec<(String, Method, HeaderMap)>>>,
    sequence: Arc<AtomicU64>,
}
async fn upstream(
    State(lab): State<Lab>,
    method: Method,
    uri: axum::http::Uri,
    headers: HeaderMap,
) -> Response {
    lab.calls
        .lock()
        .unwrap()
        .push((uri.to_string(), method.clone(), headers.clone()));
    let path = uri.path();
    let mut response = Response::builder();
    let body = match path {
        "/entry.m3u8" => return response.status(302).header("location","/nested/master.m3u8?auth=synthetic").header("set-cookie","sid=first; Path=/").body(Body::empty()).unwrap(),
        "/nested/master.m3u8" => "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"Audio\",URI=\"audio/list.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=99999999,CODECS=\"avc1.42E01E,mp4a.40.2\",AUDIO=\"a\"\nvideo.m3u8?track=main\n".to_string(),
        "/nested/video.m3u8" => "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-MAP:URI=\"../init.bin\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"../key.bin\"\n#EXTINF:2,\n../seg.ts?sample=main\n#EXTINF:4,\n../slow.ts\n#EXT-X-ENDLIST\n".to_string(),
        "/nested/audio/list.m3u8" => "#EXTM3U\n#EXTINF:2,\n../../audio.ts\n#EXT-X-ENDLIST\n".to_string(),
        "/reuse.m3u8" => format!("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:{}\n#EXTINF:2,\nseg.ts\n",lab.sequence.load(Ordering::Relaxed)),
        "/play/live.php" => "#EXTM3U\n#EXTINF:2,\n../seg.ts?token=synthetic%2B\n#EXT-X-ENDLIST\n".into(),
        "/range.m3u8" => "#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:10@0\nseg.ts\n#EXTINF:1,\n#EXT-X-BYTERANGE:10\nseg.ts\n".into(),
        "/abort.m3u8" => "#EXTM3U\n#EXTINF:2,\nabort.ts\n".into(),
        "/abort.ts" => {
            let data = stream::unfold(0,|n| async move {
                if n == 100 { return None; }
                tokio::time::sleep(Duration::from_millis(20)).await;
                Some((Ok::<_,std::io::Error>(vec![1u8; 1024]),n+1))
            });
            return response.header("content-type","video/mp2t").body(Body::from_stream(data)).unwrap();
        },
        "/seg.ts" => {
            if let Some(range) = headers.get("range").and_then(|v|v.to_str().ok()) {
                let (start,end) = range.strip_prefix("bytes=").unwrap().split_once('-').unwrap();
                let start = start.parse::<usize>().unwrap();
                let end = if end.is_empty() {999} else {end.parse().unwrap()};
                return response.status(206).header("content-range",format!("bytes {start}-{end}/1000")).header("content-length",end-start+1).body(Body::from(vec![1u8;end-start+1])).unwrap();
            }
            return response.header("content-type","video/mp2t").body(if method == Method::HEAD {Body::empty()} else {Body::from(vec![1u8;1000])}).unwrap();
        },
        "/slow.ts" => {
            tokio::time::sleep(Duration::from_millis(120)).await;
            return response.header("content-type","video/mp2t").body(Body::from(vec![2u8;3000])).unwrap();
        },
        "/audio.ts" | "/init.bin" | "/key.bin" => return response.body(Body::from(vec![3u8;100])).unwrap(),
        "/denied" => return response.status(401).header("www-authenticate","Basic realm=\"upstream\"").body(Body::from("denied")).unwrap(),
        _ => return response.status(404).body(Body::from("missing")).unwrap(),
    };
    response = response.header("content-type", "application/vnd.apple.mpegurl");
    response.body(Body::from(body)).unwrap()
}
async fn lab() -> (String, Lab, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let lab = Lab::default();
    let router = Router::new()
        .fallback(any(upstream))
        .with_state(lab.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (format!("http://{address}"), lab, task)
}
fn links(base: &str, manifest: &str) -> Vec<String> {
    let base = Url::parse(base).unwrap();
    manifest
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| base.join(l).unwrap().to_string())
        .collect()
}
fn uri_attribute(base: &str, manifest: &str, tag: &str) -> String {
    let line = manifest.lines().find(|l| l.starts_with(tag)).unwrap();
    Url::parse(base)
        .unwrap()
        .join(&attribute(line, "URI").unwrap())
        .unwrap()
        .to_string()
}
async fn session(state: &NativeHlsState, token: &str) -> Arc<Session> {
    state
        .server
        .lock()
        .await
        .as_ref()
        .unwrap()
        .sessions
        .lock()
        .unwrap()
        .get(token)
        .unwrap()
        .clone()
}

#[tokio::test]
async fn query_selected_playlist_preserves_signed_query_and_cleans_up() {
    let (origin, lab, task) = lab().await;
    let state = NativeHlsState::default();
    let path = "/play/live.php?extension=m3u8&play_token=a%2Bb%2f%3D&empty=&stream=42&stream=43";
    let opened = state.start(format!("{origin}{path}"), None).await.unwrap();
    assert!(lab.calls.lock().unwrap().is_empty());

    let client = reqwest::Client::new();
    let playlist = client
        .get(&opened.url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(lab.calls.lock().unwrap()[0].0, path);
    let segment = links(&opened.url, &playlist).remove(0);
    assert!(segment.starts_with("http://127.0.0.1:"));
    let bytes = client
        .get(segment)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(bytes.len(), 1000);
    assert_eq!(lab.calls.lock().unwrap()[1].0, "/seg.ts?token=synthetic%2B");
    assert_eq!(lab.calls.lock().unwrap().len(), 2);
    assert_eq!(state.stats(&opened.session).await.unwrap().samples, 1);

    state.stop(&opened.session).await;
    assert!(state.stats(&opened.session).await.is_err());
    assert!(state.server.lock().await.is_none());
    task.abort();
}

#[tokio::test]
async fn real_player_flow_measures_media_not_network_and_never_replays_master() {
    let (origin, lab, task) = lab().await;
    let state = NativeHlsState::default();
    let opened = state
        .start(format!("{origin}/entry.m3u8"), None)
        .await
        .unwrap();
    assert!(opened.url.ends_with(".m3u8"));
    assert!(lab.calls.lock().unwrap().is_empty());
    let client = reqwest::Client::new();
    let master = client
        .get(&opened.url)
        .header("origin", "tauri://localhost")
        .header("user-agent", "Synthetic WK")
        .send()
        .await
        .unwrap();
    assert_eq!(
        master.headers()["access-control-allow-origin"],
        "tauri://localhost"
    );
    let master = master.text().await.unwrap();
    let media_url = links(&opened.url, &master).remove(0);
    let media = client
        .get(&media_url)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let segments = links(&media_url, &media);
    for url in &segments {
        assert!(
            client
                .get(url)
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap()
                .len()
                >= 1000
        );
    }
    let stats = state.stats(&opened.session).await.unwrap();
    assert_eq!(stats.bytes, 4000);
    assert_eq!(stats.seconds, 6.0);
    assert_eq!(stats.samples, 2);
    // Retries, init, encryption keys and alternate audio cannot inflate bitrate.
    client
        .get(&segments[0])
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    for tag in ["#EXT-X-MAP:", "#EXT-X-KEY:"] {
        client
            .get(uri_attribute(&media_url, &media, tag))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
    }
    let audio_url = uri_attribute(&opened.url, &master, "#EXT-X-MEDIA:");
    let audio = client
        .get(&audio_url)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    client
        .get(links(&audio_url, &audio).remove(0))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let repeated = state.stats(&opened.session).await.unwrap();
    assert_eq!(repeated.bytes, 4000);
    assert_eq!(repeated.samples, 2);
    let calls = lab.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|(path, _, _)| path == "/entry.m3u8")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(path, _, _)| path.starts_with("/nested/master.m3u8"))
            .count(),
        1
    );
    let redirected = calls
        .iter()
        .find(|(path, _, _)| path.starts_with("/nested/master.m3u8"))
        .unwrap();
    assert_eq!(redirected.2["cookie"], "sid=first");
    assert_eq!(redirected.2["user-agent"], "Synthetic WK");
    assert!(calls
        .iter()
        .any(|(path, _, _)| path == "/nested/video.m3u8?track=main"));
    drop(calls);
    state.stop(&opened.session).await;
    task.abort();
}

#[tokio::test]
async fn full_range_requests_count_once_but_head_and_partial_ranges_do_not() {
    let (origin, _, task) = lab().await;
    let state = NativeHlsState::default();
    let opened = state
        .start(format!("{origin}/reuse.m3u8"), None)
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let media = client
        .get(&opened.url)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let chunk = links(&opened.url, &media).remove(0);
    client.head(&chunk).send().await.unwrap();
    client
        .get(&chunk)
        .header("range", "bytes=0-1")
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(state.stats(&opened.session).await.unwrap().samples, 0);
    let full = client
        .get(&chunk)
        .header("range", "bytes=0-")
        .send()
        .await
        .unwrap();
    assert_eq!(full.status(), 206);
    assert_eq!(full.headers()["content-range"], "bytes 0-999/1000");
    assert_eq!(full.bytes().await.unwrap().len(), 1000);
    assert_eq!(state.stats(&opened.session).await.unwrap().bytes, 1000);
    client
        .get(&chunk)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(state.stats(&opened.session).await.unwrap().samples, 1);
    state.stop(&opened.session).await;
    task.abort();
}

#[tokio::test]
async fn implicit_ranges_become_explicit_and_exact_completed_bytes_are_required() {
    let (origin, _, task) = lab().await;
    let state = NativeHlsState::default();
    let opened = state
        .start(format!("{origin}/range.m3u8"), None)
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let media = client
        .get(&opened.url)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(media.contains("#EXT-X-BYTERANGE:10@10"));
    let chunks = links(&opened.url, &media);
    assert_ne!(chunks[0], chunks[1]);
    for (url, range) in chunks.iter().zip(["bytes=0-9", "bytes=10-19"]) {
        client
            .get(url)
            .header("range", range)
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
    }
    let stats = state.stats(&opened.session).await.unwrap();
    assert_eq!(stats.bytes, 20);
    assert_eq!(stats.seconds, 2.0);
    assert_eq!(stats.samples, 2);
    let session = session(&state, &opened.session).await;
    let resource = session
        .resources
        .lock()
        .unwrap()
        .values()
        .find(|r| {
            matches!(
                &r.kind,
                Kind::Segment {
                    range: Some((0, 10)),
                    ..
                }
            )
        })
        .unwrap()
        .clone();
    session.sample(&resource, 9, 1.0, Some(10));
    assert_eq!(session.stats().samples, 2);
    state.stop(&opened.session).await;
    task.abort();
}

#[tokio::test]
async fn reused_url_new_media_sequence_is_a_new_sample_and_rolling_window_is_eight() {
    let (origin, lab, task) = lab().await;
    let state = NativeHlsState::default();
    let opened = state
        .start(format!("{origin}/reuse.m3u8"), None)
        .await
        .unwrap();
    let client = reqwest::Client::new();
    for sequence in 0..10 {
        lab.sequence.store(sequence, Ordering::Relaxed);
        let media = client
            .get(&opened.url)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        client
            .get(links(&opened.url, &media).remove(0))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
    }
    let stats = state.stats(&opened.session).await.unwrap();
    assert_eq!(stats.samples, 8);
    assert_eq!(stats.bytes, 8000);
    assert_eq!(stats.seconds, 16.0);
    state.stop(&opened.session).await;
    task.abort();
}

#[tokio::test]
async fn stop_cancels_streams_and_closes_listener_without_recording_aborted_media() {
    let (origin, _, task) = lab().await;
    let state = NativeHlsState::default();
    let opened = state
        .start(format!("{origin}/abort.m3u8"), None)
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let media = client
        .get(&opened.url)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let chunk = links(&opened.url, &media).remove(0);
    let mut response = client.get(chunk).send().await.unwrap();
    assert!(!response.chunk().await.unwrap().unwrap().is_empty());
    let retained = session(&state, &opened.session).await;
    state.stop(&opened.session).await;
    assert!(state.stats(&opened.session).await.is_err());
    assert_eq!(retained.stats().samples, 0);
    assert!(client.get(&opened.url).send().await.is_err());
    let _ = tokio::time::timeout(Duration::from_secs(1), response.bytes())
        .await
        .unwrap();
    state.stop(&opened.session).await;
    task.abort();
}

#[tokio::test]
async fn local_cors_preflight_and_opaque_route_reject_invalid_calls_without_upstream_requests() {
    let (origin, lab, task) = lab().await;
    let state = NativeHlsState::default();
    let opened = state
        .start(format!("{origin}/reuse.m3u8"), None)
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let preflight = client
        .request(Method::OPTIONS, &opened.url)
        .header("origin", "tauri://localhost")
        .header("access-control-request-headers", "range")
        .send()
        .await
        .unwrap();
    assert_eq!(preflight.status(), 204);
    assert!(preflight.headers()["access-control-allow-headers"]
        .to_str()
        .unwrap()
        .contains("Range"));
    assert_eq!(client.post(&opened.url).send().await.unwrap().status(), 405);
    assert_eq!(
        client
            .get(&opened.url)
            .header("origin", "https://outside.example")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .get(format!("{}?url=http://outside.example", opened.url))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        client
            .get(format!("{}bad", opened.url))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert!(lab.calls.lock().unwrap().is_empty());
    state.stop_all().await;
    assert!(state.server.lock().await.is_none());
    task.abort();
}

#[tokio::test]
async fn upstream_auth_challenges_are_not_collapsed_into_loopback_origin() {
    let (origin, lab, task) = lab().await;
    let state = NativeHlsState::default();
    let opened = state.start(format!("{origin}/denied"), None).await.unwrap();
    let client = reqwest::Client::new();
    let response = client
        .get(&opened.url)
        .header("authorization", "Basic unsafe-loopback-scope")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    assert!(!response.headers().contains_key("www-authenticate"));
    assert_eq!(response.text().await.unwrap(), "denied");
    assert!(!lab.calls.lock().unwrap()[0].2.contains_key("authorization"));
    state.stop(&opened.session).await;
    task.abort();
}

#[tokio::test]
async fn manifest_parser_rejects_unsupported_extensions_and_enforces_finite_resources() {
    let session = Session::new(None, None).unwrap();
    let base = Url::parse("https://media.example/path/master.m3u8?key=synthetic").unwrap();
    for manifest in [
        "not m3u",
        "#EXTM3U\n#EXTINF:NaN,\na.ts\n",
        "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://drm\"\n",
        "#EXTM3U\n#EXT-X-DEFINE:NAME=\"a\",VALUE=\"b\"\n",
        "#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:10\na.ts\n",
    ] {
        assert!(rewrite_manifest(&session, &base, "p", true, "/hls/s/", manifest).is_err());
    }
    for i in 0..MAX_RESOURCES {
        session
            .register(base.join(&format!("{i}.ts")).unwrap(), Kind::Other)
            .unwrap();
    }
    assert!(session
        .register(base.join("too-many.ts").unwrap(), Kind::Other)
        .is_err());
    assert!(validate_url(&Url::parse("file:///tmp/private").unwrap()).is_err());
    assert!(rewrite_manifest(
        &session,
        &base,
        "p",
        true,
        "/hls/s/",
        &"x".repeat(MAX_MANIFEST + 1)
    )
    .is_err());
}

#[tokio::test]
async fn media_identity_survives_duration_corrections_and_distinguishes_discontinuities() {
    let session = Session::new(None, None).unwrap();
    let base = Url::parse("https://media.example/list.m3u8").unwrap();
    for (duration, disc) in [(2, 0), (3, 0), (2, 1)] {
        let text=format!("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-DISCONTINUITY-SEQUENCE:{disc}\n#EXTINF:{duration},\nsegment.ts\n");
        let rewritten =
            rewrite_manifest(&session, &base, "same-playlist", true, "/", &text).unwrap();
        let id = rewritten.lines().last().unwrap().trim_start_matches('/');
        let resource = session.resources.lock().unwrap().get(id).unwrap().clone();
        session.sample(&resource, 1000, duration as f64, Some(1000));
    }
    assert_eq!(session.stats().samples, 2);
    assert_eq!(session.stats().seconds, 4.0);
}

#[tokio::test]
async fn delta_playlist_skip_advances_sample_sequence() {
    let session = Session::new(None, None).unwrap();
    let base = Url::parse("https://media.example/list.m3u8").unwrap();
    for skip in ["", "#EXT-X-SKIP:SKIPPED-SEGMENTS=3\n"] {
        let text = format!("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n{skip}#EXTINF:2,\nsegment.ts\n");
        let rewritten =
            rewrite_manifest(&session, &base, "same-playlist", true, "/", &text).unwrap();
        let id = rewritten.lines().last().unwrap().trim_start_matches('/');
        let resource = session.resources.lock().unwrap().get(id).unwrap().clone();
        session.sample(&resource, 1000, 2.0, Some(1000));
    }
    assert_eq!(session.stats().samples, 2);
    let before = "#EXTM3U\n#EXT-X-SKIP:SKIPPED-SEGMENTS=3\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:2,\nsegment.ts\n";
    let rewritten = rewrite_manifest(&session, &base, "same-playlist", true, "/", before).unwrap();
    let id = rewritten.lines().last().unwrap().trim_start_matches('/');
    let resource = session.resources.lock().unwrap().get(id).unwrap().clone();
    session.sample(&resource, 1000, 2.0, Some(1000));
    assert_eq!(session.stats().samples, 2);
    for bad in ["-1", "no", "18446744073709551615"] {
        let text = format!("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-SKIP:SKIPPED-SEGMENTS={bad}\n#EXTINF:2,\nsegment.ts\n");
        assert!(rewrite_manifest(&session, &base, "same-playlist", true, "/", &text).is_err());
    }
}

#[tokio::test]
async fn saved_cookies_keep_exact_host_path_and_secure_scope_without_stale_reimport() {
    use reqwest::cookie::CookieStore;
    let cookie = tauri::webview::Cookie::parse(
        "session=saved; Domain=.media.example; Path=/private; Secure; HttpOnly",
    )
    .unwrap()
    .into_owned();
    let (seeds, _) = playback_cookie_seeds(vec![cookie]).unwrap();
    assert!(!seeds[0].1.contains("Domain="));
    let mut session = Session::new(None, None).unwrap();
    Arc::get_mut(&mut session).unwrap().seeds = seeds;
    let child = Url::parse("https://child.media.example/private/video.m3u8").unwrap();
    session.import_cookies(&child).await.unwrap();
    assert!(session.jar.cookies(&child).is_none());
    let exact = Url::parse("https://media.example/private/video.m3u8").unwrap();
    session.import_cookies(&exact).await.unwrap();
    assert_eq!(session.jar.cookies(&exact).unwrap(), "session=saved");
    assert!(session.jar.cookies(&child).is_none());
    assert!(session
        .jar
        .cookies(&Url::parse("https://media.example/public/video.m3u8").unwrap())
        .is_none());
    assert!(session
        .jar
        .cookies(&Url::parse("http://media.example/private/video.m3u8").unwrap())
        .is_none());
    session
        .jar
        .add_cookie_str("session=fresh; Path=/private; Secure", &exact);
    session.import_cookies(&exact).await.unwrap();
    assert_eq!(session.jar.cookies(&exact).unwrap(), "session=fresh");
}
#[tokio::test]
async fn standby_hls_lease_remains_pending_until_last_relay_owner_exits() {
    let background = ottplay_core::background_work::BackgroundWork::default();
    let work = background.enter().unwrap();
    let old = work.clone();
    let state = NativeHlsState::default();
    state.start_tracked("http://127.0.0.1/video.m3u8".into(), None, Some(work)).await.unwrap();
    let router_map = state.server.lock().await.as_ref().unwrap().sessions.clone();
    let held = router_map.lock().unwrap().values().next().unwrap().clone();
    drop(old);
    background.set_standby(true);
    state.stop_all().await;
    assert!(router_map.lock().unwrap().is_empty());
    assert_eq!(background.status().pending, 1);
    assert!(!background.status().quiescent);
    drop(held);
    // Aborting the listener schedules its future for destruction on the runtime.
    tokio::time::timeout(Duration::from_secs(2), async {
        while !background.status().quiescent { tokio::task::yield_now().await; }
    }).await.unwrap();
}
