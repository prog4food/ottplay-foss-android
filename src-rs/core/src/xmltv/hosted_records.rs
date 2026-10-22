//! Fast record boundary for the hosted worker's `node-streaming` profile.
//! QuickXML tokenization is shared with the other profiles. Differential tests
//! use the pinned WebXmltvRecords implementation as the semantic reference.
use super::{attr, Channel, Channels, Programme, Programs};
use quick_xml::events::BytesStart;

pub(super) fn web_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn trim(value: &str) -> &str {
    value.trim_matches(web_space)
}

// Same inert declaration grammar as the hosted SAX callback. Never resolve an
// external DTD, and reject internal subsets and declarations containing markup.
pub(super) fn inert_doctype(value: &str) -> bool {
    fn keyword<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
        let rest = value.strip_prefix(prefix)?;
        rest.chars().next().filter(|c| web_space(*c))?;
        Some(trim(rest))
    }
    let value = trim(value);
    if value == "tv" {
        return true;
    }
    let Some(system) = keyword(value, "tv").and_then(|rest| keyword(rest, "SYSTEM")) else {
        return false;
    };
    let Some(quote @ ('\'' | '"')) = system.chars().next() else {
        return false;
    };
    system.len() >= 2
        && system.ends_with(quote)
        && !system[1..system.len() - 1].contains([quote, '<', '>'])
}

#[derive(Default)]
pub(super) struct HostedRecords {
    pub aliases: Vec<Vec<String>>,
    depth: usize,
    channel: Option<Channel>,
    programme: Option<(String, Programme)>,
    field: Option<&'static str>,
    text: String,
    text_units: usize,
    programmes_started: bool,
    count: usize,
}

impl HostedRecords {
    pub fn start(&mut self, tag: &BytesStart<'_>) -> anyhow::Result<()> {
        self.depth += 1;
        let name = tag.name();
        let name = name.as_ref();
        if self.depth == 2 && (name == b"channel" || name == b"programme") {
            self.field = None;
            self.text.clear();
            self.text_units = 0;
            self.channel = None;
            self.programme = None;
            if name == b"channel" {
                anyhow::ensure!(!self.programmes_started, "EPG_XML_ORDER");
                let id = trim(&attr(tag, "id").unwrap_or_default()).to_string();
                anyhow::ensure!(id.encode_utf16().count() <= 512, "EPG_FIELD_LIMIT");
                self.channel = Some(Channel {
                    id,
                    ..Channel::default()
                });
            } else {
                self.programmes_started = true;
                let id = trim(&attr(tag, "channel").unwrap_or_default()).to_string();
                if let (Some(start), Some(stop)) = (
                    parse_time(&attr(tag, "start").unwrap_or_default()),
                    parse_time(&attr(tag, "stop").unwrap_or_default()),
                ) {
                    // The client admission callback rejects invalid intervals
                    // before field limits; retain all valid history server-side.
                    if stop > start {
                        anyhow::ensure!(id.encode_utf16().count() <= 512, "EPG_FIELD_LIMIT");
                        self.programme = Some((
                            id,
                            Programme {
                                start,
                                stop,
                                ..Programme::default()
                            },
                        ));
                    }
                }
            }
        }
        if self.depth != 3 {
            return Ok(());
        }
        if let Some(channel) = &mut self.channel {
            if name == b"display-name" {
                self.field = Some("name");
                self.text.clear();
                self.text_units = 0;
            }
            if name == b"icon" {
                let icon = attr(tag, "src").unwrap_or_default();
                anyhow::ensure!(icon.encode_utf16().count() <= 8192, "EPG_FIELD_LIMIT");
                if channel.icon.is_empty() {
                    let lower = icon.to_ascii_lowercase();
                    if lower.starts_with("http://") || lower.starts_with("https://") {
                        channel.icon = if lower.starts_with("http://epg.one/") {
                            format!("https://cdn.epg.one/{}", &icon[15..])
                        } else if lower.starts_with("http://epg.it999.ru/") {
                            format!("https://cdn.epg.one/{}", &icon[20..])
                        } else {
                            icon
                        };
                    }
                }
            }
        } else if self.programme.is_some() && matches!(name, b"title" | b"desc" | b"catchup-id") {
            self.field = Some(if name == b"title" {
                "title"
            } else if name == b"desc" {
                "desc"
            } else {
                "ignored"
            });
            self.text.clear();
            self.text_units = 0;
        }
        Ok(())
    }

    pub fn text(&mut self, value: anyhow::Result<std::borrow::Cow<'_, str>>) -> anyhow::Result<()> {
        let value = value?;
        if self.field.is_some() {
            self.text_units += value.encode_utf16().count();
            anyhow::ensure!(self.text_units <= 16384, "EPG_FIELD_LIMIT");
            self.text.push_str(&value);
        }
        Ok(())
    }

    pub fn end(&mut self, channels: &mut Channels, programs: &mut Programs) -> anyhow::Result<()> {
        if self.depth == 3 {
            let value = trim(&self.text);
            match self.field.take() {
                Some("name") => {
                    if let Some(channel) = &mut self.channel {
                        anyhow::ensure!(channel.names.len() < 64, "EPG_FIELD_LIMIT");
                        channel.names.push(value.to_string());
                    }
                }
                Some("title") => {
                    if let Some((_, programme)) = &mut self.programme {
                        if programme.title.is_empty() {
                            programme.title = value.to_string();
                        }
                    }
                }
                Some("desc") => {
                    if let Some((_, programme)) = &mut self.programme {
                        if programme.desc.is_empty() {
                            programme.desc = value.to_string();
                        }
                    }
                }
                _ => {}
            }
            self.text.clear();
            self.text_units = 0;
        }
        if self.depth == 2 {
            if let Some(mut channel) = self.channel.take() {
                if channel.names.is_empty() {
                    channel.names.push(String::new());
                }
                for name in &channel.names {
                    self.aliases.push(vec![channel.id.clone(), name.clone()]);
                }
                channel.name = channel.names[0].clone();
                channels.entry(channel.id.clone()).or_insert(channel);
                anyhow::ensure!(
                    channels.len() <= 16384 && self.aliases.len() <= 65536,
                    "EPG_CHANNEL_LIMIT"
                );
            }
            if let Some((id, programme)) = self.programme.take() {
                self.count += 1;
                anyhow::ensure!(self.count <= 2_000_000, "EPG_RECORD_LIMIT");
                programs.entry(id).or_default().push(programme);
            }
        }
        self.depth = self.depth.saturating_sub(1);
        Ok(())
    }
}

/// Browser XMLTV time policy: 12/14 digits, optional strict ±HHMM or UTC marker,
/// validated Gregorian date, no local timezone and no leap-second coercion.
pub(super) fn parse_time(value: &str) -> Option<i64> {
    let value = trim(value);
    let bytes = value.as_bytes();
    let digits = bytes.iter().take_while(|v| v.is_ascii_digit()).count();
    if digits != 12 && digits != 14 {
        return None;
    }
    let pair = |n: usize| u32::from(bytes[n] - b'0') * 10 + u32::from(bytes[n + 1] - b'0');
    let date = chrono::NaiveDate::from_ymd_opt((pair(0) * 100 + pair(2)) as i32, pair(4), pair(6))?
        .and_hms_opt(pair(8), pair(10), if digits == 14 { pair(12) } else { 0 })?;
    let zone = trim(&value[digits..]);
    let offset = if matches!(zone, "" | "Z" | "UTC" | "GMT") {
        0
    } else {
        let bytes = zone.as_bytes();
        if bytes.len() != 5
            || !matches!(bytes[0], b'+' | b'-')
            || !bytes[1..].iter().all(u8::is_ascii_digit)
        {
            return None;
        }
        let hours = i64::from(bytes[1] - b'0') * 10 + i64::from(bytes[2] - b'0');
        let minutes = i64::from(bytes[3] - b'0') * 10 + i64::from(bytes[4] - b'0');
        if hours > 23 || minutes > 59 {
            return None;
        }
        (hours * 3600 + minutes * 60) * if bytes[0] == b'-' { -1 } else { 1 }
    };
    Some(date.and_utc().timestamp() - offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use quick_xml::{events::Event, Reader};
    use rquickjs::{Context, Function, Runtime};
    use serde_json::{json, Map, Value};

    // Run the actual pinned browser reducer, rather than reimplementing its
    // expected values in tests. Only XML token decoding is shared with Rust.
    fn oracle(xml: &str) -> Value {
        let runtime = Runtime::new().unwrap();
        runtime.set_max_stack_size(1024 * 1024);
        let context = Context::full(&runtime).unwrap();
        let mut tokens = Vec::new();
        let mut reader = Reader::from_str(xml);
        loop {
            let event = reader.read_event().unwrap();
            match event {
                Event::Start(ref tag) | Event::Empty(ref tag) => {
                    let attrs: Map<String, Value> = ["id", "channel", "start", "stop", "src"]
                        .into_iter()
                        .filter_map(|key| attr(tag, key).map(|v| (key.into(), json!(v))))
                        .collect();
                    let name = String::from_utf8_lossy(tag.name().as_ref()).to_string();
                    tokens.push(json!(["start", name, attrs]));
                    if matches!(event, Event::Empty(_)) {
                        tokens.push(json!(["end", name]));
                    }
                }
                Event::Text(text) => tokens.push(json!(["text", text.decode().unwrap()])),
                Event::CData(text) => tokens.push(json!(["text", text.decode().unwrap()])),
                Event::GeneralRef(reference) => {
                    let value = if let Some(c) = reference.resolve_char_ref().unwrap() {
                        c.to_string()
                    } else {
                        quick_xml::escape::resolve_predefined_entity(&reference.decode().unwrap())
                            .unwrap()
                            .to_string()
                    };
                    tokens.push(json!(["text", value]));
                }
                Event::End(tag) => {
                    tokens.push(json!(["end", String::from_utf8_lossy(tag.name().as_ref())]))
                }
                Event::Eof => break,
                _ => {}
            }
        }
        context.with(|ctx| {
            ctx.eval::<(), _>(include_str!("../../../../vendor/ottplay-core.js")).unwrap();
            let run: Function = ctx.eval(r#"(function(input) {
                var channels = {}, programmes = {}, aliases = [];
                var r = new OttPlayCore.WebXmltvRecords('node-streaming', function(id, start, stop) {
                    return start !== null && stop !== null && isFinite(start) && isFinite(stop) && stop > start;
                }, function(icon) { return /^https?:\/\//i.test(icon) ? icon.replace(/^http:\/\/(?:epg\.one|epg\.it999\.ru)\//i, 'https://cdn.epg.one/') : ''; });
                JSON.parse(input).forEach(function(t) {
                    if(t[0] === 'start') r.start(t[1], t[2]);
                    else if(t[0] === 'text') r.text(t[1]);
                    else {
                        var result = r.end(t[1]); if(!result) return;
                        var v = result.value;
                        if(result.kind === 'channel') {
                            if(!channels[v.id]) channels[v.id] = {id:v.id, names:v.names.length ? v.names : [''], icon:v.icon};
                            (v.names.length ? v.names : ['']).forEach(function(name){ aliases.push([v.id,name]); });
                        } else (programmes[v.id] || (programmes[v.id] = [])).push({start:v.begin,stop:v.end,title:v.title,desc:v.desc,icon:''});
                    }
                });
                Object.keys(programmes).forEach(function(id){ programmes[id].sort(function(a,b){return a.start-b.start || a.stop-b.stop;}); });
                return JSON.stringify({channels:channels,programmes:programmes,aliases:aliases});
            })"#).unwrap();
            let output: String = run.call((serde_json::to_string(&tokens).unwrap(),)).unwrap();
            serde_json::from_str(&output).unwrap()
        })
    }

    fn compare(xml: &str) {
        let (channels, programmes, aliases) = super::super::parse_xmltv_hosted(xml).unwrap();
        let channels: Map<String, Value> = channels
            .into_iter()
            .map(|(id, row)| (id, json!({"id":row.id,"names":row.names,"icon":row.icon})))
            .collect();
        assert_eq!(
            json!({"channels":channels,"programmes":programmes,"aliases":aliases}),
            oracle(xml),
            "{xml}"
        );
    }

    #[test]
    fn hosted_records_match_pinned_browser_fields_aliases_and_boundaries() {
        compare(
            r#"<tv><channel id=" a "><display-name>  РЕН &amp; ТВ <b>HD</b> </display-name><display-name/><icon src="ftp://bad"/><icon src="http://epg.one/a.png"/><icon src="https://ignored"/></channel><channel id="a"><display-name>Alias</display-name><icon src="https://ignored"/></channel><channel id="b"/><programme channel=" a " start="20260929090000 +0300" stop="20260929100000 +0300"><title> </title><title>First <b>nested</b> &amp; &#x1F600;</title><title>Last</title><desc><![CDATA[ description ]]></desc><desc>Ignored</desc><icon src="https://ignored"/></programme><programme channel="a" start="20260929080000 +0300" stop="20260929090000 +0300"/></tv>"#,
        );
        for input in [
            "202601010100",
            "20260101010000Z",
            "202601010100 UTC",
            "202601010100 GMT",
            "202601010100+0300",
            "202601010100 -0430",
            "000101010100 +0000",
            "202601010100 +2359",
            "202601010100 +2400",
            "202602300100 +0000",
            "20260101010060 +0000",
            "invalid",
            "202601010100 utc",
        ] {
            compare(&format!(
                r#"<tv><channel id="c"/><programme channel="c" start="{input}" stop="20260930120000 +0000"><title>T</title></programme></tv>"#
            ));
        }
        for whitespace in ['\u{0085}', '\u{00a0}', '\u{200b}', '\u{feff}'] {
            compare(&format!(
                r#"<tv><channel id="c"><display-name>{whitespace}N{whitespace}</display-name></channel><programme channel="c" start="202609291000" stop="202609291100"><title>{whitespace}T{whitespace}</title></programme></tv>"#
            ));
        }
    }

    #[test]
    fn hosted_rejects_truncated_dtd_late_channels_and_unbounded_fields() {
        for xml in [
            "<tv><channel id='c'/>",
            "<wrong/>",
            "<!DOCTYPE tv [<!ENTITY x 'bad'>]><tv/>",
            "<tv><programme/><channel id='late'/></tv>",
        ] {
            assert!(super::super::parse_xmltv_hosted(xml).is_err(), "{xml}");
        }
        assert!(super::super::parse_xmltv_hosted(&format!(
            "<tv><channel id='c'><display-name>{}</display-name></channel></tv>",
            "😀".repeat(8193)
        ))
        .is_err());
        assert!(super::super::parse_xmltv_hosted("<!DOCTYPE tv SYSTEM 'xmltv.dtd'><tv/>").is_ok());
        for declaration in [
            "tv",
            " tv\tSYSTEM 'xmltv.dtd' ",
            "tv  SYSTEM  \"xmltv.dtd\"",
            "tv SYSTEM \"a'b.dtd\"",
            "tv SYSTEM 'a[b].dtd'",
        ] {
            assert!(
                super::super::parse_xmltv_hosted(&format!("<!DOCTYPE {declaration}><tv/>")).is_ok(),
                "{declaration}"
            );
        }
        for declaration in [
            "tvSYSTEM 'xmltv.dtd'",
            "tv SYSTEM'xmltv.dtd'",
            "tv SYSTEM 'a' 'b'",
            "tv SYSTEM '<bad>'",
            "tv [<!ENTITY x 'bad'>]",
        ] {
            assert!(!inert_doctype(declaration), "{declaration}");
        }
        let deep = format!("<tv>{}<last/>{}</tv>", "<x>".repeat(15), "</x>".repeat(15));
        assert!(super::super::parse_xmltv_hosted(&deep).is_err());
    }
}
