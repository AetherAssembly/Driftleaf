fn main() {
    for key in [
        "DRIFTLEAF_UPDATER_PUBLIC_KEY",
        "DRIFTLEAF_UPDATER_ENDPOINT",
        "DRIFTLEAF_MAC_AUTO_UPDATE",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    tauri_build::build()
}
