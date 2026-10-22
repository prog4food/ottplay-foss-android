//! Reproducible release-mode EPG CPU benchmark; input is a local XMLTV file.
//! cargo run --release -p ottplay-core --example epg_bench -- feed.xml [parse|match|http-match]
use ottplay_core::xmltv;
use serde_json::json;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let path = args.get(1).expect("local XMLTV file");
    let mode = args.get(2).map(String::as_str).unwrap_or("parse");
    anyhow::ensure!(
        matches!(mode, "parse" | "match" | "http-match"),
        "Unknown benchmark mode"
    );
    let xml = std::fs::read_to_string(path)?;
    let begin = Instant::now();
    let (channels, programmes) = xmltv::parse_xmltv(&xml)?;
    let parse_ms = begin.elapsed().as_secs_f64() * 1000.0;
    println!(
        "{}",
        json!({"phase":"parse", "xml_bytes":xml.len(), "channels":channels.len(),
        "programmes":programmes.values().map(Vec::len).sum::<usize>(), "elapsed_ms":parse_ms})
    );
    if mode != "parse" {
        let begin = Instant::now();
        let index = if mode == "http-match" {
            xmltv::build_http_match_index(&channels)?
        } else {
            xmltv::build_match_index(&channels)?
        };
        println!(
            "{}",
            json!({"phase":"index", "profile":mode, "channels":channels.len(), "elapsed_ms":begin.elapsed().as_secs_f64()*1000.0})
        );
        let mut names: Vec<_> = channels.values().map(|c| c.name.clone()).collect();
        names.sort();
        names.truncate(500);
        for pass in 0..3 {
            let begin = Instant::now();
            let mut found = 0;
            for name in &names {
                if xmltv::match_in_index(name, &index)?.is_some() {
                    found += 1;
                }
            }
            println!(
                "{}",
                json!({"phase":"match", "pass":pass, "queries":names.len(), "found":found,
                "elapsed_ms":begin.elapsed().as_secs_f64()*1000.0})
            );
        }
    }
    // Hash complete outputs in deterministic channel order outside the timed region.
    let mut ids: Vec<_> = channels.keys().collect();
    ids.sort();
    let mut digest = 0xcbf29ce484222325u64;
    let mut consume = |value: &str| {
        for byte in value.as_bytes().iter().chain(std::iter::once(&0xffu8)) {
            digest = (digest ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
        }
    };
    for id in ids {
        let channel = &channels[id];
        for value in [&channel.id, &channel.name, &channel.icon] {
            consume(value);
        }
        for name in &channel.names {
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
    println!(
        "{}",
        json!({"phase":"result", "output_fingerprint":format!("{digest:016x}")})
    );
    Ok(())
}
