//! Browser VPortal requests use the OTT server's bounded, DNS-pinned transport.

use serde::Deserialize;
use serde_json::Value;

pub const MAX_REQUEST_BYTES: usize = 128 * 1024;
const MAX_PARAMS_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub url: String,
    pub params: Value,
}

impl Request {
    pub fn validate(&self) -> Result<(), &'static str> {
        let url = reqwest::Url::parse(&self.url).map_err(|_| "Invalid VPortal URL")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || self.url.len() > 4096
        {
            return Err("Invalid VPortal URL");
        }
        if !self.params.is_object()
            || self.params.get("app").and_then(Value::as_str) != Some("ott-play")
            || !self
                .params
                .get("key")
                .and_then(Value::as_str)
                .is_some_and(|key| !key.trim().is_empty())
        {
            return Err("Invalid VPortal request");
        }
        if self.params.to_string().len() > MAX_PARAMS_BYTES {
            return Err("VPortal request exceeds byte limit");
        }
        Ok(())
    }
}

pub async fn request(params: Request) -> Result<(reqwest::StatusCode, Vec<u8>), String> {
    params.validate()?;
    super::proxy::post_json(&params.url, params.params.to_string().as_bytes()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_json_protocol_and_rejects_ambiguous_or_oversized_requests() {
        let mut request = Request {
            url: "http://portal.example/api/v1/".into(),
            params: json!({"app":"ott-play", "key":"fixture-key", "cmd":"search", "query":"Тест"}),
        };
        assert!(request.validate().is_ok());
        for url in [
            "file:///tmp/key",
            "ftp://portal.example/api",
            "http://user:password@portal.example/api",
            "https://portal.example/api#fragment",
        ] {
            request.url = url.into();
            assert_eq!(request.validate(), Err("Invalid VPortal URL"));
        }
        request.url = "https://portal.example/api/v1/".into();
        for params in [
            json!([]),
            json!({}),
            json!({"app":"ott-play", "key":""}),
            json!({"app":"other", "key":"fixture"}),
        ] {
            request.params = params;
            assert_eq!(request.validate(), Err("Invalid VPortal request"));
        }
        request.params =
            json!({"app":"ott-play", "key":"fixture", "query":"x".repeat(MAX_PARAMS_BYTES)});
        assert_eq!(
            request.validate(),
            Err("VPortal request exceeds byte limit")
        );
    }

    #[tokio::test]
    async fn requests_apply_the_existing_destination_policy_without_disclosing_keys() {
        for url in [
            "http://127.0.0.1/api",
            "http://169.254.169.254/api",
            "http://[::1]/api",
        ] {
            let error = request(Request {
                url: url.into(),
                params: json!({"app":"ott-play", "key":"fixture-secret"}),
            })
            .await
            .unwrap_err();
            assert_eq!(error, "Proxy destination is not allowed");
            assert!(!error.contains("fixture-secret"));
            assert!(!error.contains(url));
        }
    }
}
