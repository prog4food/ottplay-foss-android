//! TMDB API / image proxy for Tauri Mode B.
//!
//! Mirrors Mode A companion `GET /tmdb/s/*` and `GET /tmdb/i/*` via
//! `ottplay_core::tmdb`, injecting `TMDB_API_KEY` server-side (never from JS).

use serde::Serialize;

/// Result shape for `invoke('tmdb_proxy')`.
///
/// - API (`s/*`): `body` is upstream JSON text; `body_base64` is null.
/// - Images (`i/*`): `body` is empty; `body_base64` holds raw bytes (standard base64).
#[derive(Debug, Serialize)]
pub struct TmdbProxyResult {
    pub status: u16,
    pub content_type: String,
    pub body: String,
    pub body_base64: Option<String>,
}

/// `invoke('tmdb_proxy', { path, query })` — proxy a companion-style TMDB path.
///
/// `path` may be `s/search/multi`, `i/w500/abc.jpg`, or include a `/tmdb/` prefix.
/// `query` is the raw query string without leading `?` (may be empty).
///
/// Missing `TMDB_API_KEY` rejects (Mode A Rust companion returns 503).
#[tauri::command]
pub async fn tmdb_proxy(
    background: tauri::State<'_, ottplay_core::background_work::BackgroundWork>,
    path: String,
    query: Option<String>,
) -> Result<TmdbProxyResult, String> {
    let work = background.enter().map_err(str::to_string)?;
    work.run(async {
        let api_key = ottplay_core::tmdb::require_api_key().map_err(|e| e.to_string())?;
        let query = query.unwrap_or_default();
        let path_tail = normalize_tmdb_path(&path)?;

    let (status, headers, bytes) = ottplay_core::tmdb::proxy(&path_tail, &query, &api_key)
        .await
        .map_err(|e| e.to_string())?;

    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    // Non-success: surface upstream body in the error for debugging (JSON errors).
    if !(200..300).contains(&status) {
        let msg = String::from_utf8_lossy(&bytes).into_owned();
        return Err(format!("tmdb HTTP {status}: {msg}"));
    }

        if path_tail.starts_with("s/")
            || content_type.contains("json")
            || content_type.starts_with("text/")
        {
            Ok(TmdbProxyResult {
                status,
                content_type,
                body: String::from_utf8_lossy(&bytes).into_owned(),
                body_base64: None,
            })
        } else {
            Ok(TmdbProxyResult {
                status,
                content_type,
                body: String::new(),
                body_base64: Some(b64_encode(&bytes)),
            })
        }
    })
    .await
    .map_err(str::to_string)?
}

fn normalize_tmdb_path(path: &str) -> Result<String, String> {
    let mut p = path.trim();
    if let Some(rest) = p.strip_prefix("http://") {
        p = rest;
    } else if let Some(rest) = p.strip_prefix("https://") {
        p = rest;
    }
    // Drop host if an absolute URL was passed (tauri.localhost/tmdb/s/...).
    if let Some(idx) = p.find("/tmdb/") {
        p = &p[idx..];
    }
    p = p.trim_start_matches('/');
    if let Some(rest) = p.strip_prefix("tmdb/") {
        p = rest;
    }
    p = p.trim_start_matches('/');
    // Drop any query accidentally left on path.
    if let Some((head, _)) = p.split_once('?') {
        p = head;
    }
    if !(p.starts_with("s/") || p.starts_with("i/")) {
        return Err(format!(
            "invalid tmdb path (expected s/* or i/*), got {p:?}"
        ));
    }
    Ok(p.to_string())
}

fn b64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = data.len() - i;
    if rem == 1 {
        let n = (data[i] as u32) << 16;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::normalize_tmdb_path;

    #[test]
    fn normalizes_prefixes() {
        assert_eq!(
            normalize_tmdb_path("/tmdb/s/search/multi").unwrap(),
            "s/search/multi"
        );
        assert_eq!(
            normalize_tmdb_path("tmdb/i/w500/x.jpg").unwrap(),
            "i/w500/x.jpg"
        );
        assert_eq!(normalize_tmdb_path("s/movie/1").unwrap(), "s/movie/1");
    }
}
