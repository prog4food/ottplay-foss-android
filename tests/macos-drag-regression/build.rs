use std::{env, path::PathBuf, process::Command};

fn main() {
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    assert!(Command::new("clang")
        .args([
            "-fobjc-arc",
            "-Wno-deprecated-declarations",
            "-c",
            "fixture.m",
            "-o"
        ])
        .arg(out.join("fixture.o"))
        .status()
        .unwrap()
        .success());
    assert!(Command::new("ar")
        .arg("rcs")
        .arg(out.join("libfixture.a"))
        .arg(out.join("fixture.o"))
        .status()
        .unwrap()
        .success());
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=fixture");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rerun-if-changed=fixture.m");
}
