//! Ports mapWikiLinks()/resolveWikiLink() from src/shared/note-links.ts: finding
//! `[[Note title]]` / `[[Note title|alias]]` links in Markdown while skipping fenced and
//! inline code, and resolving a link target to a note ID by title (optionally
//! "folder/title" when ambiguous).

fn map_inline_wiki_links(line: &str, transform: &mut dyn FnMut(&str, Option<&str>) -> String) -> String {
    let mut result = String::new();
    let mut index = 0usize;
    while index < line.len() {
        if line.as_bytes()[index] == b'`' {
            let mut ticks = 1usize;
            while line.as_bytes().get(index + ticks) == Some(&b'`') {
                ticks += 1;
            }
            let delimiter = "`".repeat(ticks);
            if let Some(relative_close) = line[index + ticks..].find(&delimiter) {
                let close = index + ticks + relative_close;
                result.push_str(&line[index..close + ticks]);
                index = close + ticks;
                continue;
            }
        }
        if line[index..].starts_with("[[") {
            if let Some(relative_close) = line[index + 2..].find("]]") {
                let close = index + 2 + relative_close;
                let contents = &line[index + 2..close];
                let (target, alias) = match contents.find('|') {
                    Some(separator) => (contents[..separator].trim(), Some(contents[separator + 1..].trim())),
                    None => (contents.trim(), None),
                };
                if !target.is_empty() {
                    result.push_str(&transform(target, alias));
                    index = close + 2;
                    continue;
                }
            }
        }
        let char_len = line[index..].chars().next().map(char::len_utf8).unwrap_or(1);
        result.push_str(&line[index..index + char_len]);
        index += char_len;
    }
    result
}

fn leading_fence_marker(line: &str) -> Option<(char, usize)> {
    let mut chars = line.chars().peekable();
    let mut spaces = 0;
    while spaces < 3 {
        match chars.peek() {
            Some(c) if c.is_whitespace() => {
                chars.next();
                spaces += 1;
            }
            _ => break,
        }
    }
    let first = *chars.peek()?;
    if first != '`' && first != '~' {
        return None;
    }
    // `peek()` above didn't advance the iterator, so `first` is still the next item
    // `take_while` will consume — no separate "+1" needed for it.
    let run_len = chars.take_while(|c| *c == first).count();
    if run_len >= 3 {
        Some((first, run_len))
    } else {
        None
    }
}

/// Splits `source` on line boundaries (preserving `\r\n`/`\n` as their own pass-through
/// pieces, matching `source.split(/(\r?\n)/)`), tracks a fenced-code-block state across
/// lines, and applies `map_inline_wiki_links` only to lines outside a fence.
pub fn map_wiki_links(source: &str, transform: &mut dyn FnMut(&str, Option<&str>) -> String) -> String {
    let mut lines = Vec::new();
    let mut rest = source;
    loop {
        match rest.find('\n') {
            Some(position) => {
                let before = &rest[..position];
                if let Some(stripped) = before.strip_suffix('\r') {
                    lines.push(stripped);
                    lines.push("\r\n");
                } else {
                    lines.push(before);
                    lines.push("\n");
                }
                rest = &rest[position + 1..];
            }
            None => {
                lines.push(rest);
                break;
            }
        }
    }
    let mut fence: Option<(char, usize)> = None;
    let mut output = String::new();
    for (index, line) in lines.iter().enumerate() {
        if index % 2 == 1 {
            output.push_str(line);
            continue;
        }
        if let Some((run_char, run_len)) = leading_fence_marker(line) {
            fence = match fence {
                None => Some((run_char, run_len)),
                Some((fence_char, fence_len)) if run_char == fence_char && run_len >= fence_len => None,
                other => other,
            };
            output.push_str(line);
        } else if fence.is_some() {
            output.push_str(line);
        } else {
            output.push_str(&map_inline_wiki_links(line, transform));
        }
    }
    output
}

/// `nodes` is (id, title, folderPath). Returns the single matching note's id, or `None`
/// if the target is empty, unresolved, or ambiguous (matches more than one note).
pub fn resolve_wiki_link(target: &str, nodes: &[(String, String, String)]) -> Option<String> {
    let normalized = target.trim().replace('\\', "/").to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    let matches: Vec<String> = if normalized.contains('/') {
        nodes
            .iter()
            .filter(|(_, title, folder_path)| {
                format!("{folder_path}/{title}").trim_start_matches('/').to_lowercase() == normalized
            })
            .map(|(id, _, _)| id.clone())
            .collect()
    } else {
        nodes
            .iter()
            .filter(|(_, title, _)| title.trim().to_lowercase() == normalized)
            .map(|(id, _, _)| id.clone())
            .collect()
    };
    if matches.len() == 1 {
        Some(matches[0].clone())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn links(source: &str) -> Vec<(String, Option<String>)> {
        let mut found = Vec::new();
        map_wiki_links(source, &mut |target, alias| {
            found.push((target.to_string(), alias.map(String::from)));
            String::new()
        });
        found
    }

    #[test]
    fn finds_plain_and_aliased_links() {
        assert_eq!(
            links("See [[Note A]] and [[Note B|alias]]."),
            vec![("Note A".into(), None), ("Note B".into(), Some("alias".into()))]
        );
    }

    #[test]
    fn skips_links_inside_inline_and_fenced_code() {
        assert_eq!(links("`[[Not a link]]`"), vec![]);
        assert_eq!(links("```\n[[Not a link]]\n```"), vec![]);
        assert_eq!(links("~~~\n[[Not a link]]\n~~~\n[[Real link]]"), vec![("Real link".into(), None)]);
    }

    #[test]
    fn resolve_prefers_unambiguous_folder_qualified_match() {
        let nodes = vec![
            ("id1".to_string(), "Driftleaf".to_string(), "Projects".to_string()),
            ("id2".to_string(), "Driftleaf".to_string(), "Archive".to_string()),
        ];
        assert_eq!(resolve_wiki_link("Driftleaf", &nodes), None); // ambiguous by title alone
        assert_eq!(resolve_wiki_link("Projects/Driftleaf", &nodes), Some("id1".to_string()));
        assert_eq!(resolve_wiki_link("nonexistent", &nodes), None);
    }
}
