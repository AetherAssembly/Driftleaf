import { HighlightStyle, LanguageDescription, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { highlightTree, tags as t } from "@lezer/highlight";

/**
 * Common fence names that `@codemirror/language-data` does not list as a language name or
 * alias, mapped to one it does. A Map (not an object literal) so info strings such as
 * `constructor` or `__proto__` cannot hit Object.prototype.
 */
const FENCE_ALIASES = new Map<string, string>([
  ["py", "python"],
  ["rs", "rust"],
  ["golang", "go"],
  ["kt", "kotlin"],
  ["hs", "haskell"],
  ["md", "markdown"],
  ["ps1", "powershell"],
  ["jsonc", "json"],
  ["docker", "dockerfile"],
  ["patch", "diff"],
  ["svg", "xml"],
  ["h", "c"],
  ["cc", "c++"],
  ["cxx", "c++"],
  ["hpp", "c++"],
]);

/**
 * Resolves a fence info string (```js, ```python, …) to a lazily loaded language.
 *
 * Matching is exact on purpose. lang-markdown's default for a plain language array is
 * fuzzy substring matching, which resolves ```text and ```plaintext to LaTeX (alias
 * "tex"); an unknown or missing language must stay unhighlighted instead.
 */
export function resolveCodeLanguage(info: string): LanguageDescription | null {
  const name = info.toLowerCase();
  return LanguageDescription.matchLanguageName(languages, FENCE_ALIASES.get(name) ?? name, false);
}

/**
 * Token colors for fenced code. Every color is a `--code-*` custom property defined per
 * theme in app.css, so switching theme recolors existing editors without a reconfigure.
 * Operators, punctuation and plain variable names deliberately keep the editor text color.
 */
export const codeHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.tagName], color: "var(--code-keyword)" },
  { tag: [t.string, t.regexp, t.escape], color: "var(--code-string)" },
  { tag: [t.number, t.bool, t.atom, t.null, t.unit, t.color, t.constant(t.name)], color: "var(--code-number)" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.standard(t.variableName), t.macroName],
    color: "var(--code-function)",
  },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--code-type)" },
  { tag: t.propertyName, color: "var(--code-property)" },
  { tag: t.meta, color: "var(--code-meta)" },
  { tag: t.inserted, color: "var(--code-inserted)" },
  { tag: t.deleted, color: "var(--code-deleted)" },
  { tag: t.heading, fontWeight: "700" },
]);

const markCache = new Map<string, Decoration>();

function tokenMark(cls: string): Decoration {
  let mark = markCache.get(cls);
  if (!mark) {
    mark = Decoration.mark({ class: cls });
    markCache.set(cls, mark);
  }
  return mark;
}

/**
 * Highlights only the contents of fenced code blocks. The stock `syntaxHighlighting()`
 * extension styles the whole document, which would also recolor prose-level nodes that
 * share these tags (inline HTML, link titles, HTML comments); restricting the pass to each
 * fence's CodeText ranges leaves everything outside code blocks exactly as it was.
 */
function buildCodeDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (ref) => {
        if (ref.name !== "FencedCode") return;
        // One CodeText per fence at the top level; one per line inside a blockquote, where
        // the quote marks sit between them and must not be styled.
        for (let child = ref.node.firstChild; child; child = child.nextSibling) {
          if (child.name !== "CodeText") continue;
          const start = Math.max(from, child.from);
          const end = Math.min(to, child.to);
          if (start >= end) continue;
          highlightTree(tree, codeHighlightStyle, (tokenFrom, tokenTo, cls) => builder.add(tokenFrom, tokenTo, tokenMark(cls)), start, end);
        }
        return false;
      },
    });
  }
  return builder.finish();
}

const codeHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildCodeDecorations(view);
    }

    update(update: ViewUpdate) {
      // The tree check covers a language chunk finishing its lazy load: that reparses the
      // fence without any document change.
      if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
        this.decorations = buildCodeDecorations(update.view);
      }
    }
  },
  {
    decorations: (instance) => instance.decorations,
  },
);

/** Syntax colors inside fenced code blocks, in both live-preview and Source mode. */
export function codeHighlightExtension(): Extension {
  const { module } = codeHighlightStyle;
  return [codeHighlightPlugin, module ? EditorView.styleModule.of(module) : []];
}
