import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, placeholder as placeholderExtension } from "@codemirror/view";
import type { NoteLinkTarget } from "../../shared/note-links";
import { livePreviewExtension, markdownEditingExtension, type LivePreviewRefs } from "../lib/live-markdown";
import {
  addAttachmentFromFile,
  attachmentMarkdown,
  loadAttachment,
  releaseAttachments,
} from "../lib/attachments";

// Lets the toolbar's Attach button (in Editor.tsx, outside this lazily loaded chunk) hand
// picked files to the editor instance that is currently mounted.
export interface AttachFilesHandle {
  current: ((files: File[]) => void) | null;
}

interface MarkdownEditorProps {
  noteId: string;
  value: string;
  notes: NoteLinkTarget[];
  sourceMode: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  onNavigate: (id: string) => void;
  onNotify: (message: string) => void;
  attachFilesRef: AttachFilesHandle;
}

export function MarkdownEditor({
  noteId,
  value,
  notes,
  sourceMode,
  placeholder,
  onChange,
  onNavigate,
  onNotify,
  attachFilesRef,
}: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastKnownDocRef = useRef<string>(value);
  const livePreviewCompartmentRef = useRef(new Compartment());
  const onNotifyRef = useRef(onNotify);
  const refs = useRef<LivePreviewRefs>({
    notesRef: { current: notes },
    onNavigateRef: { current: onNavigate },
    loadAttachmentRef: { current: loadAttachment },
    onOpenAttachmentRef: {
      current: (id) => {
        window.driftleaf.attachments.saveCopy(id).then(
          (saved) => {
            if (saved) onNotifyRef.current("Saved a decrypted copy of the attachment.");
          },
          (error: unknown) =>
            onNotifyRef.current(
              error instanceof Error ? error.message : "Could not save the attachment",
            ),
        );
      },
    },
  });
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    refs.current.notesRef.current = notes;
    refs.current.onNavigateRef.current = onNavigate;
    onChangeRef.current = onChange;
    onNotifyRef.current = onNotify;
  }, [notes, onNavigate, onChange, onNotify]);

  // Encrypts each file into the branch, then inserts the Markdown that refers to it.
  // `at` is a document position for a drop; paste and the Attach button insert at the
  // cursor. The file is stored before the reference is typed, so an interrupted save can
  // only ever leave an unused attachment (cleaned up later), never a dangling reference.
  async function attachFiles(view: EditorView, files: File[], at?: number) {
    for (const file of files) {
      try {
        const meta = await addAttachmentFromFile(file);
        // The note may have been switched while the file was being encrypted.
        if (viewRef.current !== view) {
          onNotifyRef.current(
            `"${meta.name}" was added to the branch, but the note it was for is no longer open.`,
          );
          return;
        }
        const position = Math.min(at ?? view.state.selection.main.head, view.state.doc.length);
        const line = view.state.doc.lineAt(position);
        // Keep the reference on its own line so an image is not jammed into a sentence, and
        // always end with a line break: the cursor then lands on the line after it, so the
        // image renders straight away instead of showing its Markdown under the cursor.
        const before = position > line.from ? "\n" : "";
        const insert = `${before}${attachmentMarkdown(meta)}\n`;
        view.dispatch({
          changes: { from: position, insert },
          selection: { anchor: position + insert.length },
          scrollIntoView: true,
          userEvent: "input.paste",
        });
        if (at !== undefined) at = position + insert.length;
      } catch (error) {
        onNotifyRef.current(error instanceof Error ? error.message : "Could not attach that file");
      }
    }
    view.focus();
  }

  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          EditorView.lineWrapping,
          placeholderExtension(placeholder ?? ""),
          markdownEditingExtension(),
          EditorView.domEventHandlers({
            // Files on the clipboard (a screenshot, a copied image) become attachments.
            // Text-only pastes fall through to CodeMirror untouched.
            paste(event, editorView) {
              const files = [...(event.clipboardData?.files ?? [])];
              if (files.length === 0) return false;
              event.preventDefault();
              void attachFiles(editorView, files);
              return true;
            },
            drop(event, editorView) {
              const files = [...(event.dataTransfer?.files ?? [])];
              if (files.length === 0) return false;
              event.preventDefault();
              const position = editorView.posAtCoords({ x: event.clientX, y: event.clientY });
              void attachFiles(editorView, files, position ?? undefined);
              return true;
            },
          }),
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
    attachFilesRef.current = (files) => void attachFiles(view, files);
    return () => {
      view.destroy();
      viewRef.current = null;
      attachFilesRef.current = null;
      // Decrypted images belong to the note that was showing them.
      releaseAttachments();
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
