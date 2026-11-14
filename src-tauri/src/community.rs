//! The community extension and template gallery, ported from src/main/community-catalog.ts:
//! public release metadata and assets from two AetherAssembly repositories on GitHub. These
//! are the only requests the backend itself makes, and only when the gallery is opened or an
//! item is previewed or installed. Nothing about the branch is sent.
use serde_json::{json, Value};
use std::time::Duration;

const OWNER: &str = "AetherAssembly";
const MAX_EXTENSION_BYTES: u64 = 512 * 1024;
const MAX_TEMPLATE_BYTES: u64 = 25 * 1024 * 1024;
const DOWNLOAD_HOSTS: [&str; 3] = ["api.github.com", "github.com", "release-assets.githubusercontent.com"];

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Extension,
    Template,
}

impl Kind {
    fn repository(self) -> &'static str {
        match self {
            Kind::Extension => "Driftleaf-Extensions",
            Kind::Template => "Driftleaf-Templates",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Kind::Extension => "extension",
            Kind::Template => "template",
        }
    }
    fn limit(self) -> u64 {
        match self {
            Kind::Extension => MAX_EXTENSION_BYTES,
            Kind::Template => MAX_TEMPLATE_BYTES,
        }
    }
}

async fn github_request(url: &str, accept: &str) -> Result<reqwest::Response, String> {
    let response = reqwest::Client::new()
        .get(url)
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "Driftleaf")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| format!("GitHub release request failed ({error})"))?;
    let status = response.status();
    if !status.is_success() {
        let rate_limited = status.as_u16() == 403
            && response.headers().get("x-ratelimit-remaining").and_then(|v| v.to_str().ok()) == Some("0");
        if rate_limited {
            return Err("GitHub's release browsing limit was reached. Try again later.".into());
        }
        return Err(format!(
            "GitHub release request failed ({} {})",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ));
    }
    Ok(response)
}

fn is_release(value: &Value) -> bool {
    value["tag_name"].is_string()
        && (value["name"].is_string() || value["name"].is_null())
        && (value["body"].is_string() || value["body"].is_null())
        && value["draft"].is_boolean()
        && value["prerelease"].is_boolean()
        && value["assets"].as_array().is_some_and(|assets| {
            assets.iter().all(|asset| asset["id"].is_number() && asset["name"].is_string() && asset["size"].is_number())
        })
}

// Published (not draft, not prerelease) releases, newest first, flattened to one item per
// asset of the right type, keeping only the newest item of each name.
fn latest_items(kind: Kind, releases: &[Value]) -> Vec<Value> {
    let suffix = if kind == Kind::Extension { ".js" } else { ".zip" };
    let mut seen = std::collections::HashSet::new();
    let mut items = Vec::new();
    for release in releases.iter().filter(|r| r["draft"] == false && r["prerelease"] == false) {
        let version = release["name"]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .or(release["tag_name"].as_str())
            .unwrap_or_default();
        let description = release["body"].as_str().map(str::trim).filter(|body| !body.is_empty()).unwrap_or(
            if kind == Kind::Extension { "Community JavaScript extension." } else { "Community branch template." },
        );
        for asset in release["assets"].as_array().into_iter().flatten() {
            let file_name = asset["name"].as_str().unwrap_or_default();
            if !file_name.to_lowercase().ends_with(suffix) {
                continue;
            }
            let name = &file_name[..file_name.len() - suffix.len()];
            if !seen.insert(name.to_lowercase()) {
                continue;
            }
            items.push(json!({
                "assetId": asset["id"],
                "kind": kind.name(),
                "name": name,
                "version": version,
                "description": description,
                "repository": kind.repository(),
                "size": asset["size"],
            }));
        }
    }
    items
}

async fn items_for(kind: Kind) -> Result<Vec<Value>, String> {
    let repository = kind.repository();
    let url = format!("https://api.github.com/repos/{OWNER}/{repository}/releases?per_page=30");
    let payload: Value = github_request(&url, "application/vnd.github+json")
        .await?
        .json()
        .await
        .map_err(|_| format!("GitHub returned an invalid release catalog for {repository}"))?;
    match payload.as_array() {
        Some(releases) if releases.iter().all(is_release) => Ok(latest_items(kind, releases)),
        _ => Err(format!("GitHub returned an invalid release catalog for {repository}")),
    }
}

/// `{ items, errors }`: one repository failing does not hide the other.
pub async fn list() -> Value {
    let (mut items, mut errors) = (Vec::new(), Vec::new());
    for kind in [Kind::Extension, Kind::Template] {
        match items_for(kind).await {
            Ok(found) => items.extend(found),
            Err(error) => errors.push(json!(format!("{}: {error}", kind.repository()))),
        }
    }
    json!({ "items": items, "errors": errors })
}

/// Downloads one current release asset, bounded in size and only from GitHub's own hosts.
/// Returns the asset's display name and its bytes.
pub async fn download(asset_id: &Value, kind: Kind) -> Result<(String, Vec<u8>), String> {
    let asset_id = asset_id.as_u64().filter(|id| *id >= 1).ok_or("Invalid community release asset")?;
    let item = items_for(kind)
        .await?
        .into_iter()
        .find(|item| item["assetId"].as_u64() == Some(asset_id))
        .ok_or("This release asset is no longer available")?;
    let limit = kind.limit();
    let too_large = || -> String {
        if kind == Kind::Extension { "Extensions must be smaller than 512 KB" } else { "Templates must be smaller than 25 MB" }.into()
    };
    if item["size"].as_u64().unwrap_or(u64::MAX) > limit {
        return Err(too_large());
    }
    let url = format!("https://api.github.com/repos/{OWNER}/{}/releases/assets/{asset_id}", kind.repository());
    let mut response = github_request(&url, "application/octet-stream").await?;
    if !response.url().host_str().is_some_and(|host| DOWNLOAD_HOSTS.contains(&host)) {
        return Err("GitHub redirected the release download to an unsupported host".into());
    }
    if response.content_length().unwrap_or(0) > limit {
        return Err("The downloaded release asset is too large".into());
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if (bytes.len() + chunk.len()) as u64 > limit {
            return Err("The downloaded release asset is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((item["name"].as_str().unwrap_or_default().to_string(), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_published_asset_of_each_name_wins() {
        let releases = vec![
            json!({ "tag_name": "v3", "name": null, "body": null, "draft": true, "prerelease": false,
                    "assets": [{ "id": 9, "name": "Tags.js", "size": 1 }] }),
            json!({ "tag_name": "v2", "name": " Second ", "body": " Notes ", "draft": false, "prerelease": false,
                    "assets": [{ "id": 2, "name": "Tags.JS", "size": 10 }, { "id": 3, "name": "readme.txt", "size": 1 }] }),
            json!({ "tag_name": "v1", "name": "", "body": "", "draft": false, "prerelease": false,
                    "assets": [{ "id": 1, "name": "tags.js", "size": 5 }, { "id": 4, "name": "Other.js", "size": 7 }] }),
        ];
        assert!(releases.iter().all(is_release));
        let items = latest_items(Kind::Extension, &releases);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], json!({
            "assetId": 2, "kind": "extension", "name": "Tags", "version": "Second",
            "description": "Notes", "repository": "Driftleaf-Extensions", "size": 10,
        }));
        assert_eq!(items[1]["name"], "Other");
        assert_eq!(items[1]["version"], "v1");
        assert_eq!(items[1]["description"], "Community JavaScript extension.");
        assert!(latest_items(Kind::Template, &releases).is_empty());
        assert!(!is_release(&json!({ "tag_name": "v1" })));
    }
}
