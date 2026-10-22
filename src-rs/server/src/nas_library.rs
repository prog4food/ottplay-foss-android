//! Native VPortal catalog backed by Plex on a trusted, administrator-configured NAS.
//! Plex credentials never enter a catalog, playlist, response header, or player URL.
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, OwnedRwLockReadGuard, RwLock, Semaphore};

type HmacSha256 = Hmac<Sha256>;
const MAX_JSON: usize = 8 * 1024 * 1024;
const MAX_PLAYLIST: usize = 2 * 1024 * 1024;
const URL_TTL: u64 = 7 * 24 * 60 * 60;
const MAX_EXPORT_ITEMS: usize = 100_000;
const CATALOG_CACHE_TTL: Duration = Duration::from_secs(15);
const CATALOG_CACHE_BYTES: usize = 16 * 1024 * 1024;
const CATALOG_CACHE_ENTRIES: usize = 32;
static HLS_URI_REGEX: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
    regex::Regex::new(r#"URI="([^"]*)""#).expect("constant URI regex")
});

struct CachedCatalog {
    value: Arc<Value>,
    bytes: usize,
    expires: Instant,
    used: Instant,
}

#[derive(Default)]
struct CatalogCache {
    entries: HashMap<String, CachedCatalog>,
    flights: HashMap<String, std::sync::Weak<Mutex<()>>>,
    bytes: usize,
}

impl CatalogCache {
    fn get(&mut self, key: &str) -> Option<Arc<Value>> {
        let entry = self.entries.get_mut(key)?;
        if Instant::now() < entry.expires {
            entry.used = Instant::now();
            return Some(entry.value.clone());
        }
        self.bytes -= self.entries.remove(key).unwrap().bytes;
        None
    }

    fn insert(&mut self, key: String, value: Arc<Value>, bytes: usize) {
        if bytes > CATALOG_CACHE_BYTES {
            return;
        }
        if let Some(previous) = self.entries.remove(&key) {
            self.bytes -= previous.bytes;
        }
        let now = Instant::now();
        self.entries.retain(|_, entry| {
            if entry.expires <= now {
                self.bytes -= entry.bytes;
                false
            } else {
                true
            }
        });
        while self.entries.len() >= CATALOG_CACHE_ENTRIES
            || self.bytes + bytes > CATALOG_CACHE_BYTES
        {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.bytes -= self.entries.remove(&oldest).unwrap().bytes;
        }
        self.bytes += bytes;
        self.entries.insert(
            key,
            CachedCatalog {
                value,
                bytes,
                expires: now + CATALOG_CACHE_TTL,
                used: now,
            },
        );
    }
}

struct TranscodeSession {
    seen: Instant,
    gate: Arc<RwLock<()>>,
}
impl TranscodeSession {
    fn new(seen: Instant) -> Self {
        Self {
            seen,
            gate: Arc::new(RwLock::new(())),
        }
    }
}

struct SessionLease {
    session: String,
    gate: Arc<RwLock<()>>,
    _guard: OwnedRwLockReadGuard<()>,
}

#[derive(Clone)]
struct Library {
    upstream: reqwest::Url,
    token: HeaderValue,
    key: Vec<u8>,
    client: reqwest::Client,
    metadata: Arc<Semaphore>,
    streams: Arc<Semaphore>,
    sessions: Arc<Mutex<HashMap<String, TranscodeSession>>>,
    browser_hosts: Vec<String>,
    catalog_cache: Arc<Mutex<CatalogCache>>,
    catalog_waiters: Arc<Semaphore>,
}

pub fn routes_from_env() -> anyhow::Result<Router> {
    let url = std::env::var("OTTPLAY_PLEX_URL").unwrap_or_default();
    let token = std::env::var("OTTPLAY_PLEX_TOKEN").unwrap_or_default();
    let key = std::env::var("OTTPLAY_NAS_KEY").unwrap_or_default();
    if url.is_empty() && token.is_empty() && key.is_empty() {
        return Ok(Router::new().route(
            "/nas/config",
            get(|| async { no_store(Json(json!({"enabled":false})).into_response()) }),
        ));
    }
    let mut library = Library::new(&url, &token, &key)?;
    for host in std::env::var("OTTPLAY_NAS_BROWSER_HOSTS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|host| !host.is_empty())
    {
        anyhow::ensure!(
            host.len() <= 253
                && host
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric()
                        || matches!(c, b'.' | b'-' | b':' | b'[' | b']')),
            "OTTPLAY_NAS_BROWSER_HOSTS must contain comma-separated hostnames"
        );
        library.browser_hosts.push(
            host.trim_matches(['[', ']'])
                .trim_end_matches('.')
                .to_ascii_lowercase(),
        );
    }
    Ok(routes(library))
}

impl Library {
    fn new(url: &str, token: &str, key: &str) -> anyhow::Result<Self> {
        let upstream =
            reqwest::Url::parse(url).map_err(|_| anyhow::anyhow!("Invalid OTTPLAY_PLEX_URL"))?;
        anyhow::ensure!(
            matches!(upstream.scheme(), "http" | "https")
                && upstream.host_str().is_some()
                && upstream.username().is_empty()
                && upstream.password().is_none()
                && upstream.query().is_none()
                && upstream.fragment().is_none()
                && upstream.path() == "/",
            "OTTPLAY_PLEX_URL must contain only the HTTP(S) Plex origin"
        );
        anyhow::ensure!(!token.trim().is_empty(), "OTTPLAY_PLEX_TOKEN is required");
        anyhow::ensure!(
            key.len() >= 32,
            "OTTPLAY_NAS_KEY must contain at least 32 characters"
        );
        let mut token = HeaderValue::from_str(token)
            .map_err(|_| anyhow::anyhow!("Invalid OTTPLAY_PLEX_TOKEN"))?;
        token.set_sensitive(true);
        Ok(Self {
            upstream,
            token,
            key: key.as_bytes().to_vec(),
            client: reqwest::Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(10))
                .read_timeout(Duration::from_secs(90))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            metadata: Arc::new(Semaphore::new(8)),
            streams: Arc::new(Semaphore::new(32)),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            browser_hosts: Vec::new(),
            catalog_cache: Arc::new(Mutex::new(CatalogCache::default())),
            catalog_waiters: Arc::new(Semaphore::new(64)),
        })
    }

    fn signature(&self, value: &[u8]) -> Vec<u8> {
        let mut mac =
            HmacSha256::new_from_slice(&self.key).expect("HMAC accepts arbitrary key sizes");
        mac.update(value);
        mac.finalize().into_bytes().to_vec()
    }

    fn accepts_key(&self, key: &str) -> bool {
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("valid HMAC key");
        mac.update(key.as_bytes());
        mac.verify_slice(&self.signature(&self.key)).is_ok()
    }

    fn accepts_browser(
        &self,
        headers: &HeaderMap,
        expected: &str,
        peer: Option<std::net::SocketAddr>,
    ) -> bool {
        let Some(peer) = peer else {
            return false;
        };
        if !same_origin(headers, expected) {
            return false;
        }
        let Ok(url) = reqwest::Url::parse(expected) else {
            return false;
        };
        let Some(host) = url.host_str() else {
            return false;
        };
        let host = host
            .trim_matches(['[', ']'])
            .trim_end_matches('.')
            .to_ascii_lowercase();
        self.browser_hosts.iter().any(|allowed| allowed == &host)
            || (local_host(&host) && local_ip(peer.ip()))
    }

    fn url(&self, path: &str) -> Result<reqwest::Url, &'static str> {
        if path.len() > 8192
            || !path.starts_with('/')
            || path.starts_with("//")
            || path.contains('\\')
            || path.chars().any(char::is_control)
        {
            return Err("Invalid media path");
        }
        let decoded = urlencoding::decode(path).map_err(|_| "Invalid media path")?;
        if decoded
            .split(['/', '?', '#'])
            .any(|part| part == ".." || part == ".")
        {
            return Err("Invalid media path");
        }
        let url = self.upstream.join(path).map_err(|_| "Invalid media path")?;
        if url.origin() != self.upstream.origin()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("Invalid media path");
        }
        Ok(url)
    }

    async fn fetch(
        &self,
        path: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Arc<Value>, &'static str> {
        // Play resolution and transcode negotiation must always reflect Plex's current state.
        let cacheable = path == "/library/sections"
            || path.starts_with("/hubs/search?")
            || path.starts_with("/library/sections/")
            || (path.starts_with("/library/metadata/") && path.ends_with("/children"));
        if !cacheable {
            return self
                .fetch_fresh(path, offset, limit)
                .await
                .map(|(value, _)| value);
        }
        let key = format!("{offset}:{limit}:{path}");
        if let Some(value) = self.catalog_cache.lock().await.get(&key) {
            return Ok(value);
        }
        let _waiter = self
            .catalog_waiters
            .clone()
            .try_acquire_owned()
            .map_err(|_| "NAS is busy")?;
        let gate = {
            let mut cache = self.catalog_cache.lock().await;
            if let Some(value) = cache.get(&key) {
                return Ok(value);
            }
            // Weak gates disappear when a cancelled or completed request drops its guard.
            // Cancellation cannot leave a permanently occupied in-flight cache entry.
            cache.flights.retain(|_, gate| gate.strong_count() > 0);
            match cache.flights.get(&key).and_then(std::sync::Weak::upgrade) {
                Some(gate) => gate,
                None => {
                    let gate = Arc::new(Mutex::new(()));
                    cache.flights.insert(key.clone(), Arc::downgrade(&gate));
                    gate
                }
            }
        };
        let _single_fetch = gate.lock().await;
        if let Some(value) = self.catalog_cache.lock().await.get(&key) {
            return Ok(value);
        }
        let (value, bytes) = self.fetch_fresh(path, offset, limit).await?;
        self.catalog_cache
            .lock()
            .await
            .insert(key, value.clone(), bytes);
        Ok(value)
    }

    async fn fetch_fresh(
        &self,
        path: &str,
        offset: usize,
        limit: usize,
    ) -> Result<(Arc<Value>, usize), &'static str> {
        let _permit = self
            .metadata
            .clone()
            .try_acquire_owned()
            .map_err(|_| "NAS is busy")?;
        let request = self
            .client
            .get(self.url(path)?)
            .header("X-Plex-Token", self.token.clone())
            .header(header::ACCEPT, "application/json")
            .header("X-Plex-Container-Start", offset)
            .header("X-Plex-Container-Size", limit)
            .timeout(Duration::from_secs(30));
        let response = request.send().await.map_err(|_| "Plex is unavailable")?;
        if !response.status().is_success() {
            return Err("Plex request failed");
        }
        let bytes = bounded(response, MAX_JSON).await?;
        let value = serde_json::from_slice(&bytes).map_err(|_| "Invalid Plex catalog")?;
        Ok((Arc::new(value), bytes.len()))
    }

    fn media_url(&self, origin: &str, path: &str) -> Result<String, &'static str> {
        let mut target = self.url(path)?;
        let pairs: Vec<(String, String)> = target
            .query_pairs()
            .filter(|(key, _)| !key.eq_ignore_ascii_case("X-Plex-Token"))
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        target.set_query(None);
        if !pairs.is_empty() {
            target.query_pairs_mut().extend_pairs(pairs);
        }
        let extension = target
            .path()
            .rsplit('.')
            .next()
            .filter(|extension| {
                extension.len() <= 8
                    && !extension.is_empty()
                    && extension.bytes().all(|c| c.is_ascii_alphanumeric())
            })
            .unwrap_or("bin");
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&Ticket {
                path: relative(&target),
                expires: now() + URL_TTL,
            })
            .map_err(|_| "Cannot sign media URL")?,
        );
        let signature = URL_SAFE_NO_PAD.encode(self.signature(payload.as_bytes()));
        Ok(format!(
            "{origin}/nas/stream/{payload}.{signature}/media.{extension}"
        ))
    }

    fn ticket(&self, signed: &str) -> Result<Ticket, &'static str> {
        if signed.len() > 16384 {
            return Err("Invalid media token");
        }
        let (payload, signature) = signed.split_once('.').ok_or("Invalid media token")?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| "Invalid media token")?;
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("valid HMAC key");
        mac.update(payload.as_bytes());
        mac.verify_slice(&signature)
            .map_err(|_| "Invalid media token")?;
        let ticket: Ticket = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(payload)
                .map_err(|_| "Invalid media token")?,
        )
        .map_err(|_| "Invalid media token")?;
        if ticket.expires < now() {
            return Err("Media token expired; reload the catalog or playlist");
        }
        self.url(&ticket.path)?;
        Ok(ticket)
    }

    fn item(&self, item: &Value, origin: &str) -> Option<Value> {
        let id = numeric_id(item.get("ratingKey")?)?;
        let kind = item["type"].as_str()?;
        let playable = matches!(kind, "movie" | "episode" | "track" | "clip");
        if !playable && !matches!(kind, "show" | "season" | "artist" | "album" | "photoalbum") {
            return None;
        }
        let mut result = json!({
            "type": if playable { "stream" } else { "category" },
            "id": format!("item:{id}"),
            "title": item_title(item),
            "request": {"cmd": if playable { "play" } else { "browse" }, "id":format!("item:{id}")},
            "description":item["summary"].as_str().unwrap_or(""),
        });
        if let Some(year) = item["year"].as_u64() {
            result["year"] = json!(year);
        }
        if let Some(duration) = item["duration"].as_u64() {
            result["duration"] = json!(format!("{} мин", duration / 60000));
        }
        if let Some(thumb) = item["thumb"]
            .as_str()
            .or_else(|| item["parentThumb"].as_str())
            .or_else(|| item["grandparentThumb"].as_str())
        {
            if thumb.starts_with("/library/metadata/") {
                if let Ok(url) = self.media_url(origin, thumb) {
                    result["img"] = json!(url);
                }
            }
        }
        Some(result)
    }

    async fn catalog(&self, request: &CatalogRequest, origin: &str) -> Result<Value, &'static str> {
        let offset = request.offset.unwrap_or(0);
        if offset > MAX_EXPORT_ITEMS {
            return Err("Catalog offset exceeds limit");
        }
        let limit = request.limit.unwrap_or(100).clamp(1, 1000);
        let (path, root) = match request.cmd.as_deref().unwrap_or("") {
            "" => ("/library/sections".to_owned(), true),
            "browse" => {
                let id = request.id.as_deref().ok_or("Missing catalog ID")?;
                if let Some(id) = id.strip_prefix("section:").filter(|id| valid_id(id)) {
                    (format!("/library/sections/{id}/all"), false)
                } else if let Some(id) = id.strip_prefix("item:").filter(|id| valid_id(id)) {
                    (format!("/library/metadata/{id}/children"), false)
                } else {
                    return Err("Invalid catalog ID");
                }
            }
            "search" => {
                let query = request.query.as_deref().unwrap_or("").trim();
                if query.is_empty() || query.len() > 256 {
                    return Err("Search requires 1–256 characters");
                }
                (
                    format!(
                        "/hubs/search?query={}&limit={limit}",
                        urlencoding::encode(query)
                    ),
                    false,
                )
            }
            "play" => {
                return self
                    .play(request.id.as_deref().ok_or("Missing media ID")?, origin)
                    .await
            }
            _ => return Err("Unknown catalog command"),
        };
        // The hubs endpoint paginates hub groups, not the media within those groups.
        // Obtain one bounded, stable hub snapshot and page its flattened items locally.
        let (fetch_offset, fetch_limit) = if request.cmd.as_deref() == Some("search") {
            (0, 1000)
        } else {
            (offset, limit)
        };
        let data = self.fetch(&path, fetch_offset, fetch_limit).await?;
        let container = &data["MediaContainer"];
        let mut items = Vec::new();
        let mut total = container["totalSize"].as_u64().map(|n| n as usize);
        let mut received = 0;
        if root {
            let dirs = array(container, "Directory");
            // Plex has already applied the requested container offset and size.
            received = dirs.len();
            for directory in dirs.iter().take(limit) {
                let Some(id) = directory.get("key").and_then(numeric_id) else {
                    continue;
                };
                items.push(json!({"type":"category", "id":format!("section:{id}"),
                    "title":directory["title"].as_str().unwrap_or("Plex"),
                    "request":{"cmd":"browse", "id":format!("section:{id}")}}));
            }
        } else if request.cmd.as_deref() == Some("search") {
            // Plex's hubs API limits each type independently; flatten then cap to the caller's page.
            // Hubs search is bounded by Plex's explicit limit, never a whole-library scan.
            let mut found: Vec<&Value> = array(container, "Hub")
                .iter()
                .flat_map(|hub| array(hub, "Metadata"))
                .filter(|item| catalog_item(item))
                .collect();
            if found.is_empty() {
                found = array(container, "Metadata")
                    .iter()
                    .filter(|item| catalog_item(item))
                    .collect();
            }
            // Sign thumbnails only for the visible page, not every match in every hub.
            total = Some(found.len());
            items = found
                .into_iter()
                .skip(offset)
                .take(limit)
                .filter_map(|item| self.item(item, origin))
                .collect();
            received = items.len();
        } else {
            for item in array(container, "Metadata") {
                received += 1;
                if let Some(item) = self.item(item, origin) {
                    items.push(item);
                }
            }
        }
        let sequential = array(container, "Metadata")
            .iter()
            .any(|item| matches!(item["type"].as_str(), Some("episode" | "track")));
        let mut result = json!({"type":if root {"videoportal"} else if sequential {"multistream"} else {"category"},
            "title":container["title2"].as_str().or_else(||container["librarySectionTitle"].as_str()).unwrap_or("Synology"),
            "controls":{"search":true}, "items":items});
        if received > 0
            && offset + received <= MAX_EXPORT_ITEMS
            && total
                .map(|total| offset + received < total)
                .unwrap_or(received >= limit)
        {
            let mut next = serde_json::to_value(request).map_err(|_| "Invalid request")?;
            next["offset"] = json!(offset + received);
            next["limit"] = json!(limit);
            next.as_object_mut().unwrap().remove("key");
            result["items"]
                .as_array_mut()
                .unwrap()
                .push(json!({"type":"next", "request":next}));
        }
        Ok(result)
    }

    async fn play(&self, id: &str, origin: &str) -> Result<Value, &'static str> {
        let id = id
            .strip_prefix("item:")
            .filter(|id| valid_id(id))
            .ok_or("Invalid media ID")?;
        let data = self.fetch(&format!("/library/metadata/{id}"), 0, 1).await?;
        let item = array(&data["MediaContainer"], "Metadata")
            .first()
            .ok_or("Media not found")?;
        let mut variants = serde_json::Map::new();
        let mut sessions = serde_json::Map::new();
        let mut original = None;
        let mut compatible = None;
        let mut stop = None;
        let mut heartbeat = None;
        for (media_index, media) in array(item, "Media").iter().take(16).enumerate() {
            for (part_index, part) in array(media, "Part").iter().take(32).enumerate() {
                let Some(path) = part["key"]
                    .as_str()
                    .filter(|path| path.starts_with("/library/parts/"))
                else {
                    continue;
                };
                let url = self.media_url(origin, path)?;
                if original.is_none() {
                    original = Some(url.clone());
                }
                let suffix = if media_index > 0 || part_index > 0 {
                    format!(" · {}.{}", media_index + 1, part_index + 1)
                } else {
                    String::new()
                };
                variants.insert(
                    format!(
                        "Оригинал{} · {} {}",
                        suffix,
                        media["container"].as_str().unwrap_or(""),
                        media["videoCodec"]
                            .as_str()
                            .or_else(|| media["audioCodec"].as_str())
                            .unwrap_or("")
                    ),
                    json!(url),
                );
                if matches!(item["type"].as_str(), Some("movie" | "episode" | "clip")) {
                    let (path, stop_path) = self.transcode_paths(id, media_index, part_index)?;
                    let hls = self.media_url(origin, &path)?;
                    let stop_url = self.media_url(origin, &stop_path)?;
                    let heartbeat_url =
                        self.media_url(origin, &stop_path.replace("/stop?", "/ping?"))?;
                    if compatible.is_none() {
                        compatible = Some(hls.clone());
                        stop = Some(stop_url.clone());
                        heartbeat = Some(heartbeat_url.clone());
                    }
                    sessions.insert(
                        hls.clone(),
                        json!({"stop":stop_url,"heartbeat":heartbeat_url}),
                    );
                    variants.insert(format!("Совместимый HLS{suffix}"), json!(hls));
                }
            }
        }
        Ok(
            json!({"type":"stream", "title":item_title(item), "url":compatible.or(original).ok_or("No playable media file")?, "variants":variants, "stop":stop, "heartbeat":heartbeat, "sessions":sessions}),
        )
    }

    fn transcode_paths(
        &self,
        id: &str,
        media: usize,
        part: usize,
    ) -> Result<(String, String), &'static str> {
        let session = URL_SAFE_NO_PAD.encode(
            self.signature(
                format!(
                    "{id}:{media}:{part}:{}",
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                )
                .as_bytes(),
            ),
        );
        let mut url = self.url("/video/:/transcode/universal/start.m3u8")?;
        url.query_pairs_mut()
            .append_pair("path", &format!("/library/metadata/{id}"))
            .append_pair("mediaIndex", &media.to_string())
            .append_pair("partIndex", &part.to_string())
            .append_pair("protocol", "hls")
            .append_pair("directPlay", "0")
            .append_pair("directStream", "1")
            .append_pair("fastSeek", "1")
            .append_pair("videoQuality", "100")
            .append_pair("maxVideoBitrate", "12000")
            .append_pair("videoResolution", "1920x1080")
            .append_pair("audioBoost", "100")
            .append_pair("session", &session)
            .append_pair("X-Plex-Client-Identifier", &session)
            .append_pair("X-Plex-Product", "OTTPlay")
            .append_pair("X-Plex-Platform", "Chrome");
        Ok((
            relative(&url),
            format!("/video/:/transcode/universal/stop?session={session}"),
        ))
    }

    async fn touch_session(
        &self,
        url: &reqwest::Url,
    ) -> Result<Option<SessionLease>, &'static str> {
        if !url.path().starts_with("/video/:/transcode/") {
            return Ok(None);
        }
        let session = url
            .query_pairs()
            .find(|(key, _)| key == "session")
            .map(|(_, value)| value.into_owned())
            .or_else(|| {
                url.path()
                    .split("/session/")
                    .nth(1)
                    .and_then(|tail| tail.split('/').next())
                    .map(str::to_owned)
            });
        let Some(session) = session else {
            return Ok(None);
        };
        if session.is_empty()
            || session.len() > 128
            || !session
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err("Invalid transcode session");
        }
        if url.path().ends_with("/stop") {
            return Ok(None);
        }
        let starting = url.path() == "/video/:/transcode/universal/start.m3u8";
        let heartbeat = url.path() == "/video/:/transcode/universal/ping";
        let gate = {
            let mut sessions = self.sessions.lock().await;
            if !starting && !sessions.contains_key(&session) {
                return Err("Transcode session is no longer active");
            }
            if !sessions.contains_key(&session) && sessions.len() >= 8 {
                return Err("NAS transcoder is busy; retry later");
            }
            sessions
                .entry(session.clone())
                .or_insert_with(|| TranscodeSession::new(Instant::now()))
                .gate
                .clone()
        };
        // Serialize cleanup only with requests for this particular session. A slow
        // Plex stop must never hold the global registry lock or block other players.
        let guard = if heartbeat {
            gate.clone()
                .try_read_owned()
                .map_err(|_| "Transcode session is no longer active")?
        } else {
            gate.clone().read_owned().await
        };
        let mut sessions = self.sessions.lock().await;
        if let Some(current) = sessions.get_mut(&session) {
            if !Arc::ptr_eq(&current.gate, &gate) {
                return Err("Transcode session changed; retry playback");
            }
            current.seen = Instant::now();
        } else if starting && sessions.len() < 8 {
            sessions.insert(
                session.clone(),
                TranscodeSession {
                    seen: Instant::now(),
                    gate: gate.clone(),
                },
            );
        } else {
            return Err("Transcode session is no longer active");
        }
        Ok(Some(SessionLease {
            session,
            gate,
            _guard: guard,
        }))
    }

    async fn failed_start(&self, lease: Option<&SessionLease>) {
        // A transport failure can occur after Plex starts converting. Preserve a
        // cleanup obligation, but never expire a newer generation of the session.
        if let Some(lease) = lease {
            if let Some(current) = self.sessions.lock().await.get_mut(&lease.session) {
                if Arc::ptr_eq(&current.gate, &lease.gate) {
                    current.seen = Instant::now() - Duration::from_secs(181);
                }
            }
        }
    }

    async fn reap_sessions(&self) {
        let expired: Vec<(String, Instant, Arc<RwLock<()>>)> = self
            .sessions
            .lock()
            .await
            .iter()
            .filter(|(_, entry)| entry.seen.elapsed() > Duration::from_secs(180))
            .map(|(session, entry)| (session.clone(), entry.seen, entry.gate.clone()))
            .collect();
        futures_util::stream::iter(expired)
            .for_each_concurrent(4, |(session, seen, gate)| async move {
                self.stop_expired(&session, seen, gate).await;
            })
            .await;
    }

    async fn stop_expired(&self, session: &str, seen: Instant, gate: Arc<RwLock<()>>) {
        let Ok(_session) = gate.try_write() else {
            return;
        };
        {
            let sessions = self.sessions.lock().await;
            if !sessions
                .get(session)
                .is_some_and(|current| current.seen == seen && Arc::ptr_eq(&current.gate, &gate))
            {
                return;
            }
        }
        if let Ok(url) = self.url(&format!(
            "/video/:/transcode/universal/stop?session={session}"
        )) {
            if self
                .client
                .get(url)
                .header("X-Plex-Token", self.token.clone())
                .timeout(Duration::from_secs(5))
                .send()
                .await
                .is_ok_and(|response| stopped(response.status()))
            {
                let mut sessions = self.sessions.lock().await;
                if sessions.get(session).is_some_and(|current| {
                    current.seen == seen && Arc::ptr_eq(&current.gate, &gate)
                }) {
                    sessions.remove(session);
                }
            }
        }
    }

    fn rewrite_hls(&self, source: &str, path: &str, origin: &str) -> Result<String, &'static str> {
        let base = self.url(path)?;
        let mut output = String::with_capacity(source.len() * 2);
        for line in source.lines() {
            let line = line.trim_end_matches('\r');
            if line.starts_with('#') {
                let mut last = 0;
                for capture in HLS_URI_REGEX.captures_iter(line) {
                    let value = capture.get(1).unwrap();
                    output.push_str(&line[last..value.start()]);
                    output.push_str(&self.hls_child(&base, value.as_str(), origin)?);
                    last = value.end();
                }
                output.push_str(&line[last..]);
            } else if !line.trim().is_empty() {
                output.push_str(&self.hls_child(&base, line.trim(), origin)?);
            }
            output.push('\n');
            if output.len() > 8 * MAX_PLAYLIST {
                return Err("HLS playlist exceeds limit");
            }
        }
        if self
            .token
            .to_str()
            .is_ok_and(|token| output.contains(token))
            || output.contains(self.upstream.as_str())
        {
            return Err("Invalid HLS playlist metadata");
        }
        Ok(output)
    }

    fn hls_child(
        &self,
        base: &reqwest::Url,
        reference: &str,
        origin: &str,
    ) -> Result<String, &'static str> {
        let mut target = base
            .join(reference)
            .map_err(|_| "Invalid HLS media reference")?;
        if target.origin() != self.upstream.origin()
            || !target.username().is_empty()
            || target.password().is_some()
            || !(target.path().starts_with("/video/:/transcode/")
                || target.path().starts_with("/library/parts/"))
        {
            return Err("HLS media reference is not allowed");
        }
        // Authentication is always injected as a header at the gateway.
        let pairs: Vec<(String, String)> = target
            .query_pairs()
            .filter(|(key, _)| !key.eq_ignore_ascii_case("X-Plex-Token"))
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        target.set_query(None);
        if !pairs.is_empty() {
            target.query_pairs_mut().extend_pairs(pairs);
        }
        target.set_fragment(None);
        self.media_url(origin, &relative(&target))
    }
}

fn routes(library: Library) -> Router {
    let library = Arc::new(library);
    let weak = Arc::downgrade(&library);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let Some(library) = weak.upgrade() else { break };
            library.reap_sessions().await;
        }
    });
    let media_cors = tower_http::cors::CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([Method::GET, Method::HEAD])
        .allow_headers([header::RANGE, header::IF_RANGE])
        .expose_headers([
            header::CONTENT_LENGTH,
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
        ]);
    let portable = Router::new()
        .route("/nas/stream/:ticket", get(stream))
        .route("/nas/stream/:ticket/:filename", get(stream))
        .route("/nas/playlist.m3u", get(playlist))
        .layer(media_cors);
    Router::new()
        .route("/nas/config", get(config))
        .route("/nas/api", post(api))
        .merge(portable)
        .layer(DefaultBodyLimit::max(16 * 1024))
        .with_state(library)
}

#[derive(Debug, Serialize, Deserialize)]
struct Ticket {
    path: String,
    expires: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct CatalogRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cmd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    offset: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    limit: Option<usize>,
}

fn stopped(status: StatusCode) -> bool {
    status.is_success() || matches!(status, StatusCode::NOT_FOUND | StatusCode::GONE)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 20 && id.bytes().all(|c| c.is_ascii_digit())
}
fn catalog_item(item: &Value) -> bool {
    let valid = item
        .get("ratingKey")
        .is_some_and(|id| id.as_str().is_some_and(valid_id) || id.as_u64().is_some());
    valid
        && matches!(
            item["type"].as_str(),
            Some(
                "movie"
                    | "episode"
                    | "track"
                    | "clip"
                    | "show"
                    | "season"
                    | "artist"
                    | "album"
                    | "photoalbum"
            )
        )
}
fn numeric_id(value: &Value) -> Option<String> {
    let id = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_u64().map(|n| n.to_string()))?;
    valid_id(&id).then_some(id)
}
fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn relative(url: &reqwest::Url) -> String {
    format!(
        "{}{}",
        url.path(),
        url.query().map(|q| format!("?{q}")).unwrap_or_default()
    )
}
fn item_title(item: &Value) -> String {
    let title = item["title"].as_str().unwrap_or("Plex");
    match item["type"].as_str() {
        Some("episode") => format!(
            "{} · S{:02}E{:02} · {title}",
            item["grandparentTitle"].as_str().unwrap_or(""),
            item["parentIndex"].as_u64().unwrap_or(0),
            item["index"].as_u64().unwrap_or(0)
        ),
        Some("track") => format!(
            "{} · {title}",
            item["grandparentTitle"].as_str().unwrap_or("")
        ),
        _ => title.to_owned(),
    }
}
fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}
fn error(status: StatusCode, message: &str) -> Response {
    no_store((status, Json(json!({"type":"error", "error":message}))).into_response())
}

fn origin(headers: &HeaderMap, scheme: &str) -> Result<String, &'static str> {
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing player Host")?;
    let url =
        reqwest::Url::parse(&format!("{scheme}://{host}/")).map_err(|_| "Invalid player Host")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid player Host");
    }
    Ok(url.origin().ascii_serialization())
}
fn local_host(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    host.parse::<std::net::IpAddr>().is_ok_and(local_ip)
}

fn local_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        std::net::IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(|ip| local_ip(ip.into()))
            .unwrap_or_else(|| {
                ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
            }),
    }
}

fn same_origin(headers: &HeaderMap, expected: &str) -> bool {
    if headers
        .get("sec-fetch-site")
        .is_some_and(|value| value != "same-origin")
    {
        return false;
    }
    headers
        .get(header::ORIGIN)
        .or_else(|| headers.get(header::REFERER))
        .and_then(|v| v.to_str().ok())
        .and_then(|v| reqwest::Url::parse(v).ok())
        .is_some_and(|url| url.origin().ascii_serialization() == expected)
}

async fn config(State(library): State<Arc<Library>>) -> Response {
    no_store(Json(json!({"enabled":true,"title":"Synology","api":"/nas/api", "playlist":"/nas/playlist.m3u",
        "sourceId":format!("synology:{}", URL_SAFE_NO_PAD.encode(&library.signature(b"OTTPlay NAS source identity")[..12]))})).into_response())
}

async fn api(
    State(library): State<Arc<Library>>,
    Extension(crate::msx::Scheme(scheme)): Extension<crate::msx::Scheme>,
    peer: Option<Extension<axum::extract::ConnectInfo<std::net::SocketAddr>>>,
    headers: HeaderMap,
    Json(request): Json<CatalogRequest>,
) -> Response {
    let origin = match origin(&headers, scheme) {
        Ok(origin) => origin,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    if !request
        .key
        .as_deref()
        .is_some_and(|key| library.accepts_key(key))
        && !library.accepts_browser(
            &headers,
            &origin,
            peer.map(|Extension(axum::extract::ConnectInfo(peer))| peer),
        )
    {
        return error(
            StatusCode::UNAUTHORIZED,
            "NAS access key or same-origin player required",
        );
    }
    if request.app.as_deref() != Some("ott-play") {
        return error(StatusCode::BAD_REQUEST, "Invalid VPortal application");
    }
    match library.catalog(&request, &origin).await {
        Ok(catalog) => no_store(Json(catalog).into_response()),
        Err(message) => error(
            if matches!(message, "NAS is busy") {
                StatusCode::SERVICE_UNAVAILABLE
            } else if message.starts_with("Plex") || message.starts_with("Invalid Plex") {
                StatusCode::BAD_GATEWAY
            } else {
                StatusCode::BAD_REQUEST
            },
            message,
        ),
    }
}

async fn bounded(mut response: reqwest::Response, maximum: usize) -> Result<Vec<u8>, &'static str> {
    if response
        .content_length()
        .is_some_and(|len| len > maximum as u64)
    {
        return Err("Plex response exceeds limit");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Plex response failed")? {
        if bytes.len() + chunk.len() > maximum {
            return Err("Plex response exceeds limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn valid_range(value: &str) -> bool {
    if value.len() > 128 {
        return false;
    }
    let Some(bytes) = value.strip_prefix("bytes=") else {
        return false;
    };
    let Some((start, end)) = bytes.split_once('-') else {
        return false;
    };
    if start.is_empty() && end.is_empty() {
        return false;
    }
    let number = |s: &str| {
        s.is_empty() || (s.bytes().all(|c| c.is_ascii_digit()) && s.parse::<u64>().is_ok())
    };
    number(start)
        && number(end)
        && (start.is_empty()
            || end.is_empty()
            || start.parse::<u64>().unwrap() <= end.parse::<u64>().unwrap())
}

async fn stream(
    State(library): State<Arc<Library>>,
    Extension(crate::msx::Scheme(scheme)): Extension<crate::msx::Scheme>,
    Path(parameters): Path<HashMap<String, String>>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let signed = parameters
        .get("ticket")
        .map(String::as_str)
        .unwrap_or_default();
    let ticket = match library.ticket(signed) {
        Ok(ticket) => ticket,
        Err(message) => return error(StatusCode::UNAUTHORIZED, message),
    };
    let origin = match origin(&headers, scheme) {
        Ok(origin) => origin,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    let permit = match library.streams.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return error(StatusCode::SERVICE_UNAVAILABLE, "NAS streams are busy"),
    };
    let url = match library.url(&ticket.path) {
        Ok(url) => url,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    let session_guard = match library.touch_session(&url).await {
        Ok(guard) => guard,
        Err(message) => {
            return error(
                if message == "Transcode session is no longer active" {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                },
                message,
            )
        }
    };
    let heartbeat = if url.path() == "/video/:/transcode/universal/ping" {
        url.query_pairs()
            .find(|(key, _)| key == "session")
            .map(|(_, value)| value.into_owned())
    } else {
        None
    };
    let starting = if url.path() == "/video/:/transcode/universal/start.m3u8" {
        url.query_pairs()
            .find(|(key, _)| key == "session")
            .map(|(_, value)| value.into_owned())
    } else {
        None
    };
    let starting_lease = if starting.is_some() {
        session_guard.as_ref()
    } else {
        None
    };
    // Plex requires a conversion decision for this exact client/session before starting HLS.
    // Without it the NAS can return 400 even for media it can successfully transcode.
    if url.path() == "/video/:/transcode/universal/start.m3u8" {
        let mut decision = url.clone();
        decision.set_path("/video/:/transcode/universal/decision");
        match library.fetch(&relative(&decision), 0, 1).await {
            Ok(result) => {
                if result["MediaContainer"]["transcodeDecisionCode"]
                    .as_i64()
                    .is_some_and(|code| code >= 2000)
                {
                    library.failed_start(starting_lease).await;
                    return error(StatusCode::BAD_GATEWAY, "Plex cannot convert this media");
                }
            }
            Err(message) => {
                library.failed_start(starting_lease).await;
                return error(StatusCode::BAD_GATEWAY, message);
            }
        }
    }
    let stopping = if url.path() == "/video/:/transcode/universal/stop" {
        url.query_pairs()
            .find(|(key, _)| key == "session")
            .map(|(_, value)| value.into_owned())
    } else {
        None
    };
    let stopping_generation = if let Some(session) = stopping.as_ref() {
        library
            .sessions
            .lock()
            .await
            .get(session)
            .map(|current| current.gate.clone())
    } else {
        None
    };
    let mut request = library
        .client
        .request(method.clone(), url)
        .header("X-Plex-Token", library.token.clone())
        .header(header::ACCEPT_ENCODING, "identity");
    for name in [header::RANGE, header::IF_RANGE] {
        if let Some(value) = headers.get(&name) {
            if value.len() > 256
                || (name == header::RANGE && !value.to_str().is_ok_and(valid_range))
            {
                return error(StatusCode::RANGE_NOT_SATISFIABLE, "Invalid media range");
            }
            request = request.header(name, value);
        }
    }
    let upstream = match request.send().await {
        Ok(upstream) => upstream,
        Err(_) => {
            library.failed_start(starting_lease).await;
            return error(StatusCode::BAD_GATEWAY, "Plex media unavailable");
        }
    };
    let status = upstream.status();
    if matches!(status, StatusCode::NOT_FOUND | StatusCode::GONE) {
        if let Some(session) = heartbeat {
            let mut sessions = library.sessions.lock().await;
            if session_guard.as_ref().is_some_and(|lease| {
                sessions
                    .get(&session)
                    .is_some_and(|current| Arc::ptr_eq(&current.gate, &lease.gate))
            }) {
                sessions.remove(&session);
            }
        }
    }
    if !status.is_success() {
        library.failed_start(starting_lease).await;
    }
    if let Some(session) = stopping {
        if stopped(status) {
            let mut sessions = library.sessions.lock().await;
            if stopping_generation.as_ref().is_some_and(|gate| {
                sessions
                    .get(&session)
                    .is_some_and(|current| Arc::ptr_eq(&current.gate, gate))
            }) {
                sessions.remove(&session);
            }
        }
        if matches!(status, StatusCode::NOT_FOUND | StatusCode::GONE) {
            return no_store(StatusCode::NO_CONTENT.into_response());
        }
    }
    if status.is_redirection()
        || status.is_server_error()
        || matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
    {
        return error(StatusCode::BAD_GATEWAY, "Plex media request failed");
    }
    if status.is_client_error() {
        let mut response = error(status, "Plex media is unavailable");
        if status == StatusCode::RANGE_NOT_SATISFIABLE {
            if let Some(value) = upstream.headers().get(header::CONTENT_RANGE) {
                response
                    .headers_mut()
                    .insert(header::CONTENT_RANGE, value.clone());
            }
        }
        return response;
    }
    let is_hls = ticket
        .path
        .split('?')
        .next()
        .is_some_and(|path| path.ends_with(".m3u8"))
        || upstream
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|mime| mime.contains("mpegurl") || mime.contains("m3u8"));
    let mut response_headers = HeaderMap::new();
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::ETAG,
        header::LAST_MODIFIED,
    ] {
        if let Some(value) = upstream.headers().get(&name) {
            response_headers.insert(name, value.clone());
        }
    }
    response_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response_headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if method == Method::HEAD {
        return (status, response_headers, Body::empty()).into_response();
    }
    if is_hls && status.is_success() {
        let result = bounded(upstream, MAX_PLAYLIST)
            .await
            .and_then(|bytes| String::from_utf8(bytes).map_err(|_| "Invalid HLS playlist"))
            .and_then(|source| library.rewrite_hls(&source, &ticket.path, &origin));
        return match result {
            Ok(playlist) => {
                response_headers.remove(header::CONTENT_LENGTH);
                response_headers.remove(header::ETAG);
                response_headers.insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/vnd.apple.mpegurl"),
                );
                (status, response_headers, playlist).into_response()
            }
            Err(message) => error(StatusCode::BAD_GATEWAY, message),
        };
    }
    let body = async_stream::try_stream! {
        let _permit = permit;
        let _session_guard = session_guard;
        let mut chunks = upstream.bytes_stream();
        while let Some(chunk) = chunks.next().await { yield chunk?; }
        if let Some(lease) = _session_guard.as_ref() {
            let mut sessions = library.sessions.lock().await;
            if let Some(current) = sessions.get_mut(&lease.session) {
                if Arc::ptr_eq(&current.gate,&lease.gate) { current.seen = Instant::now(); }
            }
        }
    };
    (
        status,
        response_headers,
        Body::from_stream(body.map(|part: Result<Bytes, reqwest::Error>| part)),
    )
        .into_response()
}

#[derive(Deserialize)]
struct PlaylistQuery {
    key: Option<String>,
    section: Option<String>,
    mode: Option<String>,
    limit: Option<usize>,
}

async fn playlist(
    State(library): State<Arc<Library>>,
    Extension(crate::msx::Scheme(scheme)): Extension<crate::msx::Scheme>,
    peer: Option<Extension<axum::extract::ConnectInfo<std::net::SocketAddr>>>,
    headers: HeaderMap,
    Query(query): Query<PlaylistQuery>,
) -> Response {
    let origin = match origin(&headers, scheme) {
        Ok(origin) => origin,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    if !query
        .key
        .as_deref()
        .is_some_and(|key| library.accepts_key(key))
        && !library.accepts_browser(
            &headers,
            &origin,
            peer.map(|Extension(axum::extract::ConnectInfo(peer))| peer),
        )
    {
        return error(
            StatusCode::UNAUTHORIZED,
            "NAS access key or same-origin player required",
        );
    }
    if query
        .section
        .as_ref()
        .is_some_and(|section| !valid_id(section))
    {
        return error(StatusCode::BAD_REQUEST, "Invalid library ID");
    }
    if query
        .mode
        .as_deref()
        .is_some_and(|mode| mode != "original" && mode != "compatible")
    {
        return error(StatusCode::BAD_REQUEST, "Invalid playlist mode");
    }
    let compatible = query.mode.as_deref() != Some("original");
    let maximum = query
        .limit
        .unwrap_or(MAX_EXPORT_ITEMS)
        .clamp(1, MAX_EXPORT_ITEMS);
    let data = match library.fetch("/library/sections", 0, 1000).await {
        Ok(data) => data,
        Err(message) => return error(StatusCode::BAD_GATEWAY, message),
    };
    let mut sections = Vec::new();
    for directory in array(&data["MediaContainer"], "Directory") {
        let Some(id) = directory.get("key").and_then(numeric_id) else {
            continue;
        };
        if query.section.as_ref().is_some_and(|wanted| wanted != &id) {
            continue;
        }
        let media_type = match directory["type"].as_str() {
            Some("movie") => 1,
            Some("show") => 4,
            Some("artist") => 10,
            _ => continue,
        };
        sections.push((
            id,
            media_type,
            m3u_text(directory["title"].as_str().unwrap_or("Plex")),
        ));
    }
    let body = async_stream::try_stream! {
        yield Bytes::from_static(b"#EXTM3U\n# Signed media URLs last seven days; refresh this playlist to renew them.\n");
        let mut exported = 0usize;
        for (id,media_type,title) in sections {
            let mut offset = 0usize;
            loop {
                let data = library.fetch(&format!("/library/sections/{id}/all?type={media_type}"),offset,250).await
                    .map_err(std::io::Error::other)?;
                let container = &data["MediaContainer"];
                let items = array(container,"Metadata");
                if items.is_empty() { break; }
                let mut page = String::new();
                for item in items {
                    for media in array(item,"Media").iter().take(1) {
                        for (index,part) in array(media,"Part").iter().take(32).enumerate() {
                            let Some(path) = part["key"].as_str().filter(|path|path.starts_with("/library/parts/")) else {continue};
                            let transcode;
                            let path = if compatible && media_type != 10 {
                                let Some(id) = item.get("ratingKey").and_then(numeric_id) else { continue };
                                transcode = library.transcode_paths(&id,0,index).map_err(std::io::Error::other)?.0;
                                transcode.as_str()
                            } else { path };
                            let url = library.media_url(&origin,path).map_err(std::io::Error::other)?;
                            let name = m3u_text(&item_title(item));
                            let suffix = if index > 0 {format!(" · часть {}",index + 1)} else {String::new()};
                            page.push_str(&format!("#EXTINF:-1 group-title=\"{title}\",{name}{suffix}\n{url}\n"));
                            exported += 1;
                            if exported >= maximum { break; }
                        }
                    }
                    if exported >= maximum { break; }
                }
                yield Bytes::from(page);
                offset += items.len();
                if exported >= maximum || container["totalSize"].as_u64().map(|total|offset >= total as usize).unwrap_or(items.len() < 250) { break; }
                if offset >= MAX_EXPORT_ITEMS { break; }
            }
            if exported >= maximum { break; }
        }
    };
    (
        [
            (header::CONTENT_TYPE, "audio/x-mpegurl; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (
                header::CONTENT_DISPOSITION,
                "inline; filename=\"synology.m3u\"",
            ),
        ],
        Body::from_stream(body.map(|part: Result<Bytes, std::io::Error>| part)),
    )
        .into_response()
}
fn m3u_text(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .map(|c| if c == '"' { '\'' } else { c })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::to_bytes,
        http::{Request, Uri},
    };
    use std::collections::HashSet;
    use tower::ServiceExt;

    const KEY: &str = "0123456789abcdef0123456789abcdef";
    const TOKEN: &str = "private-plex-token-fixture";
    const PLAYER: &str = "http://localhost:3000";

    fn movie(id: usize) -> Value {
        json!({"ratingKey":id.to_string(),"type":"movie","title":format!("Movie {id}"),"year":2026,
            "summary":"A film", "thumb":format!("/library/metadata/{id}/thumb/1"),
            "Media":[{"container":"mkv","videoCodec":"h264","Part":[{"key":format!("/library/parts/{id}/file.mkv")}]}]})
    }

    async fn upstream(
        State(decisions): State<Arc<Mutex<HashSet<String>>>>,
        uri: Uri,
        method: Method,
        headers: HeaderMap,
    ) -> Response {
        assert_eq!(headers["X-Plex-Token"], TOKEN);
        assert!(!headers.contains_key(header::COOKIE));
        match uri.path() {
            "/library/sections" => {
                let offset: usize = headers["X-Plex-Container-Start"].to_str().unwrap().parse().unwrap();
                let limit: usize = headers["X-Plex-Container-Size"].to_str().unwrap().parse().unwrap();
                let sections = vec![json!({"key":"1","title":"Movies","type":"movie"}),
                    json!({"key":"2","title":"Music","type":"artist"}),
                    json!({"key":"3","title":"Series","type":"show"})];
                let total = sections.len();
                let page: Vec<Value> = sections.into_iter().skip(offset).take(limit).collect();
                Json(json!({"MediaContainer":{"totalSize":total,"offset":offset,"Directory":page}})).into_response()
            }
            "/library/sections/1/all" => {
                let offset: usize = headers["X-Plex-Container-Start"].to_str().unwrap().parse().unwrap();
                let limit: usize = headers["X-Plex-Container-Size"].to_str().unwrap().parse().unwrap();
                assert!(limit <= 1000);
                let items: Vec<Value> = (1..=3).skip(offset).take(limit).map(movie).collect();
                Json(json!({"MediaContainer":{"title2":"Movies","totalSize":3,"Metadata":items}})).into_response()
            }
            "/library/metadata/10/children" => Json(json!({"MediaContainer":{"title2":"Album","totalSize":1,"Metadata":[
                {"ratingKey":"20","type":"track","title":"Song","grandparentTitle":"Artist","duration":120000}
            ]}})).into_response(),
            "/library/metadata/1" => Json(json!({"MediaContainer":{"Metadata":[movie(1)]}})).into_response(),
            "/library/metadata/2" => {
                let mut item = movie(2);
                item["Media"].as_array_mut().unwrap().push(json!({"container":"avi","videoCodec":"mpeg4","Part":[{"key":"/library/parts/2/alternate.avi"}]}));
                Json(json!({"MediaContainer":{"Metadata":[item]}})).into_response()
            }
            "/hubs/search" => {
                assert!(uri.query().unwrap().contains("query=Movie"));
                let offset: usize = headers["X-Plex-Container-Start"].to_str().unwrap().parse().unwrap();
                let limit: usize = headers["X-Plex-Container-Size"].to_str().unwrap().parse().unwrap();
                let per_hub: usize = uri.query().unwrap().split('&').find_map(|pair|pair.strip_prefix("limit=")).unwrap().parse().unwrap();
                let hubs: Vec<Value> = (0..3).skip(offset).take(limit).map(|hub| {
                    let items: Vec<Value> = ((hub*2+1)..=(hub*2+2)).take(per_hub).map(movie).collect();
                    json!({"Metadata":items})
                }).collect();
                Json(json!({"MediaContainer":{"totalSize":3,"Hub":hubs}})).into_response()
            }
            "/library/parts/1/file.mkv" => {
                if let Some(range) = headers.get(header::RANGE) {
                    assert_eq!(range,"bytes=2-5");
                    (StatusCode::PARTIAL_CONTENT,[(header::CONTENT_TYPE,"video/x-matroska"),(header::CONTENT_RANGE,"bytes 2-5/10"),(header::ACCEPT_RANGES,"bytes")],"2345").into_response()
                } else if method == Method::HEAD {
                    ([(header::CONTENT_LENGTH,"10"),(header::ACCEPT_RANGES,"bytes")],Body::empty()).into_response()
                } else { ([(header::CONTENT_TYPE,"video/x-matroska")],"0123456789").into_response() }
            }
            "/video/:/transcode/universal/decision" => {
                if uri.query().unwrap_or_default().contains("faildecision") { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
                decisions.lock().await.insert(uri.query().unwrap_or_default().to_owned());
                Json(json!({"MediaContainer":{"generalDecisionCode":1001,"transcodeDecisionCode":1001}})).into_response()
            }
            "/video/:/transcode/universal/start.m3u8" => {
                if uri.query().unwrap_or_default().contains("failstart") { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
                assert!(decisions.lock().await.contains(uri.query().unwrap_or_default()), "HLS must negotiate the same query and session first");
                ([(header::CONTENT_TYPE,"application/vnd.apple.mpegurl")],
                "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000\nsession/demo/base/index.m3u8?X-Plex-Token=private-plex-token-fixture\n").into_response()
            }
            "/video/:/transcode/universal/session/demo/base/index.m3u8" => ([(header::CONTENT_TYPE,"application/vnd.apple.mpegurl")],
                "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:5,\nsegment.ts\n").into_response(),
            "/video/:/transcode/universal/session/demo/base/segment.ts" => ([(header::CONTENT_TYPE,"video/mp2t")],vec![0x47u8;188]).into_response(),
            "/video/:/transcode/universal/ping" => {
                if uri.query().unwrap_or_default().contains("gone") {StatusCode::NOT_FOUND.into_response()}
                else {StatusCode::OK.into_response()}
            }
            "/video/:/transcode/universal/stop" => {
                let query = uri.query().unwrap_or_default();
                if query.contains("gone410") { StatusCode::GONE.into_response() }
                else if query.contains("gone") { StatusCode::NOT_FOUND.into_response() }
                else if query.contains("retry") { StatusCode::INTERNAL_SERVER_ERROR.into_response() }
                else { StatusCode::OK.into_response() }
            },
            "/redirect" => (StatusCode::TEMPORARY_REDIRECT,[(header::LOCATION,"http://elsewhere.test/private")]).into_response(),
            _=>StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn fixture() -> (Library, Router, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .fallback(upstream)
                    .with_state(Arc::new(Mutex::new(HashSet::<String>::new()))),
            )
            .await
            .unwrap();
        });
        let library = Library::new(&format!("http://{address}"), TOKEN, KEY).unwrap();
        let app = routes(library.clone())
            .layer(Extension(crate::msx::Scheme("http")))
            .layer(Extension(axum::extract::ConnectInfo(
                "127.0.0.1:10000".parse::<std::net::SocketAddr>().unwrap(),
            )));
        (library, app, task)
    }

    async fn request(
        app: &Router,
        method: &str,
        path: &str,
        body: Value,
        origin: Option<&str>,
        range: Option<&str>,
    ) -> Response {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, "localhost:3000")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        app.clone()
            .oneshot(
                request
                    .body(if method == "POST" {
                        Body::from(body.to_string())
                    } else {
                        Body::empty()
                    })
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    async fn json_body(response: Response) -> Value {
        assert_eq!(response.status(), StatusCode::OK);
        serde_json::from_slice(&to_bytes(response.into_body(), MAX_JSON).await.unwrap()).unwrap()
    }
    fn path(url: &str) -> String {
        let url = reqwest::Url::parse(url).unwrap();
        relative(&url)
    }

    #[test]
    fn validates_configuration_signatures_expiry_and_traversal() {
        for url in [
            "file:///tmp/a",
            "http://user:pass@nas/",
            "http://nas/prefix",
            "http://nas/?token=x",
            "http://nas/#x",
        ] {
            assert!(Library::new(url, TOKEN, KEY).is_err());
        }
        assert!(Library::new("http://nas", TOKEN, "short").is_err());
        let library = Library::new("http://nas:32400", TOKEN, KEY).unwrap();
        assert!(library.accepts_key(KEY));
        assert!(!library.accepts_key("wrong"));
        for path in [
            "http://evil.test/",
            "//evil.test/a",
            "/a/../private",
            "/a/%2e%2e/private",
            "/a\\b",
        ] {
            assert!(library.url(path).is_err(), "{path}");
        }
        let signed = library
            .media_url(PLAYER, "/library/parts/1/file.mkv")
            .unwrap();
        assert!(!signed.contains(TOKEN));
        let token = signed.split('/').nth(5).unwrap();
        assert!(signed.ends_with("/media.mkv"));
        assert_eq!(
            library.ticket(token).unwrap().path,
            "/library/parts/1/file.mkv"
        );
        let mut corrupted = token.as_bytes().to_vec();
        corrupted[4] = if corrupted[4] == b'a' { b'b' } else { b'a' };
        assert!(library
            .ticket(std::str::from_utf8(&corrupted).unwrap())
            .is_err());
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&Ticket {
                path: "/library/parts/1/file.mkv".into(),
                expires: now() - 1,
            })
            .unwrap(),
        );
        let signed = format!(
            "{}.{}",
            payload,
            URL_SAFE_NO_PAD.encode(library.signature(payload.as_bytes()))
        );
        assert!(library.ticket(&signed).unwrap_err().contains("expired"));
    }

    #[tokio::test]
    async fn catalog_auth_hierarchy_search_paging_and_lazy_play() {
        let (_library, app, task) = fixture().await;
        let config =
            json_body(request(&app, "GET", "/nas/config", json!(null), None, None).await).await;
        assert_eq!(config["enabled"], true);
        assert!(config["sourceId"]
            .as_str()
            .unwrap()
            .starts_with("synology:"));
        assert!(!config.to_string().contains(KEY));
        assert!(!config.to_string().contains(TOKEN));
        for origin in [
            None,
            Some("https://localhost:3000"),
            Some("http://evil.test"),
        ] {
            assert_eq!(
                request(
                    &app,
                    "POST",
                    "/nas/api",
                    json!({"app":"ott-play"}),
                    origin,
                    None
                )
                .await
                .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        let root = json_body(
            request(
                &app,
                "POST",
                "/nas/api",
                json!({"app":"ott-play"}),
                Some(PLAYER),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(root["type"], "videoportal");
        assert_eq!(root["items"][0]["request"]["id"], "section:1");
        let catalog = json_body(
            request(
                &app,
                "POST",
                "/nas/api",
                json!({"app":"ott-play","key":KEY,"cmd":"browse","id":"section:1","limit":1}),
                None,
                None,
            )
            .await,
        )
        .await;
        assert_eq!(catalog["items"][0]["request"]["cmd"], "play");
        assert_eq!(catalog["items"][1]["type"], "next");
        assert_eq!(catalog["items"][1]["request"]["offset"], 1);
        assert!(catalog["items"][1]["request"].get("key").is_none());
        let tracks = json_body(
            request(
                &app,
                "POST",
                "/nas/api",
                json!({"app":"ott-play","cmd":"browse","id":"item:10"}),
                Some(PLAYER),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(tracks["type"], "multistream");
        assert_eq!(tracks["items"][0]["title"], "Artist · Song");
        let search = json_body(
            request(
                &app,
                "POST",
                "/nas/api",
                json!({"app":"ott-play","cmd":"search","query":"Movie"}),
                Some(PLAYER),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(search["items"][0]["title"], "Movie 1");
        let play = json_body(
            request(
                &app,
                "POST",
                "/nas/api",
                json!({"app":"ott-play","cmd":"play","id":"item:1"}),
                Some(PLAYER),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(play["variants"].as_object().unwrap().len(), 2);
        assert!(play["url"].as_str().unwrap().ends_with("/media.m3u8"));
        assert_eq!(play["url"], play["variants"]["Совместимый HLS"]);
        assert!(play["stop"].as_str().unwrap().starts_with(PLAYER));
        assert!(!play.to_string().contains(TOKEN));
        for id in ["item:../1", "http://evil.test", "section:1/../../"] {
            assert_eq!(
                request(
                    &app,
                    "POST",
                    "/nas/api",
                    json!({"app":"ott-play","cmd":"browse","id":id}),
                    Some(PLAYER),
                    None
                )
                .await
                .status(),
                StatusCode::BAD_REQUEST
            );
        }
        task.abort();
    }

    #[tokio::test]
    async fn range_head_hls_rewrite_and_signed_media_auth() {
        let (library, app, task) = fixture().await;
        let url = library
            .media_url(PLAYER, "/library/parts/1/file.mkv")
            .unwrap();
        let response = request(
            &app,
            "GET",
            &path(&url),
            json!(null),
            None,
            Some("bytes=2-5"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert!(!response.headers().contains_key("X-Plex-Token"));
        assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap(), "2345");
        let head = request(&app, "HEAD", &path(&url), json!(null), None, None).await;
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "10");
        assert!(to_bytes(head.into_body(), 1024).await.unwrap().is_empty());
        assert_eq!(
            request(
                &app,
                "GET",
                &path(&url),
                json!(null),
                None,
                Some("bytes=9-2")
            )
            .await
            .status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
        assert_eq!(
            request(
                &app,
                "GET",
                "/nas/stream/forged.signature",
                json!(null),
                None,
                None
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        let hls = library
            .media_url(
                PLAYER,
                "/video/:/transcode/universal/start.m3u8?session=demo",
            )
            .unwrap();
        let response = request(&app, "GET", &path(&hls), json!(null), None, None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let master = String::from_utf8(
            to_bytes(response.into_body(), MAX_PLAYLIST)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(!master.contains(TOKEN));
        assert!(!master.contains(library.upstream.as_str()));
        let nested = master
            .lines()
            .find(|line| line.starts_with("http"))
            .unwrap();
        let response = request(&app, "GET", &path(nested), json!(null), None, None).await;
        let media = String::from_utf8(
            to_bytes(response.into_body(), MAX_PLAYLIST)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(media.contains("URI=\"http://localhost:3000/nas/stream/"));
        let segment = media.lines().find(|line| line.starts_with("http")).unwrap();
        let response = request(&app, "GET", &path(segment), json!(null), None, None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
            &[0x47u8; 188]
        );
        let redirect = library.media_url(PLAYER, "/redirect").unwrap();
        assert_eq!(
            request(&app, "GET", &path(&redirect), json!(null), None, None)
                .await
                .status(),
            StatusCode::BAD_GATEWAY
        );
        task.abort();
    }

    #[test]
    fn rejects_off_origin_hls_key_and_segment_references() {
        let library = Library::new("http://nas:32400", TOKEN, KEY).unwrap();
        for source in [
            "#EXTM3U\nhttp://evil.test/segment.ts\n",
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"http://evil.test/key\"\n",
            "#EXTM3U\n../../../../:/prefs\n",
        ] {
            assert!(library
                .rewrite_hls(source, "/video/:/transcode/universal/start.m3u8", PLAYER)
                .is_err());
        }
        for range in ["bytes=0-99", "bytes=100-", "bytes=-128"] {
            assert!(valid_range(range));
        }
        for range in [
            "bytes=-",
            "bytes=99-0",
            "bytes=0-1,2-3",
            "items=0-1",
            "bytes=18446744073709551616-",
        ] {
            assert!(!valid_range(range));
        }
    }

    #[tokio::test]
    async fn m3u_streams_bounded_export_with_original_or_compatible_video() {
        let (library, app, task) = fixture().await;
        assert_eq!(
            request(&app, "GET", "/nas/playlist.m3u", json!(null), None, None)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        for mode in ["original", "compatible"] {
            let response = request(
                &app,
                "GET",
                &format!("/nas/playlist.m3u?key={KEY}&section=1&limit=2&mode={mode}"),
                json!(null),
                None,
                None,
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let text = String::from_utf8(
                to_bytes(response.into_body(), MAX_JSON)
                    .await
                    .unwrap()
                    .to_vec(),
            )
            .unwrap();
            assert_eq!(text.matches("#EXTINF").count(), 2);
            assert!(!text.contains(TOKEN));
            assert!(!text.contains(KEY));
            let first = text.lines().find(|line| line.starts_with("http")).unwrap();
            let token = first.split('/').nth(5).unwrap();
            let ticket = library.ticket(token).unwrap();
            assert_eq!(
                ticket.path.starts_with("/video/:/transcode/"),
                mode == "compatible"
            );
        }
        task.abort();
    }

    #[tokio::test]
    async fn transcoder_sessions_are_bounded_and_reaped_after_inactivity() {
        let (library, app, task) = fixture().await;
        for number in 0..8 {
            library
                .touch_session(
                    &library
                        .url(&format!(
                            "/video/:/transcode/universal/start.m3u8?session=test{number}"
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
        }
        assert!(library
            .touch_session(
                &library
                    .url("/video/:/transcode/universal/start.m3u8?session=overflow")
                    .unwrap()
            )
            .await
            .is_err());
        let stop = library
            .media_url(PLAYER, "/video/:/transcode/universal/stop?session=test0")
            .unwrap();
        assert_eq!(
            request(&app, "GET", &path(&stop), json!(null), None, None)
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(library.sessions.lock().await.len(), 7);
        for seen in library.sessions.lock().await.values_mut() {
            seen.seen = Instant::now() - Duration::from_secs(181);
        }
        library.reap_sessions().await;
        assert!(library.sessions.lock().await.is_empty());
        task.abort();
    }
    #[tokio::test]
    async fn signed_media_and_keyed_playlists_allow_portable_cors_but_catalog_does_not() {
        let (library, app, task) = fixture().await;
        let url = library
            .media_url(PLAYER, "/library/parts/1/file.mkv")
            .unwrap();
        let response = request(
            &app,
            "GET",
            &path(&url),
            json!(null),
            Some("https://other-player.test"),
            Some("bytes=2-5"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert!(response.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS]
            .to_str()
            .unwrap()
            .contains("content-range"));
        assert!(!response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS));
        for route in [path(&url), "/nas/playlist.m3u".into()] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("OPTIONS")
                        .uri(route)
                        .header(header::ORIGIN, "https://other-player.test")
                        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                        .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "range")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
            assert!(response.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS]
                .to_str()
                .unwrap()
                .contains("range"));
        }
        let denied = request(
            &app,
            "GET",
            "/nas/playlist.m3u",
            json!(null),
            Some("https://other-player.test"),
            None,
        )
        .await;
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        let denied = request(
            &app,
            "GET",
            "/nas/stream/invalid.token/media.mkv",
            json!(null),
            Some("https://other-player.test"),
            None,
        )
        .await;
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        let allowed = request(
            &app,
            "GET",
            &format!("/nas/playlist.m3u?key={KEY}&section=1&limit=1"),
            json!(null),
            Some("https://other-player.test"),
            None,
        )
        .await;
        assert_eq!(allowed.status(), StatusCode::OK);
        assert_eq!(allowed.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        let denied = request(
            &app,
            "POST",
            "/nas/api",
            json!({"app":"ott-play"}),
            Some("https://other-player.test"),
            None,
        )
        .await;
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        assert!(!denied
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        task.abort();
    }

    #[test]
    fn keyless_browser_access_defaults_to_local_hosts_and_explicit_host_opt_in() {
        let mut library = Library::new("http://nas:32400", TOKEN, KEY).unwrap();
        for host in [
            "localhost",
            "192.168.1.20",
            "10.0.0.1",
            "172.16.2.1",
            "nas.local",
            "[::1]",
            "[fd12::1]",
        ] {
            let origin = format!("http://{host}:3000");
            let mut headers = HeaderMap::new();
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            assert!(
                library.accepts_browser(
                    &headers,
                    &origin,
                    Some("127.0.0.1:10000".parse().unwrap())
                ),
                "{host}"
            );
        }
        for host in [
            "public.example",
            "8.8.8.8",
            "172.32.1.1",
            "nas.local.evil.test",
            "[2001:4860:4860::8888]",
        ] {
            let origin = format!("https://{host}");
            let mut headers = HeaderMap::new();
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            assert!(
                !library.accepts_browser(
                    &headers,
                    &origin,
                    Some("127.0.0.1:10000".parse().unwrap())
                ),
                "{host}"
            );
        }
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "https://public.example".parse().unwrap());
        library.browser_hosts.push("public.example".to_owned());
        assert!(library.accepts_browser(
            &headers,
            "https://public.example",
            Some("8.8.8.8:10000".parse().unwrap())
        ));
        assert!(!library.accepts_browser(
            &headers,
            "http://public.example",
            Some("8.8.8.8:10000".parse().unwrap())
        ));
    }
    #[tokio::test]
    async fn root_pagination_uses_plex_total_and_does_not_apply_offset_twice() {
        let (_library, app, task) = fixture().await;
        let first = json_body(
            request(
                &app,
                "POST",
                "/nas/api",
                json!({"app":"ott-play","limit":2}),
                Some(PLAYER),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(first["items"][0]["id"], "section:1");
        assert_eq!(first["items"][1]["id"], "section:2");
        assert_eq!(first["items"][2]["type"], "next");
        assert_eq!(first["items"][2]["request"]["offset"], 2);
        let next = first["items"][2]["request"].clone();
        let second =
            json_body(request(&app, "POST", "/nas/api", next, Some(PLAYER), None).await).await;
        assert_eq!(second["items"].as_array().unwrap().len(), 1);
        assert_eq!(second["items"][0]["id"], "section:3");
        task.abort();
    }
    #[tokio::test]
    async fn absent_sessions_stop_idempotently_and_failed_starts_cannot_exhaust_capacity() {
        let (library, app, task) = fixture().await;
        for name in ["gone-faildecision", "gone-failstart"] {
            let url = library
                .media_url(
                    PLAYER,
                    &format!("/video/:/transcode/universal/start.m3u8?session={name}"),
                )
                .unwrap();
            assert_eq!(
                request(&app, "GET", &path(&url), json!(null), None, None)
                    .await
                    .status(),
                StatusCode::BAD_GATEWAY
            );
            assert!(library.sessions.lock().await[name].seen.elapsed() > Duration::from_secs(180));
        }
        library.reap_sessions().await;
        assert!(library.sessions.lock().await.is_empty());
        for name in ["gone", "gone410"] {
            library
                .sessions
                .lock()
                .await
                .insert(name.into(), TranscodeSession::new(Instant::now()));
            let url = library
                .media_url(
                    PLAYER,
                    &format!("/video/:/transcode/universal/stop?session={name}"),
                )
                .unwrap();
            assert_eq!(
                request(&app, "GET", &path(&url), json!(null), None, None)
                    .await
                    .status(),
                StatusCode::NO_CONTENT
            );
            assert!(!library.sessions.lock().await.contains_key(name));
        }
        library.sessions.lock().await.insert(
            "retry".into(),
            TranscodeSession::new(Instant::now() - Duration::from_secs(181)),
        );
        library.reap_sessions().await;
        assert!(
            library.sessions.lock().await.contains_key("retry"),
            "Transient stop failures remain eligible for retry"
        );
        task.abort();
    }
    #[tokio::test]
    async fn search_pages_flattened_items_without_paginating_hubs_twice() {
        let (_library, app, task) = fixture().await;
        let mut query = json!({"app":"ott-play","cmd":"search","query":"Movie","limit":2});
        let mut titles = Vec::new();
        for _ in 0..3 {
            let page = json_body(
                request(&app, "POST", "/nas/api", query.clone(), Some(PLAYER), None).await,
            )
            .await;
            let items = page["items"].as_array().unwrap();
            for item in items.iter().filter(|item| item["type"] != "next") {
                titles.push(item["title"].as_str().unwrap().to_owned());
            }
            match items.iter().find(|item| item["type"] == "next") {
                Some(next) => query = next["request"].clone(),
                None => break,
            }
        }
        assert_eq!(
            titles,
            (1..=6).map(|id| format!("Movie {id}")).collect::<Vec<_>>()
        );
        task.abort();
    }
    #[derive(Default)]
    struct FetchProbe {
        calls: std::sync::atomic::AtomicUsize,
        fail: std::sync::atomic::AtomicBool,
        block: std::sync::atomic::AtomicBool,
        started: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    async fn fetch_probe() -> (Library, Arc<FetchProbe>, tokio::task::JoinHandle<()>) {
        let probe = Arc::new(FetchProbe::default());
        let app = Router::new()
            .fallback(|State(probe): State<Arc<FetchProbe>>| async move {
                use std::sync::atomic::Ordering::SeqCst;
                let calls = probe.calls.fetch_add(1, SeqCst) + 1;
                if probe.block.swap(false, SeqCst) {
                    probe.started.notify_one();
                    probe.release.notified().await;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
                if probe.fail.swap(false, SeqCst) {
                    return StatusCode::BAD_GATEWAY.into_response();
                }
                Json(json!({"MediaContainer":{"probe":calls}})).into_response()
            })
            .with_state(probe.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (
            Library::new(&format!("http://{address}"), TOKEN, KEY).unwrap(),
            probe,
            task,
        )
    }

    #[tokio::test]
    async fn catalog_cache_coalesces_success_expires_and_never_caches_errors_or_play_decisions() {
        use std::sync::atomic::Ordering::SeqCst;
        let (library, probe, task) = fetch_probe().await;
        let responses = futures_util::future::join_all(
            (0..8).map(|_| library.fetch("/library/sections", 0, 100)),
        )
        .await;
        let first = responses[0].as_ref().unwrap();
        assert!(responses
            .iter()
            .all(|value| Arc::ptr_eq(first, value.as_ref().unwrap())));
        assert_eq!(
            probe.calls.load(SeqCst),
            1,
            "Concurrent page loads share one Plex request"
        );
        library.fetch("/library/sections", 0, 100).await.unwrap();
        assert_eq!(probe.calls.load(SeqCst), 1);
        for entry in library.catalog_cache.lock().await.entries.values_mut() {
            entry.expires = Instant::now() - Duration::from_secs(1);
        }
        library.fetch("/library/sections", 0, 100).await.unwrap();
        assert_eq!(
            probe.calls.load(SeqCst),
            2,
            "Expired catalogs refresh rather than extending freshness on reads"
        );
        probe.fail.store(true, SeqCst);
        assert!(library.fetch("/library/sections", 10, 100).await.is_err());
        library.fetch("/library/sections", 10, 100).await.unwrap();
        assert_eq!(
            probe.calls.load(SeqCst),
            4,
            "A failed fetch is retried immediately"
        );
        for path in [
            "/library/metadata/1",
            "/video/:/transcode/universal/decision?session=probe",
        ] {
            library.fetch(path, 0, 1).await.unwrap();
            library.fetch(path, 0, 1).await.unwrap();
        }
        assert_eq!(
            probe.calls.load(SeqCst),
            8,
            "Play metadata and per-session negotiation stay fresh"
        );
        task.abort();
    }

    #[tokio::test]
    async fn cancelled_cache_leader_does_not_deadlock_waiters_or_leave_inflight_slots() {
        use std::sync::atomic::Ordering::SeqCst;
        let (library, probe, task) = fetch_probe().await;
        probe.block.store(true, SeqCst);
        let leader = tokio::spawn({
            let library = library.clone();
            async move { library.fetch("/library/sections", 0, 100).await }
        });
        probe.started.notified().await;
        let follower = tokio::spawn({
            let library = library.clone();
            async move { library.fetch("/library/sections", 0, 100).await }
        });
        tokio::task::yield_now().await;
        leader.abort();
        assert!(leader.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(2), follower)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(probe.calls.load(SeqCst), 2);
        assert!(library
            .catalog_cache
            .lock()
            .await
            .flights
            .values()
            .all(|gate| gate.strong_count() == 0));
        probe.release.notify_one();
        task.abort();
    }

    #[test]
    fn catalog_cache_evicts_to_both_byte_and_entry_limits() {
        let mut cache = CatalogCache::default();
        for number in 0..(CATALOG_CACHE_ENTRIES + 10) {
            cache.insert(number.to_string(), Arc::new(json!({})), 1);
        }
        assert_eq!(cache.entries.len(), CATALOG_CACHE_ENTRIES);
        assert_eq!(cache.bytes, CATALOG_CACHE_ENTRIES);
        for number in 0..3 {
            cache.insert(format!("large{number}"), Arc::new(json!({})), MAX_JSON);
        }
        assert!(cache.entries.len() <= 2);
        assert!(cache.bytes <= CATALOG_CACHE_BYTES);
        assert!(cache.get("large2").is_some());
    }

    #[tokio::test]
    async fn real_peer_is_required_for_keyless_access_and_forwarded_headers_cannot_override_it() {
        let (library, _app, task) = fixture().await;
        for peer in [None, Some("8.8.8.8:123"), Some("[::ffff:8.8.8.8]:123")] {
            let mut app = routes(library.clone()).layer(Extension(crate::msx::Scheme("http")));
            if let Some(peer) = peer {
                app = app.layer(Extension(axum::extract::ConnectInfo(
                    peer.parse::<std::net::SocketAddr>().unwrap(),
                )));
            }
            let request = Request::post("/nas/api")
                .header(header::HOST, "localhost:3000")
                .header(header::ORIGIN, PLAYER)
                .header("x-forwarded-for", "127.0.0.1")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"app":"ott-play"}"#))
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                self::request(
                    &app,
                    "POST",
                    "/nas/api",
                    json!({"app":"ott-play","key":KEY}),
                    None,
                    None
                )
                .await
                .status(),
                StatusCode::OK
            );
        }
        for peer in [
            "127.0.0.1:123",
            "192.168.1.2:123",
            "[::1]:123",
            "[::ffff:192.168.1.2]:123",
        ] {
            let app = routes(library.clone())
                .layer(Extension(crate::msx::Scheme("http")))
                .layer(Extension(axum::extract::ConnectInfo(
                    peer.parse::<std::net::SocketAddr>().unwrap(),
                )));
            assert_eq!(
                request(
                    &app,
                    "POST",
                    "/nas/api",
                    json!({"app":"ott-play"}),
                    Some(PLAYER),
                    None
                )
                .await
                .status(),
                StatusCode::OK
            );
        }
        task.abort();
    }

    #[tokio::test]
    async fn session_cleanup_does_not_stop_revived_or_inflight_sessions_or_block_other_players() {
        use std::sync::atomic::Ordering::SeqCst;
        let (library, probe, task) = fetch_probe().await;
        let url = library
            .url("/video/:/transcode/universal/start.m3u8?session=active")
            .unwrap();
        let active = library.touch_session(&url).await.unwrap();
        let old = Instant::now() - Duration::from_secs(181);
        let gate = {
            let mut sessions = library.sessions.lock().await;
            let entry = sessions.get_mut("active").unwrap();
            entry.seen = old;
            entry.gate.clone()
        };
        drop(active);
        drop(library.touch_session(&url).await.unwrap());
        library.stop_expired("active", old, gate.clone()).await;
        assert_eq!(
            probe.calls.load(SeqCst),
            0,
            "A resumed session invalidates a cleanup snapshot before stop is sent"
        );
        let active = library.touch_session(&url).await.unwrap();
        library
            .sessions
            .lock()
            .await
            .get_mut("active")
            .unwrap()
            .seen = old;
        tokio::time::timeout(Duration::from_secs(1), library.reap_sessions())
            .await
            .unwrap();
        assert_eq!(
            probe.calls.load(SeqCst),
            0,
            "Active bodies are skipped without queued cleanup locks"
        );
        let other = library
            .url("/video/:/transcode/universal/start.m3u8?session=other")
            .unwrap();
        drop(
            tokio::time::timeout(Duration::from_secs(1), library.touch_session(&other))
                .await
                .unwrap()
                .unwrap(),
        );
        drop(active);
        tokio::time::timeout(Duration::from_secs(2), library.reap_sessions())
            .await
            .unwrap();
        assert_eq!(probe.calls.load(SeqCst), 1);
        assert!(!library.sessions.lock().await.contains_key("active"));
        task.abort();
    }

    #[tokio::test]
    async fn heartbeats_extend_existing_sessions_but_never_revive_stopped_missing_or_closing_sessions(
    ) {
        let (library, app, task) = fixture().await;
        let ping = library
            .media_url(PLAYER, "/video/:/transcode/universal/ping?session=beat")
            .unwrap();
        assert_eq!(
            request(&app, "GET", &path(&ping), json!(null), None, None)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert!(library.sessions.lock().await.is_empty());
        drop(
            library
                .touch_session(
                    &library
                        .url("/video/:/transcode/universal/start.m3u8?session=beat")
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        let gate = {
            let mut sessions = library.sessions.lock().await;
            let entry = sessions.get_mut("beat").unwrap();
            entry.seen = Instant::now() - Duration::from_secs(181);
            entry.gate.clone()
        };
        assert_eq!(
            request(&app, "GET", &path(&ping), json!(null), None, None)
                .await
                .status(),
            StatusCode::OK
        );
        assert!(library.sessions.lock().await["beat"].seen.elapsed() < Duration::from_secs(1));
        let closing = gate.write().await;
        assert_eq!(
            request(&app, "GET", &path(&ping), json!(null), None, None)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        drop(closing);
        let stop = library
            .media_url(PLAYER, "/video/:/transcode/universal/stop?session=beat")
            .unwrap();
        assert_eq!(
            request(&app, "GET", &path(&stop), json!(null), None, None)
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            request(&app, "GET", &path(&ping), json!(null), None, None)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert!(library.sessions.lock().await.is_empty());
        drop(
            library
                .touch_session(
                    &library
                        .url("/video/:/transcode/universal/start.m3u8?session=gone")
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        let gone = library
            .media_url(PLAYER, "/video/:/transcode/universal/ping?session=gone")
            .unwrap();
        assert_eq!(
            request(&app, "GET", &path(&gone), json!(null), None, None)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert!(library.sessions.lock().await.is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn excessive_catalog_offsets_are_rejected_instead_of_repeating_the_last_page() {
        let (_library, app, task) = fixture().await;
        let response = request(
            &app,
            "POST",
            "/nas/api",
            json!({"app":"ott-play","offset":MAX_EXPORT_ITEMS+1}),
            Some(PLAYER),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        task.abort();
    }
    #[tokio::test]
    async fn four_active_streams_do_not_starve_idle_session_cleanup() {
        use std::sync::atomic::Ordering::SeqCst;
        let (library, probe, task) = fetch_probe().await;
        let mut active = Vec::new();
        for number in 0..5 {
            let name = format!("stream{number}");
            let url = library
                .url(&format!(
                    "/video/:/transcode/universal/start.m3u8?session={name}"
                ))
                .unwrap();
            let lease = library.touch_session(&url).await.unwrap();
            library.sessions.lock().await.get_mut(&name).unwrap().seen =
                Instant::now() - Duration::from_secs(181);
            if number < 4 {
                active.push(lease);
            } else {
                drop(lease);
            }
        }
        tokio::time::timeout(Duration::from_secs(1), library.reap_sessions())
            .await
            .unwrap();
        assert_eq!(probe.calls.load(SeqCst), 1);
        assert_eq!(library.sessions.lock().await.len(), 4);
        assert!(!library.sessions.lock().await.contains_key("stream4"));
        drop(active);
        task.abort();
    }

    #[tokio::test]
    async fn playback_lifecycle_belongs_to_each_selected_hls_variant_and_not_to_originals() {
        let (library, _app, task) = fixture().await;
        let playback = library.play("item:2", PLAYER).await.unwrap();
        let sessions = playback["sessions"].as_object().unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(
            sessions[playback["url"].as_str().unwrap()]["heartbeat"],
            playback["heartbeat"]
        );
        let session_id = |url: &str| {
            let signed = url.split('/').nth(5).unwrap();
            let ticket = library.ticket(signed).unwrap();
            library
                .url(&ticket.path)
                .unwrap()
                .query_pairs()
                .find(|(key, _)| key == "session")
                .unwrap()
                .1
                .into_owned()
        };
        let mut ids = HashSet::new();
        for (url, lease) in sessions {
            let id = session_id(url);
            assert!(ids.insert(id.clone()));
            assert_eq!(session_id(lease["stop"].as_str().unwrap()), id);
            assert_eq!(session_id(lease["heartbeat"].as_str().unwrap()), id);
        }
        for (label, url) in playback["variants"].as_object().unwrap() {
            if label.starts_with("Оригинал") {
                assert!(!sessions.contains_key(url.as_str().unwrap()));
            }
        }
        task.abort();
    }

    #[tokio::test]
    async fn late_hls_children_cannot_recreate_stopped_registry_entries() {
        let (library, app, task) = fixture().await;
        for name in [
            "stale1", "stale2", "stale3", "stale4", "stale5", "stale6", "stale7", "stale8",
            "stale9",
        ] {
            let child = library
                .media_url(
                    PLAYER,
                    &format!("/video/:/transcode/universal/session/{name}/base/segment.ts"),
                )
                .unwrap();
            assert_eq!(
                request(&app, "GET", &path(&child), json!(null), None, None)
                    .await
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
        assert!(library.sessions.lock().await.is_empty());
        task.abort();
    }
    #[tokio::test]
    async fn delayed_heartbeat_failure_does_not_remove_a_restarted_session_generation() {
        let arrived = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let upstream = Router::new().fallback({
            let arrived = arrived.clone();
            let release = release.clone();
            move || {
                let arrived = arrived.clone();
                let release = release.clone();
                async move {
                    arrived.notify_one();
                    release.notified().await;
                    StatusCode::NOT_FOUND
                }
            }
        });
        let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let library = Library::new(&format!("http://{address}"), TOKEN, KEY).unwrap();
        let app = routes(library.clone()).layer(Extension(crate::msx::Scheme("http")));
        let start = library
            .url("/video/:/transcode/universal/start.m3u8?session=same")
            .unwrap();
        drop(library.touch_session(&start).await.unwrap());
        let ping = library
            .media_url(PLAYER, "/video/:/transcode/universal/ping?session=same")
            .unwrap();
        let pending = tokio::spawn(async move {
            request(&app, "GET", &path(&ping), json!(null), None, None).await
        });
        arrived.notified().await;
        library.sessions.lock().await.remove("same");
        let restarted = library.touch_session(&start).await.unwrap().unwrap();
        release.notify_one();
        assert_eq!(pending.await.unwrap().status(), StatusCode::NOT_FOUND);
        assert!(Arc::ptr_eq(
            &library.sessions.lock().await["same"].gate,
            &restarted.gate
        ));
        task.abort();
    }
}
