//! Version and feedback command handlers for Tauri Mode B.
//!
//! Mirrors Mode A contracts from `src-rs/server/src/main.rs` (version_handler
//! lines 562-596) and `archive/server.py` (_serve_version, _serve_feedback_get,
//! _serve_feedback_post).
//!
//! Commands exposed to JS via `invoke()`:
//! - `get_version({rel})` → `{file, hash, modified, size}`
//! - `feedback_get({path})` → `{"status":"ok"}` (GET fallback)
//! - `feedback_post({path, body})` → `{"status":"ok"}` (POST append to log)

use serde::Serialize;
use std::io::Write;
use tauri::Manager;

/// Version info — returned as JSON `{file, hash, modified, size}` matching
/// Mode A's version_handler shape (MD5 hex truncated to 16 chars).
#[derive(Serialize)]
pub struct VersionInfo {
    pub file: String,
    pub hash: String,
    pub modified: i64,
    pub size: u64,
}

/// Feedback result — returned as JSON `{"status":"ok"}` matching
/// Mode A's feedback_handler and _serve_feedback_post shapes.
#[derive(Serialize)]
pub struct FeedbackResult {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// `invoke('get_version', {rel})` → file metadata with MD5 hash.
///
/// Security: rejects `..` path traversal and empty paths.
/// Resolves relative to the Tauri app resources directory.
#[tauri::command]
pub async fn get_version(
    app: tauri::AppHandle,
    rel: String,
) -> Result<VersionInfo, String> {
    // Reject path traversal and empty paths (Mode A version_handler parity).
    let stripped = rel.trim_start_matches('/').to_string();
    if stripped.is_empty() || stripped.contains("..") {
        return Err("Invalid path: traversal or empty not allowed".to_string());
    }

    // Prefer resource dir (bundled frontendDist); fall back to cwd like Mode A.
    let base = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| ".".into()));
    let resolved = base.join(&stripped);

    // Verify it's a file
    let metadata = std::fs::metadata(&resolved)
        .map_err(|e| format!("Failed to stat file: {e}"))?;

    if !metadata.is_file() {
        return Err("Not a file".to_string());
    }

    // Read file contents for hashing
    let bytes = std::fs::read(&resolved)
        .map_err(|e| format!("Failed to read file: {e}"))?;

    // Compute MD5 hash (first 16 hex chars, matching Mode A version_handler)
    let digest = md5::compute(&bytes);
    let hash = format!("{:x}", digest)[..16].to_string();

    // Get modified time as Unix timestamp
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH).ok()
        })
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    Ok(VersionInfo {
        file: resolved
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string(),
        hash,
        modified,
        size: metadata.len(),
    })
}

/// `invoke('feedback_get', {path})` → `{"status":"ok"}` for GET requests.
#[tauri::command]
pub async fn feedback_get(_app: tauri::AppHandle, _path: String) -> Result<FeedbackResult, String> {
    Ok(FeedbackResult {
        status: "ok",
        message: Some("Feedback endpoint".to_string()),
    })
}

/// `invoke('feedback_post', {path, body})` → `{"status":"ok"}`.
///
/// Appends feedback to `feedback.log` under the app data directory (creates
/// the file if it does not exist). Format matches Mode A:
///   `{ts} {path}\n{body}\n---\n`
#[tauri::command]
pub async fn feedback_post(
    app: tauri::AppHandle,
    path: String,
    body: String,
) -> Result<FeedbackResult, String> {
    // Ensure feedback.log exists in app data directory (per-instance when set).
    let mut log_path = crate::instance::app_data_dir(&app)?;
    std::fs::create_dir_all(&log_path)
        .map_err(|e| format!("Failed to create app data dir: {e}"))?;
    log_path.push("feedback.log");

    // Append in Mode A format: `{ts} {path}\n{body}\n---\n`
    let ts = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let log_entry = format!("{ts} {path}\n{body}\n---\n");

    // OpenOptions: create if not exists, append mode
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|e| format!("Failed to open feedback.log: {e}"))?;

    file.write_all(log_entry.as_bytes())
        .map_err(|e| format!("Failed to write to feedback.log: {e}"))?;

    Ok(FeedbackResult {
        status: "ok",
        message: Some("Feedback recorded".to_string()),
    })
}
