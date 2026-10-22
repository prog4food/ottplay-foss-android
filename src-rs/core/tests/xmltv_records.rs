//! Compare both shipping QuickXML adapters with outputs captured before migration.
use ottplay_core::xmltv;
use serde_json::{json, Map, Value};

fn capture(xml: &str, native: bool) -> Value {
    let parsed = if native {
        xmltv::parse_xmltv_native(xml)
    } else {
        xmltv::parse_xmltv(xml)
    };
    match parsed {
        Ok((channels, programmes)) => {
            let channels: Map<String, Value> = channels
                .into_iter()
                .map(|(id, row)| {
                    (
                        id,
                        json!({"id": row.id, "name": row.name, "names": row.names, "icon": row.icon}),
                    )
                })
                .collect();
            json!({"result": {"channels": channels, "programmes": programmes}})
        }
        Err(error) => {
            json!({"error": {"message": error.to_string(), "chain": error.chain().map(ToString::to_string).collect::<Vec<_>>()}})
        }
    }
}

fn verify(fixture: &str, count: usize) {
    let document: Value = serde_json::from_str(fixture).expect("valid saved fixture");
    let cases = document["cases"].as_array().expect("saved XML cases");
    assert_eq!(cases.len(), count);
    for row in cases {
        let name = row["name"].as_str().expect("case name");
        let xml = row["xml"].as_str().expect("case XML");
        for (profile, native) in [("browser", false), ("native", true)] {
            assert_eq!(
                capture(xml, native),
                row["expected"][profile],
                "{name} ({profile})"
            );
        }
    }
}

#[test]
fn original_record_contracts_match_both_shipping_parsers() {
    verify(include_str!("fixtures/xmltv-records-before-core.json"), 20);
}

#[test]
fn text_errors_and_batch_boundaries_match_both_shipping_parsers() {
    verify(
        include_str!("fixtures/xmltv-record-boundaries-before-core.json"),
        12,
    );
}
