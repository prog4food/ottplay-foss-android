//! Local media: private server imports and native-picked, read-only source references.
//! Requests can select opaque IDs only, never filesystem paths.
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::{watch, Mutex},
};

const MAX_BYTES: u64 = 16 * 1024 * 1024 * 1024;
// An abandoned upload is never catalogued. Drop its file handle before the
// best-effort removal of its partial file (including cancelled requests).
struct PendingUpload {
    file: Option<fs::File>,
    path: PathBuf,
}
impl Drop for PendingUpload {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Clone)]
pub struct Library {
    root: PathBuf,
    token: String,
    storage: String,
    mutation: Arc<Mutex<()>>,
    scan: Arc<Mutex<ScanState>>,
    background: crate::background_work::BackgroundWork,
}
#[derive(Default)]
struct ScanState {
    jobs: usize,
    scanned: u64,
    records: std::collections::HashMap<String, (Record, bool)>,
    cached: bool,
    revision: u64,
    error: Option<String>,
    preferred: Option<Preferred>,
}
impl ScanState {
    fn invalidate(&mut self) {
        self.cached = false;
        self.preferred = None;
        self.revision = self.revision.wrapping_add(1);
    }

    fn cache_preferred(&mut self, preferred: Option<(u64, Option<Record>, Preferred)>) {
        if let Some((revision, record, status)) = preferred {
            // A source can be disconnected while the direct lookup is awaiting
            // filesystem I/O. Never resurrect that entry in a newer snapshot.
            if self.cached && self.revision == revision {
                if let Some(record) = record {
                    self.records.insert(record.id.clone(), (record, true));
                }
                self.preferred = Some(status);
            }
        }
    }
}
#[derive(Clone, Serialize)]
pub struct Preferred {
    id: String,
    state: &'static str,
}

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    id: String,
    name: String,
    size: u64,
    mime: String,
    extension: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    linked_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct SourceRecord {
    id: String,
    name: String,
    kind: String,
    path: PathBuf,
}
#[derive(Serialize)]
pub struct Source {
    id: String,
    name: String,
    kind: String,
    available: bool,
    access: &'static str,
}
#[derive(Serialize)]
pub struct Item {
    pub id: String,
    pub name: String,
    pub directory: String,
    pub size: u64,
    pub mime: String,
    pub url: String,
    pub available: bool,
    pub source: &'static str,
    #[serde(rename = "sourceId")]
    pub source_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub available: bool,
    pub items: Vec<Item>,
    pub storage: String,
    pub persistent: bool,
    pub upload_url: String,
    pub direct_sources: bool,
    pub sources: Vec<Source>,
    pub scanning: bool,
    pub scanned: u64,
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred: Option<Preferred>,
}
#[derive(Deserialize)]
struct ImportQuery {
    name: String,
}

type Failure = (StatusCode, &'static str);
const BACKGROUND_CANCELLED: Failure = (
    StatusCode::SERVICE_UNAVAILABLE,
    "Player background work cancelled",
);

struct ReadCaller(watch::Sender<bool>);
impl Drop for ReadCaller {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}

#[derive(Clone)]
struct ReadWork {
    lease: crate::background_work::WorkLease,
    abandoned: watch::Receiver<bool>,
}
impl ReadWork {
    fn check(&self) -> Result<(), Failure> {
        if *self.abandoned.borrow() {
            return Err(BACKGROUND_CANCELLED);
        }
        self.lease.check().map_err(|_| BACKGROUND_CANCELLED)
    }

    fn publish<T>(&self, publish: impl FnOnce() -> T) -> Result<T, Failure> {
        // Serialize caller abandonment with the short cache publication, just
        // as the lease serializes it with a global standby transition.
        let abandoned = self.abandoned.borrow();
        if *abandoned {
            return Err(BACKGROUND_CANCELLED);
        }
        self.lease
            .publish(publish)
            .map_err(|_| BACKGROUND_CANCELLED)
    }

    // Only interrupt waits without an in-flight filesystem operation, such as
    // the scan mutex. Actual filesystem futures go through checked() instead.
    async fn run<T>(&self, future: impl std::future::Future<Output = T>) -> Result<T, Failure> {
        let mut abandoned = self.abandoned.clone();
        if *abandoned.borrow_and_update() {
            return Err(BACKGROUND_CANCELLED);
        }
        tokio::select! {
            biased;
            _ = abandoned.changed() => Err(BACKGROUND_CANCELLED),
            value = self.lease.run(future) => {
                self.check()?;
                value.map_err(|_| BACKGROUND_CANCELLED)
            }
        }
    }
}

// Unlike cancellation of a network future, dropping a tokio::fs future does
// not stop its blocking syscall. Keep the owner alive until that call returns,
// but abandon subsequent operations when this particular caller goes away.
async fn owned_read<
    T: Send + 'static,
    F: std::future::Future<Output = Result<T, Failure>> + Send + 'static,
>(
    work: &crate::background_work::WorkLease,
    read: impl FnOnce(ReadWork) -> F + Send + 'static,
) -> Result<T, Failure> {
    work.check().map_err(|_| BACKGROUND_CANCELLED)?;
    let (abandoned, receiver) = watch::channel(false);
    let _caller = ReadCaller(abandoned);
    let owner = ReadWork {
        lease: work.clone(),
        abandoned: receiver,
    };
    let task = tokio::spawn(async move { checked(Some(&owner), read(owner.clone())).await? });
    work.run(task)
        .await
        .map_err(|_| BACKGROUND_CANCELLED)?
        .map_err(storage_error)?
}

// The owned reader must stop between operations, rather than abandon an
// operation already submitted to the filesystem thread pool.
async fn checked<T>(
    work: Option<&ReadWork>,
    operation: impl std::future::Future<Output = T>,
) -> Result<T, Failure> {
    if let Some(work) = work {
        work.check()?;
    }
    let value = operation.await;
    if let Some(work) = work {
        work.check()?;
    }
    Ok(value)
}
impl Library {
    pub async fn new(root: PathBuf, token: String, storage: &str) -> anyhow::Result<Self> {
        anyhow::ensure!(
            token.len() >= 32
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "Offline media token must contain at least 32 URL-safe characters"
        );
        fs::create_dir_all(&root).await?;
        let root = fs::canonicalize(root).await?;
        Ok(Self {
            root,
            token,
            storage: storage.into(),
            mutation: Arc::new(Mutex::new(())),
            scan: Arc::new(Mutex::new(ScanState::default())),
            background: Default::default(),
        })
    }
    /// Only native instances attach a player gate. A shared server keeps its own
    /// independent default gate and cannot be suspended by a connected player.
    pub fn with_background(mut self, background: crate::background_work::BackgroundWork) -> Self {
        self.background = background;
        self
    }
    pub fn endpoint(&self) -> String {
        format!("/offline-media/{}", self.token)
    }
    pub fn routes(self) -> Router {
        Router::new()
            .route("/offline-media/:token", get(catalog).options(preflight))
            .route(
                "/offline-media/:token/import",
                post(import).options(preflight),
            )
            .route(
                "/offline-media/:token/sources/:id",
                axum::routing::delete(remove_source).options(preflight),
            )
            .route(
                "/offline-media/:token/:id",
                get(media).delete(remove).options(preflight),
            )
            .layer(DefaultBodyLimit::disable())
            .with_state(self)
    }
    fn authorize(&self, token: &str) -> Result<(), Failure> {
        if self.background.status().standby {
            return Err((StatusCode::SERVICE_UNAVAILABLE, "Player is in standby"));
        }
        // Fixed-length comparison avoids early exits on a matching prefix.
        let mut diff = self.token.len() ^ token.len();
        for (a, b) in self.token.bytes().zip(token.bytes()) {
            diff |= (a ^ b) as usize;
        }
        if diff != 0 {
            Err((StatusCode::NOT_FOUND, "Not found"))
        } else {
            Ok(())
        }
    }
    async fn records(
        &self,
        work: &crate::background_work::WorkLease,
    ) -> Result<Vec<Record>, Failure> {
        let library = self.clone();
        owned_read(
            work,
            |owner| async move { library.read_records(&owner).await },
        )
        .await
    }
    async fn read_records(&self, work: &ReadWork) -> Result<Vec<Record>, Failure> {
        let mut directory = checked(Some(work), fs::read_dir(&self.root))
            .await?
            .map_err(storage_error)?;
        let mut out = Vec::new();
        while let Some(entry) = checked(Some(work), directory.next_entry())
            .await?
            .map_err(storage_error)?
        {
            let path = entry.path();
            if path.extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let kind = match checked(Some(work), entry.file_type()).await? {
                Ok(kind) => kind,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(storage_error(e)),
            };
            if !kind.is_file() {
                continue;
            }
            let metadata = match checked(Some(work), entry.metadata()).await? {
                Ok(metadata) => metadata,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(storage_error(e)),
            };
            if metadata.len() > 4096 {
                continue;
            }
            let bytes = match checked(Some(work), fs::read(&path)).await? {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(storage_error(e)),
            };
            if bytes.len() > 4096 {
                continue;
            }
            if let Ok(record) = serde_json::from_slice::<Record>(&bytes) {
                if valid_id(&record.id)
                    && media_type(&record.extension) == Some(record.mime.as_str())
                {
                    let available = self.read_path(&record, Some(work)).await.is_ok();
                    work.check().map_err(|_| BACKGROUND_CANCELLED)?;
                    if record.linked_path.is_none() && !available {
                        continue;
                    }
                    let mut scan = work
                        .run(self.scan.lock())
                        .await
                        .map_err(|_| BACKGROUND_CANCELLED)?;
                    work.publish(|| {
                        if scan.jobs > 0 {
                            scan.scanned += 1;
                            scan.records
                                .insert(record.id.clone(), (record.clone(), available));
                        }
                    })
                    .map_err(|_| BACKGROUND_CANCELLED)?;
                    out.push(record);
                }
            }
        }
        out.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        Ok(out)
    }
    async fn path(&self, record: &Record) -> Result<PathBuf, Failure> {
        self.read_path(record, None).await
    }
    async fn read_path(
        &self,
        record: &Record,
        work: Option<&ReadWork>,
    ) -> Result<PathBuf, Failure> {
        let path = if let Some(path) = &record.linked_path {
            // Native-picked originals may live outside the private library.
            // They must still name the same canonical, non-symlinked file.
            if checked(work, fs::canonicalize(path)).await?.ok().as_ref() != Some(path) {
                return Err((StatusCode::GONE, "Original source unavailable"));
            }
            path.clone()
        } else {
            // Keep this boundary local to the filesystem operation, even if a
            // future caller has not passed through metadata validation first.
            if !valid_id(&record.id) || media_type(&record.extension) != Some(record.mime.as_str())
            {
                return Err((StatusCode::NOT_FOUND, "Media not found"));
            }
            let path = self
                .root
                .join(format!("{}.{}", record.id, record.extension));
            if !path.starts_with(&self.root) || path.parent() != Some(self.root.as_path()) {
                return Err((StatusCode::NOT_FOUND, "Media not found"));
            }
            path
        };
        let metadata = checked(work, fs::symlink_metadata(&path))
            .await?
            .map_err(|_| (StatusCode::NOT_FOUND, "Media not found"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err((StatusCode::NOT_FOUND, "Media not found"));
        }
        Ok(path)
    }
    async fn record(&self, id: &str) -> Result<Record, Failure> {
        self.read_record(id, None).await
    }
    async fn read_record(&self, id: &str, work: Option<&ReadWork>) -> Result<Record, Failure> {
        if !valid_id(id) {
            return Err((StatusCode::NOT_FOUND, "Media not found"));
        }
        // A range request must not rescan every metadata record before it can
        // return the first video byte from a large library.
        let path = self.root.join(format!("{id}.json"));
        if !path.starts_with(&self.root) || path.parent() != Some(self.root.as_path()) {
            return Err((StatusCode::NOT_FOUND, "Media not found"));
        }
        let metadata = checked(work, fs::symlink_metadata(&path))
            .await?
            .map_err(|_| (StatusCode::NOT_FOUND, "Media not found"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
            return Err((StatusCode::NOT_FOUND, "Media not found"));
        }
        let bytes = checked(work, fs::read(path))
            .await?
            .map_err(storage_error)?;
        let record: Record = serde_json::from_slice(&bytes).map_err(storage_error)?;
        if bytes.len() > 4096
            || record.id != id
            || media_type(&record.extension) != Some(record.mime.as_str())
        {
            return Err((StatusCode::NOT_FOUND, "Media not found"));
        }
        Ok(record)
    }
    async fn source_records(&self) -> Result<Vec<SourceRecord>, Failure> {
        self.read_source_records(None).await
    }
    async fn read_source_records(
        &self,
        work: Option<&ReadWork>,
    ) -> Result<Vec<SourceRecord>, Failure> {
        let folder = self.root.join("sources");
        checked(work, fs::create_dir_all(&folder))
            .await?
            .map_err(storage_error)?;
        let mut entries = checked(work, fs::read_dir(folder))
            .await?
            .map_err(storage_error)?;
        let mut sources = Vec::new();
        while let Some(entry) = checked(work, entries.next_entry())
            .await?
            .map_err(storage_error)?
        {
            if !checked(work, entry.file_type())
                .await?
                .map_err(storage_error)?
                .is_file()
                || entry.path().extension().and_then(|x| x.to_str()) != Some("json")
            {
                continue;
            }
            if checked(work, entry.metadata())
                .await?
                .map_err(storage_error)?
                .len()
                > 16384
            {
                continue;
            }
            if let Ok(bytes) = checked(work, fs::read(entry.path())).await? {
                if let Ok(source) = serde_json::from_slice::<SourceRecord>(&bytes) {
                    if valid_id(&source.id) {
                        sources.push(source);
                    }
                }
            }
        }
        Ok(sources)
    }

    /// Schedule native discovery without keeping the webview's invoke pending.
    /// Metadata becomes visible in cumulative catalog snapshots as it is read.
    pub async fn start_link_paths(&self, paths: Vec<PathBuf>, folder: bool) -> anyhow::Result<()> {
        let work = self.background.enter().map_err(anyhow::Error::msg)?;
        self.start_link_paths_tracked(paths, folder, work).await
    }

    pub async fn start_link_paths_tracked(
        &self,
        paths: Vec<PathBuf>,
        folder: bool,
        work: crate::background_work::WorkLease,
    ) -> anyhow::Result<()> {
        work.check().map_err(anyhow::Error::msg)?;
        anyhow::ensure!(
            self.storage == "device",
            "Native sources are unavailable on this server"
        );
        {
            let mut scan = self.scan.lock().await;
            if scan.jobs == 0 {
                scan.records.clear();
                scan.cached = true;
                scan.scanned = 0;
                scan.error = None;
            }
            scan.jobs += 1;
        }
        let library = self.clone();
        tokio::spawn(async move {
            let result = library.link_paths_inner(paths, folder, &work).await;
            let mut scan = library.scan.lock().await;
            if result.is_err() {
                scan.error = Some("Local source could not be completely scanned".into());
            }
            scan.jobs -= 1;
        });
        Ok(())
    }

    pub async fn start_refresh_sources(&self) {
        self.start_refresh_sources_with_preferred(None).await;
    }

    async fn preferred_record(
        &self,
        id: &str,
        work: &crate::background_work::WorkLease,
    ) -> Option<(u64, Option<Record>, Preferred)> {
        if self.storage != "device" || !valid_id(id) {
            return None;
        }
        let library = self.clone();
        let id = id.to_string();
        let revision = work.run(self.scan.lock()).await.ok()?.revision;
        let status = Preferred {
            id: id.clone(),
            state: "pending",
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            owned_read(work, |owner| async move {
                // Only an explicit NotFound proves absence. Permission, timeout,
                // corrupt metadata or a changed/symlinked source stay pending.
                let metadata = library.root.join(format!("{id}.json"));
                if matches!(checked(Some(&owner), fs::symlink_metadata(&metadata)).await?,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound)
                {
                    return Ok((None, "missing"));
                }
                let record = library.read_record(&id, Some(&owner)).await?;
                let path = record.linked_path.clone().unwrap_or_else(|| {
                    library
                        .root
                        .join(format!("{}.{}", record.id, record.extension))
                });
                if matches!(checked(Some(&owner), fs::symlink_metadata(&path)).await?,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound)
                {
                    // A disconnected volume is not evidence that one saved
                    // file was removed from an otherwise readable folder.
                    if let Some(parent) = path.parent() {
                        if checked(Some(&owner), fs::metadata(parent))
                            .await?
                            .map(|metadata| metadata.is_dir())
                            .unwrap_or(false)
                        {
                            return Ok((None, "missing"));
                        }
                    }
                }
                library.read_path(&record, Some(&owner)).await?;
                Ok((Some(record), "found"))
            }),
        )
        .await;
        match result {
            Ok(Ok((record, state))) => Some((revision, record, Preferred { state, ..status })),
            _ => Some((revision, None, status)),
        }
    }

    /// Make the saved item available without restarting an existing scan.
    pub async fn prioritize_item(&self, id: &str) {
        let Ok(work) = self.background.enter() else {
            return;
        };
        self.prioritize_item_tracked(id, work).await;
    }

    pub async fn prioritize_item_tracked(&self, id: &str, work: crate::background_work::WorkLease) {
        self.ensure_catalog_tracked(Some(id), work).await;
    }

    /// Reuse a valid snapshot, or restart discovery after cancellation without
    /// making endpoint readers wait for a synchronous full-directory catalog.
    pub async fn ensure_catalog_tracked(
        &self,
        preferred_id: Option<&str>,
        work: crate::background_work::WorkLease,
    ) {
        if self.storage != "device" || work.check().is_err() {
            return;
        }
        let preferred = match preferred_id {
            Some(id) => self.preferred_record(id, &work).await,
            None => None,
        };
        let Ok(mut scan) = work.run(self.scan.lock()).await else {
            return;
        };
        // Standby invalidates a cancelled snapshot. Wake may discover an
        // existing endpoint without an explicit refresh, so rebuild that
        // snapshot in the background instead of falling back to a full catalog
        // read before the preferred item becomes playable.
        if !scan.cached && scan.jobs == 0 {
            drop(scan);
            self.start_refresh_sources_seeded(preferred, work, false)
                .await;
            return;
        }
        let _ = work.publish(|| scan.cache_preferred(preferred));
    }

    pub async fn start_refresh_sources_with_preferred(&self, preferred_id: Option<&str>) {
        let Ok(work) = self.background.enter() else {
            return;
        };
        self.start_refresh_sources_with_preferred_tracked(preferred_id, work)
            .await;
    }

    pub async fn start_refresh_sources_tracked(&self, work: crate::background_work::WorkLease) {
        self.start_refresh_sources_with_preferred_tracked(None, work)
            .await;
    }

    pub async fn start_refresh_sources_with_preferred_tracked(
        &self,
        preferred_id: Option<&str>,
        work: crate::background_work::WorkLease,
    ) {
        if self.storage != "device" || work.check().is_err() {
            return;
        }
        let preferred = match preferred_id {
            Some(id) => self.preferred_record(id, &work).await,
            None => None,
        };
        self.start_refresh_sources_seeded(preferred, work, true)
            .await;
    }

    async fn start_refresh_sources_seeded(
        &self,
        preferred: Option<(u64, Option<Record>, Preferred)>,
        work: crate::background_work::WorkLease,
        force_refresh: bool,
    ) {
        let library = self.clone();
        // Register before returning so the first HTTP catalog cannot mistake an
        // empty startup snapshot for a finished library. Registration and the
        // preferred seed share the standby publication gate.
        {
            let Ok(mut scan) = work.run(self.scan.lock()).await else {
                return;
            };
            let start = work.publish(|| {
                if scan.jobs > 0 || (!force_refresh && scan.cached) {
                    scan.cache_preferred(preferred);
                    return false;
                }
                scan.jobs = 1;
                scan.records.clear();
                scan.cached = true;
                scan.scanned = 0;
                scan.error = None;
                scan.preferred = None;
                scan.cache_preferred(preferred);
                true
            });
            if start != Ok(true) {
                return;
            }
        }
        tokio::spawn(async move {
            if !matches!(work.run(library.records(&work)).await, Ok(Ok(_))) {
                library.scan.lock().await.error =
                    Some("Local media metadata could not be read".into());
            }
            library.refresh_sources_inner(&work).await;
            let mut scan = library.scan.lock().await;
            if work.check().is_err() {
                scan.invalidate();
                scan.error = Some("Local media scan cancelled".into());
            }
            scan.jobs -= 1;
        });
    }

    /// Called only with paths returned by an OS-native picker, never HTTP input.
    /// Stores names and original paths; no source media is copied or deleted.
    pub async fn link_paths(&self, paths: Vec<PathBuf>, folder: bool) -> anyhow::Result<()> {
        let work = self.background.enter().map_err(anyhow::Error::msg)?;
        self.link_paths_inner(paths, folder, &work).await
    }

    async fn link_paths_inner(
        &self,
        paths: Vec<PathBuf>,
        folder: bool,
        work: &crate::background_work::WorkLease,
    ) -> anyhow::Result<()> {
        work.check().map_err(anyhow::Error::msg)?;
        anyhow::ensure!(
            self.storage == "device",
            "Native sources are unavailable on this server"
        );
        let _lock = work
            .run(self.mutation.lock())
            .await
            .map_err(anyhow::Error::msg)?;
        let records = work
            .run(self.records(work))
            .await
            .map_err(anyhow::Error::msg)?
            .map_err(|_| anyhow::anyhow!("Cannot read media metadata"))?;
        let mut known_paths: std::collections::HashSet<PathBuf> = records
            .iter()
            .filter_map(|record| record.linked_path.clone())
            .collect();
        let sources = self
            .source_records()
            .await
            .map_err(|_| anyhow::anyhow!("Cannot read media sources"))?;
        for picked in paths {
            work.check().map_err(anyhow::Error::msg)?;
            let root = fs::canonicalize(&picked).await?;
            let metadata = fs::metadata(&root).await?;
            anyhow::ensure!(
                if folder {
                    metadata.is_dir()
                } else {
                    metadata.is_file()
                },
                "Invalid selected source"
            );
            let id = sources
                .iter()
                .find(|s| s.path == root)
                .map(|s| s.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
            let name = root
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("Local media")
                .to_string();
            let source = SourceRecord {
                id: id.clone(),
                name,
                kind: if folder { "folder" } else { "file" }.into(),
                path: root.clone(),
            };
            // Fail an inaccessible selected root, but keep a valid source record
            // before discovering children so a partial scan remains refreshable.
            if folder {
                drop(fs::read_dir(&root).await?);
            } else {
                fs::File::open(&root).await?;
            }
            let destination = self.root.join("sources").join(format!("{id}.json"));
            let temporary = destination.with_extension("part");
            work.check().map_err(anyhow::Error::msg)?;
            fs::write(&temporary, serde_json::to_vec(&source)?).await?;
            fs::rename(temporary, destination).await?;
            let mut pending = vec![root.clone()];
            let mut directories: Vec<fs::ReadDir> = Vec::new();
            let mut count = 0;
            loop {
                work.check().map_err(anyhow::Error::msg)?;
                let path = if let Some(path) = pending.pop() {
                    path
                } else if let Some(directory) = directories.last_mut() {
                    match directory.next_entry().await {
                        Ok(Some(entry)) => entry.path(),
                        Ok(None) | Err(_) => {
                            directories.pop();
                            continue;
                        }
                    }
                } else {
                    break;
                };
                count += 1;
                {
                    let mut scan = self.scan.lock().await;
                    if scan.jobs > 0 {
                        scan.scanned += 1;
                    }
                }
                anyhow::ensure!(count <= 20000, "Selected source contains too many entries");
                let metadata = match fs::symlink_metadata(&path).await {
                    Ok(metadata) => metadata,
                    Err(error) if path == root => return Err(error.into()),
                    Err(_) => continue,
                };
                // Do not traverse symlinks out of the user's selected tree.
                if metadata.file_type().is_symlink() {
                    continue;
                }
                if metadata.is_dir() {
                    let children = match fs::read_dir(&path).await {
                        Ok(children) => children,
                        Err(error) if path == root => return Err(error.into()),
                        Err(_) => continue,
                    };
                    directories.push(children);
                    continue;
                }
                if !metadata.is_file() {
                    continue;
                }
                let extension = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let Some(mime) = media_type(&extension) else {
                    continue;
                };
                if known_paths.contains(&path) {
                    continue;
                }
                if let Err(error) = fs::File::open(&path).await {
                    if path == root {
                        return Err(error.into());
                    }
                    continue;
                }
                let record = Record {
                    id: uuid::Uuid::new_v4().simple().to_string(),
                    name: path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Local media")
                        .into(),
                    size: metadata.len(),
                    mime: mime.into(),
                    extension,
                    linked_path: Some(path.clone()),
                    source_id: Some(id.clone()),
                };
                let destination = self.root.join(format!("{}.json", record.id));
                let temporary = destination.with_extension("part");
                work.check().map_err(anyhow::Error::msg)?;
                fs::write(&temporary, serde_json::to_vec(&record)?).await?;
                fs::rename(temporary, destination).await?;
                known_paths.insert(path);
                let mut scan = self.scan.lock().await;
                work.publish(|| {
                    if scan.jobs > 0 {
                        scan.records.insert(record.id.clone(), (record, true));
                    }
                })
                .map_err(anyhow::Error::msg)?;
            }
        }
        Ok(())
    }

    /// Refresh existing folder grants without dropping missing files or changing stable IDs.
    pub async fn refresh_sources(&self) {
        let Ok(work) = self.background.enter() else {
            return;
        };
        self.refresh_sources_inner(&work).await;
    }
    async fn refresh_sources_inner(&self, work: &crate::background_work::WorkLease) {
        if work.check().is_err() {
            return;
        }
        if self.storage != "device" {
            return;
        }
        let Ok(sources) = self.source_records().await else {
            return;
        };
        for source in sources {
            if work.check().is_err() {
                return;
            }
            if source.kind != "folder" {
                continue;
            }
            // Unmounted, moved or denied sources remain visible for reconnection.
            if let Err(_error) = self.link_paths_inner(vec![source.path], true, work).await {
                tracing::debug!("Local source currently unavailable during refresh");
            }
        }
    }

    pub async fn disconnect_source(&self, id: &str) -> anyhow::Result<()> {
        let work = self.background.enter().map_err(anyhow::Error::msg)?;
        anyhow::ensure!(valid_id(id), "Invalid source ID");
        let _lock = work
            .run(self.mutation.lock())
            .await
            .map_err(anyhow::Error::msg)?;
        for record in self
            .records(&work)
            .await
            .map_err(|_| anyhow::anyhow!("Cannot read media metadata"))?
        {
            work.check().map_err(anyhow::Error::msg)?;
            if record.source_id.as_deref().unwrap_or(&record.id) != id {
                continue;
            }
            if record.linked_path.is_none() {
                if let Ok(path) = self.path(&record).await {
                    fs::remove_file(path).await?;
                }
            }
            fs::remove_file(self.root.join(format!("{}.json", record.id))).await?;
        }
        let path = self.root.join("sources").join(format!("{id}.json"));
        if fs::try_exists(&path).await? {
            fs::remove_file(path).await?;
        }
        self.scan.lock().await.invalidate();
        Ok(())
    }

    pub async fn catalog(&self) -> Result<Catalog, Failure> {
        let work = self
            .background
            .enter()
            .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "Player is in standby"))?;
        let library = self.clone();
        owned_read(
            &work,
            |owner| async move { library.read_catalog(&owner).await },
        )
        .await
    }
    async fn read_catalog(&self, work: &ReadWork) -> Result<Catalog, Failure> {
        let base = self.endpoint();
        let (scanning, scanned, scan_error, cached, preferred) = {
            let scan = work.run(self.scan.lock()).await?;
            (
                scan.jobs > 0,
                scan.scanned,
                scan.error.clone(),
                if scan.cached {
                    Some(scan.records.values().cloned().collect::<Vec<_>>())
                } else {
                    None
                },
                scan.preferred.clone(),
            )
        };
        let mut records = match cached {
            Some(records) => records,
            None => {
                let mut validated = Vec::new();
                for record in self.read_records(work).await? {
                    work.check()?;
                    let available = self.read_path(&record, Some(work)).await.is_ok();
                    work.check()?;
                    validated.push((record, available));
                }
                validated
            }
        };
        records.sort_by(|(a, _), (b, _)| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        let mut items = Vec::new();
        for (r, available) in records {
            // Availability is checked when metadata enters a scan snapshot.
            // Media requests always validate the original again before serving.
            let size = r.size;
            items.push(Item {
                id: r.id.clone(),
                directory: r
                    .linked_path
                    .as_ref()
                    .and_then(|path| path.parent())
                    .and_then(|path| path.file_name())
                    .and_then(|name| name.to_str())
                    .unwrap_or("")
                    .to_string(),
                name: r.name,
                size,
                mime: r.mime,
                url: if available {
                    format!("{base}/{}", r.id)
                } else {
                    String::new()
                },
                available,
                source: if r.linked_path.is_some() {
                    "linked"
                } else {
                    "imported"
                },
                source_id: r.source_id.unwrap_or(r.id),
            });
        }
        let mut sources = Vec::new();
        for source in self.read_source_records(Some(work)).await? {
            let available = checked(Some(work), fs::symlink_metadata(&source.path))
                .await?
                .map(|m| {
                    !m.file_type().is_symlink()
                        && if source.kind == "folder" {
                            m.is_dir()
                        } else {
                            m.is_file()
                        }
                })
                .unwrap_or(false);
            sources.push(Source {
                id: source.id,
                name: source.name,
                kind: source.kind,
                available,
                access: if available { "granted" } else { "unavailable" },
            });
        }
        for item in &items {
            if !sources.iter().any(|s| s.id == item.source_id) {
                sources.push(Source {
                    id: item.source_id.clone(),
                    name: item.name.clone(),
                    kind: "file".into(),
                    available: item.available,
                    access: if item.available {
                        "granted"
                    } else {
                        "unavailable"
                    },
                });
            }
        }
        work.check()?;
        Ok(Catalog {
            available: true,
            items,
            storage: self.storage.clone(),
            persistent: true,
            upload_url: format!("{base}/import"),
            direct_sources: self.storage == "device",
            sources,
            scanning,
            scanned,
            total: if scanning || scan_error.is_some() {
                None
            } else {
                Some(scanned)
            },
            scan_error,
            preferred,
        })
    }
}
fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
fn storage_error<T>(_: T) -> Failure {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "Local media storage unavailable",
    )
}
fn media_type(extension: &str) -> Option<&'static str> {
    match extension {
        "mp4" | "m4v" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "ogv" => Some("video/ogg"),
        "mp3" => Some("audio/mpeg"),
        "m4a" => Some("audio/mp4"),
        "ogg" => Some("audio/ogg"),
        _ => None,
    }
}
fn cors(response: &mut Response) {
    let h = response.headers_mut();
    h.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    h.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET, HEAD, POST, DELETE, OPTIONS"),
    );
    h.insert(
        "access-control-allow-headers",
        HeaderValue::from_static("Content-Type, Range"),
    );
    h.insert(
        "access-control-expose-headers",
        HeaderValue::from_static("Content-Length, Content-Range, Accept-Ranges"),
    );
    h.insert("cache-control", HeaderValue::from_static("no-store"));
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
}
async fn preflight(
    State(l): State<Library>,
    Path(params): Path<std::collections::HashMap<String, String>>,
) -> Response {
    let mut r = match l.authorize(params.get("token").map(String::as_str).unwrap_or("")) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => e.into_response(),
    };
    cors(&mut r);
    r
}
async fn catalog(State(l): State<Library>, Path(token): Path<String>) -> Response {
    let mut r = match l.authorize(&token) {
        Ok(()) => match l.catalog().await {
            Ok(c) => Json(c).into_response(),
            Err(e) => e.into_response(),
        },
        Err(e) => e.into_response(),
    };
    cors(&mut r);
    r
}
async fn import(
    State(l): State<Library>,
    Path(token): Path<String>,
    Query(q): Query<ImportQuery>,
    body: Body,
) -> Response {
    let result = import_inner(&l, &token, &q.name, body).await;
    let mut r = match result {
        Ok(c) => Json(c).into_response(),
        Err(e) => e.into_response(),
    };
    cors(&mut r);
    r
}
async fn import_inner(
    l: &Library,
    token: &str,
    name: &str,
    body: Body,
) -> Result<Catalog, Failure> {
    l.authorize(token)?;
    let work = l
        .background
        .enter()
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "Player is in standby"))?;
    if name.is_empty()
        || name.len() > 240
        || name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid media filename"));
    }
    let extension = FsPath::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = media_type(&extension).ok_or((
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "Use MP4, WebM, OGV, MP3, M4A or OGG",
    ))?;
    let _lock = l.mutation.lock().await;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let temporary = l.root.join(format!("{id}.upload"));
    let target = l.root.join(format!("{id}.{extension}"));
    // Ownership is established inside the blocking task, so cancellation while
    // creating the file still drops a guard instead of leaving an orphan.
    let upload_path = temporary.clone();
    let creation = work.clone();
    let mut upload = tokio::task::spawn_blocking(move || {
        creation.check().map_err(std::io::Error::other)?;
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&upload_path)?;
        Ok::<_, std::io::Error>(PendingUpload {
            file: Some(fs::File::from_std(file)),
            path: upload_path,
        })
    })
    .await
    .map_err(storage_error)?
    .map_err(storage_error)?;
    let write_result: Result<u64, Failure> = async {
        let mut size = 0u64;
        let mut chunks = body.into_data_stream();
        while let Some(chunk) = work
            .run(tokio::time::timeout(
                std::time::Duration::from_secs(60),
                chunks.next(),
            ))
            .await
            .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "Player is in standby"))?
            .map_err(|_| (StatusCode::REQUEST_TIMEOUT, "Upload stalled"))?
        {
            let chunk = chunk.map_err(|_| (StatusCode::BAD_REQUEST, "Upload interrupted"))?;
            size = size
                .checked_add(chunk.len() as u64)
                .filter(|s| *s <= MAX_BYTES)
                .ok_or((
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Maximum media size is 16 GiB",
                ))?;
            upload
                .file
                .as_mut()
                .unwrap()
                .write_all(&chunk)
                .await
                .map_err(storage_error)?;
        }
        work.check()
            .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "Player is in standby"))?;
        if size == 0 {
            return Err((StatusCode::BAD_REQUEST, "Media file is empty"));
        }
        upload
            .file
            .as_mut()
            .unwrap()
            .flush()
            .await
            .map_err(storage_error)?;
        Ok(size)
    }
    .await;
    drop(upload.file.take());
    let size = match write_result {
        Ok(size) => size,
        Err(e) => {
            let _ = fs::remove_file(&temporary).await;
            return Err(e);
        }
    };
    fs::rename(&temporary, &target)
        .await
        .map_err(storage_error)?;
    let record = Record {
        id: id.clone(),
        name: name.into(),
        size,
        mime: mime.into(),
        extension,
        linked_path: None,
        source_id: None,
    };
    let encoded = serde_json::to_vec(&record).map_err(storage_error)?;
    if let Err(e) = fs::write(l.root.join(format!("{id}.json")), encoded).await {
        let _ = fs::remove_file(target).await;
        return Err(storage_error(e));
    }
    l.scan.lock().await.invalidate();
    l.catalog().await
}
async fn remove(State(l): State<Library>, Path((token, id)): Path<(String, String)>) -> Response {
    let result: Result<Catalog, Failure> = async {
        l.authorize(&token)?;
        let work = l
            .background
            .enter()
            .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "Player is in standby"))?;
        let _lock = work.run(l.mutation.lock()).await.map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Player background work cancelled",
            )
        })?;
        let record = l.record(&id).await?;
        if record.linked_path.is_none() {
            fs::remove_file(l.path(&record).await?)
                .await
                .map_err(storage_error)?;
        }
        fs::remove_file(l.root.join(format!("{id}.json")))
            .await
            .map_err(storage_error)?;
        l.scan.lock().await.invalidate();
        l.catalog().await
    }
    .await;
    let mut r = match result {
        Ok(c) => Json(c).into_response(),
        Err(e) => e.into_response(),
    };
    cors(&mut r);
    r
}
async fn remove_source(
    State(l): State<Library>,
    Path((token, id)): Path<(String, String)>,
) -> Response {
    let result = async {
        l.authorize(&token)?;
        l.disconnect_source(&id).await.map_err(storage_error)?;
        l.catalog().await
    }
    .await;
    let mut response = match result {
        Ok(catalog) => Json(catalog).into_response(),
        Err(error) => error.into_response(),
    };
    cors(&mut response);
    response
}

fn byte_range(value: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, Failure> {
    let Some(value) = value else { return Ok(None) };
    let fail = || (StatusCode::RANGE_NOT_SATISFIABLE, "Invalid byte range");
    let raw = value.strip_prefix("bytes=").ok_or_else(fail)?;
    if raw.contains(',') || size == 0 {
        return Err(fail());
    }
    let (a, b) = raw.split_once('-').ok_or_else(fail)?;
    let range = if a.is_empty() {
        let length = b.parse::<u64>().map_err(|_| fail())?;
        if length == 0 {
            return Err(fail());
        }
        (size.saturating_sub(length), size - 1)
    } else {
        let start = a.parse::<u64>().map_err(|_| fail())?;
        let end = if b.is_empty() {
            size - 1
        } else {
            b.parse::<u64>().map_err(|_| fail())?.min(size - 1)
        };
        if start >= size || end < start {
            return Err(fail());
        }
        (start, end)
    };
    Ok(Some(range))
}

async fn read_media_chunk<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    mut file: R,
    left: u64,
    work: &crate::background_work::WorkLease,
) -> Result<(R, Vec<u8>), Failure> {
    owned_read(work, move |owner| async move {
        let mut bytes = vec![0; left.min(64 * 1024) as usize];
        let read = checked(Some(&owner), file.read(&mut bytes))
            .await?
            .map_err(storage_error)?;
        bytes.truncate(read);
        Ok((file, bytes))
    })
    .await
}

async fn media(
    State(l): State<Library>,
    Path((token, id)): Path<(String, String)>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    let result: Result<Response, Failure> = async {
        l.authorize(&token)?;
        let work = l
            .background
            .enter()
            .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "Player is in standby"))?;
        let (record, file, size) = owned_read(&work, |owner| async move {
            let record = l.read_record(&id, Some(&owner)).await?;
            let path = l.read_path(&record, Some(&owner)).await?;
            let file = checked(Some(&owner), fs::File::open(path))
                .await?
                .map_err(storage_error)?;
            let size = checked(Some(&owner), file.metadata())
                .await?
                .map_err(storage_error)?
                .len();
            Ok((record, file, size))
        })
        .await?;
        let range = match byte_range(headers.get("range").and_then(|v| v.to_str().ok()), size) {
            Ok(r) => r,
            Err(e) => {
                let mut r = e.into_response();
                r.headers_mut()
                    .insert("content-range", format!("bytes */{size}").parse().unwrap());
                return Ok(r);
            }
        };
        let (start, end) = range.unwrap_or((0, size.saturating_sub(1)));
        let length = if size == 0 { 0 } else { end - start + 1 };
        let file = owned_read(&work, move |owner| async move {
            let mut file = file;
            checked(Some(&owner), file.seek(std::io::SeekFrom::Start(start)))
                .await?
                .map_err(storage_error)?;
            Ok(file)
        })
        .await?;
        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from_stream(stream::try_unfold(
                (file, length, work),
                |(file, left, work)| async move {
                    if left == 0 {
                        return Ok::<_, std::io::Error>(None);
                    }
                    let (file, bytes) = read_media_chunk(file, left, &work)
                        .await
                        .map_err(|error| std::io::Error::other(error.1))?;
                    let read = bytes.len();
                    if read == 0 {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "Local media truncated",
                        ));
                    }
                    Ok(Some((Bytes::from(bytes), (file, left - read as u64, work))))
                },
            ))
        };
        let mut r = Response::new(body);
        *r.status_mut() = if range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        };
        let h = r.headers_mut();
        h.insert("content-type", record.mime.parse().unwrap());
        h.insert("content-length", length.into());
        h.insert("accept-ranges", HeaderValue::from_static("bytes"));
        if range.is_some() {
            h.insert(
                "content-range",
                format!("bytes {start}-{end}/{size}").parse().unwrap(),
            );
        }
        Ok(r)
    }
    .await;
    let mut r = match result {
        Ok(r) => r,
        Err(e) => e.into_response(),
    };
    cors(&mut r);
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn bounded<T>(operation: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(std::time::Duration::from_secs(2), operation)
            .await
            .expect("filesystem worker did not reach the expected checkpoint")
    }

    async fn wait_for_drain(background: &crate::background_work::BackgroundWork) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while background.status().pending != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn cancelled_owned_read_counts_current_io_and_never_starts_next_operation() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let background = crate::background_work::BackgroundWork::default();
        let work = background.enter().unwrap();
        let next_operations = Arc::new(AtomicUsize::new(0));
        let observed = next_operations.clone();
        let (started, entered) = tokio::sync::oneshot::channel();
        let (finish, current_io) = tokio::sync::oneshot::channel();
        let reader = tokio::spawn(async move {
            owned_read(&work, |owner| async move {
                // This barrier represents an already-running filesystem call:
                // cancelling its caller cannot stop the underlying operation.
                checked(Some(&owner), async move {
                    started.send(()).unwrap();
                    current_io.await.unwrap();
                })
                .await?;
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await
        });
        bounded(entered).await.unwrap();
        background.set_standby(true);
        assert_eq!(bounded(reader).await.unwrap(), Err(BACKGROUND_CANCELLED));
        assert_eq!(background.status().pending, 1);
        assert!(!background.status().quiescent);
        // Even an immediate wake cannot authorize the previous read's tail.
        background.set_standby(false);
        finish.send(()).unwrap();
        wait_for_drain(&background).await;
        assert_eq!(next_operations.load(Ordering::SeqCst), 0);
        assert!(background.set_standby(true).quiescent);
    }

    #[tokio::test]
    async fn timed_out_or_dropped_reader_stops_after_current_io_while_player_stays_awake() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for timeout in [true, false] {
            let background = crate::background_work::BackgroundWork::default();
            let work = background.enter().unwrap();
            let next_operations = Arc::new(AtomicUsize::new(0));
            let observed = next_operations.clone();
            let scan = Arc::new(Mutex::new(ScanState::default()));
            let published = scan.clone();
            let (started, entered) = tokio::sync::oneshot::channel();
            let (finish, current_io) = tokio::sync::oneshot::channel();
            let reader = tokio::spawn(async move {
                let read = owned_read(&work, |owner| async move {
                    checked(Some(&owner), async move {
                        started.send(()).unwrap();
                        current_io.await.unwrap();
                    })
                    .await?;
                    checked(Some(&owner), async {
                        observed.fetch_add(1, Ordering::SeqCst);
                    })
                    .await?;
                    let mut scan = owner.run(published.lock()).await?;
                    owner.publish(|| scan.cached = true)?;
                    Ok(())
                });
                if timeout {
                    assert!(
                        tokio::time::timeout(std::time::Duration::from_millis(25), read)
                            .await
                            .is_err()
                    );
                } else {
                    read.await.unwrap();
                }
            });
            bounded(entered).await.unwrap();
            if timeout {
                bounded(reader).await.unwrap();
            } else {
                reader.abort();
                assert!(bounded(reader).await.unwrap_err().is_cancelled());
            }
            assert_eq!(background.status().pending, 1);
            assert!(!background.status().standby);
            finish.send(()).unwrap();
            wait_for_drain(&background).await;
            assert!(!background.status().standby);
            assert_eq!(next_operations.load(Ordering::SeqCst), 0);
            assert!(!scan.lock().await.cached);
        }
    }

    #[tokio::test]
    async fn abandoned_reader_releases_scan_mutex_wait_without_late_publication() {
        let background = crate::background_work::BackgroundWork::default();
        let work = background.enter().unwrap();
        let scan = Arc::new(Mutex::new(ScanState::default()));
        let held = scan.lock().await;
        let published = scan.clone();
        let (started, entered) = tokio::sync::oneshot::channel();
        let reader = tokio::spawn(async move {
            owned_read(&work, |owner| async move {
                started.send(()).unwrap();
                let mut scan = owner.run(published.lock()).await?;
                owner.publish(|| scan.cached = true)?;
                Ok(())
            })
            .await
        });
        bounded(entered).await.unwrap();
        reader.abort();
        assert!(bounded(reader).await.unwrap_err().is_cancelled());
        // No filesystem call is active here: the abandoned mutex waiter must
        // drain even while another operation retains the publication lock.
        wait_for_drain(&background).await;
        assert!(!background.status().standby);
        assert!(!held.cached);
        drop(held);
        // A fresh read and publication remain allowed in this generation.
        let fresh = background.enter().unwrap();
        let published = scan.clone();
        owned_read(&fresh, |owner| async move {
            let mut scan = owner.run(published.lock()).await?;
            owner.publish(|| scan.cached = true)
        })
        .await
        .unwrap();
        assert!(scan.lock().await.cached);
    }

    #[tokio::test]
    async fn cancelled_media_chunk_keeps_io_owned_until_completion() {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct HeldRead {
            started: Option<tokio::sync::oneshot::Sender<()>>,
            completion: tokio::sync::oneshot::Receiver<()>,
            dropped: Arc<AtomicBool>,
        }
        impl tokio::io::AsyncRead for HeldRead {
            fn poll_read(
                mut self: std::pin::Pin<&mut Self>,
                cx: &mut std::task::Context<'_>,
                buf: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                if let Some(started) = self.started.take() {
                    started.send(()).unwrap();
                }
                match std::future::Future::poll(std::pin::Pin::new(&mut self.completion), cx) {
                    std::task::Poll::Pending => std::task::Poll::Pending,
                    std::task::Poll::Ready(result) => {
                        result.unwrap();
                        buf.put_slice(b"x");
                        std::task::Poll::Ready(Ok(()))
                    }
                }
            }
        }
        impl Drop for HeldRead {
            fn drop(&mut self) {
                self.dropped.store(true, Ordering::SeqCst);
            }
        }
        for standby in [false, true] {
            let background = crate::background_work::BackgroundWork::default();
            let work = background.enter().unwrap();
            let dropped = Arc::new(AtomicBool::new(false));
            let (started, entered) = tokio::sync::oneshot::channel();
            let (finish, completion) = tokio::sync::oneshot::channel();
            let file = HeldRead {
                started: Some(started),
                completion,
                dropped: dropped.clone(),
            };
            let reader = tokio::spawn(async move { read_media_chunk(file, 64, &work).await });
            bounded(entered).await.unwrap();
            if standby {
                background.set_standby(true);
                assert_eq!(
                    bounded(reader).await.unwrap().err(),
                    Some(BACKGROUND_CANCELLED)
                );
                background.set_standby(false);
            } else {
                reader.abort();
                assert!(bounded(reader).await.err().unwrap().is_cancelled());
            }
            assert_eq!(background.status().pending, 1);
            assert!(!dropped.load(Ordering::SeqCst));
            // The caller has gone, but its actual read still owns the file.
            finish.send(()).unwrap();
            wait_for_drain(&background).await;
            assert!(dropped.load(Ordering::SeqCst));
            assert!(!background.status().standby);
        }
    }

    #[tokio::test]
    async fn standby_stops_persisted_metadata_traversal_without_late_cache_publication() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let originals = root.with_extension("originals");
        fs::create_dir_all(&originals).await.unwrap();
        let movie = originals.join("movie.mp4");
        fs::write(&movie, b"movie").await.unwrap();
        let movie = fs::canonicalize(movie).await.unwrap();
        let background = crate::background_work::BackgroundWork::default();
        let library = Library::new(root.clone(), "r".repeat(32), "device")
            .await
            .unwrap()
            .with_background(background.clone());
        for index in 0..64 {
            let record = Record {
                id: uuid::Uuid::new_v4().simple().to_string(),
                name: format!("movie-{index}"),
                size: 5,
                mime: "video/mp4".into(),
                extension: "mp4".into(),
                linked_path: Some(movie.clone()),
                source_id: None,
            };
            fs::write(
                root.join(format!("{}.json", record.id)),
                serde_json::to_vec(&record).unwrap(),
            )
            .await
            .unwrap();
        }
        library.start_refresh_sources().await;
        let at_cancel = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let scan = library.scan.lock().await;
                if scan.scanned > 0 {
                    assert!(
                        scan.scanned < 64,
                        "cancel before the metadata traversal completes"
                    );
                    // Hold publication's mutex across cancellation. A record
                    // already read may not publish when that mutex is released.
                    background.set_standby(true);
                    let scanned = scan.scanned;
                    drop(scan);
                    return scanned;
                }
                drop(scan);
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        background.set_standby(false);
        wait_for_drain(&background).await;
        {
            let scan = library.scan.lock().await;
            assert_eq!(scan.scanned, at_cancel);
            assert_eq!(scan.records.len(), at_cancel as usize);
            assert_eq!(scan.jobs, 0);
            assert!(!scan.cached);
        }
        library.start_refresh_sources().await;
        wait_for_drain(&background).await;
        assert_eq!(library.catalog().await.unwrap().items.len(), 64);
        fs::remove_dir_all(root).await.unwrap();
        fs::remove_dir_all(originals).await.unwrap();
    }

    #[tokio::test]
    async fn saved_native_item_is_ready_before_unrelated_records_are_scanned() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let originals = root.with_extension("originals");
        fs::create_dir_all(&originals).await.unwrap();
        for index in 0..128 {
            fs::write(originals.join(format!("movie-{index:03}.mp4")), b"video")
                .await
                .unwrap();
        }
        let library = Library::new(root.clone(), "p".repeat(32), "device")
            .await
            .unwrap();
        library
            .link_paths(vec![originals.clone()], true)
            .await
            .unwrap();
        let catalog = library.catalog().await.unwrap();
        let last_id = catalog.items.last().unwrap().id.clone();
        let reopened = Library::new(root.clone(), "r".repeat(32), "device")
            .await
            .unwrap();
        reopened
            .start_refresh_sources_with_preferred(Some(&last_id))
            .await;
        {
            // On this single-thread runtime the scheduled traversal has not
            // run yet: the last playlist item must already be playable.
            let scan = reopened.scan.lock().await;
            assert_eq!(scan.jobs, 1);
            assert_eq!(scan.scanned, 0);
            assert_eq!(scan.records.len(), 1);
            assert!(scan.records.get(&last_id).unwrap().1);
        }
        let response = media(
            State(reopened.clone()),
            Path(("r".repeat(32), last_id.clone())),
            HeaderMap::new(),
            Method::GET,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while reopened.scan.lock().await.jobs != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let completed = reopened.catalog().await.unwrap();
        assert_eq!(completed.items.len(), 128);
        assert_eq!(
            completed
                .items
                .iter()
                .filter(|item| item.id == last_id)
                .count(),
            1
        );
        let scanned = completed.scanned;
        reopened.prioritize_item(&last_id).await;
        let repeated = reopened.catalog().await.unwrap();
        assert!(
            !repeated.scanning,
            "a saved-item lookup must not restart discovery"
        );
        assert_eq!(repeated.scanned, scanned);
        assert_eq!(repeated.items.len(), 128);
        fs::remove_dir_all(root).await.unwrap();
        fs::remove_dir_all(originals).await.unwrap();
    }

    #[tokio::test]
    async fn missing_saved_native_file_is_reported_before_background_discovery() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let originals = root.with_extension("originals");
        fs::create_dir_all(&originals).await.unwrap();
        fs::write(originals.join("removed.mp4"), b"video")
            .await
            .unwrap();
        fs::write(originals.join("survivor.mp4"), b"video")
            .await
            .unwrap();
        let library = Library::new(root.clone(), "p".repeat(32), "device")
            .await
            .unwrap();
        library
            .link_paths(vec![originals.clone()], true)
            .await
            .unwrap();
        let id = library
            .catalog()
            .await
            .unwrap()
            .items
            .iter()
            .find(|item| item.name == "removed.mp4")
            .unwrap()
            .id
            .clone();
        fs::remove_file(originals.join("removed.mp4"))
            .await
            .unwrap();
        let reopened = Library::new(root.clone(), "r".repeat(32), "device")
            .await
            .unwrap();
        reopened
            .start_refresh_sources_with_preferred(Some(&id))
            .await;
        {
            let scan = reopened.scan.lock().await;
            assert_eq!(scan.scanned, 0);
            assert_eq!(scan.jobs, 1);
            let preferred = scan.preferred.as_ref().unwrap();
            assert_eq!(preferred.id, id);
            assert_eq!(preferred.state, "missing");
        }
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while reopened.scan.lock().await.jobs != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(reopened
            .catalog()
            .await
            .unwrap()
            .items
            .iter()
            .any(|item| item.name == "survivor.mp4" && item.available));
        fs::remove_dir_all(root).await.unwrap();
        fs::remove_dir_all(originals).await.unwrap();
    }

    #[tokio::test]
    async fn preferred_item_does_not_wait_for_or_reset_an_active_native_scan() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let originals = root.with_extension("originals");
        fs::create_dir_all(&originals).await.unwrap();
        fs::write(originals.join("first.mp4"), b"first")
            .await
            .unwrap();
        fs::write(originals.join("last.mp4"), b"last")
            .await
            .unwrap();
        let library = Library::new(root.clone(), "p".repeat(32), "device")
            .await
            .unwrap();
        library
            .link_paths(vec![originals.clone()], true)
            .await
            .unwrap();
        let items = library.catalog().await.unwrap().items;
        // Discovery takes this lock for the whole source. Direct resume must
        // remain independent even when that background traversal is blocked.
        let mutation = library.mutation.lock().await;
        library
            .start_link_paths(vec![originals.clone()], true)
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            library.prioritize_item(&items[0].id).await;
            library
                .start_refresh_sources_with_preferred(Some(&items[1].id))
                .await;
        })
        .await
        .unwrap();
        {
            let scan = library.scan.lock().await;
            assert_eq!(
                scan.jobs, 1,
                "repeated discovery must not enqueue a second job"
            );
            assert_eq!(scan.scanned, 0);
            assert_eq!(
                scan.records.len(),
                2,
                "an existing snapshot must not be cleared"
            );
        }
        let catalog = library.catalog().await.unwrap();
        assert!(catalog.scanning);
        assert!(catalog.items.iter().all(|item| item.available));
        drop(mutation);
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while library.scan.lock().await.jobs != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(library.catalog().await.unwrap().items.len(), 2);
        fs::remove_dir_all(root).await.unwrap();
        fs::remove_dir_all(originals).await.unwrap();
    }

    #[tokio::test]
    async fn preferred_lookup_rejects_unknown_deleted_and_other_instance_items() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let library = Library::new(root.join("one"), "p".repeat(32), "device")
            .await
            .unwrap();
        let other = Library::new(root.join("two"), "q".repeat(32), "device")
            .await
            .unwrap();
        let items = import_inner(&library, &"p".repeat(32), "movie.mp4", Body::from("movie"))
            .await
            .unwrap()
            .items;
        let id = &items[0].id;
        assert!(library
            .preferred_record(id, &library.background.enter().unwrap())
            .await
            .is_some());
        let foreign = other
            .preferred_record(id, &other.background.enter().unwrap())
            .await
            .unwrap();
        assert!(foreign.1.is_none());
        assert_eq!(foreign.2.state, "missing");
        for invalid in ["../movie", "/tmp/movie.mp4", "local-movie", ""] {
            assert!(library
                .preferred_record(invalid, &library.background.enter().unwrap())
                .await
                .is_none());
        }
        fs::remove_file(library.root.join(format!("{id}.mp4")))
            .await
            .unwrap();
        let missing = library
            .preferred_record(id, &library.background.enter().unwrap())
            .await
            .unwrap();
        assert!(missing.1.is_none());
        assert_eq!(missing.2.state, "missing");
        fs::remove_dir_all(root).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preferred_lookup_rejects_replaced_original_and_metadata_symlinks() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let originals = root.with_extension("originals");
        fs::create_dir_all(&originals).await.unwrap();
        let movie = originals.join("movie.mp4");
        fs::write(&movie, b"video").await.unwrap();
        let library = Library::new(root.clone(), "p".repeat(32), "device")
            .await
            .unwrap();
        library
            .link_paths(vec![originals.clone()], true)
            .await
            .unwrap();
        let id = library.catalog().await.unwrap().items[0].id.clone();
        let target = originals.join("replacement.mp4");
        fs::rename(&movie, &target).await.unwrap();
        std::os::unix::fs::symlink(&target, &movie).unwrap();
        let blocked = library
            .preferred_record(&id, &library.background.enter().unwrap())
            .await
            .unwrap();
        assert!(blocked.1.is_none());
        assert_eq!(blocked.2.state, "pending");
        fs::remove_file(&movie).await.unwrap();
        fs::rename(target, movie).await.unwrap();
        let metadata = root.join(format!("{id}.json"));
        let metadata_target = root.join("metadata.backup");
        fs::rename(&metadata, &metadata_target).await.unwrap();
        std::os::unix::fs::symlink(metadata_target, metadata).unwrap();
        let blocked = library
            .preferred_record(&id, &library.background.enter().unwrap())
            .await
            .unwrap();
        assert!(blocked.1.is_none());
        assert_eq!(blocked.2.state, "pending");
        fs::remove_dir_all(root).await.unwrap();
        fs::remove_dir_all(originals).await.unwrap();
    }

    #[tokio::test]
    async fn disconnect_during_preferred_lookup_cannot_restore_an_old_snapshot_entry() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let library = Library::new(root.clone(), "p".repeat(32), "device")
            .await
            .unwrap();
        let item = import_inner(&library, &"p".repeat(32), "movie.mp4", Body::from("movie"))
            .await
            .unwrap()
            .items
            .remove(0);
        // Finish validation, then disconnect before that result is published.
        let preferred = library
            .preferred_record(&item.id, &library.background.enter().unwrap())
            .await;
        assert!(preferred.is_some());
        library.disconnect_source(&item.source_id).await.unwrap();
        library.start_refresh_sources().await;
        library.scan.lock().await.cache_preferred(preferred);
        assert!(library.catalog().await.unwrap().items.is_empty());
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while library.scan.lock().await.jobs != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn standby_cancels_preferred_startup_and_old_lookup_cannot_publish_after_wake() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let background = crate::background_work::BackgroundWork::default();
        let library = Library::new(root.clone(), "p".repeat(32), "device")
            .await
            .unwrap()
            .with_background(background.clone());
        let id = import_inner(&library, &"p".repeat(32), "movie.mp4", Body::from("movie"))
            .await
            .unwrap()
            .items
            .remove(0)
            .id;
        // Keep the lookup awaiting its first snapshot access. It must cancel
        // promptly rather than register a scan when this old request resumes.
        let held = library.scan.lock().await;
        let lookup_library = library.clone();
        let lookup_id = id.clone();
        let lookup = tokio::spawn(async move {
            lookup_library
                .start_refresh_sources_with_preferred(Some(&lookup_id))
                .await;
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while background.status().pending == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        background.set_standby(true);
        library.prioritize_item(&id).await;
        library
            .start_refresh_sources_with_preferred(Some(&id))
            .await;
        background.set_standby(false);
        tokio::time::timeout(std::time::Duration::from_secs(2), lookup)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(background.status().pending, 0);
        assert_eq!(held.jobs, 0);
        assert!(held.records.is_empty());
        drop(held);
        // A new wake generation can still use the direct seed normally.
        library
            .start_refresh_sources_with_preferred(Some(&id))
            .await;
        assert!(library.scan.lock().await.records.get(&id).unwrap().1);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while background.status().pending != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn ordinary_preferred_lookup_restarts_a_cancelled_snapshot_after_wake() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let background = crate::background_work::BackgroundWork::default();
        let library = Library::new(root.clone(), "p".repeat(32), "device")
            .await
            .unwrap()
            .with_background(background.clone());
        let id = import_inner(&library, &"p".repeat(32), "movie.mp4", Body::from("movie"))
            .await
            .unwrap()
            .items
            .remove(0)
            .id;
        library.start_refresh_sources().await;
        background.set_standby(true);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while background.status().pending != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!library.scan.lock().await.cached);
        background.set_standby(false);
        // This is the ordinary endpoint lookup: no explicit refresh flag.
        library.prioritize_item(&id).await;
        {
            let scan = library.scan.lock().await;
            assert!(scan.cached);
            assert_eq!(scan.jobs, 1);
            assert_eq!(scan.scanned, 0);
            assert_eq!(scan.records.len(), 1);
            assert!(scan.records.get(&id).unwrap().1);
        }
        library.prioritize_item(&id).await;
        assert!(library.scan.lock().await.jobs <= 1);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while background.status().pending != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let scanned = library.scan.lock().await.scanned;
        // Another endpoint can finish rebuilding between an ensure caller's
        // invalid-cache check and its registration lock. That stale decision
        // must not clear the now-complete snapshot and launch a second scan.
        let work = background.enter().unwrap();
        let preferred = library.preferred_record(&id, &work).await;
        library
            .start_refresh_sources_seeded(preferred, work, false)
            .await;
        library.prioritize_item(&id).await;
        assert_eq!(library.scan.lock().await.jobs, 0);
        assert_eq!(library.scan.lock().await.scanned, scanned);
        assert_eq!(library.catalog().await.unwrap().items.len(), 1);
        // Legacy profiles and the source manager may have no saved item.
        // Their ordinary endpoint discovery must also rebuild asynchronously.
        library.start_refresh_sources().await;
        background.set_standby(true);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while background.status().pending != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        background.set_standby(false);
        library
            .ensure_catalog_tracked(None, background.enter().unwrap())
            .await;
        {
            let scan = library.scan.lock().await;
            assert!(scan.cached);
            assert_eq!(scan.jobs, 1);
            assert_eq!(scan.scanned, 0);
        }
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while background.status().pending != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(library.catalog().await.unwrap().items.len(), 1);
        fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn standby_cancels_a_queued_scan_and_wake_does_not_revive_its_generation() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let originals = root.with_extension("originals");
        fs::create_dir_all(&originals).await.unwrap();
        fs::write(originals.join("movie.mp4"), b"video")
            .await
            .unwrap();
        let background = crate::background_work::BackgroundWork::default();
        let library = Library::new(root.clone(), "q".repeat(32), "device")
            .await
            .unwrap()
            .with_background(background.clone());
        let held = library.mutation.lock().await;
        library
            .start_link_paths(vec![originals.clone()], true)
            .await
            .unwrap();
        assert_eq!(background.status().pending, 1);
        background.set_standby(true);
        assert!(library
            .start_link_paths(vec![originals.clone()], true)
            .await
            .is_err());
        assert!(library.catalog().await.is_err());
        background.set_standby(false);
        drop(held);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while background.status().pending != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(library.source_records().await.unwrap().is_empty());
        library
            .start_link_paths(vec![originals.clone()], true)
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while background.status().pending != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(library.catalog().await.unwrap().items.len(), 1);
        background.set_standby(true);
        let shared_root = root.with_extension("shared");
        let shared = Library::new(shared_root.clone(), "z".repeat(32), "server")
            .await
            .unwrap();
        assert!(
            shared.catalog().await.is_ok(),
            "another server library is independent"
        );
        assert!(background.status().quiescent);
        fs::remove_dir_all(root).await.unwrap();
        fs::remove_dir_all(originals).await.unwrap();
        fs::remove_dir_all(shared_root).await.unwrap();
    }
    #[tokio::test]
    async fn background_native_scan_publishes_playable_items_before_completion() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let originals = root.with_extension("originals");
        fs::create_dir_all(&originals).await.unwrap();
        for index in 0..192 {
            fs::write(originals.join(format!("movie-{index:03}.mp4")), b"video")
                .await
                .unwrap();
        }
        let library = Library::new(root.clone(), "p".repeat(32), "device")
            .await
            .unwrap();
        library
            .start_link_paths(vec![originals.clone()], true)
            .await
            .unwrap();
        let initial = library.catalog().await.unwrap();
        assert!(
            initial.scanning,
            "the command registers work before returning"
        );
        assert_eq!(initial.total, None);
        let early = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let catalog = library.catalog().await.unwrap();
                if !catalog.items.is_empty() {
                    break catalog;
                }
                assert!(catalog.scanning);
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            early.scanning,
            "first playable batch must precede the final scan"
        );
        assert!(early.items.len() < 192);
        assert!(early.scanned > 0);
        let first_id = early.items[0].id.clone();
        let response = media(
            State(library.clone()),
            Path(("p".repeat(32), first_id.clone())),
            HeaderMap::new(),
            Method::GET,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let completed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if library.scan.lock().await.jobs == 0 {
                    break library.catalog().await.unwrap();
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(completed.items.len(), 192);
        assert!(!completed.scanning);
        assert_eq!(completed.total, Some(completed.scanned));
        assert!(completed.scan_error.is_none());
        assert!(completed.items.iter().any(|item| item.id == first_id));
        library.start_refresh_sources().await;
        // Repeated endpoint discovery must not enqueue duplicate refresh jobs.
        library.start_refresh_sources().await;
        assert_eq!(library.scan.lock().await.jobs, 1);
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while library.scan.lock().await.jobs != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let refreshed = library.catalog().await.unwrap();
        assert_eq!(refreshed.items.len(), 192);
        assert!(refreshed.items.iter().any(|item| item.id == first_id));
        assert!(!root.join(format!("{first_id}.mp4")).exists());
        let original = library
            .record(&first_id)
            .await
            .unwrap()
            .linked_path
            .unwrap();
        fs::remove_file(original).await.unwrap();
        library.start_refresh_sources().await;
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while library.scan.lock().await.jobs != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let missing = library.catalog().await.unwrap();
        let missing_item = missing
            .items
            .iter()
            .find(|item| item.id == first_id)
            .unwrap();
        assert!(
            !missing_item.available,
            "cached snapshots must preserve unavailable originals"
        );
        assert!(missing_item.url.is_empty());
        library
            .disconnect_source(&missing_item.source_id)
            .await
            .unwrap();
        assert!(
            library.catalog().await.unwrap().items.is_empty(),
            "disconnect invalidates the completed scan cache"
        );
        fs::remove_dir_all(root).await.unwrap();
        fs::remove_dir_all(originals).await.unwrap();
    }

    #[tokio::test]
    async fn refresh_keeps_available_folder_when_another_source_is_missing() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let originals = root.with_extension("originals");
        let missing = originals.join("missing");
        let available = originals.join("available");
        fs::create_dir_all(&missing).await.unwrap();
        fs::create_dir_all(&available).await.unwrap();
        fs::write(missing.join("old.mp4"), b"old").await.unwrap();
        fs::write(available.join("play.mp4"), b"video")
            .await
            .unwrap();
        let library = Library::new(root.clone(), "m".repeat(32), "device")
            .await
            .unwrap();
        library
            .link_paths(vec![missing.clone(), available], true)
            .await
            .unwrap();
        fs::remove_dir_all(missing).await.unwrap();
        library.start_refresh_sources().await;
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while library.scan.lock().await.jobs != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let catalog = library.catalog().await.unwrap();
        assert!(
            catalog.scan_error.is_none(),
            "one disconnected source must not reject the playable catalog"
        );
        assert_eq!(catalog.items.len(), 2);
        assert_eq!(
            catalog.items.iter().filter(|item| item.available).count(),
            1
        );
        assert_eq!(
            catalog
                .sources
                .iter()
                .filter(|source| source.available)
                .count(),
            1
        );
        fs::remove_dir_all(root).await.unwrap();
        fs::remove_dir_all(originals).await.unwrap();
    }

    #[tokio::test]
    async fn failed_background_scan_finishes_with_explicit_error() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let library = Library::new(root.clone(), "z".repeat(32), "device")
            .await
            .unwrap();
        library
            .start_link_paths(vec![root.join("missing")], true)
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while library.scan.lock().await.jobs != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let catalog = library.catalog().await.unwrap();
        assert!(!catalog.scanning);
        assert!(catalog.scan_error.is_some());
        fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn native_sources_stream_originals_persist_and_disconnect_without_deleting() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let originals = root.with_extension("originals");
        fs::create_dir_all(originals.join("subfolder"))
            .await
            .unwrap();
        let movie = originals.join("subfolder").join("movie.mp4");
        fs::write(&movie, "0123456789").await.unwrap();
        fs::write(originals.join("notes.txt"), "keep this")
            .await
            .unwrap();
        let library = Library::new(root.clone(), "g".repeat(32), "device")
            .await
            .unwrap();
        library
            .link_paths(vec![originals.clone()], true)
            .await
            .unwrap();
        let catalog = library.catalog().await.unwrap();
        assert_eq!(catalog.items.len(), 1);
        assert_eq!(catalog.sources.len(), 1);
        assert_eq!(catalog.items[0].directory, "subfolder");
        assert_eq!(catalog.items[0].source, "linked");
        assert_eq!(catalog.items[0].source_id, catalog.sources[0].id);
        // App data contains metadata only, never an mp4 copy.
        assert!(!root.join(format!("{}.mp4", catalog.items[0].id)).exists());
        let original_id = catalog.items[0].id.clone();
        fs::write(originals.join("new.mp4"), "new content")
            .await
            .unwrap();
        library.refresh_sources().await;
        let refreshed = library.catalog().await.unwrap();
        assert_eq!(refreshed.items.len(), 2);
        assert!(refreshed.items.iter().any(|item| item.id == original_id));
        library.refresh_sources().await;
        assert_eq!(library.catalog().await.unwrap().items.len(), 2);
        let reopened = Library::new(root.clone(), "h".repeat(32), "device")
            .await
            .unwrap();
        assert_eq!(reopened.catalog().await.unwrap().items.len(), 2);
        let mut headers = HeaderMap::new();
        headers.insert("range", "bytes=2-5".parse().unwrap());
        let response = media(
            State(reopened.clone()),
            Path(("h".repeat(32), catalog.items[0].id.clone())),
            headers,
            Method::GET,
        )
        .await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap(),
            "2345"
        );
        // Missing original stays visible but cannot be played.
        fs::rename(&movie, movie.with_extension("moved"))
            .await
            .unwrap();
        reopened.refresh_sources().await;
        let missing = reopened.catalog().await.unwrap();
        let missing_original = missing
            .items
            .iter()
            .find(|item| item.id == original_id)
            .unwrap();
        assert!(!missing_original.available);
        assert!(missing_original.url.is_empty());
        reopened
            .disconnect_source(&catalog.sources[0].id)
            .await
            .unwrap();
        assert!(reopened.catalog().await.unwrap().items.is_empty());
        assert_eq!(
            fs::read(movie.with_extension("moved")).await.unwrap(),
            b"0123456789"
        );
        assert_eq!(
            fs::read(originals.join("notes.txt")).await.unwrap(),
            b"keep this"
        );
        fs::remove_dir_all(root).await.unwrap();
        fs::remove_dir_all(originals).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn native_folder_does_not_follow_external_symlinks() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let originals = root.with_extension("originals");
        let secret = root.with_extension("secret.mp4");
        fs::create_dir_all(&originals).await.unwrap();
        fs::write(&secret, "private").await.unwrap();
        std::os::unix::fs::symlink(&secret, originals.join("escape.mp4")).unwrap();
        let library = Library::new(root.clone(), "i".repeat(32), "device")
            .await
            .unwrap();
        library
            .link_paths(vec![originals.clone()], true)
            .await
            .unwrap();
        assert!(library.catalog().await.unwrap().items.is_empty());
        fs::remove_dir_all(root).await.unwrap();
        fs::remove_dir_all(originals).await.unwrap();
        fs::remove_file(secret).await.unwrap();
    }

    #[test]
    fn ranges() {
        assert_eq!(byte_range(Some("bytes=2-4"), 10).unwrap(), Some((2, 4)));
        assert_eq!(byte_range(Some("bytes=-3"), 10).unwrap(), Some((7, 9)));
        assert_eq!(byte_range(Some("bytes=8-"), 10).unwrap(), Some((8, 9)));
        assert!(byte_range(Some("bytes=10-"), 10).is_err());
        assert!(byte_range(Some("bytes=1-2,4-5"), 10).is_err());
    }
    #[tokio::test]
    async fn imports_persist_and_reject_paths() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let l = Library::new(root.clone(), "a".repeat(32), "device")
            .await
            .unwrap();
        assert!(
            import_inner(&l, &"b".repeat(32), "a.mp4", Body::from("123"))
                .await
                .is_err()
        );
        assert!(
            import_inner(&l, &"a".repeat(32), "../a.mp4", Body::from("123"))
                .await
                .is_err()
        );
        let catalog = import_inner(&l, &"a".repeat(32), "cartoon.mp4", Body::from("12345"))
            .await
            .unwrap();
        assert_eq!(catalog.items.len(), 1);
        assert_eq!(catalog.items[0].size, 5);
        let reopened = Library::new(root.clone(), "a".repeat(32), "device")
            .await
            .unwrap();
        assert_eq!(reopened.catalog().await.unwrap().items.len(), 1);
        fs::remove_dir_all(root).await.unwrap();
    }
    #[tokio::test]
    async fn http_upload_range_head_delete_and_preflight() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let l = Library::new(root.clone(), "c".repeat(32), "device")
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let base = format!("{origin}{}", l.endpoint());
        let task = tokio::spawn(async move { axum::serve(listener, l.routes()).await.unwrap() });
        let client = reqwest::Client::new();
        assert_eq!(
            client
                .get(format!("{origin}/offline-media/{}", "x".repeat(32)))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        let upload = client
            .post(format!("{base}/import?name=test.mp4"))
            .body("0123456789")
            .send()
            .await
            .unwrap();
        assert_eq!(upload.status(), StatusCode::OK);
        let catalog: serde_json::Value = upload.json().await.unwrap();
        let url = format!("{origin}{}", catalog["items"][0]["url"].as_str().unwrap());
        let range = client
            .get(&url)
            .header("Range", "bytes=2-5")
            .send()
            .await
            .unwrap();
        assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(range.headers()["content-range"], "bytes 2-5/10");
        assert_eq!(range.bytes().await.unwrap(), "2345");
        let invalid = client
            .get(&url)
            .header("Range", "bytes=20-")
            .send()
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(invalid.headers()["content-range"], "bytes */10");
        let head = client.head(&url).send().await.unwrap();
        assert_eq!(head.headers()["content-length"], "10");
        assert!(head.bytes().await.unwrap().is_empty());
        let options = client
            .request(reqwest::Method::OPTIONS, &url)
            .send()
            .await
            .unwrap();
        assert_eq!(options.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            client.delete(&url).send().await.unwrap().status(),
            StatusCode::OK
        );
        assert_eq!(
            client.get(&url).send().await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        task.abort();
        fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn media_body_reads_on_demand_and_rejects_old_reads_after_standby() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let background = crate::background_work::BackgroundWork::default();
        let library = Library::new(root.clone(), "b".repeat(32), "device")
            .await
            .unwrap()
            .with_background(background.clone());
        let payload = vec![b'a'; 128 * 1024];
        let catalog = import_inner(&library, &library.token, "movie.mp4", Body::from(payload))
            .await
            .unwrap();
        let id = catalog.items[0].id.clone();
        let response = media(
            State(library.clone()),
            Path((library.token.clone(), id.clone())),
            HeaderMap::new(),
            Method::GET,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-length"], "131072");
        let mut body = response.into_body().into_data_stream();
        assert_eq!(body.next().await.unwrap().unwrap(), vec![b'a'; 64 * 1024]);
        // Changing the unread half proves the stream has not prefetched it.
        let path = library
            .path(&library.record(&id).await.unwrap())
            .await
            .unwrap();
        fs::write(&path, vec![b'b'; 128 * 1024]).await.unwrap();
        assert_eq!(body.next().await.unwrap().unwrap(), vec![b'b'; 64 * 1024]);
        assert!(body.next().await.is_none());
        drop(body);
        wait_for_drain(&background).await;

        let response = media(
            State(library.clone()),
            Path((library.token.clone(), id.clone())),
            HeaderMap::new(),
            Method::GET,
        )
        .await;
        let mut body = response.into_body().into_data_stream();
        assert_eq!(body.next().await.unwrap().unwrap().len(), 64 * 1024);
        background.set_standby(true);
        background.set_standby(false);
        assert!(body.next().await.unwrap().is_err());
        drop(body);
        wait_for_drain(&background).await;
        assert!(!background.status().standby);

        let response = media(
            State(library.clone()),
            Path((library.token.clone(), id)),
            HeaderMap::new(),
            Method::GET,
        )
        .await;
        let mut body = response.into_body().into_data_stream();
        assert_eq!(body.next().await.unwrap().unwrap().len(), 64 * 1024);
        assert_eq!(background.status().pending, 1);
        drop(body); // A disconnected consumer must release the idle stream.
        wait_for_drain(&background).await;
        fs::remove_dir_all(root).await.unwrap();
    }
    #[tokio::test]
    async fn cancelled_upload_removes_partial_file() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let l = Library::new(root.clone(), "d".repeat(32), "device")
            .await
            .unwrap();
        let body = Body::from_stream(
            stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from_static(
                b"partial",
            ))])
            .chain(stream::pending()),
        );
        let task =
            tokio::spawn(async move { import_inner(&l, &"d".repeat(32), "test.mp4", body).await });
        let mut started = false;
        for _ in 0..100 {
            if fs::read_dir(&root)
                .await
                .unwrap()
                .next_entry()
                .await
                .unwrap()
                .is_some()
            {
                started = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(started);
        task.abort();
        let _ = task.await;
        let mut clean = false;
        for _ in 0..100 {
            if fs::read_dir(&root)
                .await
                .unwrap()
                .next_entry()
                .await
                .unwrap()
                .is_none()
            {
                clean = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(clean);
        fs::remove_dir_all(root).await.unwrap();
    }
    #[tokio::test]
    async fn rejects_unsafe_tokens_and_path_ids() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        assert!(Library::new(root.clone(), "short".into(), "device")
            .await
            .is_err());
        assert!(Library::new(root.clone(), "a/".repeat(32), "device")
            .await
            .is_err());
        let l = Library::new(root.clone(), "e".repeat(32), "device")
            .await
            .unwrap();
        assert!(l.authorize(&"e".repeat(31)).is_err());
        assert!(l.authorize(&format!("{}x", "e".repeat(32))).is_err());
        let result = media(
            State(l),
            Path(("e".repeat(32), "../private".into())),
            HeaderMap::new(),
            Method::GET,
        )
        .await;
        assert_eq!(result.status(), StatusCode::NOT_FOUND);
        fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn request_ids_cannot_escape_library_or_delete_originals() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let outside = root.with_extension("mp4");
        fs::write(&outside, "original outside library")
            .await
            .unwrap();
        let token = "j".repeat(32);
        let library = Library::new(root.clone(), token.clone(), "device")
            .await
            .unwrap();
        let saved = import_inner(&library, &token, "saved.mp4", Body::from("saved media"))
            .await
            .unwrap();
        let saved_id = saved.items[0].id.clone();
        for id in [
            "../outside",
            "..\\outside",
            "/tmp/outside",
            "C:\\outside",
            "%2e%2e%2foutside",
            "0123456789abcdef0123456789abcde/..",
            "gggggggggggggggggggggggggggggggg",
            "",
        ] {
            let response =
                remove(State(library.clone()), Path((token.clone(), id.to_owned()))).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "id={id}");
            assert!(library.disconnect_source(id).await.is_err(), "id={id}");
        }
        assert_eq!(
            fs::read(&outside).await.unwrap(),
            b"original outside library"
        );
        assert_eq!(library.catalog().await.unwrap().items[0].id, saved_id);
        fs::remove_dir_all(root).await.unwrap();
        fs::remove_file(outside).await.unwrap();
    }

    #[tokio::test]
    async fn generated_media_boundary_rejects_unvalidated_records_and_keeps_picked_originals() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let library = Library::new(root.join("library"), "k".repeat(32), "device")
            .await
            .unwrap();
        let id = "a".repeat(32);
        let managed = library.root.join(format!("{id}.mp4"));
        fs::write(&managed, b"managed").await.unwrap();
        let original = root.join("outside.mp4");
        fs::write(&original, b"picked original").await.unwrap();
        let original = fs::canonicalize(original).await.unwrap();
        let good = Record {
            id: id.clone(),
            name: "movie.mp4".into(),
            size: 7,
            mime: "video/mp4".into(),
            extension: "mp4".into(),
            linked_path: None,
            source_id: None,
        };
        assert_eq!(library.path(&good).await.unwrap(), managed);
        // These direct callers deliberately bypass read_record/read_records,
        // proving the generated-file boundary validates its own input.
        for bad_id in [
            "../outside".into(),
            "..\\outside".into(),
            original.to_string_lossy().into_owned(),
            "a".repeat(31),
        ] {
            let mut bad = good.clone();
            bad.id = bad_id;
            assert!(library.path(&bad).await.is_err());
        }
        for bad_extension in ["../mp4", "mp4/../../outside", "..\\mp4", "", "json"] {
            let mut bad = good.clone();
            bad.extension = bad_extension.into();
            assert!(library.path(&bad).await.is_err());
        }
        let mut bad_mime = good.clone();
        bad_mime.mime = "text/plain".into();
        assert!(library.path(&bad_mime).await.is_err());
        let mut picked = good;
        picked.linked_path = Some(original.clone());
        let work = library.background.enter().unwrap();
        assert_eq!(
            owned_read(&work, |owner| async move {
                library.read_path(&picked, Some(&owner)).await
            })
            .await
            .unwrap(),
            original
        );
        assert_eq!(fs::read(&original).await.unwrap(), b"picked original");
        assert_eq!(fs::read(&managed).await.unwrap(), b"managed");
        fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn malformed_metadata_cannot_introduce_path_components() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let library = Library::new(root.clone(), "k".repeat(32), "device")
            .await
            .unwrap();
        for (index, (id, extension)) in [
            ("../outside", "mp4"),
            ("0123456789abcdef0123456789abcdef", "../../outside.mp4"),
            ("0123456789abcdef0123456789abcdef", "mp4/../../outside"),
        ]
        .into_iter()
        .enumerate()
        {
            let record = Record {
                id: id.into(),
                name: "Untrusted metadata".into(),
                size: 1,
                mime: "video/mp4".into(),
                extension: extension.into(),
                linked_path: None,
                source_id: None,
            };
            fs::write(
                root.join(format!("malformed-{index}.json")),
                serde_json::to_vec(&record).unwrap(),
            )
            .await
            .unwrap();
        }
        assert!(library.catalog().await.unwrap().items.is_empty());
        fs::remove_dir_all(root).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn folder_scan_skips_unreadable_children_and_retains_refreshable_source() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let originals = root.join("originals");
        let denied = originals.join("denied");
        fs::create_dir_all(&denied).await.unwrap();
        fs::write(originals.join("good.mp4"), b"movie")
            .await
            .unwrap();
        fs::write(denied.join("hidden.mp4"), b"movie")
            .await
            .unwrap();
        fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o000))
            .await
            .unwrap();
        let permission_is_enforced = fs::read_dir(&denied).await.is_err();
        let library = Library::new(root.join("library"), "k".repeat(32), "device")
            .await
            .unwrap();
        let result = library.link_paths(vec![originals.clone()], true).await;
        fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
        result.unwrap();
        let sources = library.source_records().await.unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].kind, "folder");
        let records = library
            .records(&library.background.enter().unwrap())
            .await
            .unwrap();
        assert!(records.iter().any(|record| record.name == "good.mp4"));
        if permission_is_enforced {
            assert!(!records.iter().any(|record| record.name == "hidden.mp4"));
        }
        library.refresh_sources().await;
        assert!(library
            .records(&library.background.enter().unwrap())
            .await
            .unwrap()
            .iter()
            .any(|record| record.name == "hidden.mp4"));
        fs::remove_dir_all(root).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_selected_root_fails_without_creating_source() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let originals = root.join("originals");
        fs::create_dir_all(&originals).await.unwrap();
        let library = Library::new(root.join("library"), "k".repeat(32), "device")
            .await
            .unwrap();
        fs::set_permissions(&originals, std::fs::Permissions::from_mode(0o000))
            .await
            .unwrap();
        let permission_is_enforced = fs::read_dir(&originals).await.is_err();
        let result = library.link_paths(vec![originals.clone()], true).await;
        fs::set_permissions(&originals, std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
        if permission_is_enforced {
            assert!(result.is_err());
            assert!(library.source_records().await.unwrap().is_empty());
        }
        fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn server_cannot_link_a_filesystem_source() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let library = Library::new(root.clone(), "l".repeat(32), "server")
            .await
            .unwrap();
        assert!(library.link_paths(vec![root.clone()], true).await.is_err());
        assert!(!library.catalog().await.unwrap().direct_sources);
        assert!(library.catalog().await.unwrap().items.is_empty());
        fs::remove_dir_all(root).await.unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn never_serves_symlinked_media_or_metadata() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let outside = root.with_extension("private");
        let l = Library::new(root.clone(), "f".repeat(32), "device")
            .await
            .unwrap();
        let catalog = import_inner(&l, &"f".repeat(32), "movie.mp4", Body::from("movie"))
            .await
            .unwrap();
        let id = catalog.items[0].id.clone();
        let path = root.join(format!("{id}.mp4"));
        fs::write(&outside, "private data").await.unwrap();
        fs::remove_file(&path).await.unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(l.catalog().await.unwrap().items.is_empty());
        let result = media(
            State(l.clone()),
            Path(("f".repeat(32), id.clone())),
            HeaderMap::new(),
            Method::GET,
        )
        .await;
        assert_eq!(result.status(), StatusCode::NOT_FOUND);
        fs::remove_file(&path).await.unwrap();
        fs::write(&path, "movie").await.unwrap();
        let metadata = root.join(format!("{id}.json"));
        let saved = fs::read(&metadata).await.unwrap();
        fs::write(&outside, saved).await.unwrap();
        fs::remove_file(&metadata).await.unwrap();
        std::os::unix::fs::symlink(&outside, &metadata).unwrap();
        assert!(l.catalog().await.unwrap().items.is_empty());
        fs::remove_dir_all(root).await.unwrap();
        fs::remove_file(outside).await.unwrap();
    }
}
