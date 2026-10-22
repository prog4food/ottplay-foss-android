use super::*;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn http_fixture(
    status: u16,
    header_delay: Duration,
    chunks: Vec<(Duration, Vec<u8>)>,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(stream.read_u8().await.unwrap());
        }
        tokio::time::sleep(header_delay).await;
        let length: usize = chunks.iter().map(|(_, bytes)| bytes.len()).sum();
        let header = format!(
            "HTTP/1.1 {status} Test\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
        );
        if stream.write_all(header.as_bytes()).await.is_err() {
            return;
        }
        for (delay, bytes) in chunks {
            tokio::time::sleep(delay).await;
            if stream.write_all(&bytes).await.is_err() {
                return;
            }
        }
    });
    (
        format!("http://user:password@{address}/private-key?token=secret#fragment"),
        task,
    )
}

fn client(read_ms: u64, total_ms: u64) -> Client {
    Client::builder()
        .no_proxy()
        .read_timeout(Duration::from_millis(read_ms))
        .timeout(Duration::from_millis(total_ms))
        .build()
        .unwrap()
}

#[tokio::test]
async fn progressing_body_can_outlast_idle_deadline_but_stall_and_total_are_bounded() {
    let chunks = vec![(Duration::from_millis(40), vec![b'x']); 8];
    for native in [false, true] {
        let (url, task) = http_fixture(200, Duration::ZERO, chunks.clone()).await;
        assert_eq!(
            fetch_remote(&url, &client(200, 2000), native)
                .await
                .unwrap(),
            b"xxxxxxxx"
        );
        task.await.unwrap();
    }

    // Each read makes progress within the idle deadline, but the total expires.
    let (url, task) = http_fixture(200, Duration::ZERO, chunks).await;
    let error = fetch_remote(&url, &client(200, 100), false)
        .await
        .unwrap_err();
    assert_eq!(format!("{error:#}"), "HTTP timeout");
    task.abort();

    for before_headers in [true, false] {
        let delay = Duration::from_millis(500);
        let (url, task) = http_fixture(
            200,
            if before_headers {
                delay
            } else {
                Duration::ZERO
            },
            vec![(
                if before_headers {
                    Duration::ZERO
                } else {
                    delay
                },
                vec![b'x'],
            )],
        )
        .await;
        let error = fetch_remote(&url, &client(80, 2000), false)
            .await
            .unwrap_err();
        assert_eq!(format!("{error:#}"), "HTTP timeout");
        task.abort();
    }
}

#[tokio::test]
async fn status_gzip_and_xml_errors_never_expose_source_or_payload() {
    for (status, body, expected) in [
        (503, b"<tv/>".to_vec(), "HTTP status 503"),
        (404, b"secret response".to_vec(), "HTTP status 404"),
        (200, vec![0x1f, 0x8b, 0], "gzip decode failed"),
        (
            200,
            b"<tv><channel id='secret'></broken>".to_vec(),
            "XMLTV parse failed",
        ),
    ] {
        let (url, task) = http_fixture(status, Duration::ZERO, vec![(Duration::ZERO, body)]).await;
        let error = fetch_single(&url).await.unwrap_err();
        assert_eq!(format!("{error:#}"), expected);
        task.await.unwrap();
    }
    let (url, task) = http_fixture(503, Duration::ZERO, vec![]).await;
    let error = fetch_single_native(&url).await.unwrap_err();
    assert_eq!(
        error
            .downcast_ref::<reqwest::Error>()
            .unwrap()
            .status()
            .unwrap(),
        503
    );
    task.await.unwrap();
}

#[test]
fn failed_refresh_preserves_sqlite_and_partial_success_keeps_existing_merge_rules() {
    // A child process owns DATABASE_URL: no test or user's environment is mutated.
    const CHILD: &str = "OTTPLAY_EPG_RECOVERY_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let directory =
            std::env::temp_dir().join(format!("ottplay-recovery-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "xmltv::fetch_tests::failed_refresh_preserves_sqlite_and_partial_success_keeps_existing_merge_rules", "--nocapture"])
            .env(CHILD, &directory)
            .env("DATABASE_URL", format!("sqlite://{}?mode=rwc", directory.join("guide.db").display()))
            .output().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let directory = std::path::PathBuf::from(std::env::var_os(CHILD).unwrap());
        let pool = crate::db::pool().await.unwrap().unwrap();
        sqlx::query("INSERT INTO xmltv_channels(id,name) VALUES ('old','Last good')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO xmltv_programmes(channel_id,start_ts,stop_ts,title) VALUES ('old',0,1,'Last programme')").execute(&pool).await.unwrap();
        let absent = directory.join("missing-private-token.xml").to_string_lossy().into_owned();
        let error = crate::fetch_xmltv(&[absent.clone(), absent.clone()]).await.unwrap_err();
        assert_eq!(format!("{error:#}"), "source 2: source read failed");
        for table in ["xmltv_channels", "xmltv_programmes"] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}")).fetch_one(&pool).await.unwrap();
            assert_eq!(count, 1, "a completely failed fetch cannot clear {table}");
        }
        let first = directory.join("first.xml");
        let second = directory.join("second.xml");
        std::fs::write(&first, "<tv><channel id='a'><display-name>First</display-name></channel><programme channel='a' start='20260928000000 +0000' stop='20260928010000 +0000'><title>One</title></programme></tv>").unwrap();
        std::fs::write(&second, "<tv><channel id='a'><display-name>Second</display-name></channel><programme channel='a' start='20260928010000 +0000' stop='20260928020000 +0000'><title>Two</title></programme></tv>").unwrap();
        let cache = crate::fetch_xmltv(&[absent.clone(), first.to_string_lossy().into_owned(), second.to_string_lossy().into_owned(), absent]).await.unwrap();
        assert_eq!(cache.channels["a"].name, "First");
        assert_eq!(cache.programs["a"].iter().map(|p| p.title.as_str()).collect::<Vec<_>>(), ["One", "Two"]);
        let persisted: Vec<String> = sqlx::query_scalar("SELECT title FROM xmltv_programmes ORDER BY start_ts").fetch_all(&pool).await.unwrap();
        assert_eq!(persisted, ["One", "Two"]);
        // Empty-but-successful feeds and zero configured feeds keep their prior contract.
        std::fs::write(&first, "<tv/>").unwrap();
        assert!(crate::fetch_xmltv(&[first.to_string_lossy().into_owned()]).await.unwrap().channels.is_empty());
        assert!(crate::fetch_xmltv(&[]).await.unwrap().channels.is_empty());
        pool.close().await;
    });
}

#[test]
fn shared_retry_intervals_accept_full_host_counter_range() {
    for (failures, seconds) in [
        (0, 7200),
        (1, 60),
        (2, 120),
        (3, 240),
        (4, 480),
        (5, 900),
        (u32::MAX, 900),
    ] {
        assert_eq!(crate::epg_refresh_interval(failures).unwrap(), seconds);
    }
}
