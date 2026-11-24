import { EditorView, Decoration, type Command, type DecorationSet, type KeyBinding, ViewPlugin, type ViewUpdate, WidgetType, keymap } from "@codemirror/view";
import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { closeSearchPanel, findNext, findPrevious, openSearchPanel, search } from "@codemirror/search";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import type { NoteLinkTarget } from "../../shared/note-links";
import { resolveWikiLink } from "../../shared/note-links";
import { codeHighlightExtension, resolveCodeLanguage } from "./code-highlight";
import { attachmentIdFromUrl, type LoadedAttachment } from "./attachments";
import { MathWidget, MermaidWidget, NoteEmbedWidget } from "./live-render-widgets";

export interface LivePreviewRefs {
  notesRef: { current: NoteLinkTarget[] };
  onNavigateRef: { current: (id: string) => void };
  loadAttachmentRef: { current: (id: string) => Promise<LoadedAttachment> };
  onOpenAttachmentRef: { current: (id: string) => void };
  loadNoteRef: { current: (id: string) => Promise<string> };
}

const WIKILINK_RE = /\[\[([^[\]|\n]+)(\|([^[\]\n]*))?\]\]/g;
const NOTE_EMBED_RE = /!\[\[([^[\]|\n]+)\]\]/g;
const INLINE_MATH_RE = /(?<!\\)\$(?!\$)([^$\n]+?)(?<!\\)\$(?!\$)/g;
const DISPLAY_MATH_RE = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/g;
const blockPreviewFocusEffect = StateEffect.define<boolean>();

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

// Renders `![alt](attachment:<id>)` as the decrypted image. Only attachments are ever
// rendered: an image with a web address stays as plain Markdown text, so opening a note can
// never cause a network request. Non-image attachments written with image syntax, and
// attachments that cannot be loaded, render as a labelled chip instead.
class AttachmentWidget extends WidgetType {
  constructor(
    private id: string,
    private alt: string,
    private from: number,
    private refs: LivePreviewRefs,
  ) {
    super();
  }

  eq(other: AttachmentWidget): boolean {
    return other.id === this.id && other.alt === this.alt && other.from === this.from;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-attachment cm-attachment--pending";
    wrap.textContent = "Loading attachment…";
    this.refs.loadAttachmentRef.current(this.id).then(
      (loaded) => {
        wrap.classList.remove("cm-attachment--pending");
        if (loaded.imageUrl) {
          const image = document.createElement("img");
          image.src = loaded.imageUrl;
          image.alt = this.alt || loaded.meta.name;
          image.draggable = false;
          // The image's size is only known once it has decoded; let CodeMirror re-measure
          // line heights then, or the cursor and scroll position are computed for a line
          // that is still one text row tall.
          image.addEventListener("load", () => view.requestMeasure());
          wrap.replaceChildren(image);
        } else {
          wrap.classList.add("cm-attachment--file");
          wrap.textContent = `Attached file: ${loaded.meta.name}`;
        }
        view.requestMeasure();
      },
      () => {
        wrap.classList.remove("cm-attachment--pending");
        wrap.classList.add("cm-attachment--missing");
        wrap.textContent = `Attachment unavailable${this.alt ? `: ${this.alt}` : ""}`;
      },
    );
    // Clicking the rendered attachment puts the cursor on its Markdown, which reveals the
    // source for editing (the same way every other inline decoration here behaves).
    wrap.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// Raw Markdown is revealed only where the cursor is, and only while the note body has
// focus. A note that has just been opened (cursor parked at position 0, focus still in the
// sidebar) therefore renders fully formatted instead of showing its first line as source.
function overlapsSelection(view: EditorView, from: number, to: number): boolean {
  if (!view.hasFocus) return false;
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
  embedRanges: Array<{ from: number; to: number }>,
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
    if (embedRanges.some((range) => start < range.to && end > range.from)) continue;

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

function buildDecorations(view: EditorView, refs: LivePreviewRefs): DecorationSet {
  const notes = refs.notesRef.current;
  const entries: Entry[] = [];
  const lineClasses = new Map<number, Set<string>>();
  const codeRanges: Array<{ from: number; to: number }> = [];
  const embedRanges: Array<{ from: number; to: number }> = [];

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

        if (name === "Image") {
          const node = ref.node;
          const marks = node.getChildren("LinkMark");
          const url = node.getChild("URL");
          if (marks.length < 2 || !url) return;
          const id = attachmentIdFromUrl(view.state.doc.sliceString(url.from, url.to));
          // Not an attachment (for example a web address): leave the Markdown as text.
          if (!id || overlapsSelection(view, node.from, node.to)) return false;
          const alt = view.state.doc.sliceString(marks[0].to, marks[1].from);
          entries.push({
            from: node.from,
            to: node.to,
            deco: Decoration.replace({ widget: new AttachmentWidget(id, alt, node.from, refs) }),
          });
          return false;
        }

        if (name === "Link") {
          const node = ref.node;
          const marks = node.getChildren("LinkMark");
          const url = node.getChild("URL");
          if (marks.length < 2 || !url) return;
          const labelFrom = marks[0].to;
          const labelTo = marks[1].from;
          const href = view.state.doc.sliceString(url.from, url.to);
          entries.push({
            from: labelFrom,
            to: labelTo,
            deco: Decoration.mark({
              class: attachmentIdFromUrl(href) ? "cm-link-label cm-attachment-link" : "cm-link-label",
              attributes: { "data-href": href },
            }),
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

    const text = view.state.doc.sliceString(from, to);
    NOTE_EMBED_RE.lastIndex = 0;
    let embedMatch: RegExpExecArray | null;
    while ((embedMatch = NOTE_EMBED_RE.exec(text))) {
      const start = from + embedMatch.index;
      const end = start + embedMatch[0].length;
      if (codeRanges.some((range) => start < range.to && end > range.from)) continue;
      embedRanges.push({ from: start, to: end });
    }

    const displayMathRanges: Array<{ from: number; to: number }> = [];
    DISPLAY_MATH_RE.lastIndex = 0;
    let displayMatch: RegExpExecArray | null;
    const rangeText = view.state.doc.sliceString(from, to);
    while ((displayMatch = DISPLAY_MATH_RE.exec(rangeText))) {
      const start = from + displayMatch.index;
      const end = start + displayMatch[0].length;
      if (
        codeRanges.some((range) => start < range.to && end > range.from) ||
        embedRanges.some((range) => start < range.to && end > range.from)
      ) continue;
      displayMathRanges.push({ from: start, to: end });
    }

    for (let lineNumber = view.state.doc.lineAt(from).number; lineNumber <= view.state.doc.lineAt(to).number; lineNumber += 1) {
      const line = view.state.doc.line(lineNumber);

      INLINE_MATH_RE.lastIndex = 0;
      let mathMatch: RegExpExecArray | null;
      while ((mathMatch = INLINE_MATH_RE.exec(line.text))) {
        const start = line.from + mathMatch.index;
        const end = start + mathMatch[0].length;
        if (
          codeRanges.some((range) => start < range.to && end > range.from) ||
          embedRanges.some((range) => start < range.to && end > range.from) ||
          displayMathRanges.some((range) => start < range.to && end > range.from) ||
          overlapsSelection(view, start, end)
        ) continue;
        entries.push({
          from: start,
          to: end,
          deco: Decoration.replace({ widget: new MathWidget(mathMatch[1], false) }),
        });
      }
    }

    collectWikiLinks(view, from, to, codeRanges, embedRanges, notes, entries);
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

interface BlockPreviewState {
  decorations: DecorationSet;
  focused: boolean;
}

function selectionOverlaps(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

function buildBlockDecorations(
  state: EditorState,
  refs: LivePreviewRefs,
  focused: boolean,
): DecorationSet {
  const notes = refs.notesRef.current;
  const entries: Entry[] = [];
  const codeRanges: Array<{ from: number; to: number }> = [];
  const doc = state.doc;

  syntaxTree(state).iterate({
    from: 0,
    to: doc.length,
    enter: (ref) => {
      if (CODE_HOST_NODES.has(ref.name) && ref.name !== "CodeText" && ref.name !== "CodeInfo") {
        codeRanges.push({ from: ref.from, to: ref.to });
      }

      if (ref.name !== "FencedCode") return;
      const node = ref.node;
      const info = node.getChild("CodeInfo");
      if (!info || doc.sliceString(info.from, info.to).trim().toLowerCase() !== "mermaid") return;
      if (focused && selectionOverlaps(state, node.from, node.to)) return;

      let source = "";
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === "CodeText") source += doc.sliceString(child.from, child.to);
      }
      entries.push({
        from: node.from,
        to: node.to,
        deco: Decoration.replace({ widget: new MermaidWidget(source), block: true }),
      });
    },
  });

  const embedRanges: Array<{ from: number; to: number }> = [];
  NOTE_EMBED_RE.lastIndex = 0;
  let embedMatch: RegExpExecArray | null;
  const text = doc.toString();
  while ((embedMatch = NOTE_EMBED_RE.exec(text))) {
    const from = embedMatch.index;
    const to = from + embedMatch[0].length;
    if (codeRanges.some((range) => from < range.to && to > range.from)) continue;
    embedRanges.push({ from, to });
    if (focused && selectionOverlaps(state, from, to)) continue;

    const id = resolveWikiLink(embedMatch[1].trim(), notes);
    if (!id) continue;
    const title = notes.find((note) => note.id === id)?.title ?? embedMatch[1].trim();
    entries.push({
      from,
      to,
      deco: Decoration.replace({ widget: new NoteEmbedWidget(id, title, refs), block: true }),
    });
  }

  DISPLAY_MATH_RE.lastIndex = 0;
  let displayMatch: RegExpExecArray | null;
  while ((displayMatch = DISPLAY_MATH_RE.exec(text))) {
    const from = displayMatch.index;
    const to = from + displayMatch[0].length;
    if (
      codeRanges.some((range) => from < range.to && to > range.from) ||
      embedRanges.some((range) => from < range.to && to > range.from) ||
      (focused && selectionOverlaps(state, from, to))
    ) continue;
    entries.push({
      from,
      to,
      deco: Decoration.replace({ widget: new MathWidget(displayMatch[1], true), block: true }),
    });
  }

  entries.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const entry of entries) builder.add(entry.from, entry.to, entry.deco);
  return builder.finish();
}

function blockPreviewExtension(refs: LivePreviewRefs): Extension {
  const field = StateField.define<BlockPreviewState>({
    create(state) {
      return {
        decorations: buildBlockDecorations(state, refs, false),
        focused: false,
      };
    },
    update(value, transaction) {
      let focused = value.focused;
      for (const effect of transaction.effects) {
        if (effect.is(blockPreviewFocusEffect)) focused = effect.value;
      }
      const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
      if (!transaction.docChanged && !selectionChanged && focused === value.focused) {
        return value;
      }
      return {
        decorations: buildBlockDecorations(transaction.state, refs, focused),
        focused,
      };
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.decorations),
  });

  return [
    field,
    EditorView.focusChangeEffect.of((_state, focused) => blockPreviewFocusEffect.of(focused)),
  ];
}

function createPlugin(refs: LivePreviewRefs) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, refs);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged
        ) {
          this.decorations = buildDecorations(update.view, refs);
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
        const attachmentId = attachmentIdFromUrl(link.dataset.href ?? "");
        // An attachment link saves a decrypted copy where the user chooses; it is never
        // handed to window.open(), which would ask the OS to open "attachment:…".
        if (attachmentId) refs.onOpenAttachmentRef.current(attachmentId);
        else window.open(link.dataset.href, "_blank", "noopener,noreferrer");
        return true;
      }

      if (target.closest(".cm-task-checkbox")) {
        view.dom.focus();
      }

      return false;
    },
  });
}

/**
 * The find/replace subset of @codemirror/search's `searchKeymap`. Its other bindings are
 * left out on purpose: Mod-d and Mod-Shift-l build multiple selections, which this editor
 * does not enable, and Mod-Alt-g opens an unrelated go-to-line panel.
 *
 * The "search-panel" scope makes these work while focus is in the panel's own fields.
 * Escape must stay ahead of defaultKeymap's Escape (simplifySelection) below:
 * closeSearchPanel reports "not handled" when no panel is open, so that still runs.
 */
const searchBindings: readonly KeyBinding[] = [
  { key: "Mod-f", run: openSearchPanel, scope: "editor search-panel" },
  { key: "F3", run: findNext, shift: findPrevious, scope: "editor search-panel", preventDefault: true },
  { key: "Mod-g", run: findNext, shift: findPrevious, scope: "editor search-panel", preventDefault: true },
  { key: "Escape", run: closeSearchPanel, scope: "editor search-panel" },
];

/**
 * Sentence-case labels for the search panel, matching the rest of the app. CodeMirror
 * derives both the visible text and the aria-labels from these phrases.
 */
const searchPhrases = {
  next: "Next",
  previous: "Previous",
  "match case": "Match case",
  regexp: "Regex",
  "by word": "Whole word",
  replace: "Replace",
  "replace all": "Replace all",
  close: "Close",
};

/**
 * Enter inside highlighted code that sits in a blockquote.
 *
 * lang-markdown's Enter handler (which repeats the `> ` marker) stands down wherever a
 * nested code language is active, so once a fence has a recognized language the default
 * handler would start the new line without the marker and the line would fall out of the
 * quote, cutting the code block in two. This repeats the current line's quote prefix (and
 * its indentation) instead. Everywhere else it reports "not handled".
 */
const continueQuotedCode: Command = ({ state, dispatch }) => {
  const { main } = state.selection;
  if (state.selection.ranges.length !== 1 || !main.empty) return false;
  const pos = main.head;
  if (markdownLanguage.isActiveAt(state, pos, -1) || markdownLanguage.isActiveAt(state, pos, 1)) return false;

  // resolve() stays in the markdown tree (it does not enter the mounted code language).
  let quoted = false;
  let fenced = false;
  for (let node: SyntaxNode | null = syntaxTree(state).resolve(pos, -1); node; node = node.parent) {
    if (node.name === "FencedCode") fenced = true;
    else if (node.name === "Blockquote") quoted = fenced;
  }
  if (!quoted) return false;

  const prefix = /^(?:[ \t]*>[ \t]?)+[ \t]*/.exec(state.doc.lineAt(pos).text)?.[0];
  if (!prefix) return false;
  const insert = state.lineBreak + prefix;
  dispatch(
    state.update({
      changes: { from: pos, insert },
      selection: { anchor: pos + insert.length },
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

/** Language support, history, find/replace and keybindings — always on, regardless of preview mode. */
export function markdownEditingExtension(): Extension {
  return [
    history(),
    search({ top: true }),
    EditorState.phrases.of(searchPhrases),
    keymap.of([
      ...searchBindings,
      { key: "Enter", run: continueQuotedCode },
      ...markdownKeymap,
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    markdown({ base: markdownLanguage, addKeymap: false, codeLanguages: resolveCodeLanguage }),
    codeHighlightExtension(),
  ];
}

/** The decorations that render markdown inline instead of showing raw syntax. */
export function livePreviewExtension(refs: LivePreviewRefs): Extension {
  return [blockPreviewExtension(refs), createPlugin(refs), linkNavigationHandler(refs)];
}

const focusLinePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      builder.add(line.from, line.from, Decoration.line({ class: "cm-focus-line" }));
      return builder.finish();
    }

    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged) this.decorations = this.build(update.view);
    }
  },
  { decorations: (instance) => instance.decorations },
);

export function focusModeExtension(focusMode: boolean, typewriter: boolean): Extension {
  if (!focusMode) return [];
  return [
    EditorView.editorAttributes.of({ class: "cm-focus-mode" }),
    focusLinePlugin,
    typewriter
      ? EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) {
            update.view.dispatch({
              effects: EditorView.scrollIntoView(update.state.selection.main.head, { y: "center" }),
            });
          }
        })
      : [],
  ];
}
