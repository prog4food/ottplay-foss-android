use axum::{
    extract::DefaultBodyLimit,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};

pub fn routes() -> Router {
    Router::new().route(
        "/vportal/api",
        post(vportal_handler).layer(DefaultBodyLimit::max(
            ottplay_core::vportal::MAX_REQUEST_BYTES,
        )),
    )
}

async fn vportal_handler(Json(request): Json<ottplay_core::vportal::Request>) -> Response {
    let response = if request.validate().is_err() {
        (StatusCode::BAD_REQUEST, "Invalid VPortal request").into_response()
    } else {
        match ottplay_core::vportal::request(request).await {
            Ok((status, body)) => (
                status,
                [
                    ("content-type", "application/json; charset=utf-8"),
                    ("x-content-type-options", "nosniff"),
                ],
                body,
            )
                .into_response(),
            // Do not expose or log the URL, request body, or portal access key.
            Err(error) => proxy_error_response(&error),
        }
    };
    let (mut parts, body) = response.into_parts();
    parts
        .headers
        .insert("cache-control", "no-store".parse().unwrap());
    Response::from_parts(parts, body)
}

fn proxy_error_response(error: &str) -> Response {
    let (status, message) = match error {
        "Proxy destination is not allowed" => {
            (StatusCode::FORBIDDEN, "VPortal destination is not allowed")
        }
        "Proxy request timed out" => (StatusCode::GATEWAY_TIMEOUT, "VPortal request timed out"),
        "Proxy is busy; retry later" | "Proxy DNS is busy; retry later" => (
            StatusCode::SERVICE_UNAVAILABLE,
            "VPortal proxy is busy; retry later",
        ),
        _ => (StatusCode::BAD_GATEWAY, "VPortal request failed"),
    };
    (status, message).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::Service;

    async fn post(body: String) -> Response {
        routes()
            .call(
                Request::post("/vportal/api")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn route_rejects_invalid_json_protocol_and_oversized_bodies() {
        assert_eq!(post("{".into()).await.status(), StatusCode::BAD_REQUEST);
        let response = post(
            r#"{"url":"file:///tmp/key","params":{"app":"ott-play","key":"fixture-secret"}}"#
                .into(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let response = post(" ".repeat(ottplay_core::vportal::MAX_REQUEST_BYTES + 1)).await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn route_applies_destination_policy_and_does_not_echo_credentials() {
        let response = post(r#"{"url":"http://169.254.169.254/api","params":{"app":"ott-play","key":"fixture-secret"}}"#.into()).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap(),
            "VPortal destination is not allowed"
        );
    }

    #[test]
    fn timeout_and_overload_have_distinct_retryable_statuses() {
        assert_eq!(
            proxy_error_response("Proxy request timed out").status(),
            StatusCode::GATEWAY_TIMEOUT
        );
        assert_eq!(
            proxy_error_response("Proxy is busy; retry later").status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
