//! Ports the in-memory FTS5 index and note graph from src/main/search.ts: rebuilt from
//! decrypted note content each session, never written to disk.
use crate::mutation::Branch;
use crate::note_links::{map_wiki_links, resolve_wiki_link};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub struct SearchIndex {
    conn: Connection,
}

impl SearchIndex {
    pub fn open() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title, folderPath UNINDEXED, content)",
        )
        .map_err(|e| e.to_string())?;
        Ok(Self { conn })
    }

    /// Mirrors buildIndex(): decrypts every note in the branch, skipping (never aborting
    /// the whole build for) any one that fails to decrypt — the same per-note corruption
    /// guarantee `read_note` already makes.
    pub fn build_from_branch(&self, branch: &Branch) -> Result<(), String> {
        self.conn.execute("DELETE FROM notes_fts", []).map_err(|e| e.to_string())?;
        self.conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        {
            let mut insert = self
                .conn
                .prepare("INSERT INTO notes_fts (id, title, folderPath, content) VALUES (?1, ?2, ?3, ?4)")
                .map_err(|e| e.to_string())?;
            for note in branch.manifest["notes"].as_array().into_iter().flatten() {
                let id = note["id"].as_str().unwrap_or("");
                if let Ok(content) = branch.read_note(id) {
                    insert
                        .execute(params![id, note["title"].as_str().unwrap_or(""), note["folderPath"].as_str().unwrap_or(""), content])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        self.conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn reindex_note(&self, id: &str, title: &str, folder_path: &str, content: &str) -> Result<(), String> {
        self.conn.execute("DELETE FROM notes_fts WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT INTO notes_fts (id, title, folderPath, content) VALUES (?1, ?2, ?3, ?4)",
                params![id, title, folder_path, content],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_from_index(&self, id: &str) -> Result<(), String> {
        self.conn.execute("DELETE FROM notes_fts WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn search(&self, query: &str) -> Result<Value, String> {
        let match_query = to_match_query(query);
        if match_query.is_empty() {
            return Ok(Value::Array(Vec::new()));
        }
        let mut statement = self
            .conn
            .prepare(
                "SELECT id, title, folderPath, snippet(notes_fts, 3, '<mark>', '</mark>', '…', 12) AS snippet \
                 FROM notes_fts WHERE notes_fts MATCH ?1 ORDER BY rank LIMIT 50",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![match_query], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut results = Vec::new();
        for row in rows {
            let (id, title, folder_path, snippet) = row.map_err(|e| e.to_string())?;
            results.push(json!({
                "id": id,
                "title": title,
                "folderPath": folder_path,
                "snippet": sanitize_snippet(&snippet),
            }));
        }
        Ok(Value::Array(results))
    }

    /// Mirrors buildNoteGraph(): wikilinks become graph edges; an unresolved but literally
    /// present note title (outside code) becomes an "unlinked mention" instead.
    pub fn build_note_graph(&self) -> Result<Value, String> {
        let mut statement = self
            .conn
            .prepare("SELECT id, title, folderPath, content FROM notes_fts ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String, String, String)> = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;

        let nodes: Vec<(String, String, String)> =
            rows.iter().map(|(id, title, folder, _)| (id.clone(), title.clone(), folder.clone())).collect();
        let mut edges: HashMap<(String, String), Value> = HashMap::new();
        let mut linked: HashSet<(String, String)> = HashSet::new();
        let mut unlinked_mentions: HashMap<(String, String), Value> = HashMap::new();

        for (row_id, _title, _folder, content) in &rows {
            let plain_text = {
                let mut transform = |target: &str, _alias: Option<&str>| -> String {
                    if let Some(target_id) = resolve_wiki_link(target, &nodes) {
                        if target_id != *row_id {
                            let key = (row_id.clone(), target_id.clone());
                            edges.insert(key.clone(), json!({ "sourceId": row_id, "targetId": target_id }));
                            linked.insert(key);
                        }
                    }
                    String::new()
                };
                map_wiki_links(content, &mut transform)
            };
            let searchable_text = strip_fences_and_inline_code(&plain_text);
            for (note_id, title, _) in &nodes {
                if note_id == row_id || title.trim().is_empty() {
                    continue;
                }
                let key = (row_id.clone(), note_id.clone());
                if linked.contains(&key) {
                    continue;
                }
                if contains_word_boundary_match(&searchable_text, title.trim()) {
                    unlinked_mentions.insert(key, json!({ "sourceId": row_id, "targetId": note_id }));
                }
            }
        }

        let node_values: Vec<Value> =
            nodes.iter().map(|(id, title, folder)| json!({ "id": id, "title": title, "folderPath": folder })).collect();
        Ok(json!({
            "nodes": node_values,
            "edges": edges.into_values().collect::<Vec<_>>(),
            "unlinkedMentions": unlinked_mentions.into_values().collect::<Vec<_>>(),
        }))
    }
}

// Each word becomes a quoted prefix term so user input can't break out into FTS5 query
// syntax (NOT/AND/columns/etc) — same guard as toMatchQuery() in search.ts.
fn to_match_query(query: &str) -> String {
    query
        .split_whitespace()
        .filter(|word| !word.is_empty())
        .map(|word| format!("\"{}\"*", word.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn sanitize_snippet(snippet: &str) -> String {
    // The highlight tags snippet() emits are exactly the literal strings passed as its
    // arguments above ("<mark>"/"</mark>"), always that exact case — no need for the
    // case-insensitive regex replace sanitizeSearchSnippet() uses for the same reason.
    escape_html(snippet).replace("&lt;mark&gt;", "<mark>").replace("&lt;/mark&gt;", "</mark>")
}

fn strip_fences_and_inline_code(text: &str) -> String {
    let fenced = regex::Regex::new(r"(?s)```.*?```|~~~.*?~~~").unwrap().replace_all(text, " ");
    regex::Regex::new(r"`[^`]*`").unwrap().replace_all(&fenced, " ").into_owned()
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Approximates the reference implementation's
/// `(?<![\p{L}\p{N}_])escapedTitle(?![\p{L}\p{N}_])` (case-insensitive) without a
/// lookaround-capable regex engine: every case-insensitive occurrence of `needle`, checked
/// against the characters immediately before/after it.
fn contains_word_boundary_match(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let haystack_chars: Vec<char> = haystack.to_lowercase().chars().collect();
    let needle_chars: Vec<char> = needle.to_lowercase().chars().collect();
    if needle_chars.is_empty() || needle_chars.len() > haystack_chars.len() {
        return false;
    }
    for start in 0..=(haystack_chars.len() - needle_chars.len()) {
        if haystack_chars[start..start + needle_chars.len()] != needle_chars[..] {
            continue;
        }
        let before_ok = start == 0 || !is_word_char(haystack_chars[start - 1]);
        let after_index = start + needle_chars.len();
        let after_ok = after_index == haystack_chars.len() || !is_word_char(haystack_chars[after_index]);
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_query_quotes_each_word_as_a_prefix_term() {
        assert_eq!(to_match_query("hello world"), "\"hello\"* \"world\"*");
        assert_eq!(to_match_query("  spaced   out  "), "\"spaced\"* \"out\"*");
        assert_eq!(to_match_query(""), "");
        // A literal quote in the query must not let user input break out of FTS5 syntax.
        assert_eq!(to_match_query("NOT\" evil"), "\"NOT\"* \"evil\"*");
    }

    #[test]
    fn snippet_sanitization_escapes_html_but_keeps_mark_tags() {
        assert_eq!(sanitize_snippet("<mark>hi</mark> & <script>"), "<mark>hi</mark> &amp; &lt;script&gt;");
    }

    #[test]
    fn word_boundary_match_respects_boundaries_and_case() {
        assert!(contains_word_boundary_match("See the Driftleaf app", "driftleaf"));
        assert!(!contains_word_boundary_match("DriftleafPro is different", "Driftleaf"));
        assert!(contains_word_boundary_match("(Driftleaf)", "Driftleaf"));
    }

    #[test]
    fn fence_stripping_removes_fenced_and_inline_code() {
        let text = "before ```\ncode [[link]]\n``` after `inline` done";
        let stripped = strip_fences_and_inline_code(text);
        assert!(!stripped.contains("code"));
        assert!(!stripped.contains("inline"));
        assert!(stripped.contains("before"));
        assert!(stripped.contains("after"));
        assert!(stripped.contains("done"));
    }

    #[test]
    fn index_search_and_graph_round_trip() {
        let index = SearchIndex::open().unwrap();
        index.reindex_note("id1", "Driftleaf", "", "A note that mentions [[Companion]] and also Companion again.").unwrap();
        index.reindex_note("id2", "Companion", "", "Nothing special here.").unwrap();
        let results = index.search("mentions").unwrap();
        assert_eq!(results[0]["id"], "id1");
        assert!(results[0]["snippet"].as_str().unwrap().contains("<mark>"));

        let graph = index.build_note_graph().unwrap();
        assert_eq!(graph["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(graph["edges"].as_array().unwrap().len(), 1);
        assert_eq!(graph["edges"][0]["sourceId"], "id1");
        assert_eq!(graph["edges"][0]["targetId"], "id2");
        // The second, unlinked "Companion again" mention must not also appear as an
        // unlinked mention, since it's already linked once via the wikilink above.
        assert_eq!(graph["unlinkedMentions"].as_array().unwrap().len(), 0);

        index.remove_from_index("id2").unwrap();
        let graph_after_removal = index.build_note_graph().unwrap();
        assert_eq!(graph_after_removal["nodes"].as_array().unwrap().len(), 1);
    }
}
