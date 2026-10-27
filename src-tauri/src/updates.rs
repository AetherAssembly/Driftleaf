use super::{prepare_close, request_flush, validate_main_window, FlushState, Sidecar};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex as AsyncMutex;

// Release discovery for builds ineligible for the signed auto-updater (Linux, unsigned
// macOS) — independent of `eligible()` below, which only gates signed in-app installation.
// Without this, those builds never checked public release metadata at all (B10).
const RELEASES_OWNER: &str = "AetherAssembly";
const RELEASES_REPO: &str = "Driftleaf";

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

async fn fetch_latest_stable_release() -> Result<GithubRelease, String> {
    let url =
        format!("https://api.github.com/repos/{RELEASES_OWNER}/{RELEASES_REPO}/releases?per_page=10");
    let releases: Vec<GithubRelease> = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "Driftleaf")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    releases
        .into_iter()
        .find(|release| !release.draft && !release.prerelease)
        .ok_or_else(|| "No published release was found".to_string())
}

fn parse_release_version(tag: &str) -> Option<semver::Version> {
    semver::Version::parse(tag.trim_start_matches('v')).ok()
}

const PUBLIC_KEY: &str = match option_env!("DRIFTLEAF_UPDATER_PUBLIC_KEY") {
    Some(key) => key,
    None => "",
};
const ENDPOINT: &str = match option_env!("DRIFTLEAF_UPDATER_ENDPOINT") {
    Some(url) => url,
    None => "",
};

pub struct Updates {
    enabled: bool,
    status: Mutex<Value>,
    operation: AsyncMutex<()>,
    candidate: AsyncMutex<Option<Update>>,
    downloaded: AsyncMutex<Option<(Update, Vec<u8>)>>,
}

fn eligible(
    platform: &str,
    debug: bool,
    portable: bool,
    key: &str,
    endpoint: &str,
    mac_signed: bool,
) -> bool {
    !debug
        && !portable
        && !key.trim().is_empty()
        && endpoint.starts_with("https://")
        && (platform == "windows" || (platform == "macos" && mac_signed))
}

pub fn setup(app: &AppHandle) -> Result<Updates, Box<dyn std::error::Error>> {
    let portable = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|p| p.join("driftleaf-portable")))
        .is_some_and(|path| path.exists());
    let enabled = eligible(
        std::env::consts::OS,
        cfg!(debug_assertions),
        portable,
        PUBLIC_KEY,
        ENDPOINT,
        option_env!("DRIFTLEAF_MAC_AUTO_UPDATE") == Some("1"),
    );
    if enabled {
        app.plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(PUBLIC_KEY)
                .build(),
        )?;
    }
    Ok(Updates {
        enabled,
        status: Mutex::new(json!({"state": if enabled {"idle"} else {"unsupported"},
            "currentVersion": app.package_info().version.to_string(), "availableVersion": null,
            "downloadUrl": null, "checkedAt": null, "automaticInstall": enabled,
            "message": if enabled {"Updates have not been checked yet."} else {"Automatic updates are not configured for this test build. Install newer test packages manually."}})),
        operation: AsyncMutex::new(()),
        candidate: AsyncMutex::new(None),
        downloaded: AsyncMutex::new(None),
    })
}

impl Updates {
    fn snapshot(&self) -> Value {
        self.status.lock().unwrap().clone()
    }
    fn publish(&self, app: &AppHandle, state: &str, message: &str) -> Value {
        let mut status = self.status.lock().unwrap();
        status["state"] = json!(state);
        status["message"] = json!(message);
        let result = status.clone();
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit("driftleaf:updateStatus", &result);
        }
        result
    }
    pub async fn check(&self, app: &AppHandle) -> Result<Value, String> {
        let _operation = self.operation.lock().await;
        if self.downloaded.lock().await.is_some() {
            return Ok(self.snapshot());
        }
        self.publish(app, "checking", "Checking for updates…");
        if self.enabled {
            return self.check_signed(app).await;
        }
        self.check_unsigned(app).await
    }

    async fn check_signed(&self, app: &AppHandle) -> Result<Value, String> {
        let result = async {
            let endpoint = ENDPOINT
                .parse()
                .map_err(|_| "Invalid updater endpoint".to_string())?;
            app.updater_builder()
                .endpoints(vec![endpoint])
                .map_err(|e| e.to_string())?
                .timeout(Duration::from_secs(60))
                .build()
                .map_err(|e| e.to_string())?
                .check()
                .await
                .map_err(|e| e.to_string())
        }
        .await;
        match result {
            Ok(candidate) => {
                let available = candidate.is_some();
                {
                    let mut status = self.status.lock().unwrap();
                    status["availableVersion"] =
                        candidate.as_ref().map_or(Value::Null, |u| json!(u.version));
                    status["checkedAt"] = json!(SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64);
                }
                *self.candidate.lock().await = candidate;
                Ok(self.publish(
                    app,
                    if available { "available" } else { "up-to-date" },
                    if available {
                        "A signed update is available."
                    } else {
                        "Driftleaf is up to date."
                    },
                ))
            }
            Err(error) => {
                self.publish(app, "error", &error);
                Err(error)
            }
        }
    }

    // Linux and unsigned-macOS builds: this app will never install for them automatically,
    // but README/docs/UPDATES.md promises they still get told a newer release exists and
    // get a link to it — plain unauthenticated GitHub release metadata, no signing involved.
    async fn check_unsigned(&self, app: &AppHandle) -> Result<Value, String> {
        match fetch_latest_stable_release().await {
            Ok(release) => {
                let current = app.package_info().version.clone();
                let available = parse_release_version(&release.tag_name)
                    .is_some_and(|latest| latest > current);
                {
                    let mut status = self.status.lock().unwrap();
                    status["availableVersion"] =
                        if available { json!(release.tag_name) } else { Value::Null };
                    status["downloadUrl"] =
                        if available { json!(release.html_url) } else { Value::Null };
                    status["checkedAt"] = json!(SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64);
                }
                Ok(self.publish(
                    app,
                    if available { "available" } else { "up-to-date" },
                    if available {
                        "A new release is available. This build updates manually — download and install it yourself."
                    } else {
                        "Driftleaf is up to date."
                    },
                ))
            }
            Err(error) => {
                self.publish(app, "error", &error);
                Err(error)
            }
        }
    }
}

#[tauri::command]
pub fn update_status(
    window: WebviewWindow,
    state: tauri::State<'_, Updates>,
) -> Result<Value, String> {
    validate_main_window(window.label())?;
    Ok(state.snapshot())
}
#[tauri::command]
pub async fn update_check(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, Updates>,
) -> Result<Value, String> {
    validate_main_window(window.label())?;
    state.check(&app).await
}
#[tauri::command]
pub async fn update_download(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, Updates>,
) -> Result<Value, String> {
    validate_main_window(window.label())?;
    let _operation = state.operation.lock().await;
    if !state.enabled {
        return Err("Automatic updates are not configured".into());
    }
    let update = state
        .candidate
        .lock()
        .await
        .clone()
        .ok_or("Check for an update first")?;
    if update.download_url.scheme() != "https" {
        return Err("Update downloads must use HTTPS".into());
    }
    state.publish(&app, "downloading", "Downloading and verifying update…");
    match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => {
            *state.downloaded.lock().await = Some((update, bytes));
            Ok(state.publish(&app, "downloaded", "Update verified. Restart to install."))
        }
        Err(error) => {
            state.publish(&app, "error", &error.to_string());
            Err(error.to_string())
        }
    }
}
#[tauri::command]
pub async fn update_install(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, Updates>,
    flush: tauri::State<'_, Arc<FlushState>>,
    sidecar: tauri::State<'_, Arc<Sidecar>>,
) -> Result<(), String> {
    validate_main_window(window.label())?;
    let _operation = state.operation.lock().await;
    if !state.enabled {
        return Err("Automatic updates are not configured".into());
    }
    let mut downloaded = state.downloaded.lock().await;
    let (update, bytes) = downloaded.as_ref().ok_or("No verified update is ready")?;
    if !flush.closing.lock().unwrap().insert("main".into()) {
        return Err("A close or installation is already in progress".into());
    }
    let (id, receiver) = request_flush(&window.as_ref().window(), &flush);
    let ready = prepare_close(&flush, id, receiver, Duration::from_secs(30), || async {
        sidecar
            .call("lifecycle.trustedDrain", vec![])
            .await
            .map(|_| ())
    })
    .await;
    let result = ready.and_then(|_| update.install(bytes).map_err(|e| e.to_string()));
    if let Err(error) = result {
        flush.closing.lock().unwrap().remove("main");
        let _ = window.emit("driftleaf:closeCancelled", ());
        return Err(error);
    }
    downloaded.take();
    app.restart();
}

// Opens the release page discovered by check_unsigned() (or the signed path, if it ever sets
// downloadUrl) in the system browser — the manual-download half of B10's fix. Available
// regardless of `enabled`, unlike download/install above, which stay signed-path-only.
#[tauri::command]
pub async fn update_open_download(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, Updates>,
) -> Result<(), String> {
    validate_main_window(window.label())?;
    let url = state
        .status
        .lock()
        .unwrap()
        .get("downloadUrl")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| "No downloadable release is available. Check for updates first.".to_string())?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_policy_requires_signed_installed_supported_build() {
        assert!(eligible(
            "windows",
            false,
            false,
            "key",
            "https://example.org/tauri.json",
            false
        ));
        assert!(!eligible(
            "windows",
            false,
            false,
            "",
            "https://example.org/tauri.json",
            false
        ));
        assert!(!eligible(
            "windows",
            false,
            true,
            "key",
            "https://example.org/tauri.json",
            false
        ));
        assert!(!eligible(
            "windows",
            true,
            false,
            "key",
            "https://example.org/tauri.json",
            false
        ));
        assert!(!eligible(
            "linux",
            false,
            false,
            "key",
            "https://example.org/tauri.json",
            false
        ));
        assert!(!eligible(
            "macos",
            false,
            false,
            "key",
            "https://example.org/tauri.json",
            false
        ));
        assert!(eligible(
            "macos",
            false,
            false,
            "key",
            "https://example.org/tauri.json",
            true
        ));
        assert!(!eligible(
            "windows",
            false,
            false,
            "key",
            "http://example.org/tauri.json",
            false
        ));
    }

    // B10 regression: ineligible builds must still compare real release metadata against the
    // current version rather than reporting "unsupported" without checking anything.
    #[test]
    fn parses_tags_with_and_without_a_leading_v() {
        assert_eq!(
            parse_release_version("v1.2.3"),
            Some(semver::Version::new(1, 2, 3))
        );
        assert_eq!(
            parse_release_version("1.2.3"),
            Some(semver::Version::new(1, 2, 3))
        );
        assert_eq!(parse_release_version("not-a-version"), None);
    }

    #[test]
    fn release_availability_compares_against_the_current_version() {
        let current = semver::Version::new(0, 7, 1);
        let older = parse_release_version("v0.7.0").unwrap();
        let newer = parse_release_version("v0.8.0").unwrap();
        assert!(older < current);
        assert!(newer > current);
    }
}
