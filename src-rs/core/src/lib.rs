//! XMLTV fetch + parse + SQLite cache.
use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value as JsonValue;
use tokio::sync::RwLock;
use tokio::time::{interval, Duration};

pub mod background_work;
pub mod control_discovery;
pub mod db;
pub mod m3u;
pub mod native_xmltv;
pub mod offline_media;
mod proxy;
pub mod runtime_diagnostics;
mod shared_guide;
pub mod stalker;
pub mod tmdb;
pub mod vportal;
pub mod xmltv;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Fetch XMLTV from `urls`, parse, persist to SQLite, return channels+programs.
pub async fn fetch_xmltv(urls: &[String]) -> anyhow::Result<xmltv::XmltvCache> {
    fetch_xmltv_inner(urls, None).await
}

pub async fn fetch_xmltv_tracked(
    urls: &[String],
    work: background_work::WorkLease,
) -> anyhow::Result<xmltv::XmltvCache> {
    fetch_xmltv_inner(urls, Some(work)).await
}

async fn fetch_xmltv_inner(
    urls: &[String],
    work: Option<background_work::WorkLease>,
) -> anyhow::Result<xmltv::XmltvCache> {
    let refresh = shared_guide::GuideRefresh::new(urls.len())?;
    let mut all_channels: HashMap<String, xmltv::Channel> = HashMap::new();
    let mut all_programs: HashMap<String, Vec<xmltv::Programme>> = HashMap::new();
    let mut failure = None;

    while refresh.action()? == "FETCH" {
        let source_index = refresh.index()?;
        let url = &urls[source_index];
        let fetched = match &work {
            Some(work) => {
                work.check().map_err(anyhow::Error::msg)?;
                xmltv::fetch_single_tracked(url, false, work.clone()).await
            }
            None => xmltv::fetch_single(url).await,
        };
        if let Some(work) = &work {
            work.check().map_err(anyhow::Error::msg)?;
        }
        match fetched {
            Ok((mut ch, pr)) => {
                for id in refresh.unowned(ch.keys().cloned().collect())? {
                    let channel = ch
                        .remove(&id)
                        .expect("shared core selected an incoming channel");
                    all_channels.insert(id, channel);
                }
                for (id, mut progs) in pr {
                    all_programs
                        .entry(id)
                        .and_modify(|existing| existing.append(&mut progs))
                        .or_insert(progs);
                }
                refresh.advance(true, true)?;
            }
            Err(e) => {
                // fetch_single returns only credential-free failure categories.
                let error = anyhow::anyhow!("source {}: {e}", source_index + 1);
                tracing::warn!("XMLTV fetch failed: {error}");
                failure = Some(error);
                refresh.advance(false, true)?;
            }
        }
    }

    let cache = xmltv::XmltvCache {
        channels: all_channels,
        programs: all_programs,
        fetched_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    };

    let mut pool = None;
    loop {
        match refresh.action()?.as_str() {
            "OPEN_DATABASE" => match db::pool().await {
                Ok(opened) => {
                    refresh.advance(true, opened.is_some())?;
                    pool = opened;
                }
                Err(_) => {
                    failure = Some(anyhow::anyhow!("EPG database unavailable"));
                    refresh.advance(false, false)?;
                }
            },
            "WRITE_DATABASE" => {
                let result = db::persist(
                    pool.as_ref().expect("shared core requested an open pool"),
                    &cache,
                )
                .await;
                let succeeded = result.is_ok();
                if result.is_err() {
                    tracing::warn!("EPG database write failed");
                }
                refresh.advance(succeeded, true)?;
            }
            "REPLACE" => return Ok(cache),
            "FAIL" => return Err(failure.expect("shared core retained a refresh failure")),
            _ => anyhow::bail!("Unexpected shared guide refresh action"),
        }
    }
}

/// Shared refresh policy; hosts count rejected refreshes and execute timers.
pub fn epg_refresh_interval(consecutive_failures: u32) -> anyhow::Result<u64> {
    shared_guide::refresh_interval(consecutive_failures)
}

/// Return EPG slice for `channel_id`.
///
/// - `time_shift_hours` is timezone offset only (from channel-name ±Nh / map),
///   never archive/catchup depth.
/// - `archive_hours` is configured catchup/history depth (M3U `rechours` /
///   `catchup-days` → channel.rec). Lookback uses that value when > 0;
///   otherwise the historical ±48h default. Future cushion stays 48h.
pub async fn get_epg_slice(
    cache: &xmltv::XmltvCache,
    _hash: &str,
    channel_id: &str,
    time_shift_hours: i64,
    archive_hours: i64,
) -> anyhow::Result<JsonValue> {
    get_epg_slice_using(
        cache, channel_id, time_shift_hours, archive_hours, shared_guide::slice,
    )
}

/// Return a slice using the snapshot's existing shared-core context.
/// This synchronous operation belongs on a blocking worker in async servers.
pub fn get_epg_slice_with_index(
    cache: &xmltv::XmltvCache,
    index: &xmltv::MatchIndex,
    _hash: &str,
    channel_id: &str,
    time_shift_hours: i64,
    archive_hours: i64,
) -> anyhow::Result<JsonValue> {
    get_epg_slice_using(
        cache, channel_id, time_shift_hours, archive_hours,
        |times, now, archive, shift| index.slice(times, now, archive, shift),
    )
}

fn get_epg_slice_using(
    cache: &xmltv::XmltvCache,
    channel_id: &str,
    time_shift_hours: i64,
    archive_hours: i64,
    select: impl FnOnce(Vec<Vec<f64>>, i64, i64, i64) -> anyhow::Result<Vec<Vec<f64>>>,
) -> anyhow::Result<JsonValue> {
    let now = chrono::Utc::now().timestamp();
    let programs = cache.programs.get(channel_id).map(Vec::as_slice).unwrap_or(&[]);
    let times = programs.iter().map(|p| vec![p.start as f64, p.stop as f64]).collect();
    let rows = select(times, now, archive_hours, time_shift_hours)?;
    let epg_data: Vec<JsonValue> = rows.into_iter().map(|row| {
        let p = &programs[row[0] as usize];
        serde_json::json!({ "time": row[1] as i64, "time_to": row[2] as i64,
            "name": p.title, "descr": p.desc, "icon": p.icon })
    }).collect();
    Ok(serde_json::json!({ "epg_data": epg_data }))
}

/// Fuzzy-match a playlist channel name against XMLTV channels.
/// Returns `(xmltv_channel_id, channel_name, score)`.
pub fn match_channel(
    name: &str,
    channels: &xmltv::Channels,
) -> anyhow::Result<Option<(String, f32)>> {
    xmltv::match_channel(name, channels)
}

/// Background task: refresh XMLTV every 2h, update the shared cache.
pub async fn background_refresh(xmltv_urls: Vec<String>, cache: Arc<RwLock<xmltv::XmltvCache>>) {
    let seconds = match shared_guide::refresh_interval(0) {
        Ok(seconds) => seconds,
        Err(error) => {
            tracing::warn!("XMLTV refresh policy failed: {error}");
            return;
        }
    };
    let mut ticker = interval(Duration::from_secs(seconds));
    loop {
        ticker.tick().await;
        tracing::info!("XMLTV background refresh triggered");
        match fetch_xmltv(&xmltv_urls).await {
            Ok(fresh) => {
                let mut guard = cache.write().await;
                *guard = fresh;
                tracing::info!("XMLTV cache refreshed");
            }
            Err(e) => tracing::warn!("XMLTV refresh failed: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xmltv::{Channel, Programme, XmltvCache};
    use std::collections::HashMap;

    fn sample_cache(now: i64) -> XmltvCache {
        let mut programs = HashMap::new();
        // One programme 72h ago, one current, one tomorrow
        programs.insert(
            "ch1".to_string(),
            vec![
                Programme {
                    start: now - 72 * 3600,
                    stop: now - 71 * 3600,
                    title: "old".into(),
                    desc: String::new(),
                    icon: String::new(),
                },
                Programme {
                    start: now - 1800,
                    stop: now + 1800,
                    title: "now".into(),
                    desc: String::new(),
                    icon: String::new(),
                },
                Programme {
                    start: now + 3600,
                    stop: now + 7200,
                    title: "soon".into(),
                    desc: String::new(),
                    icon: String::new(),
                },
            ],
        );
        let mut channels = HashMap::new();
        channels.insert(
            "ch1".to_string(),
            Channel {
                id: "ch1".into(),
                name: "Test".into(),
                icon: String::new(),
                names: Vec::new(),
            },
        );
        XmltvCache {
            channels,
            programs,
            fetched_at: now as u64,
        }
    }

    #[tokio::test]
    async fn indexed_slice_preserves_archive_shift_and_missing_channel() -> anyhow::Result<()> {
        let cache = sample_cache(chrono::Utc::now().timestamp());
        let index = xmltv::build_match_index(&cache.channels)?;
        for channel in ["ch1", "missing"] {
            for archive in [0, 24, 144] {
                for shift in [-12, 0, 2, 24] {
                    assert_eq!(
                        get_epg_slice_with_index(&cache, &index, "", channel, shift, archive)?,
                        get_epg_slice(&cache, "", channel, shift, archive).await?,
                        "channel={channel}, archive={archive}, shift={shift}"
                    );
                }
            }
        }
        Ok(())
    }

    #[tokio::test]
    async fn archive_hours_extends_lookback() {
        let now = chrono::Utc::now().timestamp();
        let cache = sample_cache(now);
        let def = get_epg_slice(&cache, "", "ch1", 0, 0).await.unwrap();
        let def_arr = def["epg_data"].as_array().unwrap();
        // Default 48h lookback excludes the 72h-old programme
        assert!(
            def_arr.iter().all(|p| p["name"] != "old"),
            "default window should omit 72h-old: {:?}",
            def_arr
        );

        let deep = get_epg_slice(&cache, "", "ch1", 0, 144).await.unwrap();
        let deep_arr = deep["epg_data"].as_array().unwrap();
        assert!(
            deep_arr.iter().any(|p| p["name"] == "old"),
            "144h archive lookback should include 72h-old: {:?}",
            deep_arr
        );
        assert!(deep_arr.iter().any(|p| p["name"] == "now"));
    }
}
