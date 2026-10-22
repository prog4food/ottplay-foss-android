//! Tauri IPC commands reusing ottplay-core.
//!
//! Commands exposed to JS via `invoke()`:
//! - `ping`         — health check
//! - `get_epg`      — per-channel EPG slice (wraps `ottplay_core::get_epg_slice`)
//! - `play_pip` / `stop_pip` / `set_pip_bounds` — native always-on-top PiP window
//!
//! In-process: calls ottplay-core directly. No HTTP server mounted (see §3.1 note).
//! A localhost axum router can be added later for devtools/debugging.

use std::collections::HashMap;
use std::sync::Arc;

use super::queue::SharedQueues;
use ottplay_core::native_xmltv::NativeSnapshot;
use serde::Serialize;
use serde_json::Value as JsonValue;
use tokio::sync::RwLock;

#[derive(Serialize)]
pub struct SleepResult {
    pub ok: bool,
    pub prevented: bool,
    pub message: String,
}

/// Shared shell state.
pub struct TauriState {
    pub background: ottplay_core::background_work::BackgroundWork,
    /// Cached XMLTV (startup warm + single-flight ensure; empty never stored).
    pub xmltv_cache: Arc<RwLock<Option<Arc<NativeSnapshot>>>>,
    /// EPG URLs: configured via EPG_URLS env var or default for desktop Mode B.
    /// Falls back to http://epg.it999.ru/epg2.xml.gz when unset, so get_epg
    /// is never stuck on empty URLs (Mode B Tauri only).
    pub epg_urls: Arc<RwLock<Vec<String>>>,
    /// epg_hash → xmltv_id map populated by match_channels.
    pub epg_to_xmltv: Arc<RwLock<HashMap<String, String>>>,
    /// epg_hash → time_shift_hours map populated by match_channels.
    pub time_shift_by_epg: Arc<RwLock<HashMap<String, i64>>>,
    /// Single-flight gate so cold XMLTV fetch (≈40MB gz / hundreds of MB XML)
    /// is not duplicated by concurrent get_epg / match_channels / startup warm.
    pub xmltv_fetch_lock: Arc<tokio::sync::Mutex<()>>,
    /// In-memory command queue for Mode B native webhook / polling API.
    pub command_queues: SharedQueues,
}

/// Health-check payload mirroring inverter-desktop's ping pattern.
#[derive(Serialize)]
pub struct PingResult {
    pub ok: bool,
    pub version: &'static str,
}

/// Tauri desktop media control commands.
#[derive(Serialize)]
pub struct FullscreenResult {
    pub ok: bool,
    /// Current fullscreen state after the command (Rust is source of truth).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fullscreen: Option<bool>,
}

/// `invoke('ping')` → liveness probe.
#[tauri::command]
pub async fn ping() -> Result<PingResult, String> {
    Ok(PingResult {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// Initialise EPG URLs from environment or default for desktop Mode B.
///
/// Reads `EPG_URLS` (semicolon-separated) at startup; falls back to the same
/// default as `src-rs/server/src/main.rs:epg_urls()` so `get_epg` is never stuck
/// on empty URLs. Called once by the builder before the window opens.
pub fn init_xmltv_urls() -> Vec<String> {
    const DEFAULT_EPG: &str = "http://epg.it999.ru/epg2.xml.gz";
    let urls: Vec<String> = std::env::var("EPG_URLS")
        .unwrap_or_default()
        .split(';')
        .filter_map(|s| {
            let s = s.trim();
            if s.is_empty() { None } else { Some(s.to_string()) }
        })
        .collect();
    if urls.is_empty() {
        vec![DEFAULT_EPG.to_string()]
    } else {
        urls
    }
}

/// Clone one coherent generation without keeping a cache lock during queries.
pub async fn xmltv_snapshot(state: &TauriState) -> Result<Arc<NativeSnapshot>, String> {
    state.xmltv_cache.read().await.clone().ok_or_else(|| "EPG cache empty".into())
}

/// Ensure XMLTV is loaded (Mode B). Single-flight; never caches a 0-channel result.
pub async fn ensure_xmltv_cache(state: &TauriState) -> Result<(usize, usize), String> {
    refresh_xmltv_cache(state, false).await
}

async fn refresh_xmltv_cache(state: &TauriState, force: bool) -> Result<(usize, usize), String> {
    let work = state.background.enter().map_err(str::to_string)?;
    work.run(async {
        if !force {
            if let Ok(snapshot) = xmltv_snapshot(state).await {
                return Ok(snapshot.counts());
            }
        }
        let _gate = state.xmltv_fetch_lock.lock().await;
        if !force {
            // Winner may have filled the cache while we waited for the lock.
            if let Ok(snapshot) = xmltv_snapshot(state).await {
                return Ok(snapshot.counts());
            }
        }
        let urls = state.epg_urls.read().await.clone();
        if urls.is_empty() {
            return Err("EPG cache empty and no XMLTV URLs configured".to_string());
        }
        tracing::info!("[EPG] Mode B fetching {} source(s)...", urls.len());
        let fresh = ottplay_core::fetch_xmltv_tracked(&urls, work.clone())
            .await
            .map_err(|e| e.to_string())?;
        if fresh.channels.is_empty() {
            tracing::warn!("[EPG] Fetch returned 0 channels — not caching (will retry)");
            return Err("EPG fetch returned 0 channels".to_string());
        }
        let parsing = work.clone();
        let snapshot = tokio::task::spawn_blocking(move || {
            parsing.check().map_err(anyhow::Error::msg)?;
            let result = NativeSnapshot::new(fresh);
            parsing.check().map_err(anyhow::Error::msg)?;
            result
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        let (n_ch, n_pr) = snapshot.counts();
        // Queries retain the previous data and index until the replacement is complete.
        let mut cache = state.xmltv_cache.write().await;
        work.publish(|| *cache = Some(Arc::new(snapshot)))
            .map_err(str::to_string)?;
        tracing::info!("[EPG] Loaded {n_ch} channels, {n_pr} programmes");
        Ok((n_ch, n_pr))
    })
    .await
    .map_err(str::to_string)?
}

/// Background warm + 2h refresh (Mode A companion parity). Emits `epg-cache-ready`
/// so JS can clear time_request misses and progressively refill list/podval/EPG menu.
pub fn spawn_xmltv_warm(app: tauri::AppHandle, state: &TauriState) {
    use tauri::Emitter;

    // Clone Arc handles so the warm task outlives setup().
    let warm_state = TauriState {
        background: state.background.clone(),
        xmltv_cache: state.xmltv_cache.clone(),
        epg_urls: state.epg_urls.clone(),
        epg_to_xmltv: state.epg_to_xmltv.clone(),
        time_shift_by_epg: state.time_shift_by_epg.clone(),
        xmltv_fetch_lock: state.xmltv_fetch_lock.clone(),
        command_queues: state.command_queues.clone(),
    };

    tauri::async_runtime::spawn(async move {
        match ensure_xmltv_cache(&warm_state).await {
            Ok((n_ch, n_pr)) => {
                let _ = app.emit(
                    "epg-cache-ready",
                    serde_json::json!({ "channels": n_ch, "programmes": n_pr }),
                );
            }
            Err(e) => tracing::warn!("[EPG] Startup warm failed: {e}"),
        }

        // Periodic refresh like src-rs/server (every 2h).
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(2 * 3600));
        ticker.tick().await; // skip immediate tick (just warmed)
        loop {
            ticker.tick().await;
            match refresh_xmltv_cache(&warm_state, true).await {
                Ok((n_ch, n_pr)) => {
                    tracing::info!("[EPG] Background refresh ok ({n_ch} ch, {n_pr} pr)");
                    let _ = app.emit(
                        "epg-cache-ready",
                        serde_json::json!({ "channels": n_ch, "programmes": n_pr }),
                    );
                }
                Err(e) => tracing::warn!("[EPG] Background refresh failed: {e}"),
            }
        }
    });
}

/// `invoke('get_epg', {hash, channelId, ch, timeShiftHours})` → JSON EPG slice (Tauri 2 camelCase).
///
/// Mirrors `src-rs/server/src/main.rs::epg_handler`:
/// 1. If `ch` (playlist channel name) provided, fuzzy-match → xmltv_id.
/// 2. Else if `hash` non-empty, lookup `epg_to_xmltv` map (fallback: use hash as xmltv_id).
/// 3. Else fall back to `channel_id` (numeric playlist chId — rarely matches XMLTV id).
#[tauri::command]
pub async fn get_epg(
    state: tauri::State<'_, TauriState>,
    hash: String,
    channel_id: String,
    ch: Option<String>,
    time_shift_hours: i64,
    // Configured catchup/history hours (channel.rec / M3U rechours). Not timezone.
    archive_hours: Option<i64>,
    tvg_id: Option<String>,
    tvg_name: Option<String>,
    xmltv_urls: Option<Vec<String>>,
) -> Result<JsonValue, String> {
    let work = state.background.enter().map_err(str::to_string)?;
    work.run(async {
        let sources = xmltv_urls.unwrap_or_default();
        let (snapshot, fallback_id, mapped_shift) = if sources.is_empty() {
            // Never keep map/cache guards across a fetch or a CPU-bound query.
            ensure_xmltv_cache(&state).await?;
            let (fallback, mapped_shift) = {
                let epg_map = state.epg_to_xmltv.read().await;
                let shift_map = state.time_shift_by_epg.read().await;
                let fallback = if hash.is_empty() {
                    channel_id
                } else {
                    epg_map.get(&hash).cloned().unwrap_or_else(|| hash.clone())
                };
                (fallback, shift_map.get(&hash).copied())
            };
            (xmltv_snapshot(&state).await?, Some(fallback), mapped_shift)
        } else {
            (
                ottplay_core::native_xmltv::load_sources_tracked(&sources, work.clone())
                    .await
                    .map_err(|e| e.to_string())?,
                None,
                None,
            )
        };
        let lookup = EpgLookup {
            hash,
            fallback_id,
            ch,
            time_shift_hours,
            archive_hours: archive_hours.unwrap_or(0),
            tvg_id: tvg_id.unwrap_or_default(),
            tvg_name: tvg_name.unwrap_or_default(),
            mapped_shift,
        };
        let querying = work.clone();
        tokio::task::spawn_blocking(move || {
            querying.check().map_err(anyhow::Error::msg)?;
            let result = lookup.run(&snapshot);
            querying.check().map_err(anyhow::Error::msg)?;
            result
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(str::to_string)?
}

struct EpgLookup {
    hash: String,
    // The legacy name/map fallback applies only to the default source set.
    fallback_id: Option<String>,
    ch: Option<String>,
    time_shift_hours: i64,
    archive_hours: i64,
    tvg_id: String,
    tvg_name: String,
    mapped_shift: Option<i64>,
}

impl EpgLookup {
    fn run(self, snapshot: &NativeSnapshot) -> anyhow::Result<JsonValue> {
        let shift = if self.time_shift_hours != 0 {
            self.time_shift_hours
        } else if let Some(shift) = self.mapped_shift {
            shift
        } else {
            snapshot
                .index()
                .extract_time_shift(self.ch.as_deref().unwrap_or(&self.tvg_name))?
        };
        let id = snapshot.resolve(
            &self.tvg_id,
            &self.tvg_name,
            self.ch.as_deref().unwrap_or(""),
        )?;
        let id = match (id, self.fallback_id) {
            (Some(id), _) => id,
            (None, Some(fallback)) => {
                // Keep the pre-existing default-source legacy matching policy on a native miss.
                match self.ch.as_deref() {
                    Some(name) => ottplay_core::match_channel(name, &snapshot.cache().channels)?
                        .map(|(id, _)| id).unwrap_or(fallback),
                    None => fallback,
                }
            }
            (None, None) => String::new(),
        };
        ottplay_core::get_epg_slice_with_index(
            snapshot.cache(),
            snapshot.index(),
            &self.hash,
            &id,
            shift,
            self.archive_hours,
        )
    }
}

#[cfg(test)]
mod epg_snapshot_tests {
    use super::*;
    use ottplay_core::xmltv::{Channel, Programme, XmltvCache};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn snapshot(id: &str, name: &str) -> Arc<NativeSnapshot> {
        let now = chrono::Utc::now().timestamp();
        Arc::new(
            NativeSnapshot::new(XmltvCache {
                channels: HashMap::from([(
                    id.into(),
                    Channel {
                        id: id.into(),
                        name: name.into(),
                        names: vec![name.into(), "Alias".into()],
                        ..Default::default()
                    },
                )]),
                programs: HashMap::from([(
                    id.into(),
                    vec![Programme {
                        start: now - 1800,
                        stop: now + 1800,
                        title: name.into(),
                        ..Default::default()
                    }],
                )]),
                ..Default::default()
            })
            .unwrap(),
        )
    }

    fn state(url: String, snapshot: Option<Arc<NativeSnapshot>>) -> Arc<TauriState> {
        Arc::new(TauriState {
            background: Default::default(),
            xmltv_cache: Arc::new(RwLock::new(snapshot)),
            epg_urls: Arc::new(RwLock::new(vec![url])),
            epg_to_xmltv: Arc::new(RwLock::new(HashMap::new())),
            time_shift_by_epg: Arc::new(RwLock::new(HashMap::new())),
            xmltv_fetch_lock: Arc::new(tokio::sync::Mutex::new(())),
            command_queues: Default::default(),
        })
    }

    #[tokio::test]
    async fn standby_revokes_default_epg_download_and_preserves_previous_cache() {
        use axum::{routing::get, Router};
        let calls = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let app = Router::new().route("/feed", get({
            let calls = calls.clone(); let entered = entered.clone(); let release = release.clone();
            move || { let calls = calls.clone(); let entered = entered.clone(); let release = release.clone(); async move {
                calls.fetch_add(1, Ordering::SeqCst);
                entered.notify_one();
                release.acquire().await.unwrap().forget();
                "<tv><channel id=\"new\"><display-name>New</display-name></channel></tv>"
            }}
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let old = snapshot("old", "Old");
        let state = state(format!("http://{}/feed", listener.local_addr().unwrap()), Some(old.clone()));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        state.background.set_standby(true);
        assert!(ensure_xmltv_cache(&state).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        state.background.set_standby(false);
        let download = { let state = state.clone(); tokio::spawn(async move { refresh_xmltv_cache(&state, true).await }) };
        entered.notified().await;
        state.background.set_standby(true);
        assert!(tokio::time::timeout(std::time::Duration::from_secs(2), download).await.unwrap().unwrap().is_err());
        assert!(state.background.status().quiescent);
        assert!(Arc::ptr_eq(&xmltv_snapshot(&state).await.unwrap(), &old));
        state.background.set_standby(false);
        release.add_permits(2);
        assert_eq!(refresh_xmltv_cache(&state, true).await.unwrap().0, 1);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(!Arc::ptr_eq(&xmltv_snapshot(&state).await.unwrap(), &old));
        server.abort();
    }

    #[tokio::test]
    async fn forced_refresh_is_atomic_and_cold_ensure_is_single_flight() {
        use axum::{http::StatusCode, routing::get, Router};
        let requests = Arc::new(AtomicUsize::new(0));
        let mode = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(tokio::sync::Notify::new());
        let finish = Arc::new(tokio::sync::Notify::new());
        let app = Router::new().route("/feed", get({
            let requests = requests.clone(); let mode = mode.clone();
            let started = started.clone(); let finish = finish.clone();
            move || {
                let requests = requests.clone(); let mode = mode.clone();
                let started = started.clone(); let finish = finish.clone();
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    if mode.load(Ordering::SeqCst) == 0 { return (StatusCode::BAD_GATEWAY, "offline"); }
                    started.notify_one(); finish.notified().await;
                    (StatusCode::OK, "<tv><channel id=\"fresh\"><display-name>Fresh</display-name></channel></tv>")
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/feed", listener.local_addr().unwrap());
        struct Server(tokio::task::JoinHandle<()>);
        impl Drop for Server { fn drop(&mut self) { self.0.abort(); } }
        let _server = Server(tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); }));
        let old = snapshot("old", "Old");
        let state = state(url.clone(), Some(old.clone()));
        assert!(refresh_xmltv_cache(&state, true).await.is_err());
        assert!(Arc::ptr_eq(&old, &xmltv_snapshot(&state).await.unwrap()));
        mode.store(1, Ordering::SeqCst);
        let refreshing = { let state = state.clone(); tokio::spawn(async move { refresh_xmltv_cache(&state, true).await }) };
        started.notified().await;
        assert_eq!(tokio::time::timeout(std::time::Duration::from_millis(250), ensure_xmltv_cache(&state)).await.unwrap().unwrap(), (1, 1));
        assert!(Arc::ptr_eq(&old, &xmltv_snapshot(&state).await.unwrap()));
        finish.notify_one(); refreshing.await.unwrap().unwrap();
        let fresh = xmltv_snapshot(&state).await.unwrap();
        assert!(!Arc::ptr_eq(&old, &fresh));
        assert_eq!(fresh.resolve("fresh", "", "").unwrap().as_deref(), Some("fresh"));
        assert_eq!(old.resolve("", "Alias", "").unwrap().as_deref(), Some("old"));
        assert_eq!(old.cache().programs["old"][0].title, "Old");
        // Two cold callers share the same completed data/index generation.
        *state.xmltv_cache.write().await = None;
        let before = requests.load(Ordering::SeqCst);
        let first = { let state = state.clone(); tokio::spawn(async move { ensure_xmltv_cache(&state).await }) };
        started.notified().await;
        let second = { let state = state.clone(); tokio::spawn(async move { ensure_xmltv_cache(&state).await }) };
        finish.notify_one();
        assert_eq!(first.await.unwrap().unwrap(), (1, 0));
        assert_eq!(second.await.unwrap().unwrap(), (1, 0));
        assert_eq!(requests.load(Ordering::SeqCst), before + 1);
    }

    #[test]
    fn lookup_preserves_default_map_fallback_and_shift_precedence() {
        let snapshot = snapshot("xmltv", "News");
        let query = |explicit, mapped, fallback: Option<&str>, id: &str| {
            EpgLookup {
                hash: "playlist-hash".into(),
                fallback_id: fallback.map(str::to_string),
                ch: None,
                time_shift_hours: explicit,
                archive_hours: 96,
                tvg_id: id.into(),
                tvg_name: String::new(),
                mapped_shift: mapped,
            }
            .run(&snapshot)
            .unwrap()
        };
        let start = snapshot.cache().programs["xmltv"][0].start;
        assert_eq!(query(2, Some(5), Some("xmltv"), "")["epg_data"][0]["time"], start + 2 * 3600);
        assert_eq!(query(0, Some(5), Some("xmltv"), "")["epg_data"][0]["time"], start + 5 * 3600);
        assert_eq!(query(0, None, None, "xmltv")["epg_data"][0]["name"], "News");
        assert_eq!(query(0, None, None, "missing")["epg_data"], serde_json::json!([]));
    }
}

/// Tracks macOS simple-fullscreen intent + pre-FS outer geometry.
///
/// `Window::is_fullscreen()` is false while in `set_simple_fullscreen`, so
/// toggle/exit must consult this flag. Never use a system-wide letter shortcut.
///
/// Frameless (`decorations: false`) windows can look "stuck" fullscreen when
/// tao's simple-FS exit no-ops or restores a screen-sized frame: we therefore
/// save outer position/size ourselves and force-restore on exit.
#[cfg(target_os = "macos")]
static MACOS_SIMPLE_FS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug)]
struct SavedOuter {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

#[cfg(target_os = "macos")]
static MACOS_SAVED_OUTER: std::sync::Mutex<Option<SavedOuter>> =
    std::sync::Mutex::new(None);

/// Drain the wry/tao main-thread queue after a fire-and-forget setter.
///
/// `set_simple_fullscreen` only enqueues from async command threads; a
/// following getter round-trip waits until prior messages (including that
/// setter) have been applied.
fn sync_window_queue(window: &tauri::Window) {
    let _ = window.is_fullscreen();
}

/// True when the window is in Spaces fullscreen or our macOS simple fullscreen.
fn is_effectively_fullscreen(window: &tauri::Window) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        if MACOS_SIMPLE_FS.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(true);
        }
    }
    window.is_fullscreen().map_err(|e| e.to_string())
}

/// Apply fullscreen without registering any global letter shortcut.
///
/// On macOS prefer `set_simple_fullscreen` so the webview still receives L and
/// Escape (Spaces/native fullscreen eats those keys). Exit always clears both
/// Spaces and simple FS, then restores the pre-enter outer frame so L/Escape
/// cannot leave the window stuck at monitor size. Other platforms keep
/// `set_fullscreen`.
/// Called from async IPC commands: macOS focus restoration waits for the main
/// dispatch queue, so this must not run on the main thread.
pub fn apply_fullscreen(
    _app: &tauri::AppHandle,
    window: &tauri::Window,
    fullscreen: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::sync::atomic::Ordering;
        if fullscreen {
            if is_effectively_fullscreen(window)? {
                // Already FS — do not overwrite saved outer geometry.
                return Ok(());
            }
            let native = window.is_fullscreen().unwrap_or(false);
            if native {
                // Already Spaces FS — leave as-is; JS cannot get keys there.
                MACOS_SIMPLE_FS.store(false, Ordering::SeqCst);
                return Ok(());
            }
            // Remember windowed outer frame before simple FS expands to screen.
            if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
                if let Ok(mut guard) = MACOS_SAVED_OUTER.lock() {
                    *guard = Some(SavedOuter {
                        x: pos.x,
                        y: pos.y,
                        w: size.width,
                        h: size.height,
                    });
                }
            }
            window
                .set_simple_fullscreen(true)
                .map_err(|e| e.to_string())?;
            sync_window_queue(window);
            MACOS_SIMPLE_FS.store(true, Ordering::SeqCst);
        } else {
            // Force-leave Spaces FS and simple FS regardless of which is active.
            let _ = window.set_fullscreen(false);
            let _ = window.set_simple_fullscreen(false);
            sync_window_queue(window);
            MACOS_SIMPLE_FS.store(false, Ordering::SeqCst);
            // Explicit geometry restore — tao exit can no-op or restore a
            // screen-sized frame on frameless windows, which looks like
            // "L enters but never exits".
            let saved = MACOS_SAVED_OUTER
                .lock()
                .ok()
                .and_then(|mut g| g.take());
            if let Some(s) = saved {
                if s.w > 0 && s.h > 0 {
                    let _ = window.set_size(tauri::PhysicalSize::new(s.w, s.h));
                    let _ = window.set_position(tauri::PhysicalPosition::new(s.x, s.y));
                    sync_window_queue(window);
                }
            }
        }
        // Tao's fullscreen style changes make its container NSView the first
        // responder, taking keyboard input away from WKWebView. Focus the
        // webview, not just the window (WebviewWindow::set_focus only focuses
        // the native window). Exit restores the style on the GCD main queue;
        // the Tao getter barrier above does not drain that queue. Run the final
        // focus there too, after the style update, and wait before acknowledging
        // the command so another fullscreen key can be delivered immediately.
        use tauri::Manager;
        if let Some(webview_window) = _app.get_webview_window(window.label()) {
            dispatch2::DispatchQueue::main().exec_sync(move || {
                let webview: &tauri::Webview = webview_window.as_ref();
                if let Err(error) = webview.set_focus() {
                    tracing::warn!(%error, "could not restore fullscreen webview focus");
                }
            });
        }
        // macOS Tahoe draws a 1px gray rim while the window shadow is enabled,
        // even in simple fullscreen. Apply this after the deferred style update
        // and restore the main window's normal shadow when returning windowed.
        window.set_shadow(!fullscreen).map_err(|e| e.to_string())?;
        sync_window_queue(window);
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        window
            .set_fullscreen(fullscreen)
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// `invoke('set_fullscreen', {fullscreen})` → set window fullscreen.
#[tauri::command]
pub async fn set_fullscreen(
    app: tauri::AppHandle,
    window: tauri::Window,
    fullscreen: bool,
) -> Result<FullscreenResult, String> {
    apply_fullscreen(&app, &window, fullscreen)?;
    let actual = is_effectively_fullscreen(&window).unwrap_or(fullscreen);
    Ok(FullscreenResult {
        ok: true,
        fullscreen: Some(actual),
    })
}

/// `invoke('toggle_fullscreen')` → flip effective fullscreen (simple FS on macOS).
/// Single Rust source of truth — no JS cache / API naming guesswork.
#[tauri::command]
pub async fn toggle_fullscreen(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<FullscreenResult, String> {
    let cur = is_effectively_fullscreen(&window)?;
    let next = !cur;
    apply_fullscreen(&app, &window, next)?;
    // Report live effective state (flag + is_fullscreen), not the intent bit.
    let actual = is_effectively_fullscreen(&window).unwrap_or(next);
    Ok(FullscreenResult {
        ok: true,
        fullscreen: Some(actual),
    })
}

/// `invoke('prevent_sleep', {})` → best-effort display sleep prevention.
///
/// Platform notes (mirror server.py::prevent_sleep patterns):
/// - macOS: `caffeinate -i -s` (spawns native sleep-prevention assertion process)
/// - Linux: `systemd-inhibit` (spawns process that blocks idle/sleep via D-Bus)
/// - Windows: `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` via FFI
/// Falls back gracefully when native APIs are unavailable.
#[tauri::command]
pub async fn prevent_sleep() -> Result<SleepResult, String> {
    let prevented = prevent_sleep_native();
    Ok(SleepResult {
        ok: true,
        prevented,
        message: if prevented {
            "Sleep prevention attempted (best-effort)".to_string()
        } else {
            "Sleep prevention not available on this platform".to_string()
        },
    })
}

/// Spawned process handle for platforms that use a keepalive process (macOS/Linux).
#[cfg(any(target_os = "macos", target_os = "linux"))]
static SLEEP_PROC: std::sync::OnceLock<std::sync::Mutex<Option<u32>>> =
    std::sync::OnceLock::new();

/// Platform-specific sleep prevention.
#[cfg(target_os = "macos")]
fn prevent_sleep_native() -> bool {
    // macOS: `caffeinate -i -s` prevents idle sleep + system sleep for as long
    // as the child process runs. We spawn it and store the PID so allow_sleep
    // can terminate it.
    let child = match std::process::Command::new("caffeinate")
        .args(["-i", "-s"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let pid = child.id();
    std::mem::forget(child); // keep process alive; killed in allow_sleep_native
    let mut guard = SLEEP_PROC.get_or_init(Default::default).lock().unwrap();
    *guard = Some(pid);
    true
}

#[cfg(target_os = "linux")]
fn prevent_sleep_native() -> bool {
    // Linux: `systemd-inhibit` blocks idle + sleep via D-Bus for the lifetime
    // of the child process. We spawn and store the PID so allow_sleep can kill it.
    let child = match std::process::Command::new("systemd-inhibit")
        .args([
            "--what=idle",
            "--what=sleep",
            "--mode=block",
            "--",
            "sleep",
            "infinity",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let pid = child.id();
    std::mem::forget(child);
    let mut guard = SLEEP_PROC.get_or_init(Default::default).lock().unwrap();
    *guard = Some(pid);
    true
}

/// Windows: `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`.
/// Stateless — the assertion persists until the calling process exits or a
/// subsequent call with ES_CONTINUOUS only.
#[cfg(target_os = "windows")]
fn prevent_sleep_native() -> bool {
    const ES_CONTINUOUS: u32 = 0x80000000;
    const ES_SYSTEM_REQUIRED: u32 = 0x00000001;

    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }

    let prev = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
    prev != 0 // non-zero return = succeeded
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn prevent_sleep_native() -> bool {
    false
}

/// `invoke('allow_sleep', {})` → release sleep prevention.
#[tauri::command]
pub async fn allow_sleep() -> Result<SleepResult, String> {
    allow_sleep_native();
    Ok(SleepResult {
        ok: true,
        prevented: false,
        message: "Sleep prevention released".to_string(),
    })
}

/// Platform-specific sleep allowance (release assertion).
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn allow_sleep_native() {
    // Terminate the spawned keepalive process so the machine can sleep again.
    let guard = SLEEP_PROC.get_or_init(Default::default).lock().unwrap();
    if let Some(pid) = *guard {
        // kill the process — ignore result (may have already exited)
        let _ = std::process::Command::new("kill")
            .arg(pid.to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

#[cfg(target_os = "windows")]
fn allow_sleep_native() {
    const ES_CONTINUOUS: u32 = 0x80000000;
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }
    unsafe {
        SetThreadExecutionState(ES_CONTINUOUS);
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn allow_sleep_native() {}
/// Result payload for native PiP commands.
#[derive(Serialize)]
pub struct PipResult {
    pub ok: bool,
}

const PIP_LABEL: &str = "pip";
const PIP_CANVAS_W: f64 = 1280.0;
const PIP_CANVAS_H: f64 = 720.0;
const PIP_MARGIN: f64 = 20.0;

/// Map size index to logical inner size (matches core pipPresets).
fn pip_size(size: i32) -> (f64, f64) {
    match size.clamp(0, 2) {
        0 => (256.0, 144.0),
        1 => (384.0, 216.0),
        _ => (512.0, 288.0),
    }
}

/// Corner positions: 0 TR, 1 BR, 2 BL, 3 TL against a logical canvas.
fn pip_logical_xy(position: i32, w: f64, h: f64, canvas_w: f64, canvas_h: f64) -> (f64, f64) {
    let pos = ((position % 4) + 4) % 4;
    match pos {
        0 => (canvas_w - w - PIP_MARGIN, PIP_MARGIN),
        1 => (canvas_w - w - PIP_MARGIN, canvas_h - h - PIP_MARGIN),
        2 => (PIP_MARGIN, canvas_h - h - PIP_MARGIN),
        _ => (PIP_MARGIN, PIP_MARGIN),
    }
}

/// Per-app PiP lifecycle. Only window setup/teardown holds `commands`; buffering
/// never blocks a newer play or stop command.
#[derive(Default)]
pub struct PipState {
    commands: tokio::sync::Mutex<()>,
    inner: std::sync::Mutex<PipInner>,
}

#[derive(Default)]
struct PipInner {
    next_session: u64,
    next_instance: u64,
    last_request_id: u64,
    instance: Option<u64>,
    ready: bool,
    current: Option<PipRequest>,
    active_work: Option<ottplay_core::background_work::WorkLease>,
    stopping: HashMap<u64, ottplay_core::background_work::WorkLease>,
    pending: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
}

/// Only app-owned status labels cross into the isolated PiP document.
#[derive(Clone, serde::Deserialize, Serialize)]
#[serde(default)]
pub struct PipLabels {
    loading: String,
    playback: String,
    startup: String,
    runtime: String,
}

impl Default for PipLabels {
    fn default() -> Self {
        Self {
            loading: "Loading…".into(),
            playback: "Stream could not be played".into(),
            startup: "Player could not start".into(),
            runtime: "Compatibility runtime could not load. Reopen the player to retry.".into(),
        }
    }
}

impl PipLabels {
    fn bounded(mut self) -> Self {
        let fallback = Self::default();
        for (value, default) in [
            (&mut self.loading, fallback.loading),
            (&mut self.playback, fallback.playback),
            (&mut self.startup, fallback.startup),
            (&mut self.runtime, fallback.runtime),
        ] {
            if value.trim().is_empty() || value.encode_utf16().count() > 512 {
                *value = default;
            }
        }
        self
    }
}

#[derive(Clone, Serialize)]
pub struct PipRequest {
    instance: u64,
    session: u64,
    url: String,
    engine: Option<i32>,
    r#loop: bool,
    labels: PipLabels,
}

impl PipInner {
    fn cancel(&mut self, reason: &str) {
        if let Some(pending) = self.pending.take() {
            let _ = pending.send(Err(reason.to_string()));
        }
        self.current = None;
    }

    fn accept(&mut self, request_id: Option<u64>) -> bool {
        if let Some(id) = request_id {
            if id <= self.last_request_id {
                return false;
            }
            self.last_request_id = id;
        }
        true
    }

    fn acknowledge(
        &mut self,
        instance: u64,
        session: u64,
        event: &str,
    ) -> Result<Option<PipRequest>, String> {
        if self.instance != Some(instance) {
            return Ok(None);
        }
        if event == "stopped" {
            self.stopping.remove(&session);
            return Ok(None);
        }
        if event == "stop_error" { return Err("PiP teardown could not be confirmed".into()); }
        if event == "ready" {
            self.ready = true;
            return Ok(self.current.clone());
        }
        if self.current.as_ref().map(|request| request.session) != Some(session) {
            return Ok(None);
        }
        match event {
            "playing" => {
                if let Some(pending) = self.pending.take() {
                    let _ = pending.send(Ok(()));
                }
            }
            "error" => {
                if let Some(pending) = self.pending.take() {
                    let _ = pending.send(Err("PiP stream could not be played".to_string()));
                }
            }
            _ => return Err("Unknown PiP acknowledgement".to_string()),
        }
        Ok(None)
    }
}

fn pip_player_script(request: &PipRequest) -> Result<String, String> {
    let request_json = serde_json::to_string(request).map_err(|e| e.to_string())?;
    Ok(format!(
        "window.__ottplayPip && window.__ottplayPip.play({request_json});"
    ))
}

fn pip_stop_script(session: u64) -> String {
    format!("window.__ottplayPip && window.__ottplayPip.stop({session});")
}

/// The dedicated App-origin document is the only caller allowed to acknowledge
/// readiness/playback. Old documents cannot acknowledge a replacement window.
#[tauri::command]
pub async fn pip_player_event(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    instance: u64,
    session: u64,
    event: String,
) -> Result<Option<PipRequest>, String> {
    use tauri::Manager;

    if window.label() != PIP_LABEL {
        return Err("PiP acknowledgement requires the PiP window".to_string());
    }
    let state = app.state::<PipState>();
    let mut inner = state.inner.lock().map_err(|_| "PiP state unavailable")?;
    inner.acknowledge(instance, session, &event)
}

#[cfg(test)]
mod pip_lifecycle_tests {
    use super::*;

    fn request(session: u64) -> PipRequest {
        PipRequest {
            instance: 1,
            session,
            url: "https://fixture.invalid/channel.m3u8".into(),
            engine: Some(1),
            r#loop: false,
            labels: PipLabels::default(),
        }
    }

    #[test]
    fn standby_pip_requires_matching_stop_acknowledgement() {
        let background = ottplay_core::background_work::BackgroundWork::default();
        let mut inner = PipInner { instance: Some(1), ..Default::default() };
        inner.stopping.insert(7, background.enter().unwrap());
        background.set_standby(true);
        inner.acknowledge(99, 7, "stopped").unwrap();
        inner.acknowledge(1, 6, "stopped").unwrap();
        assert!(!background.status().quiescent);
        assert!(inner.acknowledge(1, 7, "stop_error").is_err());
        assert!(!background.status().quiescent);
        inner.acknowledge(1, 7, "stopped").unwrap();
        assert!(background.status().quiescent);
    }

    #[test]
    fn localized_labels_are_bounded_and_survive_bootstrap_encoding() {
        let labels: PipLabels = serde_json::from_value(serde_json::json!({
            "loading": "Загрузка…",
            "playback": "Не удалось воспроизвести поток",
            "startup": "",
            "runtime": "x".repeat(513),
            "unexpected": "ignored",
        }))
        .unwrap();
        let labels = labels.bounded();
        assert_eq!(labels.loading, "Загрузка…");
        assert_eq!(labels.startup, PipLabels::default().startup);
        assert_eq!(labels.runtime, PipLabels::default().runtime);
        let encoded = serde_json::to_string(&labels).unwrap();
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("labels", &encoded)
            .finish();
        assert_eq!(
            url::form_urlencoded::parse(query.as_bytes())
                .next()
                .unwrap()
                .1,
            encoded
        );
        assert!(!encoded.contains("unexpected"));
    }

    #[test]
    fn stale_ipc_does_not_replace_a_newer_play_or_stop() {
        let mut inner = PipInner::default();
        assert!(inner.accept(Some(100)));
        assert!(!inner.accept(Some(100)));
        assert!(!inner.accept(Some(99)));
        assert!(inner.accept(Some(101)));
        assert!(inner.accept(None)); // Existing callers without request IDs remain compatible.
        assert!(!inner.accept(Some(100)));
    }

    #[test]
    fn ready_returns_latest_request_and_rejects_a_destroyed_document() {
        let mut inner = PipInner {
            instance: Some(1),
            current: Some(request(2)),
            ..Default::default()
        };
        assert!(inner.acknowledge(99, 0, "ready").unwrap().is_none());
        assert!(!inner.ready);
        assert_eq!(
            inner.acknowledge(1, 0, "ready").unwrap().unwrap().session,
            2
        );
        assert!(inner.ready);
        inner.cancel("stopped");
        assert!(inner.acknowledge(1, 0, "ready").unwrap().is_none());
    }

    #[test]
    fn cancel_wakes_pending_play_and_old_decoder_events_cannot_ack_new_play() {
        let (sender, mut old_reply) = tokio::sync::oneshot::channel();
        let mut inner = PipInner {
            instance: Some(1),
            current: Some(request(1)),
            pending: Some(sender),
            ..Default::default()
        };
        inner.cancel("superseded");
        assert_eq!(old_reply.try_recv().unwrap(), Err("superseded".into()));
        let (sender, mut new_reply) = tokio::sync::oneshot::channel();
        inner.current = Some(request(2));
        inner.pending = Some(sender);
        inner.acknowledge(1, 1, "playing").unwrap();
        inner.acknowledge(1, 1, "error").unwrap();
        assert!(matches!(
            new_reply.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        inner.acknowledge(1, 2, "playing").unwrap();
        assert_eq!(new_reply.try_recv().unwrap(), Ok(()));
    }

    #[test]
    fn decoder_failure_rejects_instead_of_acknowledging_a_blank_player() {
        let (sender, mut reply) = tokio::sync::oneshot::channel();
        let mut inner = PipInner {
            instance: Some(1),
            current: Some(request(1)),
            pending: Some(sender),
            ..Default::default()
        };
        inner.acknowledge(1, 1, "error").unwrap();
        assert_eq!(
            reply.try_recv().unwrap(),
            Err("PiP stream could not be played".into())
        );
    }
}

fn apply_pip_bounds(win: &tauri::WebviewWindow, position: i32, size: i32) -> Result<(), String> {
    let (w, h) = pip_size(size);

    // Prefer primary monitor logical size; fall back to 1280x720 MVP canvas.
    let (origin_x, origin_y, canvas_w, canvas_h) = match win.primary_monitor() {
        Ok(Some(mon)) => {
            let scale = mon.scale_factor();
            let mon_size = mon.size();
            let pos = mon.position();
            (
                pos.x as f64 / scale,
                pos.y as f64 / scale,
                mon_size.width as f64 / scale,
                mon_size.height as f64 / scale,
            )
        }
        _ => (0.0, 0.0, PIP_CANVAS_W, PIP_CANVAS_H),
    };

    let (x, y) = pip_logical_xy(position, w, h, canvas_w, canvas_h);
    win.set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    win.set_position(tauri::LogicalPosition::new(origin_x + x, origin_y + y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Open the local player document and acknowledge actual video playback, rather
/// than merely successful native-window creation. New calls cancel old waiters.
#[tauri::command]
pub async fn play_pip(
    app: tauri::AppHandle,
    url: String,
    engine: Option<i32>,
    request_id: Option<u64>,
    r#loop: Option<bool>,
    labels: Option<PipLabels>,
) -> Result<PipResult, String> {
    use tauri::Manager;
    let work = app.state::<ottplay_core::background_work::BackgroundWork>().enter().map_err(str::to_string)?;

    let validation = url::Url::parse(&url)
        .map_err(|_| "PiP requires an absolute stream URL")
        .and_then(|parsed| {
            if matches!(parsed.scheme(), "http" | "https") {
                Ok(())
            } else {
                Err("Unsupported PiP stream URL scheme")
            }
        });
    if let Err(error) = validation {
        // A rejected replacement must release the previous native decoder too.
        stop_pip(app, request_id).await?;
        return Err(error.to_string());
    }
    let state = app.state::<PipState>();
    let setup_guard = state.commands.lock().await;
    work.check().map_err(str::to_string)?;
    let existing_window = app.get_webview_window(PIP_LABEL);
    let is_new_window = existing_window.is_none();
    let (request, receiver, ready) = {
        let mut inner = state.inner.lock().map_err(|_| "PiP state unavailable")?;
        if !inner.accept(request_id) {
            return Ok(PipResult { ok: false });
        }
        inner.cancel("PiP request superseded");
        inner.next_session += 1;
        if existing_window.is_none() || inner.instance.is_none() {
            inner.next_instance += 1;
            inner.instance = Some(inner.next_instance);
            inner.ready = false;
        }
        let request = PipRequest {
            instance: inner.instance.expect("PiP instance initialized"),
            session: inner.next_session,
            url,
            engine,
            r#loop: r#loop.unwrap_or(false),
            labels: labels.unwrap_or_default().bounded(),
        };
        let (sender, receiver) = tokio::sync::oneshot::channel();
        inner.pending = Some(sender);
        inner.current = Some(request.clone());
        inner.active_work = Some(work.clone());
        (request, receiver, inner.ready)
    };

    let window_result = if let Some(win) = existing_window {
        Ok(win)
    } else {
        let (w, h) = pip_size(2);
        let labels_json = serde_json::to_string(&request.labels).map_err(|e| e.to_string())?;
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("labels", &labels_json)
            .finish();
        let mut builder = tauri::WebviewWindowBuilder::new(
            &app,
            PIP_LABEL,
            tauri::WebviewUrl::App(format!("pip.html?{query}#{}", request.instance).into()),
        )
        .title("OttPlay PiP")
        .inner_size(w, h)
        .decorations(false)
        .resizable(true)
        .visible(true)
        .always_on_top(true)
        .skip_taskbar(true);
        if let Some(data_dir) = crate::instance::resolve_data_dir() {
            builder = crate::instance::apply_isolation(builder, &data_dir);
        }
        builder.build()
    };

    let setup_result = window_result.map_err(|e| e.to_string()).and_then(|win| {
        if is_new_window {
            let event_app = app.clone();
            let instance = request.instance;
            win.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    let state = event_app.state::<PipState>();
                    if let Ok(mut inner) = state.inner.lock() {
                        if inner.instance == Some(instance) {
                            inner.cancel("PiP window closed");
                            inner.instance = None;
                            inner.ready = false;
                            inner.active_work = None;
                            inner.stopping.clear();
                        }
                    };
                }
            });
        }
        win.show().map_err(|e| e.to_string())?;
        win.unminimize().map_err(|e| e.to_string())?;
        // New windows receive their current request through the ready handshake.
        // Reused documents are initialized exactly once; no Finished/immediate eval race.
        if ready {
            win.eval(&pip_player_script(&request)?)
                .map_err(|e| e.to_string())?;
        } else {
            apply_pip_bounds(&win, 0, 2)?;
        }
        Ok(())
    });
    if let Err(error) = setup_result {
        let mut inner = state.inner.lock().map_err(|_| "PiP state unavailable")?;
        inner.cancel("PiP window could not start");
        if let Some(win) = app.get_webview_window(PIP_LABEL) {
            let _ = win.eval(&pip_stop_script(request.session));
            let _ = win.hide();
        } else {
            inner.instance = None;
            inner.ready = false;
        }
        return Err(error);
    }
    drop(setup_guard);

    let result = match tokio::time::timeout(std::time::Duration::from_secs(20), receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("PiP request cancelled".to_string()),
        Err(_) => Err("PiP playback did not start in time".to_string()),
    };
    if let Err(error) = result {
        let _guard = state.commands.lock().await;
        let mut inner = state.inner.lock().map_err(|_| "PiP state unavailable")?;
        if inner.current.as_ref().map(|active| active.session) == Some(request.session) {
            inner.cancel("PiP playback stopped");
            if let Some(win) = app.get_webview_window(PIP_LABEL) {
                let _ = win.eval(&pip_stop_script(request.session));
                let _ = win.hide();
            }
        }
        return Err(error);
    }
    Ok(PipResult { ok: true })
}

/// Release all media and hide the reusable document. Keeping the initialized
/// window avoids asynchronous close/reopen races on the fixed native label.
#[tauri::command]
pub async fn stop_pip(app: tauri::AppHandle, request_id: Option<u64>) -> Result<PipResult, String> {
    use tauri::Manager;

    let state = app.state::<PipState>();
    let _guard = state.commands.lock().await;
    let session = {
        let mut inner = state.inner.lock().map_err(|_| "PiP state unavailable")?;
        if !inner.accept(request_id) {
            return Ok(PipResult { ok: false });
        }
        if inner.active_work.is_none() && !inner.stopping.is_empty() {
            return Ok(PipResult { ok: true });
        }
        inner.cancel("PiP playback stopped");
        inner.next_session += 1;
        let session = inner.next_session;
        if let Some(work) = inner.active_work.take() {
            inner.stopping.insert(session, work);
        }
        session
    };
    if let Some(win) = app.get_webview_window(PIP_LABEL) {
        let stopped = win.eval(&pip_stop_script(session));
        let hidden = win.hide();
        // A failed eval must not leave a stopped player's empty window visible.
        stopped.map_err(|e| e.to_string())?;
        hidden.map_err(|e| e.to_string())?;
    } else {
        let mut inner = state.inner.lock().map_err(|_| "PiP state unavailable")?;
        inner.active_work = None;
        inner.stopping.clear();
    }
    Ok(PipResult { ok: true })
}

/// invoke set_pip_bounds {position, size} -> corner + preset size for the PiP window.
#[tauri::command]
pub async fn set_pip_bounds(
    app: tauri::AppHandle,
    position: i32,
    size: i32,
) -> Result<PipResult, String> {
    use tauri::Manager;

    if let Some(win) = app.get_webview_window(PIP_LABEL) {
        apply_pip_bounds(&win, position, size)?;
    }
    Ok(PipResult { ok: true })
}

/// `invoke('exit_app')` → close main window and exit the process.
///
/// Browser `window.close()` does not quit a Tauri app; Escape → confirm → Enter
/// calls `stbExit()`, which must invoke this under `__TAURI__`.
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.close();
    }
    app.exit(0);
}

/// `invoke('proxy_fetch', { url })` — GET a remote URL (playlist / companion
/// `cp.php` stand-in) without CORS. Leading `@` is stripped (provider form).
/// Used only for text-sized bodies (M3U playlists), not media streams.
#[tauri::command]
pub async fn proxy_fetch(
    background: tauri::State<'_, ottplay_core::background_work::BackgroundWork>,
    url: String,
) -> Result<String, String> {
    let work = background.enter().map_err(str::to_string)?;
    work.run(async {
        let params = ottplay_core::m3u::ProxyParams {
            url,
            ua: String::new(),
        };
        let (_headers, body) = ottplay_core::m3u::proxy_stream(params).await?;
        Ok(String::from_utf8_lossy(&body).into_owned())
    })
    .await
    .map_err(str::to_string)?
}
