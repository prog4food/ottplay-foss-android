//! Local web clients use the same bounded discovery as the native application.
//! This router is merged after asset CORS; remote websites cannot enumerate the
//! host's DNS environment. Only the actual listener origin is accepted.
use axum::{
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};

pub fn routes() -> Router {
    Router::new().route("/api/control-discovery", get(discover))
}

async fn discover(
    Extension(crate::msx::Scheme(scheme)): Extension<crate::msx::Scheme>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = local_request(headers, scheme) {
        return response;
    }
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        Json(ottplay_core::control_discovery::discover_control_servers().await),
    )
        .into_response()
}

fn local_request(mut headers: HeaderMap, scheme: &str) -> Result<String, Response> {
    // The player sets no-referrer and browsers normally omit Origin on GET.
    // Fetch Metadata proves same-origin on modern browsers. Older clients send
    // a non-simple marker header; a remote website cannot send that header
    // without a CORS preflight, and this endpoint grants no CORS permission.
    if !headers.contains_key(header::ORIGIN)
        && !headers.contains_key(header::REFERER)
        && (headers
            .get("sec-fetch-site")
            .is_some_and(|v| v == "same-origin")
            || headers.get("x-ottplay-discovery").is_some_and(|v| v == "1"))
    {
        if let Some(origin) = headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .and_then(|host| HeaderValue::from_str(&format!("{scheme}://{host}")).ok())
        {
            headers.insert(header::ORIGIN, origin);
        }
    }
    // Also validates Host, actual listener scheme and any Fetch Metadata.
    crate::swop::client_origin(&headers, scheme)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[test]
    fn no_referrer_get_needs_browser_same_origin_proof() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("localhost:8080"));
        assert!(local_request(headers.clone(), "http").is_err());
        headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
        assert!(local_request(headers.clone(), "http").is_ok());
        headers.remove("sec-fetch-site");
        headers.insert("x-ottplay-discovery", HeaderValue::from_static("1"));
        assert!(local_request(headers.clone(), "http").is_ok());
        headers.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
        assert!(local_request(headers.clone(), "http").is_err());
        headers.remove("sec-fetch-site");
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://remote.test"),
        );
        assert!(local_request(headers.clone(), "http").is_err());
        headers.remove(header::ORIGIN);
        headers.insert(
            header::HOST,
            HeaderValue::from_static("user@localhost:8080"),
        );
        assert!(local_request(headers, "http").is_err());
    }

    #[tokio::test]
    async fn route_is_not_the_feedback_wildcard_and_rejects_remote_origins() {
        let app = Router::new()
            .route("/api/*path", get(|| async { "feedback" }))
            .layer(tower_http::cors::CorsLayer::permissive())
            .merge(routes())
            .layer(Extension(crate::msx::Scheme("http")));
        for (origin, site) in [
            ("https://remote.test", "cross-site"),
            ("http://localhost:9999", "same-origin"),
            ("", "same-origin"),
        ] {
            let request = Request::builder()
                .uri("/api/control-discovery")
                .header("host", "localhost:8080")
                .header("origin", origin)
                .header("sec-fetch-site", site)
                .body(Body::empty())
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert!(response
                .headers()
                .get("access-control-allow-origin")
                .is_none());
        }
    }
}
