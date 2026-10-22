//! The native WebKit decoder exposes no encoded-byte counter. This relay measures
//! only the segment responses requested by that decoder; it never probes a stream.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::Response,
    routing::any,
    Router,
};
use futures_util::stream;
use reqwest::{cookie::Jar, Url};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::{watch, Mutex as AsyncMutex, Semaphore};

const MAX_MANIFEST: usize = 1024 * 1024;
const MAX_SEGMENT: u64 = 64 * 1024 * 1024;
const MAX_RESOURCES: usize = 2048;
const MAX_URL: usize = 8192;
const MAX_SESSIONS: usize = 4;
const MAX_ORIGINS: usize = 64;
const RESOURCE_AGE: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, PartialEq)]
enum Kind {
    Playlist {
        main: bool,
    },
    Segment {
        main: bool,
        seconds: f64,
        range: Option<(u64, u64)>,
        key: String,
    },
    Other,
}

struct Resource {
    url: Url,
    kind: Kind,
    seen: Mutex<Instant>,
}

#[derive(Default, Clone, Debug, Serialize)]
pub struct NativeHlsStats {
    pub bytes: u64,
    pub seconds: f64,
    pub samples: usize,
}

struct Session {
    // Held through every outstanding relay response after the listener stops.
    _work: Option<ottplay_core::background_work::WorkLease>,
    resources: Mutex<HashMap<String, Arc<Resource>>>,
    samples: Mutex<VecDeque<(String, u64, f64)>>,
    sampled: Mutex<VecDeque<String>>,
    cancel: watch::Sender<bool>,
    client: reqwest::Client,
    jar: Arc<Jar>,
    imported: AsyncMutex<HashSet<String>>,
    seeds: Vec<(String, String)>,
    seeded: Mutex<HashSet<usize>>,
    cookie_bytes: AtomicUsize,
    requests: Arc<Semaphore>,
}

fn playback_cookie_seeds(
    cookies: Vec<tauri::webview::Cookie<'static>>,
) -> Result<(Vec<(String, String)>, usize), String> {
    if cookies.len() > 1024 {
        return Err("Native HLS cookie limit exceeded".into());
    }
    let mut seeds = Vec::new();
    let mut bytes = 0;
    for mut cookie in cookies {
        let Some(domain) = cookie.domain().map(str::to_owned) else {
            continue;
        };
        // Tauri's public Cookie normalizes a leading dot, losing the original
        // host-only flag. Never broaden saved credentials to child hosts.
        // Parent-domain-only authentication can safely fall back to native src.
        cookie.unset_domain();
        let value = cookie.to_string();
        bytes += value.len();
        if value.len() > 8192 || bytes > MAX_MANIFEST {
            return Err("Native HLS cookie limit exceeded".into());
        }
        seeds.push((domain, value));
    }
    Ok((seeds, bytes))
}

impl Session {
    fn new(
        window: Option<tauri::WebviewWindow>,
        work: Option<ottplay_core::background_work::WorkLease>,
    ) -> Result<Arc<Self>, String> {
        let jar = Arc::new(Jar::default());
        let client = reqwest::Client::builder()
            .cookie_provider(jar.clone())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|_| "Unable to initialize native HLS transport")?;
        let cookies = match window {
            Some(window) => window
                .cookies()
                .map_err(|_| "Unable to read playback cookies")?,
            None => Vec::new(),
        };
        let (seeds, cookie_bytes) = playback_cookie_seeds(cookies)?;
        let (cancel, _) = watch::channel(false);
        Ok(Arc::new(Self {
            _work: work,
            resources: Mutex::new(HashMap::new()),
            samples: Mutex::new(VecDeque::new()),
            cancel,
            client,
            jar,
            imported: AsyncMutex::new(HashSet::new()),
            seeds,
            seeded: Mutex::new(HashSet::new()),
            cookie_bytes: AtomicUsize::new(cookie_bytes),
            sampled: Mutex::new(VecDeque::new()),
            requests: Arc::new(Semaphore::new(8)),
        }))
    }

    fn register(&self, url: Url, kind: Kind) -> Result<String, String> {
        validate_url(&url)?;
        let mut resources = self.resources.lock().unwrap();
        for (id, resource) in resources.iter() {
            if resource.url == url && resource.kind == kind {
                *resource.seen.lock().unwrap() = Instant::now();
                return Ok(id.clone());
            }
        }
        if resources.len() >= MAX_RESOURCES {
            resources.retain(|_, r| r.seen.lock().unwrap().elapsed() < RESOURCE_AGE);
        }
        if resources.len() >= MAX_RESOURCES {
            return Err("Native HLS resource limit exceeded".into());
        }
        let id = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            if matches!(kind, Kind::Playlist { .. }) {
                ".m3u8"
            } else {
                ""
            }
        );
        resources.insert(
            id.clone(),
            Arc::new(Resource {
                url,
                kind,
                seen: Mutex::new(Instant::now()),
            }),
        );
        Ok(id)
    }

    fn stats(&self) -> NativeHlsStats {
        let samples = self.samples.lock().unwrap();
        NativeHlsStats {
            bytes: samples.iter().map(|x| x.1).sum(),
            seconds: samples.iter().map(|x| x.2).sum(),
            samples: samples.len(),
        }
    }

    fn sample(&self, resource: &Resource, bytes: u64, seconds: f64, expected: Option<u64>) {
        if *self.cancel.borrow() || bytes == 0 || expected.is_some_and(|length| bytes != length) {
            return;
        }
        let Kind::Segment { key, .. } = &resource.kind else {
            return;
        };
        let mut seen = self.sampled.lock().unwrap();
        if seen.contains(key) {
            return;
        }
        seen.push_back(key.clone());
        if seen.len() > 512 {
            seen.pop_front();
        }
        let mut samples = self.samples.lock().unwrap();
        samples.push_back((key.clone(), bytes, seconds));
        if samples.len() > 8 {
            samples.pop_front();
        }
    }

    async fn import_cookies(&self, url: &Url) -> Result<(), String> {
        let mut imported = self.imported.lock().await;
        let origin = url.origin().ascii_serialization();
        if imported.contains(&origin) {
            return Ok(());
        }
        if imported.len() >= MAX_ORIGINS {
            return Err("Native HLS origin limit exceeded".into());
        }
        let host = url.host_str().unwrap_or_default();
        let mut seeded = self.seeded.lock().unwrap();
        for (index, (domain, value)) in self.seeds.iter().enumerate() {
            let normalized = domain.trim_start_matches('.');
            if !seeded.contains(&index) && host == normalized {
                self.jar.add_cookie_str(value, url);
                seeded.insert(index);
            }
        }
        imported.insert(origin);
        Ok(())
    }

    async fn fetch(
        &self,
        method: Method,
        mut url: Url,
        incoming: &HeaderMap,
    ) -> Result<reqwest::Response, String> {
        let mut cancel = self.cancel.subscribe();
        for _ in 0..10 {
            if *cancel.borrow() {
                return Err("Native HLS session stopped".into());
            }
            validate_url(&url)?;
            if self.cookie_bytes.load(Ordering::Relaxed) > MAX_MANIFEST {
                return Err("Native HLS cookie limit exceeded".into());
            }
            self.import_cookies(&url).await?;
            let mut request = self
                .client
                .request(method.clone(), url.clone())
                .header("accept-encoding", "identity");
            for key in [
                "user-agent",
                "accept",
                "accept-language",
                "range",
                "if-range",
                "if-none-match",
                "if-modified-since",
            ] {
                if let Some(value) = incoming.get(key) {
                    request = request.header(key, value);
                }
            }
            let response = tokio::select! {
                _ = cancel.changed() => return Err("Native HLS session stopped".into()),
                response = request.send() => response.map_err(|_| "Native HLS upstream request failed")?,
            };
            let added = response
                .headers()
                .get_all("set-cookie")
                .iter()
                .map(|v| v.as_bytes().len())
                .sum::<usize>();
            if self.cookie_bytes.fetch_add(added, Ordering::Relaxed) + added > MAX_MANIFEST {
                return Err("Native HLS cookie limit exceeded".into());
            }
            if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .ok_or("Native HLS redirect is invalid")?;
                url = url
                    .join(location)
                    .map_err(|_| "Native HLS redirect is invalid")?;
                continue;
            }
            return Ok(response);
        }
        Err("Native HLS redirect limit exceeded".into())
    }
}

struct Server {
    address: std::net::SocketAddr,
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Default)]
pub struct NativeHlsState {
    server: AsyncMutex<Option<Server>>,
}

#[derive(Debug, Serialize)]
pub struct NativeHlsStart {
    pub url: String,
    pub session: String,
}

impl NativeHlsState {
    #[cfg(test)]
    async fn start(
        &self,
        url: String,
        window: Option<tauri::WebviewWindow>,
    ) -> Result<NativeHlsStart, String> {
        self.start_tracked(url, window, None).await
    }
    async fn start_tracked(
        &self,
        url: String,
        window: Option<tauri::WebviewWindow>,
        work: Option<ottplay_core::background_work::WorkLease>,
    ) -> Result<NativeHlsStart, String> {
        let url = Url::parse(&url).map_err(|_| "Native HLS URL is invalid")?;
        validate_url(&url)?;
        let mut guard = self.server.lock().await;
        if guard.is_none() {
            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .map_err(|_| "Unable to bind native HLS relay")?;
            let address = listener
                .local_addr()
                .map_err(|_| "Unable to inspect native HLS relay")?;
            let sessions = Arc::new(Mutex::new(HashMap::new()));
            let router = Router::new()
                .route("/hls/:session/:resource", any(relay))
                .with_state(sessions.clone())
                .layer(axum::middleware::from_fn(local_cors));
            let task = tokio::spawn(async move {
                let _ = axum::serve(listener, router).await;
            });
            *guard = Some(Server {
                address,
                sessions,
                task,
            });
        }
        let server = guard.as_ref().unwrap();
        if server.sessions.lock().unwrap().len() >= MAX_SESSIONS {
            return Err("Native HLS session limit exceeded".into());
        }
        let session = Session::new(window, work.clone())?;
        let resource = session.register(url, Kind::Playlist { main: true })?;
        let token = uuid::Uuid::new_v4().simple().to_string();
        let insert = || {
            server
                .sessions
                .lock()
                .unwrap()
                .insert(token.clone(), session);
        };
        if let Some(work) = &work {
            work.publish(insert).map_err(str::to_string)?;
        } else {
            insert();
        }
        Ok(NativeHlsStart {
            url: format!("http://{}/hls/{token}/{resource}", server.address),
            session: token,
        })
    }

    /// Nonblocking metadata only; does not start the relay or inspect URLs/cookies.
    pub fn diagnostic_session_count(&self) -> Option<usize> {
        let guard = self.server.try_lock().ok()?;
        match guard.as_ref() {
            Some(server) => Some(server.sessions.try_lock().ok()?.len()),
            None => Some(0),
        }
    }

    async fn stats(&self, token: &str) -> Result<NativeHlsStats, String> {
        let guard = self.server.lock().await;
        let server = guard.as_ref().ok_or("Native HLS session not found")?;
        let sessions = server.sessions.lock().unwrap();
        let session = sessions.get(token).ok_or("Native HLS session not found")?;
        Ok(session.stats())
    }

    pub async fn stop_all(&self) {
        let mut guard = self.server.lock().await;
        if let Some(server) = guard.as_ref() {
            let mut sessions = server.sessions.lock().unwrap();
            for session in sessions.values() {
                session.cancel.send_replace(true);
            }
            // Keep-alive HTTP connections can retain a Router/map clone after
            // listener abort. Only actual in-flight replies should retain leases.
            sessions.clear();
        }
        *guard = None;
    }

    async fn stop(&self, token: &str) {
        let mut guard = self.server.lock().await;
        if let Some(server) = guard.as_ref() {
            let mut sessions = server.sessions.lock().unwrap();
            if let Some(session) = sessions.remove(token) {
                session.cancel.send_replace(true);
                session.resources.lock().unwrap().clear();
                session.samples.lock().unwrap().clear();
            }
            if !sessions.is_empty() {
                return;
            }
        }
        *guard = None;
    }
}

fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Native HLS is available only to the main window".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn native_hls_start(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NativeHlsState>,
    background: tauri::State<'_, ottplay_core::background_work::BackgroundWork>,
    url: String,
) -> Result<NativeHlsStart, String> {
    main_window(&window)?;
    let work = background.enter().map_err(str::to_string)?;
    state.start_tracked(url, Some(window), Some(work)).await
}

#[tauri::command]
pub async fn native_hls_stats(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NativeHlsState>,
    session: String,
) -> Result<NativeHlsStats, String> {
    main_window(&window)?;
    state.stats(&session).await
}

#[tauri::command]
pub async fn native_hls_stop(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NativeHlsState>,
    session: String,
) -> Result<(), String> {
    main_window(&window)?;
    state.stop(&session).await;
    Ok(())
}

fn validate_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.as_str().len() > MAX_URL
        || url.fragment().is_some()
    {
        return Err("Unsupported native HLS resource URL".into());
    }
    Ok(())
}

fn error(status: StatusCode, message: &'static str) -> Response {
    Response::builder()
        .status(status)
        .header("cache-control", "no-store")
        .body(Body::from(message))
        .unwrap()
}

fn local_origin(value: &str) -> bool {
    if value == "null" {
        return true;
    } // WK custom-protocol pages may have an opaque origin.
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https" | "tauri" | "asset")
        && matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "tauri.localhost" | "asset.localhost")
        )
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && (url.path().is_empty() || url.path() == "/")
}

async fn local_cors(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let origin = request.headers().get("origin").cloned();
    if origin
        .as_ref()
        .is_some_and(|v| !v.to_str().is_ok_and(local_origin))
    {
        return error(
            StatusCode::FORBIDDEN,
            "Only local playback origins are supported",
        );
    }
    let mut response = next.run(request).await;
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert("access-control-allow-origin", origin);
        response
            .headers_mut()
            .insert("vary", HeaderValue::from_static("Origin"));
        response.headers_mut().insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET, HEAD, OPTIONS"),
        );
        response.headers_mut().insert(
            "access-control-allow-headers",
            HeaderValue::from_static("Range, Accept, Content-Type"),
        );
        response.headers_mut().insert(
            "access-control-expose-headers",
            HeaderValue::from_static("Content-Length, Content-Range, Accept-Ranges"),
        );
    }
    response
}

async fn relay(
    State(sessions): State<Arc<Mutex<HashMap<String, Arc<Session>>>>>,
    Path((token, id)): Path<(String, String)>,
    method: Method,
    uri: axum::http::Uri,
    incoming: HeaderMap,
) -> Response {
    if method != Method::GET && method != Method::HEAD && method != Method::OPTIONS {
        return error(StatusCode::METHOD_NOT_ALLOWED, "GET and HEAD only");
    }
    let session = { sessions.lock().unwrap().get(&token).cloned() };
    let Some(session) = session else {
        return error(StatusCode::GONE, "Native HLS session stopped");
    };
    if *session.cancel.borrow() {
        return error(StatusCode::GONE, "Native HLS session stopped");
    }
    let resource = { session.resources.lock().unwrap().get(&id).cloned() };
    let Some(resource) = resource else {
        return error(StatusCode::NOT_FOUND, "Unknown native HLS resource");
    };
    if method == Method::OPTIONS {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(Body::empty())
            .unwrap();
    }
    *resource.seen.lock().unwrap() = Instant::now();
    let Ok(permit) = session.requests.clone().try_acquire_owned() else {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "Native HLS request limit exceeded",
        );
    };
    let mut url = resource.url.clone();
    if let Some(query) = uri.query() {
        if !matches!(resource.kind, Kind::Playlist { .. }) || query.len() > 256 {
            return error(StatusCode::BAD_REQUEST, "Unsupported native HLS query");
        }
        let extra: Vec<_> = url::form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect();
        if extra.len() > 3
            || extra.iter().any(|(k, v)| match k.as_str() {
                "_HLS_msn" | "_HLS_part" => v.parse::<u64>().is_err(),
                "_HLS_skip" => !matches!(v.as_str(), "YES" | "v2"),
                _ => true,
            })
        {
            return error(StatusCode::BAD_REQUEST, "Unsupported native HLS query");
        }
        let kept: Vec<_> = url
            .query_pairs()
            .filter(|(k, _)| !extra.iter().any(|(key, _)| key == k))
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        url.set_query(None);
        url.query_pairs_mut().extend_pairs(kept).extend_pairs(extra);
    }
    let response = match session.fetch(method.clone(), url, &incoming).await {
        Ok(response) => response,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "Native HLS upstream unavailable"),
    };
    let status = response.status();
    let headers = response.headers().clone();
    let final_url = response.url().clone();
    let mut outgoing = HeaderMap::new();
    for key in [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "cache-control",
        "etag",
        "last-modified",
        "content-encoding",
    ] {
        if let Some(value) = headers.get(key) {
            outgoing.insert(key, value.clone());
        }
    }
    if method == Method::HEAD {
        return (status, outgoing, Body::empty()).into_response();
    }
    if let Kind::Playlist { main } = resource.kind {
        if status.is_success() {
            if status != StatusCode::OK {
                return error(StatusCode::BAD_GATEWAY, "Unsupported partial HLS manifest");
            }
            let body = match read_manifest(&session, response).await {
                Ok(body) => body,
                Err(_) => return error(StatusCode::BAD_GATEWAY, "Invalid native HLS manifest"),
            };
            let prefix = format!("/hls/{token}/");
            let body = match rewrite_manifest(&session, &final_url, &id, main, &prefix, &body) {
                Ok(body) => body,
                Err(_) => return error(StatusCode::BAD_GATEWAY, "Unsupported native HLS manifest"),
            };
            outgoing.insert(
                "content-type",
                HeaderValue::from_static("application/vnd.apple.mpegurl"),
            );
            outgoing.remove("content-length");
            outgoing.remove("content-encoding");
            outgoing.remove("etag");
            outgoing.insert("cache-control", HeaderValue::from_static("no-store"));
            return (status, outgoing, body).into_response();
        }
    }
    if headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .is_some_and(|n| n > MAX_SEGMENT)
    {
        return error(StatusCode::BAD_GATEWAY, "Native HLS body limit exceeded");
    }
    let sample_seconds = sample_duration(&resource.kind, status, &headers, &incoming);
    let content_length = response.content_length();
    let cancel = session.cancel.subscribe();
    let body = stream::unfold(
        (response, cancel, 0u64, false, session, resource, permit),
        move |(mut response, mut cancel, mut bytes, done, session, resource, permit)| async move {
            if done || *cancel.borrow() {
                return None;
            }
            let next = tokio::select! {
                _ = cancel.changed() => return Some((Err(std::io::Error::other("Native HLS session stopped")), (response,cancel,bytes,true,session,resource,permit))),
                next = response.chunk() => next,
            };
            match next {
                Ok(Some(chunk)) => {
                    bytes += chunk.len() as u64;
                    if bytes > MAX_SEGMENT {
                        return Some((
                            Err(std::io::Error::other("Native HLS body limit exceeded")),
                            (response, cancel, bytes, true, session, resource, permit),
                        ));
                    }
                    // Hyper may finish a Content-Length body without polling it
                    // again. Confirm upstream EOF before yielding its final bytes.
                    let mut finished = false;
                    if content_length == Some(bytes) {
                        let tail = tokio::select! {
                            _ = cancel.changed() => return Some((Err(std::io::Error::other("Native HLS session stopped")), (response,cancel,bytes,true,session,resource,permit))),
                            tail = response.chunk() => tail,
                        };
                        if !matches!(tail, Ok(None)) {
                            return Some((
                                Err(std::io::Error::other("Invalid native HLS body length")),
                                (response, cancel, bytes, true, session, resource, permit),
                            ));
                        }
                        if let Some((seconds, expected)) = sample_seconds {
                            session.sample(&resource, bytes, seconds, expected);
                        }
                        finished = true;
                    }
                    Some((
                        Ok(chunk),
                        (response, cancel, bytes, finished, session, resource, permit),
                    ))
                }
                Ok(None) => {
                    if let Some((seconds, expected)) = sample_seconds {
                        session.sample(&resource, bytes, seconds, expected);
                    }
                    None
                }
                Err(_) => Some((
                    Err(std::io::Error::other("Native HLS upstream body failed")),
                    (response, cancel, bytes, true, session, resource, permit),
                )),
            }
        },
    );
    (status, outgoing, Body::from_stream(body)).into_response()
}

use axum::response::IntoResponse;

async fn read_manifest(
    session: &Session,
    mut response: reqwest::Response,
) -> Result<String, String> {
    let mut bytes = Vec::new();
    let mut cancel = session.cancel.subscribe();
    loop {
        if *cancel.borrow() {
            return Err("Session stopped".into());
        }
        let chunk = tokio::select! { _ = cancel.changed() => return Err("Session stopped".into()), chunk = response.chunk() => chunk.map_err(|_| "Manifest download failed")? };
        let Some(chunk) = chunk else {
            break;
        };
        if bytes.len() + chunk.len() > MAX_MANIFEST {
            return Err("Manifest limit exceeded".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Manifest is not UTF-8".into())
}

fn sample_duration(
    kind: &Kind,
    status: StatusCode,
    headers: &HeaderMap,
    incoming: &HeaderMap,
) -> Option<(f64, Option<u64>)> {
    if headers
        .get("content-encoding")
        .is_some_and(|v| v != "identity")
    {
        return None;
    }
    let Kind::Segment {
        main: true,
        seconds,
        range,
        ..
    } = kind
    else {
        return None;
    };
    match range {
        None if status == StatusCode::OK => Some((
            *seconds,
            headers
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok()),
        )),
        None if status == StatusCode::PARTIAL_CONTENT => {
            let content = headers
                .get("content-range")?
                .to_str()
                .ok()?
                .strip_prefix("bytes 0-")?;
            let (end, total) = content.split_once('/')?;
            let end = end.parse::<u64>().ok()?;
            let total = total.parse::<u64>().ok()?;
            if total > 0 && end.checked_add(1)? == total {
                Some((*seconds, Some(total)))
            } else {
                None
            }
        }
        Some((offset, length)) if status == StatusCode::PARTIAL_CONTENT => {
            let end = offset.checked_add(*length)?.checked_sub(1)?;
            let expected = format!("bytes={offset}-{end}");
            let content = format!("bytes {offset}-{end}/");
            if incoming.get("range")?.to_str().ok()? == expected
                && headers
                    .get("content-range")?
                    .to_str()
                    .ok()?
                    .starts_with(&content)
            {
                Some((*seconds, Some(*length)))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn attribute(line: &str, name: &str) -> Option<String> {
    attributes(line)
        .ok()?
        .into_iter()
        .find(|(key, _, _)| key == name)
        .map(|(_, a, b)| line[a..b].to_string())
}

/// Byte ranges of attribute values preserve the rest of the original manifest.
fn attributes(line: &str) -> Result<Vec<(String, usize, usize)>, String> {
    let Some(colon) = line.find(':') else {
        return Ok(Vec::new());
    };
    let bytes = line.as_bytes();
    let mut i = colon + 1;
    let mut result = Vec::new();
    while i < bytes.len() {
        while i < bytes.len() && matches!(bytes[i], b' ' | b',') {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i] != b'=' && bytes[i] != b',' {
            i += 1;
        }
        if i == bytes.len() || bytes[i] != b'=' {
            break;
        }
        let name = line[start..i].trim().to_string();
        i += 1;
        let quoted = i < bytes.len() && bytes[i] == b'"';
        if quoted {
            i += 1;
        }
        let value = i;
        while i < bytes.len()
            && if quoted {
                bytes[i] != b'"'
            } else {
                bytes[i] != b','
            }
        {
            i += 1;
        }
        if quoted && i == bytes.len() {
            return Err("Unclosed HLS attribute".into());
        }
        result.push((name, value, i));
        if quoted {
            i += 1;
            if i < bytes.len() && bytes[i] != b',' {
                return Err("Invalid HLS attribute".into());
            }
        }
    }
    Ok(result)
}

fn byte_range(value: &str, previous_end: Option<u64>) -> Result<(u64, u64), String> {
    let (length, offset) = value
        .split_once('@')
        .map_or((value, None), |(n, o)| (n, Some(o)));
    let length = length
        .parse::<u64>()
        .map_err(|_| "Invalid HLS byte range")?;
    let offset = match offset {
        Some(value) => value.parse::<u64>().map_err(|_| "Invalid HLS byte range")?,
        None => previous_end.ok_or("Missing HLS byte range offset")?,
    };
    if length == 0 || length > MAX_SEGMENT || offset.checked_add(length).is_none() {
        return Err("Invalid HLS byte range".into());
    }
    Ok((offset, length))
}

fn rewrite_manifest(
    session: &Session,
    base: &Url,
    playlist: &str,
    main: bool,
    prefix: &str,
    text: &str,
) -> Result<String, String> {
    let text = text.trim_start_matches('\u{feff}');
    if text.len() > MAX_MANIFEST || text.lines().next().map(str::trim) != Some("#EXTM3U") {
        return Err("Not an HLS manifest".into());
    }
    let mut result = String::new();
    let mut duration = None;
    let mut pending_range = None;
    let mut previous_range: Option<(Url, u64)> = None;
    let mut variant = None;
    let mut rewrites = 0;
    let mut sequence = 0u64;
    let mut skipped_segments = None;
    let mut discontinuity = 0u64;
    for original in text.lines() {
        let line = original.trim();
        if line.len() > 32768 {
            return Err("HLS line limit exceeded".into());
        }
        if line.starts_with("#EXT-X-DEFINE:") || line.starts_with("#EXT-X-CONTENT-STEERING:") {
            return Err("Unsupported HLS extension".into());
        }
        if let Some(value) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            sequence = value
                .parse::<u64>()
                .map_err(|_| "Invalid HLS sequence")?
                .checked_add(skipped_segments.unwrap_or(0))
                .ok_or("HLS sequence overflow")?;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-DISCONTINUITY-SEQUENCE:") {
            discontinuity = value.parse().map_err(|_| "Invalid HLS discontinuity")?;
        }
        if line.starts_with("#EXT-X-SKIP:") {
            if skipped_segments.is_some() {
                return Err("Repeated HLS skip tag".into());
            }
            let skipped = attribute(line, "SKIPPED-SEGMENTS")
                .ok_or("Missing HLS skip count")?
                .parse::<u64>()
                .map_err(|_| "Invalid HLS skip count")?;
            skipped_segments = Some(skipped);
            sequence = sequence
                .checked_add(skipped)
                .ok_or("HLS sequence overflow")?;
        }
        if line == "#EXT-X-DISCONTINUITY" {
            discontinuity = discontinuity
                .checked_add(1)
                .ok_or("HLS discontinuity overflow")?;
        }
        if line.starts_with("#EXTINF:") {
            let value = line[8..]
                .split(',')
                .next()
                .unwrap_or("")
                .parse::<f64>()
                .map_err(|_| "Invalid HLS media duration")?;
            if !value.is_finite() || value <= 0.0 || value > 3600.0 {
                return Err("Invalid HLS media duration".into());
            }
            duration = Some(value);
        } else if let Some(value) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            let range = byte_range(value, previous_range.as_ref().map(|(_, end)| *end))?;
            pending_range = Some((range, !value.contains('@')));
            result.push_str(&format!("#EXT-X-BYTERANGE:{}@{}\n", range.1, range.0));
            continue;
        } else if line.starts_with("#EXT-X-STREAM-INF:") {
            let codecs = attribute(line, "CODECS").unwrap_or_default().to_lowercase();
            let audio_only = !codecs.is_empty()
                && !["avc", "hev", "hvc", "vp0", "vp9", "av01", "dvh", "dvhe"]
                    .iter()
                    .any(|v| codecs.contains(v))
                && attribute(line, "RESOLUTION").is_none();
            variant = Some(main && !audio_only);
        }
        let rewritten = if !line.is_empty() && !line.starts_with('#') {
            let url = base.join(line).map_err(|_| "Invalid HLS resource")?;
            let kind = if let Some(main) = variant.take() {
                Kind::Playlist { main }
            } else if let Some(seconds) = duration.take() {
                let range = match pending_range.take() {
                    Some((range, implicit)) => {
                        if implicit && previous_range.as_ref().is_none_or(|(last, _)| last != &url)
                        {
                            return Err("Invalid implicit HLS byte range".into());
                        }
                        Some(range)
                    }
                    None => None,
                };
                previous_range = range.map(|(offset, length)| (url.clone(), offset + length));
                let key = format!("{playlist}/{discontinuity}/{sequence}/{range:?}");
                sequence = sequence.checked_add(1).ok_or("HLS sequence overflow")?;
                Kind::Segment {
                    main,
                    seconds,
                    range,
                    key,
                }
            } else {
                return Err("HLS resource has no media duration".into());
            };
            rewrites += 1;
            format!("{prefix}{}", session.register(url, kind)?)
        } else if line.starts_with("#EXT-X-") {
            let attrs = attributes(line)?;
            let mut rewritten = line.to_string();
            for (key, start, end) in attrs.into_iter().rev() {
                if key != "URI" && key != "SERVER-URI" {
                    continue;
                }
                let url = base
                    .join(&line[start..end])
                    .map_err(|_| "Invalid HLS attribute URL")?;
                let kind = if line.starts_with("#EXT-X-MEDIA:") {
                    Kind::Playlist {
                        main: main && attribute(line, "TYPE").as_deref() == Some("VIDEO"),
                    }
                } else if line.starts_with("#EXT-X-I-FRAME-STREAM-INF:")
                    || line.starts_with("#EXT-X-RENDITION-REPORT:")
                {
                    Kind::Playlist { main: false }
                } else {
                    Kind::Other
                };
                rewrites += 1;
                rewritten.replace_range(
                    start..end,
                    &format!("{prefix}{}", session.register(url, kind)?),
                );
            }
            rewritten
        } else {
            line.to_string()
        };
        if rewrites > MAX_RESOURCES || result.len() + rewritten.len() + 1 > MAX_MANIFEST * 2 {
            return Err("HLS rewrite limit exceeded".into());
        }
        result.push_str(&rewritten);
        result.push('\n');
    }
    if duration.is_some() || variant.is_some() || pending_range.is_some() {
        return Err("Incomplete HLS manifest".into());
    }
    Ok(result)
}

#[cfg(test)]
#[path = "native_hls_tests.rs"]
mod tests;

#[cfg(test)]
mod diagnostic_tests {
    use super::*;

    #[tokio::test]
    async fn runtime_diagnostic_count_never_starts_or_waits_for_a_relay() {
        let state = NativeHlsState::default();
        assert_eq!(state.diagnostic_session_count(), Some(0));
        let held = state.server.lock().await;
        assert!(held.is_none());
        assert_eq!(state.diagnostic_session_count(), None);
        drop(held);
        assert_eq!(state.diagnostic_session_count(), Some(0));
    }
}
