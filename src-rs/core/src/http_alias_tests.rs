use super::*;
use crate::{m3u, native_xmltv};

fn channel(id: &str, names: &[&str]) -> Channel {
    Channel {
        id: id.into(),
        name: names.last().unwrap().to_string(),
        names: names.iter().map(|name| name.to_string()).collect(),
        icon: format!("https://fixture.test/{id}.png"),
    }
}

fn ren_channels(ids: [&str; 3], order: [usize; 3]) -> Channels {
    let rows = [
        channel(ids[0], &["Рен ТВ HD", "Рен ТВ HD orig"]),
        channel(ids[1], &["РЕН ТВ +3 (Омск)", "РЕН ТВ +4 (Томск)", "Рен ТВ +4"]),
        channel(ids[2], &["РЕН ТВ +7 (Владивосток)", "Рен ТВ +6", "Рен ТВ +7"]),
    ];
    order.into_iter().map(|n| (ids[n].into(), rows[n].clone())).collect()
}

#[test]
fn http_alias_match_ignores_insertion_order_and_numeric_identity() -> anyhow::Result<()> {
    for ids in [["18", "3033", "3034"], ["z-original", "a-regional", "b-regional"]] {
        for order in [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] {
            let channels = ren_channels(ids, order);
            // Reproduce the previous failure: the only legacy exact keys are
            // shifted aliases, so the base channel loses independently of order.
            let legacy = build_match_index(&channels)?;
            assert_ne!(legacy.match_name("РЕН ТВ HD")?.unwrap().0, ids[0]);
            let index = build_http_match_index(&channels)?;
            for name in ["РЕН ТВ HD", "рен тв", " \tРен\u{a0}ТВ  hd "] {
                assert_eq!(index.match_name(name)?, Some((ids[0].into(), 1.0)));
            }
            assert_eq!(index.match_name("Рен ТВ +4")?, Some((ids[1].into(), 1.0)));
            assert_eq!(index.match_name("Рен ТВ +7")?, Some((ids[2].into(), 1.0)));
            assert_eq!(index.resolve(ids[2], &["РЕН ТВ HD"])?, Some(ids[2].into()));
        }
    }
    Ok(())
}

#[test]
fn http_alias_match_deduplicates_ids_and_leaves_real_ambiguity_unresolved() -> anyhow::Result<()> {
    let channels = Channels::from([
        ("one".into(), channel("one", &["Cinema HD", "Cinema HD", " Cinema\u{a0}HD "])),
        ("two".into(), channel("two", &["Cinema FHD"])),
        ("news".into(), channel("news", &["News", "News", "NEWS"])),
    ]);
    let index = build_http_match_index(&channels)?;
    assert_eq!(index.match_name("Cinema HD")?, Some(("one".into(), 1.0)));
    assert_eq!(index.match_name("Cinema")?, None, "two distinct canonical IDs are ambiguous");
    assert_eq!(index.match_name("News")?, Some(("news".into(), 1.0)));
    let duplicate = Channels::from([
        ("one".into(), channel("one", &["Same"])),
        ("two".into(), channel("two", &["Same"])),
    ]);
    assert_eq!(build_http_match_index(&duplicate)?.match_name("Same")?, None);
    Ok(())
}

#[test]
fn http_alias_match_preserves_legacy_fuzzy_missing_and_snapshot_lifetime() -> anyhow::Result<()> {
    let channels = Channels::from([("news".into(), channel("news", &["News"]))]);
    let legacy = build_match_index(&channels)?;
    let index = build_http_match_index(&channels)?;
    for name in ["News Extra", "Definitely unrelated 482059", "", "  "] {
        assert_eq!(index.match_name(name)?, legacy.match_name(name)?, "{name}");
    }
    let retained = index.clone();
    let replacement = build_http_match_index(&Channels::from([
        ("replacement".into(), channel("replacement", &["News"])),
    ]))?;
    std::thread::spawn(move || {
        assert_eq!(retained.match_name("News").unwrap(), Some(("news".into(), 1.0)));
    }).join().unwrap();
    assert_eq!(replacement.match_name("News")?, Some(("replacement".into(), 1.0)));
    Ok(())
}

#[test]
fn http_alias_match_returns_the_base_schedule_and_applies_playlist_shift_once() -> anyhow::Result<()> {
    let channels = ren_channels(["z-original", "a-regional", "b-regional"], [2, 1, 0]);
    let now = chrono::Utc::now().timestamp();
    let programs = [("z-original", "Base programme"), ("a-regional", "Wrong +4 programme"), ("b-regional", "Wrong +7 programme")]
        .into_iter().map(|(id, title)| (id.into(), vec![Programme {
            start: now - 60, stop: now + 600, title: title.into(), ..Default::default()
        }])).collect();
    let cache = XmltvCache { channels, programs, ..Default::default() };
    let index = build_http_match_index(&cache.channels)?;
    for (name, shift) in [("РЕН ТВ HD", 0), ("РЕН ТВ +4", 4)] {
        let body = format!("{{}}\n\t\n\n\t\n57-0-0-17~{}", urlencoding::encode(name));
        let mut map = HashMap::new();
        let mut shifts = HashMap::new();
        let response = m3u::match_channels_text_with_index(&body, &cache.channels, &index, &mut map, &mut shifts)?;
        let hash = m3u::compute_epg_hash(&format!("z-original|{shift}"));
        assert_eq!(response, format!("{{}}\n\t\n57~local~{hash}\n\t\nlocal~/"));
        assert_eq!(map[&hash], "z-original");
        assert_eq!(shifts.get(&hash).copied().unwrap_or(0), shift);
        let guide = crate::get_epg_slice_with_index(&cache, &index, &hash, &map[&hash], shift, 48)?;
        assert_eq!(guide["epg_data"][0]["name"], "Base programme");
        assert_eq!(guide["epg_data"][0]["time"], now - 60 + shift * 3600);
        assert_eq!(m3u::match_logos_text_with_index(&body, &cache.channels, &index)?,
            "{}\n\t\n57~https://fixture.test/z-original.png");
    }
    // Native explicit-ID resolution retains the existing authoritative identity,
    // even when its display name would otherwise choose the canonical base.
    assert_eq!(native_xmltv::resolve_id(&cache, "a-regional", "", "РЕН ТВ HD")?, Some("a-regional".into()));
    Ok(())
}
