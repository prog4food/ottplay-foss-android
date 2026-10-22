//! M3U channel matching + logo lookup + stream proxy.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::xmltv::{self, Channels};

/// Input: array of {id, name, logo, url} from frontend
#[derive(Debug, Deserialize)]
pub struct M3uChannel {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub logo: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct MatchResult {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub epg_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub epg_name: Option<String>,
    pub score: f32,
}

/// POST /m3u/match-channels
/// Match each channel name → XMLTV, register epg_hash → xmltv_id in epg_to_xmltv.
pub fn match_channels(
    channels: Vec<M3uChannel>,
    xmltv_ch: &Channels,
    epg_to_xmltv: &mut HashMap<String, String>,
    time_shift_by_epg: &mut HashMap<String, i64>,
) -> anyhow::Result<Vec<MatchResult>> {
    let index = xmltv::build_match_index(xmltv_ch)?;
    match_channels_with_index(channels, xmltv_ch, &index, epg_to_xmltv, time_shift_by_epg)
}

/// Reuse the index for the same immutable XMLTV channel snapshot.
pub fn match_channels_with_index(
    channels: Vec<M3uChannel>,
    xmltv_ch: &Channels,
    index: &xmltv::MatchIndex,
    epg_to_xmltv: &mut HashMap<String, String>,
    time_shift_by_epg: &mut HashMap<String, i64>,
) -> anyhow::Result<Vec<MatchResult>> {
    channels
        .into_iter()
        .map(|ch| {
            if xmltv_ch.is_empty() {
                return Ok(MatchResult {
                    id: ch.id,
                    epg_id: None,
                    epg_name: None,
                    score: 0.0,
                });
            }
            let time_shift = index.extract_time_shift(&ch.name)?;
            let base_name = index.strip_time_shift(&ch.name)?;
            Ok(match xmltv::match_in_index(&base_name, index)? {
                Some((xmltv_id, score)) => {
                    let epg_hash = compute_epg_hash(&format!("{xmltv_id}|{time_shift}"));
                    epg_to_xmltv.insert(epg_hash.clone(), xmltv_id.clone());
                    if time_shift != 0 {
                        time_shift_by_epg.insert(epg_hash.clone(), time_shift);
                    }
                    let epg_name = xmltv_ch.get(&xmltv_id).map(|c| c.name.clone());
                    MatchResult {
                        id: ch.id,
                        epg_id: Some(epg_hash),
                        epg_name,
                        score,
                    }
                }
                None => MatchResult {
                    id: ch.id,
                    epg_id: None,
                    epg_name: None,
                    score: 0.0,
                },
            })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
pub struct LogoChannel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct LogoResult {
    pub id: String,
    pub logo_url: String,
}

/// POST /m3u/match-logos
pub fn match_logos(
    channels: Vec<LogoChannel>,
    xmltv_ch: &Channels,
) -> anyhow::Result<Vec<LogoResult>> {
    let index = xmltv::build_match_index(xmltv_ch)?;
    match_logos_with_index(channels, xmltv_ch, &index)
}

/// Reuse the same snapshot index as channel matching and EPG lookup.
pub fn match_logos_with_index(
    channels: Vec<LogoChannel>,
    xmltv_ch: &Channels,
    index: &xmltv::MatchIndex,
) -> anyhow::Result<Vec<LogoResult>> {
    channels
        .into_iter()
        .map(|ch| {
            let logo_url = if xmltv_ch.is_empty() {
                format!("/logo/{}.svg?ch={}", ch.id, urlencoding::encode(&ch.name))
            } else {
                let base_name = index.strip_time_shift(&ch.name)?;
                match xmltv::match_in_index(&base_name, index)? {
                    Some((xmltv_id, _score)) => xmltv_ch
                        .get(&xmltv_id)
                        .and_then(|c| {
                            if c.icon.is_empty() {
                                None
                            } else {
                                Some(c.icon.clone())
                            }
                        })
                        .unwrap_or_else(|| {
                            format!("/logo/{}.svg?ch={}", ch.id, urlencoding::encode(&ch.name))
                        }),
                    None => format!("/logo/{}.svg?ch={}", ch.id, urlencoding::encode(&ch.name)),
                }
            };
            Ok(LogoResult {
                id: ch.id,
                logo_url,
            })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
pub struct ProxyParams {
    pub url: String,
    #[serde(default)]
    pub ua: String,
}

/// UA presets mirrored from server.py
const UA_PRESETS: &[(&str, &str)] = &[
    ("webos", "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36 LG Browser/9.00.00"),
    ("tizen", "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) SamsungTV/3.0 Chrome/76.0.3809.146 Safari/537.36"),
    ("viera", "Mozilla/5.0 (Unknown; Linux; Viera/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36"),
    ("mag", "Mozilla/5.0 (STB; Infomir MAG524) Maple 6.0 QtWebKit/3.0"),
    ("dune", "Mozilla/5.0 (Dune HD; DuneOS) AppleWebKit/537.36 (KHTML, like Gecko) DuneHD/1.0 Chrome/68.0.3440.106 Safari/537.36"),
];

/// POST /m3u/cp.php — proxy a stream with injected UA.
pub async fn proxy_stream(
    params: ProxyParams,
) -> Result<(reqwest::header::HeaderMap, Vec<u8>), String> {
    let mut url = params.url;
    if url.starts_with('@') {
        url = url[1..].to_string();
    }
    if url.is_empty() {
        return Err("No URL provided".into());
    }

    let ua = if params.ua.is_empty() {
        "OTT-play-FOSS/1.0".to_string()
    } else {
        UA_PRESETS
            .iter()
            .find(|(k, _)| k == &params.ua.as_str())
            .map(|(_, v)| v.to_string())
            .unwrap_or_else(|| params.ua.clone())
    };

    super::proxy::fetch(&url, &ua).await
}

/// Deterministic hash for EPG URL — mirrors server.py compute_epg_hash.
pub fn compute_epg_hash(identifier: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    identifier.hash(&mut h);
    format!("{:016x}", h.finish() & 0xFFFFFFFFFFFF)
}

/// Parse one legacy match id-line: `id-h-h-namehash[~srcs]~urlencodedName`.
fn parse_match_line(line: &str) -> Option<(String, String, String)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let (hash_part, ch_name) = match line.rfind('~') {
        Some(idx) => (
            &line[..idx],
            urlencoding::decode(&line[idx + 1..])
                .unwrap_or_else(|_| line[idx + 1..].into())
                .into_owned(),
        ),
        None => (line, String::new()),
    };
    let hash_core = hash_part.split('~').next().unwrap_or(hash_part);
    let fields: Vec<&str> = hash_core.split('-').collect();
    if fields.len() < 4 {
        return None;
    }
    Some((fields[0].to_string(), fields[3].to_string(), ch_name))
}

/// Legacy FOSS text body for POST /m3u/match-channels.
/// Body: `{json}\n\t\n{optional raw}\n\t\n{id lines}`
/// Response: `{}\n\t\n{ch_id~local~epg_hash}\n\t\n{local~/}`
pub fn match_channels_text(
    body: &str,
    xmltv_ch: &Channels,
    epg_to_xmltv: &mut HashMap<String, String>,
    time_shift_by_epg: &mut HashMap<String, i64>,
) -> anyhow::Result<String> {
    let index = xmltv::build_match_index(xmltv_ch)?;
    match_channels_text_with_index(body, xmltv_ch, &index, epg_to_xmltv, time_shift_by_epg)
}

pub fn match_channels_text_with_index(
    body: &str,
    xmltv_ch: &Channels,
    index: &xmltv::MatchIndex,
    epg_to_xmltv: &mut HashMap<String, String>,
    time_shift_by_epg: &mut HashMap<String, i64>,
) -> anyhow::Result<String> {
    let parts: Vec<&str> = body.split("\n\t\n").collect();
    let id_section = parts.get(2).copied().unwrap_or("");
    let mut ch_mappings: Vec<String> = Vec::new();

    for line in id_section.lines() {
        let Some((ch_id, name_hash, ch_name)) = parse_match_line(line) else {
            continue;
        };

        if !xmltv_ch.is_empty() && !ch_name.is_empty() {
            let time_shift = index.extract_time_shift(&ch_name)?;
            let base_name = index.strip_time_shift(&ch_name)?;
            if let Some((xmltv_id, _score)) = xmltv::match_in_index(&base_name, index)? {
                let epg_hash = compute_epg_hash(&format!("{xmltv_id}|{time_shift}"));
                epg_to_xmltv.insert(epg_hash.clone(), xmltv_id);
                if time_shift != 0 {
                    time_shift_by_epg.insert(epg_hash.clone(), time_shift);
                }
                ch_mappings.push(format!("{ch_id}~local~{epg_hash}"));
                continue;
            }
        }

        let epg_url = if !name_hash.is_empty() && name_hash != "0" {
            name_hash
        } else {
            ch_id.clone()
        };
        ch_mappings.push(format!("{ch_id}~local~{epg_url}"));
    }

    Ok(format!("{{}}\n\t\n{}\n\t\nlocal~/", ch_mappings.join("\n")))
}

/// Legacy FOSS text body for POST /m3u/match-logos.
/// Response: `{}\n\t\n{ch_id~logo_url}`
pub fn match_logos_text(body: &str, xmltv_ch: &Channels) -> anyhow::Result<String> {
    let index = xmltv::build_match_index(xmltv_ch)?;
    match_logos_text_with_index(body, xmltv_ch, &index)
}

pub fn match_logos_text_with_index(
    body: &str,
    xmltv_ch: &Channels,
    index: &xmltv::MatchIndex,
) -> anyhow::Result<String> {
    let parts: Vec<&str> = body.split("\n\t\n").collect();
    let id_section = parts.get(2).copied().unwrap_or("");
    let mut log_mappings: Vec<String> = Vec::new();

    for line in id_section.lines() {
        let Some((ch_id, _name_hash, ch_name)) = parse_match_line(line) else {
            continue;
        };

        let logo_url = if xmltv_ch.is_empty() || ch_name.is_empty() {
            format!("/logo/{}.svg?ch={}", ch_id, urlencoding::encode(&ch_name))
        } else {
            let base_name = index.strip_time_shift(&ch_name)?;
            match xmltv::match_in_index(&base_name, index)? {
                Some((xmltv_id, _)) => xmltv_ch
                    .get(&xmltv_id)
                    .and_then(|c| {
                        if c.icon.is_empty() {
                            None
                        } else {
                            Some(c.icon.clone())
                        }
                    })
                    .unwrap_or_else(|| {
                        format!("/logo/{}.svg?ch={}", ch_id, urlencoding::encode(&ch_name))
                    }),
                None => format!("/logo/{}.svg?ch={}", ch_id, urlencoding::encode(&ch_name)),
            }
        };
        log_mappings.push(format!("{ch_id}~{logo_url}"));
    }

    Ok(format!("{{}}\n\t\n{}", log_mappings.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channels() -> Channels {
        HashMap::from([(
            "news".into(),
            xmltv::Channel {
                id: "news".into(),
                name: "News".into(),
                icon: "https://fixture.test/news.png".into(),
                names: vec!["News".into()],
            },
        )])
    }

    #[test]
    fn reused_index_preserves_text_protocol_hashes_shifts_and_logo_fallbacks() -> anyhow::Result<()>
    {
        let channels = channels();
        let index = xmltv::build_match_index(&channels)?;
        let body = "{}\n\t\n\n\t\n1-0-0-17~News%20%2B2\n2-0-0-23~Unrelated\n3-0-0-0~";
        let mut expected_map = HashMap::new();
        let mut expected_shifts = HashMap::new();
        let expected =
            match_channels_text(body, &channels, &mut expected_map, &mut expected_shifts)?;
        let expected_logos = match_logos_text(body, &channels)?;
        for _ in 0..3 {
            let mut map = HashMap::new();
            let mut shifts = HashMap::new();
            assert_eq!(
                match_channels_text_with_index(body, &channels, &index, &mut map, &mut shifts)?,
                expected
            );
            assert_eq!(map, expected_map);
            assert_eq!(shifts, expected_shifts);
            assert_eq!(
                match_logos_text_with_index(body, &channels, &index)?,
                expected_logos
            );
        }
        let shifted_hash = compute_epg_hash("news|2");
        assert!(expected.contains(&format!("1~local~{shifted_hash}")));
        assert_eq!(expected_shifts[&shifted_hash], 2);
        assert!(expected.contains("2~local~23\n3~local~3"));
        assert!(expected_logos.contains("1~https://fixture.test/news.png"));
        assert!(expected_logos.contains("2~/logo/2.svg?ch=Unrelated"));
        Ok(())
    }

    #[test]
    fn reused_index_preserves_json_protocol() -> anyhow::Result<()> {
        let channels = channels();
        let index = xmltv::build_match_index(&channels)?;
        let input = r#"[{"id":"1","name":"News +2"},{"id":"2","name":"Unrelated"}]"#;
        let mut expected_map = HashMap::new();
        let mut expected_shifts = HashMap::new();
        let expected = match_channels(
            serde_json::from_str(input)?,
            &channels,
            &mut expected_map,
            &mut expected_shifts,
        )?;
        let mut map = HashMap::new();
        let mut shifts = HashMap::new();
        let actual = match_channels_with_index(
            serde_json::from_str(input)?,
            &channels,
            &index,
            &mut map,
            &mut shifts,
        )?;
        assert_eq!(
            serde_json::to_value(actual)?,
            serde_json::to_value(expected)?
        );
        assert_eq!(map, expected_map);
        assert_eq!(shifts, expected_shifts);
        assert_eq!(
            serde_json::to_value(match_logos_with_index(
                serde_json::from_str(input)?,
                &channels,
                &index
            )?)?,
            serde_json::to_value(match_logos(serde_json::from_str(input)?, &channels)?)?,
        );
        Ok(())
    }
}
