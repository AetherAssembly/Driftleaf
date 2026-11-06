import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, placeholder as placeholderExtension } from "@codemirror/view";
import type { NoteLinkTarget } from "../../shared/note-links";
import { livePreviewExtension, markdownEditingExtension, type LivePreviewRefs } from "../lib/live-markdown";

interface MarkdownEditorProps {
  noteId: string;
  value: string;
  notes: NoteLinkTarget[];
  sourceMode: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  onNavigate: (id: string) => void;
}

export function MarkdownEditor({
  noteId,
  value,
  notes,
  sourceMode,
  placeholder,
  onChange,
  onNavigate,
}: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastKnownDocRef = useRef<string>(value);
  const livePreviewCompartmentRef = useRef(new Compartment());
  const refs = useRef<LivePreviewRefs>({
    notesRef: { current: notes },
    onNavigateRef: { current: onNavigate },
  });
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    refs.current.notesRef.current = notes;
    refs.current.onNavigateRef.current = onNavigate;
    onChangeRef.current = onChange;
  }, [notes, onNavigate, onChange]);

  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          EditorView.lineWrapping,
          placeholderExtension(placeholder ?? ""),
          markdownEditingExtension(),
          livePreviewCompartmentRef.current.of(sourceMode ? [] : livePreviewExtension(refs.current)),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const text = update.state.doc.toString();
            lastKnownDocRef.current = text;
            onChangeRef.current(text);
          }),
          EditorView.contentAttributes.of({ "aria-label": "Note body", spellcheck: "true" }),
        ],
      }),
      parent: containerRef.current!,
    });
    viewRef.current = view;
    lastKnownDocRef.current = value;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Recreated whenever the open note changes so undo history and selection don't leak
    // across notes; content/mode updates after mount are applied via the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === lastKnownDocRef.current) return;
    lastKnownDocRef.current = value;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: livePreviewCompartmentRef.current.reconfigure(sourceMode ? [] : livePreviewExtension(refs.current)),
    });
  }, [sourceMode]);

  return <div className="editor__codemirror" ref={containerRef} />;
}
