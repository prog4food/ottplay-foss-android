//! Same-origin remote text entry relay. The installation credential is never public.
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::{sync::Arc, time::Duration};

const CLIENT_HEADER: &str = "x-swop-client-id";
const SESSION_HEADER: &str = "x-swop-session-token";
// The wire permits 8000 UTF-16 value units; JSON escapes can require 48 KiB.
// Smaller response caps lose a valid value after the Worker consumes it.
const MAX_BODY: usize = 64 * 1024;

#[derive(Clone)]
struct Relay {
    upstream: reqwest::Url,
    authorization: HeaderValue,
    client: reqwest::Client,
}

pub fn routes_from_env() -> anyhow::Result<Router> {
    let upstream = std::env::var("SWOP_BASE_URL").unwrap_or_default();
    let token = std::env::var("SWOP_INSTALLATION_TOKEN").unwrap_or_default();
    if token.trim().is_empty() {
        return Ok(Router::new());
    }
    let relay = Relay::new(&upstream, &token)?;
    Ok(routes(relay))
}

impl Relay {
    fn new(upstream: &str, token: &str) -> anyhow::Result<Self> {
        let upstream: reqwest::Url = upstream.trim().parse()?;
        anyhow::ensure!(
            upstream.scheme() == "https"
                && upstream.host_str().is_some()
                && upstream.username().is_empty()
                && upstream.password().is_none()
                && upstream.query().is_none()
                && upstream.fragment().is_none(),
            "SWOP_BASE_URL must be an HTTPS URL without credentials, query or fragment"
        );
        anyhow::ensure!(
            token.trim().len() >= 32,
            "SWOP_INSTALLATION_TOKEN is too short"
        );
        let mut authorization = HeaderValue::from_str(&format!("Bearer {}", token.trim()))?;
        authorization.set_sensitive(true);
        Ok(Self {
            upstream,
            authorization,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                // A redirect must never leak the installation credential.
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }
}

fn routes(relay: Relay) -> Router {
    Router::new()
        .route("/swop/session", post(session))
        .route("/swop/val", get(value).post(value_post))
        .route("/local/swop.json", get(config))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(Arc::new(relay))
}

async fn config() -> Response {
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"swopBaseUrl": "/swop"})),
    )
        .into_response()
}

fn error(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"error": message})),
    )
        .into_response()
}

pub(crate) fn client_origin(headers: &HeaderMap, scheme: &str) -> Result<String, Response> {
    let deny = || error(StatusCode::FORBIDDEN, "installation origin required");
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .ok_or_else(deny)?;
    // Match the actual listener, never spoofable X-Forwarded-* headers.
    let origin = reqwest::Url::parse(&format!("{scheme}://{host}/")).map_err(|_| deny())?;
    if !origin.username().is_empty()
        || origin.password().is_some()
        || origin.host_str().is_none()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return Err(deny());
    }
    if let Some(site) = headers.get("sec-fetch-site") {
        if site != "same-origin" {
            return Err(deny());
        }
    }
    let supplied = headers
        .get(header::ORIGIN)
        .or_else(|| headers.get(header::REFERER))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| reqwest::Url::parse(value).ok())
        .ok_or_else(deny)?;
    if supplied.origin() != origin.origin() {
        return Err(deny());
    }
    Ok(origin.origin().ascii_serialization())
}

async fn session(
    State(relay): State<Arc<Relay>>,
    Extension(crate::msx::Scheme(scheme)): Extension<crate::msx::Scheme>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    forward(
        &relay,
        scheme,
        &headers,
        Method::POST,
        "/session",
        None,
        body,
    )
    .await
}

#[derive(Deserialize)]
struct ValueQuery {
    c: String,
}

async fn value_post(
    State(relay): State<Arc<Relay>>,
    Extension(crate::msx::Scheme(scheme)): Extension<crate::msx::Scheme>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    forward(&relay, scheme, &headers, Method::POST, "/val", None, body).await
}

async fn value(
    State(relay): State<Arc<Relay>>,
    Extension(crate::msx::Scheme(scheme)): Extension<crate::msx::Scheme>,
    headers: HeaderMap,
    Query(query): Query<ValueQuery>,
) -> Response {
    if query.c.len() != 6 || !query.c.bytes().all(|c| c.is_ascii_alphanumeric()) {
        return error(StatusCode::BAD_REQUEST, "invalid session code");
    }
    forward(
        &relay,
        scheme,
        &headers,
        Method::GET,
        "/val",
        Some(&query.c),
        Bytes::new(),
    )
    .await
}

async fn forward(
    relay: &Relay,
    scheme: &str,
    headers: &HeaderMap,
    method: Method,
    path: &str,
    code: Option<&str>,
    body: Bytes,
) -> Response {
    let origin = match client_origin(headers, scheme) {
        Ok(origin) => origin,
        Err(response) => return response,
    };
    let mut target = relay.upstream.clone();
    target.set_path(&format!(
        "{}{}",
        relay.upstream.path().trim_end_matches('/'),
        path
    ));
    if let Some(code) = code {
        target.query_pairs_mut().append_pair("c", code);
    }
    let mut request = relay
        .client
        .request(method, target)
        .header(header::AUTHORIZATION, relay.authorization.clone())
        .header(header::ORIGIN, origin)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(client_id) = headers.get(CLIENT_HEADER) {
        request = request.header(CLIENT_HEADER, client_id);
    }
    if let Some(token) = headers.get(SESSION_HEADER) {
        request = request.header(SESSION_HEADER, token);
    }
    let mut upstream = match request.send().await {
        Ok(response) => response,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "remote text entry unavailable"),
    };
    let status = upstream.status();
    if status.is_redirection() {
        return error(StatusCode::BAD_GATEWAY, "unexpected upstream redirect");
    }
    let mut response = Vec::new();
    loop {
        match upstream.chunk().await {
            Ok(Some(chunk)) if response.len() + chunk.len() <= MAX_BODY => {
                response.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => {
                return error(
                    StatusCode::BAD_GATEWAY,
                    "invalid remote text entry response",
                )
            }
        }
    }
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        response,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use tower::ServiceExt;

    fn headers(origin: Option<&str>, referer: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "192.168.1.20:8443".parse().unwrap());
        if let Some(origin) = origin {
            h.insert(header::ORIGIN, origin.parse().unwrap());
        }
        if let Some(referer) = referer {
            h.insert(header::REFERER, referer.parse().unwrap());
        }
        h
    }

    #[test]
    fn only_same_origin_browser_requests_are_accepted() {
        assert_eq!(
            client_origin(&headers(Some("http://192.168.1.20:8443"), None), "http").unwrap(),
            "http://192.168.1.20:8443"
        );
        assert!(client_origin(
            &headers(None, Some("http://192.168.1.20:8443/index.html")),
            "http"
        )
        .is_ok());
        for origin in [
            None,
            Some("null"),
            Some("https://other-installation.test"),
            Some("http://192.168.1.20:8444"),
            Some("https://192.168.1.20:8443"),
        ] {
            assert!(client_origin(&headers(origin, None), "http").is_err());
        }
        let mut h = headers(Some("http://192.168.1.20:8443"), None);
        h.insert("sec-fetch-site", "cross-site".parse().unwrap());
        assert!(client_origin(&h, "http").is_err());
        let mut h = headers(Some("https://wrong.test"), None);
        h.insert("x-forwarded-host", "wrong.test".parse().unwrap());
        h.insert("x-forwarded-proto", "https".parse().unwrap());
        assert!(client_origin(&h, "http").is_err());
    }

    #[tokio::test]
    async fn maximum_wire_values_survive_consuming_relay_and_next_byte_is_rejected() {
        // 8000 CJK is accepted by the production Worker today. The control case
        // also covers the semantic wire maximum after its byte-cap alignment.
        for value in ["界".repeat(8000), "\u{0001}".repeat(8000)] {
            let pending = Arc::new(std::sync::Mutex::new(Some(value.clone())));
            let consume = pending.clone();
            let draft = "\u{0001}".repeat(4000);
            let expected_draft = draft.clone();
            let upstream = Router::new()
                .route("/session", post(move |Json(body): Json<serde_json::Value>| {
                    let expected = expected_draft.clone();
                    async move {
                        assert_eq!(body["draft"], expected);
                        Json(json!({"code":"ABCDEF", "sessionToken":"private-token"}))
                    }
                }))
                .route("/val", post(move || {
                    let value = consume.lock().unwrap().take();
                    async move { Json(match value {
                        Some(value) => json!({"status":"ready", "value":value}),
                        None => json!({"status":"gone"}),
                    }) }
                }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
            let mut relay = Relay::new("https://worker.test", &"s".repeat(48)).unwrap();
            relay.upstream = format!("http://{address}").parse().unwrap();
            let app = routes(relay).layer(Extension(crate::msx::Scheme("http")));
            let request = |path: &str, body: String| Request::builder().method("POST").uri(path)
                .header(header::HOST, "192.168.1.20:8443")
                .header(header::ORIGIN, "http://192.168.1.20:8443")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body)).unwrap();
            let session = app.clone().oneshot(request("/swop/session", json!({"draft":draft}).to_string())).await.unwrap();
            assert_eq!(session.status(), StatusCode::OK);
            let ready = app.clone().oneshot(request("/swop/val", "{}".into())).await.unwrap();
            assert_eq!(ready.status(), StatusCode::OK);
            let ready = to_bytes(ready.into_body(), MAX_BODY).await.unwrap();
            assert!(ready.len() > 16 * 1024 && ready.len() <= MAX_BODY);
            let ready: serde_json::Value = serde_json::from_slice(&ready).unwrap();
            assert_eq!(ready["value"], value);
            assert!(pending.lock().unwrap().is_none());
            let gone = app.clone().oneshot(request("/swop/val", "{}".into())).await.unwrap();
            let gone: serde_json::Value = serde_json::from_slice(&to_bytes(gone.into_body(), MAX_BODY).await.unwrap()).unwrap();
            assert_eq!(gone["status"], "gone");
            let rejected = app.oneshot(request("/swop/session", "x".repeat(MAX_BODY + 1))).await.unwrap();
            assert_eq!(rejected.status(), StatusCode::PAYLOAD_TOO_LARGE);
            task.abort();
        }
    }

    #[tokio::test]
    async fn relay_rejects_upstream_response_one_byte_over_bound() {
        let upstream = Router::new().route("/val", post(|| async { vec![b'x'; MAX_BODY + 1] }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let mut relay = Relay::new("https://worker.test", &"s".repeat(48)).unwrap();
        relay.upstream = format!("http://{address}").parse().unwrap();
        let response = routes(relay).layer(Extension(crate::msx::Scheme("http")))
            .oneshot(Request::builder().method("POST").uri("/swop/val")
                .header(header::HOST, "192.168.1.20:8443")
                .header(header::ORIGIN, "http://192.168.1.20:8443")
                .body(Body::from("{}")).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert!(to_bytes(response.into_body(), MAX_BODY).await.unwrap().len() < 100);
        task.abort();
    }

    #[tokio::test]
    async fn relay_hides_credentials_limits_routes_and_forwards_scoped_session() {
        let upstream = Router::new().route(
            "/session",
            post(|headers: HeaderMap, body: Bytes| async move {
                assert_eq!(
                    headers[header::AUTHORIZATION],
                    format!("Bearer {}", "s".repeat(48))
                );
                assert_eq!(headers[header::ORIGIN], "http://192.168.1.20:8443");
                assert_eq!(headers[CLIENT_HEADER], "device-tv-01");
                assert_eq!(headers[SESSION_HEADER], "scoped-read-token");
                assert_eq!(body, "{\"caption\":\"TV\"}");
                assert!(!headers.contains_key("cookie"));
                (
                    [(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
                    Json(json!({"code":"ABCDEF", "sessionToken":"scoped-read-token"})),
                )
            }),
        ).route("/val", post(|headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
            assert_eq!(headers[header::AUTHORIZATION], format!("Bearer {}", "s".repeat(48)));
            assert_eq!(headers[header::ORIGIN], "http://192.168.1.20:8443");
            assert_eq!(body, json!({"code":"ABCDEF", "clientId":"device-tv-01", "sessionToken":"scoped-read-token"}));
            Json(json!({"status":"ready", "value":"typed on phone"}))
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });
        let mut relay = Relay::new("https://worker.test", &"s".repeat(48)).unwrap();
        relay.upstream = format!("http://{address}").parse().unwrap();
        // Match production: legacy assets retain CORS; the relay does not inherit it.
        let app = Router::new()
            .nest_service(
                "/local",
                tower_http::services::ServeDir::new("nonexistent-test-fixture"),
            )
            .layer(tower_http::cors::CorsLayer::permissive())
            .merge(routes(relay))
            .layer(Extension(crate::msx::Scheme("http")));
        let request = Request::builder()
            .method("POST")
            .uri("/swop/session")
            .header(header::HOST, "192.168.1.20:8443")
            .header(header::ORIGIN, "http://192.168.1.20:8443")
            .header(header::AUTHORIZATION, "Bearer attacker-override")
            .header(header::COOKIE, "private=cookie")
            .header(CLIENT_HEADER, "device-tv-01")
            .header(SESSION_HEADER, "scoped-read-token")
            .body(Body::from("{\"caption\":\"TV\"}"))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        assert!(!response.headers().contains_key(header::AUTHORIZATION));
        let body = to_bytes(response.into_body(), MAX_BODY).await.unwrap();
        assert!(!String::from_utf8_lossy(&body).contains(&"s".repeat(48)));
        let poll = Request::builder()
            .method("POST")
            .uri("/swop/val")
            .header(header::HOST, "192.168.1.20:8443")
            .header(header::REFERER, "http://192.168.1.20:8443/index.html")
            .header(header::CONTENT_TYPE, "application/json")
            .header(CLIENT_HEADER, "device-tv-01")
            .body(Body::from(
                r#"{"code":"ABCDEF","clientId":"device-tv-01","sessionToken":"scoped-read-token"}"#,
            ))
            .unwrap();
        let poll = app.clone().oneshot(poll).await.unwrap();
        assert_eq!(poll.status(), StatusCode::OK);
        assert!(
            String::from_utf8_lossy(&to_bytes(poll.into_body(), MAX_BODY).await.unwrap())
                .contains("typed on phone")
        );
        let preflight = Request::builder()
            .method("OPTIONS")
            .uri("/swop/session")
            .header(header::ORIGIN, "https://copied-installation.test")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
            .body(Body::empty())
            .unwrap();
        let preflight = app.clone().oneshot(preflight).await.unwrap();
        assert_eq!(preflight.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert!(!preflight
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        for path in ["/swop/admin/clients", "/swop/submit", "/swop/anything"] {
            assert_eq!(
                app.clone()
                    .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
        let config = app
            .oneshot(
                Request::builder()
                    .uri("/local/swop.json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            to_bytes(config.into_body(), MAX_BODY).await.unwrap(),
            "{\"swopBaseUrl\":\"/swop\"}"
        );
        task.abort();
    }
}
