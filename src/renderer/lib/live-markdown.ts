import { EditorView, Decoration, type DecorationSet, ViewPlugin, type ViewUpdate, WidgetType, keymap } from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import type { SyntaxNodeRef } from "@lezer/common";
import type { NoteLinkTarget } from "../../shared/note-links";
import { resolveWikiLink } from "../../shared/note-links";

export interface LivePreviewRefs {
  notesRef: { current: NoteLinkTarget[] };
  onNavigateRef: { current: (id: string) => void };
}

const WIKILINK_RE = /\[\[([^[\]|\n]+)(\|([^[\]\n]*))?\]\]/g;

const CODE_HOST_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "HTMLBlock", "HTMLTag", "CodeText", "CodeInfo"]);

class CheckboxWidget extends WidgetType {
  constructor(
    private checked: boolean,
    private from: number,
    private to: number,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.from === this.from && other.to === this.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.className = "cm-task-checkbox";
    input.addEventListener("mousedown", (event) => event.preventDefault());
    input.addEventListener("click", (event) => {
      event.preventDefault();
      const next = this.checked ? "[ ]" : "[x]";
      view.dispatch({ changes: { from: this.from, to: this.to, insert: next } });
    });
    return input;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function overlapsSelection(view: EditorView, from: number, to: number): boolean {
  for (const range of view.state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function skipTrailingSpace(doc: EditorView["state"]["doc"], pos: number): number {
  if (pos < doc.length && doc.sliceString(pos, pos + 1) === " ") return pos + 1;
  return pos;
}

interface Entry {
  from: number;
  to: number;
  deco: Decoration;
}

function headingLevel(name: string): number | null {
  const match = name.match(/^ATXHeading([1-6])$/);
  return match ? Number(match[1]) : null;
}

function collectWikiLinks(
  view: EditorView,
  from: number,
  to: number,
  codeRanges: Array<{ from: number; to: number }>,
  notes: NoteLinkTarget[],
  entries: Entry[],
) {
  const text = view.state.doc.sliceString(from, to);
  let match: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((match = WIKILINK_RE.exec(text))) {
    const start = from + match.index;
    const end = start + match[0].length;
    if (codeRanges.some((range) => start < range.to && end > range.from)) continue;

    const target = match[1].trim();
    const alias = match[3]?.trim();
    if (!target) continue;

    const id = resolveWikiLink(target, notes);
    const resolvedTitle = id ? notes.find((note) => note.id === id)?.title : undefined;
    const label = alias || resolvedTitle || target;
    const labelStart = alias ? start + match[0].indexOf("|") + 1 : start + 2;
    const labelEnd = labelStart + label.length;

    if (overlapsSelection(view, start, end)) continue;

    entries.push({ from: start, to: start + 2, deco: Decoration.replace({}) });
    if (alias) {
      entries.push({ from: start + 2, to: labelStart, deco: Decoration.replace({}) });
    }
    entries.push({
      from: labelStart,
      to: labelEnd,
      deco: Decoration.mark({
        class: id ? "cm-wikilink" : "cm-wikilink cm-wikilink-broken",
        attributes: id ? { "data-note-id": id } : {},
      }),
    });
    entries.push({ from: labelEnd, to: end, deco: Decoration.replace({}) });
  }
}

function buildDecorations(view: EditorView, notes: NoteLinkTarget[]): DecorationSet {
  const entries: Entry[] = [];
  const lineClasses = new Map<number, Set<string>>();
  const codeRanges: Array<{ from: number; to: number }> = [];

  const addLineClass = (linePos: number, cls: string) => {
    const set = lineClasses.get(linePos) ?? new Set<string>();
    set.add(cls);
    lineClasses.set(linePos, set);
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (ref: SyntaxNodeRef) => {
        const name = ref.name;

        if (CODE_HOST_NODES.has(name) && name !== "CodeText" && name !== "CodeInfo") {
          codeRanges.push({ from: ref.from, to: ref.to });
        }

        const level = headingLevel(name);
        if (level) {
          const node = ref.node;
          const line = view.state.doc.lineAt(node.from);
          addLineClass(line.from, `cm-header cm-header-${level}`);
          const mark = node.getChild("HeaderMark");
          if (mark && !overlapsSelection(view, line.from, line.to)) {
            entries.push({ from: mark.from, to: skipTrailingSpace(view.state.doc, mark.to), deco: Decoration.replace({}) });
          }
          return;
        }

        if (name === "StrongEmphasis" || name === "Emphasis" || name === "Strikethrough") {
          const node = ref.node;
          const marks = node.getChildren(name === "Strikethrough" ? "StrikethroughMark" : "EmphasisMark");
          const open = marks[0];
          const close = marks[marks.length - 1];
          if (!open || !close) return;
          const cls = name === "StrongEmphasis" ? "cm-strong" : name === "Emphasis" ? "cm-em" : "cm-strike";
          entries.push({ from: open.to, to: close.from, deco: Decoration.mark({ class: cls }) });
          if (!overlapsSelection(view, node.from, node.to)) {
            entries.push({ from: open.from, to: open.to, deco: Decoration.replace({}) });
            entries.push({ from: close.from, to: close.to, deco: Decoration.replace({}) });
          }
          return;
        }

        if (name === "InlineCode") {
          const node = ref.node;
          const marks = node.getChildren("CodeMark");
          const open = marks[0];
          const close = marks[marks.length - 1];
          if (!open || !close) return;
          entries.push({ from: open.to, to: close.from, deco: Decoration.mark({ class: "cm-inline-code" }) });
          if (!overlapsSelection(view, node.from, node.to)) {
            entries.push({ from: open.from, to: open.to, deco: Decoration.replace({}) });
            entries.push({ from: close.from, to: close.to, deco: Decoration.replace({}) });
          }
          return;
        }

        if (name === "Link") {
          const node = ref.node;
          const marks = node.getChildren("LinkMark");
          const url = node.getChild("URL");
          if (marks.length < 2 || !url) return;
          const labelFrom = marks[0].to;
          const labelTo = marks[1].from;
          entries.push({
            from: labelFrom,
            to: labelTo,
            deco: Decoration.mark({ class: "cm-link-label", attributes: { "data-href": view.state.doc.sliceString(url.from, url.to) } }),
          });
          if (!overlapsSelection(view, node.from, node.to)) {
            entries.push({ from: node.from, to: labelFrom, deco: Decoration.replace({}) });
            entries.push({ from: labelTo, to: node.to, deco: Decoration.replace({}) });
          }
          return;
        }

        if (name === "QuoteMark") {
          entries.push({ from: ref.from, to: ref.to, deco: Decoration.mark({ class: "cm-quote-mark" }) });
          addLineClass(view.state.doc.lineAt(ref.from).from, "cm-quote-line");
          return;
        }

        if (name === "ListMark") {
          entries.push({ from: ref.from, to: ref.to, deco: Decoration.mark({ class: "cm-list-mark" }) });
          return;
        }

        if (name === "TaskMarker") {
          if (!overlapsSelection(view, ref.from, ref.to)) {
            const text = view.state.doc.sliceString(ref.from, ref.to);
            const checked = /x/i.test(text);
            entries.push({ from: ref.from, to: ref.to, deco: Decoration.replace({ widget: new CheckboxWidget(checked, ref.from, ref.to) }) });
          }
          return;
        }

        if (name === "HorizontalRule") {
          const line = view.state.doc.lineAt(ref.from);
          if (!overlapsSelection(view, line.from, line.to)) {
            addLineClass(line.from, "cm-hr-line");
            entries.push({ from: ref.from, to: ref.to, deco: Decoration.replace({}) });
          }
          return;
        }
      },
    });

    collectWikiLinks(view, from, to, codeRanges, notes, entries);
  }

  entries.sort((a, b) => a.from - b.from || a.to - b.to);
  const lineEntries = [...lineClasses.entries()].sort((a, b) => a[0] - b[0]);

  const builder = new RangeSetBuilder<Decoration>();
  let entryIndex = 0;
  let lineIndex = 0;
  while (entryIndex < entries.length || lineIndex < lineEntries.length) {
    const nextEntry = entries[entryIndex];
    const nextLine = lineEntries[lineIndex];
    if (nextLine && (!nextEntry || nextLine[0] <= nextEntry.from)) {
      builder.add(nextLine[0], nextLine[0], Decoration.line({ class: [...nextLine[1]].join(" ") }));
      lineIndex++;
    } else if (nextEntry) {
      builder.add(nextEntry.from, nextEntry.to, nextEntry.deco);
      entryIndex++;
    }
  }
  return builder.finish();
}

function createPlugin(refs: LivePreviewRefs) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, refs.notesRef.current);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view, refs.notesRef.current);
        }
      }
    },
    {
      decorations: (instance) => instance.decorations,
    },
  );
}

function linkNavigationHandler(refs: LivePreviewRefs) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target;
      if (!(target instanceof Element)) return false;

      const wikilink = target.closest(".cm-wikilink[data-note-id]");
      if (wikilink instanceof HTMLElement) {
        event.preventDefault();
        refs.onNavigateRef.current(wikilink.dataset.noteId!);
        return true;
      }

      const link = target.closest(".cm-link-label[data-href]");
      if (link instanceof HTMLElement) {
        event.preventDefault();
        window.open(link.dataset.href, "_blank", "noopener,noreferrer");
        return true;
      }

      if (target.closest(".cm-task-checkbox")) {
        view.dom.focus();
      }

      return false;
    },
  });
}

/** Language support, history and keybindings — always on, regardless of preview mode. */
export function markdownEditingExtension(): Extension {
  return [
    history(),
    keymap.of([...markdownKeymap, ...historyKeymap, ...defaultKeymap]),
    markdown({ base: markdownLanguage, addKeymap: false }),
  ];
}

/** The decorations that render markdown inline instead of showing raw syntax. */
export function livePreviewExtension(refs: LivePreviewRefs): Extension {
  return [createPlugin(refs), linkNavigationHandler(refs)];
}
