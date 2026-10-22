//! Native-shell XMLTV sources. Browser companion configuration is untouched.
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex as SyncMutex, Weak};
use tokio::sync::Mutex;
use serde::Deserialize;
use crate::xmltv::{self, XmltvCache};
use crate::shared_guide;

/// Data and its complete native alias index are published as one immutable generation.
/// Retaining an Arc keeps both alive while a refresh replaces the current snapshot.
pub struct NativeSnapshot {
    cache: XmltvCache,
    index: xmltv::MatchIndex,
    programme_count: usize,
}

impl NativeSnapshot {
    /// Builds a QuickJS index; call on a blocking worker in async applications.
    pub fn new(cache: XmltvCache) -> anyhow::Result<Self> {
        let index = build_index(&cache)?;
        let programme_count = cache.programs.values().map(Vec::len).sum();
        Ok(Self { cache, index, programme_count })
    }

    pub fn cache(&self) -> &XmltvCache { &self.cache }

    pub fn index(&self) -> &xmltv::MatchIndex { &self.index }

    pub fn counts(&self) -> (usize, usize) {
        (self.cache.channels.len(), self.programme_count)
    }

    pub fn resolve(&self, tvg_id: &str, tvg_name: &str, name: &str) -> anyhow::Result<Option<String>> {
        resolve_in_index(&self.cache, &self.index, tvg_id, tvg_name, name)
    }
}

#[derive(Clone, Debug)]
struct SourceError(Arc<anyhow::Error>);

impl std::fmt::Display for SourceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self.0.as_ref(), formatter)
    }
}

impl std::error::Error for SourceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0.source()
    }
}

type SourceResult = Result<Arc<NativeSnapshot>, SourceError>;
type SourceAttempt = Mutex<Option<SourceResult>>;

#[derive(Default)]
struct SourceState {
    cache: Option<Arc<NativeSnapshot>>,
    attempt: Weak<SourceAttempt>,
}

#[derive(Default)]
struct SourceSlot(SyncMutex<SourceState>);

#[derive(Default)]
struct SourceRegistry {
    resident: HashMap<Vec<String>, Arc<SourceSlot>>,
    // Eviction drops cache residency, not the identity of an active refresh.
    active: HashMap<Vec<String>, Weak<SourceSlot>>,
}

impl SourceRegistry {
    fn acquire(&mut self, urls: &[String]) -> anyhow::Result<Arc<SourceSlot>> {
        self.active.retain(|_, slot| slot.strong_count() != 0);
        let slot = self.active.get(urls).and_then(Weak::upgrade)
            .unwrap_or_else(|| Arc::new(SourceSlot::default()));
        if shared_guide::evict_source_set(self.resident.len(), self.resident.contains_key(urls))? {
            if let Some(key) = self.resident.keys().next().cloned() { self.resident.remove(&key); }
        }
        self.resident.insert(urls.to_vec(), slot.clone());
        self.active.insert(urls.to_vec(), Arc::downgrade(&slot));
        Ok(slot)
    }
}

static SOURCES: LazyLock<Mutex<SourceRegistry>> = LazyLock::new(|| Mutex::new(SourceRegistry::default()));

#[derive(Clone, Debug, Default, Deserialize)]
pub struct MatchChannel {
    #[serde(default)] pub tvg_id: String,
    #[serde(default)] pub tvg_name: String,
    #[serde(default)] pub name: String,
    #[serde(default)] pub xmltv_urls: Vec<String>,
}

/// New headers retain exact IDs and URL schemes; old browser bodies remain valid.
pub fn match_metadata(body: &str) -> HashMap<String, MatchChannel> {
    #[derive(Default, Deserialize)]
    struct Header { #[serde(default)] native_channels: HashMap<String, MatchChannel> }
    serde_json::from_str::<Header>(body.split("\n\t\n").next().unwrap_or("{}"))
        .unwrap_or_default().native_channels
}

pub fn match_ids(body: &str) -> Vec<String> {
    body.split("\n\t\n").nth(2).unwrap_or("").lines()
        .filter_map(|line| line.split('-').next().filter(|id| !id.is_empty()).map(String::from)).collect()
}

/// Explicit XMLTV IDs are authoritative; names are a fallback, in provider order.
/// One-off helper; repeated queries should reuse `NativeSnapshot::resolve`.
pub fn resolve_id(cache: &XmltvCache, tvg_id: &str, tvg_name: &str, name: &str) -> anyhow::Result<Option<String>> {
    resolve_in_index(cache, &build_index(cache)?, tvg_id, tvg_name, name)
}

pub fn build_index(cache: &XmltvCache) -> anyhow::Result<xmltv::MatchIndex> {
    let mut rows = Vec::new();
    let mut ids: Vec<_> = cache.channels.keys().collect();
    ids.sort();
    for id in ids {
        let channel = &cache.channels[id];
        let names = if channel.names.is_empty() { vec![channel.name.clone()] } else { channel.names.clone() };
        for name in names { rows.push(vec![id.clone(), name]); }
    }
    xmltv::MatchIndex::new(rows)
}

pub fn resolve_in_index(_cache: &XmltvCache, index: &xmltv::MatchIndex, tvg_id: &str, tvg_name: &str, name: &str) -> anyhow::Result<Option<String>> {
    index.resolve(tvg_id, &[tvg_name, name])
}

/// First feed defining an ID owns that channel and its programmes.
pub fn merge_source(target: &mut XmltvCache, mut source: XmltvCache) -> anyhow::Result<()> {
    let ids = shared_guide::unowned(target.channels.keys().cloned().collect(), source.channels.keys().cloned().collect())?;
    for id in ids {
        if let Some(channel) = source.channels.remove(&id) { target.channels.insert(id.clone(), channel); }
        if let Some(programs) = source.programs.remove(&id) { target.programs.insert(id, programs); }
    }
    Ok(())
}

pub async fn load_sources(urls: &[String]) -> anyhow::Result<Arc<NativeSnapshot>> {
    load_sources_inner(urls, None).await
}

pub async fn load_sources_tracked(
    urls: &[String],
    work: crate::background_work::WorkLease,
) -> anyhow::Result<Arc<NativeSnapshot>> {
    load_sources_inner(urls, Some(work)).await
}

async fn load_sources_inner(
    urls: &[String],
    work: Option<crate::background_work::WorkLease>,
) -> anyhow::Result<Arc<NativeSnapshot>> {
    anyhow::ensure!(!urls.is_empty(), "No XMLTV sources");
    anyhow::ensure!(urls.iter().all(|url| url.starts_with("http://") || url.starts_with("https://")), "Invalid XMLTV URL");
    let slot = SOURCES.lock().await.acquire(urls)?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
    let (cache, attempt) = {
        let mut state = slot.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(cache) = state.cache.as_ref() {
            if shared_guide::source_fresh(now.saturating_sub(cache.cache.fetched_at))? { return Ok(cache.clone()); }
        }
        let attempt = state.attempt.upgrade().unwrap_or_else(|| {
            let attempt = Arc::new(SourceAttempt::new(None));
            state.attempt = Arc::downgrade(&attempt);
            attempt
        });
        (state.cache.clone(), attempt)
    };
    // The guard serializes leaders; cancellation leaves an unfinished attempt
    // for a waiting caller to take over instead of stranding its subscribers.
    let mut result = attempt.lock().await;
    if result.is_none() {
        let refreshed = refresh_sources(urls, cache, now, work.clone())
            .await
            .map_err(|error| SourceError(Arc::new(error)));
        let mut state = slot.0.lock().unwrap_or_else(|error| error.into_inner());
        let publish = || {
            if let Ok(cache) = &refreshed {
                state.cache = Some(cache.clone());
            }
            *result = Some(refreshed);
        };
        if let Some(work) = &work {
            work.publish(publish).map_err(anyhow::Error::msg)?;
        } else {
            publish();
        }
        // Callers already holding this attempt share even STALE/FAIL. A later
        // independent request retries normally, without altering fetched_at.
        state.attempt = Weak::new();
    }
    result.as_ref().expect("source attempt completed").clone().map_err(Into::into)
}

async fn refresh_sources(
    urls: &[String],
    cache: Option<Arc<NativeSnapshot>>,
    now: u64,
    work: Option<crate::background_work::WorkLease>,
) -> anyhow::Result<Arc<NativeSnapshot>> {
    let mut merged = XmltvCache::default();
    let mut last_error = None;
    for url in urls {
        let fetched = match &work {
            Some(work) => {
                work.check().map_err(anyhow::Error::msg)?;
                xmltv::fetch_single_tracked(url, true, work.clone()).await
            }
            None => xmltv::fetch_single_native(url).await,
        };
        if let Some(work) = &work {
            work.check().map_err(anyhow::Error::msg)?;
        }
        match fetched {
            Ok((channels, programs)) => merge_source(
                &mut merged,
                XmltvCache {
                    channels,
                    programs,
                    fetched_at: now,
                },
            )?,
            Err(error) => last_error = Some(error),
        }
    }
    match shared_guide::source_refresh(
        last_error.is_some(),
        merged.channels.is_empty(),
        cache.is_some(),
    )?
    .as_str()
    {
        // A partial refresh retains ownership for this exact ordered source set.
        "STALE" => return Ok(cache.expect("core selected an existing stale entry")),
        "FAIL" => return Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Empty XMLTV sources"))),
        "REPLACE" => (),
        _ => anyhow::bail!("Invalid shared guide refresh decision"),
    }
    merged.fetched_at = now;
    Ok(Arc::new(
        tokio::task::spawn_blocking(move || {
            if let Some(work) = &work {
                work.check().map_err(anyhow::Error::msg)?;
            }
            let result = NativeSnapshot::new(merged);
            if let Some(work) = &work {
                work.check().map_err(anyhow::Error::msg)?;
            }
            result
        })
        .await??,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::sync::{mpsc, Semaphore};

    struct GatedFeed {
        urls: Vec<String>,
        calls: Arc<AtomicUsize>,
        healthy: Arc<AtomicBool>,
        release: Arc<Semaphore>,
        started: mpsc::UnboundedReceiver<usize>,
        server: tokio::task::JoinHandle<()>,
    }

    impl Drop for GatedFeed { fn drop(&mut self) { self.server.abort(); } }

    impl GatedFeed {
        async fn new() -> Self {
            use axum::{http::StatusCode, routing::get, Router};
            let calls = Arc::new(AtomicUsize::new(0));
            let healthy = Arc::new(AtomicBool::new(false));
            let release = Arc::new(Semaphore::new(0));
            let (started, receiver) = mpsc::unbounded_channel();
            let app = Router::new().route("/feed", get({
                let calls = calls.clone(); let healthy = healthy.clone(); let release = release.clone();
                move || {
                    let calls = calls.clone(); let healthy = healthy.clone();
                    let release = release.clone(); let started = started.clone();
                    async move {
                        let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
                        let _ = started.send(call);
                        release.acquire().await.unwrap().forget();
                        if healthy.load(Ordering::SeqCst) {
                            (StatusCode::OK, "<tv><channel id=\"fresh\"><display-name>Fresh</display-name></channel></tv>")
                        } else { (StatusCode::SERVICE_UNAVAILABLE, "offline") }
                    }
                }
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let urls = vec![format!("http://{}/feed", listener.local_addr().unwrap())];
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
            Self { urls, calls, healthy, release, started: receiver, server }
        }

        async fn next_call(&mut self, expected: usize) {
            assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(3), self.started.recv()).await.unwrap(), Some(expected));
        }

        fn request(&self) -> tokio::task::JoinHandle<anyhow::Result<Arc<NativeSnapshot>>> {
            let urls = self.urls.clone();
            tokio::spawn(async move { load_sources(&urls).await })
        }

        async fn complete(request: tokio::task::JoinHandle<anyhow::Result<Arc<NativeSnapshot>>>) -> anyhow::Result<Arc<NativeSnapshot>> {
            tokio::time::timeout(std::time::Duration::from_secs(3), request).await.unwrap().unwrap()
        }
    }

    async fn wait_subscribers(slot: &SourceSlot, count: usize) {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if slot.0.lock().unwrap().attempt.strong_count() == count { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
    }

    async fn remove_sources(urls: &[String]) {
        let mut sources = SOURCES.lock().await;
        sources.resident.remove(urls);
        sources.active.remove(urls);
    }

    #[tokio::test]
    async fn standby_drops_custom_feed_and_wake_can_retry_without_stale_publication() {
        let mut feed = GatedFeed::new().await;
        let background = crate::background_work::BackgroundWork::default();
        let work = background.enter().unwrap();
        let urls = feed.urls.clone();
        let request = tokio::spawn(async move {
            work.run(load_sources_tracked(&urls, work.clone())).await
        });
        feed.next_call(1).await;
        background.set_standby(true);
        assert!(tokio::time::timeout(std::time::Duration::from_secs(2), request).await.unwrap().unwrap().is_err());
        assert!(background.status().quiescent);
        background.set_standby(false);
        feed.healthy.store(true, Ordering::SeqCst);
        feed.release.add_permits(2);
        let work = background.enter().unwrap();
        let result = work.run(load_sources_tracked(&feed.urls, work.clone())).await.unwrap().unwrap();
        assert_eq!(result.counts().0, 1);
        assert_eq!(feed.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn failed_refresh_is_shared_by_queued_callers_but_next_request_retries() {
        for with_stale in [false, true] {
            let mut feed = GatedFeed::new().await;
            let slot = SOURCES.lock().await.acquire(&feed.urls).unwrap();
            let stale = Arc::new(NativeSnapshot::new(fixture("old", "Old", "old schedule")).unwrap());
            if with_stale { slot.0.lock().unwrap().cache = Some(stale.clone()); }
            let mut requests = vec![feed.request()];
            feed.next_call(1).await;
            requests.extend((0..3).map(|_| feed.request()));
            wait_subscribers(&slot, 4).await;
            // A cancelled follower must not cancel the leader or its other waiters.
            let cancelled = requests.pop().unwrap();
            cancelled.abort();
            assert!(matches!(tokio::time::timeout(std::time::Duration::from_secs(3), cancelled).await.unwrap(), Err(error) if error.is_cancelled()));
            wait_subscribers(&slot, 3).await;
            feed.release.add_permits(3);
            let mut errors = Vec::new();
            for request in requests {
                match GatedFeed::complete(request).await {
                    Ok(snapshot) => {
                        assert!(with_stale);
                        assert!(Arc::ptr_eq(&snapshot, &stale));
                        assert_eq!(snapshot.cache().fetched_at, 0);
                    }
                    Err(error) => { assert!(!with_stale); errors.push(format!("{error:#}")); }
                }
            }
            assert_eq!(feed.calls.load(Ordering::SeqCst), 1, "queued callers must share the failed attempt");
            if !with_stale {
                assert_eq!(errors.len(), 3);
                assert!(errors.iter().all(|error| error == &errors[0] && error.contains("503")));
                assert!(slot.0.lock().unwrap().cache.is_none());
            }
            // No failure TTL: an independent request immediately performs a new attempt.
            feed.healthy.store(true, Ordering::SeqCst);
            let recovered = feed.request();
            feed.next_call(2).await;
            let snapshot = GatedFeed::complete(recovered).await.unwrap();
            assert_eq!(snapshot.resolve("fresh", "", "").unwrap().as_deref(), Some("fresh"));
            assert!(!Arc::ptr_eq(&snapshot, &stale));
            assert!(Arc::ptr_eq(&GatedFeed::complete(feed.request()).await.unwrap(), &snapshot));
            assert_eq!(feed.calls.load(Ordering::SeqCst), 2, "ordinary fresh reuse remains unchanged");
            remove_sources(&feed.urls).await;
        }
    }

    #[tokio::test]
    async fn cancelled_refresh_leader_can_be_replaced_by_waiter_or_next_request() {
        for with_waiter in [false, true] {
            let mut feed = GatedFeed::new().await;
            feed.healthy.store(true, Ordering::SeqCst);
            let slot = SOURCES.lock().await.acquire(&feed.urls).unwrap();
            let leader = feed.request();
            feed.next_call(1).await;
            let waiting = if with_waiter {
                let request = feed.request();
                wait_subscribers(&slot, 2).await;
                Some(request)
            } else { None };
            leader.abort();
            assert!(matches!(tokio::time::timeout(std::time::Duration::from_secs(3), leader).await.unwrap(), Err(error) if error.is_cancelled()));
            let successor = waiting.unwrap_or_else(|| feed.request());
            feed.next_call(2).await;
            feed.release.add_permits(2);
            let snapshot = GatedFeed::complete(successor).await.unwrap();
            assert_eq!(snapshot.resolve("fresh", "", "").unwrap().as_deref(), Some("fresh"));
            assert!(Arc::ptr_eq(&GatedFeed::complete(feed.request()).await.unwrap(), &snapshot));
            assert_eq!(feed.calls.load(Ordering::SeqCst), 2);
            remove_sources(&feed.urls).await;
        }
    }

    #[test]
    fn resident_eviction_keeps_active_source_identity_and_shared_attempt() {
        let mut registry = SourceRegistry::default();
        while !shared_guide::evict_source_set(registry.resident.len(), false).unwrap() {
            let urls = vec![format!("https://fixture/{}/feed", registry.resident.len())];
            registry.acquire(&urls).unwrap();
        }
        let capacity = registry.resident.len();
        let victim = registry.resident.keys().next().unwrap().clone();
        let held = registry.resident[&victim].clone();
        let attempt = Arc::new(SourceAttempt::new(None));
        held.0.lock().unwrap().attempt = Arc::downgrade(&attempt);
        registry.acquire(&["https://fixture/new/feed".into()]).unwrap();
        assert!(!registry.resident.contains_key(&victim));
        let reacquired = registry.acquire(&victim).unwrap();
        assert!(Arc::ptr_eq(&held, &reacquired));
        assert!(Arc::ptr_eq(&attempt, &reacquired.0.lock().unwrap().attempt.upgrade().unwrap()));
        assert_eq!(registry.resident.len(), capacity);
    }

    #[test]
    fn shared_source_errors_retain_original_context_and_cause() {
        let original = anyhow::Error::new(std::io::Error::other("fixture cause")).context("fixture context");
        let shared = SourceError(Arc::new(original));
        let error: anyhow::Error = shared.clone().into();
        assert_eq!(error.to_string(), "fixture context");
        assert_eq!(error.chain().last().unwrap().to_string(), "fixture cause");
        assert_eq!(format!("{error:#}"), "fixture context: fixture cause");
        assert_eq!(format!("{shared:#}"), "fixture context: fixture cause");
    }

    #[tokio::test]
    async fn partial_refresh_preserves_old_ownership_only_for_the_same_ordered_sources() {
        use axum::{http::StatusCode, routing::get, Router};
        let app = Router::new()
            .route("/bad", get(|| async { (StatusCode::BAD_GATEWAY, "offline") }))
            .route("/good", get(|| async { "<tv><channel id=\"private-id\"><display-name>Later source</display-name></channel></tv>" }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        struct Server(tokio::task::JoinHandle<()>);
        impl Drop for Server { fn drop(&mut self) { self.0.abort(); } }
        let _server = Server(tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); }));
        let urls = vec![format!("http://{address}/bad"), format!("http://{address}/good")];
        let stale = Arc::new(NativeSnapshot::new(fixture("private-id", "Earlier source", "original schedule")).unwrap());
        let slot = SOURCES.lock().await.acquire(&urls).unwrap();
        slot.0.lock().unwrap().cache = Some(stale.clone());
        let retained = load_sources(&urls).await.unwrap();
        assert!(Arc::ptr_eq(&retained, &stale));
        assert_eq!(retained.cache.programs["private-id"][0].title, "original schedule");
        let reversed: Vec<_> = urls.iter().rev().cloned().collect();
        let partial = load_sources(&reversed).await.unwrap();
        assert_eq!(partial.cache.channels["private-id"].name, "Later source");
        assert!(!Arc::ptr_eq(&partial, &stale));
        assert!(load_sources(&urls[..1]).await.is_err());
        remove_sources(&urls).await; remove_sources(&reversed).await; remove_sources(&urls[..1]).await;
    }
    fn fixture(id: &str, name: &str, title: &str) -> XmltvCache {
        XmltvCache { channels: HashMap::from([(id.into(), xmltv::Channel { id: id.into(), name: name.into(), icon: "https://fixture/logo.png".into(), names: vec![name.into()] })]),
            programs: HashMap::from([(id.into(), vec![xmltv::Programme { title: title.into(), ..Default::default() }])]), ..Default::default() }
    }
    #[test]
    fn exact_id_wins_and_source_priority_is_stable() {
        let mut cache = fixture("private-id", "One", "first feed");
        merge_source(&mut cache, fixture("private-id", "Wrong", "second feed")).unwrap();
        merge_source(&mut cache, fixture("other", "Other", "other feed")).unwrap();
        assert_eq!(resolve_id(&cache, "private-id", "Other", "Other").unwrap(), Some("private-id".into()));
        assert_eq!(cache.programs["private-id"][0].title, "first feed");
        assert_eq!(resolve_id(&cache, "missing", "Other", "One").unwrap(), Some("other".into()));
    }
    #[test]
    fn exact_display_name_wins_before_fuzzy_tvg_name_and_aliases_survive() {
        let mut cache = fixture("news", "News", "news");
        merge_source(&mut cache, fixture("cinema", "Cinema", "cinema")).unwrap();
        cache.channels.get_mut("cinema").unwrap().names.push("Films".into());
        assert_eq!(resolve_id(&cache, "missing", "News Extra", "Cinema").unwrap(), Some("cinema".into()));
        assert_eq!(resolve_id(&cache, "missing", "Films", "Renamed").unwrap(), Some("cinema".into()));
    }
    fn portrait_snapshot(ids: [&str; 2], reversed: bool, native: bool) -> NativeSnapshot {
        let base = format!(r#"<channel id="{}"><display-name>СТС Love</display-name><display-name>СТС Love orig</display-name></channel>"#, ids[0]);
        let regional = format!(r#"<channel id="{}"><display-name>СТС LOVE (+7)</display-name><display-name>СТС Love +7</display-name></channel>"#, ids[1]);
        let channels = if reversed { regional + &base } else { base + &regional };
        // Public-feed episode from the report: the regional schedule is seven
        // hours earlier, although its programme title is exactly the same.
        let xml = format!(r#"<tv>{channels}
            <programme channel="{}" start="20260930080300 +0300" stop="20260930081000 +0300"><title>Три кота (Портрет). Сезон: 3, Серия: 43.</title></programme>
            <programme channel="{}" start="20260930010300 +0300" stop="20260930011000 +0300"><title>Три кота (Портрет). Сезон: 3, Серия: 43.</title></programme></tv>"#, ids[0], ids[1]);
        let (channels, programs) = if native {
            xmltv::parse_xmltv_native(&xml).unwrap()
        } else {
            // Tauri's default feed uses the same parser as the HTTP server.
            xmltv::parse_xmltv(&xml).unwrap()
        };
        assert_eq!(programs[ids[0]][0].start, 1_790_744_580);
        assert_eq!(programs[ids[1]][0].start, 1_790_719_380);
        NativeSnapshot::new(XmltvCache { channels, programs, ..Default::default() }).unwrap()
    }

    fn assert_unshifted_portrait(tvg_id: &str) {
        for ids in [["1322", "1109"], ["a-base", "z-regional"], ["z-base", "a-regional"]] {
            for reversed in [false, true] {
                for native in [false, true] {
                    let snapshot = portrait_snapshot(ids, reversed, native);
                    let id = snapshot.resolve(tvg_id, "", "СТС Love").unwrap().unwrap();
                    assert_eq!(id, ids[0], "tvg_id={tvg_id:?}, native={native}, reversed={reversed}");
                    let programme = &snapshot.cache().programs[&id][0];
                    assert_eq!(programme.start, 1_790_744_580);
                    let now = 1_790_744_880; // 22:08 PDT: base programme is current.
                    assert!(programme.start <= now && now < programme.stop);
                    assert_eq!(snapshot.index().extract_time_shift("СТС Love").unwrap(), 0);
                }
            }
        }
    }

    #[test]
    fn native_unshifted_name_without_tvg_id_keeps_base_schedule() {
        assert_unshifted_portrait("");
    }

    #[test]
    fn native_unshifted_name_with_foreign_tvg_id_keeps_base_schedule() {
        assert_unshifted_portrait("hlsproxy-409");
    }

    #[test]
    fn native_real_xmltv_id_remains_authoritative_with_regional_aliases() {
        for native in [false, true] {
            let snapshot = portrait_snapshot(["1322", "1109"], false, native);
            for (tvg_id, name, expected_time) in [
                ("1322", "СТС Love +7", 1_790_744_580),
                ("1109", "СТС Love", 1_790_719_380),
            ] {
                let id = snapshot.resolve(tvg_id, "", name).unwrap().unwrap();
                assert_eq!(id, tvg_id, "an existing XMLTV ID is authoritative");
                assert_eq!(snapshot.cache().programs[&id][0].start, expected_time);
            }
        }
    }
    #[tokio::test]
    async fn retained_native_index_preserves_aliases_shifts_slices_and_old_generation() {
        let mut cache = fixture("news", "News", "current");
        merge_source(&mut cache, fixture("cinema", "Cinema", "film")).unwrap();
        cache.channels.get_mut("cinema").unwrap().names.push("Films".into());
        let now = chrono::Utc::now().timestamp();
        cache.programs.insert("news".into(), vec![
            xmltv::Programme { start: now - 72 * 3600, stop: now - 71 * 3600, title: "archive".into(), ..Default::default() },
            xmltv::Programme { start: now - 1800, stop: now + 1800, title: "current".into(), ..Default::default() },
            xmltv::Programme { start: now + 24 * 3600, stop: now + 25 * 3600, title: "future".into(), ..Default::default() },
        ]);
        let snapshot = Arc::new(NativeSnapshot::new(cache).unwrap());
        for (id, tvg, name, expected) in [
            ("news", "Films", "Cinema", "news"),
            ("missing", "News Extra", "Cinema", "cinema"),
            ("", "Films", "Renamed", "cinema"),
            ("", "", "News +3", "news"),
        ] {
            assert_eq!(snapshot.resolve(id, tvg, name).unwrap().as_deref(), Some(expected));
            assert_eq!(snapshot.resolve(id, tvg, name).unwrap(), resolve_id(&snapshot.cache, id, tvg, name).unwrap());
        }
        assert_eq!(snapshot.index.extract_time_shift("News +3").unwrap(), xmltv::extract_time_shift("News +3").unwrap());
        for archive in [0, 96] {
            let expected = crate::get_epg_slice(&snapshot.cache, "hash", "news", 3, archive).await.unwrap();
            let held = snapshot.clone();
            let actual = tokio::task::spawn_blocking(move || crate::get_epg_slice_with_index(
                &held.cache, &held.index, "hash", "news", 3, archive)).await.unwrap().unwrap();
            assert_eq!(actual, expected);
            assert_eq!(actual["epg_data"].as_array().unwrap().len(), if archive == 0 { 2 } else { 3 });
        }
        let held = snapshot.clone();
        let slot = tokio::sync::RwLock::new(snapshot);
        *slot.write().await = Arc::new(NativeSnapshot::new(fixture("replacement", "Replacement", "new")).unwrap());
        assert_eq!(slot.read().await.resolve("replacement", "", "").unwrap().as_deref(), Some("replacement"));
        let old = tokio::task::spawn_blocking(move || {
            assert_eq!(held.resolve("news", "", "").unwrap().as_deref(), Some("news"));
            assert_eq!(held.cache.programs["news"][1].title, "current");
            held.counts()
        }).await.unwrap();
        assert_eq!(old, (2, 4));
    }
    #[test]
    fn custom_feed_cdata_aliases_and_programme_order() {
        let xml = r#"<tv><channel id="private"><display-name>First</display-name><display-name><![CDATA[Alias & News]]></display-name></channel>
        <programme channel="private" start="20260912110000 +0000" stop="20260912120000 +0000"><title>Later &amp; <![CDATA[News]]></title></programme>
        <programme channel="private" start="20260912100000 +0000" stop="20260912110000 +0000"><title>Earlier</title></programme></tv>"#;
        let (channels, programs) = xmltv::parse_xmltv_native(xml).unwrap();
        assert_eq!(channels["private"].names, ["First", "Alias & News"]);
        assert_eq!(programs["private"][0].title, "Earlier");
        assert_eq!(programs["private"][1].title, "Later & News");
        let (_, browser) = xmltv::parse_xmltv(xml).unwrap();
        assert_eq!(browser["private"].len(), 2, "browser retains main's CDATA support");
        assert_eq!(browser["private"][0].title, "Later & News", "browser retains XML input order");
    }
    #[test]
    fn incomplete_native_feed_is_rejected_before_cache_replacement() {
        let complete = r#"<tv><channel id="a"><display-name>Feed A</display-name></channel></tv>"#;
        let truncated = complete.trim_end_matches("</tv>");
        assert!(xmltv::parse_xmltv_native(truncated).is_err());
        assert!(xmltv::parse_xmltv(truncated).unwrap().0.contains_key("a"), "browser parser behavior remains unchanged");
        assert!(xmltv::parse_xmltv_native("<html>upstream error</html>").is_err());
        assert!(xmltv::parse_xmltv_native("<tv></tv><tv></tv>").is_err());
        assert!(xmltv::parse_xmltv_native("").is_err());
        assert!(xmltv::parse_xmltv_native(complete).unwrap().0.contains_key("a"));
        assert!(xmltv::parse_xmltv_native("<?xml version=\"1.0\"?><tv/>").unwrap().0.is_empty());
    }
    #[test]
    fn native_metadata_retains_sources_and_raw_ids() {
        let body = "{\"native_channels\":{\"42\":{\"tvg_id\":\"private-id\",\"xmltv_urls\":[\"https://fixture/feed.xml?key=x\"]}}}\n\t\nlegacy-raw\n\t\n42-1-2-3~Private";
        assert_eq!(match_ids(body), ["42"]);
        assert_eq!(match_metadata(body)["42"].xmltv_urls, ["https://fixture/feed.xml?key=x"]);
        assert!(match_metadata("{}\n\t\n\n\t\n42-1-2-3~Private").is_empty());
    }
}
