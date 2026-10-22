//! Opt-in, bounded diagnostic storage. Public player routes have no access to it.
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Query, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use ottplay_core::runtime_diagnostics::{Metric, Platform, RuntimeDiagnostics};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

const DEBUG_ARCHIVE_MAX: u64 = 100 * 1024 * 1024;
const DEBUG_RETENTION: Duration = Duration::from_secs(7 * 24 * 3600);
const DEBUG_BODY_MAX: usize = 256 * 1024;

struct DebugState {
    started: Instant,
    log: PathBuf,
    archive: PathBuf,
    marker: PathBuf,
    enabled: bool,
    token: Option<String>,
    writes: Mutex<()>,
}

impl DebugState {
    fn enabled(&self) -> bool {
        self.enabled || self.marker.is_file()
    }
}

pub fn routes() -> Router {
    let cwd = std::env::current_dir().expect("server working directory");
    routes_for(Arc::new(DebugState {
        started: Instant::now(),
        log: cwd.join("debug-playback.log"),
        archive: debug_archive_dir(),
        marker: cwd.join("debug.enabled"),
        enabled: std::env::var("OTTPLAY_DEBUG").ok().as_deref() == Some("1"),
        token: std::env::var("OTTPLAY_DEBUG_TOKEN")
            .ok()
            .filter(|s| s.len() >= 32 && s.bytes().all(|b| (33..=126).contains(&b))),
        writes: Mutex::new(()),
    }))
}

fn routes_for(state: Arc<DebugState>) -> Router {
    Router::new()
        .route("/debug/config", get(debug_config))
        .route("/debug/runtime", get(debug_runtime))
        .route("/debug/ingest", post(debug_ingest))
        .route("/debug/tail", get(debug_tail))
        .route("/debug/status", get(debug_status))
        .route("/debug/summary", get(debug_summary))
        .route("/debug/archive-status", get(debug_archive_status))
        .route_layer(middleware::from_fn_with_state(state.clone(), authorize))
        .layer(DefaultBodyLimit::max(DEBUG_BODY_MAX))
        .with_state(state)
}

fn same_secret(actual: &[u8], expected: &[u8]) -> bool {
    actual.len() == expected.len()
        && actual
            .iter()
            .zip(expected)
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

fn permitted(state: &DebugState, headers: &HeaderMap) -> bool {
    // A reverse proxy can look exactly like a loopback client. Neither its
    // connection address nor Host/Origin/forwarded headers replace authentication.
    let Some(token) = &state.token else {
        return false;
    };
    headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .is_some_and(|actual| same_secret(actual.as_bytes(), token.as_bytes()))
}

async fn authorize(State(state): State<Arc<DebugState>>, request: Request, next: Next) -> Response {
    let runtime = request.uri().path() == "/debug/runtime";
    // A value-only runtime read does not start or require diagnostic log capture.
    let enabled = runtime || state.enabled();
    let allowed = permitted(&state, request.headers());
    if !enabled || !allowed {
        if request.uri().path() == "/debug/config" {
            return Json(serde_json::json!({"enabled":false})).into_response();
        }
        let mut response = StatusCode::FORBIDDEN.into_response();
        if runtime {
            response
                .headers_mut()
                .insert("cache-control", "no-store".parse().unwrap());
        }
        return response;
    }
    let mut response = next.run(request).await;
    if runtime {
        response
            .headers_mut()
            .insert("cache-control", "no-store".parse().unwrap());
    }
    response
}

async fn debug_runtime(
    State(state): State<Arc<DebugState>>,
) -> Result<Json<RuntimeDiagnostics>, StatusCode> {
    let started = state.started;
    let mut result = tokio::task::spawn_blocking(move || {
        RuntimeDiagnostics::collect(Platform::Server, env!("CARGO_PKG_VERSION"), started)
    })
    .await
    .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    // O(1) cached counts only. Never trigger a refresh or wait for a writer.
    if let Ok(cache) = crate::EPG_CACHE.try_read() {
        result.metric(Metric::EpgChannels, cache.cache.channels.len() as u64);
        result.metric(Metric::EpgProgrammes, cache.programme_count as u64);
    }
    if let Ok(mapping) = crate::EPG_TO_XMLTV.try_read() {
        result.metric(Metric::EpgMappings, mapping.len() as u64);
    }
    if let Ok(shifts) = crate::TIME_SHIFT_BY_EPG.try_read() {
        result.metric(Metric::EpgShifts, shifts.len() as u64);
    }
    Ok(Json(result))
}

fn redact_text(text: &str) -> String {
    static URLS: Lazy<Regex> =
        Lazy::new(|| Regex::new(r#"(?i)(?:https?|rtsp|rtmp)://[^\s"'<>\\]+"#).unwrap());
    static FIELDS: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r#"(?i)\b(?:username|user|password|passwd|pwd|token|access_token|refresh_token|secret|authorization|api[_-]?key)(?:=|%3d|:)\s*[^\s&"'<>]+"#).unwrap()
    });
    static AUTH: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)\b(?:Bearer|Basic)\s+[a-z0-9_~+./=-]+").unwrap());
    let urls = URLS.replace_all(text, |caps: &regex::Captures<'_>| {
        reqwest::Url::parse(&caps[0])
            .ok()
            .filter(|u| matches!(u.scheme(), "http" | "https"))
            .map(|u| format!("{}/[redacted]", u.origin().ascii_serialization()))
            .unwrap_or_else(|| "[redacted URL]".into())
    });
    AUTH.replace_all(&FIELDS.replace_all(&urls, "[redacted]"), "[redacted]")
        .into_owned()
}

fn redact_json(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => *text = redact_text(text),
        serde_json::Value::Array(values) => values.iter_mut().for_each(redact_json),
        serde_json::Value::Object(values) => {
            for (key, value) in values {
                let lower = key.to_ascii_lowercase().replace(['-', '_'], "");
                if [
                    "user",
                    "pwd",
                    "cookie",
                    "setcookie",
                    "key",
                    "auth",
                    "credential",
                    "credentials",
                    "signature",
                    "sig",
                ]
                .contains(&lower.as_str())
                    || [
                        "password",
                        "passwd",
                        "secret",
                        "token",
                        "authorization",
                        "username",
                        "apikey",
                    ]
                    .iter()
                    .any(|s| lower.contains(s))
                {
                    *value = serde_json::Value::String("[redacted]".into());
                } else {
                    redact_json(value);
                }
            }
        }
        _ => {}
    }
}

fn redact_lines(content: &str) -> String {
    content
        .lines()
        .map(|line| {
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(line) {
                redact_json(&mut value);
                value.to_string()
            } else {
                redact_text(line)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// Only files owned by this feature are pruned. Symlinks and unrelated files stay untouched.
fn prune_archive(
    dir: &Path,
    incoming: u64,
    maximum: u64,
    retention: Duration,
) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let now = SystemTime::now();
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("debug-playback-")
            || !(name.ends_with(".jsonl") || name.ends_with(".log"))
        {
            continue;
        }
        let meta = entry.path().symlink_metadata()?;
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified()?;
        if now.duration_since(modified).unwrap_or_default() > retention {
            std::fs::remove_file(entry.path())?;
        } else {
            files.push((modified, entry.path(), meta.len()));
        }
    }
    files.sort_by_key(|f| f.0);
    let mut total: u64 = files.iter().map(|f| f.2).sum();
    for (_, path, length) in files {
        if total.saturating_add(incoming) <= maximum {
            break;
        }
        std::fs::remove_file(path)?;
        total = total.saturating_sub(length);
    }
    Ok(())
}

fn append_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if path.symlink_metadata().is_ok_and(|m| !m.is_file()) {
        return Err(std::io::Error::other(
            "Diagnostic log must be a regular file",
        ));
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

const DEBUG_LOG_MAX: u64 = 20 * 1024 * 1024;
const DEBUG_SUMMARY_SCAN_MAX: u64 = 2 * 1024 * 1024;

/// Permanent archive under the source repo, outside the installed local stack.
/// Prefer OTTPLAY_DEBUG_ARCHIVE, then an existing .local-artifacts/debug-archive
/// in the working directory, then $HOME/victron/ottplay-foss/.local-artifacts/debug-archive.
/// The local service installer sets the source archive explicitly so rsync cannot remove it.
fn debug_archive_dir() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("OTTPLAY_DEBUG_ARCHIVE") {
        let t = p.trim();
        if !t.is_empty() {
            return std::path::PathBuf::from(t);
        }
    }
    let rel = std::path::PathBuf::from(".local-artifacts/debug-archive");
    if rel.is_dir() {
        return rel;
    }
    if let Ok(home) = std::env::var("HOME") {
        return std::path::PathBuf::from(home)
            .join("victron/ottplay-foss/.local-artifacts/debug-archive");
    }
    rel
}

#[derive(Deserialize)]
struct DebugIngestBody {
    session: Option<String>,
    events: Option<Vec<serde_json::Value>>,
    port: Option<serde_json::Value>,
    origin: Option<String>,
    #[serde(rename = "playerId")]
    player_id: Option<String>,
    ua: Option<String>,
}

async fn debug_config() -> impl IntoResponse {
    Json(serde_json::json!({"enabled":true}))
}

async fn debug_ingest(State(state): State<Arc<DebugState>>, body: Bytes) -> StatusCode {
    let Ok(batch) = serde_json::from_slice::<DebugIngestBody>(&body) else {
        return StatusCode::BAD_REQUEST;
    };
    let events = batch.events.unwrap_or_default();
    if events.is_empty() || events.len() > 500 {
        return StatusCode::BAD_REQUEST;
    }
    let received = Utc::now().to_rfc3339();
    let mut bytes = Vec::new();
    for event in events {
        let mut line =
            serde_json::json!({"session":batch.session, "event":event, "recvAt":received});
        for (key, value) in [
            ("port", batch.port.clone()),
            (
                "origin",
                batch.origin.clone().map(serde_json::Value::String),
            ),
            (
                "playerId",
                batch.player_id.clone().map(serde_json::Value::String),
            ),
            ("ua", batch.ua.clone().map(serde_json::Value::String)),
        ] {
            if let Some(value) = line
                .get("event")
                .and_then(|e| e.get(key))
                .cloned()
                .or(value)
            {
                line[key] = value;
            }
        }
        redact_json(&mut line);
        bytes.extend_from_slice(line.to_string().as_bytes());
        bytes.push(b'\n');
    }
    // Batch tags may be repeated per event; bound the serialized result as well.
    if bytes.len() > DEBUG_BODY_MAX {
        return StatusCode::PAYLOAD_TOO_LARGE;
    }
    match tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let _guard = state
            .writes
            .lock()
            .map_err(|_| std::io::Error::other("Debug storage lock poisoned"))?;
        if state
            .log
            .metadata()
            .is_ok_and(|m| m.len().saturating_add(bytes.len() as u64) > DEBUG_LOG_MAX)
        {
            std::fs::rename(&state.log, state.log.with_extension("log.1"))?;
        }
        prune_archive(
            &state.archive,
            bytes.len() as u64,
            DEBUG_ARCHIVE_MAX,
            DEBUG_RETENTION,
        )?;
        let archive = state.archive.join(format!(
            "debug-playback-{}.jsonl",
            Utc::now().format("%Y%m%d")
        ));
        append_file(&state.log, &bytes)?;
        append_file(&archive, &bytes)
    })
    .await
    {
        Ok(Ok(())) => StatusCode::OK,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[derive(Deserialize)]
struct DebugTailQuery {
    n: Option<usize>,
}

/// GET /debug/tail?n=100 — last n lines of debug-playback.log as text/plain.
async fn debug_tail(
    State(state): State<Arc<DebugState>>,
    Query(q): Query<DebugTailQuery>,
) -> impl IntoResponse {
    let n = q.n.unwrap_or(100).min(5000);
    let path = &state.log;
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = content.lines().collect();
    let start = if lines.len() > n { lines.len() - n } else { 0 };
    let out = redact_lines(&lines[start..].join("\n"));
    (
        StatusCode::OK,
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        out,
    )
}

/// GET /debug/status — {ok, size, mtime, lines_approx}.
async fn debug_status(State(state): State<Arc<DebugState>>) -> impl IntoResponse {
    let path = &state.log;
    match std::fs::metadata(path) {
        Ok(meta) => {
            let size = meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let lines_approx = std::fs::read_to_string(path)
                .map(|s| s.lines().count())
                .unwrap_or(0);
            (
                StatusCode::OK,
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                serde_json::json!({
                    "ok": true,
                    "size": size,
                    "mtime": mtime,
                    "lines_approx": lines_approx,
                })
                .to_string(),
            )
        }
        Err(_) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            serde_json::json!({
                "ok": true,
                "size": 0,
                "mtime": 0,
                "lines_approx": 0,
            })
            .to_string(),
        ),
    }
}

/// GET /debug/summary — scan last ~2MB of debug-playback.log → per-port counts.
async fn debug_summary(State(state): State<Arc<DebugState>>) -> impl IntoResponse {
    let path = &state.log;
    let file_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let content = match std::fs::read(path) {
        Ok(bytes) => {
            let start = if bytes.len() as u64 > DEBUG_SUMMARY_SCAN_MAX {
                bytes.len() - DEBUG_SUMMARY_SCAN_MAX as usize
            } else {
                0
            };
            // Align to next newline if we truncated mid-line.
            let slice = if start > 0 {
                match bytes[start..].iter().position(|&b| b == b'\n') {
                    Some(i) => &bytes[start + i + 1..],
                    None => &bytes[start..],
                }
            } else {
                &bytes[..]
            };
            String::from_utf8_lossy(slice).into_owned()
        }
        Err(_) => String::new(),
    };

    #[derive(Default)]
    struct PortStats {
        events: u64,
        stalls: u64,
        errors: u64,
        sessions: std::collections::HashSet<String>,
    }

    let mut by_port: HashMap<String, PortStats> = HashMap::new();
    let mut total_lines: u64 = 0;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        total_lines += 1;
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                // Opaque / legacy tab lines — bucket under "unknown"
                let e = by_port.entry("unknown".to_string()).or_default();
                e.events += 1;
                if line.to_ascii_lowercase().contains("stall") {
                    e.stalls += 1;
                }
                if line.to_ascii_lowercase().contains("error") {
                    e.errors += 1;
                }
                continue;
            }
        };

        let port = v
            .get("port")
            .and_then(|p| match p {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .or_else(|| {
                v.get("event")
                    .and_then(|e| e.get("port"))
                    .and_then(|p| match p {
                        serde_json::Value::String(s) => Some(s.clone()),
                        serde_json::Value::Number(n) => Some(n.to_string()),
                        _ => None,
                    })
            })
            .unwrap_or_else(|| "unknown".to_string());

        let session = v
            .get("session")
            .and_then(|s| s.as_str())
            .or_else(|| {
                v.get("event")
                    .and_then(|e| e.get("session"))
                    .and_then(|s| s.as_str())
            })
            .unwrap_or("-")
            .to_string();

        let cat = v
            .get("event")
            .and_then(|e| e.get("cat"))
            .and_then(|c| c.as_str())
            .unwrap_or("");
        let msg = v
            .get("event")
            .and_then(|e| e.get("msg"))
            .and_then(|m| m.as_str())
            .unwrap_or("");
        let e = by_port.entry(port).or_default();
        e.events += 1;
        e.sessions.insert(session);
        let msg_lc = msg.to_ascii_lowercase();
        if cat == "stall" || msg_lc.contains("stall") {
            e.stalls += 1;
        }
        // Explicit error events (video error / hls ERROR*) — not every line mentioning the word.
        if msg == "error"
            || msg_lc.starts_with("error")
            || msg.contains("ERROR")
            || (cat == "video" && msg_lc == "error")
        {
            e.errors += 1;
        }
    }

    let mut by_port_json = serde_json::Map::new();
    for (port, stats) in by_port {
        by_port_json.insert(
            port,
            serde_json::json!({
                "events": stats.events,
                "stalls": stats.stalls,
                "errors": stats.errors,
                "sessions": stats.sessions.len() as u64,
            }),
        );
    }

    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        serde_json::json!({
            "byPort": by_port_json,
            "totalLines": total_lines,
            "fileBytes": file_bytes,
        })
        .to_string(),
    )
}

/// GET /debug/archive-status — list permanent archive dir files + sizes.
async fn debug_archive_status(State(state): State<Arc<DebugState>>) -> impl IntoResponse {
    let dir = &state.archive;
    let mut files: Vec<serde_json::Value> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            let meta = ent.metadata().ok();
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            files.push(serde_json::json!({
                "name": name,
                "size": size,
                "mtime": mtime,
            }));
        }
    }
    files.sort_by(|a, b| {
        let an = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let bn = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
        an.cmp(bn)
    });
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        serde_json::json!({
            "ok": true,
            "dir": dir.to_string_lossy(),
            "files": files,
        })
        .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::extract::ConnectInfo;
    use axum::http::Request;
    use std::fs::{File, FileTimes};
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::Service;

    struct Fixture {
        directory: PathBuf,
        state: Arc<DebugState>,
    }

    impl Fixture {
        fn new(enabled: bool) -> Self {
            static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);
            let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
            let suffix = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = std::env::temp_dir().join(format!(
                "ott-debug-{}-{suffix}-{sequence}",
                std::process::id()
            ));
            std::fs::create_dir(&directory).unwrap();
            Self {
                state: Arc::new(DebugState {
                    started: Instant::now(),
                    log: directory.join("debug.log"),
                    archive: directory.join("archive"),
                    marker: directory.join("debug.enabled"),
                    enabled,
                    token: Some("test-token-0123456789abcdefghijklmno".into()),
                    writes: Mutex::new(()),
                }),
                directory,
            }
        }

        async fn request(
            &self,
            path: &str,
            body: Option<&str>,
            peer: &str,
            origin: Option<&str>,
            token: Option<&str>,
        ) -> Response {
            let mut builder = Request::builder()
                .method(if body.is_some() { "POST" } else { "GET" })
                .uri(path)
                .header("host", "127.0.0.1:8080");
            if let Some(origin) = origin {
                builder = builder.header("origin", origin);
            }
            if let Some(token) = token {
                builder = builder.header("authorization", format!("Bearer {token}"));
            }
            let mut request = builder
                .body(body.map_or_else(Body::empty, |s| Body::from(s.to_owned())))
                .unwrap();
            request
                .extensions_mut()
                .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
            routes_for(self.state.clone()).call(request).await.unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.directory).unwrap();
        }
    }

    #[tokio::test]
    async fn runtime_snapshot_requires_bearer_but_does_not_enable_log_capture() {
        let fixture = Fixture::new(false);
        for token in [None, Some("wrong"), fixture.state.token.as_deref()] {
            let response = fixture.request("/debug/runtime", None, "127.0.0.1:42", Some("http://localhost:8080"), token).await;
            assert_eq!(response.headers()["cache-control"], "no-store");
            if token != fixture.state.token.as_deref() {
                assert_eq!(response.status(), StatusCode::FORBIDDEN);
                continue;
            }
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value.as_object().unwrap().len(), 6);
            assert_eq!(value["version"], 1);
            assert_eq!(value["platform"], "server");
            assert_eq!(value["appVersion"], env!("CARGO_PKG_VERSION"));
            assert!(value["webviewVersion"].is_null());
            for (key, metric) in value["metrics"].as_object().unwrap() {
                assert!(["uptimeMs", "residentBytes", "systemAvailableBytes", "systemTotalBytes", "logicalProcessors", "epgChannels", "epgProgrammes", "epgMappings", "epgShifts"].contains(&key.as_str()), "{key}");
                assert!(metric.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991));
            }
        }
        assert!(!fixture.state.log.exists());
        assert!(!fixture.state.archive.exists());
        assert!(!fixture.state.marker.exists());
        let response = fixture.request("/debug/config", None, "127.0.0.1:42", None, fixture.state.token.as_deref()).await;
        assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap().as_ref(), br#"{"enabled":false}"#);
        let response = fixture.request("/debug/tail", None, "127.0.0.1:42", None, fixture.state.token.as_deref()).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn disabled_debug_rejects_reads_and_writes_even_with_token() {
        let fixture = Fixture::new(false);
        for path in [
            "/debug/tail",
            "/debug/status",
            "/debug/summary",
            "/debug/archive-status",
        ] {
            let response = fixture
                .request(
                    path,
                    None,
                    "127.0.0.1:42",
                    None,
                    fixture.state.token.as_deref(),
                )
                .await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
        }
        let response = fixture
            .request(
                "/debug/ingest",
                Some(r#"{"events":[{"msg":"test"}]}"#),
                "127.0.0.1:42",
                None,
                fixture.state.token.as_deref(),
            )
            .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(!fixture.state.log.exists());
        assert!(!fixture.state.archive.exists());
        let response = fixture
            .request("/debug/config", None, "127.0.0.1:42", None, None)
            .await;
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
            br#"{"enabled":false}"#
        );
    }

    #[tokio::test]
    async fn diagnostics_require_bearer_even_for_loopback_and_reverse_proxies() {
        let fixture = Fixture::new(true);
        for (peer, origin, token, expected) in [
            ("192.168.1.20:42", None, None, StatusCode::FORBIDDEN),
            (
                "192.168.1.20:42",
                None,
                Some("wrong"),
                StatusCode::FORBIDDEN,
            ),
            (
                "127.0.0.1:42",
                Some("https://attacker.invalid"),
                None,
                StatusCode::FORBIDDEN,
            ),
            ("127.0.0.1:42", Some("null"), None, StatusCode::FORBIDDEN),
            (
                "127.0.0.1:42",
                Some("http://127.0.0.1:9999"),
                None,
                StatusCode::FORBIDDEN,
            ),
            (
                "127.0.0.1:42",
                Some("http://127.0.0.1:8080"),
                None,
                StatusCode::FORBIDDEN,
            ),
            ("[::1]:42", None, None, StatusCode::FORBIDDEN),
            (
                "192.168.1.20:42",
                None,
                fixture.state.token.as_deref(),
                StatusCode::OK,
            ),
        ] {
            assert_eq!(
                fixture
                    .request("/debug/tail", None, peer, origin, token)
                    .await
                    .status(),
                expected
            );
        }
        let mut headers = HeaderMap::new();
        headers.insert("host", "attacker.invalid".parse().unwrap());
        headers.insert("x-forwarded-for", "127.0.0.1".parse().unwrap());
        assert!(!permitted(&fixture.state, &headers));
        headers.insert("host", "localhost:8080".parse().unwrap());
        assert!(!permitted(&fixture.state, &headers));
        headers.insert("sec-fetch-site", "cross-site".parse().unwrap());
        assert!(!permitted(&fixture.state, &headers));
    }

    #[tokio::test]
    async fn authorized_ingest_redacts_storage_and_tail_and_rejects_bad_batches() {
        let fixture = Fixture::new(true);
        let body = r#"{"session":"session-1","port":"8080","events":[{"cat":"net","msg":"error","data":{"url":"https://name:DUMMY_SECRET@provider.invalid/live/user/DUMMY_SECRET/1?token=DUMMY_SECRET","nested":{"access_token":"DUMMY_SECRET","pwd":"DUMMY_SECRET","user":"DUMMY_SECRET","api-key":"DUMMY_SECRET","Cookie":"sid=DUMMY_SECRET","Set-Cookie":"sid=DUMMY_SECRET"},"error":"Bearer DUMMY_SECRET password=DUMMY_SECRET"}}]}"#;
        assert_eq!(
            fixture
                .request(
                    "/debug/ingest",
                    Some(body),
                    "127.0.0.1:42",
                    None,
                    fixture.state.token.as_deref()
                )
                .await
                .status(),
            StatusCode::OK
        );
        let log = std::fs::read_to_string(&fixture.state.log).unwrap();
        assert!(!log.contains("DUMMY_SECRET"));
        assert!(log.contains("provider.invalid/[redacted]"));
        let archive = std::fs::read_dir(&fixture.state.archive)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(std::fs::read_to_string(archive).unwrap(), log);
        let summary = fixture
            .request(
                "/debug/summary",
                None,
                "127.0.0.1:42",
                None,
                fixture.state.token.as_deref(),
            )
            .await;
        let summary: serde_json::Value =
            serde_json::from_slice(&to_bytes(summary.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(summary["byPort"]["8080"]["errors"], 1);
        // Existing pre-upgrade log content is sanitized on read, too.
        append_file(&fixture.state.log, b"{\"password\":\"DUMMY_SECRET\"}\nold https://provider.invalid/live/user/DUMMY_SECRET\n").unwrap();
        let response = fixture
            .request(
                "/debug/tail",
                None,
                "127.0.0.1:42",
                None,
                fixture.state.token.as_deref(),
            )
            .await;
        assert!(
            !String::from_utf8(to_bytes(response.into_body(), 4096).await.unwrap().to_vec())
                .unwrap()
                .contains("DUMMY_SECRET")
        );
        for body in ["not-json token=DUMMY_SECRET", r#"{"events":[]}"#] {
            assert_eq!(
                fixture
                    .request(
                        "/debug/ingest",
                        Some(body),
                        "127.0.0.1:42",
                        None,
                        fixture.state.token.as_deref()
                    )
                    .await
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
        let large = "x".repeat(DEBUG_BODY_MAX + 1);
        assert_eq!(
            fixture
                .request(
                    "/debug/ingest",
                    Some(&large),
                    "127.0.0.1:42",
                    None,
                    fixture.state.token.as_deref()
                )
                .await
                .status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }

    #[test]
    fn archive_retention_and_byte_budget_preserve_unrelated_files() {
        let fixture = Fixture::new(true);
        std::fs::create_dir(&fixture.state.archive).unwrap();
        let old = fixture.state.archive.join("debug-playback-old.jsonl");
        std::fs::write(&old, b"old").unwrap();
        File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_times(FileTimes::new().set_modified(SystemTime::UNIX_EPOCH))
            .unwrap();
        let unrelated = fixture.state.archive.join("operator.txt");
        std::fs::write(&unrelated, b"untouched").unwrap();
        for index in 0..3 {
            std::fs::write(
                fixture
                    .state
                    .archive
                    .join(format!("debug-playback-{index}.jsonl")),
                b"12345",
            )
            .unwrap();
        }
        prune_archive(&fixture.state.archive, 4, 10, DEBUG_RETENTION).unwrap();
        assert!(!old.exists());
        assert_eq!(std::fs::read_to_string(unrelated).unwrap(), "untouched");
        let bytes: u64 = std::fs::read_dir(&fixture.state.archive)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("debug-playback-")
            })
            .map(|e| e.metadata().unwrap().len())
            .sum();
        assert!(bytes + 4 <= 10);
    }
}
