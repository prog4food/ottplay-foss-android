//! Repeatable adapter benchmark. All records are synthetic and require no network.
use ottplay_core::xmltv::{self, Channel, Channels};
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let mut xml = String::from("<tv><channel id='one'><display-name>One</display-name></channel>");
    let origin = chrono::DateTime::from_timestamp(1767225600, 0).unwrap();
    for i in 0..100_000 {
        let start = origin + chrono::Duration::minutes((i % 200) * 30);
        let stop = start + chrono::Duration::minutes(30);
        xml.push_str(&format!("<programme channel='one' start='{} +0000' stop='{} +0000'><title>News</title></programme>", start.format("%Y%m%d%H%M%S"), stop.format("%Y%m%d%H%M%S")));
    }
    xml.push_str("</tv>");
    let start = Instant::now();
    let (_, programs) = xmltv::parse_xmltv_native(&xml)?;
    assert_eq!(programs["one"].len(), 100_000);
    let parse_ms = start.elapsed().as_millis();
    let timestamps: Vec<_> = (0..100_000)
        .map(|i| {
            (origin + chrono::Duration::seconds(i))
                .format("%Y%m%d%H%M%S +0000")
                .to_string()
        })
        .collect();
    let start = Instant::now();
    for (i, value) in timestamps.iter().enumerate() {
        assert_eq!(
            xmltv::parse_xmltv_time(value)?,
            origin.timestamp() + i as i64
        );
    }
    let distinct_dates_ms = start.elapsed().as_millis();
    let start = Instant::now();
    for (i, value) in timestamps.iter().enumerate() {
        assert_eq!(
            chrono::DateTime::parse_from_str(value, "%Y%m%d%H%M%S %z")?.timestamp(),
            origin.timestamp() + i as i64
        );
    }
    let chrono_dates_ms = start.elapsed().as_millis();
    let channels: Channels = (0..2_000)
        .map(|i| {
            let id = format!("id{i}");
            (
                id.clone(),
                Channel {
                    id,
                    name: format!("Channel {i} News"),
                    ..Default::default()
                },
            )
        })
        .collect();
    let start = Instant::now();
    let index = xmltv::build_match_index(&channels)?;
    let index_ms = start.elapsed().as_millis();
    let start = Instant::now();
    for i in 0..500 {
        assert!(xmltv::match_in_index(&format!("Channel {i} News Extra"), &index)?.is_some());
    }
    println!(
        "{}",
        serde_json::json!({"programmes": 100_000, "xml_bytes": xml.len(), "parse_ms": parse_ms, "distinct_dates": 100_000, "distinct_dates_ms": distinct_dates_ms, "chrono_oracle_ms": chrono_dates_ms,
        "catalog_channels": channels.len(), "index_ms": index_ms, "fuzzy_queries": 500, "fuzzy_ms": start.elapsed().as_millis()})
    );
    Ok(())
}
