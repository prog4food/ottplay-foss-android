//! OS media controls for Tauri Mode B (souvlaki → MPRIS / macOS Now Playing / Windows SMTC).
//!
//! Transport events eval into the main webview (`<video>` play/pause + `_doKey` next/prev),
//! mirroring Cap MobileNativeMedia lock-screen wiring. Artwork via `cover_url` when the
//! souvlaki backend supports it. Seek only when JS marks `seekable` (VOD/archive with
//! known duration); live IPTV leaves seek as a no-op without claiming success.

use serde::Serialize;
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const JS_PLAY: &str = "if(typeof window.stbResume==='function')window.stbResume();else if(window.stbContinue&&window.stbIsPlaying&&!window.stbIsPlaying())window.stbContinue(); true;";
const JS_PAUSE: &str = "if(window.stbPause)window.stbPause(); true;";
const JS_STOP: &str = "if(window.stbStop)window.stbStop(); true;";
const JS_NEXT: &str = "(function(){if(window._doKey&&window.keys)window._doKey(window.keys.NEXT);})();";
const JS_PREV: &str = "(function(){if(window._doKey&&window.keys)window._doKey(window.keys.PREV);})();";

pub struct MediaSessionState {
    inner: Mutex<Option<MediaSessionInner>>,
    artwork: tokio::sync::Mutex<Option<(String, String)>>,
    generation: AtomicU64,
}

struct MediaSessionInner {
    controls: MediaControls,
    metadata: MetadataCache,
    seekable: bool,
    /// Last known duration for relative seek clamps (seconds).
    duration_secs: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
struct MetadataSnapshot {
    title: String,
    artist: String,
    cover_url: Option<String>,
    duration: Option<Duration>,
}

#[derive(Default)]
struct MetadataCache(Option<MetadataSnapshot>);

impl MetadataCache {
    fn publish(
        &mut self,
        snapshot: MetadataSnapshot,
        publish: impl FnOnce(MediaMetadata<'_>) -> Result<(), String>,
    ) -> Result<(), String> {
        if self.0.as_ref() == Some(&snapshot) {
            return Ok(());
        }
        // Position ticks must not clear Now Playing artwork and reload its URL.
        publish(MediaMetadata {
            title: Some(&snapshot.title),
            artist: Some(&snapshot.artist),
            album: Some("OTT-play FOSS"),
            cover_url: snapshot.cover_url.as_deref(),
            duration: snapshot.duration,
        })?;
        self.0 = Some(snapshot);
        Ok(())
    }
}

impl Default for MediaSessionState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
            artwork: tokio::sync::Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct MediaSessionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported: Option<bool>,
}

fn ok() -> MediaSessionResult {
    MediaSessionResult {
        ok: true,
        error: None,
        unsupported: None,
    }
}

fn err(msg: impl Into<String>) -> MediaSessionResult {
    MediaSessionResult {
        ok: false,
        error: Some(msg.into()),
        unsupported: None,
    }
}

fn eval_main(app: &AppHandle, js: &str) {
    if let Some(win) = app.get_webview_window("main") {
        if let Err(e) = win.eval(js) {
            tracing::warn!("media_session eval failed: {e}");
        }
    } else {
        tracing::warn!("media_session: main webview missing");
    }
}

fn js_seek_abs(secs: f64) -> String {
    format!(
        "(function(){{var t={secs}; if(!(isFinite(t)&&t>=0))return; \
         if(window.stbSetPosTime){{window.stbSetPosTime(t);}} \
         else {{var v=document.querySelector('video'); if(v&&isFinite(v.duration)){{v.currentTime=t;}}}}}})();"
    )
}

fn js_seek_rel(delta_secs: f64) -> String {
    format!(
        "(function(){{var d={delta_secs}; \
         if(window.stbGetPosTime&&window.stbSetPosTime){{\
           var t=window.stbGetPosTime()+d; var len=window.stbGetLen?window.stbGetLen():0;\
           if(isFinite(len)&&len>0){{if(t<0)t=0; if(t>len)t=len;}} \
           window.stbSetPosTime(t); return;}}\
         var v=document.querySelector('video'); if(!v||!isFinite(v.duration))return; \
         var t=v.currentTime+d; if(t<0)t=0; if(t>v.duration)t=v.duration; v.currentTime=t;}})();"
    )
}

fn hwnd_for(app: &AppHandle) -> Option<*mut std::ffi::c_void> {
    #[cfg(target_os = "windows")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let win = app.get_webview_window("main")?;
        let handle = win.window_handle().ok()?;
        match handle.as_raw() {
            RawWindowHandle::Win32(h) => Some(h.hwnd.get() as *mut std::ffi::c_void),
            _ => None,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        None
    }
}

fn ensure_controls(app: &AppHandle, state: &MediaSessionState) -> Result<(), String> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "media session lock poisoned".to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let hwnd = hwnd_for(app);
    #[cfg(target_os = "windows")]
    if hwnd.is_none() {
        return Err("windows media session requires main window hwnd".into());
    }

    let config = PlatformConfig {
        dbus_name: "play.ott.foss",
        display_name: "OTT-play FOSS",
        hwnd,
    };

    let mut controls = MediaControls::new(config).map_err(|e| format!("MediaControls::new: {e}"))?;

    let app_cb = app.clone();
    let seek_flag = Arc::new(AtomicBool::new(false));
    let seek_flag_cb = seek_flag.clone();
    controls
        .attach(move |event: MediaControlEvent| {
            match event {
                MediaControlEvent::Play => eval_main(&app_cb, JS_PLAY),
                MediaControlEvent::Pause => eval_main(&app_cb, JS_PAUSE),
                MediaControlEvent::Toggle => {
                    eval_main(
                        &app_cb,
                        "if(window.stbIsPlaying&&window.stbPause&&window.stbContinue){if(window.stbIsPlaying())window.stbPause();else window.stbContinue();} true;",
                    );
                }
                MediaControlEvent::Next => eval_main(&app_cb, JS_NEXT),
                MediaControlEvent::Previous => eval_main(&app_cb, JS_PREV),
                MediaControlEvent::Stop => eval_main(&app_cb, JS_STOP),
                MediaControlEvent::SetPosition(MediaPosition(pos)) => {
                    // Live: ignore (honest no-op). VOD/archive only.
                    if !seek_flag_cb.load(Ordering::Relaxed) {
                        return;
                    }
                    eval_main(&app_cb, &js_seek_abs(pos.as_secs_f64()));
                }
                MediaControlEvent::Seek(dir) => {
                    if !seek_flag_cb.load(Ordering::Relaxed) {
                        return;
                    }
                    let delta = match dir {
                        SeekDirection::Forward => 10.0,
                        SeekDirection::Backward => -10.0,
                    };
                    eval_main(&app_cb, &js_seek_rel(delta));
                }
                MediaControlEvent::SeekBy(dir, amount) => {
                    if !seek_flag_cb.load(Ordering::Relaxed) {
                        return;
                    }
                    let secs = amount.as_secs_f64();
                    let delta = match dir {
                        SeekDirection::Forward => secs,
                        SeekDirection::Backward => -secs,
                    };
                    eval_main(&app_cb, &js_seek_rel(delta));
                }
                _ => {}
            }
        })
        .map_err(|e| format!("MediaControls::attach: {e}"))?;

    // Stash seek flag on inner via a side channel: we keep Arc in a static map keyed by...
    // Simpler: store Arc on MediaSessionInner and update it from apply_meta.
    *guard = Some(MediaSessionInner {
        controls,
        metadata: MetadataCache::default(),
        seekable: false,
        duration_secs: None,
    });
    // Re-bind seek flag: MediaSessionInner needs the Arc. Rebuild with Arc stored.
    // The attach closure already captured seek_flag_cb; keep a copy on state via OnceLock-like approach.
    // Store Arc in a companion field on MediaSessionState instead.
    drop(guard);
    // Put Arc into state-level slot so apply_meta can flip it.
    SEEKABLE_FLAG
        .lock()
        .map(|mut g| *g = Some(seek_flag))
        .ok();
    Ok(())
}

/// Shared seekable flag flipped by metadata updates; attach closure reads it.
static SEEKABLE_FLAG: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

fn set_seekable_flag(seekable: bool) {
    if let Ok(guard) = SEEKABLE_FLAG.lock() {
        if let Some(flag) = guard.as_ref() {
            flag.store(seekable, Ordering::Relaxed);
        }
    }
}

fn with_controls<F>(state: &MediaSessionState, f: F) -> Result<(), String>
where
    F: FnOnce(&mut MediaControls) -> Result<(), String>,
{
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "media session lock poisoned".to_string())?;
    let inner = guard
        .as_mut()
        .ok_or_else(|| "media session not started".to_string())?;
    f(&mut inner.controls)
}

fn apply_metadata(
    state: &MediaSessionState,
    title: &str,
    artist: &str,
    cover_url: Option<&str>,
    duration_sec: Option<f64>,
    position_sec: Option<f64>,
    seekable: bool,
    playing: bool,
) -> Result<(), String> {
    set_seekable_flag(seekable);
    {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "media session lock poisoned".to_string())?;
        if let Some(inner) = guard.as_mut() {
            inner.seekable = seekable;
            inner.duration_secs = if seekable { duration_sec } else { None };
        }
    }

    let duration = if seekable {
        duration_sec
            .filter(|d| d.is_finite() && *d > 0.0)
            .map(|d| Duration::from_secs_f64(d))
    } else {
        None
    };
    let progress = if seekable {
        position_sec
            .filter(|p| p.is_finite() && *p >= 0.0)
            .map(|p| MediaPosition(Duration::from_secs_f64(p)))
    } else {
        None
    };

    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "media session lock poisoned".to_string())?;
    let inner = guard
        .as_mut()
        .ok_or_else(|| "media session not started".to_string())?;
    let controls = &mut inner.controls;
    inner.metadata.publish(
        MetadataSnapshot {
            title: title.to_owned(),
            artist: artist.to_owned(),
            cover_url: cover_url.map(str::to_owned),
            duration,
        },
        |metadata| {
            controls
                .set_metadata(metadata)
                .map_err(|e| format!("set_metadata: {e}"))
        },
    )?;
    let playback = if playing {
        MediaPlayback::Playing { progress }
    } else {
        MediaPlayback::Paused { progress }
    };
    controls
        .set_playback(playback)
        .map_err(|e| format!("set_playback: {e}"))
}

// Souvlaki delegates remote artwork to untracked OS downloads. Fetch it under
// our cancellation lease and give OS controls only a bounded local raster file.
fn raster_artwork(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.starts_with(b"\xff\xd8\xff")
        || bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")
        || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"))
}

async fn fetch_artwork(work: &ottplay_core::background_work::WorkLease, raw: &str) -> Result<Option<Vec<u8>>, String> {
    const LIMIT: usize = 4 * 1024 * 1024;
    let Ok(url) = reqwest::Url::parse(raw) else { return Ok(None) };
    if !matches!(url.scheme(), "http" | "https") { return Ok(None) }
    let fetched = work.run(async {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().ok()?;
        let mut response = client.get(url).send().await.ok()?.error_for_status().ok()?;
        if response.content_length().is_some_and(|length| length > LIMIT as u64) { return None }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len() + chunk.len() > LIMIT { return None }
            bytes.extend_from_slice(&chunk);
        }
        raster_artwork(&bytes).then_some(bytes)
    }).await.map_err(str::to_string)?;
    Ok(fetched)
}

async fn prepare_artwork(app: &AppHandle, state: &MediaSessionState, work: &ottplay_core::background_work::WorkLease, raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else { return Ok(None) };
    let mut cache = work.run(state.artwork.lock()).await.map_err(str::to_string)?;
    if let Some((source, local)) = cache.as_ref() {
        if source == raw { return Ok(Some(local.clone())) }
    }
    let Some(bytes) = fetch_artwork(work, raw).await? else { return Ok(None) };
    let root = crate::instance::app_data_dir(app)?;
    // Alternate two bounded files so metadata sees a changed local URL.
    // Filesystem completion remains counted if standby arrives during a write.
    tokio::fs::create_dir_all(&root).await.map_err(|_| "Artwork cache unavailable")?;
    work.check().map_err(str::to_string)?;
    let slot = if cache.as_ref().is_some_and(|(_, local)| local.ends_with("-0")) { 1 } else { 0 };
    let path = root.join(format!("media-session-artwork-{slot}"));
    let temporary = root.join("media-session-artwork.tmp");
    tokio::fs::write(&temporary, bytes).await.map_err(|_| "Artwork cache unavailable")?;
    work.check().map_err(str::to_string)?;
    tokio::fs::rename(temporary, &path).await.map_err(|_| "Artwork cache unavailable")?;
    work.check().map_err(str::to_string)?;
    #[cfg(target_os = "windows")]
    let local = format!("file://{}", path.display()); // Souvlaki passes this path directly to WinRT.
    #[cfg(not(target_os = "windows"))]
    let local = url::Url::from_file_path(path).map_err(|_| "Artwork cache unavailable")?.to_string();
    *cache = Some((raw.to_owned(), local.clone()));
    Ok(Some(local))
}

fn publish_media_generation<T>(
    generation: &AtomicU64,
    expected: u64,
    work: &ottplay_core::background_work::WorkLease,
    publish: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    work.publish(|| {
        if generation.load(Ordering::SeqCst) != expected {
            return Err("Media session superseded".into());
        }
        publish()
    }).map_err(str::to_string)?
}

fn meta_args(
    title: Option<String>,
    artist: Option<String>,
) -> (String, String) {
    (
        title.unwrap_or_else(|| "OTT-play FOSS".into()),
        artist.unwrap_or_else(|| "Now playing".into()),
    )
}

/// `invoke('start_media_session', { title, artist, artworkUrl, durationSec, positionSec, seekable })`
#[tauri::command]
pub async fn start_media_session(
    app: AppHandle,
    state: State<'_, MediaSessionState>,
    title: Option<String>,
    artist: Option<String>,
    #[allow(non_snake_case)]
    artworkUrl: Option<String>,
    #[allow(non_snake_case)]
    durationSec: Option<f64>,
    #[allow(non_snake_case)]
    positionSec: Option<f64>,
    seekable: Option<bool>,
) -> Result<MediaSessionResult, String> {
    let work = app.state::<ottplay_core::background_work::BackgroundWork>().enter().map_err(str::to_string)?;
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let artwork = prepare_artwork(&app, &state, &work, artworkUrl.as_deref()).await?;
    work.check().map_err(str::to_string)?;
    if state.generation.load(Ordering::SeqCst) != generation { return Err("Media session superseded".into()) }
    let (title, artist) = meta_args(title, artist);
    let seekable = seekable.unwrap_or(false);
    if let Err(e) = ensure_controls(&app, &state) {
        return Ok(err(e));
    }
    match publish_media_generation(&state.generation, generation, &work, || {
        apply_metadata(
            &state,
            &title,
            &artist,
            artwork.as_deref(),
            durationSec,
            positionSec,
            seekable,
            true,
        )
    }) {
        Ok(()) => Ok(ok()),
        Err(e) => Ok(err(e)),
    }
}

/// `invoke('pause_media_session')`
#[tauri::command]
pub async fn pause_media_session(
    state: State<'_, MediaSessionState>,
) -> Result<MediaSessionResult, String> {
    match with_controls(&state, |c| {
        c.set_playback(MediaPlayback::Paused { progress: None })
            .map_err(|e| format!("set_playback: {e}"))
    }) {
        Ok(()) => Ok(ok()),
        Err(e) => Ok(err(e)),
    }
}

/// `invoke('resume_media_session', { title, artist, artworkUrl, durationSec, positionSec, seekable })`
#[tauri::command]
pub async fn resume_media_session(
    app: AppHandle,
    state: State<'_, MediaSessionState>,
    title: Option<String>,
    artist: Option<String>,
    #[allow(non_snake_case)]
    artworkUrl: Option<String>,
    #[allow(non_snake_case)]
    durationSec: Option<f64>,
    #[allow(non_snake_case)]
    positionSec: Option<f64>,
    seekable: Option<bool>,
) -> Result<MediaSessionResult, String> {
    if state.inner.lock().map(|g| g.is_none()).unwrap_or(true) {
        return start_media_session(
            app,
            state,
            title,
            artist,
            artworkUrl,
            durationSec,
            positionSec,
            seekable,
        )
        .await;
    }
    let work = app.state::<ottplay_core::background_work::BackgroundWork>().enter().map_err(str::to_string)?;
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let artwork = prepare_artwork(&app, &state, &work, artworkUrl.as_deref()).await?;
    work.check().map_err(str::to_string)?;
    if state.generation.load(Ordering::SeqCst) != generation { return Err("Media session superseded".into()) }
    let (title, artist) = meta_args(title, artist);
    let seekable = seekable.unwrap_or(false);
    match publish_media_generation(&state.generation, generation, &work, || {
        apply_metadata(
            &state,
            &title,
            &artist,
            artwork.as_deref(),
            durationSec,
            positionSec,
            seekable,
            true,
        )
    }) {
        Ok(()) => Ok(ok()),
        Err(e) => Ok(err(e)),
    }
}

/// `invoke('update_media_session', { title, artist, artworkUrl, durationSec, positionSec, seekable })`
#[tauri::command]
pub async fn update_media_session(
    app: AppHandle,
    state: State<'_, MediaSessionState>,
    title: Option<String>,
    artist: Option<String>,
    #[allow(non_snake_case)]
    artworkUrl: Option<String>,
    #[allow(non_snake_case)]
    durationSec: Option<f64>,
    #[allow(non_snake_case)]
    positionSec: Option<f64>,
    seekable: Option<bool>,
) -> Result<MediaSessionResult, String> {
    if state.inner.lock().map(|g| g.is_none()).unwrap_or(true) {
        return start_media_session(
            app,
            state,
            title,
            artist,
            artworkUrl,
            durationSec,
            positionSec,
            seekable,
        )
        .await;
    }
    let work = app.state::<ottplay_core::background_work::BackgroundWork>().enter().map_err(str::to_string)?;
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let artwork = prepare_artwork(&app, &state, &work, artworkUrl.as_deref()).await?;
    work.check().map_err(str::to_string)?;
    if state.generation.load(Ordering::SeqCst) != generation { return Err("Media session superseded".into()) }
    let (title, artist) = meta_args(title, artist);
    let seekable = seekable.unwrap_or(false);
    match publish_media_generation(&state.generation, generation, &work, || {
        apply_metadata(
            &state,
            &title,
            &artist,
            artwork.as_deref(),
            durationSec,
            positionSec,
            seekable,
            true,
        )
    }) {
        Ok(()) => Ok(ok()),
        Err(e) => Ok(err(e)),
    }
}

/// `invoke('stop_media_session')`
#[tauri::command]
pub async fn stop_media_session(
    state: State<'_, MediaSessionState>,
) -> Result<MediaSessionResult, String> {
    state.generation.fetch_add(1, Ordering::SeqCst);
    set_seekable_flag(false);
    let mut guard = match state.inner.lock() {
        Ok(g) => g,
        Err(_) => return Ok(err("media session lock poisoned")),
    };
    if let Some(mut inner) = guard.take() {
        let _ = inner.controls.set_playback(MediaPlayback::Stopped);
        // Drop detaches controls.
    }
    Ok(ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_metadata_rechecks_generation_inside_publication_lock() {
        let background = ottplay_core::background_work::BackgroundWork::default();
        let work = background.enter().unwrap();
        let blocked = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let holder = {
            let work = work.clone();
            let blocked = blocked.clone();
            let release = release.clone();
            std::thread::spawn(move || work.publish(|| { blocked.wait(); release.wait(); }).unwrap())
        };
        blocked.wait();
        let generation = Arc::new(AtomicU64::new(1));
        let (started, ready) = std::sync::mpsc::channel();
        let old = {
            let generation = generation.clone();
            std::thread::spawn(move || {
                assert_eq!(generation.load(Ordering::SeqCst), 1);
                started.send(()).unwrap();
                publish_media_generation(&generation, 1, &work, || panic!("stale metadata published"))
            })
        };
        ready.recv().unwrap();
        generation.store(2, Ordering::SeqCst);
        release.wait();
        holder.join().unwrap();
        let result: Result<(), String> = old.join().unwrap();
        assert_eq!(result.unwrap_err(), "Media session superseded");
    }

    #[tokio::test]
    async fn standby_cancels_artwork_before_os_delivery() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/poster", listener.local_addr().unwrap());
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
        let work = background.enter().unwrap();
        let request = tokio::spawn(async move { fetch_artwork(&work, &url).await });
        ready.await.unwrap();
        background.set_standby(true);
        assert!(request.await.unwrap().is_err());
        assert!(background.status().quiescent);
        server.await.unwrap();
    }

    #[test]
    fn artwork_never_delegates_remote_svg_loads_to_os() {
        assert!(raster_artwork(b"\x89PNG\r\n\x1a\n"));
        assert!(raster_artwork(b"GIF89a"));
        assert!(!raster_artwork(b"<svg><image href='https://example.test/image'/></svg>"));
        assert!(!raster_artwork(b"not an image"));
    }

    fn movie() -> MetadataSnapshot {
        MetadataSnapshot {
            title: "Movie".into(),
            artist: "OTT-play FOSS".into(),
            cover_url: Some("https://example.test/poster.jpg".into()),
            duration: Some(Duration::from_secs(600)),
        }
    }

    #[test]
    fn position_refreshes_keep_artwork_until_metadata_changes() {
        let mut cache = MetadataCache::default();
        let mut published = Vec::new();
        let mut publish = |metadata: MediaMetadata<'_>| {
            published.push((
                metadata.title.unwrap().to_owned(),
                metadata.artist.unwrap().to_owned(),
                metadata.cover_url.map(str::to_owned),
                metadata.duration,
            ));
            Ok(())
        };
        for _ in 0..300 {
            cache.publish(movie(), &mut publish).unwrap();
        }
        let mut next = movie();
        next.title = "Next movie".into();
        cache.publish(next.clone(), &mut publish).unwrap();
        next.cover_url = None;
        cache.publish(next.clone(), &mut publish).unwrap();
        next.duration = None;
        cache.publish(next.clone(), &mut publish).unwrap();
        next.artist = "Live TV".into();
        cache.publish(next, &mut publish).unwrap();
        // A fresh session must publish even when restarting the same movie.
        MetadataCache::default()
            .publish(movie(), &mut publish)
            .unwrap();
        assert_eq!(published.len(), 6);
        assert_eq!(published[1].0, "Next movie");
        assert_eq!(published[2].2, None);
        assert_eq!(published[3].3, None);
        assert_eq!(published[4].1, "Live TV");
    }

    #[test]
    fn failed_metadata_publication_is_retried() {
        let mut cache = MetadataCache::default();
        assert!(cache
            .publish(movie(), |_| Err("unavailable".into()))
            .is_err());
        let mut retries = 0;
        cache
            .publish(movie(), |_| {
                retries += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(retries, 1);
    }
}
