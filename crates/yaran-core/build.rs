//! Build script: stamps the version string yaran displays, `v<version>` for a
//! release build and `development` otherwise.

use std::env;
fn main() {
    println!("cargo:rerun-if-env-changed=YARAN_RELEASE_BUILD");
    let display_version = if env::var("YARAN_RELEASE_BUILD").as_deref() == Ok("1") {
        format!("v{}", env!("CARGO_PKG_VERSION"))
    } else {
        "development".to_string()
    };
    println!("cargo:rustc-env=YARAN_DISPLAY_VERSION={display_version}");
}
