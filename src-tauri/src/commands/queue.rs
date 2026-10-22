//! Native Mode B command queues. Internal IPC is always available.
//!
//! Optional loopback HTTP starts only through the settings IPC, with a 32–256
//! character device code. Environment variables cannot enable it. Every endpoint
//! requires its Bearer token; browser Origin requests and CORS preflights are refused. Tokens are never logged.
//! Prefer :18081, fall back through :18090; OTTPLAY_QUEUE_PORT pins an exact port.
//!
//! GET /api/webhook/health (/webhook/health), GET/POST /api/webhook/commands
//! (/webhook/poll, /webhook/notify) retain their JSON contracts. device_id is optional.
//! Queues expire after 60s. Payload, device count, total bytes and request rate are
//! bounded. Polling an unknown device does not allocate a queue.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use axum::response::{IntoResponse, Response as HttpResponse};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{json, Value as JsonValue};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, RwLock};
use tokio::task::{JoinHandle, JoinSet};

const EXPIRE_SECS: f64 = 60.0;
const DEVICE_CAP: usize = 50;
const DEVICE_TRIM: usize = 25;
const BROADCAST_CAP: usize = 100;
const BROADCAST_TRIM: usize = 50;
const MAX_DEVICES: usize = 64;
const MAX_BODY_BYTES: usize = 16 * 1024;
const MAX_QUEUE_BYTES: usize = 2 * 1024 * 1024;
const MAX_DEVICE_ID_BYTES: usize = 128;
const MAX_URL_BYTES: usize = 2048;
const MAX_HEADER_BYTES: usize = 8192;
const MAX_HEADERS: usize = 64;
const REQUESTS_PER_MINUTE: usize = 120;

pub const DEFAULT_QUEUE_PORT: u16 = 18081;
pub const QUEUE_PORT_FALLBACK_END: u16 = 18090;
const BACKEND_ID: &str = "tauri";

#[derive(Default)]
pub struct CommandQueues {
    pub devices: HashMap<String, Vec<JsonValue>>,
    pub broadcast: Vec<JsonValue>,
}
pub type SharedQueues = Arc<RwLock<CommandQueues>>;
// The listener and all its connections belong to a single cancellable task.
// Serializing configuration prevents rapid toggle/rotation calls from leaving an
// old listener behind. Dropping app state also closes it.
#[derive(Clone, Default)]
pub struct QueueHttpRuntime {
    inner: Arc<Mutex<Option<RunningHttp>>>,
}

struct RunningHttp {
    access: Arc<HttpAccess>,
    port: u16,
    task: JoinHandle<()>,
}

impl Drop for RunningHttp {
    fn drop(&mut self) {
        self.access.active.store(false, Ordering::SeqCst);
        self.task.abort();
    }
}

pub fn new_shared() -> SharedQueues {
    Arc::new(RwLock::new(CommandQueues::default()))
}

fn now_ts() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

// Deliberately not Debug: accidental diagnostics must not expose the credential.
struct HttpAccess {
    token: String,
    active: AtomicBool,
}

impl HttpAccess {
    fn from_values(enabled: bool, token: Option<&str>) -> Option<Self> {
        if !enabled {
            return None;
        }
        let token = token?;
        if !(32..=256).contains(&token.len())
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        {
            return None;
        }
        Some(Self {
            token: token.to_string(),
            active: AtomicBool::new(true),
        })
    }

    fn authorized(&self, req: &Request<Body>) -> bool {
        if !self.active.load(Ordering::SeqCst) {
            return false;
        }
        let mut headers = req.headers().get_all("authorization").iter();
        let Some(header) = headers.next() else {
            return false;
        };
        if headers.next().is_some() {
            return false;
        }
        let Some(value) = header.to_str().ok().and_then(|h| h.strip_prefix("Bearer ")) else {
            return false;
        };
        let mut difference = value.len() ^ self.token.len();
        for (a, b) in value.bytes().zip(self.token.bytes()) {
            difference |= usize::from(a ^ b);
        }
        difference == 0
    }
}

struct RequestLimit {
    since: Instant,
    used: usize,
}

impl RequestLimit {
    fn new() -> Self {
        Self {
            since: Instant::now(),
            used: 0,
        }
    }

    fn allow(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.since) >= Duration::from_secs(60) {
            self.since = now;
            self.used = 0;
        }
        if self.used >= REQUESTS_PER_MINUTE {
            return false;
        }
        self.used += 1;
        true
    }
}

fn json_response(status: u16, body: JsonValue) -> HttpResponse {
    (
        StatusCode::from_u16(status).unwrap(),
        [
            ("cache-control", "no-store"),
            ("x-content-type-options", "nosniff"),
        ],
        axum::Json(body),
    )
        .into_response()
}

fn error_response(status: u16, message: &str) -> HttpResponse {
    json_response(status, json!({"error": message}))
}

fn path_matches(path: &str, candidates: &[&str]) -> bool {
    candidates.contains(&path)
}

fn checked_device_id(value: &str) -> Result<String, &'static str> {
    if value.bytes().any(|b| b.is_ascii_control()) {
        return Err("Invalid device_id");
    }
    let id = value.trim();
    if id.len() > MAX_DEVICE_ID_BYTES
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    {
        return Err("Invalid device_id");
    }
    Ok(id.to_string())
}

fn extract_device_id(url: &str) -> Result<String, &'static str> {
    let mut device = None;
    let query = url.split_once('?').map(|(_, query)| query).unwrap_or("");
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        if key == "device_id" {
            if device.is_some() {
                return Err("Duplicate device_id");
            }
            device = Some(checked_device_id(&value)?);
        }
    }
    Ok(device.unwrap_or_default())
}

fn prune(queues: &mut CommandQueues, now: f64) {
    let cutoff = now - EXPIRE_SECS;
    let recent =
        |value: &JsonValue| value.get("ts").and_then(JsonValue::as_f64).unwrap_or(0.0) > cutoff;
    queues.broadcast.retain(recent);
    queues.devices.retain(|_, values| {
        values.retain(recent);
        !values.is_empty()
    });
}

fn enqueue(
    queues: &mut CommandQueues,
    device: &str,
    mut data: JsonValue,
    now: f64,
) -> Result<usize, &'static str> {
    let device = checked_device_id(device)?;
    if let Some(object) = data.as_object_mut() {
        object.insert("ts".to_string(), json!(now));
    } else {
        data = json!({"value": data, "ts": now});
    }
    let bytes = serde_json::to_vec(&data)
        .map_err(|_| "Invalid command")?
        .len();
    if bytes > MAX_BODY_BYTES {
        return Err("Command too large");
    }
    prune(queues, now);
    if !device.is_empty()
        && !queues.devices.contains_key(&device)
        && queues.devices.len() >= MAX_DEVICES
    {
        return Err("Too many device queues");
    }
    let stored_bytes: usize = queues
        .broadcast
        .iter()
        .chain(queues.devices.values().flatten())
        .map(|value| {
            serde_json::to_vec(value)
                .map(|v| v.len())
                .unwrap_or(MAX_QUEUE_BYTES)
        })
        .sum();
    if stored_bytes.saturating_add(bytes) > MAX_QUEUE_BYTES {
        return Err("Queue capacity reached");
    }
    let (values, cap, trim) = if device.is_empty() {
        (&mut queues.broadcast, BROADCAST_CAP, BROADCAST_TRIM)
    } else {
        (
            queues.devices.entry(device).or_default(),
            DEVICE_CAP,
            DEVICE_TRIM,
        )
    };
    values.push(data);
    if values.len() > cap {
        values.drain(0..values.len() - trim);
    }
    Ok(values.len())
}

fn poll(queues: &mut CommandQueues, device: &str, now: f64) -> Result<JsonValue, &'static str> {
    let device = checked_device_id(device)?;
    prune(queues, now);
    let values = if device.is_empty() {
        std::mem::take(&mut queues.broadcast)
    } else {
        queues.devices.remove(&device).unwrap_or_default()
    };
    Ok(JsonValue::Array(values))
}

fn ports_to_try() -> Vec<u16> {
    if let Ok(raw) = std::env::var("OTTPLAY_QUEUE_PORT") {
        if !raw.trim().is_empty() {
            return match raw.trim().parse::<u16>() {
                Ok(port) if port > 0 => vec![port],
                _ => {
                    tracing::error!("command queue: invalid OTTPLAY_QUEUE_PORT");
                    Vec::new()
                }
            };
        }
    }
    (DEFAULT_QUEUE_PORT..=QUEUE_PORT_FALLBACK_END).collect()
}

async fn try_bind(ports: &[u16]) -> Result<(TcpListener, u16), String> {
    let mut last_error = String::from("no ports to try");
    for port in ports {
        match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, *port)).await {
            Ok(listener) => {
                let port = listener.local_addr().map_err(|e| e.to_string())?.port();
                return Ok((listener, port));
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(last_error)
}

async fn serve_http(
    listener: TcpListener,
    port: u16,
    queues: SharedQueues,
    access: Arc<HttpAccess>,
) {
    let limit = Arc::new(Mutex::new(RequestLimit::new()));
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, remote)) = accepted else { break };
                // Bound accepted sockets, including clients that never finish headers.
                if connections.len() >= 32 { continue; }
                let queues = queues.clone();
                let access = access.clone();
                let limit = limit.clone();
                connections.spawn(async move {
                    let service = service_fn(move |request: Request<hyper::body::Incoming>| {
                        let queues = queues.clone();
                        let access = access.clone();
                        let limit = limit.clone();
                        async move {
                            Ok::<_, Infallible>(handle_request(
                                request.map(Body::new), &queues, port, &access, &limit, remote,
                            ).await)
                        }
                    });
                    // A closed/disabled listener aborts this task too via JoinSet.
                    // Connection lifetime also bounds incomplete headers and bodies.
                    let mut http = http1::Builder::new();
                    http.keep_alive(false)
                        .max_buf_size(MAX_HEADER_BYTES)
                        .timer(TokioTimer::new())
                        .header_read_timeout(Duration::from_secs(2));
                    let _ = tokio::time::timeout(
                        Duration::from_secs(5),
                        http.serve_connection(TokioIo::new(stream), service),
                    ).await;
                });
            }
            _ = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

impl QueueHttpRuntime {
    async fn configure(
        &self,
        queues: &SharedQueues,
        enabled: bool,
        token: Option<&str>,
        ports: &[u16],
    ) -> Result<JsonValue, String> {
        let mut running = self.inner.lock().await;
        if let Some(mut previous) = running.take() {
            // Revoke before cancelling; an already dispatched request must also
            // check this while holding the queue lock before draining/enqueueing.
            previous.access.active.store(false, Ordering::SeqCst);
            previous.task.abort();
            let _ = (&mut previous.task).await;
        }
        *queues.write().await = CommandQueues::default();
        if !enabled {
            return Ok(http_status(0));
        }
        let access = Arc::new(
            HttpAccess::from_values(true, token)
                .ok_or_else(|| "A valid device code is required".to_string())?,
        );
        let (listener, port) = try_bind(ports)
            .await
            .map_err(|_| "Unable to bind command queue on loopback".to_string())?;
        let task = tokio::spawn(serve_http(listener, port, queues.clone(), access.clone()));
        *running = Some(RunningHttp { access, port, task });
        Ok(http_status(port))
    }

    async fn status(&self) -> JsonValue {
        let running = self.inner.lock().await;
        let port = running
            .as_ref()
            .filter(|r| !r.task.is_finished())
            .map(|r| r.port)
            .unwrap_or(0);
        http_status(port)
    }
}

fn http_status(port: u16) -> JsonValue {
    json!({"httpEnabled":port != 0, "running":port != 0, "port":port, "backend":BACKEND_ID})
}

async fn handle_request(
    req: Request<Body>,
    queues: &SharedQueues,
    port: u16,
    access: &HttpAccess,
    limit: &Mutex<RequestLimit>,
    remote: SocketAddr,
) -> HttpResponse {
    if !limit.lock().await.allow(Instant::now()) {
        return error_response(429, "Request limit reached");
    }
    if !remote.ip().is_loopback() {
        return error_response(403, "Loopback clients only");
    }
    let url = req.uri().to_string();
    if url.len() > MAX_URL_BYTES {
        return error_response(414, "Request URL too long");
    }
    let header_bytes: usize = req
        .headers()
        .iter()
        .map(|(h, v)| h.as_str().len() + v.len())
        .sum();
    if req.headers().len() > MAX_HEADERS || header_bytes > MAX_HEADER_BYTES {
        return error_response(431, "Request headers too large");
    }
    if !access.authorized(&req) {
        let mut response = error_response(401, "Bearer authorization required");
        response
            .headers_mut()
            .insert("www-authenticate", "Bearer".parse().unwrap());
        return response;
    }
    if req.headers().contains_key("origin") {
        return error_response(403, "Browser-origin requests are not supported");
    }
    let path = url.split('?').next().unwrap_or("").trim_end_matches('/');
    let is_health = path_matches(path, &["/api/webhook/health", "/webhook/health"])
        && req.method() == Method::GET;
    let is_post = path_matches(path, &["/api/webhook/commands", "/webhook/notify"])
        && req.method() == Method::POST;
    let is_get = path_matches(path, &["/api/webhook/commands", "/webhook/poll"])
        && req.method() == Method::GET;
    if !is_health && !is_post && !is_get {
        return error_response(404, "Not Found");
    }
    if req.headers().contains_key("transfer-encoding") || req.headers().contains_key("expect") {
        return error_response(400, "Use a fixed Content-Length without Expect");
    }
    let lengths = req
        .headers()
        .get_all("content-length")
        .iter()
        .collect::<Vec<_>>();
    let length = lengths
        .first()
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.parse::<usize>().ok());
    if lengths.len() > 1 || (lengths.len() == 1 && length.is_none()) {
        return error_response(400, "Invalid Content-Length");
    }
    if is_post && lengths.len() != 1 {
        return error_response(411, "Content-Length required");
    }
    if length.unwrap_or(0) > MAX_BODY_BYTES {
        return error_response(413, "Request body too large");
    }
    if !is_post && length.unwrap_or(0) != 0 {
        return error_response(400, "Unexpected request body");
    }
    if is_health {
        return json_response(
            200,
            json!({"status":"ok", "service":"ottplay-command-queue", "backend":BACKEND_ID, "port":port}),
        );
    }
    let device = match extract_device_id(&url) {
        Ok(device) => device,
        Err(error) => return error_response(400, error),
    };
    if is_post {
        let body = match tokio::time::timeout(
            Duration::from_secs(2),
            to_bytes(req.into_body(), MAX_BODY_BYTES),
        )
        .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(_)) => return error_response(400, "Unable to read request body"),
            Err(_) => return error_response(408, "Request body timeout"),
        };
        if body.len() != length.unwrap_or(0) {
            return error_response(400, "Invalid Content-Length");
        }
        let data = match serde_json::from_slice(&body) {
            Ok(data) => data,
            Err(_) => return error_response(400, "Invalid JSON"),
        };
        let mut queues = queues.write().await;
        if !access.active.load(Ordering::SeqCst) {
            return error_response(401, "Device code revoked");
        }
        match enqueue(&mut queues, &device, data, now_ts()) {
            Ok(count) => json_response(200, json!({"status":"ok", "queued":count})),
            Err(error) => error_response(429, error),
        }
    } else {
        let mut queues = queues.write().await;
        if !access.active.load(Ordering::SeqCst) {
            return error_response(401, "Device code revoked");
        }
        match poll(&mut queues, &device, now_ts()) {
            Ok(data) => json_response(200, data),
            Err(error) => error_response(400, error),
        }
    }
}

// ─── Tauri IPC surface (for direct JS invoke) ───────────────────────────────

#[tauri::command]
pub async fn queue_port(runtime: tauri::State<'_, QueueHttpRuntime>) -> Result<JsonValue, String> {
    Ok(runtime.status().await)
}

#[tauri::command]
pub async fn queue_http_configure(
    runtime: tauri::State<'_, QueueHttpRuntime>,
    state: tauri::State<'_, crate::commands::tauri_commands::TauriState>,
    enabled: bool,
    token: Option<String>,
) -> Result<JsonValue, String> {
    runtime
        .configure(
            &state.command_queues,
            enabled,
            token.as_deref(),
            &ports_to_try(),
        )
        .await
}

#[tauri::command]
pub async fn queue_poll(
    state: tauri::State<'_, crate::commands::tauri_commands::TauriState>,
    device_id: Option<String>,
) -> Result<JsonValue, String> {
    poll(
        &mut *state.command_queues.write().await,
        &device_id.unwrap_or_default(),
        now_ts(),
    )
    .map_err(str::to_string)
}

#[tauri::command]
pub async fn queue_enqueue(
    state: tauri::State<'_, crate::commands::tauri_commands::TauriState>,
    device_id: Option<String>,
    command: JsonValue,
) -> Result<JsonValue, String> {
    let count = enqueue(
        &mut *state.command_queues.write().await,
        &device_id.unwrap_or_default(),
        command,
        now_ts(),
    )
    .map_err(str::to_string)?;
    Ok(json!({"status":"ok", "queued":count}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const TOKEN: &str = "synthetic-local-test-token-1234567890";
    const NEXT_TOKEN: &str = "synthetic-new-device-token-1234567890";

    fn access() -> HttpAccess {
        HttpAccess::from_values(true, Some(TOKEN)).unwrap()
    }

    fn request(
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<&str>,
    ) -> Request<Body> {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        if let Some(body) = body {
            request = request.header("Content-Length", body.len());
        }
        request
            .body(Body::from(body.unwrap_or_default().to_string()))
            .unwrap()
    }

    async fn call(request: Request<Body>, queues: &SharedQueues) -> HttpResponse {
        handle_request(
            request,
            queues,
            18081,
            &access(),
            &Mutex::new(RequestLimit::new()),
            "127.0.0.1:9999".parse().unwrap(),
        )
        .await
    }

    async fn body(response: HttpResponse) -> JsonValue {
        serde_json::from_slice(
            &to_bytes(response.into_body(), MAX_QUEUE_BYTES)
                .await
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn http_requires_explicit_opt_in_and_url_safe_device_code() {
        assert!(HttpAccess::from_values(false, Some(TOKEN)).is_none());
        for token in [
            None,
            Some("short"),
            Some("                                "),
            Some("synthetic-token-with-newline-123456\n"),
            Some("synthetic-token-non-url-safe-123456+/"),
        ] {
            assert!(HttpAccess::from_values(true, token).is_none());
        }
        assert!(HttpAccess::from_values(true, Some(&"a".repeat(257))).is_none());
        assert!(HttpAccess::from_values(true, Some(&"a".repeat(32))).is_some());
        assert!(HttpAccess::from_values(true, Some(&"b".repeat(256))).is_some());
    }

    #[tokio::test]
    async fn every_http_route_requires_bearer_and_has_no_cors() {
        let queues = new_shared();
        enqueue(
            &mut *queues.write().await,
            "",
            json!({"command":"play"}),
            now_ts(),
        )
        .unwrap();
        for (method, path) in [
            (Method::GET, "/api/webhook/health"),
            (Method::GET, "/webhook/health"),
            (Method::GET, "/api/webhook/commands"),
            (Method::GET, "/webhook/poll"),
            (Method::POST, "/api/webhook/commands"),
            (Method::POST, "/webhook/notify"),
            (Method::OPTIONS, "/api/webhook/commands"),
        ] {
            let response = call(request(method, path, None, None), &queues).await;
            assert_eq!(response.status(), 401);
            assert!(response
                .headers()
                .keys()
                .all(|h| !h.as_str().starts_with("access-control-")));
        }
        assert_eq!(
            queues.read().await.broadcast.len(),
            1,
            "unauthorized polling must not drain commands"
        );
        let health = call(
            request(Method::GET, "/api/webhook/health", Some(TOKEN), None),
            &queues,
        )
        .await;
        assert_eq!(health.status(), 200);
        assert_eq!(body(health).await["backend"], "tauri");
        assert_eq!(
            call(
                request(Method::GET, "/webhook/poll", Some(NEXT_TOKEN), None),
                &queues
            )
            .await
            .status(),
            401
        );
        let mut duplicate = request(Method::GET, "/webhook/poll", Some(TOKEN), None);
        duplicate.headers_mut().append(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {TOKEN}")).unwrap(),
        );
        assert_eq!(call(duplicate, &queues).await.status(), 401);
        let mut browser = request(Method::GET, "/webhook/poll", Some(TOKEN), None);
        browser.headers_mut().insert(
            "origin",
            HeaderValue::from_static("https://untrusted.invalid"),
        );
        assert_eq!(call(browser, &queues).await.status(), 403);
        let remote = request(Method::GET, "/webhook/poll", Some(TOKEN), None);
        assert_eq!(
            handle_request(
                remote,
                &queues,
                18081,
                &access(),
                &Mutex::new(RequestLimit::new()),
                "192.0.2.1:9999".parse().unwrap()
            )
            .await
            .status(),
            403
        );
    }

    #[tokio::test]
    async fn authenticated_http_and_internal_ipc_share_device_routing() {
        let queues = new_shared();
        let response = call(
            request(
                Method::POST,
                "/webhook/notify?device_id=living-room",
                Some(TOKEN),
                Some(r#"{"command":"pause","id":"fixture"}"#),
            ),
            &queues,
        )
        .await;
        assert_eq!(response.status(), 200);
        assert_eq!(body(response).await["queued"], 1);
        assert_eq!(
            body(
                call(
                    request(
                        Method::GET,
                        "/webhook/poll?device_id=other",
                        Some(TOKEN),
                        None
                    ),
                    &queues
                )
                .await
            )
            .await,
            json!([])
        );
        assert_eq!(queues.read().await.devices.len(), 1);
        let data = poll(&mut *queues.write().await, "living-room", now_ts()).unwrap();
        assert_eq!(data[0]["command"], "pause");
        assert!(data[0]["ts"].as_f64().is_some());
        enqueue(
            &mut *queues.write().await,
            "",
            json!({"command":"stop"}),
            now_ts(),
        )
        .unwrap();
        let result = body(
            call(
                request(Method::GET, "/api/webhook/commands", Some(TOKEN), None),
                &queues,
            )
            .await,
        )
        .await;
        assert_eq!(result[0]["command"], "stop");
        assert!(queues.read().await.broadcast.is_empty());
    }

    #[tokio::test]
    async fn http_rejects_oversize_and_ambiguous_requests_before_enqueue() {
        let queues = new_shared();
        let mut too_large = request(Method::POST, "/webhook/notify", Some(TOKEN), None);
        too_large.headers_mut().insert(
            "content-length",
            HeaderValue::from_str(&(MAX_BODY_BYTES + 1).to_string()).unwrap(),
        );
        assert_eq!(call(too_large, &queues).await.status(), 413);
        let url = format!("/webhook/poll?device_id={}", "x".repeat(MAX_URL_BYTES));
        assert_eq!(
            call(request(Method::GET, &url, Some(TOKEN), None), &queues)
                .await
                .status(),
            414
        );
        let mut headers = request(Method::GET, "/webhook/poll", Some(TOKEN), None);
        headers.headers_mut().insert(
            "x-filler",
            HeaderValue::from_str(&"x".repeat(MAX_HEADER_BYTES)).unwrap(),
        );
        assert_eq!(call(headers, &queues).await.status(), 431);
        for url in [
            "/webhook/notify?device_id=a&device_id=b",
            "/webhook/notify?device_id=%0Ainvalid",
            "/webhook/notify?device_id=%3Cscript%3E",
        ] {
            assert_eq!(
                call(request(Method::POST, url, Some(TOKEN), Some("{}")), &queues)
                    .await
                    .status(),
                400
            );
        }
        for (name, value) in [("transfer-encoding", "chunked"), ("expect", "100-continue")] {
            let mut req = request(Method::POST, "/webhook/notify", Some(TOKEN), None);
            req.headers_mut()
                .insert(name, HeaderValue::from_static(value));
            assert_eq!(call(req, &queues).await.status(), 400);
        }
        assert_eq!(
            call(
                request(
                    Method::POST,
                    "/webhook/notify",
                    Some(TOKEN),
                    Some("not-json")
                ),
                &queues
            )
            .await
            .status(),
            400
        );
        assert_eq!(
            call(
                request(Method::POST, "/webhook/notify", Some(TOKEN), None),
                &queues
            )
            .await
            .status(),
            411
        );
        let mut duplicate = request(Method::POST, "/webhook/notify", Some(TOKEN), Some("{}"));
        duplicate
            .headers_mut()
            .append("content-length", HeaderValue::from_static("2"));
        assert_eq!(call(duplicate, &queues).await.status(), 400);
        assert!(queues.read().await.broadcast.is_empty());
        assert!(queues.read().await.devices.is_empty());
    }

    #[tokio::test]
    async fn configuration_is_off_by_default_and_internal_ipc_remains_available() {
        let runtime = QueueHttpRuntime::default();
        let queues = new_shared();
        assert_eq!(runtime.status().await, http_status(0));
        assert!(runtime
            .configure(&queues, true, Some("short"), &[0])
            .await
            .is_err());
        assert_eq!(runtime.status().await, http_status(0));
        assert_eq!(
            runtime.configure(&queues, false, None, &[0]).await.unwrap(),
            http_status(0)
        );
        enqueue(
            &mut *queues.write().await,
            "",
            json!({"command":"play"}),
            now_ts(),
        )
        .unwrap();
        assert_eq!(
            poll(&mut *queues.write().await, "", now_ts()).unwrap()[0]["command"],
            "play"
        );
    }

    #[tokio::test]
    async fn enable_rotate_disable_closes_listener_and_revokes_old_code() {
        let runtime = QueueHttpRuntime::default();
        let queues = new_shared();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let status = runtime
            .configure(&queues, true, Some(TOKEN), &[0])
            .await
            .unwrap();
        let port = status["port"].as_u64().unwrap() as u16;
        assert_eq!(status["running"], true);
        let url = format!("http://127.0.0.1:{port}/api/webhook/commands");
        assert_eq!(
            client
                .post(&url)
                .json(&json!({"command":"stop"}))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            client
                .post(&url)
                .bearer_auth(TOKEN)
                .json(&json!({"command":"pause"}))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        assert_eq!(queues.read().await.broadcast.len(), 1);
        let rotated = runtime
            .configure(&queues, true, Some(NEXT_TOKEN), &[port])
            .await
            .unwrap();
        assert_eq!(rotated["port"], port);
        assert!(queues.read().await.broadcast.is_empty());
        assert_eq!(
            client
                .get(&url)
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            client
                .get(&url)
                .bearer_auth(NEXT_TOKEN)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        runtime
            .configure(&queues, false, None, &[port])
            .await
            .unwrap();
        assert!(
            tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
                .await
                .is_err()
        );
        assert!(TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn disabling_aborts_partial_requests_and_invalid_rotation_fails_closed() {
        let runtime = QueueHttpRuntime::default();
        let queues = new_shared();
        let status = runtime
            .configure(&queues, true, Some(TOKEN), &[0])
            .await
            .unwrap();
        let port = status["port"].as_u64().unwrap() as u16;
        let old_access = runtime.inner.lock().await.as_ref().unwrap().access.clone();
        let mut partial = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        partial.write_all(format!("POST /webhook/notify HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: 100\r\n\r\n{{").as_bytes()).await.unwrap();
        tokio::task::yield_now().await;
        let stopped = tokio::time::timeout(
            Duration::from_millis(500),
            runtime.configure(&queues, false, None, &[port]),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(stopped, http_status(0));
        assert!(!old_access.active.load(Ordering::SeqCst));
        // A rejection may already be buffered before cancellation. Drain it and
        // require EOF/reset within the deadline instead of requiring the first
        // read to be empty; no successful response may escape for a partial body.
        let mut received = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(1), partial.read_to_end(&mut received))
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&received).contains("200 OK"));
        assert!(queues.read().await.broadcast.is_empty());
        runtime
            .configure(&queues, true, Some(NEXT_TOKEN), &[port])
            .await
            .unwrap();
        assert!(runtime
            .configure(&queues, true, Some("invalid"), &[port])
            .await
            .is_err());
        assert_eq!(runtime.status().await, http_status(0));
        assert!(TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn revoked_requests_cannot_change_queues_after_waiting_for_lock() {
        for method in [Method::GET, Method::POST] {
            let queues = new_shared();
            let access = Arc::new(access());
            let mut guard = queues.write().await;
            enqueue(&mut guard, "", json!({"command":"play"}), now_ts()).unwrap();
            let cloned_queues = queues.clone();
            let cloned_access = access.clone();
            let payload = if method == Method::POST {
                Some(r#"{"command":"stop"}"#)
            } else {
                None
            };
            let pending = tokio::spawn(async move {
                handle_request(
                    request(method, "/api/webhook/commands", Some(TOKEN), payload),
                    &cloned_queues,
                    18081,
                    &cloned_access,
                    &Mutex::new(RequestLimit::new()),
                    "127.0.0.1:9999".parse().unwrap(),
                )
                .await
            });
            tokio::task::yield_now().await;
            access.active.store(false, Ordering::SeqCst);
            drop(guard);
            assert_eq!(pending.await.unwrap().status(), 401);
            assert_eq!(queues.read().await.broadcast.len(), 1);
        }
    }

    #[tokio::test]
    async fn failed_bind_keeps_listener_disabled_and_frees_previous_port() {
        let runtime = QueueHttpRuntime::default();
        let queues = new_shared();
        let occupied = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let occupied_port = occupied.local_addr().unwrap().port();
        let status = runtime
            .configure(&queues, true, Some(TOKEN), &[0])
            .await
            .unwrap();
        let previous_port = status["port"].as_u64().unwrap() as u16;
        assert!(runtime
            .configure(&queues, true, Some(NEXT_TOKEN), &[occupied_port])
            .await
            .is_err());
        assert_eq!(runtime.status().await, http_status(0));
        assert!(
            TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, previous_port))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn concurrent_configuration_leaves_only_one_listener() {
        let runtime = QueueHttpRuntime::default();
        let queues = new_shared();
        let (first, second) = tokio::join!(
            runtime.configure(&queues, true, Some(TOKEN), &[0]),
            runtime.configure(&queues, true, Some(NEXT_TOKEN), &[0]),
        );
        let first = first.unwrap()["port"].as_u64().unwrap() as u16;
        let second = second.unwrap()["port"].as_u64().unwrap() as u16;
        let active = runtime.status().await["port"].as_u64().unwrap() as u16;
        assert!(active == first || active == second);
        if first != second {
            let stopped = if active == first { second } else { first };
            assert!(TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, stopped))
                .await
                .is_ok());
        }
        runtime
            .configure(&queues, false, None, &[active])
            .await
            .unwrap();
        assert!(TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, active))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn request_rate_resets_without_sleeping() {
        let queues = new_shared();
        let mut rate = RequestLimit::new();
        for _ in 0..REQUESTS_PER_MINUTE {
            assert!(rate.allow(rate.since));
        }
        let limit = Mutex::new(rate);
        assert_eq!(
            handle_request(
                request(Method::GET, "/webhook/health", Some(TOKEN), None),
                &queues,
                18081,
                &access(),
                &limit,
                "127.0.0.1:9999".parse().unwrap()
            )
            .await
            .status(),
            429
        );
        let mut rate = limit.lock().await;
        let reset = rate.since + Duration::from_secs(60);
        assert!(rate.allow(reset));
    }
    #[test]
    fn queues_prune_empty_devices_and_keep_memory_bounded() {
        let mut queues = CommandQueues::default();
        for n in 0..1000 {
            assert_eq!(
                poll(&mut queues, &format!("unknown-{n}"), 100.0).unwrap(),
                json!([])
            );
        }
        assert!(queues.devices.is_empty());
        for n in 0..MAX_DEVICES {
            enqueue(
                &mut queues,
                &format!("device-{n}"),
                json!({"command":"play"}),
                100.0,
            )
            .unwrap();
        }
        assert_eq!(
            enqueue(&mut queues, "overflow", json!({}), 100.0),
            Err("Too many device queues")
        );
        assert!(enqueue(&mut queues, "after-expiry", json!({}), 161.0).is_ok());
        assert_eq!(queues.devices.len(), 1);
        assert_eq!(
            enqueue(&mut queues, "bad/id", json!({}), 161.0),
            Err("Invalid device_id")
        );
        assert_eq!(
            enqueue(
                &mut queues,
                "x",
                json!({"url":"x".repeat(MAX_BODY_BYTES)}),
                161.0
            ),
            Err("Command too large")
        );
        let payload = json!({"url":"x".repeat(MAX_BODY_BYTES - 100)});
        let mut limited = CommandQueues::default();
        let mut count = 0;
        loop {
            match enqueue(
                &mut limited,
                &format!("device-{}", count % MAX_DEVICES),
                payload.clone(),
                100.0,
            ) {
                Ok(_) => count += 1,
                Err(error) => {
                    assert_eq!(error, "Queue capacity reached");
                    break;
                }
            }
            assert!(count < 200, "serialized queue bytes must remain bounded");
        }
        assert!(count > 100);
        assert!(enqueue(&mut limited, "fresh", json!({}), 161.0).is_ok());
        assert_eq!(limited.devices.len(), 1);
    }
}
