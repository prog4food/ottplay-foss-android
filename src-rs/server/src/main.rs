mod debug_api;
mod control_discovery;
mod hosted_epg;
mod msx;
mod nas_library;
mod stalker_api;
mod swop;
mod tls;
mod tls_key_policy;
mod vportal_api;

use anyhow::{bail, Context};
use axum::{
    body::Bytes,
    extract::{Path, Query},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse},
    routing::{any, get, post},
    Json, Router,
};
use chrono::Utc;
use clap::Parser;
use once_cell::sync::{Lazy, OnceCell};
use rustls::ServerConfig;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::sync::Arc;
use std::time::SystemTime;
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio::task::JoinSet;
use tokio_rustls::TlsAcceptor;
use tower::Service;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use ottplay_core::xmltv::{self, XmltvCache};

// Cache and index travel together: readers retain a coherent immutable generation
// while a refresh builds the next generation outside the request/runtime locks.
struct EpgSnapshot {
    cache: XmltvCache,
    index: OnceCell<xmltv::MatchIndex>,
    programme_count: usize,
}

impl EpgSnapshot {
    fn new(cache: XmltvCache) -> anyhow::Result<Self> {
        let index = xmltv::build_http_match_index(&cache.channels)?;
        let programme_count = cache
            .programs
            .values()
            .fold(0usize, |count, rows| count.saturating_add(rows.len()));
        Ok(Self {
            cache,
            index: OnceCell::with_value(index),
            programme_count,
        })
    }

    fn initial() -> Self {
        Self {
            cache: XmltvCache::default(),
            index: OnceCell::new(),
            programme_count: 0,
        }
    }

    fn index(&self) -> anyhow::Result<&xmltv::MatchIndex> {
        // Only the initial placeholder defers construction; fetched snapshots
        // are fully indexed before publication, even when their guide is empty.
        self.index
            .get_or_try_init(|| xmltv::build_http_match_index(&self.cache.channels))
    }
}

static EPG_CACHE: Lazy<Arc<RwLock<Arc<EpgSnapshot>>>> = Lazy::new(|| {
    Arc::new(RwLock::new(Arc::new(EpgSnapshot::initial())))
});

static EPG_TO_XMLTV: Lazy<Arc<RwLock<HashMap<String, String>>>> =
    Lazy::new(|| Arc::new(RwLock::new(HashMap::new())));
static TIME_SHIFT_BY_EPG: Lazy<Arc<RwLock<HashMap<String, i64>>>> =
    Lazy::new(|| Arc::new(RwLock::new(HashMap::new())));

static TMDB_KEY: Lazy<Option<String>> = Lazy::new(ottplay_core::tmdb::api_key_from_env);

fn epg_urls() -> Vec<String> {
    // Match archive/server.py: default EPG when EPG_URLS unset/empty.
    const DEFAULT_EPG: &str = "http://epg.it999.ru/epg2.xml.gz";
    let urls: Vec<String> = std::env::var("EPG_URLS")
        .unwrap_or_default()
        .split(';')
        .filter_map(|s| {
            let s = s.trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        })
        .collect();
    if urls.is_empty() {
        vec![DEFAULT_EPG.to_string()]
    } else {
        urls
    }
}

#[derive(Parser)]
struct Cli {
    #[arg(long, default_value = "0.0.0.0")]
    host: String,
    /// HTTP listen ports. Repeat --port; defaults to 8080 only when omitted.
    #[arg(long, action = clap::ArgAction::Append, default_value = "8080")]
    port: Vec<u16>,
    #[arg(long, requires = "key")]
    cert: Option<String>,
    #[arg(long, requires = "cert")]
    key: Option<String>,
    /// HTTPS listen port(s). Repeatable: `--https-port 8443 --https-port 8444`.
    /// When `--cert`/`--key` are set and no ports are given, defaults to `[8443]`.
    #[arg(long, action = clap::ArgAction::Append, requires_all = ["cert", "key"])]
    https_port: Vec<u16>,
}

impl Cli {
    fn listen_ports(&self) -> anyhow::Result<(Vec<u16>, Vec<u16>)> {
        let https = if self.cert.is_some() && self.https_port.is_empty() {
            vec![8443]
        } else {
            self.https_port.clone()
        };
        let mut used = HashSet::new();
        for (scheme, ports) in [("HTTP", &self.port), ("HTTPS", &https)] {
            for port in ports {
                if !used.insert(*port) {
                    bail!("duplicate or conflicting listen port {port} ({scheme})");
                }
            }
        }
        Ok((self.port.clone(), https))
    }
}

struct BoundListeners {
    http: Vec<TcpListener>,
    https: Vec<TcpListener>,
}

async fn bind_listeners(host: &str, http: &[u16], https: &[u16]) -> anyhow::Result<BoundListeners> {
    let mut listeners = BoundListeners {
        http: Vec::new(),
        https: Vec::new(),
    };
    // Bind everything before starting a task. A later bind failure drops all
    // earlier sockets instead of leaving a partially available service.
    for (scheme, ports, sockets) in [
        ("HTTP", http, &mut listeners.http),
        ("HTTPS", https, &mut listeners.https),
    ] {
        for port in ports {
            sockets.push(
                TcpListener::bind((host, *port))
                    .await
                    .with_context(|| format!("cannot bind {scheme} {host}:{port}"))?,
            );
        }
    }
    Ok(listeners)
}

async fn supervise_listeners(mut tasks: JoinSet<anyhow::Result<()>>) -> anyhow::Result<()> {
    let failure = match tasks.join_next().await {
        Some(Ok(Err(error))) => error,
        Some(Err(error)) => anyhow::Error::new(error).context("listener task failed"),
        Some(Ok(Ok(()))) => anyhow::anyhow!("listener stopped unexpectedly"),
        None => anyhow::anyhow!("no listeners configured"),
    };
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Err(failure)
}

async fn serve_tls(
    listener: TcpListener,
    app: Router,
    config: Arc<ServerConfig>,
) -> anyhow::Result<()> {
    let acceptor = TlsAcceptor::from(config);
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(connection) => connection,
            Err(error) => {
                tracing::warn!("TLS accept error: {error}");
                continue;
            }
        };
        let acceptor = acceptor.clone();
        let app = app
            .clone()
            .layer(axum::Extension(axum::extract::ConnectInfo(peer)));
        tokio::spawn(async move {
            let tls = match acceptor.accept(stream).await {
                Ok(stream) => stream,
                Err(error) => {
                    // A client's rejected handshake does not stop other listeners.
                    tracing::warn!("TLS handshake failed: {error}");
                    return;
                }
            };
            let io = hyper_util::rt::TokioIo::new(tls);
            if let Err(error) = hyper::server::conn::http1::Builder::new()
                .serve_connection(
                    io,
                    hyper::service::service_fn(move |req| {
                        let app = app.clone();
                        app.clone().call(req)
                    }),
                )
                .await
            {
                tracing::warn!("TLS serve connection error: {error}");
            }
        });
    }
}

async fn serve_listeners(
    listeners: BoundListeners,
    app: Router,
    tls_config: Option<Arc<ServerConfig>>,
) -> anyhow::Result<()> {
    if !listeners.https.is_empty() && tls_config.is_none() {
        bail!("HTTPS listeners require a certificate and key");
    }
    let mut tasks = JoinSet::new();
    for listener in listeners.http {
        let address = listener.local_addr()?;
        println!("ottplay-server: http://{address}");
        let app = app.clone().layer(axum::Extension(msx::Scheme("http")));
        tasks.spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .with_context(|| format!("HTTP listener {address} failed"))
        });
    }
    for listener in listeners.https {
        let address = listener.local_addr()?;
        println!("ottplay-server: https://{address}");
        let app = app.clone().layer(axum::Extension(msx::Scheme("https")));
        let config = tls_config.clone().context("missing TLS configuration")?;
        tasks.spawn(async move {
            serve_tls(listener, app, config)
                .await
                .with_context(|| format!("HTTPS listener {address} failed"))
        });
    }
    supervise_listeners(tasks).await
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let (http_ports, https_ports) = cli.listen_ports()?;
    // rustls 0.23: both aws-lc-rs and ring end up linked (reqwest + tokio-rustls feature
    // unification). Install an explicit process default before ServerConfig::builder(),
    // otherwise HTTPS listen panics with "no process-level CryptoProvider available".
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("failed to install rustls CryptoProvider (aws-lc-rs)");

    let tls_config = match (&cli.cert, &cli.key) {
        (Some(cert), Some(key)) => Some(build_tls_config(cert, key)?),
        _ => None,
    };
    let listeners = bind_listeners(&cli.host, &http_ports, &https_ports).await?;
    if hosted_epg::enabled()? {
        return serve_listeners(listeners, hosted_epg::start()?, tls_config).await;
    }
    // HTTP startup must not wait for external EPG.
    spawn_epg_refresh(epg_urls());
    Lazy::force(&TMDB_KEY);

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/", get(root))
        .route("/index.html", get(root))
        .route("/favicon.ico", get(favicon_handler))
        .route("/health", get(health))
        .route("/epg/:hash", get(epg_handler))
        .route("/tmdb/*path", get(tmdb_handler))
        .route("/logo/:id", get(logo_handler))
        .route("/version/*path", get(version_handler))
        .route("/m3u/match-channels", post(match_channels_handler))
        .route("/m3u/match-logos", post(match_logos_handler))
        .route("/m3u/cp.php", post(cp_proxy_handler))
        // Phase 2.5: Feedback/analytics endpoints
        .route("/feedback", any(feedback_handler_no_path))
        .route("/feedback/*path", any(feedback_handler))
        .route("/api", any(feedback_handler_no_path))
        .route("/api/*path", any(feedback_handler))
        .route("/report_feedb", post(feedback_handler_no_path))
        // Command queues are explicitly configured authenticated local sidecars.
        .merge(disabled_command_routes())
        .merge(debug_api::routes())
        .merge(vportal_api::routes())
        .merge(stalker_api::routes())
        .merge(msx::routes())
        .merge(device_entry_routes(std::path::Path::new(".")))
        .merge(player_asset_routes(std::path::Path::new(".")))
        // Operator-local overrides (gitignored); 404 if directory missing
        .nest_service("/local", ServeDir::new("local"))
        .layer(cors)
        // Installation-authenticated relay must not inherit permissive asset CORS.
        .merge(swop::routes_from_env()?)
        .merge(nas_library::routes_from_env()?)
        .merge(control_discovery::routes())
        .merge(offline_media_routes().await?);

    serve_listeners(listeners, app, tls_config).await
}

/// Media import is disabled unless an operator configures both storage and a secret.
async fn offline_media_routes() -> anyhow::Result<Router> {
    let Some(directory) = std::env::var_os("OTT_OFFLINE_MEDIA_DIR") else {
        return Ok(Router::new());
    };
    let token = std::env::var("OTT_OFFLINE_MEDIA_TOKEN")
        .map_err(|_| anyhow::anyhow!("OTT_OFFLINE_MEDIA_DIR requires OTT_OFFLINE_MEDIA_TOKEN"))?;
    Ok(ottplay_core::offline_media::Library::new(directory.into(), token, "server").await?.routes())
}

async fn refresh_epg_snapshot(
    cache: &RwLock<Arc<EpgSnapshot>>,
    build: impl FnOnce() -> anyhow::Result<EpgSnapshot> + Send + 'static,
) -> anyhow::Result<()> {
    let fresh = tokio::task::spawn_blocking(build).await??;
    let previous = {
        let mut current = cache.write().await;
        std::mem::replace(&mut *current, Arc::new(fresh))
    };
    // A full guide contains hundreds of thousands of owned strings. Releasing
    // our old generation must not hold the publication lock or an async worker.
    tokio::task::spawn_blocking(move || drop(previous)).await?;
    Ok(())
}

fn spawn_epg_refresh(urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }
    let cache = EPG_CACHE.clone();
    let _refresh = spawn_epg_refresh_loop(
        move || {
            let urls = urls.clone();
            let cache = cache.clone();
            async move {
                println!("[EPG] Fetching {} source(s)...", urls.len());
                match ottplay_core::fetch_xmltv(&urls).await {
                    Ok(fresh) => {
                        let channels = fresh.channels.len();
                        let programmes: usize = fresh.programs.values().map(Vec::len).sum();
                        match refresh_epg_snapshot(&cache, move || EpgSnapshot::new(fresh)).await {
                            Ok(()) => {
                                println!(
                                    "[EPG] Loaded {channels} channels, {programmes} programmes"
                                );
                                return true;
                            }
                            Err(_) => eprintln!("[EPG] Index refresh failed"),
                        }
                    }
                    Err(error) => eprintln!("[EPG] Fetch error: {error}"),
                }
                false
            }
        },
        |failures| ottplay_core::epg_refresh_interval(failures).map(std::time::Duration::from_secs),
    );
}

fn spawn_epg_refresh_loop<F, Work, Delay>(
    mut refresh: F,
    mut delay: Delay,
) -> tokio::task::JoinHandle<()>
where
    F: FnMut() -> Work + Send + 'static,
    Work: std::future::Future<Output = bool> + Send + 'static,
    Delay: FnMut(u32) -> anyhow::Result<std::time::Duration> + Send + 'static,
{
    tokio::spawn(async move {
        let mut failures = 0u32;
        loop {
            failures = if refresh().await {
                0
            } else {
                failures.saturating_add(1)
            };
            let interval = match delay(failures) {
                Ok(interval) => interval,
                Err(_) => {
                    eprintln!("[EPG] Refresh scheduling failed");
                    return;
                }
            };
            // Unlike interval().tick(), the first sleep is not immediate:
            // initial fetch and periodic refresh never overlap or run twice.
            tokio::time::sleep(interval).await;
        }
    })
}

fn build_tls_config(cert_path: &str, key_path: &str) -> anyhow::Result<Arc<ServerConfig>> {
    // Load certificate
    let cert_file = File::open(cert_path).context("cannot open certificate")?;
    let certs = tls::read_certificates(cert_file)?;
    tls_key_policy::validate_chain(&certs)?;

    // Load private key
    let key_file = File::open(key_path).context("cannot open private key")?;
    let key = tls::read_private_key(key_file)?;

    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("bad certificate/key")?;

    // Configure ALPN for HTTP/1.1
    config.alpn_protocols = vec![b"http/1.1".to_vec()];

    Ok(Arc::new(config))
}

fn device_entry_routes(directory: &std::path::Path) -> Router {
    // Device paths select an adapter in index.html; they are not filesystem paths.
    let directory = directory.to_path_buf();
    let entry = move || {
        let directory = directory.clone();
        async move { read_root(&directory) }
    };
    Router::new()
        .route("/f", get(entry.clone()))
        .route("/f/", get(entry.clone()))
        .route("/f/*device", get(entry))
}

fn player_asset_routes(directory: &std::path::Path) -> Router {
    // These generated files live at the web root; expose only the explicit
    // public files rather than mounting the source/configuration directory.
    let mut routes = Router::new()
        .route_service(
            "/offline-worker.js",
            ServeFile::new(directory.join("offline-worker.js")),
        )
        .route_service(
            "/build-info.json",
            ServeFile::new(directory.join("build-info.json")),
        );
    for name in [
        "dist",
        "styles",
        "images",
        "locales",
        "devices",
        "fonts",
        "js",
        "providers",
        "hosted",
        "diagnostics",
    ] {
        routes = routes.nest_service(&format!("/{name}"), ServeDir::new(directory.join(name)));
    }
    routes
}

#[cfg(test)]
mod listener_tests {
    use super::*;

    #[test]
    fn repeated_http_ports_replace_the_default_and_https_remains_explicit() {
        let defaults = Cli::try_parse_from(["ottplay-server"]).unwrap();
        assert_eq!(defaults.host, "0.0.0.0");
        assert_eq!(defaults.listen_ports().unwrap(), (vec![8080], vec![]));

        let http = Cli::try_parse_from([
            "ottplay-server",
            "--host",
            "127.0.0.1",
            "--port",
            "8443",
            "--port",
            "8444",
            "--port",
            "8445",
            "--port",
            "8446",
        ])
        .unwrap();
        assert_eq!(
            http.listen_ports().unwrap(),
            (vec![8443, 8444, 8445, 8446], vec![])
        );
        let tls = Cli::try_parse_from(["ottplay-server", "--cert", "cert.pem", "--key", "key.pem"])
            .unwrap();
        assert_eq!(tls.listen_ports().unwrap(), (vec![8080], vec![8443]));
        let tls = Cli::try_parse_from([
            "ottplay-server",
            "--port",
            "8090",
            "--cert",
            "cert.pem",
            "--key",
            "key.pem",
            "--https-port",
            "9443",
            "--https-port",
            "9444",
        ])
        .unwrap();
        assert_eq!(tls.listen_ports().unwrap(), (vec![8090], vec![9443, 9444]));
    }

    #[test]
    fn ambiguous_ports_and_incomplete_tls_options_are_rejected() {
        for args in [
            vec!["ottplay-server", "--port", "8443", "--port", "8443"],
            vec![
                "ottplay-server",
                "--port",
                "8443",
                "--cert",
                "cert.pem",
                "--key",
                "key.pem",
            ],
            vec![
                "ottplay-server",
                "--cert",
                "cert.pem",
                "--key",
                "key.pem",
                "--https-port",
                "9443",
                "--https-port",
                "9443",
            ],
        ] {
            let cli = Cli::try_parse_from(args).unwrap();
            assert!(cli
                .listen_ports()
                .unwrap_err()
                .to_string()
                .contains("duplicate or conflicting"));
        }
        for args in [
            vec!["ottplay-server", "--cert", "cert.pem"],
            vec!["ottplay-server", "--key", "key.pem"],
            vec!["ottplay-server", "--https-port", "8443"],
            vec!["ottplay-server", "--port", "65536"],
        ] {
            assert!(Cli::try_parse_from(args).is_err());
        }
    }

    #[tokio::test]
    async fn four_http_listeners_serve_the_same_router_and_stop_together() {
        let listeners = bind_listeners("127.0.0.1", &[0, 0, 0, 0], &[])
            .await
            .unwrap();
        let addresses: Vec<_> = listeners
            .http
            .iter()
            .map(|s| s.local_addr().unwrap())
            .collect();
        assert_eq!(addresses.iter().collect::<HashSet<_>>().len(), 4);
        let app = Router::new().route("/health", get(health)).route(
            "/peer",
            get(
                |axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<
                    std::net::SocketAddr,
                >| async move { peer.ip().to_string() },
            ),
        );
        let task = tokio::spawn(serve_listeners(listeners, app, None));
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        for address in &addresses {
            let response = client
                .get(format!("http://{address}/health"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.text().await.unwrap(), "OK");
            let peer = client
                .get(format!("http://{address}/peer"))
                .header("x-forwarded-for", "8.8.8.8")
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            assert_eq!(
                peer, "127.0.0.1",
                "Only the actual accepted TCP peer is trusted"
            );
        }
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::task::yield_now().await;
        for address in addresses {
            let rebound = TcpListener::bind(address).await.unwrap();
            drop(rebound);
        }
    }

    #[tokio::test]
    async fn a_later_bind_failure_releases_all_earlier_http_and_tls_sockets() {
        let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let occupied_port = occupied.local_addr().unwrap().port();
        let available = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let available_port = available.local_addr().unwrap().port();
        drop(available);
        for (http, https) in [
            (vec![available_port, occupied_port], vec![]),
            (vec![available_port], vec![occupied_port]),
            (vec![], vec![available_port, occupied_port]),
        ] {
            let error = match bind_listeners("127.0.0.1", &http, &https).await {
                Ok(_) => panic!("an occupied port must prevent startup"),
                Err(error) => error,
            };
            assert!(error
                .to_string()
                .contains(&format!("127.0.0.1:{occupied_port}")));
            let rebound = TcpListener::bind(("127.0.0.1", available_port))
                .await
                .unwrap();
            drop(rebound);
        }
    }

    #[tokio::test]
    async fn a_failed_listener_propagates_its_error_and_cancels_its_peers() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut tasks = JoinSet::new();
        tasks.spawn(async move {
            let _listener = listener;
            std::future::pending::<anyhow::Result<()>>().await
        });
        tasks.spawn(async { anyhow::bail!("synthetic listener failure") });
        assert_eq!(
            supervise_listeners(tasks).await.unwrap_err().to_string(),
            "synthetic listener failure"
        );
        let rebound = TcpListener::bind(address).await.unwrap();
        drop(rebound);

        let mut tasks = JoinSet::new();
        tasks.spawn(async { Ok(()) });
        assert!(supervise_listeners(tasks)
            .await
            .unwrap_err()
            .to_string()
            .contains("stopped unexpectedly"));

        let mut tasks: JoinSet<anyhow::Result<()>> = JoinSet::new();
        tasks.spawn(async { panic!("synthetic listener panic") });
        assert!(supervise_listeners(tasks)
            .await
            .unwrap_err()
            .to_string()
            .contains("listener task failed"));
    }
}

#[cfg(test)]
mod epg_startup_tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;

    #[tokio::test]
    async fn failed_refreshes_back_off_and_only_an_accepted_snapshot_resets_the_delay() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = Arc::new(RwLock::new(Arc::new(
            EpgSnapshot::new(XmltvCache::default()).unwrap(),
        )));
        let previous = cache.read().await.clone();
        let attempts = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let finish = Arc::new(tokio::sync::Notify::new());
        let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
        let task = spawn_epg_refresh_loop(
            {
                let cache = cache.clone();
                let attempts = attempts.clone();
                let active = active.clone();
                let finish = finish.clone();
                move || {
                    let cache = cache.clone();
                    let previous = previous.clone();
                    let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                    let active = active.clone();
                    let finish = finish.clone();
                    let started = started.clone();
                    async move {
                        assert_eq!(
                            active.fetch_add(1, Ordering::SeqCst),
                            0,
                            "refreshes cannot overlap"
                        );
                        started.send(attempt).unwrap();
                        finish.notified().await;
                        let accepted = refresh_epg_snapshot(&cache, move || {
                            if attempt < 2 {
                                anyhow::bail!("synthetic index failure");
                            }
                            EpgSnapshot::new(XmltvCache::default())
                        })
                        .await
                        .is_ok();
                        assert_eq!(Arc::ptr_eq(&*cache.read().await, &previous), !accepted);
                        active.fetch_sub(1, Ordering::SeqCst);
                        accepted
                    }
                }
            },
            move |failures| {
                let seconds = ottplay_core::epg_refresh_interval(failures)?;
                sent.send((failures, seconds)).unwrap();
                // Scale only the host timer; assert the actual shared policy values.
                Ok(if failures == 0 {
                    std::time::Duration::from_secs(seconds)
                } else {
                    std::time::Duration::from_millis(10)
                })
            },
        );
        for (attempt, expected) in [(1, 60), (2, 120), (0, 7200)].into_iter().enumerate() {
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_secs(5), starts.recv())
                    .await
                    .unwrap(),
                Some(attempt)
            );
            assert!(
                received.try_recv().is_err(),
                "delay starts only after completion"
            );
            assert_eq!(active.load(Ordering::SeqCst), 1);
            finish.notify_one();
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_secs(5), received.recv())
                    .await
                    .unwrap(),
                Some(expected)
            );
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        task.abort();
    }

    #[tokio::test]
    async fn http_startup_does_not_wait_for_initial_epg_or_duplicate_its_refresh() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::sync::Notify;
        let started = Arc::new(Notify::new());
        let finish_fetch = Arc::new(Notify::new());
        let finished = Arc::new(Notify::new());
        let requests = Arc::new(AtomicUsize::new(0));
        let task = spawn_epg_refresh_loop(
            {
                let started = started.clone();
                let finish_fetch = finish_fetch.clone();
                let finished = finished.clone();
                let requests = requests.clone();
                move || {
                    let started = started.clone();
                    let finish_fetch = finish_fetch.clone();
                    let finished = finished.clone();
                    let requests = requests.clone();
                    async move {
                        requests.fetch_add(1, Ordering::SeqCst);
                        started.notify_one();
                        // Represents an offline EPG request with no response yet.
                        finish_fetch.notified().await;
                        finished.notify_one();
                        true
                    }
                }
            },
            |_| Ok(std::time::Duration::from_secs(2 * 3600)),
        );
        let deadline = std::time::Duration::from_secs(5);
        tokio::time::timeout(deadline, started.notified())
            .await
            .unwrap();
        let mut app = Router::new().route("/health", get(health));
        let response = tokio::time::timeout(
            deadline,
            app.call(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
            b"OK"
        );
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        finish_fetch.notify_one();
        tokio::time::timeout(deadline, finished.notified())
            .await
            .unwrap();
        tokio::task::yield_now().await;
        assert_eq!(
            requests.load(Ordering::SeqCst),
            1,
            "Completing the initial fetch must not trigger an immediate periodic fetch"
        );
        task.abort();
    }
}

async fn root() -> impl IntoResponse {
    read_root(std::path::Path::new("."))
}

fn read_root(directory: &std::path::Path) -> Html<String> {
    // Prefer dist/index.html: vite substitutes __OTTP_VERSION__ there.
    // Source index.html keeps the placeholder for local/dev editing.
    for candidate in ["dist/index.html", "index.html"] {
        if let Ok(html) = std::fs::read_to_string(directory.join(candidate)) {
            return Html(html);
        }
    }
    Html(PLACEHOLDER_HTML.to_string())
}

async fn favicon_handler() -> impl IntoResponse {
    match std::fs::read("favicon.ico") {
        Ok(bytes) => (
            StatusCode::OK,
            [
                ("content-type", "image/x-icon"),
                ("cache-control", "max-age=86400"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn health() -> &'static str {
    "OK"
}

async fn tmdb_handler(
    Path(path): Path<String>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<(StatusCode, HeaderMap, Vec<u8>), StatusCode> {
    let api_key = ottplay_core::tmdb::require_api_key().map_err(|_| {
        tracing::warn!("[TMDB] TMDB_API_KEY not set");
        StatusCode::SERVICE_UNAVAILABLE
    })?;
    let query = params
        .iter()
        .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    match ottplay_core::tmdb::proxy(&path, &query, &api_key).await {
        Ok((status, mut headers, body)) => {
            headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
            Ok((
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
                headers,
                body,
            ))
        }
        Err(e) => {
            tracing::warn!("[TMDB] FAIL: {e}");
            Err(StatusCode::BAD_GATEWAY)
        }
    }
}

async fn epg_handler(
    Path(hash): Path<String>,
    Query(params): Query<EpgParams>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    // Client requests /epg/{hash}.json — strip optional .json suffix.
    let hash = hash.strip_suffix(".json").unwrap_or(&hash).to_string();
    let snapshot = EPG_CACHE.read().await.clone();
    let matched = if let Some(ch) = params.ch {
        let snapshot = snapshot.clone();
        tokio::task::spawn_blocking(move || xmltv::match_in_index(&ch, snapshot.index()?))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .map(|(id, _)| id)
    } else {
        None
    };
    let channel_id = match matched {
        Some(id) => id,
        None => EPG_TO_XMLTV
            .read()
            .await
            .get(&hash)
            .cloned()
            .unwrap_or_else(|| hash.clone()),
    };
    let time_shift: i64 = match params.ts {
        Some(ts) => ts as i64,
        None => TIME_SHIFT_BY_EPG
            .read()
            .await
            .get(&hash)
            .copied()
            .unwrap_or(0),
    };
    let archive_hours: i64 = params.hours.map(|h| h as i64).unwrap_or(0);
    let result = tokio::task::spawn_blocking(move || {
        ottplay_core::get_epg_slice_with_index(
            &snapshot.cache,
            snapshot.index()?,
            &hash,
            &channel_id,
            time_shift,
            archive_hours,
        )
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    result
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Debug, Deserialize)]
struct EpgParams {
    #[serde(rename = "ch")]
    ch: Option<String>,
    ts: Option<i32>,
    /// Configured catchup/history hours (M3U rechours). Not timezone.
    hours: Option<i32>,
}

async fn match_channels_handler(body: Bytes) -> impl IntoResponse {
    // Legacy FOSS posts text (`{}\n\t\n...`), not JSON. Keep JSON array as a
    // fallback for native/app clients that already speak the typed API.
    // Matching is CPU-heavy — run off the async runtime so /epg and UI stay responsive.
    let body_owned = String::from_utf8_lossy(&body).into_owned();
    let is_text = body_owned.contains("\n\t\n");
    let snapshot = EPG_CACHE.read().await.clone();

    if is_text {
        let result = tokio::task::spawn_blocking(move || {
            let mut epg_to_xmltv = std::collections::HashMap::new();
            let mut time_shift_by_epg = std::collections::HashMap::new();
            let text = snapshot.index().and_then(|index| {
                ottplay_core::m3u::match_channels_text_with_index(
                    &body_owned,
                    &snapshot.cache.channels,
                    index,
                    &mut epg_to_xmltv,
                    &mut time_shift_by_epg,
                )
            });
            (text, epg_to_xmltv, time_shift_by_epg)
        })
        .await;
        return match result {
            Ok((Ok(text), epg_map, shift_map)) => {
                {
                    let mut m = EPG_TO_XMLTV.write().await;
                    m.extend(epg_map);
                    let mut s = TIME_SHIFT_BY_EPG.write().await;
                    s.extend(shift_map);
                }
                tracing::info!(
                    "[EPG] match-channels text: {} bytes in → {} bytes out",
                    body.len(),
                    text.len()
                );
                (
                    [(
                        axum::http::header::CONTENT_TYPE,
                        "text/plain; charset=utf-8",
                    )],
                    text,
                )
                    .into_response()
            }
            Ok((Err(_), _, _)) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            Err(e) => {
                tracing::error!("[EPG] match-channels join error: {e}");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        };
    }

    let parsed: Result<Vec<ottplay_core::m3u::M3uChannel>, _> = serde_json::from_slice(&body);
    match parsed {
        Ok(channels) => {
            let result = tokio::task::spawn_blocking(move || {
                let mut epg_to_xmltv = std::collections::HashMap::new();
                let mut time_shift_by_epg = std::collections::HashMap::new();
                let results = snapshot.index().and_then(|index| {
                    ottplay_core::m3u::match_channels_with_index(
                        channels,
                        &snapshot.cache.channels,
                        index,
                        &mut epg_to_xmltv,
                        &mut time_shift_by_epg,
                    )
                });
                (results, epg_to_xmltv, time_shift_by_epg)
            })
            .await;
            match result {
                Ok((Ok(results), epg_map, shift_map)) => {
                    {
                        let mut m = EPG_TO_XMLTV.write().await;
                        m.extend(epg_map);
                        let mut s = TIME_SHIFT_BY_EPG.write().await;
                        s.extend(shift_map);
                    }
                    Json(serde_json::to_value(results).unwrap()).into_response()
                }
                Ok((Err(_), _, _)) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                Err(e) => {
                    tracing::error!("[EPG] match-channels join error: {e}");
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
        Err(_) => StatusCode::BAD_REQUEST.into_response(),
    }
}

async fn match_logos_handler(body: Bytes) -> impl IntoResponse {
    let body_owned = String::from_utf8_lossy(&body).into_owned();
    let is_text = body_owned.contains("\n\t\n");
    let snapshot = EPG_CACHE.read().await.clone();

    if is_text {
        let result = tokio::task::spawn_blocking(move || {
            ottplay_core::m3u::match_logos_text_with_index(
                &body_owned,
                &snapshot.cache.channels,
                snapshot.index()?,
            )
        })
        .await;
        return match result {
            Ok(Ok(text)) => {
                tracing::info!(
                    "[EPG] match-logos text: {} bytes in → {} bytes out",
                    body.len(),
                    text.len()
                );
                (
                    [(
                        axum::http::header::CONTENT_TYPE,
                        "text/plain; charset=utf-8",
                    )],
                    text,
                )
                    .into_response()
            }
            Ok(Err(_)) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            Err(e) => {
                tracing::error!("[EPG] match-logos join error: {e}");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        };
    }

    match serde_json::from_slice::<Vec<ottplay_core::m3u::LogoChannel>>(&body) {
        Ok(channels) => {
            let result = tokio::task::spawn_blocking(move || {
                ottplay_core::m3u::match_logos_with_index(
                    channels,
                    &snapshot.cache.channels,
                    snapshot.index()?,
                )
            })
            .await;
            match result {
                Ok(Ok(results)) => Json(serde_json::to_value(results).unwrap()).into_response(),
                Ok(Err(_)) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                Err(e) => {
                    tracing::error!("[EPG] match-logos join error: {e}");
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
        Err(_) => StatusCode::BAD_REQUEST.into_response(),
    }
}

fn form_decode_value(raw: &str) -> String {
    let plus_as_space = raw.replace('+', "%20");
    urlencoding::decode(&plus_as_space)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| raw.replace('+', " "))
}

/// Accept JSON `{url, ua?}` or `application/x-www-form-urlencoded` (`url=` / `ua=`).
/// Providers POST jQuery form bodies (`{url: "@"+cpurl}`), not JSON.
fn parse_cp_proxy_params(body: &[u8]) -> Option<ottplay_core::m3u::ProxyParams> {
    if let Ok(params) = serde_json::from_slice::<ottplay_core::m3u::ProxyParams>(body) {
        if !params.url.is_empty() {
            return Some(params);
        }
    }
    let s = String::from_utf8_lossy(body);
    let mut url = String::new();
    let mut ua = String::new();
    for pair in s.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let val = parts.next().unwrap_or("");
        match key {
            "url" => url = form_decode_value(val),
            "ua" => ua = form_decode_value(val),
            _ => {}
        }
    }
    if url.is_empty() {
        None
    } else {
        Some(ottplay_core::m3u::ProxyParams { url, ua })
    }
}

async fn cp_proxy_handler(body: Bytes) -> Result<(StatusCode, HeaderMap, Vec<u8>), StatusCode> {
    let params = parse_cp_proxy_params(&body).ok_or(StatusCode::BAD_REQUEST)?;
    match ottplay_core::m3u::proxy_stream(params).await {
        Ok((headers, body)) => Ok((StatusCode::OK, cp_response_headers(&headers), body)),
        Err(e) => {
            tracing::warn!("[PROXY] FAIL: {e}");
            Err(StatusCode::BAD_GATEWAY)
        }
    }
}

fn cp_response_headers(upstream: &HeaderMap) -> HeaderMap {
    // reqwest has already removed the upstream transfer framing. Axum must
    // frame this buffered body itself; forwarding Transfer-Encoding makes the
    // response invalid. Only retain representation metadata, never upstream
    // connection headers or cookies belonging to a different origin.
    let mut headers = HeaderMap::new();
    for name in ["content-type", "content-encoding"] {
        for value in upstream.get_all(name) {
            headers.append(name, value.clone());
        }
    }
    // This POST endpoint can also be opened by a form navigation. Isolate any
    // upstream HTML from the player's origin while leaving XHR text unchanged.
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static("sandbox"),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    headers.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert("access-control-allow-headers", HeaderValue::from_static("*"));
    headers
}

#[cfg(test)]
mod cp_proxy_tests {
    use super::*;
    use std::io::{Read, Write};

    #[tokio::test]
    async fn buffered_gzip_response_has_local_framing_and_no_upstream_cookies() {
        let playlist = b"#EXTM3U\n#EXTINF:-1,Fixture\nhttps://stream.example/live\n";
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(playlist).unwrap();
        let compressed = encoder.finish().unwrap();
        let mut upstream = HeaderMap::new();
        for (name, value) in [
            ("content-type", "application/vnd.apple.mpegurl"),
            ("content-encoding", "gzip"),
            ("content-length", "99999"),
            ("transfer-encoding", "chunked"),
            ("connection", "x-upstream-hop, close"),
            ("x-upstream-hop", "fixture"),
            ("set-cookie", "provider-session=fixture; Path=/"),
            ("access-control-allow-origin", "https://provider.example"),
        ] {
            upstream.insert(name, HeaderValue::from_static(value));
        }
        let expected = compressed.clone();
        let app = Router::new().route(
            "/",
            get(move || {
                let headers = cp_response_headers(&upstream);
                let body = compressed.clone();
                async move { (StatusCode::OK, headers, body) }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let response = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap()
            .get(format!("http://{address}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();
        assert_eq!(headers["content-type"], "application/vnd.apple.mpegurl");
        assert_eq!(headers["content-encoding"], "gzip");
        assert_eq!(headers["content-security-policy"], "sandbox");
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(headers["access-control-allow-origin"], "*");
        for name in [
            "transfer-encoding",
            "connection",
            "x-upstream-hop",
            "set-cookie",
        ] {
            assert!(!headers.contains_key(name), "{name}");
        }
        assert_eq!(response.content_length(), Some(expected.len() as u64));
        let received = response.bytes().await.unwrap();
        assert_eq!(received.as_ref(), expected);
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(received.as_ref())
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, playlist);
        server.abort();
    }

    #[test]
    fn representation_encodings_preserve_their_order() {
        let mut upstream = HeaderMap::new();
        upstream.append("content-encoding", HeaderValue::from_static("gzip"));
        upstream.append("content-encoding", HeaderValue::from_static("br"));
        let headers = cp_response_headers(&upstream);
        let values: Vec<_> = headers.get_all("content-encoding").iter().collect();
        assert_eq!(values, ["gzip", "br"]);
    }

    #[tokio::test]
    async fn upstream_html_cannot_relax_the_local_document_sandbox() {
        let mut upstream = HeaderMap::new();
        upstream.insert(
            "content-type",
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        upstream.append(
            "content-security-policy",
            HeaderValue::from_static("sandbox allow-scripts allow-same-origin"),
        );
        upstream.append(
            "content-security-policy",
            HeaderValue::from_static("default-src * 'unsafe-inline' 'unsafe-eval'"),
        );
        upstream.insert(
            "x-content-type-options",
            HeaderValue::from_static("unsafe"),
        );
        let payload = "<script>window.stolen = localStorage.getItem('profiles')</script>";
        let response = (StatusCode::OK, cp_response_headers(&upstream), payload).into_response();
        assert_eq!(
            response.headers()["content-type"],
            "text/html; charset=utf-8",
        );
        assert_eq!(response.headers()["content-security-policy"], "sandbox");
        assert_eq!(
            response.headers().get_all("content-security-policy").iter().count(),
            1,
        );
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap()
                .as_ref(),
            payload.as_bytes(),
        );
    }
}

/// /logo/:id?ch=<name> — generate a stable coloured SVG badge per channel id.
async fn logo_handler(
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let logo_id = id.split('.').next().unwrap_or("0").to_string();
    let ch_name = params.get("ch").cloned().unwrap_or_default();
    let svg = generate_logo_svg(&logo_id, &ch_name);
    (
        [
            ("content-type", "image/svg+xml"),
            ("cache-control", "max-age=86400"),
        ],
        svg,
    )
}

fn generate_logo_svg(logo_id: &str, ch_name: &str) -> String {
    const COLORS: &[&str] = &[
        "#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6", "#1abc9c", "#e67e22", "#34495e",
        "#16a085", "#c0392b", "#2980b9", "#27ae60", "#d35400", "#8e44ad", "#f1c40f",
    ];
    let hash: u32 = logo_id.bytes().fold(5381u32, |acc, b| {
        acc.wrapping_mul(33).wrapping_add(b as u32)
    });
    let color = COLORS[(hash as usize) % COLORS.len()];
    let letter: String = if !ch_name.trim().is_empty() {
        ch_name
            .trim()
            .chars()
            .next()
            .unwrap()
            .to_uppercase()
            .to_string()
    } else {
        let n = (hash as usize) % 26;
        ((b'A' + n as u8) as char).to_string()
    };
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90"><rect width="120" height="90" rx="8" fill="{color}"/><text x="60" y="58" text-anchor="middle" font-family="Arial,sans-serif" font-size="36" font-weight="bold" fill="white">{letter}</text></svg>"#
    )
}

/// /version/*path — return JSON with file metadata + md5 hex prefix (Python parity).
async fn version_handler(Path(rel): Path<String>) -> Result<Json<serde_json::Value>, StatusCode> {
    use md5::{Digest, Md5};
    use std::fs;
    let stripped = rel.strip_prefix('/').unwrap_or(&rel);
    // Reject path traversal; only serve real files under cwd.
    if stripped.is_empty() || stripped.contains("..") {
        return Err(StatusCode::NOT_FOUND);
    }
    let filename = stripped.rsplit('/').next().unwrap_or("").to_string();
    let filepath = format!("./{stripped}");
    match fs::metadata(&filepath) {
        Ok(meta) if meta.is_file() => {
            let bytes = fs::read(&filepath).unwrap_or_default();
            let digest = format!("{:x}", Md5::digest(&bytes))
                .chars()
                .take(16)
                .collect::<String>();
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Ok(Json(serde_json::json!({
                "file": filename,
                "hash": digest,
                "modified": modified,
                "size": meta.len(),
            })))
        }
        _ => Err(StatusCode::NOT_FOUND),
    }
}

const PLACEHOLDER_HTML: &str = "<!doctype html><html><body><h1>ottplay-server</h1></body></html>";

/// Append feedback line to feedback.log (format: `ts\npath\nbody\n---\n`)
fn append_feedback_log(path: &str, body: &str) {
    use std::io::Write;
    let ts = Utc::now().format("%Y-%m-%d %H:%M:%S");
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("feedback.log")
        .and_then(|mut f| writeln!(f, "{ts} {path}\n{body}\n---"));
}

/// Feedback/analytics handler - handles GET/POST /feedback/*, GET/POST /api/*, POST /report_feedb
async fn feedback_handler(
    Path(path): Path<String>,
    body: Option<axum::body::Bytes>,
) -> impl axum::response::IntoResponse {
    let body_str = body
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    let ts = Utc::now().format("%Y-%m-%d %H:%M:%S");
    tracing::info!("[FEEDBACK] {ts} {path}: {body_str}");
    append_feedback_log(&path, &body_str);
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        r#"{"status":"ok"}"#,
    )
}

/// Feedback handler for paths with no tail (e.g. /report_feedb, /feedback, /api)
async fn feedback_handler_no_path(
    body: Option<axum::body::Bytes>,
) -> impl axum::response::IntoResponse {
    feedback_handler(Path("".to_string()), body).await
}

/// Reserve command paths before the generic /api feedback sink. No HTTP method
/// or alias may look like successful command acceptance on the central server.
fn disabled_command_routes() -> Router {
    let mut routes = Router::new();
    for path in [
        "/api/webhook/commands",
        "/api/webhook/health",
        "/webhook/poll",
        "/webhook/notify",
        "/webhook/health",
    ] {
        routes = routes.route(path, any(webhook_stub));
        routes = routes.route(&format!("{path}/"), any(webhook_stub));
    }
    routes
}

/// The central server never provisions or accepts device command credentials.
async fn webhook_stub() -> impl axum::response::IntoResponse {
    (
        StatusCode::FORBIDDEN,
        [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "HTTP remote disabled on the central server. Configure the authenticated local_proxy.py separately.",
    )
}

#[cfg(test)]
mod disabled_command_tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;

    #[tokio::test]
    async fn central_webhook_aliases_never_accept_commands_or_drain_a_queue() {
        let mut app = Router::new()
            .route("/api/*path", any(feedback_handler))
            .merge(disabled_command_routes());
        for path in [
            "/api/webhook/commands",
            "/api/webhook/health",
            "/webhook/poll",
            "/webhook/notify",
            "/webhook/health",
        ] {
            for suffix in ["", "/", "?device_id=known-id"] {
                for method in ["GET", "POST", "PUT", "DELETE", "OPTIONS"] {
                    let request = Request::builder()
                        .method(method)
                        .uri(format!("{path}{suffix}"))
                        .header("Authorization", "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
                        .body(Body::from(r#"{"command":"exit_player"}"#))
                        .unwrap();
                    let response = app.call(request).await.unwrap();
                    assert_eq!(
                        response.status(),
                        StatusCode::FORBIDDEN,
                        "{method} {path}{suffix}"
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod device_entry_tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use std::path::PathBuf;

    // Absolute fixture roots keep parallel requests/tests independent of cwd.
    struct WebRootFixture {
        directory: PathBuf,
    }

    impl Drop for WebRootFixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.directory).unwrap();
        }
    }

    async fn request(app: &mut Router, path: &str) -> (StatusCode, String, Bytes) {
        let response = app
            .call(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (status, content_type, body)
    }

    #[tokio::test]
    async fn generated_root_assets_are_served_without_exposing_private_neighbors() {
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "ottplay-root-assets-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(directory.join("hosted")).unwrap();
        std::fs::write(directory.join("hosted/epg-worker.js"), "self.onmessage = function () {};").unwrap();
        let _fixture = WebRootFixture {
            directory: directory.clone(),
        };
        std::fs::write(
            directory.join("offline-worker.js"),
            "self.addEventListener('fetch', function () {});",
        )
        .unwrap();
        std::fs::write(directory.join("build-info.json"), r#"{"revision":"test"}"#).unwrap();
        std::fs::write(directory.join(".env"), "PRIVATE=secret").unwrap();
        std::fs::write(directory.join("Cargo.toml"), "private source").unwrap();
        let mut app = player_asset_routes(&directory);
        for (path, mime, bytes) in [
            (
                "/offline-worker.js",
                "javascript",
                "self.addEventListener('fetch', function () {});",
            ),
            (
                "/build-info.json",
                "application/json",
                r#"{"revision":"test"}"#,
            ),
        ] {
            let result = request(&mut app, path).await;
            assert_eq!(result.0, StatusCode::OK, "{path}");
            assert!(result.1.contains(mime), "{path}: {}", result.1);
            assert_eq!(result.2.as_ref(), bytes.as_bytes());
        }
        assert_eq!(request(&mut app, "/hosted/epg-worker.js").await.0, StatusCode::OK);
        for path in [
            "/.env",
            "/Cargo.toml",
            "/offline-worker.js/.env",
            "/build-info.json/Cargo.toml",
        ] {
            assert_eq!(
                request(&mut app, path).await.0,
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
    }

    #[tokio::test]
    async fn mode_a_device_entries_serve_html_without_exposing_web_root() {
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "ottplay-device-routes-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(directory.join("dist")).unwrap();
        std::fs::create_dir_all(directory.join("devices/lg/webos")).unwrap();
        std::fs::create_dir_all(directory.join("src-rs/server/src")).unwrap();
        std::fs::create_dir_all(directory.join(".git")).unwrap();
        let built_html = "<!doctype html><html><body>built player</body></html>";
        let source_html = "<!doctype html><html><body>source player</body></html>";
        let private_source = "[workspace]\nmembers = [\"private-source\"]\n";
        let adapter = "var adapter = 'lg/webos';";
        std::fs::write(directory.join("dist/index.html"), built_html).unwrap();
        std::fs::write(directory.join("index.html"), source_html).unwrap();
        std::fs::write(directory.join("Cargo.toml"), private_source).unwrap();
        std::fs::write(
            directory.join("src-rs/server/src/main.rs"),
            "private source",
        )
        .unwrap();
        std::fs::write(directory.join(".env"), "PRIVATE=value").unwrap();
        std::fs::write(directory.join(".git/config"), "private git config").unwrap();
        std::fs::write(directory.join("devices/lg/webos/device.js"), adapter).unwrap();
        let _fixture = WebRootFixture {
            directory: directory.clone(),
        };

        // Reproduce both failures in the former production route.
        let mut old = Router::new().nest_service("/f", ServeDir::new(&directory));
        for path in ["/f/dune/", "/f/lg/webos/"] {
            assert_eq!(request(&mut old, path).await.0, StatusCode::NOT_FOUND);
        }
        let exposed = request(&mut old, "/f/Cargo.toml").await;
        assert_eq!(exposed.0, StatusCode::OK);
        assert_eq!(exposed.2.as_ref(), private_source.as_bytes());

        let mut app = Router::new()
            .merge(device_entry_routes(&directory))
            .merge(player_asset_routes(&directory));
        for path in [
            "/f",
            "/f/",
            "/f/pc/",
            "/f/dune/",
            "/f/mag/",
            "/f/hisense/",
            "/f/lg/webos/",
            "/f/lg/netcast/",
            "/f/samsung/tizen/",
            "/f/samsung/maple/",
            "/f/Cargo.toml",
            "/f/src-rs/server/src/main.rs",
            "/f/.env",
            "/f/.git/config",
            "/f/devices/lg/webos/device.js",
        ] {
            let response = request(&mut app, path).await;
            assert_eq!(response.0, StatusCode::OK, "{path}");
            assert!(response.1.starts_with("text/html"), "{path}");
            assert_eq!(response.2.as_ref(), built_html.as_bytes(), "{path}");
        }
        let asset = request(&mut app, "/devices/lg/webos/device.js").await;
        assert_eq!(asset.0, StatusCode::OK);
        assert_eq!(asset.2.as_ref(), adapter.as_bytes());
        assert_eq!(
            request(&mut app, "/Cargo.toml").await.0,
            StatusCode::NOT_FOUND
        );

        std::fs::remove_file(directory.join("dist/index.html")).unwrap();
        let fallback = request(&mut app, "/f/lg/webos/").await;
        assert_eq!(fallback.0, StatusCode::OK);
        assert_eq!(fallback.2.as_ref(), source_html.as_bytes());
    }

    #[tokio::test]
    async fn renamed_runtime_assets_resolve_without_exposing_retired_roots() {
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "ottplay-runtime-routes-{}-{stamp}",
            std::process::id()
        ));
        let fixtures = [
            ("dist/player.js", "var player = 'renamed';", "javascript"),
            ("styles/player.css", "body { color: white; }", "text/css"),
            ("images/player-logo.png", "fixture logo", "image/png"),
            ("locales/russian.js", "var keyStrings = {};", "javascript"),
            ("devices/pc/device.js", "var keys = {};", "javascript"),
            ("diagnostics/av-v1.mp4", "fixture video", "video/mp4"),
            (
                "providers/m3u/about.html",
                "<p>Playlist provider</p>",
                "text/html",
            ),
        ];
        for (path, contents, _) in fixtures {
            let file = directory.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, contents).unwrap();
        }
        let html = "<!doctype html><title>Renamed player</title>";
        std::fs::write(directory.join("dist/index.html"), html).unwrap();
        // Real stale files must not accidentally become reachable under the
        // removed directory routes after an in-place package upgrade.
        for old in ["stbPlayer/1280.css", "stb/pc/stb.js", "prov/m3u/about.html"] {
            let file = directory.join(old);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, "stale asset").unwrap();
        }
        let _fixture = WebRootFixture {
            directory: directory.clone(),
        };
        let mut app = Router::new()
            .merge(device_entry_routes(&directory))
            .merge(player_asset_routes(&directory));
        for (path, expected, mime) in fixtures {
            for suffix in ["", "?1.2.3-beta.4"] {
                let url = format!("/{path}{suffix}");
                let response = request(&mut app, &url).await;
                assert_eq!(response.0, StatusCode::OK, "{url}");
                assert!(response.1.contains(mime), "{url}: {}", response.1);
                assert_eq!(response.2.as_ref(), expected.as_bytes(), "{url}");
            }
        }
        let entry = request(&mut app, "/f/pc/").await;
        assert_eq!(entry.0, StatusCode::OK);
        assert!(entry.1.starts_with("text/html"));
        assert_eq!(entry.2.as_ref(), html.as_bytes());
        for old in [
            "/stbPlayer/1280.css",
            "/stb/pc/stb.js",
            "/prov/m3u/about.html",
        ] {
            assert_eq!(
                request(&mut app, old).await.0,
                StatusCode::NOT_FOUND,
                "{old}"
            );
        }
    }
}

#[cfg(test)]
mod epg_snapshot_tests {
    use super::*;

    #[test]
    fn only_initial_placeholder_defers_index_construction() -> anyhow::Result<()> {
        assert!(EpgSnapshot::initial().index.get().is_none());
        assert!(EpgSnapshot::new(XmltvCache::default())?
            .index
            .get()
            .is_some());
        assert!(snapshot("news", "Schedule")?.index.get().is_some());
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn early_requests_preserve_protocols_and_registrations_across_refresh(
    ) -> anyhow::Result<()> {
        async fn body(response: impl IntoResponse) -> anyhow::Result<String> {
            let response = response.into_response();
            anyhow::ensure!(response.status() == StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), 4096).await?;
            Ok(String::from_utf8(bytes.to_vec())?)
        }
        let initial = Arc::new(EpgSnapshot::initial());
        let previous = std::mem::replace(&mut *EPG_CACHE.write().await, initial.clone());
        let registered = HashMap::from([("keep".into(), "previous".into())]);
        let shifts = HashMap::from([("keep".into(), 7)]);
        let previous_map = std::mem::replace(&mut *EPG_TO_XMLTV.write().await, registered.clone());
        let previous_shifts =
            std::mem::replace(&mut *TIME_SHIFT_BY_EPG.write().await, shifts.clone());

        // Concurrent early requests share the placeholder while running both
        // matching and slicing on their existing blocking workers.
        let mut readers = JoinSet::new();
        for _ in 0..8 {
            readers.spawn(async {
                body(
                    epg_handler(
                        Path("keep.json".into()),
                        Query(EpgParams {
                            ch: Some("News +2".into()),
                            ts: None,
                            hours: Some(168),
                        }),
                    )
                    .await,
                )
                .await
            });
        }
        while let Some(result) = readers.join_next().await {
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&result??)?,
                serde_json::json!({"epg_data": []})
            );
        }
        assert!(initial.index.get().is_some());
        let json = r#"[{"id":"one","name":"News +2"}]"#;
        let text = "{}\n\t\n{}\n\t\none-a-b-0~News%20%2B2\ntwo-a-b-known~Unknown%20%2B3\nbad";
        assert_eq!(
            body(match_channels_handler(Bytes::from_static(text.as_bytes())).await).await?,
            "{}\n\t\none~local~one\ntwo~local~known\n\t\nlocal~/"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &body(match_channels_handler(Bytes::from_static(json.as_bytes())).await).await?
            )?,
            serde_json::json!([{"id": "one", "score": 0.0}])
        );
        assert_eq!(
            body(match_logos_handler(Bytes::from_static(text.as_bytes())).await).await?,
            "{}\n\t\none~/logo/one.svg?ch=News%20%2B2\ntwo~/logo/two.svg?ch=Unknown%20%2B3"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &body(match_logos_handler(Bytes::from_static(json.as_bytes())).await).await?
            )?,
            serde_json::json!([{"id": "one", "logo_url": "/logo/one.svg?ch=News%20%2B2"}])
        );
        assert_eq!(*EPG_TO_XMLTV.read().await, registered);
        assert_eq!(*TIME_SHIFT_BY_EPG.read().await, shifts);

        refresh_epg_snapshot(&EPG_CACHE, || snapshot("new", "New schedule")).await?;
        assert!(EPG_CACHE.read().await.index.get().is_some());
        let matched: serde_json::Value = serde_json::from_str(
            &body(match_channels_handler(Bytes::from_static(json.as_bytes())).await).await?,
        )?;
        let hash = matched[0]["epg_id"].as_str().unwrap();
        assert_eq!(EPG_TO_XMLTV.read().await[hash], "new");
        assert_eq!(TIME_SHIFT_BY_EPG.read().await[hash], 2);
        assert_eq!(EPG_TO_XMLTV.read().await["keep"], "previous");
        assert_eq!(TIME_SHIFT_BY_EPG.read().await["keep"], 7);
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            assert!(xmltv::match_in_index("News", initial.index()?)?.is_none());
            assert!(initial.cache.programs.is_empty());
            Ok(())
        })
        .await??;

        *EPG_CACHE.write().await = previous;
        *EPG_TO_XMLTV.write().await = previous_map;
        *TIME_SHIFT_BY_EPG.write().await = previous_shifts;
        Ok(())
    }

    fn snapshot(id: &str, title: &str) -> anyhow::Result<EpgSnapshot> {
        let cache = XmltvCache {
            channels: HashMap::from([(
                id.into(),
                xmltv::Channel {
                    id: id.into(),
                    name: "News".into(),
                    ..Default::default()
                },
            )]),
            programs: HashMap::from([(
                id.into(),
                vec![xmltv::Programme {
                    title: title.into(),
                    ..Default::default()
                }],
            )]),
            ..Default::default()
        };
        EpgSnapshot::new(cache)
    }

    #[tokio::test]
    async fn refresh_replaces_index_and_programmes_together_without_invalidating_readers(
    ) -> anyhow::Result<()> {
        let cache = RwLock::new(Arc::new(snapshot("old", "Old schedule")?));
        let in_flight = cache.read().await.clone();
        refresh_epg_snapshot(&cache, || snapshot("new", "New schedule")).await?;
        let refreshed = cache.read().await.clone();
        for (snapshot, expected_id, expected_title) in [
            (in_flight, "old", "Old schedule"),
            (refreshed, "new", "New schedule"),
        ] {
            // A request can finish on another worker after the refresh has swapped.
            std::thread::spawn(move || {
                let (id, _) = xmltv::match_in_index("News HD", snapshot.index().unwrap())
                    .unwrap()
                    .unwrap();
                assert_eq!(id, expected_id);
                assert_eq!(snapshot.cache.programs[&id][0].title, expected_title);
            })
            .join()
            .unwrap();
        }
        Ok(())
    }

    #[tokio::test]
    async fn failed_or_panicked_index_build_retains_previous_generation() -> anyhow::Result<()> {
        let previous = Arc::new(snapshot("old", "Old schedule")?);
        let cache = RwLock::new(previous.clone());
        assert!(
            refresh_epg_snapshot(&cache, || anyhow::bail!("index fixture failed"))
                .await
                .is_err()
        );
        assert!(Arc::ptr_eq(&*cache.read().await, &previous));
        assert!(
            refresh_epg_snapshot(&cache, || panic!("index worker fixture panicked"))
                .await
                .is_err()
        );
        assert!(Arc::ptr_eq(&*cache.read().await, &previous));
        assert_eq!(
            xmltv::match_in_index("News", previous.index()?)?.unwrap().0,
            "old"
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn parallel_matching_keeps_serving_while_next_index_is_built() -> anyhow::Result<()> {
        let cache = Arc::new(RwLock::new(Arc::new(snapshot("old", "Old schedule")?)));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let refreshing = cache.clone();
        let refresh = tokio::spawn(async move {
            refresh_epg_snapshot(&refreshing, move || {
                let _ = started_tx.send(());
                release_rx.recv()?;
                snapshot("new", "New schedule")
            })
            .await
        });
        started_rx.await?;
        let mut readers = JoinSet::new();
        for _ in 0..8 {
            let cache = cache.clone();
            readers.spawn(async move {
                let snapshot = cache.read().await.clone();
                tokio::task::spawn_blocking(move || {
                    for _ in 0..20 {
                        let (id, _) = xmltv::match_in_index("News HD", snapshot.index()?)?.unwrap();
                        anyhow::ensure!(id == "old");
                        anyhow::ensure!(snapshot.cache.programs[&id][0].title == "Old schedule");
                    }
                    Ok::<_, anyhow::Error>(())
                })
                .await?
            });
        }
        let reads = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while let Some(result) = readers.join_next().await {
                result??;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await;
        // Release the worker even if a regression times out, so runtime shutdown cannot hang.
        release_tx.send(())?;
        reads??;
        refresh.await??;
        let refreshed = cache.read().await.clone();
        assert_eq!(
            xmltv::match_in_index("News", refreshed.index()?)?.unwrap().0,
            "new"
        );
        Ok(())
    }
}
