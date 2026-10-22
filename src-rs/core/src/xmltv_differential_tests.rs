//! The server kernel is a compatibility implementation, not a second policy owner.
//! Compare it with the pinned Kotlin/QuickJS Rust profile through the same XML decoder.
use super::{parse_xmltv, parse_xmltv_shared_reference, Channels, Programs};
use serde_json::{json, Map, Value};

fn capture(result: anyhow::Result<(Channels, Programs)>) -> Value {
    match result {
        Ok((channels, programmes)) => {
            let channels: Map<String, Value> = channels.into_iter().map(|(id, row)| {
                (id, json!({"id": row.id, "name": row.name, "names": row.names, "icon": row.icon}))
            }).collect();
            json!({"result": {"channels": channels, "programmes": programmes}})
        }
        Err(error) => json!({"error": {
            "message": error.to_string(),
            "chain": error.chain().map(ToString::to_string).collect::<Vec<_>>()
        }}),
    }
}

fn compare(label: &str, xml: &str) {
    assert_eq!(
        capture(parse_xmltv(xml)),
        capture(parse_xmltv_shared_reference(xml)),
        "{label}"
    );
}

#[test]
fn server_records_match_shared_captured_contracts() {
    for (source, expected_count) in [
        (
            include_str!("../tests/fixtures/xmltv-records-before-core.json"),
            20,
        ),
        (
            include_str!("../tests/fixtures/xmltv-record-boundaries-before-core.json"),
            12,
        ),
    ] {
        let document: Value = serde_json::from_str(source).unwrap();
        let cases = document["cases"].as_array().unwrap();
        assert_eq!(cases.len(), expected_count);
        for row in cases {
            let xml = row["xml"].as_str().unwrap();
            let expected = &row["expected"]["browser"];
            for result in [parse_xmltv(xml), parse_xmltv_shared_reference(xml)] {
                assert_eq!(&capture(result), expected, "{}", row["name"]);
            }
        }
    }
}

#[test]
fn server_records_match_shared_calendar_and_unicode_boundaries() -> anyhow::Result<()> {
    let mut count = 0;
    let mut check = |input: &str| -> anyhow::Result<()> {
        assert_eq!(
            super::server_records::parse_time(input),
            super::parse_xmltv_time(input)?,
            "{input:?}"
        );
        count += 1;
        Ok(())
    };
    // The shared-core JavaScript calendar oracle's four-digit-year grid.
    for year in (1..=9999).step_by(41) {
        for month in 1..=12 {
            check(&format!("{year:04}{month:02}17123456 +0000"))?;
        }
    }
    for year in [
        0, 1, 1900, 1901, 1969, 1970, 2000, 2024, 2026, 2038, 2100, 9999,
    ] {
        for month in [0, 1, 2, 3, 12, 13] {
            for day in [0, 1, 28, 29, 30, 31, 32] {
                for time in ["000000", "235959", "240000", "236000", "235960"] {
                    check(&format!("{year:04}{month:02}{day:02}{time}"))?;
                }
            }
        }
    }
    // Include integer-encoding edges and suffix policies, not only valid UTC dates.
    for date in [
        "20260101000000",
        "19011213204551",
        "19011213204552",
        "20380119031407",
        "20380119031408",
        "99991231235959",
        "19700101000000",
        "19691231235959",
    ] {
        for zone in [
            "",
            "+0300",
            "-1200",
            "+0000ignored",
            "+9999",
            "+2360",
            "+💥",
            "+0💥",
            "+éé",
            "+é",
            "+000",
            "+ab00",
            "+００００",
            "+٠٣٠٠",
            "+𝟘𝟛𝟘𝟘",
            "-0x00",
            "UTC",
            "CET",
            "Z",
        ] {
            for separator in ["", " ", "\t", "\u{85}"] {
                check(&format!("{date}{separator}{zone}"))?;
            }
        }
    }
    let whitespace = [
        "", "\t", "\n", "\r", "\u{b}", "\u{c}", " ", "\u{85}", "\u{a0}", "\u{1680}", "\u{2000}",
        "\u{2001}", "\u{2002}", "\u{2003}", "\u{2004}", "\u{2005}", "\u{2006}", "\u{2007}",
        "\u{2008}", "\u{2009}", "\u{200a}", "\u{2028}", "\u{2029}", "\u{202f}", "\u{205f}",
        "\u{3000}", "\u{feff}", "\u{200b}",
    ];
    for edge in whitespace {
        for input in [
            "",
            "20260101",
            "20260101000060Z",
            "20260101000061Z",
            "20260101240000",
            "20260101000000 +9999",
            "20260101000000 +0300ignored",
            "20260101000000 +03",
            "20260101000000 +0💥",
            "2026010100000💥",
            "２０２６０１０１００００００",
            "٢٠٢٦٠١٠١٠٠٠٠٠٠",
            "𝟚𝟘𝟚𝟞𝟘𝟙𝟘𝟙𝟘𝟘𝟘𝟘𝟘𝟘",
            "19691231235959",
            "19700101000000",
        ] {
            check(&format!("{edge}{input}{edge}"))?;
        }
    }
    assert_eq!(count, 6476);
    Ok(())
}

#[test]
fn server_records_match_shared_repeated_fields_and_unicode_text() {
    let fields = [
        "<title>First</title><title>Last</title><desc>A</desc><desc>B</desc>",
        "<title>First</title><title></title><title> </title>",
        "<title/><desc/><title>After empty</title>",
        "<title>A &amp; <![CDATA[B]]> &#x43;</title><desc> x <![CDATA[ & y ]]>z</desc>",
        "<title>Before<unknown>Inside</unknown>After</title><desc>Tail</desc>",
        "<title>Before<desc>Nested</desc>After</title>",
        "<unknown><title>Nested title</title></unknown><desc>Text</desc>",
        "<title>Image</title><icon src=\"first\"/><icon/><icon src=\"last\"/>",
    ];
    let edges = [
        "",
        " ",
        "\u{85}",
        "\u{a0}",
        "\u{2007}",
        "\u{2028}",
        "\u{3000}",
        "\u{feff}",
        "\u{feff}\u{85}",
        "\u{85}\u{feff}",
    ];
    let mut xml = String::from("<tv>");
    for (i, edge) in edges.iter().enumerate() {
        xml.push_str(&format!("<channel id=\"c{i}\"><display-name>{edge}РЕН ТВ HD{edge}</display-name><display-name><![CDATA[{edge}𝟜 +4{edge}]]></display-name><icon src=\"a&amp;b\"/></channel>"));
        for field in fields {
            xml.push_str(&format!("<programme channel=\"c{i}\" start=\"20380119031408 -0530\" stop=\"19011213204551 +0000\">{field}</programme>"));
        }
        xml.push_str(&format!("<programme channel=\"c{i}\"><title>{edge}Title{edge}</title><desc>{edge}Описаниеé𝟜{edge}</desc></programme>"));
        // A duplicate channel replaces metadata, without deleting earlier programmes.
        xml.push_str(&format!(
            "<channel id=\"c{i}\"><display-name>Replacement</display-name></channel>"
        ));
    }
    xml.push_str("</tv>");
    compare("generated repeated/empty/nested fields and Unicode", &xml);
}

#[test]
fn server_records_match_shared_decoder_error_order_at_batch_boundaries() {
    let valid = "<programme channel=\"a\" start=\"20260928000000 +0300\" stop=\"20260928003000 +0300\"><title>Valid</title><desc>Text</desc></programme>";
    for count in [0, 1, 25, 26, 255, 256, 257] {
        let prefix = format!(
            "<tv><channel id=\"a\"><display-name>A</display-name></channel>{}",
            valid.repeat(count)
        );
        for suffix in [
            "<ignored>&unknown;</ignored></tv>",
            "<programme channel=\"a\"><title>&unknown;</title></programme></tv>",
            "<ignored>&unknown;</ignored><programme><title>&#0;</title></programme></tv>",
            "<programme><title>&unknown;</title></programme><tail></mismatch>",
            "<programme><title>A<x></x>&unknown;</title></programme></tv>",
            "<tail></mismatch>",
            "<programme><title>Unclosed",
            "<programme><title>&#x110000;</title></programme></tv>",
        ] {
            compare(
                &format!("events after {count} programmes; {suffix}"),
                &(prefix.clone() + suffix),
            );
        }
    }
    for length in [32767, 32768, 65535, 65536, 65537] {
        let value = "Ж".repeat(length);
        compare(&format!("large field {length}"), &format!("<tv><programme channel=\"a\"><title>{value}&amp;<![CDATA[尾]]></title><desc>&#x1F4FA;</desc></programme></tv>"));
    }
}

fn assert_complete_equal(actual: &(Channels, Programs), expected: &(Channels, Programs)) {
    assert_eq!(actual.0.len(), expected.0.len(), "channel count");
    for (id, row) in &actual.0 {
        let other = &expected.0[id];
        assert_eq!(
            (&row.id, &row.name, &row.icon, &row.names),
            (&other.id, &other.name, &other.icon, &other.names),
            "channel {id}"
        );
    }
    assert_eq!(actual.1.len(), expected.1.len(), "programme channel count");
    for (id, rows) in &actual.1 {
        let other = &expected.1[id];
        assert_eq!(rows.len(), other.len(), "programme count for {id}");
        for (position, (row, other)) in rows.iter().zip(other).enumerate() {
            assert_eq!(
                (row.start, row.stop, &row.title, &row.desc, &row.icon),
                (
                    other.start,
                    other.stop,
                    &other.title,
                    &other.desc,
                    &other.icon
                ),
                "channel {id}, programme {position}"
            );
        }
    }
}

fn fingerprint((channels, programmes): &(Channels, Programs)) -> String {
    let mut digest = 0xcbf29ce484222325u64;
    let mut consume = |value: &str| {
        for byte in value.as_bytes().iter().chain(std::iter::once(&0xffu8)) {
            digest = (digest ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
        }
    };
    let mut ids: Vec<_> = channels.keys().collect();
    ids.sort();
    for id in ids {
        let row = &channels[id];
        for value in [&row.id, &row.name, &row.icon] {
            consume(value);
        }
        for name in &row.names {
            consume(name);
        }
    }
    let mut ids: Vec<_> = programmes.keys().collect();
    ids.sort();
    for id in ids {
        consume(id);
        for row in &programmes[id] {
            consume(&row.start.to_string());
            consume(&row.stop.to_string());
            consume(&row.title);
            consume(&row.desc);
            consume(&row.icon);
        }
    }
    format!("{digest:016x}")
}

#[test]
#[ignore = "explicit local full-feed check; requires OTTPLAY_XMLTV_DIFFERENTIAL_FEED"]
fn server_records_match_shared_full_feed() -> anyhow::Result<()> {
    use std::io::Read;
    let input = std::fs::read(std::env::var("OTTPLAY_XMLTV_DIFFERENTIAL_FEED")?)?;
    let xml = if input.starts_with(&[0x1f, 0x8b]) {
        let mut result = String::new();
        flate2::read::GzDecoder::new(&input[..]).read_to_string(&mut result)?;
        result
    } else {
        String::from_utf8(input)?
    };
    let start = std::time::Instant::now();
    let actual = parse_xmltv(&xml)?;
    let native_ms = start.elapsed().as_secs_f64() * 1000.0;
    let start = std::time::Instant::now();
    let expected = parse_xmltv_shared_reference(&xml)?;
    let shared_ms = start.elapsed().as_secs_f64() * 1000.0;
    assert_complete_equal(&actual, &expected);
    // Equality above compares every field, including ordering. The compact FNV
    // fingerprint only links to earlier diagnostics; it is not the equality oracle.
    println!(
        "{}",
        json!({"xml_bytes":xml.len(), "channels":actual.0.len(),
        "programmes":actual.1.values().map(Vec::len).sum::<usize>(),
        "native_parse_ms":native_ms,"shared_parse_ms":shared_ms,
        "output_fingerprint":fingerprint(&actual), "all_fields_equal":true})
    );
    Ok(())
}

#[test]
fn server_records_match_shared_programme_attribute_scan() {
    let attributes = [
        "channel='a&amp;b'",
        "start='20260928000000 +0300'",
        "stop='20260928003000 +0300'",
    ];
    let mut cases = Vec::new();
    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        let ordered = order.map(|index| attributes[index]).join(" ");
        for prefix in [
            "",
            "ignored='value' ",
            "bare ",
            "junk=unquoted ",
            "junk='one' junk='two' ",
        ] {
            cases.push(format!("{prefix}{ordered} trailing='&unsupported;'"));
        }
        cases.push(format!(
            "{} ignored='x' {} ignored='duplicate' {}",
            attributes[order[0]], attributes[order[1]], attributes[order[2]]
        ));
    }
    // A failed first decode still wins over later duplicate attributes. Their
    // decoding errors, and unrelated attribute errors, must stay ignored.
    for key in ["channel", "start", "stop"] {
        for value in [
            "",
            "replacement",
            "20260928010000 +0000",
            "&unsupported;",
            "&#x110000;",
            "&#0;",
        ] {
            cases.push(format!("{key}='{value}' {}", attributes.join(" ")));
            cases.push(format!("{} {key}='{value}'", attributes.join(" ")));
        }
    }
    cases.extend([
        "channel='a&#38;b' start='20260928000000&#32;+0300' stop='20260928003000&#x20;+0300'"
            .into(),
        "channel='a\tb' start='20260928000000\r\n+0300' stop='20260928003000\t+0300'".into(),
        "channel='a&amp;b'".into(),
        "start='20260928000000 +0300' stop='20260928003000 +0300'".into(),
        "channel=a start='20260928000000 +0300' channel='a&amp;b' stop='20260928003000 +0300'"
            .into(),
        "channel 'lost' start='20260928000000 +0300' channel='a&amp;b' stop='20260928003000 +0300'"
            .into(),
    ]);
    // Exercise quick-xml's hashed duplicate-check path as well as the usual
    // handful of attributes, and preserve the early stop after all three keys.
    let extras = (0..40)
        .map(|index| format!("x{index}='ignored' "))
        .collect::<String>();
    cases.push(format!("{extras}{} x2='duplicate'", attributes.join(" ")));
    cases.push(format!(
        "{} {extras}channel='duplicate'",
        attributes.join(" ")
    ));
    for (index, attributes) in cases.iter().enumerate() {
        for title in ["First", "&unsupported;"] {
            compare(&format!("programme attributes {index}: {attributes}"), &format!(
                "<tv><channel id='a&amp;b'><display-name>A</display-name></channel><programme {attributes}><title>{title}</title><desc>Description</desc></programme><programme channel='a&amp;b'><title>Following</title></programme></tv>"
            ));
        }
    }
    assert_eq!(cases.len(), 80);
}
