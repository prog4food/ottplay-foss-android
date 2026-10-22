use ottplay_core::{stalker, vportal, xmltv as guide};
use serde_json::json;
use std::collections::BTreeMap;

pub fn xmltv(data: &[u8]) {
    if data.len() > 8192 {
        return;
    }
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    // All three production profiles are deliberate: their duplicate and alias
    // policies differ, so cross-profile equality would be a false oracle.
    for parse in [guide::parse_xmltv, guide::parse_xmltv_native] {
        if let Ok((channels, programs)) = parse(text) {
            assert!(channels.len() <= text.len());
            assert!(programs.values().map(Vec::len).sum::<usize>() <= text.len());
            for (id, channel) in channels {
                assert_eq!(id, channel.id);
            }
        }
    }
    if let Ok((channels, programs, aliases)) = guide::parse_xmltv_hosted(text) {
        assert!(channels.len() <= 16_384 && aliases.len() <= 65_536);
        assert!(programs.values().map(Vec::len).sum::<usize>() <= 2_000_000);
        for (id, channel) in channels {
            assert_eq!(id, channel.id);
        }
        for rows in programs.values() {
            assert!(rows.iter().all(|row| row.stop > row.start));
            assert!(rows
                .windows(2)
                .all(|pair| (pair[0].start, pair[0].stop) <= (pair[1].start, pair[1].stop)));
        }
    }
    // Timestamp helpers are real production paths, not an independent parser.
    let _ = guide::parse_xmltv_time(text);
}

fn check_stalker(request: stalker::Request) {
    if let Ok(headers) = request.validate() {
        let url = url::Url::parse(&request.url).unwrap();
        assert!(matches!(url.scheme(), "http" | "https"));
        assert!(url.host_str().is_some() && url.username().is_empty());
        assert!(url.password().is_none() && url.fragment().is_none());
        assert!(url.path().ends_with("/load.php") || url.path().ends_with("/portal.php"));
        assert!(headers.contains_key("cookie"));
        for (name, value) in &headers {
            assert!(matches!(
                name.as_str(),
                "cookie" | "authorization" | "x-user-agent" | "referer" | "user-agent" | "accept"
            ));
            assert!(value.as_bytes().len() <= 4096);
        }
        if let Some(value) = headers.get("referer") {
            let referer = url::Url::parse(value.to_str().unwrap()).unwrap();
            assert_eq!(url.origin(), referer.origin());
            assert!(referer.username().is_empty() && referer.password().is_none());
        }
        let pairs: Vec<_> = url.query_pairs().collect();
        for key in ["type", "action", "JsHttpRequest"] {
            assert_eq!(pairs.iter().filter(|(name, _)| name == key).count(), 1);
        }
    }
}

fn check_vportal(request: vportal::Request) {
    if request.validate().is_ok() {
        let url = url::Url::parse(&request.url).unwrap();
        assert!(matches!(url.scheme(), "http" | "https"));
        assert!(url.host_str().is_some() && url.username().is_empty());
        assert!(url.password().is_none() && url.fragment().is_none());
        assert!(request.params.is_object());
        assert_eq!(request.params["app"], "ott-play");
        assert!(!request.params["key"].as_str().unwrap().trim().is_empty());
        assert!(request.params.to_string().len() <= 64 * 1024);
    }
}

pub fn portal_request(data: &[u8]) {
    if data.len() > 32_768 {
        return;
    }
    if let Ok(request) = serde_json::from_slice::<stalker::Request>(data) {
        check_stalker(request);
    }
    if let Ok(request) = serde_json::from_slice::<vportal::Request>(data) {
        check_vportal(request);
    }
    if let Ok(text) = std::str::from_utf8(data) {
        check_stalker(stalker::Request {
            url: text.into(),
            headers: BTreeMap::from([("Cookie".into(), "mac=00:00:00:00:00:01".into())]),
        });
        check_vportal(vportal::Request {
            url: text.into(),
            params: json!({"app":"ott-play", "key":"synthetic-fixture"}),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corpus_regressions() {
        for (name, run) in [
            ("xmltv", xmltv as fn(&[u8])),
            ("portal_request", portal_request as fn(&[u8])),
        ] {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("corpus")
                .join(name);
            for entry in std::fs::read_dir(path).unwrap() {
                run(&std::fs::read(entry.unwrap().path()).unwrap());
            }
            run(b"");
            run(&[0xff, 0]);
        }
    }
}
