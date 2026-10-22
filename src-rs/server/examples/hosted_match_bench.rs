//! Offline QuickJS measurement. External runner owns deadlines and SHA-256 receipts.
use anyhow::{ensure, Result};
use flate2::read::GzDecoder;
use md5::{Digest, Md5};
use ottplay_core::xmltv::{parse_xmltv_hosted, MatchBudget, MatchIndex};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Write},
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    version: u8,
    source: String,
    channels: Vec<Channel>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Channel {
    id: String,
    tvg_id: String,
    tvg_name: String,
    name: String,
}

fn emit(value: Value) -> Result<()> {
    println!("{value}");
    std::io::stdout().flush()?;
    Ok(())
}
fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
fn digest(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Md5::digest(serde_json::to_vec(value)?)))
}

fn parity() -> Result<()> {
    let rows = [
        ["ren", "РЕН ТВ"],
        ["ren", "REN TV"],
        ["other", "Другой"],
        ["amb1", "Shared Alias"],
        ["amb2", "Shared Alias"],
        ["emoji", "📺 Ünicode"],
        ["first", "abcd"],
        ["second", "abce"],
    ]
    .iter()
    .map(|row| row.iter().map(|s| s.to_string()).collect())
    .collect();
    let index = MatchIndex::web(rows)?;
    let cases = [
        ("ren", "Другой", "Other +7", Some("ren"), 25200),
        ("missing", "REN TV", "Другой", Some("ren"), 0),
        ("missing", "", "РЕН ТВ HD +3", Some("ren"), 10800),
        ("", "Shared Alias", "", Some("amb1"), 0),
        ("amb2", "Shared Alias", "", Some("amb2"), 0),
        ("", "", "📺 Ünicode", Some("emoji"), 0),
        ("", "", "abcf", None, 0),
        ("", "", "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", None, 0),
    ];
    let start = Instant::now();
    let mut outputs = Vec::new();
    for (id, tvg, name, expected, expected_shift) in cases {
        let found = index.resolve(id, &[tvg, name])?;
        ensure!(found.as_deref() == expected, "PARITY_MATCH");
        let shift = if found.is_some() {
            index.web_shift_seconds(name)?
        } else {
            0
        };
        ensure!(shift == expected_shift, "PARITY_SHIFT");
        outputs.push((found, shift));
    }
    emit(json!({"stage":"parity","passed":true,"cases":outputs.len(),
        "matchMs":ms(start),"outputMd5":digest(&outputs)?}))
}

fn run() -> Result<()> {
    let compiled_core_md5 = format!(
        "{:x}",
        Md5::digest(include_bytes!("../../../vendor/ottplay-core.js"))
    );
    emit(json!({"stage":"core", "compiledCoreMd5":compiled_core_md5}))?;
    let args: Vec<String> = std::env::args().collect();
    ensure!(
        args.len() == 5 && args[4] == compiled_core_md5,
        "COMPILED_CORE"
    );
    ensure!(
        args[3] != "full" || compiled_core_md5 != "dd5c2c9e8634b6e17b63a6ab541b6046",
        "OLD_CORE_FULL_FORBIDDEN"
    );
    let count = match args[3].as_str() {
        "baseline" => 40, // Exactly 32 known metadata rows plus only eight misses.
        "full" => 2048,
        _ => anyhow::bail!("MODE"),
    };
    let raw = std::fs::read(&args[2])?;
    ensure!(raw.len() <= 512 * 1024, "INPUT_BYTES");
    let input: Input = serde_json::from_slice(&raw)?;
    ensure!(
        input.version == 1 && input.source == "epg-one" && input.channels.len() == 2048,
        "INPUT"
    );
    ensure!(
        input
            .channels
            .iter()
            .map(|c| &c.id)
            .collect::<HashSet<_>>()
            .len()
            == 2048,
        "DUPLICATE_IDS"
    );
    ensure!(
        input
            .channels
            .iter()
            .all(|c| [&c.id, &c.tvg_id, &c.tvg_name, &c.name]
                .iter()
                .all(|v| v.encode_utf16().count() <= 512)),
        "INPUT_FIELDS"
    );
    parity()?;
    let started = Instant::now();
    let mut xml = String::new();
    GzDecoder::new(File::open(&args[1])?)
        .take(512 * 1024 * 1024 + 1)
        .read_to_string(&mut xml)?;
    ensure!(xml.len() <= 512 * 1024 * 1024, "XML_BYTES");
    emit(json!({"stage":"decode","decodeMs":ms(started),"xmlBytes":xml.len()}))?;
    let started = Instant::now();
    let (channels, programs, aliases) = parse_xmltv_hosted(&xml)?;
    let parsed_ms = ms(started);
    let alias_count = aliases.len();
    let alias_md5 = digest(&aliases)?;
    emit(
        json!({"stage":"parse","parseMs":parsed_ms,"channels":channels.len(),
        "programmes":programs.values().map(Vec::len).sum::<usize>(),
        "aliases":alias_count,"aliasesMd5":alias_md5}),
    )?;
    // Retain parsed channels/programmes, like a live immutable server snapshot.
    drop(xml);
    let started = Instant::now();
    let index = MatchIndex::web(aliases)?;
    emit(json!({"stage":"index","indexMs":ms(started)}))?;
    let started = Instant::now();
    let mut mappings = Vec::new();
    let mut known_ms = 0.0;
    let budget = MatchBudget::new(Duration::from_secs(8));
    for (position, row) in input.channels.iter().take(count).enumerate() {
        let resolved = index.resolve_web_with_budget(
            &row.tvg_id, &[&row.tvg_name, &row.name], &row.name, &budget,
        )?;
        let found = resolved.as_ref().map(|(id, _)| id.clone());
        if position < 32 {
            ensure!(found.as_deref() == Some("18"), "REN_MAPPING");
        } else {
            ensure!(found.is_none(), "UNEXPECTED_MAPPING");
        }
        if let Some(id) = found {
            ensure!(channels.contains_key(&id), "UNKNOWN_CHANNEL");
            let shift = resolved.expect("resolved matching row").1;
            ensure!(shift == 0, "REN_SHIFT");
            mappings.push((position, id, shift));
        }
        if position == 31 {
            known_ms = ms(started);
        }
    }
    let match_ms = ms(started);
    emit(json!({"stage":"match","passed":true,"adapter":"resolve_web_with_budget","budgetMs":8000,"requested":count,
        "mappings":mappings.len(),"unmatched":count-mappings.len(),
        "knownMatchMs":known_ms,"missMatchMs":match_ms-known_ms,"matchMs":match_ms,
        "mappingsMd5":digest(&mappings)?,"retainedProgrammeChannels":programs.len()}))
}

fn main() {
    if run().is_err() {
        let _ = emit(json!({"stage":"failure","passed":false,"code":"OFFLINE_BENCH_FAILED"}));
        std::process::exit(1);
    }
}
