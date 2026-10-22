//! Immutable pre-migration outcomes exercised through the public shipping API.
//! Every case gets a child process so DATABASE_URL never races with other tests.
use ottplay_core::{db, xmltv};
use serde_json::{json, Map, Value};
use sqlx::Row;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

fn epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn sources(input: &Value, key: &str) -> Vec<String> {
    input[key]
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|row| row.as_str().unwrap().to_owned())
                .collect()
        })
        .unwrap_or_default()
}
fn payload(cache: &xmltv::XmltvCache) -> Value {
    let channels: Map<String, Value> = cache
        .channels
        .iter()
        .map(|(id, row)| {
            (
                id.clone(),
                json!({"id": row.id, "name": row.name, "names": row.names, "icon": row.icon}),
            )
        })
        .collect();
    let programmes: Map<String, Value> = cache.programs.iter().map(|(id, rows)| (id.clone(),
        Value::Array(rows.iter().map(|row| json!({"start": row.start, "stop": row.stop, "title": row.title, "desc": row.desc, "icon": row.icon})).collect()))).collect();
    json!({"channels": channels, "programmes": programmes})
}
fn error(error: anyhow::Error) -> Value {
    json!({"message": error.to_string(), "chain": error.chain().map(ToString::to_string).collect::<Vec<_>>()})
}
async fn database() -> Value {
    let pool = db::pool().await.unwrap().unwrap();
    let channels: Vec<Value> = sqlx::query("SELECT id, name, icon FROM xmltv_channels ORDER BY id")
        .fetch_all(&pool).await.unwrap().iter().map(|row| json!({"id": row.get::<String,_>("id"), "name": row.get::<String,_>("name"), "icon": row.get::<String,_>("icon")})).collect();
    let programmes: Vec<Value> = sqlx::query("SELECT channel_id, start_ts, stop_ts, title, description, icon FROM xmltv_programmes ORDER BY channel_id, start_ts, title")
        .fetch_all(&pool).await.unwrap().iter().map(|row| json!({"channel": row.get::<String,_>("channel_id"), "start": row.get::<i64,_>("start_ts"), "stop": row.get::<i64,_>("stop_ts"), "title": row.get::<String,_>("title"), "description": row.get::<String,_>("description"), "icon": row.get::<String,_>("icon")})).collect();
    pool.close().await;
    json!({"channels": channels, "programmes": programmes})
}
async fn capture(input: Value) -> Value {
    let mut result = json!({});
    let seed_sources = sources(&input, "seedSources");
    if !seed_sources.is_empty() {
        let seed = ottplay_core::fetch_xmltv(&seed_sources).await.unwrap();
        result["seedFetch"] = payload(&seed);
        result["databaseBefore"] = database().await;
    }
    if input["databaseMode"] == "persist-error" {
        let pool = db::pool().await.unwrap().unwrap();
        sqlx::query("CREATE TRIGGER reject_channel_write BEFORE INSERT ON xmltv_channels BEGIN SELECT RAISE(ABORT, 'fixture persist rejected'); END")
            .execute(&pool).await.unwrap();
        pool.close().await;
    }
    let before = epoch();
    let urls = sources(&input, "sources");
    if input["background"] == true {
        let (channels, programs) =
            xmltv::parse_xmltv(input["memorySeedXml"].as_str().unwrap()).unwrap();
        let cache = Arc::new(RwLock::new(xmltv::XmltvCache {
            channels,
            programs,
            fetched_at: 17,
        }));
        result["memoryBefore"] = payload(&*cache.read().await);
        let task = tokio::spawn(ottplay_core::background_refresh(urls, cache.clone()));
        let changed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if cache.read().await.fetched_at != 17 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .is_ok();
        task.abort();
        let _ = task.await;
        let cache = cache.read().await;
        result["firstTickUpdatedMemory"] = json!(changed);
        result["result"] = payload(&cache);
        result["fetchedAtPositive"] = json!(cache.fetched_at > 0);
        result["fetchedAtWithinCallWindow"] =
            json!(before <= cache.fetched_at && cache.fetched_at <= epoch());
    } else {
        match ottplay_core::fetch_xmltv(&urls).await {
            Ok(cache) => {
                result["result"] = payload(&cache);
                result["fetchedAtPositive"] = json!(cache.fetched_at > 0);
                result["fetchedAtWithinCallWindow"] =
                    json!(before <= cache.fetched_at && cache.fetched_at <= epoch());
            }
            Err(failure) => result["error"] = error(failure),
        }
    }
    if input["databaseMode"] == "persist-error" || input["databaseMode"] == "enabled" {
        result["databaseAfter"] = database().await;
    }
    result
}

const CASE_ENV: &str = "OTTPLAY_REFRESH_CONTRACT_CASE";
const ROOT_ENV: &str = "OTTPLAY_REFRESH_CONTRACT_ROOT";

struct TemporaryDirectory(std::path::PathBuf);
impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn saved_refresh_contracts_match_public_api() {
    verify(
        include_str!("fixtures/xmltv-refresh-before-core.json"),
        20,
        "saved_refresh_contracts_match_public_api",
    );
}

#[test]
fn persistence_boundaries_match_public_api() {
    verify(
        include_str!("fixtures/xmltv-refresh-boundaries-before-core.json"),
        8,
        "persistence_boundaries_match_public_api",
    );
}

// Keep the pre-migration oracle immutable. These named cases deliberately changed
// with shared-core's all-source-failure recovery policy and safe server errors.
// Every other case still compares the complete historical payload unchanged.
fn recovery_expectation(case: &Value) -> Value {
    let mut expected = case["expected"].clone();
    let message = match case["name"].as_str().unwrap() {
        "all failed sources still return fresh empty cache" => {
            expected = json!({});
            Some("source 2: XMLTV parse failed")
        }
        "database connection failure still propagates after all fetches fail" => {
            Some("source 2: XMLTV parse failed")
        }
        "database connection failure propagates after successful fetch"
        | "database connection failure still propagates with no feeds" => {
            Some("EPG database unavailable")
        }
        "background all failed clears memory and persisted cache" => {
            expected["firstTickUpdatedMemory"] = json!(false);
            expected["result"] = expected["memoryBefore"].clone();
            expected["databaseAfter"] = expected["databaseBefore"].clone();
            expected["fetchedAtWithinCallWindow"] = json!(false);
            None
        }
        _ => None,
    };
    if let Some(message) = message {
        expected["error"] = json!({"message": message, "chain": [message]});
    }
    expected
}

fn verify(document: &str, count: usize, test: &str) {
    let fixture: Value = serde_json::from_str(document).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), count);
    if let Ok(index) = std::env::var(CASE_ENV) {
        let index: usize = index.parse().unwrap();
        let directory = std::path::PathBuf::from(std::env::var_os(ROOT_ENV).unwrap());
        let mut input = cases[index].clone();
        for (name, xml) in fixture["feeds"].as_object().unwrap() {
            std::fs::write(directory.join(format!("{name}.xml")), xml.as_str().unwrap()).unwrap();
        }
        for key in ["sources", "seedSources"] {
            input[key] = Value::Array(
                sources(&input, key)
                    .iter()
                    .map(|name| json!(directory.join(format!("{name}.xml"))))
                    .collect(),
            );
        }
        input["memorySeedXml"] = fixture["feeds"]["seed"].clone();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let observed = runtime.block_on(capture(input));
        assert_eq!(
            observed,
            recovery_expectation(&cases[index]),
            "{}",
            cases[index]["name"]
        );
        return;
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "ottplay-refresh-contracts-{}-{test}-{nonce}",
        std::process::id()
    ));
    std::fs::create_dir(&path).unwrap();
    let directory = TemporaryDirectory(path);
    let binary = std::env::current_exe().unwrap();
    for (index, case) in cases.iter().enumerate() {
        let case_directory = directory.0.join(index.to_string());
        std::fs::create_dir(&case_directory).unwrap();
        let mut command = std::process::Command::new(&binary);
        command
            .args(["--exact", test, "--nocapture"])
            .env(CASE_ENV, index.to_string())
            .env(ROOT_ENV, &case_directory)
            .env("DATABASE_URL", "");
        if let Some(mode) = case["databaseMode"].as_str() {
            let filename = if mode == "connection-error" {
                case_directory.join("absent").join("cache.sqlite")
            } else {
                case_directory.join("cache.sqlite")
            };
            // SQLx decodes this filename after stripping the sqlite scheme. A relative
            // filename avoids platform-specific drive/path URL interpretation.
            let filename = filename.strip_prefix(&case_directory).unwrap();
            command.env(
                "DATABASE_URL",
                format!("sqlite://{}?mode=rwc", filename.display()),
            );
        }
        let result = command.current_dir(&case_directory).output().unwrap();
        assert!(
            result.status.success(),
            "{}\nstdout: {}\nstderr: {}",
            case["name"],
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
