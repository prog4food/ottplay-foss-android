//! TMDB proxy: api.themoviedb.org/3/* + image.tmdb.org/t/p/*.
use anyhow::{anyhow, Result};
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use reqwest::Client;

/// Fetch from TMDB. `api_key` injected server-side (env var).
pub async fn proxy(
    path_tail: &str,
    query: &str,
    api_key: &str,
) -> Result<(u16, HeaderMap, Vec<u8>)> {
    let target = build_url(path_tail, query, api_key)?;
    let client = Client::builder()
        .user_agent("OTT-play-FOSS/1.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let resp = client
        .get(&target)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| anyhow!("tmdb upstream: {e}"))?;

    let status = resp.status();
    let mut out_headers = HeaderMap::new();
    if let Some(ct) = resp.headers().get(CONTENT_TYPE) {
        out_headers.insert(CONTENT_TYPE, HeaderValue::from_bytes(ct.as_bytes()).unwrap());
    } else {
        out_headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    }
    let body = resp.bytes().await?.to_vec();
    Ok((status.as_u16(), out_headers, body))
}

fn build_url(path_tail: &str, query: &str, api_key: &str) -> Result<String> {
    let (base, tail) = if let Some(rest) = path_tail.strip_prefix("s/") {
        ("https://api.themoviedb.org/3/", rest)
    } else if let Some(rest) = path_tail.strip_prefix("i/") {
        ("https://image.tmdb.org/t/p/", rest)
    } else {
        return Err(anyhow!("invalid tmdb path (expected s/* or i/*)"));
    };
    let mut url = format!("{base}{tail}");
    if !query.is_empty() {
        url.push('?');
        url.push_str(query);
    }
    // Inject api_key for API calls; image CDN ignores it.
    if base.contains("themoviedb.org/3/") {
        if url.contains('?') {
            url.push('&');
        } else {
            url.push('?');
        }
        url.push_str("api_key=");
        url.push_str(&urlencoding::encode(api_key));
    }
    Ok(url)
}

/// Read TMDB_API_KEY at startup. Returns None if missing — server runs without it,
/// /tmdb/* endpoints return 503 instead of panicking.
pub fn api_key_from_env() -> Option<String> {
    match std::env::var("TMDB_API_KEY") {
        Ok(k) if !k.is_empty() => Some(k),
        _ => None,
    }
}

/// Returns Err if no key — used by /tmdb/* handlers to short-circuit with 503.
pub fn require_api_key() -> Result<String> {
    api_key_from_env().ok_or_else(|| anyhow!("TMDB_API_KEY not set"))
}
