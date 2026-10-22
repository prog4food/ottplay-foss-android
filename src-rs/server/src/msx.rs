//! Media Station X bootstrap for the address and port used by the TV.
use axum::{
    http::{header, uri::Authority, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use serde_json::{json, Value};
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone, Copy)]
pub struct Scheme(pub &'static str);

pub fn routes() -> Router {
    Router::new()
        .route("/msx/start.json", get(start))
        .route("/msx/content.json", get(content))
        .layer(CorsLayer::new().allow_origin(Any))
}

fn response(value: Value) -> Response {
    // A shared cache must not reuse another listener's generated launch URL.
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

async fn start() -> Response {
    response(json!({
        "name": "OTT-play FOSS",
        "version": "1.0.0",
        "parameter": "content:{PREFIX}{SERVER}/msx/content.json"
    }))
}

async fn content(
    Extension(Scheme(scheme)): Extension<Scheme>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    // Use the actual Host and listener scheme, never untrusted forwarding headers.
    let host = headers
        .get(header::HOST)
        .and_then(|host| host.to_str().ok())
        .ok_or(StatusCode::BAD_REQUEST)?;
    let authority: Authority = host.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    if authority.host().is_empty() || host.contains('@') {
        return Err(StatusCode::BAD_REQUEST);
    }
    let action = format!("link:{scheme}://{authority}/");
    Ok(response(json!({
        "headline": "OTT-play FOSS",
        "action": action,
        "pages": [{"items": [{
            "type": "default",
            "layout": "0,0,12,2",
            "icon": "play-circle-outline",
            "label": "Open OTT-play FOSS",
            "action": action
        }]}]
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn bootstrap_preserves_lan_hostname_ipv6_port_and_tls() {
        for (scheme, host) in [
            ("http", "192.168.1.20:8443"),
            ("http", "player.local:8446"),
            ("https", "tv.example:9443"),
            ("http", "[fd00::20]:8444"),
        ] {
            let app = routes().layer(Extension(Scheme(scheme)));
            let request = |path| {
                Request::builder()
                    .uri(path)
                    .header(header::HOST, host)
                    .header(header::ORIGIN, "https://msx.benzac.de")
                    .header("x-forwarded-host", "wrong.example")
                    .header("x-forwarded-proto", "wrong")
                    .body(Body::empty())
                    .unwrap()
            };
            let start = app
                .clone()
                .oneshot(request("/msx/start.json"))
                .await
                .unwrap();
            assert_eq!(start.status(), StatusCode::OK);
            assert_eq!(start.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
            let start: Value =
                serde_json::from_slice(&to_bytes(start.into_body(), 4096).await.unwrap()).unwrap();
            let parameter = start["parameter"]
                .as_str()
                .unwrap()
                .replace("{PREFIX}", &format!("{scheme}://"))
                .replace("{SERVER}", host);
            assert_eq!(
                parameter,
                format!("content:{scheme}://{host}/msx/content.json")
            );
            let content = app.oneshot(request("/msx/content.json")).await.unwrap();
            assert_eq!(content.status(), StatusCode::OK);
            assert_eq!(content.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
            assert_eq!(content.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(content.headers()[header::CONTENT_TYPE], "application/json");
            let content: Value =
                serde_json::from_slice(&to_bytes(content.into_body(), 4096).await.unwrap())
                    .unwrap();
            let action = format!("link:{scheme}://{host}/");
            assert_eq!(content["action"], action);
            assert_eq!(content["pages"][0]["items"][0]["action"], action);
        }
    }

    #[tokio::test]
    async fn missing_or_invalid_host_cannot_create_a_launch_url() {
        for host in [None, Some("user@tv.example"), Some("tv.example/path")] {
            let mut request = Request::builder().uri("/msx/content.json");
            if let Some(host) = host {
                request = request.header(header::HOST, host);
            }
            let response = routes()
                .layer(Extension(Scheme("http")))
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }
}
