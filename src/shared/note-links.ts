import type { NoteGraph } from "./ipc";

export interface NoteLinkTarget {
  id: string;
  title: string;
  folderPath: string;
}

export interface WikiLink {
  target: string;
  alias?: string;
}

function mapInlineWikiLinks(
  line: string,
  transform: (link: WikiLink) => string,
): string {
  let result = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] === "`") {
      let ticks = 1;
      while (line[index + ticks] === "`") ticks++;
      const delimiter = "`".repeat(ticks);
      const close = line.indexOf(delimiter, index + ticks);
      if (close !== -1) {
        result += line.slice(index, close + ticks);
        index = close + ticks;
        continue;
      }
    }

    if (line.startsWith("[[", index)) {
      const close = line.indexOf("]]", index + 2);
      if (close !== -1) {
        const contents = line.slice(index + 2, close);
        const separator = contents.indexOf("|");
        const target = (separator === -1 ? contents : contents.slice(0, separator)).trim();
        const alias = separator === -1 ? undefined : contents.slice(separator + 1).trim();
        if (target) {
          result += transform({ target, alias });
          index = close + 2;
          continue;
        }
      }
    }

    result += line[index];
    index++;
  }
  return result;
}

export function mapWikiLinks(
  source: string,
  transform: (link: WikiLink) => string,
): string {
  const lines = source.split(/(\r?\n)/);
  let fence: { character: string; length: number } | null = null;
  return lines
    .map((line, index) => {
      if (index % 2 === 1) return line;
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (marker) {
        const run = marker[1];
        if (!fence) {
          fence = { character: run[0], length: run.length };
        } else if (run[0] === fence.character && run.length >= fence.length) {
          fence = null;
        }
        return line;
      }
      return fence ? line : mapInlineWikiLinks(line, transform);
    })
    .join("");
}

export function resolveWikiLink(target: string, nodes: NoteLinkTarget[]): string | null {
  const normalized = target.trim().replace(/\\/g, "/").toLowerCase();
  if (!normalized) return null;

  if (normalized.includes("/")) {
    const matches = nodes.filter(
      (node) =>
        `${node.folderPath}/${node.title}`.replace(/^\/+/, "").toLowerCase() === normalized,
    );
    return matches.length === 1 ? matches[0].id : null;
  }

  const matches = nodes.filter((node) => node.title.trim().toLowerCase() === normalized);
  return matches.length === 1 ? matches[0].id : null;
}

export function backlinksFor(graph: NoteGraph, noteId: string): string[] {
  return [
    ...new Set(
      graph.edges.filter((edge) => edge.targetId === noteId).map((edge) => edge.sourceId),
    ),
  ];
}

export function unlinkedMentionsFor(graph: NoteGraph, noteId: string): string[] {
  return [
    ...new Set(
      graph.unlinkedMentions
        .filter((mention) => mention.targetId === noteId)
        .map((mention) => mention.sourceId),
    ),
  ];
}
