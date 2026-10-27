use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as AsyncMutex;

// A one-way, read-only check of Driftleaf's own site RSS feed — fetched once per launch,
// parsed for only its single most recent <item>, and never written back to or polled.
const FEED_URL: &str = "https://driftleaf.aetherassembly.org/rss_driftleaf.xml";

struct AnnouncementItem {
    guid: String,
    title: String,
    link: Option<String>,
    pub_date: Option<String>,
    description: Option<String>,
}

async fn fetch_latest_item() -> Result<Option<AnnouncementItem>, String> {
    let xml = reqwest::Client::new()
        .get(FEED_URL)
        .header("User-Agent", "Driftleaf")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_latest_item(&xml))
}

// Only the first <item> in the feed is ever read — everything after it is ignored, by design.
fn parse_latest_item(xml: &str) -> Option<AnnouncementItem> {
    let start = xml.find("<item>")?;
    let end = xml[start..].find("</item>")? + start;
    let item_xml = &xml[start..end];

    let title = extract_tag(item_xml, "title")?;
    let guid = extract_tag(item_xml, "guid").unwrap_or_else(|| title.clone());
    let link = extract_tag(item_xml, "link");
    let pub_date = extract_tag(item_xml, "pubDate");
    let description = extract_tag(item_xml, "description");

    Some(AnnouncementItem { guid, title, link, pub_date, description })
}

fn extract_tag(item_xml: &str, tag: &str) -> Option<String> {
    let open_start = item_xml.find(&format!("<{tag}"))?;
    let open_end = item_xml[open_start..].find('>')? + open_start + 1;
    let close = item_xml[open_end..].find(&format!("</{tag}>"))? + open_end;
    Some(unescape_xml_entities(item_xml[open_end..close].trim()))
}

fn unescape_xml_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

pub struct Announcements {
    status: Mutex<Value>,
    operation: AsyncMutex<()>,
}

pub fn setup() -> Announcements {
    Announcements {
        status: Mutex::new(json!({
            "guid": null, "title": null, "link": null, "pubDate": null, "description": null,
            "checkedAt": null,
        })),
        operation: AsyncMutex::new(()),
    }
}

impl Announcements {
    fn snapshot(&self) -> Value {
        self.status.lock().unwrap().clone()
    }

    fn publish(&self, app: &AppHandle, item: Option<AnnouncementItem>) -> Value {
        let mut status = self.status.lock().unwrap();
        status["guid"] = item.as_ref().map(|i| json!(i.guid)).unwrap_or(Value::Null);
        status["title"] = item.as_ref().map(|i| json!(i.title)).unwrap_or(Value::Null);
        status["link"] = item
            .as_ref()
            .and_then(|i| i.link.as_ref())
            .map(|link| json!(link))
            .unwrap_or(Value::Null);
        status["pubDate"] = item
            .as_ref()
            .and_then(|i| i.pub_date.as_ref())
            .map(|date| json!(date))
            .unwrap_or(Value::Null);
        status["description"] = item
            .as_ref()
            .and_then(|i| i.description.as_ref())
            .map(|description| json!(description))
            .unwrap_or(Value::Null);
        status["checkedAt"] = json!(SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64);
        let result = status.clone();
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit("driftleaf:announcementStatus", &result);
        }
        result
    }

    pub async fn check(&self, app: &AppHandle) -> Result<Value, String> {
        let _operation = self.operation.lock().await;
        let item = fetch_latest_item().await?;
        Ok(self.publish(app, item))
    }
}

#[tauri::command]
pub async fn announcement_status(state: tauri::State<'_, Announcements>) -> Result<Value, String> {
    Ok(state.snapshot())
}

#[tauri::command]
pub async fn announcement_check(
    app: AppHandle,
    state: tauri::State<'_, Announcements>,
) -> Result<Value, String> {
    state.check(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_single_most_recent_item_only() {
        let xml = r#"<rss><channel>
            <item><title>Newest</title><link>https://example.com/a</link><guid isPermaLink="false">guid-a</guid><pubDate>Mon, 26 Oct 2026 00:00:00 GMT</pubDate></item>
            <item><title>Older</title><link>https://example.com/b</link><guid isPermaLink="false">guid-b</guid></item>
        </channel></rss>"#;
        let item = parse_latest_item(xml).unwrap();
        assert_eq!(item.title, "Newest");
        assert_eq!(item.guid, "guid-a");
        assert_eq!(item.link, Some("https://example.com/a".to_string()));
    }

    #[test]
    fn falls_back_to_the_title_when_no_guid_is_present() {
        let xml = r#"<item><title>No guid here</title><link>https://example.com</link></item>"#;
        let item = parse_latest_item(xml).unwrap();
        assert_eq!(item.guid, "No guid here");
    }

    #[test]
    fn unescapes_entities_in_the_description() {
        let xml = r#"<item><title>T</title><description>Notes &amp; links &lt;here&gt;</description></item>"#;
        let item = parse_latest_item(xml).unwrap();
        assert_eq!(item.description, Some("Notes & links <here>".to_string()));
    }

    #[test]
    fn returns_none_without_any_item() {
        assert!(parse_latest_item("<rss><channel></channel></rss>").is_none());
    }
}
