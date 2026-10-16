import { marked } from "marked";
import DOMPurify from "dompurify";
import type { NoteLinkTarget } from "../../shared/note-links";
import { mapWikiLinks, resolveWikiLink } from "../../shared/note-links";

marked.setOptions({ breaks: true, gfm: true });

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|>]/g, "\\$&");
}

export function renderMarkdown(source: string, notes: NoteLinkTarget[] = []): string {
  const withWikiLinks = mapWikiLinks(source, ({ target, alias }) => {
    const id = resolveWikiLink(target, notes);
    if (!id) return `[[${target}${alias ? `|${alias}` : ""}]]`;
    const note = notes.find((item) => item.id === id);
    const label = alias || note?.title || target;
    return `[${escapeMarkdownLabel(label)}](#driftleaf-note=${encodeURIComponent(id)})`;
  });
  const html = marked.parse(withWikiLinks, { async: false }) as string;
  return DOMPurify.sanitize(html);
}
