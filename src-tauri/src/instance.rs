//! Multi-instance data isolation for desktop Tauri shells.
//!
//! macOS WKWebView ignores `$HOME` overrides and always keys the default
//! `WKWebsiteDataStore` / `NSSearchPath` dirs off the real home + bundle id
//! (`com.ottplay.foss`). Queue ports already isolate via `OTTPLAY_QUEUE_PORT`.
//!
//! Prefer `OTTPLAY_DATA_DIR` (absolute). Else `OTTPLAY_INSTANCE` (e.g. `2`)
//! → `~/Library/Application Support/com.ottplay.foss.<instance>` (and the
//! matching webview data directory under that tree). Unset → identical to
//! stock Tauri paths.
//!
//! Webview remote state (localStorage / cookies): `data_directory` on
//! Win/Linux; on macOS 14+ also a stable `data_store_identifier` UUID derived
//! from the data dir (WKWebView has no path-based store API).

use std::path::{Path, PathBuf};

use tauri::{Manager, Runtime, WebviewWindowBuilder};

/// Bundle identifier from `tauri.conf.json` — keep in sync when renaming.
pub const BUNDLE_ID: &str = "com.ottplay.foss";

/// Resolve the isolated app-data root, if either env var is set.
///
/// - `OTTPLAY_DATA_DIR` (absolute) wins when set.
/// - else `OTTPLAY_INSTANCE` → `<platform data dir>/{BUNDLE_ID}.<instance>`.
/// - else `None` (callers keep stock `app.path().app_data_dir()`).
pub fn resolve_data_dir() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("OTTPLAY_DATA_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.is_absolute() {
                return Some(path);
            }
            tracing::warn!(
                "OTTPLAY_DATA_DIR must be an absolute path, ignoring: {}",
                path.display()
            );
        }
    }

    if let Ok(raw) = std::env::var("OTTPLAY_INSTANCE") {
        let inst = raw.trim();
        if inst.is_empty()
            || inst.contains("..")
            || inst.contains('/')
            || inst.contains('\\')
            || inst.contains('\0')
        {
            tracing::warn!("invalid OTTPLAY_INSTANCE={raw:?}; ignoring");
            return None;
        }
        return platform_data_dir().map(|base| base.join(format!("{BUNDLE_ID}.{inst}")));
    }

    None
}

/// Slug for window-state filename / logs when isolation is active.
pub fn isolation_slug() -> Option<String> {
    if let Ok(raw) = std::env::var("OTTPLAY_DATA_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_absolute() {
            let digest = md5::compute(trimmed.as_bytes());
            let hex = format!("{:x}", digest);
            return Some(format!("dir{}", &hex[..10]));
        }
    }
    if let Ok(raw) = std::env::var("OTTPLAY_INSTANCE") {
        let inst = raw.trim();
        if !inst.is_empty()
            && !inst.contains("..")
            && !inst.contains('/')
            && !inst.contains('\\')
            && !inst.contains('\0')
        {
            return Some(format!("inst{inst}"));
        }
    }
    None
}

/// Window-state plugin filename so instances do not clobber geometry.
pub fn window_state_filename() -> Option<String> {
    isolation_slug().map(|s| format!(".window-state.{s}.json"))
}

/// Webview profile directory under the instance data root.
pub fn webview_data_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("webview")
}

/// Stable 16-byte WKWebsiteDataStore id derived from the data dir path.
pub fn data_store_identifier(data_dir: &Path) -> [u8; 16] {
    let key = format!("ottplay-foss:webview:{}", data_dir.display());
    *md5::compute(key.as_bytes())
}

/// Create app-data + webview dirs (and a WebKit-sidecar folder on macOS).
pub fn ensure_dirs(data_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    std::fs::create_dir_all(webview_data_dir(data_dir))?;
    #[cfg(target_os = "macos")]
    {
        if let Some(webkit) = webkit_sidecar_dir(data_dir) {
            std::fs::create_dir_all(&webkit)?;
        }
    }
    Ok(())
}

/// macOS: `~/Library/WebKit/com.ottplay.foss.<instance>` marker/sidecar path.
///
/// Actual WK persistent state for non-default stores lives under WebKit's
/// UUID-based WebsiteDataStore tree; this sibling dir makes instance layout
/// discoverable next to Application Support and holds optional extras.
#[cfg(target_os = "macos")]
pub fn webkit_sidecar_dir(data_dir: &Path) -> Option<PathBuf> {
    let name = data_dir.file_name()?.to_str()?;
    if !name.starts_with(BUNDLE_ID) {
        // OTTPLAY_DATA_DIR custom root: still place a WebKit folder named after
        // a stable hash so instances stay distinct.
        let digest = md5::compute(data_dir.display().to_string().as_bytes());
        let hashed = format!("{BUNDLE_ID}.{}", &format!("{:x}", digest)[..8]);
        return std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/WebKit").join(hashed));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/WebKit").join(name))
}

/// Apply wry/Tauri webview isolation (path + macOS data-store UUID).
pub fn apply_isolation<'a, R: Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    data_dir: &Path,
) -> WebviewWindowBuilder<'a, R, M> {
    let webview_dir = webview_data_dir(data_dir);
    let store_id = data_store_identifier(data_dir);
    builder
        .data_directory(webview_dir)
        .data_store_identifier(store_id)
}

fn platform_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support"));
    }
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("APPDATA").map(PathBuf::from);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            return Some(PathBuf::from(xdg));
        }
        return std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"));
    }
}

/// App data dir for feedback / callers: isolated root or stock Tauri path.
pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = resolve_data_dir() {
        ensure_dirs(&dir).map_err(|e| format!("Failed to create instance data dir: {e}"))?;
        return Ok(dir);
    }
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))
}
