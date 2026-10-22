//! XMLTV fetch + parse + fuzzy match.
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Read;

use flate2::read::GzDecoder;
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[cfg(test)]
#[path = "xmltv_fetch_tests.rs"]
mod fetch_tests;
mod hosted_records;
mod server_records;

#[derive(Clone, Debug, Default)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub icon: String,
    /// Retained for native matching; the browser matcher keeps using `name`.
    pub names: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Programme {
    pub start: i64,
    pub stop: i64,
    pub title: String,
    pub desc: String,
    pub icon: String,
}

#[derive(Clone, Debug, Default)]
pub struct XmltvCache {
    pub channels: HashMap<String, Channel>,
    pub programs: HashMap<String, Vec<Programme>>,
    pub fetched_at: u64,
}

pub type Channels = HashMap<String, Channel>;
pub type Programs = HashMap<String, Vec<Programme>>;

/// Fetch + parse one XMLTV source. Supports http(s), .gz, plain .xml.
pub async fn fetch_single(source: &str) -> anyhow::Result<(Channels, Programs)> {
    fetch_single_impl(source, false, None).await
}

/// Native custom feeds retain aliases and chronological programme order.
pub async fn fetch_single_native(source: &str) -> anyhow::Result<(Channels, Programs)> {
    fetch_single_impl(source, true, None).await
}

pub(crate) async fn fetch_single_tracked(
    source: &str,
    native: bool,
    work: crate::background_work::WorkLease,
) -> anyhow::Result<(Channels, Programs)> {
    fetch_single_impl(source, native, Some(work)).await
}

async fn fetch_single_impl(
    source: &str,
    native: bool,
    work: Option<crate::background_work::WorkLease>,
) -> anyhow::Result<(Channels, Programs)> {
    let content: Vec<u8> = if source.starts_with("http://") || source.starts_with("https://") {
        let client = Client::builder()
            .user_agent("OTT-play-FOSS/1.0")
            .connect_timeout(std::time::Duration::from_secs(30))
            .read_timeout(std::time::Duration::from_secs(60))
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .map_err(|error| fetch_failure(native, "HTTP client failed", error.into()))?;
        fetch_remote(source, &client, native).await?
    } else {
        tokio::fs::read(source)
            .await
            .map_err(|error| fetch_failure(native, "source read failed", error.into()))?
    };

    let source_has_gz_extension = source.ends_with(".gz");
    // XMLTV feeds can contain hundreds of megabytes of XML. Decompression and
    // synchronous record reduction must not occupy an async request worker.
    tokio::task::spawn_blocking(move || {
        // Keep this lease counted until a synchronous parser actually exits.
        if let Some(work) = &work {
            work.check().map_err(anyhow::Error::msg)?;
        }
        let is_gz = (!native && source_has_gz_extension) || content.starts_with(&[0x1f, 0x8b]);
        let raw: Vec<u8> = if is_gz {
            let mut d = GzDecoder::new(&content[..]);
            let mut out = Vec::new();
            let mut chunk = [0; 64 * 1024];
            loop {
                if let Some(work) = &work {
                    work.check().map_err(anyhow::Error::msg)?;
                }
                let read = d
                    .read(&mut chunk)
                    .map_err(|error| fetch_failure(native, "gzip decode failed", error.into()))?;
                if read == 0 {
                    break;
                }
                out.extend_from_slice(&chunk[..read]);
            }
            out
        } else {
            content
        };
        let text = String::from_utf8_lossy(&raw);
        let result = parse_xmltv_guarded(&text, native, work.as_ref())
            .map_err(|error| fetch_failure(native, "XMLTV parse failed", error));
        if let Some(work) = &work {
            work.check().map_err(anyhow::Error::msg)?;
        }
        result
    })
    .await
    .map_err(|error| fetch_failure(native, "XMLTV worker failed", error.into()))?
}

async fn fetch_remote(source: &str, client: &Client, native: bool) -> anyhow::Result<Vec<u8>> {
    let response = client
        .get(source)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| fetch_failure(native, "HTTP request failed", error.into()))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| fetch_failure(native, "HTTP body failed", error.into()))?;
    Ok(bytes.to_vec())
}

// URLs, response bodies and nested error text can all contain credentials.
// Native callers retain their existing detailed error contract.
fn fetch_failure(native: bool, stage: &'static str, error: anyhow::Error) -> anyhow::Error {
    if native {
        return error;
    }
    if let Some(http) = error.downcast_ref::<reqwest::Error>() {
        if let Some(status) = http.status() {
            return anyhow::anyhow!("HTTP status {}", status.as_u16());
        }
        if http.is_timeout() {
            return anyhow::anyhow!("HTTP timeout");
        }
        if http.is_connect() {
            return anyhow::anyhow!("HTTP connection failed");
        }
    }
    anyhow::anyhow!(stage)
}

/// Event-based XMLTV parser. Cheap; no DOM.
pub fn parse_xmltv(xml: &str) -> anyhow::Result<(Channels, Programs)> {
    parse_xmltv_impl(xml, false)
}

pub fn parse_xmltv_native(xml: &str) -> anyhow::Result<(Channels, Programs)> {
    parse_xmltv_impl(xml, true)
}

/// Public-feed server profile for the hosted web client. Preserves alias order,
/// first metadata/first nonempty fields, strict browser timestamps and duplicates.
pub fn parse_xmltv_hosted(xml: &str) -> anyhow::Result<(Channels, Programs, Vec<Vec<String>>)> {
    anyhow::ensure!(xml.len() <= 512 * 1024 * 1024, "EPG_XML_LIMIT");
    let mut records = Records::Hosted(hosted_records::HostedRecords::default());
    let (channels, mut programs) = parse_xmltv_with_records(xml, false, &mut records, None)?;
    for rows in programs.values_mut() {
        rows.sort_by_key(|row| (row.start, row.stop));
    }
    let Records::Hosted(records) = records else { unreachable!() };
    Ok((channels, programs, records.aliases))
}

fn parse_xmltv_impl(xml: &str, native: bool) -> anyhow::Result<(Channels, Programs)> {
    parse_xmltv_guarded(xml, native, None)
}

fn parse_xmltv_guarded(
    xml: &str,
    native: bool,
    work: Option<&crate::background_work::WorkLease>,
) -> anyhow::Result<(Channels, Programs)> {
    let mut records = if native {
        Records::Shared(RecordTokens::new(true)?)
    } else {
        Records::Server(server_records::ServerRecords::default())
    };
    parse_xmltv_with_records(xml, native, &mut records, work)
}

fn parse_xmltv_with_records(
    xml: &str,
    native: bool,
    records: &mut Records,
    work: Option<&crate::background_work::WorkLease>,
) -> anyhow::Result<(Channels, Programs)> {
    let mut reader = Reader::from_str(xml);
    // quick-xml 0.41 emits references separately. Preserve whitespace between
    // text/reference/CDATA events and trim once when the complete field closes.
    reader.config_mut().trim_text(false);

    let mut channels: Channels = HashMap::new();
    let mut programs: Programs = HashMap::new();

    let mut buf = Vec::new();
    let mut depth = 0usize;
    let mut root_seen = false;
    let mut root_closed = false;
    let hosted = matches!(records, Records::Hosted(_));
    let mut work_events = 0u32;
    loop {
        work_events = work_events.wrapping_add(1);
        if work_events % 128 == 0 {
            if let Some(work) = work {
                work.check().map_err(anyhow::Error::msg)?;
            }
        }
        let event = reader.read_event_into(&mut buf);
        let validation = (|| -> anyhow::Result<()> {
            if native || hosted {
                // quick_xml can return EOF after complete channels inside an unclosed root.
                // Such a partial download must never replace the native cache.
                match &event {
                    Ok(Event::Start(element)) => {
                        if depth == 0 {
                            anyhow::ensure!(
                                !root_seen && element.name().as_ref() == b"tv",
                                "Invalid XMLTV root"
                            );
                            root_seen = true;
                        }
                        depth += 1;
                        anyhow::ensure!(!hosted || depth <= 16, "EPG_XML_DEPTH");
                    }
                    Ok(Event::Empty(element)) if depth == 0 => {
                        anyhow::ensure!(
                            !root_seen && element.name().as_ref() == b"tv",
                            "Invalid XMLTV root"
                        );
                        root_seen = true;
                        root_closed = true;
                    }
                    Ok(Event::Empty(_)) if hosted => {
                        anyhow::ensure!(depth < 16, "EPG_XML_DEPTH");
                    }
                    Ok(Event::End(element)) => {
                        anyhow::ensure!(depth > 0, "Unexpected XMLTV closing element");
                        depth -= 1;
                        if depth == 0 {
                            anyhow::ensure!(
                                element.name().as_ref() == b"tv",
                                "Invalid XMLTV closing root"
                            );
                            root_closed = true;
                        }
                    }
                    Ok(Event::Text(text)) if depth == 0 => {
                        anyhow::ensure!(
                            text.decode()?.trim().is_empty(),
                            "Text outside XMLTV root"
                        );
                    }
                    Ok(Event::GeneralRef(_)) if depth == 0 => {
                        anyhow::bail!("Entity outside XMLTV root")
                    }
                    Ok(Event::CData(_)) if depth == 0 => anyhow::bail!("CDATA outside XMLTV root"),
                    Ok(Event::Eof) => anyhow::ensure!(
                        root_seen && root_closed && depth == 0,
                        "Incomplete XMLTV document"
                    ),
                    _ => {}
                }
            }
            Ok(())
        })();
        if let Err(error) = validation {
            records.flush(&mut channels, &mut programs)?;
            return Err(error);
        }
        match event {
            Ok(Event::DocType(value)) if hosted => {
                let value = value.decode()?;
                anyhow::ensure!(hosted_records::inert_doctype(&value), "EPG_XML_DTD");
            }
            Ok(Event::Empty(element)) if hosted => {
                records.start(&element, &mut channels, &mut programs)?;
                records.end(element.name().as_ref(), &mut channels, &mut programs)?;
            }
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                // Empty elements have always supplied only a start event here.
                records.start(&element, &mut channels, &mut programs)?;
            }
            Ok(Event::Text(text)) => {
                records.text(
                    text.decode().map_err(Into::into),
                    &mut channels,
                    &mut programs,
                )?;
            }
            Ok(Event::CData(text)) => {
                records.text(
                    text.decode().map_err(Into::into),
                    &mut channels,
                    &mut programs,
                )?;
            }
            Ok(Event::GeneralRef(reference)) => {
                let decoded = (|| -> anyhow::Result<Cow<'_, str>> {
                    if let Some(character) = reference.resolve_char_ref()? {
                        return Ok(Cow::Owned(character.to_string()));
                    }
                    let name = reference.decode()?;
                    match quick_xml::escape::resolve_predefined_entity(&name) {
                        Some(value) => Ok(value.into()),
                        None => anyhow::bail!("Unsupported XML entity: &{name};"),
                    }
                })();
                records.text(decoded, &mut channels, &mut programs)?;
            }
            Ok(Event::End(element)) => {
                records.end(element.name().as_ref(), &mut channels, &mut programs)?
            }
            Ok(Event::Eof) => break,
            Err(error) => {
                // A prior batched decode error keeps its original precedence.
                records.flush(&mut channels, &mut programs)?;
                anyhow::bail!("XML parse error at {}: {error}", reader.buffer_position());
            }
            _ => {}
        }
        buf.clear();
    }

    records.flush(&mut channels, &mut programs)?;
    if native {
        let Records::Shared(records) = records else {
            unreachable!("native custom feeds use the shared reducer");
        };
        for entries in programs.values_mut() {
            let order = records
                .core
                .order(entries.iter().map(|entry| entry.start as f64).collect())?;
            anyhow::ensure!(order.len() == entries.len(), "Invalid shared XMLTV order");
            let mut original: Vec<_> = std::mem::take(entries).into_iter().map(Some).collect();
            for index in order {
                entries.push(
                    original
                        .get_mut(index)
                        .and_then(Option::take)
                        .ok_or_else(|| anyhow::anyhow!("Invalid shared XMLTV order"))?,
                );
            }
        }
    }
    Ok((channels, programs))
}

// Both profiles share tokenization, attribute normalization and error handling.
// Only the server's per-event record/calendar work avoids the QuickJS bridge.
enum Records {
    Server(server_records::ServerRecords),
    Hosted(hosted_records::HostedRecords),
    Shared(RecordTokens),
}

impl Records {
    fn start(
        &mut self,
        element: &quick_xml::events::BytesStart<'_>,
        channels: &mut Channels,
        programs: &mut Programs,
    ) -> anyhow::Result<()> {
        match self {
            Self::Hosted(records) => records.start(element),
            Self::Server(records) => {
                records.start(element);
                Ok(())
            }
            Self::Shared(records) => {
                let mut row = vec![
                    "start".into(),
                    String::from_utf8_lossy(element.name().as_ref()).into_owned(),
                ];
                for key in ["id", "channel", "start", "stop", "src"] {
                    if let Some(value) = attr(element, key) {
                        row.push(key.into());
                        row.push(value);
                    }
                }
                records.push(row, channels, programs)
            }
        }
    }

    fn text(
        &mut self,
        value: anyhow::Result<Cow<'_, str>>,
        channels: &mut Channels,
        programs: &mut Programs,
    ) -> anyhow::Result<()> {
        match self {
            Self::Hosted(records) => records.text(value),
            Self::Server(records) => records.text(value),
            Self::Shared(records) => records.text(value.map(Cow::into_owned), channels, programs),
        }
    }

    fn end(
        &mut self,
        name: &[u8],
        channels: &mut Channels,
        programs: &mut Programs,
    ) -> anyhow::Result<()> {
        match self {
            Self::Hosted(records) => records.end(channels, programs),
            Self::Server(records) => {
                records.end(name, channels, programs);
                Ok(())
            }
            Self::Shared(records) => records.push(
                vec!["end".into(), String::from_utf8_lossy(name).into_owned()],
                channels,
                programs,
            ),
        }
    }

    fn flush(&mut self, channels: &mut Channels, programs: &mut Programs) -> anyhow::Result<()> {
        match self {
            Self::Server(_) | Self::Hosted(_) => Ok(()),
            Self::Shared(records) => records.flush(channels, programs),
        }
    }
}

/// The bounded transport queue contains XML tokens and original decoder errors.
/// Only the shared reducer decides whether a text token belongs to a field.
struct RecordTokens {
    core: crate::shared_guide::GuideRecords,
    rows: Vec<Vec<String>>,
    bytes: usize,
    errors: Vec<Option<anyhow::Error>>,
}

impl RecordTokens {
    const MAX_ROWS: usize = 256;
    const MAX_BYTES: usize = 64 * 1024;

    fn new(native: bool) -> anyhow::Result<Self> {
        Ok(Self {
            core: crate::shared_guide::GuideRecords::new(native)?,
            rows: Vec::new(),
            bytes: 0,
            errors: Vec::new(),
        })
    }

    fn push(
        &mut self,
        row: Vec<String>,
        channels: &mut Channels,
        programs: &mut Programs,
    ) -> anyhow::Result<()> {
        self.bytes += row.iter().map(String::len).sum::<usize>();
        self.rows.push(row);
        if self.rows.len() >= Self::MAX_ROWS || self.bytes >= Self::MAX_BYTES {
            self.flush(channels, programs)?;
        }
        Ok(())
    }

    fn text(
        &mut self,
        value: anyhow::Result<String>,
        channels: &mut Channels,
        programs: &mut Programs,
    ) -> anyhow::Result<()> {
        let row = match value {
            Ok(value) => vec!["text".into(), value],
            Err(error) => {
                let index = self.errors.len();
                self.errors.push(Some(error));
                vec!["text-error".into(), index.to_string()]
            }
        };
        self.push(row, channels, programs)
    }

    fn flush(&mut self, channels: &mut Channels, programs: &mut Programs) -> anyhow::Result<()> {
        if self.rows.is_empty() {
            return Ok(());
        }
        let actions = self.core.accept(std::mem::take(&mut self.rows))?;
        for action in actions {
            match action.first().map(String::as_str) {
                Some("replace-channel") if action.len() >= 4 => {
                    let mut fields = action.into_iter().skip(1);
                    let id = fields.next().expect("checked length");
                    channels.insert(
                        id.clone(),
                        Channel {
                            id,
                            name: fields.next().expect("checked length"),
                            icon: fields.next().expect("checked length"),
                            names: fields.collect(),
                        },
                    );
                }
                Some("programme") if action.len() == 7 => {
                    let mut fields = action.into_iter().skip(1);
                    let channel = fields.next().expect("checked length");
                    programs.entry(channel).or_default().push(Programme {
                        start: fields.next().expect("checked length").parse::<f64>()? as i64,
                        stop: fields.next().expect("checked length").parse::<f64>()? as i64,
                        title: fields.next().expect("checked length"),
                        desc: fields.next().expect("checked length"),
                        icon: fields.next().expect("checked length"),
                    });
                }
                Some("error") if action.len() == 2 => {
                    let index: usize = action[1].parse()?;
                    return Err(self
                        .errors
                        .get_mut(index)
                        .and_then(Option::take)
                        .ok_or_else(|| anyhow::anyhow!("Invalid shared XMLTV decoder error"))?);
                }
                _ => anyhow::bail!("Invalid shared XMLTV action"),
            }
        }
        self.bytes = 0;
        self.errors.clear();
        Ok(())
    }
}

fn attr_value<'a>(e: &'a quick_xml::events::BytesStart<'_>, key: &str) -> Option<Cow<'a, str>> {
    for a in e.attributes().flatten() {
        if a.key.as_ref() == key.as_bytes() {
            return a
                .decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0, e.decoder())
                .ok();
        }
    }
    None
}

fn attr(e: &quick_xml::events::BytesStart<'_>, key: &str) -> Option<String> {
    attr_value(e, key).map(Cow::into_owned)
}

/// Parse XMLTV timestamps through the pinned shared core (seconds).
pub fn parse_xmltv_time(ts: &str) -> anyhow::Result<i64> {
    crate::shared_guide::text::<f64>("nativeGuideTime", ts).map(|value| value as i64)
}

pub use crate::shared_guide::GuideIndex as MatchIndex;
pub use crate::shared_guide::GuideMatchBudget as MatchBudget;

pub fn normalize_name(name: &str) -> anyhow::Result<String> {
    crate::shared_guide::text("nativeGuideName", name)
}

pub fn build_match_index(channels: &Channels) -> anyhow::Result<MatchIndex> {
    MatchIndex::new(
        channels
            .iter()
            .map(|(id, c)| vec![id.clone(), c.name.clone()])
            .collect(),
    )
}

/// The HTTP companion can match any retained alias without discarding regional
/// shift markers before the shared core's unique exact-name decision.
pub fn build_http_match_index(channels: &Channels) -> anyhow::Result<MatchIndex> {
    let rows = channels.iter().map(|(id, channel)| vec![id.clone(), channel.name.clone()]).collect();
    let aliases = channels.iter().flat_map(|(id, channel)| {
        let names = if channel.names.is_empty() { std::slice::from_ref(&channel.name) } else { &channel.names };
        names.iter().map(move |name| vec![id.clone(), name.clone()])
    }).collect();
    MatchIndex::with_aliases(rows, aliases)
}

pub fn match_in_index(name: &str, index: &MatchIndex) -> anyhow::Result<Option<(String, f32)>> {
    index.match_name(name)
}

pub fn match_channel(name: &str, channels: &Channels) -> anyhow::Result<Option<(String, f32)>> {
    match_in_index(name, &build_match_index(channels)?)
}

pub fn strip_time_shift(name: &str) -> anyhow::Result<String> {
    crate::shared_guide::text("nativeGuideStripShift", name)
}

pub fn extract_time_shift(name: &str) -> anyhow::Result<i64> {
    crate::shared_guide::text::<i32>("nativeGuideShift", name).map(i64::from)
}

#[cfg(test)]
fn parse_xmltv_shared_reference(xml: &str) -> anyhow::Result<(Channels, Programs)> {
    parse_xmltv_with_records(xml, false, &mut Records::Shared(RecordTokens::new(false)?), None)
}

#[cfg(test)]
#[path = "xmltv_differential_tests.rs"]
mod differential_tests;

#[cfg(test)]
#[path = "http_alias_tests.rs"]
mod http_alias_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_xmltv() {
        let xml = r#"<?xml version="1.0"?>
<tv>
  <channel id="c1">
    <display-name>Channel One</display-name>
  </channel>
  <programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="c1">
    <title>News</title>
    <desc>Headlines</desc>
  </programme>
</tv>"#;
        let (ch, pr) = parse_xmltv(xml).unwrap();
        assert_eq!(ch.len(), 1);
        assert_eq!(ch.get("c1").unwrap().name, "Channel One");
        let progs = pr.get("c1").expect("c1 should have progs");
        assert_eq!(progs.len(), 1);
        assert_eq!(progs[0].title, "News");
        assert_eq!(progs[0].desc, "Headlines");
    }

    #[test]
    fn xmltv_preserves_fragmented_entities_cdata_and_attribute_values() {
        let xml = r#"<tv>
<channel id="c1"><display-name>Channel &amp; &#x41;&#66;</display-name>
<icon src="https://example.test/icon?a=1&amp;b=2"/></channel>
<programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="c1">
<title>  News &amp; Sport &#x1f3c6;  </title>
<desc>Before <![CDATA[<raw>&]]> after &quot;quotes&quot; &apos;ok&apos;</desc>
</programme></tv>"#;
        let (channels, programmes) = parse_xmltv(xml).unwrap();
        assert_eq!(channels["c1"].name, "Channel & AB");
        assert_eq!(channels["c1"].icon, "https://example.test/icon?a=1&b=2");
        assert_eq!(programmes["c1"][0].title, "News & Sport 🏆");
        assert_eq!(
            programmes["c1"][0].desc,
            "Before <raw>& after \"quotes\" 'ok'"
        );
    }

    #[test]
    fn xmltv_rejects_unresolved_entities_without_external_resolution() {
        assert!(parse_xmltv(
            "<tv><channel id='c1'><display-name>&external;</display-name></channel></tv>"
        )
        .is_err());
    }

    #[test]
    fn malformed_multibyte_timestamps_do_not_panic() {
        assert_eq!(parse_xmltv_time("2026010100000💥").unwrap(), 0);
        assert_eq!(parse_xmltv_time("20260101000000 +0💥").unwrap(), 0);
    }

    #[test]
    fn time_parse_utc() {
        let t = parse_xmltv_time("20260101120000 +0000").unwrap();
        assert!(t > 0);
    }

    #[test]
    fn time_parse_positive_offset() {
        let utc = parse_xmltv_time("20260101120000 +0000").unwrap();
        let plus3 = parse_xmltv_time("20260101120000 +0300").unwrap();
        assert_eq!(utc - plus3, 3 * 3600, "+0300 local noon is 09:00 UTC");
        let minus530 = parse_xmltv_time("20260101120000 -0530").unwrap();
        assert_eq!(minus530 - utc, 5 * 3600 + 30 * 60);
    }

    #[test]
    fn normalize_strip_hd() {
        assert_eq!(normalize_name("HD First").unwrap(), "first");
        assert_eq!(normalize_name("First HD").unwrap(), "first");
        assert_eq!(normalize_name("First +4h").unwrap(), "first");
        assert_eq!(normalize_name("First (Алания)").unwrap(), "first");
    }

    #[test]
    fn match_exact() {
        let mut ch = Channels::new();
        ch.insert(
            "c1".into(),
            Channel {
                id: "c1".into(),
                name: "Первый канал".into(),
                names: vec!["Первый канал".into()],
                icon: String::new(),
            },
        );
        let m = match_channel("Первый канал", &ch).unwrap();
        assert!(m.is_some());
        assert_eq!(m.unwrap().0, "c1");
    }
}
