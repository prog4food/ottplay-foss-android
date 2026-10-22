use axum::{
    extract::DefaultBodyLimit,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};

pub fn routes() -> Router {
    Router::new().route(
        "/stalker/api",
        post(handle).layer(DefaultBodyLimit::max(
            ottplay_core::stalker::MAX_REQUEST_BYTES,
        )),
    )
}

async fn handle(Json(request): Json<ottplay_core::stalker::Request>) -> Response {
    let response = if request.validate().is_err() {
        (StatusCode::BAD_REQUEST, "Invalid Stalker request").into_response()
    } else {
        match ottplay_core::stalker::request(request).await {
            Ok((status, body)) => (
                status,
                [
                    ("content-type", "application/json; charset=utf-8"),
                    ("x-content-type-options", "nosniff"),
                ],
                body,
            )
                .into_response(),
            Err(error) => {
                let status = match error.as_str() {
                    "Proxy destination is not allowed" => StatusCode::FORBIDDEN,
                    "Proxy request timed out" => StatusCode::GATEWAY_TIMEOUT,
                    "Proxy is busy; retry later" | "Proxy DNS is busy; retry later" => {
                        StatusCode::SERVICE_UNAVAILABLE
                    }
                    _ => StatusCode::BAD_GATEWAY,
                };
                // Credentials and upstream response details never enter logs/errors.
                (status, "Stalker request failed").into_response()
            }
        }
    };
    let (mut parts, body) = response.into_parts();
    parts
        .headers
        .insert("cache-control", "no-store".parse().unwrap());
    Response::from_parts(parts, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use tower::Service;
    #[tokio::test]
    async fn bounds_and_validates_requests_without_exposing_credentials() {
        for (body, expected) in [
            ("{".to_string(), StatusCode::BAD_REQUEST),
            (
                " ".repeat(ottplay_core::stalker::MAX_REQUEST_BYTES + 1),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
            (
                r#"{"url":"http://127.0.0.1/server/load.php?type=stb&action=handshake&JsHttpRequest=1-xml","headers":{"Cookie":"mac=fixture-secret"}}"#.into(),
                StatusCode::FORBIDDEN,
            ),
        ] {
            let response = routes()
                .call(
                    Request::post("/stalker/api")
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            let body = to_bytes(response.into_body(), 4096).await.unwrap();
            assert!(!String::from_utf8_lossy(&body).contains("fixture-secret"));
        }
    }
}
