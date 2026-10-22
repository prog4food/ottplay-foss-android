//! Bounded DNS-SD discovery through the operating system's resolver.
//!
//! Apple uses DNSServiceQueryRecord (including supplemental/split DNS), Windows
//! uses DnsQuery, and Linux uses libc's resolver (including a configured local
//! systemd-resolved stub). No alternate/public resolver is used. Search domains
//! come from System Configuration, Windows DNS registry settings, or resolv.conf.
//! Unsupported hosts and absent/invalid DNS records produce an empty list.
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{Arc, LazyLock},
    time::Duration,
};
use tokio::{
    sync::{Mutex, Semaphore},
    task::JoinSet,
    time::{timeout_at, Instant},
};

mod search_domains;

const SERVICE: &str = "_ottplay-ctrl._tcp";
const PTR: u16 = 12;
const TXT: u16 = 16;
const SRV: u16 = 33;
const MAX_DOMAINS: usize = 16;
const MAX_SERVERS: usize = 8;
const DEADLINE: Duration = Duration::from_secs(3);
const CACHE_TIME: Duration = Duration::from_secs(5);
// Native calls cannot be cancelled on every OS. A permit stays with the worker
// after its caller times out, so a broken resolver cannot accumulate threads.
static WORKERS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(32)));
static CACHE: LazyLock<Mutex<Option<(Instant, Discovery)>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ControlServer {
    pub id: String,
    pub domain: String,
    pub address: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Discovery {
    pub version: u8,
    pub servers: Vec<ControlServer>,
}

impl Default for Discovery {
    fn default() -> Self {
        Self {
            version: 1,
            servers: Vec::new(),
        }
    }
}

/// The deadline includes waiting for a concurrent discovery. Results are kept
/// for at most five seconds (and never longer than the DNS TTL).
pub async fn discover_control_servers() -> Discovery {
    let started = Instant::now();
    let deadline = started + DEADLINE;
    let Ok(mut cache) = timeout_at(deadline, CACHE.lock()).await else {
        return Discovery::default();
    };
    if let Some((until, result)) = cache.as_ref() {
        if *until > Instant::now() {
            return result.clone();
        }
    }
    let domains = blocking(deadline, search_domains::read)
        .await
        .unwrap_or_default();
    let (result, ttl) = discover(domains, deadline, native_lookup).await;
    *cache = Some((
        Instant::now() + ttl.min(CACHE_TIME).saturating_sub(started.elapsed()),
        result.clone(),
    ));
    result
}

async fn blocking<T: Send + 'static>(
    deadline: Instant,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    if Instant::now() >= deadline {
        return None;
    }
    let permit = timeout_at(deadline, WORKERS.clone().acquire_owned())
        .await
        .ok()?
        .ok()?;
    if Instant::now() >= deadline {
        return None;
    }
    timeout_at(
        deadline,
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            work()
        }),
    )
    .await
    .ok()?
    .ok()
}

#[derive(Clone)]
struct Record {
    data: Vec<u8>,
    ttl: Duration,
}

async fn native_lookup(name: String, kind: u16, deadline: Instant) -> Vec<Record> {
    blocking(deadline, move || {
        system_resolver::lookup(&name, kind)
            .unwrap_or_default()
            .into_iter()
            .filter(|r| {
                r.rtype == kind
                    && r.class == 1
                    && r.name.eq_ignore_ascii_case(name.trim_end_matches('.'))
            })
            .take(64)
            .filter(|r| r.rdata.len() <= 2048)
            .map(|r| Record {
                data: r.rdata,
                ttl: r.ttl,
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

async fn discover<F, Fut>(
    domains: Vec<String>,
    deadline: Instant,
    lookup: F,
) -> (Discovery, Duration)
where
    F: Fn(String, u16, Instant) -> Fut + Clone + Send + 'static,
    Fut: std::future::Future<Output = Vec<Record>> + Send,
{
    let mut tasks = JoinSet::new();
    let mut domains_seen = std::collections::HashSet::new();
    for domain in domains
        .into_iter()
        .filter_map(|d| canonical_host(&d))
        .filter(|d| domains_seen.insert(d.clone()))
        .take(MAX_DOMAINS)
    {
        let lookup = lookup.clone();
        tasks.spawn(async move {
            let owner = format!("{SERVICE}.{domain}.");
            let records = lookup(owner.clone(), PTR, deadline).await;
            (domain, owner, records)
        });
    }
    let mut resolving = JoinSet::new();
    let mut instances = std::collections::HashSet::new();
    // Start resolving each completed domain immediately; one slow DNS search
    // domain must not consume the budget of another, working LAN domain.
    while let Ok(Some(joined)) = timeout_at(deadline, tasks.join_next()).await {
        let Ok((domain, owner, records)) = joined else {
            continue;
        };
        for ptr in records {
            let Some(instance) = instance_name(&ptr.data, &owner) else {
                continue;
            };
            if instances.len() >= MAX_SERVERS || !instances.insert(instance.clone()) {
                continue;
            }
            let lookup = lookup.clone();
            let domain = domain.clone();
            resolving.spawn(async move {
                let (srv, txt) = tokio::join!(
                    lookup(instance.clone(), SRV, deadline),
                    lookup(instance.clone(), TXT, deadline)
                );
                server(&instance, &domain, ptr.ttl, &srv, &txt)
            });
        }
    }
    tasks.abort_all();
    let mut result = Discovery::default();
    let mut ttl = CACHE_TIME;
    // Futures already complete remain available at the deadline; unfinished
    // native work is detached behind the fixed worker limit above.
    while let Ok(Some(joined)) = timeout_at(deadline, resolving.join_next()).await {
        if let Ok(Some((item, lifetime))) = joined {
            result.servers.push(item);
            ttl = ttl.min(lifetime);
        }
    }
    result.servers.sort_by(|a, b| a.id.cmp(&b.id));
    (result, ttl)
}

fn canonical_host(value: &str) -> Option<String> {
    let value = value.strip_suffix('.').unwrap_or(value);
    if value.is_empty()
        || value.len() > 253
        || value.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

// RDATA names returned by system-resolver are expanded. Reject compression,
// arbitrary escapes and non-ASCII instance labels so IDs have one canonical
// representation on the player and control server.
fn wire_name(data: &[u8]) -> Option<String> {
    if data.len() > 255 {
        return None;
    }
    let mut pos = 0;
    let mut labels = Vec::new();
    loop {
        let size = *data.get(pos)? as usize;
        pos += 1;
        if size == 0 {
            return (pos == data.len() && !labels.is_empty())
                .then(|| format!("{}.", labels.join(".")));
        }
        if size > 63 {
            return None;
        }
        let label = data.get(pos..pos + size)?;
        if !label
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return None;
        }
        labels.push(std::str::from_utf8(label).ok()?.to_ascii_lowercase());
        pos += size;
    }
}

fn instance_name(data: &[u8], owner: &str) -> Option<String> {
    let name = wire_name(data)?;
    let label = name.strip_suffix(&format!(".{owner}"))?;
    // The instance must be one label under the exact queried service/domain.
    if label.contains('.') || canonical_host(label).is_none() {
        return None;
    }
    Some(name)
}

fn server(
    id: &str,
    domain: &str,
    ptr_ttl: Duration,
    srv: &[Record],
    txt: &[Record],
) -> Option<(ControlServer, Duration)> {
    // One instance is one pairing endpoint. Ambiguous SRV/TXT answers must not
    // silently choose a different server or combine inconsistent metadata.
    if srv.len() != 1 || txt.len() != 1 {
        return None;
    }
    let srv = &srv[0];
    let txt = &txt[0];
    if srv.data.len() < 7 {
        return None;
    }
    let port = u16::from_be_bytes([srv.data[4], srv.data[5]]);
    if port == 0 {
        return None;
    }
    let host = canonical_host(&wire_name(&srv.data[6..])?)?;
    let values = txt_values(&txt.data)?;
    if values.len() != 3 || values.get("txtvers")? != "1" || values.get("scheme")? != "https" {
        return None;
    }
    let path = base_path(values.get("path")?)?;
    let authority = if port == 443 {
        host
    } else {
        format!("{host}:{port}")
    };
    Some((
        ControlServer {
            id: id.into(),
            domain: domain.into(),
            address: format!("https://{authority}{path}"),
        },
        ptr_ttl.min(srv.ttl).min(txt.ttl),
    ))
}

fn base_path(path: &str) -> Option<&str> {
    if !path.starts_with('/') {
        return None;
    }
    let normalized = path.strip_suffix('/').unwrap_or(path);
    if normalized.is_empty() {
        return Some(normalized);
    }
    if normalized.split('/').skip(1).any(|part| {
        part.is_empty()
            || part == "."
            || part == ".."
            || !part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-'))
    }) {
        return None;
    }
    Some(normalized)
}

fn txt_values(data: &[u8]) -> Option<BTreeMap<String, String>> {
    if data.len() > 2048 {
        return None;
    }
    let mut values = BTreeMap::new();
    let mut pos = 0;
    let mut text_size = 0;
    while pos < data.len() {
        let size = data[pos] as usize;
        pos += 1;
        let text = std::str::from_utf8(data.get(pos..pos + size)?).ok()?;
        let (key, value) = text.split_once('=')?;
        text_size += size;
        if text_size > 1024 || !matches!(key, "txtvers" | "scheme" | "path") {
            return None;
        }
        if values.insert(key.to_string(), value.to_string()).is_some() {
            return None;
        }
        pos += size;
    }
    Some(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn name(value: &str) -> Vec<u8> {
        let mut result = Vec::new();
        for label in value.trim_end_matches('.').split('.') {
            result.push(label.len() as u8);
            result.extend_from_slice(label.as_bytes());
        }
        result.push(0);
        result
    }

    fn txt(fields: &[&str]) -> Record {
        let mut data = Vec::new();
        for field in fields {
            data.push(field.len() as u8);
            data.extend_from_slice(field.as_bytes());
        }
        Record {
            data,
            ttl: Duration::from_secs(60),
        }
    }

    fn srv(host: &str, port: u16) -> Record {
        let mut data = vec![0, 0, 0, 0];
        data.extend(port.to_be_bytes());
        data.extend(name(host));
        Record {
            data,
            ttl: Duration::from_secs(30),
        }
    }

    fn metadata() -> Record {
        txt(&["txtvers=1", "scheme=https", "path=/ott-control"])
    }

    #[test]
    fn validates_https_metadata_and_canonical_port() {
        let (value, ttl) = server(
            "home._ottplay-ctrl._tcp.lab.test.",
            "lab.test",
            Duration::from_secs(2),
            &[srv("CONTROL.lab.test", 443)],
            &[metadata()],
        )
        .unwrap();
        assert_eq!(value.address, "https://control.lab.test/ott-control");
        assert_eq!(ttl, Duration::from_secs(2));
        assert_eq!(
            server(
                "id",
                "lab.test",
                CACHE_TIME,
                &[srv("host.lab.test", 9443)],
                &[metadata()]
            )
            .unwrap()
            .0
            .address,
            "https://host.lab.test:9443/ott-control"
        );
        for fields in [
            vec!["txtvers=2", "scheme=https", "path=/ott-control"],
            vec!["txtvers=1", "scheme=http", "path=/ott-control"],
            vec!["txtvers=1", "scheme=https", "path=//evil.test"],
            vec![
                "txtvers=1",
                "scheme=https",
                "path=/ott-control?token=secret",
            ],
            vec![
                "txtvers=1",
                "scheme=https",
                "path=/ott-control",
                "SCHEME=http",
            ],
        ] {
            assert!(server(
                "id",
                "lab.test",
                CACHE_TIME,
                &[srv("host.lab.test", 443)],
                &[txt(&fields)]
            )
            .is_none());
        }
        assert!(server(
            "id",
            "lab.test",
            CACHE_TIME,
            &[srv("user@host.test", 443)],
            &[metadata()]
        )
        .is_none());
        assert!(server(
            "id",
            "lab.test",
            CACHE_TIME,
            &[srv("host.test", 0)],
            &[metadata()]
        )
        .is_none());
        assert!(server(
            "id",
            "lab.test",
            CACHE_TIME,
            &[srv("host.test", 443), srv("other.test", 443)],
            &[metadata()]
        )
        .is_none());
        assert!(server(
            "id",
            "lab.test",
            CACHE_TIME,
            &[srv("host.test", 443)],
            &[metadata(), metadata()]
        )
        .is_none());
    }

    #[test]
    fn rejects_truncated_and_unbounded_dns_names_and_txt() {
        for value in [
            &[0xc0, 0x10][..],
            &[64, b'a', 0],
            &[1, b'a'],
            &[1, b'a', 0, 0],
            &[0],
        ] {
            assert!(wire_name(value).is_none());
        }
        assert!(wire_name(&name(&format!("{}.test", "a".repeat(64)))).is_none());
        assert!(txt_values(&[4, b'a']).is_none());
        assert!(txt_values(&vec![0; 2049]).is_none());
        assert!(canonical_host("bad.test..").is_none());
        assert!(canonical_host("-bad.test").is_none());
        assert_eq!(
            instance_name(
                &name("HOME._ottplay-ctrl._tcp.LAB.TEST."),
                "_ottplay-ctrl._tcp.lab.test."
            ),
            Some("home._ottplay-ctrl._tcp.lab.test.".into())
        );
        assert!(instance_name(
            &name("home._ottplay-ctrl._tcp.other.test"),
            "_ottplay-ctrl._tcp.lab.test."
        )
        .is_none());
        assert!(instance_name(
            &name("two.labels._ottplay-ctrl._tcp.lab.test"),
            "_ottplay-ctrl._tcp.lab.test."
        )
        .is_none());
    }

    #[test]
    fn descriptor_validation_matches_control_server_contract() {
        for (path, expected) in [
            ("/", ""),
            ("/remote", "/remote"),
            ("/a/b/", "/a/b"),
            ("/a._~-9", "/a._~-9"),
        ] {
            let text = txt(&["txtvers=1", "scheme=https", &format!("path={path}")]);
            let result = server(
                "id",
                "lab.test",
                CACHE_TIME,
                &[srv("host.lab.test", 443)],
                &[text],
            )
            .unwrap();
            assert_eq!(result.0.address, format!("https://host.lab.test{expected}"));
        }
        for path in [
            "", "relative", "//", "/a//b", "/a//", "/.", "/a/../b", "/a?b", "/a#b", "/a%b",
            "/a\\b", "/a b", "/a:b",
        ] {
            assert!(base_path(path).is_none(), "accepted {path:?}");
        }
        for fields in [
            vec!["TXTVERS=1", "scheme=https", "path=/"],
            vec!["txtvers=1", "scheme=https", "path=/", "other=value"],
            vec!["txtvers=1", "scheme=https", "path=/", "path=/remote"],
        ] {
            assert!(txt_values(&txt(&fields).data).is_none());
        }
        for label in ["_home", "-home", "home-", "two.labels"] {
            assert!(instance_name(
                &name(&format!("{label}._ottplay-ctrl._tcp.lab.test")),
                "_ottplay-ctrl._tcp.lab.test."
            )
            .is_none());
        }
    }

    fn fixture() -> Arc<HashMap<(String, u16), Vec<Record>>> {
        let mut records = HashMap::new();
        let ids = [
            "b._ottplay-ctrl._tcp.lab.test.",
            "a._ottplay-ctrl._tcp.lab.test.",
        ];
        records.insert(
            ("_ottplay-ctrl._tcp.lab.test.".into(), PTR),
            ids.iter()
                .map(|id| Record {
                    data: name(id),
                    ttl: CACHE_TIME,
                })
                .collect(),
        );
        for id in ids {
            records.insert((id.into(), SRV), vec![srv("host.lab.test", 443)]);
            records.insert((id.into(), TXT), vec![metadata()]);
        }
        Arc::new(records)
    }

    #[tokio::test]
    async fn multiple_servers_are_sorted_and_duplicate_domains_do_not_duplicate_results() {
        let records = fixture();
        let (result, _) = discover(
            vec!["LAB.TEST.".into(), "lab.test".into(), "invalid/name".into()],
            Instant::now() + DEADLINE,
            move |name, kind, _| {
                let records = records.clone();
                async move { records.get(&(name, kind)).cloned().unwrap_or_default() }
            },
        )
        .await;
        assert_eq!(result.servers.len(), 2);
        assert_eq!(result.servers[0].id, "a._ottplay-ctrl._tcp.lab.test.");
        assert_eq!(result.servers[1].id, "b._ottplay-ctrl._tcp.lab.test.");
        assert_eq!(serde_json::to_value(result).unwrap()["version"], 1);
    }

    #[tokio::test]
    async fn slow_domain_does_not_hide_completed_lan_results_or_exceed_budget() {
        let records = fixture();
        let start = Instant::now();
        let (result, _) = discover(
            vec!["slow.test".into(), "lab.test".into()],
            start + Duration::from_millis(50),
            move |name, kind, _| {
                let records = records.clone();
                async move {
                    if name.contains("slow") {
                        tokio::time::sleep(Duration::from_secs(20)).await;
                    }
                    records.get(&(name, kind)).cloned().unwrap_or_default()
                }
            },
        )
        .await;
        assert!(start.elapsed() < Duration::from_millis(500));
        assert_eq!(result.servers.len(), 2);
    }

    #[tokio::test]
    async fn native_worker_wait_is_bounded_even_when_os_call_is_not_cancellable() {
        let start = Instant::now();
        let value = blocking(start + Duration::from_millis(20), || {
            std::thread::sleep(Duration::from_millis(100));
            true
        })
        .await;
        assert!(value.is_none());
        assert!(start.elapsed() < Duration::from_millis(90));
    }

    #[tokio::test]
    async fn expired_budget_does_not_start_native_work() {
        assert_eq!(
            blocking(Instant::now() - Duration::from_secs(1), || panic!(
                "expired query was started"
            ))
            .await,
            None::<()>
        );
    }

    #[tokio::test]
    #[ignore = "reads real system DNS; run manually after configuring a test DNS-SD service"]
    async fn system_dns_discovery() {
        let start = Instant::now();
        let result = discover_control_servers().await;
        println!("{}", serde_json::to_string(&result).unwrap());
        assert!(start.elapsed() < Duration::from_millis(3500));
    }
}
