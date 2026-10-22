//! Native compatibility backend for the server's shared `rust` record profile.
//! QuickXML still owns tokenization and decoding. Calendar/record changes must
//! remain equivalent to the pinned shared core, checked by differential tests.
use super::{attr, Channel, Channels, Programme, Programs};
use quick_xml::events::BytesStart;

#[derive(Clone, Copy)]
enum Field {
    Name,
    Title,
    Description,
}

#[derive(Default)]
pub(super) struct ServerRecords {
    channel: Option<Channel>,
    programme: Option<(String, Programme)>,
    field: Option<Field>,
    text: String,
}

impl ServerRecords {
    pub(super) fn start(&mut self, element: &BytesStart<'_>) {
        match element.name().as_ref() {
            b"channel" => {
                self.channel = Some(Channel {
                    id: attr(element, "id").unwrap_or_default(),
                    ..Channel::default()
                });
            }
            b"programme" => {
                let mut values = [None, None, None];
                let mut seen = 0u8;
                // Retain QuickXML's duplicate checks and first-value semantics,
                // including a first value that fails decoding and defaults empty.
                for attribute in element.attributes().flatten() {
                    let field = match attribute.key.as_ref() {
                        b"channel" => 0,
                        b"start" => 1,
                        b"stop" => 2,
                        _ => continue,
                    };
                    values[field] = attribute
                        .decoded_and_normalized_value(
                            quick_xml::XmlVersion::Implicit1_0,
                            element.decoder(),
                        )
                        .ok();
                    seen |= 1 << field;
                    if seen == 7 {
                        break;
                    }
                }
                let [channel, start, stop] = values;
                self.programme = Some((
                    channel.unwrap_or_default().into_owned(),
                    Programme {
                        start: parse_time(&start.unwrap_or_default()),
                        stop: parse_time(&stop.unwrap_or_default()),
                        ..Programme::default()
                    },
                ));
            }
            b"display-name" if self.channel.is_some() => self.capture(Field::Name),
            b"title" if self.programme.is_some() => self.capture(Field::Title),
            b"desc" if self.programme.is_some() => self.capture(Field::Description),
            b"icon" => {
                if let Some(icon) = attr(element, "src") {
                    if let Some(channel) = &mut self.channel {
                        channel.icon = icon;
                    } else if let Some((_, programme)) = &mut self.programme {
                        programme.icon = icon;
                    }
                }
            }
            _ => {}
        }
    }

    fn capture(&mut self, field: Field) {
        self.field = Some(field);
        self.text.clear();
    }

    pub(super) fn text(
        &mut self,
        value: anyhow::Result<std::borrow::Cow<'_, str>>,
    ) -> anyhow::Result<()> {
        // Unsupported entities outside a consumed field are intentionally ignored.
        if self.field.is_some() {
            self.text.push_str(&value?);
        }
        Ok(())
    }

    pub(super) fn end(&mut self, name: &[u8], channels: &mut Channels, programs: &mut Programs) {
        match name {
            b"display-name" | b"title" | b"desc" => {
                let value = self.text.trim();
                match self.field {
                    Some(Field::Name) => {
                        if let Some(channel) = &mut self.channel {
                            channel.name = value.into();
                            channel.names.push(value.into());
                        }
                    }
                    Some(Field::Title) => {
                        if let Some((_, programme)) = &mut self.programme {
                            programme.title = value.into();
                        }
                    }
                    Some(Field::Description) => {
                        if let Some((_, programme)) = &mut self.programme {
                            programme.desc = value.into();
                        }
                    }
                    None => {}
                }
                self.text.clear();
            }
            b"channel" => {
                if let Some(mut channel) = self.channel.take() {
                    if channel.name.is_empty() {
                        channel.name = channel.id.clone();
                    }
                    channels.insert(channel.id.clone(), channel);
                }
            }
            b"programme" => {
                if let Some((id, programme)) = self.programme.take() {
                    if !programme.title.is_empty() {
                        programs.entry(id).or_default().push(programme);
                    }
                }
            }
            _ => {}
        }
        // The shared Rust profile ends field capture on every closing token,
        // including an unknown nested element, and preserves programme order.
        self.field = None;
    }
}

pub(super) fn parse_time(value: &str) -> i64 {
    let value = value.trim();
    let bytes = value.as_bytes();
    if bytes.len() < 14 || !bytes[..14].iter().all(u8::is_ascii_digit) {
        return 0;
    }
    let pair =
        |offset: usize| u32::from(bytes[offset] - b'0') * 10 + u32::from(bytes[offset + 1] - b'0');
    let second = pair(12);
    // chrono's timestamp and the shared Rust profile both map leap second 60
    // to the preceding second; 61 and higher remain invalid.
    let second = if second == 60 { 59 } else { second };
    let Some(date) =
        chrono::NaiveDate::from_ymd_opt((pair(0) * 100 + pair(2)) as i32, pair(4), pair(6))
            .and_then(|date| date.and_hms_opt(pair(8), pair(10), second))
    else {
        return 0;
    };
    let zone = value[14..].trim().as_bytes();
    let mut offset = 0;
    if zone.len() >= 5 && matches!(zone[0], b'+' | b'-') {
        if !zone[1..5].iter().all(u8::is_ascii_digit) {
            return 0;
        }
        let hours = i64::from(zone[1] - b'0') * 10 + i64::from(zone[2] - b'0');
        let minutes = i64::from(zone[3] - b'0') * 10 + i64::from(zone[4] - b'0');
        offset = (hours * 3600 + minutes * 60) * if zone[0] == b'-' { -1 } else { 1 };
    }
    date.and_utc().timestamp() - offset
}
