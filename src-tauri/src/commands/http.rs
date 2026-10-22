//! Text HTTP transport for the embedded frontend's jQuery AJAX requests.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    status: u16,
    status_text: String,
    body: String,
    headers: String,
}

#[derive(Debug, Serialize)]
pub struct HttpError {
    message: String,
    timeout: bool,
}

impl From<reqwest::Error> for HttpError {
    fn from(error: reqwest::Error) -> Self {
        Self {
            message: error.to_string(),
            timeout: error.is_timeout(),
        }
    }
}

/// HTTP errors are responses, not IPC failures: jQuery needs their status/body.
/// No browser cookies are imported; explicit provider request headers survive.
#[tauri::command]
pub async fn proxy_http(
    background: tauri::State<'_, ottplay_core::background_work::BackgroundWork>,
    url: String,
    method: String,
    body: Option<String>,
    headers: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
    secure_control: Option<bool>,
    screenshot_control: Option<bool>,
    remote_control: Option<bool>,
) -> Result<HttpResponse, HttpError> {
    proxy_http_with_background(
        &background,
        url,
        method,
        body,
        headers,
        timeout_ms,
        secure_control,
        screenshot_control,
        remote_control,
    )
    .await
}

async fn proxy_http_with_background(
    background: &ottplay_core::background_work::BackgroundWork,
    url: String,
    method: String,
    body: Option<String>,
    headers: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
    secure_control: Option<bool>,
    screenshot_control: Option<bool>,
    remote_control: Option<bool>,
) -> Result<HttpResponse, HttpError> {
    let secure_control = secure_control.unwrap_or(false);
    let screenshot_control = screenshot_control.unwrap_or(false);
    // Remote control and diagnostic screenshots must survive player standby.
    let work = if remote_control.unwrap_or(false) || secure_control || screenshot_control {
        None
    } else {
        Some(background.enter().map_err(|message| HttpError {
            message: message.into(),
            timeout: false,
        })?)
    };
    let request = proxy_http_inner(
        url,
        method,
        body,
        headers,
        timeout_ms,
        secure_control,
        screenshot_control,
    );
    match work {
        Some(work) => work.run(request).await.map_err(|message| HttpError {
            message: message.into(),
            timeout: false,
        })?,
        None => request.await,
    }
}

async fn proxy_http_inner(
    url: String,
    method: String,
    body: Option<String>,
    headers: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
    secure_control: bool,
    screenshot_control: bool,
) -> Result<HttpResponse, HttpError> {
    let url =
        reqwest::Url::parse(url.strip_prefix('@').unwrap_or(&url)).map_err(|error| HttpError {
            message: error.to_string(),
            timeout: false,
        })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(HttpError {
            message: "Only HTTP(S) URLs are supported".into(),
            timeout: false,
        });
    }
    if secure_control
        && (url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some())
    {
        return Err(HttpError {
            message: "Secure control requests require HTTPS without URL credentials or a fragment"
                .into(),
            timeout: false,
        });
    }
    if screenshot_control && !screenshot_url_allowed(&url) {
        return Err(HttpError {
            message: "Screenshot transfers require HTTPS or loopback HTTP without URL credentials or a fragment".into(),
            timeout: false,
        });
    }
    if screenshot_control
        && body
            .as_ref()
            .is_some_and(|body| body.len() > 2 * 1024 * 1024)
    {
        return Err(HttpError {
            message: "Screenshot request exceeds the transfer size limit".into(),
            timeout: false,
        });
    }
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| HttpError {
        message: error.to_string(),
        timeout: false,
    })?;
    let client = shared_client(secure_control, screenshot_control).await?;
    let mut request = client
        .request(method, url)
        .timeout(Duration::from_millis(timeout_ms.unwrap_or(30000).max(1)));
    for (name, value) in headers.unwrap_or_default() {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let mut response = request.send().await?;
    let status = response.status();
    let mut headers = String::new();
    for (name, value) in response.headers() {
        if let Ok(value) = value.to_str() {
            headers.push_str(name.as_str());
            headers.push_str(": ");
            headers.push_str(value);
            headers.push_str("\r\n");
        }
    }
    let body = if screenshot_control {
        // Screenshot bytes travel in the request. The response is only an ACK,
        // so bound it even when the server uses chunked transfer encoding.
        const ACK_LIMIT: usize = 64 * 1024;
        let oversized = || HttpError {
            message: "Screenshot acknowledgement exceeds the response size limit".into(),
            timeout: false,
        };
        if response
            .content_length()
            .is_some_and(|size| size > ACK_LIMIT as u64)
        {
            return Err(oversized());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if chunk.len() > ACK_LIMIT - bytes.len() {
                return Err(oversized());
            }
            bytes.extend_from_slice(&chunk);
        }
        String::from_utf8(bytes).map_err(|_| HttpError {
            message: "Screenshot acknowledgement is not valid UTF-8".into(),
            timeout: false,
        })?
    } else {
        response.text().await?
    };
    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body,
    })
}

fn screenshot_url_allowed(url: &reqwest::Url) -> bool {
    let loopback = match url.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(address)) => address.octets() == [127, 0, 0, 1],
        Some(url::Host::Ipv6(address)) => address == std::net::Ipv6Addr::LOCALHOST,
        _ => false,
    };
    url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && (url.scheme() == "https" || (url.scheme() == "http" && loopback))
}

async fn shared_client(
    secure_control: bool,
    screenshot_control: bool,
) -> Result<&'static reqwest::Client, HttpError> {
    // Reuse TLS connections while paging provider libraries. Keep each transport
    // policy in its own pool, including when both control flags are present.
    static PROVIDER: tokio::sync::OnceCell<reqwest::Client> = tokio::sync::OnceCell::const_new();
    static SECURE_CONTROL: tokio::sync::OnceCell<reqwest::Client> =
        tokio::sync::OnceCell::const_new();
    static SCREENSHOT: tokio::sync::OnceCell<reqwest::Client> = tokio::sync::OnceCell::const_new();
    let slot = if secure_control {
        &SECURE_CONTROL
    } else if screenshot_control {
        &SCREENSHOT
    } else {
        &PROVIDER
    };
    slot.get_or_try_init(|| async { client_builder(secure_control, screenshot_control).build() })
        .await
        .map_err(HttpError::from)
}

fn client_builder(secure_control: bool, screenshot_control: bool) -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder()
        .pool_max_idle_per_host(4)
        .pool_idle_timeout(Duration::from_secs(30))
        // Provider credentials belong to individual requests, never the client.
        .cookie_store(false)
        .user_agent("OTT-play-FOSS/1.0");
    if secure_control {
        // Pairing claims carry bearer credentials. Even a same-host redirect
        // can change TLS to cleartext; return the redirect response untouched.
        builder
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
    } else if screenshot_control {
        // The loopback exception applies only to the selected local endpoint,
        // never to a redirect that forwards an image to a different recipient.
        builder.redirect(reqwest::redirect::Policy::none())
    } else {
        builder
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    #[tokio::test]
    async fn standby_cancels_provider_body_but_keeps_control_transport_available() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/provider", listener.local_addr().unwrap());
        let (started, ready) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nx").await.unwrap();
            started.send(()).unwrap();
            let mut byte = [0];
            let closed = tokio::time::timeout(Duration::from_secs(2), socket.read(&mut byte)).await.unwrap();
            assert!(matches!(closed, Ok(0)) || closed.is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset));
        });
        let background = ottplay_core::background_work::BackgroundWork::default();
        let request = tokio::spawn({
            let background = background.clone();
            async move { proxy_http_with_background(&background, url, "GET".into(), None, None, Some(10000), None, None, None).await }
        });
        ready.await.unwrap();
        background.set_standby(true);
        let error = tokio::time::timeout(Duration::from_secs(2), request).await.unwrap().unwrap().unwrap_err();
        assert!(error.message.contains("cancelled"));
        assert!(background.status().quiescent);
        server.await.unwrap();
        let refused = proxy_http_with_background(&background, "http://127.0.0.1:1".into(), "GET".into(), None, None, Some(50), None, None, None).await.unwrap_err();
        assert_eq!(refused.message, "Player is in standby");
        let control_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let control_url = format!("http://{}/command", control_listener.local_addr().unwrap());
        let control_server = tokio::spawn(async move {
            let (mut socket, _) = control_listener.accept().await.unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]").await.unwrap();
        });
        let legacy = proxy_http_with_background(&background, control_url, "GET".into(), None, None, Some(1000), None, None, Some(true)).await.unwrap();
        assert_eq!(legacy.status, 200);
        assert_eq!(legacy.body, "[]");
        control_server.await.unwrap();
        // An exempt control request still reaches its own policy validation.
        let control = proxy_http_with_background(&background, "http://127.0.0.1:1".into(), "GET".into(), None, None, Some(50), Some(true), None, None).await.unwrap_err();
        assert!(control.message.contains("Secure control requests require HTTPS"));
    }

    async fn proxy_http(
        url: String,
        method: String,
        body: Option<String>,
        headers: Option<HashMap<String, String>>,
        timeout_ms: Option<u64>,
        secure_control: Option<bool>,
        screenshot_control: Option<bool>,
    ) -> Result<HttpResponse, HttpError> {
        proxy_http_with_background(
            &Default::default(),
            url,
            method,
            body,
            headers,
            timeout_ms,
            secure_control,
            screenshot_control,
            None,
        )
        .await
    }

    #[tokio::test]
    async fn preserves_http_error_body_headers_and_post_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://{}/m3u/match-channels?source=custom",
            listener.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut request = String::new();
            let mut content_length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                    content_length = value.trim().parse::<usize>().unwrap();
                }
                request.push_str(&line);
            }
            let mut body = vec![0; content_length];
            reader.read_exact(&mut body).unwrap();
            stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nX-Upstream: custom\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{\"error\":\"denied\"}").unwrap();
            (request, body)
        });
        let response = proxy_http(
            url,
            "POST".into(),
            Some("{}\n\t\nchannels".into()),
            Some(HashMap::from([
                ("Authorization".into(), "Bearer test".into()),
                ("Content-Type".into(), "text/plain".into()),
            ])),
            Some(2000),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(response.status, 403);
        assert_eq!(response.status_text, "Forbidden");
        assert_eq!(response.body, r#"{"error":"denied"}"#);
        assert!(response.headers.contains("x-upstream: custom\r\n"));
        let (request, body) = server.join().unwrap();
        assert!(request.starts_with("POST /m3u/match-channels?source=custom HTTP/1.1\r\n"));
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer test\r\n"));
        assert_eq!(body, b"{}\n\t\nchannels");
    }

    #[tokio::test]
    async fn rejects_non_http_schemes() {
        let error = proxy_http(
            "file:///tmp/playlist".into(),
            "GET".into(),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("Only HTTP(S)"));
        assert!(!error.timeout);
    }

    #[tokio::test]
    async fn secure_control_rejects_plaintext_and_url_credentials_before_network_io() {
        for url in [
            "http://127.0.0.1:1/api/pairings?id=receipt",
            "https://user:secret@localhost/api/pairings",
            "https://localhost/api/pairings#fragment",
        ] {
            let error = proxy_http(
                url.into(),
                "GET".into(),
                None,
                None,
                Some(100),
                Some(true),
                None,
            )
            .await
            .unwrap_err();
            assert!(error
                .message
                .contains("Secure control requests require HTTPS"));
            assert!(!error.message.contains("secret"));
        }
        // HTTPS-only also applies inside the HTTP client, not just URL parsing.
        assert!(shared_client(true, false)
            .await
            .unwrap()
            .get("http://127.0.0.1:1/")
            .timeout(Duration::from_millis(100))
            .send()
            .await
            .unwrap_err()
            .is_builder());
    }

    #[tokio::test]
    async fn secure_control_does_not_forward_bearer_on_redirect() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut request = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                request.push_str(&line);
            }
            stream.write_all(format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{address}/leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
            listener.set_nonblocking(true).unwrap();
            std::thread::sleep(Duration::from_millis(150));
            assert!(
                matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
                "redirect destination was contacted"
            );
            request
        });
        // Use a plaintext fixture solely to exercise the production redirect
        // policy. The separate test above covers the HTTPS-only enforcement.
        let client = client_builder(true, false)
            .https_only(false)
            .build()
            .unwrap();
        let response = client
            .get(format!("http://{address}/api/pairings?id=receipt"))
            .timeout(Duration::from_millis(1000))
            .bearer_auth("claim-secret")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(response.url().path(), "/api/pairings");
        assert!(server
            .join()
            .unwrap()
            .to_lowercase()
            .contains("authorization: bearer claim-secret"));
    }

    #[tokio::test]
    async fn screenshot_transport_validates_urls_and_bounds_before_network_io() {
        for allowed in [
            "https://controller.example/api/responses",
            "http://127.0.0.1:8443/api/responses",
            "http://localhost:8443/api/responses",
            "http://[::1]:8443/api/responses",
        ] {
            assert!(screenshot_url_allowed(
                &reqwest::Url::parse(allowed).unwrap()
            ));
        }
        for denied in [
            "http://controller.example/api/responses",
            "http://192.168.1.10/api/responses",
            "http://127.0.0.2/api/responses",
            "http://localhost.example/api/responses",
            "http://[::2]/api/responses",
            "https://user:secret@controller.example/api/responses",
            "http://user:secret@localhost/api/responses",
            "https://controller.example/api/responses#fragment",
        ] {
            let error = proxy_http(
                denied.into(),
                "POST".into(),
                Some("{}".into()),
                None,
                Some(100),
                None,
                Some(true),
            )
            .await
            .unwrap_err();
            assert!(error.message.starts_with("Screenshot transfers require"));
            assert!(!error.message.contains("secret"));
        }
        let error = proxy_http(
            "http://127.0.0.1:1/api/responses".into(),
            "POST".into(),
            Some("x".repeat(2 * 1024 * 1024 + 1)),
            None,
            Some(100),
            None,
            Some(true),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("request exceeds"));
        // Screenshot loopback permission must not weaken strict pairing policy.
        let error = proxy_http(
            "http://127.0.0.1:1/api/responses".into(),
            "POST".into(),
            Some("{}".into()),
            None,
            Some(100),
            Some(true),
            Some(true),
        )
        .await
        .unwrap_err();
        assert!(error
            .message
            .starts_with("Secure control requests require HTTPS"));
    }

    fn read_test_request(stream: &mut std::net::TcpStream) -> (String, Vec<u8>) {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut headers = String::new();
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" || line.is_empty() {
                break;
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse::<usize>().unwrap();
            }
            headers.push_str(&line);
        }
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes).unwrap();
        (headers, bytes)
    }

    #[tokio::test]
    async fn provider_reuses_connections_without_retaining_headers_or_cookies() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/library/sections", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            // Both pages must use the same accepted connection.
            let (mut stream, _) = listener.accept().unwrap();
            let first = read_test_request(&mut stream);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nSet-Cookie: session=private\r\n\r\n{}").unwrap();
            let second = read_test_request(&mut stream);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .unwrap();
            (first.0.to_ascii_lowercase(), second.0.to_ascii_lowercase())
        });
        let first = proxy_http(
            url.clone(),
            "GET".into(),
            None,
            Some(HashMap::from([
                ("Authorization".into(), "Bearer private".into()),
                ("X-Plex-Token".into(), "provider-secret".into()),
                ("Cookie".into(), "explicit=value".into()),
            ])),
            Some(2000),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(first.status, 200);
        let second = proxy_http(url, "GET".into(), None, None, Some(2000), None, None)
            .await
            .unwrap();
        assert_eq!(second.status, 200);
        let (first, second) = server.join().unwrap();
        assert!(first.contains("authorization: bearer private\r\n"));
        assert!(first.contains("x-plex-token: provider-secret\r\n"));
        assert!(first.contains("cookie: explicit=value\r\n"));
        assert!(!second.contains("authorization:"));
        assert!(!second.contains("x-plex-token:"));
        assert!(!second.contains("cookie:"));
    }

    #[tokio::test]
    async fn reused_connection_honors_each_request_timeout_including_response_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/library/page", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            for delay_ms in [0, 400, 250] {
                read_test_request(&mut stream);
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n")
                    .unwrap();
                std::thread::sleep(Duration::from_millis(delay_ms));
                // The final request intentionally times out before its body.
                let _ = stream.write_all(b"{}");
            }
        });
        for timeout_ms in [200, 2000] {
            let response = proxy_http(
                url.clone(),
                "GET".into(),
                None,
                None,
                Some(timeout_ms),
                None,
                None,
            )
            .await
            .unwrap();
            assert_eq!(response.body, "{}");
        }
        let error = proxy_http(url, "GET".into(), None, None, Some(75), None, None)
            .await
            .unwrap_err();
        assert!(error.timeout);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn screenshot_and_provider_requests_use_separate_connection_pools() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/endpoint", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut provider, _) = listener.accept().unwrap();
            read_test_request(&mut provider);
            provider
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                .unwrap();
            listener.set_nonblocking(true).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let mut screenshot = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "screenshot reused the provider connection"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("accept screenshot connection: {error}"),
                }
            };
            read_test_request(&mut screenshot);
            screenshot
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .unwrap();
            // Returning to provider traffic must retain its original connection.
            read_test_request(&mut provider);
            provider
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .unwrap();
        });
        for screenshot in [false, true, false] {
            let response = proxy_http(
                url.clone(),
                "GET".into(),
                None,
                None,
                Some(2000),
                None,
                Some(screenshot),
            )
            .await
            .unwrap();
            assert_eq!(response.status, 200);
        }
        server.join().unwrap();
    }

    #[tokio::test]
    async fn full_screenshot_body_reaches_only_the_selected_endpoint_on_redirect() {
        // A 1 MiB binary image occupies 1,398,104 base64 characters. Exercise the
        // actual production bridge with this budget, not a tiny empty request.
        let body = format!(
            r#"{{"data":{{"image":"{}=="}},"id":"shot","status":"ok"}}"#,
            "A".repeat(1_398_102)
        );
        for redirect_status in [307, 308] {
            let selected = TcpListener::bind("127.0.0.1:0").unwrap();
            let selected_address = selected.local_addr().unwrap();
            let destination = TcpListener::bind("127.0.0.1:0").unwrap();
            let destination_address = destination.local_addr().unwrap();
            let selected_server = std::thread::spawn(move || {
                let (mut stream, _) = selected.accept().unwrap();
                let request = read_test_request(&mut stream);
                stream.write_all(format!("HTTP/1.1 {redirect_status} Redirect\r\nLocation: http://{destination_address}/image-leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
                request
            });
            let response = proxy_http(
                format!("http://{selected_address}/api/responses"),
                "POST".into(),
                Some(body.clone()),
                Some(HashMap::from([(
                    "Authorization".into(),
                    "Bearer fixture".into(),
                )])),
                Some(1000),
                None,
                Some(true),
            )
            .await;
            let (headers, received) = selected_server.join().unwrap();
            assert_eq!(received.len(), body.len());
            assert!(received == body.as_bytes());
            assert!(headers
                .to_ascii_lowercase()
                .contains("authorization: bearer fixture\r\n"));
            // A followed redirect would have opened a queued TCP connection even
            // if its upload then timed out. The second server must receive none.
            destination.set_nonblocking(true).unwrap();
            assert!(
                matches!(destination.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
                "the screenshot redirect destination received a connection"
            );
            assert_eq!(response.unwrap().status, redirect_status);
        }
    }

    #[tokio::test]
    async fn screenshot_acknowledgement_is_bounded_with_or_without_content_length() {
        for chunked in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                read_test_request(&mut stream);
                let body = "x".repeat(64 * 1024 + 1);
                let response = if chunked {
                    format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n", body.len())
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                };
                let _ = stream.write_all(response.as_bytes());
            });
            let error = proxy_http(
                format!("http://{address}/api/responses"),
                "POST".into(),
                Some("{}".into()),
                None,
                Some(1000),
                None,
                Some(true),
            )
            .await
            .unwrap_err();
            server.join().unwrap();
            assert!(error.message.contains("acknowledgement exceeds"));
        }
    }
}
