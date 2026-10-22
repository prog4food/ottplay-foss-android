//! Native-picked local sources, served directly through a private loopback endpoint.
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;

#[derive(Clone)]
struct Runtime {
    endpoint: String,
    library: ottplay_core::offline_media::Library,
}
#[derive(Default)]
pub struct OfflineMediaState(Mutex<Option<Runtime>>);
#[derive(Serialize)]
pub struct Endpoint {
    endpoint: String,
    #[serde(rename = "pickerCancelled", skip_serializing_if = "Option::is_none")]
    picker_cancelled: Option<bool>,
}

async fn runtime(
    app: &AppHandle,
    state: &OfflineMediaState,
    preferred_id: Option<&str>,
    refresh: bool,
) -> Result<Runtime, String> {
    let background = app.state::<ottplay_core::background_work::BackgroundWork>();
    let work = background.enter().map_err(str::to_string)?;
    let mut current = work.run(state.0.lock()).await.map_err(str::to_string)?;
    if let Some(value) = current.as_ref() {
        let value = value.clone();
        drop(current);
        if refresh {
            value
                .library
                .start_refresh_sources_with_preferred_tracked(preferred_id, work.clone())
                .await;
        } else {
            value
                .library
                .ensure_catalog_tracked(preferred_id, work.clone())
                .await;
        }
        work.check().map_err(str::to_string)?;
        return Ok(value);
    }
    let root = crate::instance::app_data_dir(app)?.join("offline-media");
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let library = work
        .run(ottplay_core::offline_media::Library::new(
            root, token, "device",
        ))
        .await
        .map_err(str::to_string)?
        .map_err(|_| "Local media storage unavailable")?
        .with_background(background.inner().clone());
    let listener = work
        .run(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .await
        .map_err(str::to_string)?
        .map_err(|_| "Local media listener unavailable")?;
    let address = listener
        .local_addr()
        .map_err(|_| "Local media listener unavailable")?;
    let endpoint = format!("http://{address}{}", library.endpoint());
    let server = library.clone();
    library
        .start_refresh_sources_with_preferred_tracked(preferred_id, work.clone())
        .await;
    let result = Runtime { endpoint, library };
    work.publish(|| {
        tauri::async_runtime::spawn(async move {
            if let Err(error) = axum::serve(listener, server.routes()).await {
                tracing::warn!(%error, "Offline media listener stopped");
            }
        });
        *current = Some(result.clone());
    })
    .map_err(str::to_string)?;
    Ok(result)
}

#[tauri::command]
pub async fn offline_media_endpoint(
    app: AppHandle,
    state: State<'_, OfflineMediaState>,
    refresh: Option<bool>,
    preferred_id: Option<String>,
) -> Result<Endpoint, String> {
    let current = runtime(
        &app,
        &state,
        preferred_id.as_deref(),
        refresh.unwrap_or(false),
    )
    .await?;
    Ok(Endpoint {
        endpoint: current.endpoint,
        picker_cancelled: None,
    })
}

#[tauri::command]
pub async fn offline_media_import_files(
    app: AppHandle,
    state: State<'_, OfflineMediaState>,
) -> Result<Endpoint, String> {
    let work = app
        .state::<ottplay_core::background_work::BackgroundWork>()
        .enter()
        .map_err(str::to_string)?;
    let current = runtime(&app, &state, None, false).await?;
    let picker_work = work.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let _picker_work = picker_work;
        app.dialog()
            .file()
            .add_filter("Media", &["mp4", "m4v", "webm", "ogv", "mp3", "m4a", "ogg"])
            .blocking_pick_files()
    })
    .await
    .map_err(|_| "File picker unavailable")?;
    work.check().map_err(str::to_string)?;
    let picker_cancelled = selected.is_none().then_some(true);
    if let Some(files) = selected {
        let paths = files
            .into_iter()
            .map(|file| {
                file.into_path()
                    .map_err(|_| "Select a local filesystem file")
            })
            .collect::<Result<Vec<_>, _>>()?;
        current
            .library
            .start_link_paths_tracked(paths, false, work.clone())
            .await
            .map_err(|_| "Unable to link selected files; no files were copied")?;
    }
    Ok(Endpoint {
        endpoint: current.endpoint,
        picker_cancelled,
    })
}

#[tauri::command]
pub async fn offline_media_import_folder(
    app: AppHandle,
    state: State<'_, OfflineMediaState>,
) -> Result<Endpoint, String> {
    let work = app
        .state::<ottplay_core::background_work::BackgroundWork>()
        .enter()
        .map_err(str::to_string)?;
    let current = runtime(&app, &state, None, false).await?;
    let picker_work = work.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let _picker_work = picker_work;
        app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|_| "Folder picker unavailable")?;
    work.check().map_err(str::to_string)?;
    let picker_cancelled = selected.is_none().then_some(true);
    if let Some(folder) = selected {
        let path = folder
            .into_path()
            .map_err(|_| "Select a local filesystem folder")?;
        current
            .library
            .start_link_paths_tracked(vec![path], true, work.clone())
            .await
            .map_err(|_| "Unable to link selected folder; no files were copied")?;
    }
    Ok(Endpoint {
        endpoint: current.endpoint,
        picker_cancelled,
    })
}

#[tauri::command]
pub async fn offline_media_remove_source(
    app: AppHandle,
    state: State<'_, OfflineMediaState>,
    id: String,
) -> Result<Endpoint, String> {
    let current = runtime(&app, &state, None, false).await?;
    current
        .library
        .disconnect_source(&id)
        .await
        .map_err(|_| "Unable to disconnect local source")?;
    Ok(Endpoint {
        endpoint: current.endpoint,
        picker_cancelled: None,
    })
}
