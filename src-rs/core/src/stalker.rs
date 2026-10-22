//! Narrow, bounded transport for the classic MAG client in the shared JS core.
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Url,
};
use serde::Deserialize;
use std::collections::BTreeMap;

pub const MAX_REQUEST_BYTES: usize = 32 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

impl Request {
    pub fn validate(&self) -> Result<HeaderMap, &'static str> {
        let url = Url::parse(&self.url).map_err(|_| "Invalid Stalker URL")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || self.url.len() > 8192
            || !["/load.php", "/portal.php"]
                .iter()
                .any(|p| url.path().ends_with(p))
        {
            return Err("Invalid Stalker URL");
        }
        let pairs: Vec<_> = url.query_pairs().collect();
        let one = |key: &str| {
            let values: Vec<_> = pairs.iter().filter(|(k, _)| k == key).collect();
            if values.len() == 1 {
                Some(values[0].1.as_ref())
            } else {
                None
            }
        };
        let allowed = matches!(
            (one("type"), one("action")),
            (Some("stb"), Some("handshake" | "get_profile"))
                | (
                    Some("itv"),
                    Some(
                        "get_genres"
                            | "get_all_channels"
                            | "get_ordered_list"
                            | "create_link"
                            | "get_short_epg"
                            | "get_epg_info"
                    )
                )
        );
        if !allowed || one("JsHttpRequest") != Some("1-xml") {
            return Err("Invalid Stalker action");
        }
        let mut headers = HeaderMap::new();
        for (key, value) in &self.headers {
            if value.len() > 4096 {
                return Err("Invalid Stalker header");
            }
            let name =
                HeaderName::from_bytes(key.as_bytes()).map_err(|_| "Invalid Stalker header")?;
            if !matches!(
                name.as_str(),
                "cookie" | "authorization" | "x-user-agent" | "referer"
            ) || headers.contains_key(&name)
            {
                return Err("Invalid Stalker header");
            }
            if name == "referer" {
                let referer = Url::parse(value).map_err(|_| "Invalid Stalker referer")?;
                if referer.origin() != url.origin()
                    || !referer.username().is_empty()
                    || referer.password().is_some()
                {
                    return Err("Invalid Stalker referer");
                }
            }
            headers.insert(
                name,
                HeaderValue::from_str(value).map_err(|_| "Invalid Stalker header")?,
            );
        }
        if !headers.contains_key("cookie") {
            return Err("Missing Stalker MAC cookie");
        }
        headers.insert("user-agent", HeaderValue::from_static("Mozilla/5.0"));
        headers.insert("accept", HeaderValue::from_static("application/json"));
        Ok(headers)
    }
}

pub async fn request(input: Request) -> Result<(reqwest::StatusCode, Vec<u8>), String> {
    let headers = input.validate()?;
    // Large MAG catalogs exceed the ordinary 16 MiB playlist limit. Keep the
    // larger allowance confined to the validated, read-only bulk action.
    let bulk = Url::parse(&input.url)
        .map_err(|_| "Invalid Stalker URL")?
        .query_pairs()
        .any(|(key, value)| key == "action" && value == "get_all_channels");
    if bulk {
        super::proxy::get_headers_limit(&input.url, headers, 64 * 1024 * 1024).await
    } else {
        super::proxy::get_headers(&input.url, headers).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Request {
        Request {
            url: "http://portal.example/stalker_portal/server/load.php?type=stb&action=handshake&JsHttpRequest=1-xml".into(),
            headers: BTreeMap::from([(
                "Cookie".into(),
                "mac=02%3A00%3A00%3A00%3A00%3A01".into(),
            )]),
        }
    }
    #[test]
    fn rejects_non_protocol_requests_and_unsafe_headers() {
        assert!(input().validate().is_ok());
        let mut bulk = input();
        bulk.url = "http://portal.example/server/load.php?type=itv&action=get_all_channels&JsHttpRequest=1-xml".into();
        assert!(bulk.validate().is_ok());
        bulk.url = bulk.url.replace("type=itv", "type=stb");
        assert!(bulk.validate().is_err());
        for url in [
            "file:///tmp/load.php",
            "http://user:secret@portal.example/load.php",
            "http://portal.example/admin.php?type=stb&action=handshake&JsHttpRequest=1-xml",
            "http://portal.example/load.php?type=stb&action=handshake&action=delete&JsHttpRequest=1-xml",
            "http://portal.example/load.php?type=stb&action=delete&JsHttpRequest=1-xml",
        ] {
            let mut r = input();
            r.url = url.into();
            assert!(r.validate().is_err());
        }
        for (key, value) in [
            ("Host", "internal"),
            ("Cookie", "a\r\nb"),
            ("Referer", "http://other.example/c/"),
            ("cookie", "duplicate"),
        ] {
            let mut r = input();
            r.headers.insert(key.into(), value.into());
            assert!(r.validate().is_err());
        }
    }
    #[tokio::test]
    async fn transport_preserves_destination_policy() {
        let mut r = input();
        r.url = r.url.replace("portal.example", "127.0.0.1");
        assert_eq!(
            request(r).await.unwrap_err(),
            "Proxy destination is not allowed"
        );
    }
}
