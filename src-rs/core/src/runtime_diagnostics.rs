//! Small, value-only native observations. No logs, paths, URLs, or process enumeration.
use serde::Serialize;
use std::{collections::BTreeMap, time::Instant};

const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Tauri,
    Server,
}

pub enum Metric {
    ResidentBytes,
    SystemAvailableBytes,
    SystemTotalBytes,
    LogicalProcessors,
    NativeHlsSessions,
    EpgChannels,
    EpgProgrammes,
    EpgMappings,
    EpgShifts,
}

impl Metric {
    fn key(self) -> &'static str {
        match self {
            Self::ResidentBytes => "residentBytes",
            Self::SystemAvailableBytes => "systemAvailableBytes",
            Self::SystemTotalBytes => "systemTotalBytes",
            Self::LogicalProcessors => "logicalProcessors",
            Self::NativeHlsSessions => "nativeHlsSessions",
            Self::EpgChannels => "epgChannels",
            Self::EpgProgrammes => "epgProgrammes",
            Self::EpgMappings => "epgMappings",
            Self::EpgShifts => "epgShifts",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostics {
    version: u8,
    platform: Platform,
    app_version: Option<String>,
    os_version: Option<String>,
    webview_version: Option<String>,
    metrics: BTreeMap<&'static str, serde_json::Value>,
}

/// Versions are projected as tokens, never arbitrary OS or error descriptions.
pub fn version_token(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.+-".contains(&b)))
    .then(|| value.to_owned())
}

impl RuntimeDiagnostics {
    pub fn collect(platform: Platform, app_version: &str, started: Instant) -> Self {
        let mut result = Self {
            version: 1,
            platform,
            app_version: version_token(app_version),
            os_version: None,
            webview_version: None,
            metrics: BTreeMap::new(),
        };
        result.metrics.insert(
            "uptimeMs",
            (started.elapsed().as_millis().min(MAX_SAFE as u128) as u64).into(),
        );
        if let Ok(count) = std::thread::available_parallelism() {
            result.metric(Metric::LogicalProcessors, count.get() as u64);
        }
        platform_sample(&mut result);
        result
    }

    pub fn metric(&mut self, key: Metric, value: u64) {
        if value <= MAX_SAFE {
            self.metrics.insert(key.key(), value.into());
        }
    }

    /// Main-window focus, not a claim about visibility of a separate WebView process.
    pub fn foreground(&mut self, value: bool) {
        self.metrics.insert("foreground", value.into());
    }

    pub fn webview_version(&mut self, value: &str) {
        self.webview_version = version_token(value);
    }
}

#[cfg(any(target_os = "linux", test))]
fn kilobytes(text: &str, key: &str) -> Option<u64> {
    let mut matches = text.lines().filter_map(|line| line.strip_prefix(key));
    let value = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    let mut words = value.split_whitespace();
    let bytes = words.next()?.parse::<u64>().ok()?.checked_mul(1024)?;
    (words.next()? == "kB" && words.next().is_none() && bytes <= MAX_SAFE).then_some(bytes)
}

#[cfg(target_os = "linux")]
fn read_small(path: &str) -> Option<String> {
    use std::io::Read;
    let mut text = String::new();
    std::fs::File::open(path)
        .ok()?
        .take(65_537)
        .read_to_string(&mut text)
        .ok()?;
    (text.len() <= 65_536).then_some(text)
}

#[cfg(target_os = "linux")]
fn platform_sample(result: &mut RuntimeDiagnostics) {
    if let Some(text) = read_small("/proc/self/status") {
        if let Some(bytes) = kilobytes(&text, "VmRSS:") {
            result.metric(Metric::ResidentBytes, bytes);
        }
    }
    if let Some(text) = read_small("/proc/meminfo") {
        for (field, key) in [
            ("MemTotal:", Metric::SystemTotalBytes),
            ("MemAvailable:", Metric::SystemAvailableBytes),
        ] {
            if let Some(bytes) = kilobytes(&text, field) {
                result.metric(key, bytes);
            }
        }
    }
    result.os_version =
        read_small("/proc/sys/kernel/osrelease").and_then(|value| version_token(value.trim()));
}

#[cfg(target_os = "macos")]
fn platform_sample(result: &mut RuntimeDiagnostics) {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v0>::zeroed();
    // proc_pid_rusage writes to the matching versioned structure for our own process.
    let status = unsafe {
        libc::proc_pid_rusage(
            std::process::id() as libc::pid_t,
            libc::RUSAGE_INFO_V0,
            info.as_mut_ptr().cast(),
        )
    };
    if status == 0 {
        let info = unsafe { info.assume_init() };
        result.metric(Metric::ResidentBytes, info.ri_resident_size);
    }
    let mut total = 0u64;
    let mut size = std::mem::size_of_val(&total);
    // Both sysctl names are constants; no filesystem paths or machine names are read.
    let status = unsafe {
        libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&mut total as *mut u64).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if status == 0 && size == std::mem::size_of_val(&total) {
        result.metric(Metric::SystemTotalBytes, total);
    }
    let mut version = [0u8; 65];
    let mut size = version.len();
    let status = unsafe {
        libc::sysctlbyname(
            c"kern.osproductversion".as_ptr(),
            version.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if status == 0 && size > 0 && size <= version.len() && version[size - 1] == 0 {
        result.os_version = std::str::from_utf8(&version[..size - 1])
            .ok()
            .and_then(version_token);
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn platform_sample(_: &mut RuntimeDiagnostics) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_versions_and_metrics_never_accept_arbitrary_text_or_unsafe_numbers() {
        for bad in [
            "",
            "Mac OS 15",
            "https://secret.invalid",
            "token=secret",
            "a\n",
        ] {
            assert!(version_token(bad).is_none());
        }
        assert!(version_token(&"a".repeat(65)).is_none());
        assert_eq!(
            version_token("1.2.3-rc+sha_4"),
            Some("1.2.3-rc+sha_4".into())
        );
        let mut snapshot = RuntimeDiagnostics::collect(Platform::Tauri, "1.2.3", Instant::now());
        snapshot.metric(Metric::EpgChannels, MAX_SAFE + 1);
        snapshot.foreground(false);
        snapshot.webview_version("unsafe version");
        let value = serde_json::to_value(snapshot).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 6);
        assert_eq!(value["platform"], "tauri");
        assert_eq!(value["version"], 1);
        assert_eq!(value["appVersion"], "1.2.3");
        assert!(value["webviewVersion"].is_null());
        assert!(value["metrics"].get("epgChannels").is_none());
        assert_eq!(value["metrics"]["foreground"], false);
        for (key, value) in value["metrics"].as_object().unwrap() {
            assert!(
                value.is_boolean() || value.as_u64().is_some_and(|n| n <= MAX_SAFE),
                "{key}"
            );
        }
    }

    #[test]
    fn runtime_memory_parser_requires_exact_units_and_bounds() {
        assert_eq!(
            kilobytes("Name:\tprivate\nVmRSS:\t42 kB\n", "VmRSS:"),
            Some(43_008)
        );
        for text in [
            "VmRSS: 1 MB",
            "VmRSS: -1 kB",
            "VmRSS: 1 kB extra",
            "VmRSS: 1 kB\nVmRSS: 2 kB",
            "VmRSS: 18446744073709551615 kB",
            "other: 1 kB",
        ] {
            assert_eq!(kilobytes(text, "VmRSS:"), None, "{text}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn runtime_macos_reports_actual_self_resident_memory() {
        let value = serde_json::to_value(RuntimeDiagnostics::collect(
            Platform::Server,
            "1.0.0",
            Instant::now(),
        ))
        .unwrap();
        let resident = value["metrics"]["residentBytes"].as_u64().unwrap();
        let total = value["metrics"]["systemTotalBytes"].as_u64().unwrap();
        assert!(resident > 0 && resident <= total);
    }
}
