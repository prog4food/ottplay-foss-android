//! Restricted, fixed-public-source EPG service for hosted browser/TV clients.
//! It never accepts playlist URLs, XMLTV URLs, proxy destinations or credentials.
use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        DefaultBodyLimit, Query, State,
    },
    http::{header, HeaderValue, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use ottplay_core::xmltv::{self, Channels, MatchBudget, MatchIndex, Programs};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    io::Read,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{OwnedSemaphorePermit, RwLock, Semaphore};

const SOURCE: &str = "epg-one";
const SOURCE_URL: &str = "https://cdn.epg.one/epg2.xml.gz";
const REFRESH_MS: u64 = 7_200_000;
const WIRE_LIMIT: usize = 96 * 1024 * 1024;
const XML_LIMIT: usize = 512 * 1024 * 1024;
const MAX_ROWS: usize = 20_000;
const MAX_ROW_BYTES: usize = 8 * 1024 * 1024;
const MAX_CURRENT_BYTES: usize = 2 * 1024 * 1024;
const MATCH_TIMEOUT: Duration = Duration::from_secs(8);

type PendingRequestPermits =
    Arc<Mutex<Option<(OwnedSemaphorePermit, Option<OwnedSemaphorePermit>)>>>;

struct CancelRequestOnDrop {
    budget: Option<MatchBudget>,
    work: Option<tokio::task::AbortHandle>,
    pending: Option<PendingRequestPermits>,
}

impl Drop for CancelRequestOnDrop {
    fn drop(&mut self) {
        if let Some(budget) = &self.budget {
            budget.cancel();
        }
        // Tokio can remove a blocking task that has not started yet. Once it
        // starts, it keeps its leases until it returns. Matching work also
        // observes its cancelled budget through JS interrupts and row checks.
        if let Some(work) = &self.work {
            work.abort();
        }
        // A saturated Tokio blocking pool may not drop an aborted queued task
        // until it is dequeued. Release its leases now, but never take leases
        // already transferred to a running worker.
        if let Some(pending) = &self.pending {
            pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
        }
    }
}

struct Snapshot {
    channels: Channels,
    programs: Programs,
    index: MatchIndex,
    generation: String,
    fetched_at: u64,
}

impl Snapshot {
    fn from_xml(xml: &str, fetched_at: u64) -> anyhow::Result<Self> {
        let parse_started = Instant::now();
        let (channels, programs, aliases) = xmltv::parse_xmltv_hosted(xml)?;
        let alias_count = aliases.len();
        eprintln!(
            "[Hosted EPG] phase=parse elapsedMs={} bytes={} channels={} aliases={} programmes={}",
            parse_started.elapsed().as_millis(),
            xml.len(),
            channels.len(),
            alias_count,
            programs.values().map(Vec::len).sum::<usize>()
        );
        anyhow::ensure!(
            channels
                .keys()
                .any(|id| programs.get(id).is_some_and(|rows| !rows.is_empty())),
            "EPG_EMPTY"
        );
        let index_started = Instant::now();
        let index = MatchIndex::web(aliases)?;
        eprintln!(
            "[Hosted EPG] phase=index elapsedMs={} aliases={}",
            index_started.elapsed().as_millis(),
            alias_count
        );
        // This process-local opaque revision names a complete immutable snapshot;
        // it is not an authentication token and survives no server restart.
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        Ok(Self {
            channels,
            programs,
            index,
            generation: format!("{fetched_at:x}-{nonce:x}"),
            fetched_at,
        })
    }

    fn metadata(&self, now: u64) -> Value {
        json!({"version":1,"source":SOURCE,"generation":self.generation,
            "fetchedAt":self.fetched_at,"refreshMs":REFRESH_MS,
            "stale":now.saturating_sub(self.fetched_at) >= REFRESH_MS})
    }

    fn matches(
        &self,
        channels: Vec<ChannelInput>,
        now: u64,
        budget: &MatchBudget,
    ) -> anyhow::Result<Value> {
        let mut mappings = Map::new();
        for row in channels {
            budget.check()?;
            if let Some((id, shift)) = self.index.resolve_web_with_budget(
                &row.tvg_id,
                &[&row.tvg_name, &row.name],
                &row.name,
                budget,
            )? {
                let logo = self
                    .channels
                    .get(&id)
                    .map(|c| c.icon.as_str())
                    .unwrap_or("");
                mappings.insert(row.id, json!({"channelId":id,"shift":shift,"logo":logo}));
            }
        }
        budget.check()?;
        let mut result = self.metadata(now);
        result["mappings"] = Value::Object(mappings);
        Ok(result)
    }

    fn programmes(&self, input: ProgrammeInput, now: u64) -> Result<Value, ApiError> {
        if input.generation != self.generation {
            return Err(ApiError::Generation);
        }
        if !self.channels.contains_key(&input.channel_id) {
            return Err(ApiError::NotFound);
        }
        let clock = (now / 1000) as i64;
        let history = if input.hours > 0 { input.hours } else { 48 };
        let from = clock - history * 3600;
        let until = clock + 48 * 3600;
        let mut rows = Vec::new();
        let mut bytes = 0;
        for row in self.programs.get(&input.channel_id).into_iter().flatten() {
            let start = row.start + input.shift;
            let stop = row.stop + input.shift;
            if stop <= from || start >= until {
                continue;
            }
            // Match the browser's decoded UTF-16 record budget, not HTTP gzip size.
            bytes += 80 + 2 * (row.title.encode_utf16().count() + row.desc.encode_utf16().count());
            if rows.len() >= MAX_ROWS || bytes > MAX_ROW_BYTES {
                return Err(ApiError::Limit);
            }
            rows.push(
                json!({"time":start,"time_to":stop,"name":row.title,"descr":row.desc,"icon":""}),
            );
        }
        let mut result = self.metadata(now);
        result["rows"] = Value::Array(rows);
        Ok(result)
    }

    fn current(
        &self,
        input: CurrentInput,
        now: u64,
        budget: &MatchBudget,
    ) -> anyhow::Result<Value> {
        let clock = (now / 1000) as i64;
        let search = caseless_key(&input.search);
        let total = input.channels.len();
        let mut programs = Vec::new();
        let mut result = self.metadata(now);
        result["asOf"] = json!(clock);
        result["checked"] = json!(total);
        result["total"] = json!(total);
        result["programs"] = json!([]);
        let mut bytes = serde_json::to_vec(&result)?.len();
        for row in input.channels {
            budget.check()?;
            let Some((id, inferred_shift)) = self.index.resolve_web_with_budget(
                &row.tvg_id,
                &[&row.tvg_name, &row.name],
                &row.name,
                budget,
            )?
            else {
                continue;
            };
            let Some(rows) = self.programs.get(&id) else {
                continue;
            };
            let shift = inferred_shift + row.shift;
            let Some(program) = current_program(rows, clock - shift, budget)? else {
                continue;
            };
            if program.title.is_empty()
                || (!search.is_empty() && !caseless_key(&program.title).contains(&search))
            {
                continue;
            }
            let value = json!({"id":row.id,"start":program.start + shift,
                "end":program.stop + shift,"title":program.title});
            // Count actual JSON bytes, including escapes and array separators,
            // without retaining descriptions or another complete encoded body.
            bytes += serde_json::to_vec(&value)?.len() + usize::from(!programs.is_empty());
            if bytes > MAX_CURRENT_BYTES {
                return Err(anyhow::Error::new(CurrentResponseLimit));
            }
            programs.push(value);
        }
        budget.check()?;
        result["programs"] = Value::Array(programs);
        Ok(result)
    }
}

// Match the player's caselessKey without changing accents or whitespace.
fn caseless_key(value: &str) -> String {
    let mut key = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch == '\u{131}' {
            key.push(ch);
        } else {
            for lower in ch.to_lowercase() {
                key.extend(lower.to_uppercase());
            }
        }
    }
    key
}

fn current_program<'a>(
    rows: &'a [xmltv::Programme],
    clock: i64,
    budget: &MatchBudget,
) -> anyhow::Result<Option<&'a xmltv::Programme>> {
    // Hosted snapshots sort by start then stop. Search only the eligible
    // prefix; older overlapping entries can remain current after newer ones end.
    let mut end = rows.partition_point(|row| row.start <= clock);
    while end > 0 {
        budget.check()?;
        let start = rows[end - 1].start;
        let mut first = end - 1;
        while first > 0 && rows[first - 1].start == start {
            budget.check()?;
            first -= 1;
        }
        for row in &rows[first..end] {
            budget.check()?;
            // The shared guide selects the first valid row at the latest start.
            if row.stop > clock {
                return Ok(Some(row));
            }
        }
        end = first;
    }
    Ok(None)
}

#[derive(Debug)]
struct CurrentResponseLimit;

impl std::fmt::Display for CurrentResponseLimit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EPG_CHANNEL_LIMIT")
    }
}

impl std::error::Error for CurrentResponseLimit {}

struct GuideState {
    snapshot: RwLock<Option<Arc<Snapshot>>>,
    match_requests: Arc<Semaphore>,
    match_execution: Arc<Semaphore>,
    programme_requests: Arc<Semaphore>,
}

impl GuideState {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            snapshot: RwLock::new(None),
            // QuickJS serializes access to the shared index. Bound its queue
            // separately so matching new playlists cannot starve guide reads.
            match_requests: Arc::new(Semaphore::new(2)),
            // Wait asynchronously rather than blocking another worker on the
            // serialized JS context. Both admission and execution are bounded.
            match_execution: Arc::new(Semaphore::new(1)),
            programme_requests: Arc::new(Semaphore::new(4)),
        })
    }

    async fn publish(&self, fresh: Snapshot) {
        let old = self.snapshot.write().await.replace(Arc::new(fresh));
        // Hundreds of thousands of strings must not be freed on the async runtime.
        let _ = tokio::task::spawn_blocking(move || drop(old)).await;
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChannelInput {
    id: String,
    tvg_id: String,
    tvg_name: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MatchInput {
    version: u8,
    source: String,
    channels: Vec<ChannelInput>,
}

impl MatchInput {
    fn valid(&self) -> bool {
        let mut ids = HashSet::new();
        self.version == 1
            && self.source == SOURCE
            && self.channels.len() <= 2048
            && self.channels.iter().all(|c| {
                !c.id.is_empty()
                    && ids.insert(&c.id)
                    && [&c.id, &c.tvg_id, &c.tvg_name, &c.name]
                        .iter()
                        .all(|s| s.encode_utf16().count() <= 512)
            })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CurrentChannelInput {
    id: String,
    tvg_id: String,
    tvg_name: String,
    name: String,
    shift: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CurrentInput {
    version: u8,
    source: String,
    channels: Vec<CurrentChannelInput>,
    search: String,
}

impl CurrentInput {
    fn valid(&self) -> bool {
        let mut ids = HashSet::new();
        self.version == 1
            && self.source == SOURCE
            && self.search.len() <= 1024
            && self.channels.len() <= 2048
            && self.channels.iter().all(|c| {
                !c.id.is_empty()
                    && ids.insert(&c.id)
                    && (-86400..=86400).contains(&c.shift)
                    && [&c.id, &c.tvg_id, &c.tvg_name, &c.name]
                        .iter()
                        .all(|s| s.encode_utf16().count() <= 512)
            })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProgrammeInput {
    channel_id: String,
    shift: i64,
    hours: i64,
    generation: String,
}

impl ProgrammeInput {
    fn valid(&self) -> bool {
        !self.channel_id.is_empty()
            && self.channel_id.encode_utf16().count() <= 512
            && (-86400..=86400).contains(&self.shift)
            && self.shift % 3600 == 0
            && (0..=8784).contains(&self.hours)
            && !self.generation.is_empty()
            && self.generation.len() <= 80
    }
}

#[derive(Debug)]
enum ApiError {
    Invalid,
    Large,
    NotReady,
    NotFound,
    Generation,
    Busy,
    Limit,
    Internal,
    Timeout,
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "EPG_REQUEST"),
            Self::Large => (StatusCode::PAYLOAD_TOO_LARGE, "EPG_REQUEST_LIMIT"),
            Self::NotReady => (StatusCode::SERVICE_UNAVAILABLE, "EPG_NOT_READY"),
            Self::NotFound => (StatusCode::NOT_FOUND, "EPG_CHANNEL"),
            Self::Generation => (StatusCode::CONFLICT, "EPG_GENERATION"),
            Self::Busy => (StatusCode::TOO_MANY_REQUESTS, "EPG_BUSY"),
            Self::Limit => (StatusCode::UNPROCESSABLE_ENTITY, "EPG_CHANNEL_LIMIT"),
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "EPG_INTERNAL"),
            Self::Timeout => (StatusCode::GATEWAY_TIMEOUT, "EPG_TIMEOUT"),
        };
        let mut response = (
            status,
            Json(json!({"version":1,"source":SOURCE,"error":{"code":code}})),
        )
            .into_response();
        if matches!(
            status,
            StatusCode::SERVICE_UNAVAILABLE | StatusCode::TOO_MANY_REQUESTS
        ) {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("5"));
        }
        response
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn router(state: Arc<GuideState>) -> Router {
    Router::new()
        .route("/health", get(|| async { "OK" }))
        .route("/epg/v1/health", get(readiness))
        .route("/epg/v1/match", post(match_channels))
        .route("/epg/v1/current", post(current))
        .route("/epg/v1/programmes", get(programmes))
        .fallback(|| async { ApiError::NotFound })
        .layer(DefaultBodyLimit::max(512 * 1024))
        .layer(middleware::map_response(
            |mut response: Response| async move {
                response
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                response.headers_mut().insert(
                    header::X_CONTENT_TYPE_OPTIONS,
                    HeaderValue::from_static("nosniff"),
                );
                response
            },
        ))
        .with_state(state)
}

async fn readiness(State(state): State<Arc<GuideState>>) -> Result<Json<Value>, ApiError> {
    let snapshot = state.snapshot.read().await;
    snapshot
        .as_ref()
        .map(|s| Json(s.metadata(now_ms())))
        .ok_or(ApiError::NotReady)
}

async fn match_channels(
    State(state): State<Arc<GuideState>>,
    body: Result<Json<MatchInput>, JsonRejection>,
) -> Result<Response, ApiError> {
    let input = body
        .map_err(|e| {
            if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
                ApiError::Large
            } else {
                ApiError::Invalid
            }
        })?
        .0;
    if !input.valid() {
        return Err(ApiError::Invalid);
    }
    run_match(state, input, MATCH_TIMEOUT).await
}

async fn run_match(
    state: Arc<GuideState>,
    input: MatchInput,
    timeout: Duration,
) -> Result<Response, ApiError> {
    run_match_using(
        state,
        input.channels,
        timeout,
        |snapshot, channels, budget| snapshot.matches(channels, now_ms(), budget),
    )
    .await
}

async fn current(
    State(state): State<Arc<GuideState>>,
    body: Result<Json<CurrentInput>, JsonRejection>,
) -> Result<Response, ApiError> {
    let input = body
        .map_err(|e| {
            if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
                ApiError::Large
            } else {
                ApiError::Invalid
            }
        })?
        .0;
    if !input.valid() {
        return Err(ApiError::Invalid);
    }
    run_current(state, input, MATCH_TIMEOUT).await
}

async fn run_current(
    state: Arc<GuideState>,
    input: CurrentInput,
    timeout: Duration,
) -> Result<Response, ApiError> {
    run_match_using(state, input, timeout, |snapshot, input, budget| {
        snapshot.current(input, now_ms(), budget)
    })
    .await
}

async fn run_match_using<I: Send + 'static>(
    state: Arc<GuideState>,
    input: I,
    timeout: Duration,
    work: impl FnOnce(Arc<Snapshot>, I, &MatchBudget) -> anyhow::Result<Value> + Send + 'static,
) -> Result<Response, ApiError> {
    let budget = MatchBudget::new(timeout);
    let mut cancel = CancelRequestOnDrop {
        budget: Some(budget.clone()),
        work: None,
        pending: None,
    };
    let deadline = tokio::time::Instant::from_std(budget.deadline());
    let permit = state
        .match_requests
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::Busy)?;
    let snapshot = tokio::time::timeout_at(deadline, state.snapshot.read())
        .await
        .map_err(|_| ApiError::Timeout)?
        .clone()
        .ok_or(ApiError::NotReady)?;
    let execution =
        tokio::time::timeout_at(deadline, state.match_execution.clone().acquire_owned())
            .await
            .map_err(|_| ApiError::Timeout)?
            .map_err(|_| ApiError::Internal)?;
    let work_budget = budget.clone();
    let pending = Arc::new(Mutex::new(Some((permit, Some(execution)))));
    cancel.pending = Some(pending.clone());
    let work = tokio::task::spawn_blocking(move || {
        let _permits = pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
            .ok_or(ApiError::Timeout)?;
        if work_budget.stopped() {
            return Err(ApiError::Timeout);
        }
        let result = work(snapshot, input, &work_budget)
            .map(|value| Json(value).into_response())
            .map_err(|error| {
                if work_budget.stopped() {
                    ApiError::Timeout
                } else if error.is::<CurrentResponseLimit>() {
                    ApiError::Limit
                } else {
                    ApiError::Internal
                }
            });
        if work_budget.stopped() {
            return Err(ApiError::Timeout);
        }
        result
    });
    cancel.work = Some(work.abort_handle());
    tokio::time::timeout_at(deadline, work)
        .await
        .map_err(|_| ApiError::Timeout)?
        .map_err(|_| ApiError::Internal)?
}

async fn programmes(
    State(state): State<Arc<GuideState>>,
    query: Result<Query<ProgrammeInput>, QueryRejection>,
) -> Result<Response, ApiError> {
    let input = query.map_err(|_| ApiError::Invalid)?.0;
    if !input.valid() {
        return Err(ApiError::Invalid);
    }
    let permit = state
        .programme_requests
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::Busy)?;
    let snapshot = state
        .snapshot
        .read()
        .await
        .clone()
        .ok_or(ApiError::NotReady)?;
    let pending = Arc::new(Mutex::new(Some((permit, None))));
    let mut cancel = CancelRequestOnDrop {
        budget: None,
        work: None,
        pending: Some(pending.clone()),
    };
    let work = tokio::task::spawn_blocking(move || {
        let _permit = pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
            .ok_or(ApiError::Timeout)?;
        snapshot
            .programmes(input, now_ms())
            .map(|value| Json(value).into_response())
    });
    cancel.work = Some(work.abort_handle());
    work.await.map_err(|_| ApiError::Internal)?
}

async fn fetch_snapshot(client: &reqwest::Client) -> anyhow::Result<Snapshot> {
    let download_started = Instant::now();
    let mut response = client.get(SOURCE_URL).send().await?.error_for_status()?;
    anyhow::ensure!(
        response
            .content_length()
            .is_none_or(|n| n <= WIRE_LIMIT as u64),
        "EPG_WIRE_LIMIT"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(bytes.len() + chunk.len() <= WIRE_LIMIT, "EPG_WIRE_LIMIT");
        bytes.extend_from_slice(&chunk);
    }
    eprintln!(
        "[Hosted EPG] phase=download elapsedMs={} bytes={}",
        download_started.elapsed().as_millis(),
        bytes.len()
    );
    let fresh = now_ms();
    tokio::task::spawn_blocking(move || {
        let decode_started = Instant::now();
        let mut raw = Vec::new();
        if bytes.starts_with(&[31, 139]) {
            flate2::read::GzDecoder::new(&bytes[..])
                .take((XML_LIMIT + 1) as u64)
                .read_to_end(&mut raw)?;
        } else {
            raw = bytes;
        }
        anyhow::ensure!(raw.len() <= XML_LIMIT, "EPG_XML_LIMIT");
        let xml = std::str::from_utf8(&raw)?;
        eprintln!(
            "[Hosted EPG] phase=decode elapsedMs={} bytes={}",
            decode_started.elapsed().as_millis(),
            raw.len()
        );
        Snapshot::from_xml(xml, fresh)
    })
    .await?
}

pub fn enabled() -> anyhow::Result<bool> {
    match std::env::var("EPG_ONLY").ok().as_deref() {
        None | Some("false" | "0") => Ok(false),
        Some("true" | "1") => Ok(true),
        _ => anyhow::bail!("EPG_ONLY must be true or false"),
    }
}

pub fn start() -> anyhow::Result<Router> {
    if let Ok(source) = std::env::var("EPG_URLS") {
        anyhow::ensure!(
            source.trim() == SOURCE_URL,
            "EPG_ONLY supports only its configured public feed"
        );
    }
    let state = GuideState::new();
    let client = reqwest::Client::builder()
        .user_agent("OTT-play-FOSS/1.0")
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .timeout(Duration::from_secs(600))
        // A moved public feed needs a reviewed configuration update, never a
        // redirect to an arbitrary destination or an internal address.
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let refresh_state = state.clone();
    tokio::spawn(async move {
        let mut failures = 0u32;
        loop {
            match fetch_snapshot(&client).await {
                Ok(fresh) => {
                    refresh_state.publish(fresh).await;
                    failures = 0;
                }
                Err(_) => {
                    failures = failures.saturating_add(1u32);
                    eprintln!("[Hosted EPG] refresh failed; retaining accepted snapshot");
                }
            }
            let delay = ottplay_core::epg_refresh_interval(failures).unwrap_or(300);
            tokio::time::sleep(Duration::from_secs(delay)).await;
        }
    });
    Ok(router(state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use tower::ServiceExt;

    const XML: &str = r#"<tv><channel id="ren"><display-name>РЕН ТВ</display-name><display-name>REN TV</display-name><icon src="http://epg.one/ren.png"/></channel><channel id="other"><display-name>Другой</display-name></channel><channel id="amb1"><display-name>Shared Alias</display-name></channel><channel id="amb2"><display-name>Shared Alias</display-name></channel><programme channel="ren" start="20260929100000 +0300" stop="20260929110000 +0300"><title>Передача</title><desc>Описание</desc></programme></tv>"#;
    const NOW: u64 = 1_790_665_200_000; // 2026-09-29 07:00 UTC

    fn snapshot() -> Snapshot {
        Snapshot::from_xml(XML, NOW).unwrap()
    }
    fn channel(id: &str, tvg_id: &str, tvg_name: &str, name: &str) -> ChannelInput {
        ChannelInput {
            id: id.into(),
            tvg_id: tvg_id.into(),
            tvg_name: tvg_name.into(),
            name: name.into(),
        }
    }
    fn query(snapshot: &Snapshot, id: &str, shift: i64, hours: i64) -> ProgrammeInput {
        ProgrammeInput {
            channel_id: id.into(),
            shift,
            hours,
            generation: snapshot.generation.clone(),
        }
    }

    fn match_input() -> MatchInput {
        MatchInput {
            version: 1,
            source: SOURCE.into(),
            channels: vec![channel("local", "ren", "", "РЕН ТВ")],
        }
    }

    fn current_channel(id: &str, tvg_id: &str, name: &str, shift: i64) -> CurrentChannelInput {
        CurrentChannelInput {
            id: id.into(),
            tvg_id: tvg_id.into(),
            tvg_name: String::new(),
            name: name.into(),
            shift,
        }
    }

    fn current_input(channels: Vec<CurrentChannelInput>, search: &str) -> CurrentInput {
        CurrentInput {
            version: 1,
            source: SOURCE.into(),
            channels,
            search: search.into(),
        }
    }

    fn current_body() -> Value {
        json!({"version":1,"source":SOURCE,"search":"",
            "channels":[{"id":"local","tvgId":"ren","tvgName":"","name":"РЕН ТВ","shift":0}]})
    }

    #[test]
    fn current_caseless_key_matches_unicode_17_without_extra_equivalences() {
        let mut mappings = std::collections::HashMap::new();
        for line in include_str!("../../../tests/fixtures/unicode/CaseFolding-17.0.0.txt").lines() {
            let fields: Vec<_> = line
                .split('#')
                .next()
                .unwrap()
                .split(';')
                .map(str::trim)
                .collect();
            if fields.len() < 3 || !matches!(fields[1], "C" | "F") {
                continue;
            }
            let point = u32::from_str_radix(fields[0], 16).unwrap();
            let folded: String = fields[2]
                .split_whitespace()
                .map(|point| char::from_u32(u32::from_str_radix(point, 16).unwrap()).unwrap())
                .collect();
            mappings.insert(point, folded);
        }
        assert_eq!(mappings.len(), 1585);
        for point in 0..=0x10ffff {
            let Some(ch) = char::from_u32(point) else {
                continue;
            };
            let original = ch.to_string();
            let expected = mappings.get(&point).unwrap_or(&original);
            let actual = caseless_key(&original);
            assert_eq!(actual, caseless_key(expected), "C/F pair U+{point:04X}");
            let mut canonical = String::new();
            for ch in actual.chars() {
                if let Some(folded) = mappings.get(&(ch as u32)) {
                    canonical.push_str(folded);
                } else {
                    canonical.push(ch);
                }
            }
            assert_eq!(&canonical, expected, "no extra equivalence U+{point:04X}");
        }
        assert_eq!(
            caseless_key("Три Кота Straße ẞ ςσΣ"),
            "ТРИ КОТА STRASSE SS ΣΣΣ"
        );
        assert_ne!(caseless_key("ё"), caseless_key("е"));
        assert_ne!(caseless_key("ı"), caseless_key("i"));
        assert_ne!(caseless_key("a  b"), caseless_key("a b"));
    }

    #[test]
    fn current_selects_latest_overlap_and_first_valid_tie_without_copying_history() {
        let row = |start, stop, title: &str| xmltv::Programme {
            start,
            stop,
            title: title.into(),
            ..Default::default()
        };
        let rows = vec![
            row(10, 100, "older overlap"),
            row(20, 25, "ended tie"),
            row(20, 30, "first current tie"),
            row(20, 40, "later tie"),
            row(22, 24, "ended later start"),
            row(60, 80, "future"),
        ];
        let budget = MatchBudget::new(MATCH_TIMEOUT);
        assert!(current_program(&rows, 9, &budget).unwrap().is_none());
        assert_eq!(
            current_program(&rows, 20, &budget).unwrap().unwrap().title,
            "ended tie"
        );
        assert_eq!(
            current_program(&rows, 25, &budget).unwrap().unwrap().title,
            "first current tie"
        );
        assert_eq!(
            current_program(&rows, 30, &budget).unwrap().unwrap().title,
            "later tie"
        );
        assert_eq!(
            current_program(&rows, 40, &budget).unwrap().unwrap().title,
            "older overlap"
        );
        assert_eq!(
            current_program(&rows, 60, &budget).unwrap().unwrap().title,
            "future"
        );
        assert!(current_program(&rows, 100, &budget).unwrap().is_none());
        budget.cancel();
        assert!(current_program(&rows, 40, &budget).is_err());
    }

    #[test]
    fn current_matches_in_order_filters_titles_and_applies_both_shifts_once() {
        let mut snapshot = snapshot();
        snapshot.programs.get_mut("ren").unwrap()[0].title = "Три Кота: Ёлка Straße".into();
        let rows = || {
            vec![
                current_channel("second", "ren", "РЕН ТВ +1", -3600),
                current_channel("missing", "", "Unknown channel", 0),
                current_channel("no-guide", "other", "Другой", 0),
                current_channel("first", "ren", "РЕН ТВ", 0),
            ]
        };
        let result = snapshot
            .current(
                current_input(rows(), "тРИ кОТА"),
                NOW,
                &MatchBudget::new(MATCH_TIMEOUT),
            )
            .unwrap();
        assert_eq!(result["programs"].as_array().unwrap().len(), 2);
        assert_eq!(result["programs"][0]["id"], "second");
        assert_eq!(result["programs"][1]["id"], "first");
        assert_eq!(result["programs"][0]["start"], NOW / 1000);
        assert_eq!(result["programs"][0]["end"], NOW / 1000 + 3600);
        assert_eq!(result["asOf"], NOW / 1000);
        assert_eq!(result["checked"], 4);
        assert_eq!(result["total"], 4);
        assert_eq!(result["generation"], snapshot.generation);
        assert_eq!(result["fetchedAt"], NOW);
        assert_eq!(result["stale"], false);
        let encoded = result.to_string();
        assert!(!encoded.contains("Описание"));
        assert!(!encoded.contains("http"));
        assert_eq!(result["programs"][0].as_object().unwrap().len(), 4);
        for (search, count) in [
            ("STRASSE", 2),
            ("ёлка", 2),
            ("елка", 0),
            ("три  кота", 0),
            ("unknown", 0),
            ("", 2),
        ] {
            let result = snapshot
                .current(
                    current_input(rows(), search),
                    NOW,
                    &MatchBudget::new(MATCH_TIMEOUT),
                )
                .unwrap();
            assert_eq!(
                result["programs"].as_array().unwrap().len(),
                count,
                "{search}"
            );
        }
        let shifted = snapshot
            .current(
                current_input(vec![current_channel("seconds", "ren", "РЕН ТВ +1", 30)], ""),
                NOW + 3630_000,
                &MatchBudget::new(MATCH_TIMEOUT),
            )
            .unwrap();
        assert_eq!(shifted["programs"][0]["start"], NOW / 1000 + 3630);
        assert_eq!(shifted["programs"][0]["end"], NOW / 1000 + 7230);
        let stale = snapshot
            .current(
                current_input(rows(), ""),
                NOW + REFRESH_MS,
                &MatchBudget::new(MATCH_TIMEOUT),
            )
            .unwrap();
        assert_eq!(stale["stale"], true);
        assert_eq!(stale["checked"], 4);
        snapshot.programs.get_mut("ren").unwrap()[0].title.clear();
        let empty = snapshot
            .current(
                current_input(rows(), ""),
                NOW,
                &MatchBudget::new(MATCH_TIMEOUT),
            )
            .unwrap();
        assert_eq!(empty["programs"], json!([]));
    }

    #[tokio::test]
    async fn current_endpoint_rejects_invalid_and_oversized_requests_without_echoing_fields() {
        let state = GuideState::new();
        let path = "/epg/v1/current";
        let (status, body) = request(router(state.clone()), "POST", path, current_body()).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"]["code"], "EPG_NOT_READY");
        state.publish(snapshot()).await;
        let mut invalid = Vec::new();
        for (field, value) in [
            ("version", json!(2)),
            ("source", json!("other")),
            ("search", json!("я".repeat(513))),
            ("url", json!("https://private.invalid/secret")),
        ] {
            let mut body = current_body();
            body[field] = value;
            invalid.push(body);
        }
        for (field, value) in [
            ("id", json!("")),
            ("name", json!("😀".repeat(257))),
            ("shift", json!(86401)),
            ("shift", json!(-86401)),
            ("shift", json!(0.5)),
            ("shift", json!("NaN")),
            ("url", json!("https://private.invalid/secret")),
        ] {
            let mut body = current_body();
            body["channels"][0][field] = value;
            invalid.push(body);
        }
        let mut duplicate = current_body();
        let row = duplicate["channels"][0].clone();
        duplicate["channels"].as_array_mut().unwrap().push(row);
        invalid.push(duplicate);
        let mut many = current_body();
        many["channels"] = json!((0..2049)
            .map(|i| json!({"id":i.to_string(),"tvgId":"ren","tvgName":"","name":"","shift":0}))
            .collect::<Vec<_>>());
        invalid.push(many);
        for body in invalid {
            let (status, result) = request(router(state.clone()), "POST", path, body).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(
                result,
                json!({"version":1,"source":SOURCE,"error":{"code":"EPG_REQUEST"}})
            );
        }
        let mut large = current_body();
        large["search"] = json!("a".repeat(512 * 1024));
        let (status, result) = request(router(state.clone()), "POST", path, large).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(result["error"]["code"], "EPG_REQUEST_LIMIT");
        let mut empty = current_body();
        empty["channels"] = json!([]);
        empty["search"] = json!("я".repeat(512));
        let (status, result) = request(router(state), "POST", path, empty).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(result["checked"], 0);
        assert_eq!(result["total"], 0);
        assert_eq!(result["programs"], json!([]));
        assert!(result["asOf"].as_u64().is_some());
    }

    #[test]
    fn current_response_budget_counts_json_escaping_and_never_returns_partial_rows() {
        let mut snapshot = snapshot();
        let channels = || {
            (0..128)
                .map(|i| current_channel(&i.to_string(), "ren", "РЕН ТВ", 0))
                .collect()
        };
        snapshot.programs.get_mut("ren").unwrap()[0].title = "a".repeat(16000);
        let result = snapshot
            .current(
                current_input(channels(), ""),
                NOW,
                &MatchBudget::new(MATCH_TIMEOUT),
            )
            .unwrap();
        assert_eq!(result["programs"].as_array().unwrap().len(), 128);
        assert!(serde_json::to_vec(&result).unwrap().len() <= MAX_CURRENT_BYTES);
        snapshot.programs.get_mut("ren").unwrap()[0].title = "a".repeat(16384);
        let error = snapshot
            .current(
                current_input(channels(), ""),
                NOW,
                &MatchBudget::new(MATCH_TIMEOUT),
            )
            .unwrap_err();
        assert!(error.is::<CurrentResponseLimit>());
        snapshot.programs.get_mut("ren").unwrap()[0].title = "\u{1}".repeat(3000);
        let error = snapshot
            .current(
                current_input(channels(), ""),
                NOW,
                &MatchBudget::new(MATCH_TIMEOUT),
            )
            .unwrap_err();
        assert!(error.is::<CurrentResponseLimit>());
    }

    #[tokio::test]
    async fn current_route_returns_compact_current_rows_or_a_whole_budget_error() {
        let state = GuideState::new();
        let clock = now_ms();
        let mut fresh = snapshot();
        fresh.fetched_at = clock;
        let program = &mut fresh.programs.get_mut("ren").unwrap()[0];
        program.start = (clock / 1000) as i64 - 60;
        program.stop = (clock / 1000) as i64 + 3600;
        program.title = "Три Кота".into();
        let start = program.start;
        let end = program.stop;
        state.publish(fresh).await;
        let mut body = current_body();
        body["search"] = json!("кОТа");
        let (status, result) =
            request(router(state.clone()), "POST", "/epg/v1/current", body).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            result["programs"],
            json!([{"id":"local","start":start,"end":end,"title":"Три Кота"}])
        );
        assert!(result["asOf"]
            .as_i64()
            .is_some_and(|now| start <= now && now < end));
        assert_eq!(result["stale"], false);
        assert_eq!(result["checked"], 1);
        assert_eq!(result["total"], 1);
        let held = state
            .match_requests
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        let (status, result) = request(
            router(state.clone()),
            "POST",
            "/epg/v1/current",
            current_body(),
        )
        .await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(result["error"]["code"], "EPG_BUSY");
        drop(held);
        let mut oversized = snapshot();
        let program = &mut oversized.programs.get_mut("ren").unwrap()[0];
        program.start = start;
        program.stop = end;
        program.title = "a".repeat(16384);
        state.publish(oversized).await;
        let mut body = current_body();
        body["channels"] = json!((0..128)
            .map(
                |i| json!({"id":i.to_string(),"tvgId":"ren","tvgName":"","name":"РЕН ТВ","shift":0})
            )
            .collect::<Vec<_>>());
        let (status, result) = request(router(state), "POST", "/epg/v1/current", body).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            result,
            json!({"version":1,"source":SOURCE,"error":{"code":"EPG_CHANNEL_LIMIT"}})
        );
    }

    #[tokio::test]
    async fn current_deadline_cancellation_and_snapshot_replacement_are_coherent() {
        let state = GuideState::new();
        state.publish(snapshot()).await;
        let old_generation = state
            .snapshot
            .read()
            .await
            .as_ref()
            .unwrap()
            .generation
            .clone();
        let held = state.match_execution.clone().acquire_owned().await.unwrap();
        let input = || current_input(vec![current_channel("local", "ren", "РЕН ТВ", 0)], "");
        let response = run_current(state.clone(), input(), Duration::from_millis(20)).await;
        assert!(matches!(response, Err(ApiError::Timeout)));
        assert_eq!(state.match_requests.available_permits(), 2);
        let task = tokio::spawn(run_current(state.clone(), input(), MATCH_TIMEOUT));
        tokio::time::timeout(Duration::from_secs(1), async {
            while state.match_requests.available_permits() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(state.match_requests.available_permits(), 2);
        let task = tokio::spawn(run_current(state.clone(), input(), MATCH_TIMEOUT));
        // Wait until this request has captured its immutable snapshot.
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let captured = state
                    .snapshot
                    .read()
                    .await
                    .as_ref()
                    .is_some_and(|s| Arc::strong_count(s) > 1);
                if captured {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let mut fresh = snapshot();
        fresh.fetched_at = now_ms();
        fresh.generation = "replacement".into();
        state.publish(fresh).await;
        drop(held);
        let response = task.await.unwrap().unwrap();
        let result: Value = serde_json::from_slice(
            &to_bytes(response.into_body(), MAX_CURRENT_BYTES)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(result["generation"], old_generation);
        assert_eq!(result["fetchedAt"], NOW);
        assert_eq!(result["checked"], 1);
        let (_, result) = request(router(state), "POST", "/epg/v1/current", current_body()).await;
        assert_eq!(result["generation"], "replacement");
        assert_eq!(result["stale"], false);
    }

    // Deterministic host-work probe: core tests separately interrupt a real
    // infinite JS loop. Here we test HTTP ownership, queuing and permit cleanup
    // without relying on how fast the evolving matcher handles a fixture.
    fn blocked_match(
        entered: Arc<tokio::sync::Notify>,
        finished: Arc<std::sync::atomic::AtomicBool>,
    ) -> impl FnOnce(Arc<Snapshot>, Vec<ChannelInput>, &MatchBudget) -> anyhow::Result<Value> + Send
    {
        move |_, _, budget| {
            entered.notify_one();
            while !budget.stopped() {
                std::thread::park_timeout(Duration::from_millis(1));
            }
            finished.store(true, std::sync::atomic::Ordering::SeqCst);
            budget.check()?;
            unreachable!("a stopped budget is never a successful empty mapping")
        }
    }

    #[tokio::test]
    async fn hosted_match_queue_deadline_and_drop_release_admission() {
        let state = GuideState::new();
        state.publish(snapshot()).await;
        let held = state.match_execution.clone().acquire_owned().await.unwrap();
        let response = run_match(state.clone(), match_input(), Duration::from_millis(20)).await;
        assert!(matches!(response, Err(ApiError::Timeout)));
        assert_eq!(state.match_requests.available_permits(), 2);
        let task = tokio::spawn(run_match(state.clone(), match_input(), MATCH_TIMEOUT));
        tokio::time::timeout(Duration::from_secs(1), async {
            while state.match_requests.available_permits() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(matches!(task.await, Err(error) if error.is_cancelled()));
        assert_eq!(state.match_requests.available_permits(), 2);
        drop(held);
        assert!(run_match(state, match_input(), MATCH_TIMEOUT).await.is_ok());
    }

    #[tokio::test]
    async fn hosted_match_active_deadline_releases_worker_without_empty_success() {
        let state = GuideState::new();
        state.publish(snapshot()).await;
        let entered = Arc::new(tokio::sync::Notify::new());
        let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let response = run_match_using(
            state.clone(),
            match_input().channels,
            Duration::from_millis(20),
            blocked_match(entered, finished.clone()),
        )
        .await;
        assert!(matches!(response, Err(ApiError::Timeout)));
        let released = tokio::time::timeout(
            Duration::from_secs(1),
            state.match_execution.clone().acquire_owned(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(finished.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(state.match_requests.available_permits(), 2);
        drop(released);
        let response = ApiError::Timeout.into_response();
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
        let data: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(data["error"]["code"], "EPG_TIMEOUT");
        assert!(data.get("mappings").is_none());
        assert!(run_match(state, match_input(), MATCH_TIMEOUT).await.is_ok());
    }

    #[test]
    fn hosted_match_cancelled_blocking_queue_releases_permits_before_dequeue() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let state = GuideState::new();
            state.publish(snapshot()).await;
            let (release, held) = std::sync::mpsc::channel();
            let entered = Arc::new(tokio::sync::Notify::new());
            let signal = entered.clone();
            let blocker = tokio::task::spawn_blocking(move || {
                signal.notify_one();
                let _ = held.recv();
            });
            entered.notified().await;
            let request = tokio::spawn(run_match(state.clone(), match_input(), MATCH_TIMEOUT));
            tokio::time::timeout(Duration::from_secs(1), async {
                while state.match_execution.available_permits() != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            request.abort();
            assert!(matches!(request.await, Err(error) if error.is_cancelled()));
            // The blocking worker is still occupied by an unrelated task. The
            // cancelled queued request must release capacity without running.
            assert_eq!(state.match_execution.available_permits(), 1);
            assert_eq!(state.match_requests.available_permits(), 2);
            release.send(()).unwrap();
            blocker.await.unwrap();
            assert!(run_match(state, match_input(), MATCH_TIMEOUT).await.is_ok());
        });
    }

    #[test]
    fn hosted_programmes_cancelled_blocking_queue_releases_all_permits_before_dequeue() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let state = GuideState::new();
            let fresh = snapshot();
            let generation = fresh.generation.clone();
            state.publish(fresh).await;
            let (release, held) = std::sync::mpsc::channel();
            let entered = Arc::new(tokio::sync::Notify::new());
            let signal = entered.clone();
            let blocker = tokio::task::spawn_blocking(move || {
                signal.notify_one();
                let _ = held.recv();
            });
            entered.notified().await;
            let start = || {
                tokio::spawn(programmes(
                    State(state.clone()),
                    Ok(Query(ProgrammeInput {
                        channel_id: "ren".into(),
                        shift: 0,
                        hours: 8784,
                        generation: generation.clone(),
                    })),
                ))
            };
            let requests: Vec<_> = (0..4).map(|_| start()).collect();
            tokio::time::timeout(Duration::from_secs(1), async {
                while state.programme_requests.available_permits() != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            for request in &requests {
                request.abort();
            }
            for request in requests {
                assert!(matches!(request.await, Err(error) if error.is_cancelled()));
            }
            // The unrelated blocking worker is still occupied. Disconnected
            // consumers must not keep all guide capacity until it is released.
            assert_eq!(state.programme_requests.available_permits(), 4);
            let replacement = start();
            tokio::time::timeout(Duration::from_secs(1), async {
                while state.programme_requests.available_permits() != 3 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            release.send(()).unwrap();
            blocker.await.unwrap();
            let response = tokio::time::timeout(Duration::from_secs(1), replacement)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(state.programme_requests.available_permits(), 4);
        });
    }

    #[tokio::test]
    async fn hosted_match_socket_disconnect_cancels_work_without_starving_guide() {
        use tokio::io::AsyncWriteExt;
        let state = GuideState::new();
        state.publish(snapshot()).await;
        let generation = state
            .snapshot
            .read()
            .await
            .as_ref()
            .unwrap()
            .generation
            .clone();
        let entered = Arc::new(tokio::sync::Notify::new());
        let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let app = router(state.clone()).route(
            "/test-match",
            post({
                let state = state.clone();
                let entered = entered.clone();
                let finished = finished.clone();
                move |Json(input): Json<MatchInput>| {
                    run_match_using(
                        state.clone(),
                        input.channels,
                        MATCH_TIMEOUT,
                        blocked_match(entered.clone(), finished.clone()),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        let body = r#"{"version":1,"source":"epg-one","channels":[]}"#;
        socket.write_all(format!("POST /test-match HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), entered.notified())
            .await
            .unwrap();
        let path =
            format!("/epg/v1/programmes?channelId=ren&shift=0&hours=8784&generation={generation}");
        assert_eq!(
            tokio::time::timeout(
                Duration::from_secs(1),
                request(router(state.clone()), "GET", &path, Value::Null)
            )
            .await
            .unwrap()
            .0,
            StatusCode::OK
        );
        assert_eq!(
            request(router(state.clone()), "GET", "/epg/v1/health", Value::Null)
                .await
                .0,
            StatusCode::OK
        );
        drop(socket);
        let released = tokio::time::timeout(
            Duration::from_secs(1),
            state.match_execution.clone().acquire_owned(),
        )
        .await;
        server.abort();
        let released = released
            .expect("disconnect must cancel active work before the eight-second deadline")
            .unwrap();
        assert!(finished.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(state.match_requests.available_permits(), 2);
        drop(released);
        assert!(run_match(state.clone(), match_input(), MATCH_TIMEOUT)
            .await
            .is_ok());
        assert_eq!(
            state.snapshot.read().await.as_ref().unwrap().generation,
            generation
        );
    }

    async fn request(app: Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        let response = app
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[test]
    fn matching_preserves_id_name_priority_ambiguity_shift_and_metadata() {
        let s = snapshot();
        let result = s
            .matches(
                vec![
                    channel("id", "ren", "Другой", "Other +7"),
                    channel("tvg", "missing", "REN TV", "Другой"),
                    channel("name", "missing", "", "РЕН ТВ HD +3"),
                    channel("ambiguous", "", "Shared Alias", ""),
                    channel("exact", "amb2", "Shared Alias", ""),
                ],
                NOW,
                &MatchBudget::new(MATCH_TIMEOUT),
            )
            .unwrap();
        assert_eq!(result["mappings"]["id"]["channelId"], "ren");
        assert_eq!(result["mappings"]["id"]["shift"], 25200);
        assert_eq!(result["mappings"]["tvg"]["channelId"], "ren");
        assert_eq!(result["mappings"]["name"]["channelId"], "ren");
        assert_eq!(result["mappings"]["name"]["shift"], 10800);
        assert_eq!(
            result["mappings"]["name"]["logo"],
            "https://cdn.epg.one/ren.png"
        );
        // The pinned web profile intentionally keeps the first display alias;
        // an exact XMLTV ID still wins over that ambiguous display name.
        assert_eq!(result["mappings"]["ambiguous"]["channelId"], "amb1");
        assert_eq!(result["mappings"]["exact"]["channelId"], "amb2");
        assert_eq!(result["fetchedAt"], NOW);
        assert_eq!(result["refreshMs"], REFRESH_MS);
        assert_eq!(result["stale"], false);
        assert_eq!(s.metadata(NOW + REFRESH_MS)["stale"], true);
    }

    #[test]
    fn programme_window_archive_timezone_and_shift_are_applied_once() {
        let mut s = snapshot();
        let zero = s.programmes(query(&s, "ren", 0, 0), NOW).ok().unwrap();
        assert_eq!(zero["rows"][0]["time"], NOW / 1000);
        assert_eq!(zero["rows"][0]["time_to"], NOW / 1000 + 3600);
        assert_eq!(zero["rows"][0]["icon"], "");
        let shifted = s.programmes(query(&s, "ren", 25200, 0), NOW).ok().unwrap();
        assert_eq!(shifted["rows"][0]["time"], NOW / 1000 + 25200);
        let clock = (NOW / 1000) as i64;
        let rows = s.programs.get_mut("ren").unwrap();
        rows.clear();
        for (name, start, stop) in [
            ("old", clock - 100 * 3600, clock - 99 * 3600),
            ("touch-from", clock - 49 * 3600, clock - 48 * 3600),
            ("overlap", clock - 48 * 3600 - 1, clock - 48 * 3600 + 1),
            ("future", clock + 48 * 3600 - 1, clock + 49 * 3600),
            ("touch-until", clock + 48 * 3600, clock + 49 * 3600),
        ] {
            rows.push(xmltv::Programme {
                start,
                stop,
                title: name.into(),
                ..Default::default()
            });
        }
        let default = s.programmes(query(&s, "ren", 0, 0), NOW).ok().unwrap();
        let names: Vec<_> = default["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["overlap", "future"]);
        let archive = s.programmes(query(&s, "ren", 0, 168), NOW).ok().unwrap();
        assert_eq!(archive["rows"].as_array().unwrap().len(), 4);
        assert!(
            s.programmes(query(&s, "other", 0, 168), NOW).ok().unwrap()["rows"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let mut old = query(&s, "ren", 0, 0);
        old.generation = "previous".into();
        assert!(matches!(s.programmes(old, NOW), Err(ApiError::Generation)));
        assert!(matches!(
            s.programmes(query(&s, "missing", 0, 0), NOW),
            Err(ApiError::NotFound)
        ));
    }

    #[tokio::test]
    async fn cold_errors_and_schema_are_bounded_and_never_cached() {
        let state = GuideState::new();
        let app = router(state.clone());
        let valid = json!({"version":1,"source":SOURCE,"channels":[]});
        for path in [
            "/epg/v1/health",
            "/epg/v1/programmes?channelId=ren&shift=0&hours=168&generation=test",
        ] {
            let (status, data) = request(app.clone(), "GET", path, Value::Null).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(data["error"]["code"], "EPG_NOT_READY");
        }
        assert_eq!(
            request(app.clone(), "POST", "/epg/v1/match", valid.clone())
                .await
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        for bad in [
            json!({"version":1,"source":"https://private/","channels":[]}),
            json!({"version":1,"source":SOURCE,"channels":[],"url":"http://private/"}),
            json!({"version":1,"source":SOURCE,"channels":[{"id":"a","tvgId":"","tvgName":"","name":"","stream":"private"}]}),
            json!({"version":1,"source":SOURCE,"channels":[{"id":"a","tvgId":"","tvgName":"","name":""},{"id":"a","tvgId":"","tvgName":"","name":""}]}),
        ] {
            let (status, data) = request(app.clone(), "POST", "/epg/v1/match", bad).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert!(!data.to_string().contains("private"));
        }
        for suffix in ["&url=http://private/", "&shift=1", "&hours=8785"] {
            let path = format!(
                "/epg/v1/programmes?channelId=ren&shift=0&hours=168&generation=test{suffix}"
            );
            assert_eq!(
                request(app.clone(), "GET", &path, Value::Null).await.0,
                StatusCode::BAD_REQUEST
            );
        }
        for path in ["/proxy", "/api/epg/channels", "/", "/control"] {
            assert_eq!(
                request(app.clone(), "GET", path, Value::Null).await.0,
                StatusCode::NOT_FOUND
            );
        }
        let oversized =
            json!({"version":1,"source":SOURCE,"channels":[],"padding":"x".repeat(524288)});
        assert_eq!(
            request(app, "POST", "/epg/v1/match", oversized).await.0,
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }

    #[tokio::test]
    async fn refresh_keeps_good_snapshot_and_generations_are_coherent() {
        let state = GuideState::new();
        let first = snapshot();
        let generation = first.generation.clone();
        state.publish(first).await;
        assert!(Snapshot::from_xml("<tv><channel id='x'/>", NOW + 1).is_err());
        assert!(Snapshot::from_xml(r#"<tv><channel id="a"/><programme channel="b" start="20260929090000 +0000" stop="20260929100000 +0000"/></tv>"#, NOW+1).is_err());
        assert_eq!(
            state.snapshot.read().await.as_ref().unwrap().generation,
            generation
        );
        let app = router(state.clone());
        let (status, matched) = request(app.clone(), "POST", "/epg/v1/match", json!({"version":1,"source":SOURCE,"channels":[{"id":"c","tvgId":"ren","tvgName":"","name":"РЕН ТВ"}]})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(matched["generation"], generation);
        assert_eq!(matched["mappings"]["c"]["channelId"], "ren");
        state
            .publish(Snapshot::from_xml(XML, NOW + 1).unwrap())
            .await;
        let path =
            format!("/epg/v1/programmes?channelId=ren&shift=0&hours=168&generation={generation}");
        assert_eq!(
            request(app.clone(), "GET", &path, Value::Null).await.0,
            StatusCode::CONFLICT
        );
        let permit = state
            .match_requests
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        assert_eq!(
            request(
                app.clone(),
                "POST",
                "/epg/v1/match",
                json!({"version":1,"source":SOURCE,"channels":[]})
            )
            .await
            .0,
            StatusCode::TOO_MANY_REQUESTS
        );
        let current = state
            .snapshot
            .read()
            .await
            .as_ref()
            .unwrap()
            .generation
            .clone();
        let current_path =
            format!("/epg/v1/programmes?channelId=ren&shift=0&hours=168&generation={current}");
        // Match admission remains saturated. Guide requests have independent
        // capacity and never need the shared matcher context's lock.
        assert_eq!(
            request(app.clone(), "GET", &current_path, Value::Null)
                .await
                .0,
            StatusCode::OK
        );
        let guide_permits = state
            .programme_requests
            .clone()
            .acquire_many_owned(4)
            .await
            .unwrap();
        assert_eq!(
            request(app.clone(), "GET", &current_path, Value::Null)
                .await
                .0,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            request(app, "GET", "/epg/v1/health", Value::Null).await.0,
            StatusCode::OK
        );
        drop(guide_permits);
        drop(permit);
    }

    #[test]
    fn response_budgets_fail_instead_of_returning_partial_archive() {
        let mut s = snapshot();
        let row = s.programs["ren"][0].clone();
        s.programs
            .insert("ren".into(), vec![row.clone(); MAX_ROWS + 1]);
        assert!(matches!(
            s.programmes(query(&s, "ren", 0, 0), NOW),
            Err(ApiError::Limit)
        ));
        s.programs.insert(
            "ren".into(),
            vec![xmltv::Programme {
                title: "😀".repeat(MAX_ROW_BYTES / 4),
                ..row
            }],
        );
        assert!(matches!(
            s.programmes(query(&s, "ren", 0, 0), NOW),
            Err(ApiError::Limit)
        ));
    }

    /// Offline qualification only: no fetches, credentials or synthetic timing
    /// assertions. Feed and reference clock are supplied explicitly by the runner.
    #[test]
    #[ignore = "requires a retained public XMLTV gzip and output directory"]
    fn hosted_retained_feed_qualification() {
        let path = std::env::var("OTTPLAY_EPG_TEST_GZIP").expect("public fixture path");
        let output = std::env::var("OTTPLAY_EPG_TEST_OUTPUT").expect("output directory");
        let now: u64 = std::env::var("OTTPLAY_EPG_TEST_NOW")
            .expect("reference epoch seconds")
            .parse::<u64>()
            .unwrap()
            * 1000;
        let started = std::time::Instant::now();
        let mut xml = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(path).unwrap())
            .read_to_string(&mut xml)
            .unwrap();
        let decoded_ms = started.elapsed().as_millis();
        let snapshot = Snapshot::from_xml(&xml, now).unwrap();
        let ready_ms = started.elapsed().as_millis();
        let matches = snapshot
            .matches(
                vec![
                    channel("ren", "hlsproxy-382", "", "РЕН ТВ HD"),
                    channel("plus7", "18", "", "РЕН ТВ +7"),
                ],
                now,
                &MatchBudget::new(MATCH_TIMEOUT),
            )
            .unwrap();
        assert_eq!(matches["mappings"]["ren"]["channelId"], "18");
        assert_eq!(matches["mappings"]["plus7"]["shift"], 25200);
        let mut cases = Map::new();
        for (label, shift, hours) in [
            ("ren48", 0, 48),
            ("ren168", 0, 168),
            ("ren336", 0, 336),
            ("renPlus7", 25200, 48),
            ("renMinus3", -10800, 48),
        ] {
            let result = snapshot
                .programmes(query(&snapshot, "18", shift, hours), now)
                .ok()
                .unwrap();
            cases.insert(label.into(), result["rows"].clone());
        }
        let mut report = json!({"referenceEpoch":now/1000,"decodeMs":decoded_ms,"readyMs":ready_ms,"xmlBytes":xml.len(),
            "channels":snapshot.channels.len(),"programmes":snapshot.programs.values().map(Vec::len).sum::<usize>(),
            "matchAndQueryMs":started.elapsed().as_millis()-ready_ms,"cases":cases});
        if std::env::var("OTTPLAY_EPG_TEST_REFRESH").as_deref() == Ok("1") {
            let refresh_started = std::time::Instant::now();
            let replacement = Snapshot::from_xml(&xml, now + 1).unwrap();
            assert_ne!(replacement.generation, snapshot.generation);
            assert_eq!(
                replacement.programs["18"].len(),
                snapshot.programs["18"].len()
            );
            assert!(matches!(
                replacement.programmes(query(&snapshot, "18", 0, 48), now),
                Err(ApiError::Generation)
            ));
            report["refreshMsWithOldSnapshotHeld"] = json!(refresh_started.elapsed().as_millis());
            // Both snapshots remain alive through the comparison to exercise
            // the actual refresh peak, not just cold-start allocation.
            drop(replacement);
        }
        std::fs::write(
            std::path::Path::new(&output).join("server-feed-qualification.json"),
            serde_json::to_vec(&report).unwrap(),
        )
        .unwrap();
        println!(
            "hosted feed qualification: channels={} programmes={} ready={}ms match+queries={}ms",
            report["channels"], report["programmes"], ready_ms, report["matchAndQueryMs"]
        );
    }
}
