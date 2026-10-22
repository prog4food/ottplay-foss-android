mod commands;
mod instance;
#[cfg(target_os = "linux")]
mod linux_media_compat;
mod preferred_languages;

use commands::media_session::MediaSessionState;
use commands::tauri_commands::{PipState, TauriState};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::RwLock;

/// Default URL for the desktop shell webview.
///
/// Debug builds point at the local HTTP companion (`:8443`) so Mode A paths work while
/// developing. Release builds default to empty so the app uses embedded
/// `frontendDist` (`frontend/` — Mode A-like staged tree).
///
/// Override with `OTTPLAY_WEB_URL` in either mode. Set it to empty to keep
/// embedded `frontendDist`.
#[cfg(debug_assertions)]
const DEFAULT_WEB_URL: &str = "http://127.0.0.1:8443/";
#[cfg(not(debug_assertions))]
const DEFAULT_WEB_URL: &str = "";

pub fn run() {
    #[cfg(target_os = "linux")]
    linux_media_compat::configure_early();
    let epg_urls = commands::tauri_commands::init_xmltv_urls();
    let command_queues = commands::queue::new_shared();
    let background = ottplay_core::background_work::BackgroundWork::default();
    // No listener starts at launch; settings explicitly configure optional HTTP.
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin({
            // Persist main window position/size across launches (Mode B frameless).
            // SIZE|POSITION|VISIBLE only — never FULLSCREEN/MAXIMIZED/DECORATIONS so
            // restore does not fight Key L native fullscreen toggle.
            // Per-instance filename when OTTPLAY_INSTANCE / OTTPLAY_DATA_DIR is set.
            let mut ws = tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .with_denylist(&["pip"]);
            if let Some(name) = instance::window_state_filename() {
                ws = ws.with_filename(name);
            }
            ws.build()
        })
        .manage(background.clone())
        .manage(commands::background::BackgroundPersistence::default())
        .manage(commands::offline_media::OfflineMediaState::default())
        .manage(commands::queue::QueueHttpRuntime::default())
        .manage(MediaSessionState::default())
        .manage(commands::native_hls::NativeHlsState::default())
        .manage(commands::runtime_diagnostics::RuntimeDiagnosticsState::default())
        .manage(PipState::default())
        .manage(TauriState {
            background,
            xmltv_cache: Arc::new(RwLock::new(None)),
            epg_urls: Arc::new(RwLock::new(epg_urls.clone())),
            epg_to_xmltv: Arc::new(RwLock::new(HashMap::new())),
            time_shift_by_epg: Arc::new(RwLock::new(HashMap::new())),
            xmltv_fetch_lock: Arc::new(tokio::sync::Mutex::new(())),
            command_queues: command_queues.clone(),
        })
        .invoke_handler(tauri::generate_handler![
            commands::tauri_commands::ping,
            commands::background::background_standby_status,
            commands::background::set_background_standby,
            commands::offline_media::offline_media_endpoint,
            commands::offline_media::offline_media_import_files,
            commands::offline_media::offline_media_import_folder,
            commands::offline_media::offline_media_remove_source,
            commands::runtime_diagnostics::runtime_diagnostics,
            commands::tauri_commands::get_epg,
            commands::m3u::match_channels,
            commands::m3u::match_logos,
            commands::tmdb::tmdb_proxy,
            commands::tauri_commands::proxy_fetch,
            commands::http::proxy_http,
            commands::plex_auth::open_plex_sign_in,
            commands::control_discovery::discover_control_servers,
            commands::swop::swop_http,
            commands::native_hls::native_hls_start,
            commands::native_hls::native_hls_stats,
            commands::native_hls::native_hls_stop,
            commands::tauri_commands::set_fullscreen,
            commands::tauri_commands::toggle_fullscreen,
            commands::tauri_commands::prevent_sleep,
            commands::tauri_commands::allow_sleep,
            commands::tauri_commands::play_pip,
            commands::tauri_commands::pip_player_event,
            commands::tauri_commands::stop_pip,
            commands::tauri_commands::set_pip_bounds,
            commands::tauri_commands::exit_app,
            commands::lifecycle::lifecycle_capabilities,
            commands::lifecycle::restart_app,
            commands::screenshot::screenshot_capabilities,
            commands::screenshot::capture_screenshot,
            commands::media_session::start_media_session,
            commands::media_session::pause_media_session,
            commands::media_session::resume_media_session,
            commands::media_session::stop_media_session,
            commands::media_session::update_media_session,
            commands::queue::queue_poll,
            commands::queue::queue_enqueue,
            commands::queue::queue_port,
            commands::queue::queue_http_configure,
            commands::misc::get_version,
            commands::misc::feedback_get,
            commands::misc::feedback_post,
            commands::stalker::stalker_portal_fetch,
        ])
        .on_page_load(|window, payload| {
            if window.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<commands::native_hls::NativeHlsState>()
                        .stop_all()
                        .await;
                });
            }
        })
        .setup(|app| {
            commands::background::restore(app.handle());
            // Always build the main window here (tauri.conf windows=[]) so
            // OTTPLAY_INSTANCE / OTTPLAY_DATA_DIR can set data_directory +
            // macOS data_store_identifier at create time. Destroy+recreate
            // races on the `main` label and panics.
            if let Some(data_dir) = instance::resolve_data_dir() {
                instance::ensure_dirs(&data_dir).map_err(|e| {
                    Box::<dyn std::error::Error>::from(format!(
                        "instance data dir {}: {e}",
                        data_dir.display()
                    ))
                })?;
                tracing::info!(
                    path = %data_dir.display(),
                    slug = instance::isolation_slug().unwrap_or_default(),
                    "OTTPLAY instance isolation enabled"
                );
            }

            let raw = std::env::var("OTTPLAY_WEB_URL").unwrap_or_else(|_| DEFAULT_WEB_URL.into());
            let web_url = if raw.trim().is_empty() {
                None
            } else {
                Some(tauri::Url::parse(&raw).map_err(|e| {
                    Box::<dyn std::error::Error>::from(format!(
                        "invalid OTTPLAY_WEB_URL {raw:?}: {e}"
                    ))
                })?)
            };
            #[cfg(dev)]
            let dev_url = app.config().build.dev_url.as_ref();
            #[cfg(not(dev))]
            let dev_url = None;

            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .initialization_script(preferred_languages::initialization_script(
                web_url.as_ref(),
                dev_url,
            ))
            .title("OttPlay FOSS")
            .inner_size(1280.0, 720.0)
            .center()
            .resizable(true)
            .decorations(false);
            if let Some(data_dir) = instance::resolve_data_dir() {
                builder = instance::apply_isolation(builder, &data_dir);
            }
            builder.build()?;

            if let Some(window) = app.get_webview_window("main") {
                if let Some(url) = web_url {
                    tracing::info!("navigating main webview to {url}");
                    window.navigate(url)?;
                } else {
                    tracing::info!("OTTPLAY_WEB_URL empty — using embedded frontendDist");
                }
            }

            // Mode A companion warms XMLTV before serving; Mode B must too or the
            // first get_epg/match_channels pays a multi-second 40MB gz parse and
            // can permanently cache a transient 0-channel miss.
            let handle = app.handle().clone();
            commands::tauri_commands::spawn_xmltv_warm(handle, &*app.state::<TauriState>());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
