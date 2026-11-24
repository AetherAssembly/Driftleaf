import DOMPurify from "dompurify";
import { marked } from "marked";
import { WidgetType, type EditorView } from "@codemirror/view";
import type { NoteLinkTarget } from "../../shared/note-links";

export class MathWidget extends WidgetType {
  constructor(
    private readonly formula: string,
    private readonly displayMode: boolean,
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other.formula === this.formula && other.displayMode === this.displayMode;
  }

  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement(this.displayMode ? "div" : "span");
    element.className = this.displayMode ? "cm-math cm-math--display" : "cm-math";
    void import("katex")
      .then(({ default: katex }) => {
        katex.render(this.formula, element, {
          displayMode: this.displayMode,
          throwOnError: false,
          trust: false,
        });
        view.requestMeasure();
      })
      .catch((error: unknown) => {
        element.classList.add("cm-math--error");
        element.textContent = `Math could not be rendered: ${error instanceof Error ? error.message : String(error)}`;
        view.requestMeasure();
      });
    return element;
  }
}

export class MermaidWidget extends WidgetType {
  constructor(private readonly source: string) {
    super();
  }

  eq(other: MermaidWidget): boolean {
    return other.source === this.source;
  }

  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement("div");
    element.className = "cm-mermaid cm-mermaid--pending";
    element.textContent = "Rendering diagram…";
    void loadMermaid()
      .then(async (mermaid) => {
        const id = `driftleaf-mermaid-${++mermaidRenderId}`;
        const { svg } = await mermaid.render(id, this.source);
        element.classList.remove("cm-mermaid--pending");
        element.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } });
        view.requestMeasure();
      })
      .catch((error: unknown) => showDiagramError(element, error));
    return element;
  }
}

let mermaidRenderId = 0;
let mermaidModulePromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid(): Promise<typeof import("mermaid").default> {
  mermaidModulePromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true });
    return mermaid;
  });
  return mermaidModulePromise;
}

function showDiagramError(element: HTMLElement, error: unknown): void {
  element.classList.remove("cm-mermaid--pending");
  element.classList.add("cm-mermaid--error");
  const message = error instanceof Error ? error.message : String(error);
  element.textContent = `Diagram could not be rendered: ${message}`;
}

export interface EmbedWidgetRefs {
  notesRef: { current: NoteLinkTarget[] };
  loadNoteRef: { current: (id: string) => Promise<string> };
}

export class NoteEmbedWidget extends WidgetType {
  constructor(
    private readonly noteId: string,
    private readonly title: string,
    private readonly refs: EmbedWidgetRefs,
  ) {
    super();
  }

  eq(other: NoteEmbedWidget): boolean {
    return other.noteId === this.noteId && other.title === this.title;
  }

  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement("section");
    element.className = "cm-note-embed cm-note-embed--pending";
    const heading = document.createElement("div");
    heading.className = "cm-note-embed__title";
    heading.textContent = this.title || "Untitled";
    const body = document.createElement("div");
    body.className = "cm-note-embed__body";
    body.textContent = "Loading embedded note…";
    element.append(heading, body);

    void this.refs.loadNoteRef.current(this.noteId)
      .then((content) => {
        const html = marked.parse(content, { async: false });
        body.innerHTML = DOMPurify.sanitize(html, {
          FORBID_TAGS: [
            "img",
            "iframe",
            "video",
            "audio",
            "source",
            "style",
            "svg",
            "math",
            "object",
            "embed",
            "link",
            "base",
            "meta",
          ],
          FORBID_ATTR: ["style"],
        });
        element.classList.remove("cm-note-embed--pending");
        view.requestMeasure();
      })
      .catch((error: unknown) => {
        body.textContent = `Embedded note could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
        element.classList.remove("cm-note-embed--pending");
        element.classList.add("cm-note-embed--error");
        view.requestMeasure();
      });
    return element;
  }
}
