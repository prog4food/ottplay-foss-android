use sha2::{Digest, Sha256};
use std::{fs, path::Path};

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor");
    let manifest = root.join("ottplay-core.manifest.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest).expect("Shared core receipt"))
            .expect("Valid shared core receipt");
    assert_eq!(receipt["name"], "ottplay-shared-core");
    for file in ["ottplay-core.js", "ottplay-core.LICENSE.txt"] {
        let path = root.join(file);
        println!("cargo:rerun-if-changed={}", path.display());
        let actual = format!(
            "{:x}",
            Sha256::digest(fs::read(path).expect("Shared core artifact"))
        );
        assert_eq!(
            receipt["artifacts"][file]["sha256"].as_str(),
            Some(actual.as_str()),
            "Modified shared core artifact: {file}"
        );
    }
}
