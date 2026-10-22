//! M3U channel matching and logo lookup commands for Tauri Mode B.
//!
//! Commands exposed to JS via `invoke()`:
//! - `match_channels` — match channel names to XMLTV IDs, populate epg_to_xmltv map
//! - `match_logos` — resolve channel logo URLs from XMLTV icons
//!
//! Protocol: FOSS text format using `\n\t\n` as field separator.

use super::tauri_commands::TauriState;
use ottplay_core::native_xmltv;
use std::collections::HashMap;

struct NativeMatch {
    channel: String,
    xmltv_id: String,
    hash: String,
    shift: i64,
    logo: String,
}

fn match_group(
    snapshot: &native_xmltv::NativeSnapshot,
    group: &[(String, native_xmltv::MatchChannel)],
) -> anyhow::Result<Vec<NativeMatch>> {
    let cache = snapshot.cache();
    group
        .iter()
        .map(|(channel, info)| {
            let id = snapshot
                .resolve(&info.tvg_id, &info.tvg_name, &info.name)?
                .unwrap_or_default();
            let shift = snapshot.index().extract_time_shift(&info.name)?;
            let hash = ottplay_core::m3u::compute_epg_hash(&format!(
                "{}|{id}|{shift}",
                info.xmltv_urls.join("|")
            ));
            let logo = cache
                .channels
                .get(&id)
                .map(|ch| ch.icon.clone())
                .filter(|logo| !logo.is_empty())
                .unwrap_or_else(|| {
                    format!(
                        "/logo/{channel}.svg?ch={}",
                        url::form_urlencoded::byte_serialize(info.name.as_bytes())
                            .collect::<String>()
                    )
                });
            Ok(NativeMatch {
                channel: channel.clone(),
                xmltv_id: id,
                hash,
                shift,
                logo,
            })
        })
        .collect()
}

async fn native_matches(
    state: &TauriState,
    body: &str,
    work: &ottplay_core::background_work::WorkLease,
) -> Result<Option<Vec<NativeMatch>>, String> {
    let metadata = native_xmltv::match_metadata(body);
    if metadata.is_empty() { return Ok(None); }
    let mut groups: HashMap<Vec<String>, Vec<(String, native_xmltv::MatchChannel)>> = HashMap::new();
    for id in native_xmltv::match_ids(body) {
        if let Some(info) = metadata.get(&id) { groups.entry(info.xmltv_urls.clone()).or_default().push((id, info.clone())); }
    }
    let mut matches = Vec::new();
    for (sources, group) in groups {
        let snapshot = if sources.is_empty() {
            super::tauri_commands::ensure_xmltv_cache(state).await?;
            super::tauri_commands::xmltv_snapshot(state).await?
        } else {
            native_xmltv::load_sources_tracked(&sources, work.clone())
                .await
                .map_err(|error| error.to_string())?
        };
        let parsing = work.clone();
        matches.extend(
            tokio::task::spawn_blocking(move || {
                parsing.check().map_err(anyhow::Error::msg)?;
                let result = match_group(&snapshot, &group);
                parsing.check().map_err(anyhow::Error::msg)?;
                result
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?,
        );
    }
    Ok(Some(matches))
}

/// `invoke('match_channels', {body, url})` — match M3U channels to XMLTV.
///
/// Accepts the FOSS text body format: `{json}\n\t\n{optional raw}\n\t\n{id lines}`
/// Returns: `{}\n\t\n{ch_id~local~epg_hash}\n\t\n{local~/}`
#[tauri::command]
pub async fn match_channels(
    state: tauri::State<'_, TauriState>,
    body: String,
    _url: String,
) -> Result<String, String> {
    let work = state.background.enter().map_err(str::to_string)?;
    work.run(async {
        if let Some(matches) = native_matches(&state, &body, &work).await? {
            let mut epg_map = state.epg_to_xmltv.write().await;
            let mut time_map = state.time_shift_by_epg.write().await;
            let rows: Vec<String> = work
                .publish(|| {
                    matches
                        .into_iter()
                        .map(|entry| {
                            epg_map.insert(entry.hash.clone(), entry.xmltv_id);
                            time_map.insert(entry.hash.clone(), entry.shift);
                            format!("{}~local~{}", entry.channel, entry.hash)
                        })
                        .collect()
                })
                .map_err(str::to_string)?;
            return Ok(format!("{{}}\n\t\n{}\n\t\nlocal~/", rows.join("\n")));
        }
        super::tauri_commands::ensure_xmltv_cache(&state).await?;

        let cache = state.xmltv_cache.read().await;
        let cache = cache.as_ref().ok_or("EPG cache empty after ensure")?;

        // In-place write locks on the shared hash maps
        let mut epg_map = state.epg_to_xmltv.write().await;
        let mut time_map = state.time_shift_by_epg.write().await;

        let result = work
            .publish(|| {
                ottplay_core::m3u::match_channels_text(
                    &body,
                    &cache.cache().channels,
                    &mut epg_map,
                    &mut time_map,
                )
            })
            .map_err(str::to_string)?;

        result.map_err(|error| error.to_string())
    })
    .await
    .map_err(str::to_string)?
}

/// `invoke('match_logos', {body, url})` — resolve channel logo URLs.
///
/// Accepts the FOSS text body format: `{json}\n\t\n{optional raw}\n\t\n{id lines}`
/// Returns: `{}\n\t\n{ch_id~logo_url}`
#[tauri::command]
pub async fn match_logos(
    state: tauri::State<'_, TauriState>,
    body: String,
    _url: String,
) -> Result<String, String> {
    let work = state.background.enter().map_err(str::to_string)?;
    work.run(async {
        if let Some(matches) = native_matches(&state, &body, &work).await? {
            let rows: Vec<String> = matches
                .into_iter()
                .map(|entry| format!("{}~{}", entry.channel, entry.logo))
                .collect();
            return Ok(format!("{{}}\n\t\n{}", rows.join("\n")));
        }
        super::tauri_commands::ensure_xmltv_cache(&state).await?;

    let cache = state.xmltv_cache.read().await;
    let cache = cache.as_ref().ok_or("EPG cache empty after ensure")?;

        let result = ottplay_core::m3u::match_logos_text(&body, &cache.cache().channels);
        result.map_err(|error| error.to_string())
    })
    .await
    .map_err(str::to_string)?
}

#[cfg(test)]
mod native_match_tests {
    use super::*;
    use ottplay_core::xmltv::{Channel, XmltvCache};

    #[test]
    fn retained_alias_index_preserves_playlist_hashes_shifts_and_logos() {
        let snapshot = native_xmltv::NativeSnapshot::new(XmltvCache {
            channels: HashMap::from([(
                "private".into(),
                Channel {
                    id: "private".into(),
                    name: "News".into(),
                    names: vec!["News".into(), "Alias".into()],
                    icon: "https://fixture.invalid/logo".into(),
                },
            )]),
            ..Default::default()
        })
        .unwrap();
        for sources in [vec![], vec!["https://fixture.invalid/feed".into()]] {
            let info = native_xmltv::MatchChannel {
                tvg_id: "missing".into(),
                tvg_name: "Alias".into(),
                name: "Renamed +3".into(),
                xmltv_urls: sources,
            };
            let expected_hash = ottplay_core::m3u::compute_epg_hash(&format!(
                "{}|private|3",
                info.xmltv_urls.join("|")
            ));
            let group = vec![("42".into(), info)];
            for _ in 0..2 {
                let matched = match_group(&snapshot, &group).unwrap();
                assert_eq!(matched[0].channel, "42");
                assert_eq!(matched[0].xmltv_id, "private");
                assert_eq!(matched[0].shift, 3);
                assert_eq!(matched[0].hash, expected_hash);
                assert_eq!(matched[0].logo, "https://fixture.invalid/logo");
            }
        }
    }
}
