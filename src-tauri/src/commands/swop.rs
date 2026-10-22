//! Explicit native SWOP relay capability, isolated from provider HTTP/cookies.
use serde::Serialize;
use std::time::Duration;

const LIMIT: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwopResponse {
    status: u16,
    status_text: String,
    body: String,
    headers: &'static str,
}

#[derive(Debug, Serialize)]
pub struct SwopError {
    message: &'static str,
    timeout: bool,
}

fn invalid() -> SwopError {
    SwopError {
        message: "Native remote text entry request failed",
        timeout: false,
    }
}

impl From<reqwest::Error> for SwopError {
    fn from(error: reqwest::Error) -> Self {
        Self {
            timeout: error.is_timeout(),
            ..invalid()
        }
    }
}

fn validate(raw: &str, body: &str, client_id: &str) -> Result<reqwest::Url, SwopError> {
    // Compare the raw authority/path, before URL parsers normalize dot segments,
    // backslashes, escapes, alternate IP forms or userinfo.
    let (scheme, rest) = raw.split_once("://").ok_or_else(invalid)?;
    let (authority, path) = rest.split_once('/').ok_or_else(invalid)?;
    if !matches!(path, "swop/session" | "swop/val")
        || authority.is_empty()
        || !authority
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b))
    {
        return Err(invalid());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| invalid())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || url.port() == Some(0)
    {
        return Err(invalid());
    }
    let raw_host = if authority.starts_with('[') {
        authority
            .split_once(']')
            .map(|(host, _)| format!("{host}]"))
            .ok_or_else(invalid)?
    } else {
        authority.split(':').next().unwrap_or("").to_string()
    };
    if scheme != "https"
        && !(scheme == "http" && matches!(raw_host.as_str(), "127.0.0.1" | "[::1]"))
    {
        return Err(invalid());
    }
    if body.len() > LIMIT
        || !serde_json::from_str::<serde_json::Value>(body)
            .map(|v| v.is_object())
            .unwrap_or(false)
        || client_id.is_empty()
        || client_id.len() > 128
        || !client_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    {
        return Err(invalid());
    }
    Ok(url)
}

/// Origin here is a native assertion about the explicitly configured relay.
/// It is NOT browser provenance or authorization. The bearer stays on the relay.
#[tauri::command]
pub async fn swop_http(
    url: String,
    body: String,
    client_id: String,
) -> Result<SwopResponse, SwopError> {
    let url = validate(&url, &body, &client_id)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .cookie_store(false)
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()?;
    let origin = url.origin().ascii_serialization();
    let mut response = client
        .post(url)
        .header("Origin", origin)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("X-Swop-Client-Id", client_id)
        .body(body)
        .send()
        .await?;
    let status = response.status();
    if status.is_redirection()
        || response
            .content_length()
            .map(|n| n > LIMIT as u64)
            .unwrap_or(false)
    {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > LIMIT {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| invalid())?;
    Ok(SwopResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").into(),
        body,
        headers: "Content-Type: application/json\r\n",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    #[test]
    fn rejects_ambiguous_urls_and_oversized_or_nonobject_json() {
        for url in [
            "http://relay.example/swop/session",
            "http://localhost/swop/val",
            "http://127.1/swop/val",
            "http://2130706433/swop/val",
            "https://user:pass@relay.example/swop/session",
            "https://relay.example/swop/session?x",
            "https://relay.example/swop/session#x",
            "https://relay.example/x/../swop/val",
            "https://relay.example/swop/%76al",
            "https://relay.example/swop/val/",
            "https://relay.example:0/swop/val",
            "https://relay.example:65536/swop/val",
            "https://relay.example\\@evil.example/swop/val",
            "https://relay.example/swop/a.php",
        ] {
            assert!(validate(url, "{}", "device").is_err(), "{url}");
        }
        for url in [
            "https://relay.example/swop/session",
            "http://127.0.0.1:8443/swop/val",
            "http://[::1]:8443/swop/val",
        ] {
            assert!(validate(url, "{}", "device-123").is_ok(), "{url}");
        }
        assert!(validate("https://relay.example/swop/val", "[]", "device").is_err());
        assert!(validate("https://relay.example/swop/val", "{}", "bad\r\nheader").is_err());
        let oversized = serde_json::json!({"draft": "я".repeat(32768)}).to_string();
        assert!(validate("https://relay.example/swop/val", &oversized, "device").is_err());
    }

    fn fixture(
        status: &str,
        extra_headers: &str,
        body: Vec<u8>,
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/swop/session", listener.local_addr().unwrap());
        let status = status.to_owned();
        let extra = extra_headers.to_owned();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut request = String::new();
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some(size) = line.to_lowercase().strip_prefix("content-length:") {
                    length = size.trim().parse().unwrap();
                }
                request.push_str(&line);
            }
            let mut received = vec![0; length];
            reader.read_exact(&mut received).unwrap();
            request.push_str(std::str::from_utf8(&received).unwrap());
            let length = if extra.contains("Transfer-Encoding:") {
                String::new()
            } else {
                format!("Content-Length: {}\r\n", body.len())
            };
            let header = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{extra}{length}Connection: close\r\n\r\n");
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(&body);
            request
        });
        (url, server)
    }

    #[tokio::test]
    async fn posts_fixed_headers_and_preserves_http_error_without_response_secrets() {
        let (url, server) = fixture(
            "403 Forbidden",
            "Set-Cookie: secret=value\r\n",
            b"{\"error\":\"denied\"}".to_vec(),
        );
        let origin = reqwest::Url::parse(&url)
            .unwrap()
            .origin()
            .ascii_serialization();
        let response = swop_http(url, "{\"draft\":\"Привет\"}".into(), "device".into())
            .await
            .unwrap();
        assert_eq!(response.status, 403);
        assert_eq!(response.body, "{\"error\":\"denied\"}");
        assert!(!response.headers.to_lowercase().contains("cookie"));
        let request = server.join().unwrap().to_lowercase();
        assert!(request.starts_with("post /swop/session http/1.1\r\n"));
        assert!(request.contains(&format!("origin: {origin}\r\n")));
        assert!(request.contains("content-type: application/json\r\n"));
        assert!(request.contains("x-swop-client-id: device\r\n"));
        assert!(!request.contains("authorization:"));
        assert!(!request.contains("cookie:"));
    }

    #[tokio::test]
    async fn preserves_maximum_unicode_and_control_values() {
        for value in ["界".repeat(8000), "\u{0001}".repeat(8000)] {
            let json = serde_json::json!({"status":"ready", "value":value}).to_string();
            assert!(json.len() > 16 * 1024 && json.len() <= LIMIT);
            let (url, server) = fixture("200 OK", "", json.as_bytes().to_vec());
            let response = swop_http(url, "{}".into(), "device".into()).await.unwrap();
            assert_eq!(response.body, json);
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn rejects_redirect_before_following_and_bounds_response() {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let location = format!(
            "Location: http://{}/swop/session\r\n",
            destination.local_addr().unwrap()
        );
        let (url, server) = fixture("307 Temporary Redirect", &location, vec![]);
        assert!(swop_http(url, "{}".into(), "device".into()).await.is_err());
        server.join().unwrap();
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let (url, server) = fixture("200 OK", "", vec![b'x'; LIMIT + 1]);
        assert!(swop_http(url, "{}".into(), "device".into()).await.is_err());
        server.join().unwrap();
        let chunk = format!("{:x}\r\n{}\r\n0\r\n\r\n", LIMIT + 1, "x".repeat(LIMIT + 1));
        let (url, server) = fixture(
            "200 OK",
            "Transfer-Encoding: chunked\r\n",
            chunk.into_bytes(),
        );
        assert!(swop_http(url, "{}".into(), "device".into()).await.is_err());
        server.join().unwrap();
        let (url, server) = fixture("200 OK", "", vec![0xff]);
        assert!(swop_http(url, "{}".into(), "device".into()).await.is_err());
        server.join().unwrap();
    }
}
