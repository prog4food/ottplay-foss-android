//! Select a narrowly qualified app-private playback backport before GTK starts.
//!
//! This never changes the system installation. Missing, updated or customized
//! runtimes keep their existing plugin selection. The package manifest digest is
//! embedded by the reviewed Linux source build, not discovered from a user path.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

const PRIVATE_ROOT: &str = "/usr/lib/ottplay-foss/compat/noble";
const SOURCE_VERSION: &str = "1.24.2-1ubuntu0.5";
const MAX_PLUGIN_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: u32,
    os_id: String,
    os_version: String,
    architecture: String,
    source_package_version: String,
    original_plugin_sha256: String,
    replacement_plugin_sha256: String,
}

fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn host_plugin(architecture: &str) -> Option<&'static str> {
    match architecture {
        "aarch64" => Some("/usr/lib/aarch64-linux-gnu/gstreamer-1.0/libgstplayback.so"),
        "x86_64" => Some("/usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstplayback.so"),
        _ => None,
    }
}

fn known_original(architecture: &str) -> Option<&'static str> {
    match architecture {
        "aarch64" => Some("a5319c096d66691bc2da0a47bce8130473981e7b0ec15d321641f01ed8c93f42"),
        "x86_64" => Some("c116ceccf67edc9d96dc6dfc63eb3bd6c380e2bd215be0c6aaba42d4bda5cb2f"),
        _ => None,
    }
}

fn qualified_os(release: &str) -> bool {
    let mut id = None;
    let mut version = None;
    for line in release.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().trim_matches(['\'', '"']);
        match key.trim() {
            "ID" if id.is_none() => id = Some(value),
            "VERSION_ID" if version.is_none() => version = Some(value),
            "ID" | "VERSION_ID" => return false,
            _ => {}
        }
    }
    id == Some("ubuntu") && version == Some("24.04")
}

fn custom_environment(keys: impl IntoIterator<Item = OsString>) -> bool {
    keys.into_iter().any(|key| {
        let key = key.to_string_lossy();
        key == "LD_LIBRARY_PATH"
            || key == "LD_PRELOAD"
            || key == "APPIMAGE"
            || key == "APPDIR"
            || key.starts_with("GST_PLUGIN_PATH")
            || key.starts_with("GST_PLUGIN_SYSTEM_PATH")
            || key.starts_with("GST_PLUGIN_SCANNER")
            || key.starts_with("GST_REGISTRY")
    })
}

fn qualify(
    manifest: &Manifest,
    architecture: &str,
    host: &str,
    replacement: &str,
) -> Result<(), &'static str> {
    if manifest.schema != 1
        || manifest.os_id != "ubuntu"
        || manifest.os_version != "24.04"
        || manifest.architecture != architecture
        || manifest.source_package_version != SOURCE_VERSION
        || known_original(architecture) != Some(manifest.original_plugin_sha256.as_str())
        || !valid_sha(&manifest.replacement_plugin_sha256)
    {
        return Err("package manifest does not match the qualified runtime");
    }
    if host != manifest.original_plugin_sha256 {
        return Err("system playback plugin differs; retaining system selection");
    }
    if replacement != manifest.replacement_plugin_sha256 {
        return Err("private playback plugin failed its package digest");
    }
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_bounded(path: &Path, maximum: u64) -> io::Result<Vec<u8>> {
    let file = File::open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.len() > maximum {
        return Err(io::Error::other("not a bounded regular file"));
    }
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(io::Error::other("file grew past bound"));
    }
    Ok(bytes)
}

fn trusted_package_file(path: &Path, maximum: u64) -> io::Result<Vec<u8>> {
    if !path.is_absolute() {
        return Err(io::Error::other("relative package path"));
    }
    let mut part = PathBuf::new();
    for component in path.components() {
        if !matches!(component, Component::RootDir | Component::Normal(_)) {
            return Err(io::Error::other("noncanonical package path"));
        }
        part.push(component);
        let metadata = fs::symlink_metadata(&part)?;
        if metadata.file_type().is_symlink() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0
        {
            return Err(io::Error::other("untrusted package path ownership"));
        }
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o022 != 0
        || metadata.len() > maximum
    {
        return Err(io::Error::other("untrusted package file"));
    }
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(io::Error::other("package file grew past bound"));
    }
    Ok(bytes)
}

fn has_user_plugins(home: &Path, data_home: Option<PathBuf>) -> bool {
    let mut locations = vec![
        home.join(".local/share/gstreamer-1.0/plugins"),
        home.join(".gstreamer-1.0/plugins"),
    ];
    if let Some(data) = data_home {
        if !data.is_absolute() {
            return true;
        }
        locations.push(data.join("gstreamer-1.0/plugins"));
    }
    locations
        .into_iter()
        .any(|path| match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(_) => true,
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => true,
            Ok(_) => match fs::read_dir(path) {
                Ok(mut entries) => entries.next().is_some(),
                Err(_) => true,
            },
        })
}

fn private_registry(base: &Path, architecture: &str, replacement: &str) -> io::Result<PathBuf> {
    if !base.is_absolute() || !valid_sha(replacement) || host_plugin(architecture).is_none() {
        return Err(io::Error::other("invalid private registry path"));
    }
    // Called before any application threads exist. This read has no side effects.
    let uid = unsafe { libc::geteuid() };
    let directory = base.join("ottplay-foss/gstreamer-compat");
    let mut part = PathBuf::new();
    for component in directory.components() {
        if !matches!(component, Component::RootDir | Component::Normal(_)) {
            return Err(io::Error::other("noncanonical registry path"));
        }
        part.push(component);
        if !part.exists() {
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            builder.create(&part)?;
        }
        let metadata = fs::symlink_metadata(&part)?;
        let trusted_sticky_parent = metadata.uid() == 0 && metadata.mode() & 0o1000 != 0;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || (metadata.uid() != uid && metadata.uid() != 0)
            || (metadata.mode() & 0o022 != 0 && !trusted_sticky_parent)
        {
            return Err(io::Error::other("untrusted registry directory"));
        }
    }
    let metadata = fs::symlink_metadata(&directory)?;
    if metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err(io::Error::other("registry directory must be private"));
    }
    let registry = directory.join(format!("noble-{architecture}-{replacement}.bin"));
    match fs::symlink_metadata(&registry) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
        Ok(metadata)
            if metadata.is_file() && metadata.uid() == uid && metadata.mode() & 0o022 == 0 => {}
        Ok(_) => return Err(io::Error::other("untrusted registry file")),
    }
    Ok(registry)
}

fn prepare(expected_manifest: Option<&str>) -> Result<(PathBuf, PathBuf), &'static str> {
    let expected = expected_manifest
        .filter(|value| valid_sha(value))
        .ok_or("no packaged compatibility manifest")?;
    if custom_environment(std::env::vars_os().map(|(key, _)| key)) {
        return Err("custom loader or GStreamer paths; retaining configured selection");
    }
    let release = read_bounded(Path::new("/etc/os-release"), 16 * 1024)
        .map_err(|_| "cannot identify operating system")?;
    if !qualified_os(
        std::str::from_utf8(&release).map_err(|_| "invalid operating system metadata")?,
    ) {
        return Err("operating system is outside the qualified Ubuntu 24.04 runtime");
    }
    let architecture = std::env::consts::ARCH;
    let host = host_plugin(architecture).ok_or("architecture is not qualified")?;
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("no absolute home directory")?;
    if has_user_plugins(&home, std::env::var_os("XDG_DATA_HOME").map(PathBuf::from)) {
        return Err("per-user GStreamer plugins; retaining configured selection");
    }
    let root = Path::new(PRIVATE_ROOT);
    let bytes = trusted_package_file(&root.join("runtime-manifest.json"), 16 * 1024)
        .map_err(|_| "private manifest is missing or not root-owned")?;
    if digest(&bytes) != expected {
        return Err("private manifest failed the embedded digest");
    }
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| "invalid private manifest")?;
    let host_digest = digest(
        &trusted_package_file(Path::new(host), MAX_PLUGIN_BYTES)
            .map_err(|_| "system playback plugin is not trusted")?,
    );
    let plugin_directory = root.join("gstreamer-1.0");
    let replacement = digest(
        &trusted_package_file(
            &plugin_directory.join("libgstplayback.so"),
            MAX_PLUGIN_BYTES,
        )
        .map_err(|_| "private playback plugin is not trusted")?,
    );
    qualify(&manifest, architecture, &host_digest, &replacement)?;
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".cache"));
    let registry = private_registry(&cache, architecture, &replacement)
        .map_err(|_| "cannot create a private GStreamer registry")?;
    Ok((plugin_directory, registry))
}

/// Must run at the very start of the native entry point, before any threads or
/// GTK/WebKit initialization. AppImage supplies its own paths and is skipped.
pub fn configure_early() {
    match prepare(option_env!("OTTPLAY_GST_COMPAT_MANIFEST_SHA256")) {
        Ok((plugins, registry)) => {
            std::env::set_var("GST_PLUGIN_PATH_1_0", plugins);
            std::env::set_var("GST_REGISTRY", registry);
            eprintln!("OttPlay media compatibility: selected the verified private Noble playback backport");
        }
        Err(reason) => eprintln!("OttPlay media compatibility: {reason}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        Manifest {
            schema: 1,
            os_id: "ubuntu".into(),
            os_version: "24.04".into(),
            architecture: "aarch64".into(),
            source_package_version: SOURCE_VERSION.into(),
            original_plugin_sha256: known_original("aarch64").unwrap().into(),
            replacement_plugin_sha256: "b".repeat(64),
        }
    }

    #[test]
    fn exact_known_host_and_replacement_are_required() {
        let mut value = manifest();
        assert!(qualify(
            &value,
            "aarch64",
            &value.original_plugin_sha256,
            &value.replacement_plugin_sha256
        )
        .is_ok());
        assert!(qualify(
            &value,
            "x86_64",
            &value.original_plugin_sha256,
            &value.replacement_plugin_sha256
        )
        .is_err());
        assert!(qualify(
            &value,
            "aarch64",
            &"c".repeat(64),
            &value.replacement_plugin_sha256
        )
        .is_err());
        assert!(qualify(
            &value,
            "aarch64",
            &value.original_plugin_sha256,
            &"c".repeat(64)
        )
        .is_err());
        value.original_plugin_sha256 = "c".repeat(64);
        assert!(qualify(
            &value,
            "aarch64",
            &value.original_plugin_sha256,
            &value.replacement_plugin_sha256
        )
        .is_err());
    }

    #[test]
    fn manifest_schema_and_source_cannot_expand_the_allowlist() {
        for changed in ["schema", "id", "version", "source", "replacement"] {
            let mut value = manifest();
            match changed {
                "schema" => value.schema = 2,
                "id" => value.os_id = "debian".into(),
                "version" => value.os_version = "26.04".into(),
                "source" => value.source_package_version = "1.24.2-1ubuntu0.6".into(),
                _ => value.replacement_plugin_sha256 = "../bad".into(),
            }
            assert!(qualify(
                &value,
                "aarch64",
                &value.original_plugin_sha256,
                &value.replacement_plugin_sha256
            )
            .is_err());
        }
    }

    #[test]
    fn only_exact_os_metadata_qualifies() {
        assert!(qualified_os("ID=ubuntu\nVERSION_ID=\"24.04\"\n"));
        for release in [
            "ID=ubuntu\nVERSION_ID=26.04",
            "ID=debian\nVERSION_ID=24.04",
            "ID=ubuntu\nVERSION_ID=24.04\nID=ubuntu",
            "ID=ubuntu;echo bad\nVERSION_ID=24.04",
        ] {
            assert!(!qualified_os(release));
        }
    }

    #[test]
    fn all_explicit_loader_paths_skip_even_when_empty() {
        for key in [
            "LD_LIBRARY_PATH",
            "LD_PRELOAD",
            "APPDIR",
            "APPIMAGE",
            "GST_PLUGIN_PATH",
            "GST_PLUGIN_PATH_1_0",
            "GST_PLUGIN_SYSTEM_PATH_1_0",
            "GST_PLUGIN_SCANNER_1_0",
            "GST_REGISTRY",
            "GST_REGISTRY_1_0",
        ] {
            assert!(custom_environment([OsString::from(key)]), "{key}");
        }
        assert!(!custom_environment([OsString::from("GST_DEBUG")]));
    }

    struct Temporary(PathBuf);
    impl Temporary {
        fn new() -> Self {
            let name = format!(
                "ottplay-media-compat-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let path = fs::canonicalize(std::env::temp_dir()).unwrap().join(name);
            fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn private_registry_rejects_links_and_shared_cache_files() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temporary = Temporary::new();
        let hash = "b".repeat(64);
        let registry = private_registry(&temporary.0, "aarch64", &hash).unwrap();
        assert!(registry.starts_with(&temporary.0));
        assert_eq!(
            fs::metadata(registry.parent().unwrap()).unwrap().mode() & 0o777,
            0o700
        );
        fs::write(&registry, b"cache").unwrap();
        fs::set_permissions(&registry, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(private_registry(&temporary.0, "aarch64", &hash).is_err());
        let link = temporary.0.join("link");
        symlink(&temporary.0, &link).unwrap();
        assert!(private_registry(&link, "aarch64", &hash).is_err());
        assert!(private_registry(Path::new("relative"), "aarch64", &hash).is_err());
    }

    #[test]
    fn custom_user_plugins_are_not_shadowed() {
        let temporary = Temporary::new();
        assert!(!has_user_plugins(&temporary.0, None));
        let plugins = temporary.0.join(".local/share/gstreamer-1.0/plugins");
        fs::create_dir_all(&plugins).unwrap();
        assert!(!has_user_plugins(&temporary.0, None));
        fs::write(plugins.join("custom.so"), b"custom").unwrap();
        assert!(has_user_plugins(&temporary.0, None));
        assert!(has_user_plugins(
            &temporary.0,
            Some(PathBuf::from("relative"))
        ));
    }

    #[test]
    fn package_paths_and_file_bounds_fail_closed() {
        let temporary = Temporary::new();
        let file = temporary.0.join("plugin");
        fs::write(&file, b"123456789").unwrap();
        assert!(read_bounded(&file, 4).is_err());
        assert_eq!(read_bounded(&file, 9).unwrap(), b"123456789");
        assert!(trusted_package_file(&file, 9).is_err());
        assert!(trusted_package_file(Path::new("relative"), 9).is_err());
    }

    #[test]
    fn manifest_rejects_additional_path_fields() {
        let raw = format!(
            r#"{{"schema":1,"os_id":"ubuntu","os_version":"24.04","architecture":"aarch64","source_package_version":"{SOURCE_VERSION}","original_plugin_sha256":"{}","replacement_plugin_sha256":"{}","path":"/tmp/plugin"}}"#,
            known_original("aarch64").unwrap(),
            "b".repeat(64)
        );
        assert!(serde_json::from_str::<Manifest>(&raw).is_err());
    }
}
