import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Button, Modal } from "@aetherAssembly/ui";
import type { NoteMeta } from "../../shared/ipc";
import type { AttachFilesHandle } from "./MarkdownEditor";

// CodeMirror and its language/markdown packages are sizeable; split them into their
// own chunk so the rest of the app doesn't pay for the editor until a note is opened.
const MarkdownEditor = lazy(() =>
  import("./MarkdownEditor").then((module) => ({ default: module.MarkdownEditor })),
);

interface EditorProps {
  note: NoteMeta;
  notes: NoteMeta[];
  backlinks: NoteMeta[];
  mentions: NoteMeta[];
  content: string;
  saveStatus: "idle" | "saving" | "saved";
  fontSizePx: number;
  typewriterMode: boolean;
  onChange: (content: string) => void;
  onRenameTitle: (title: string) => void;
  onDelete: () => void;
  onNavigate: (id: string) => void;
  onNotify: (message: string) => void;
}

export function Editor({
  note,
  notes,
  backlinks,
  mentions,
  content,
  saveStatus,
  fontSizePx,
  typewriterMode,
  onChange,
  onRenameTitle,
  onDelete,
  onNavigate,
  onNotify,
}: EditorProps) {
  const [sourceMode, setSourceMode] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const attachFilesRef = useRef<AttachFilesHandle["current"]>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("focus-mode-active", focusMode);
    return () => document.documentElement.classList.remove("focus-mode-active");
  }, [focusMode]);

  return (
    <div className="editor">
      <div className="editor__toolbar">
        <input
          className="editor__title"
          aria-label="Note title"
          value={note.title}
          onChange={(e) => onRenameTitle(e.target.value)}
          placeholder="Untitled"
        />
        <div className="editor__toolbar-actions">
          <span className="editor__save-status" aria-live="polite">
            {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved" : null}
          </span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              // Reset so picking the same file twice in a row still fires a change.
              event.target.value = "";
              if (files.length > 0) attachFilesRef.current?.(files);
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            title="Attach an image or file. It is encrypted into this branch. You can also paste or drop one into the note."
          >
            Attach
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSourceMode((v) => !v)}>
            {sourceMode ? "Live preview" : "Source mode"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={focusMode}
            onClick={() => setFocusMode((value) => !value)}
          >
            {focusMode ? "Exit focus" : "Focus"}
          </Button>
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      </div>

      {backlinks.length > 0 ? (
        <section className="editor__backlinks" aria-label="Backlinks">
          <span>Linked from</span>
          {backlinks.map((backlink) => (
            <Button
              key={backlink.id}
              variant="ghost"
              size="sm"
              onClick={() => onNavigate(backlink.id)}
            >
              {backlink.title || "Untitled"}
            </Button>
          ))}
        </section>
      ) : null}
      {mentions.length > 0 ? (
        <section className="editor__backlinks" aria-label="Unlinked mentions">
          <span>Mentioned in</span>
          {mentions.map((mention) => (
            <Button
              key={mention.id}
              variant="ghost"
              size="sm"
              onClick={() => onNavigate(mention.id)}
            >
              {mention.title || "Untitled"}
            </Button>
          ))}
        </section>
      ) : null}

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete note?">
        <p>
          &ldquo;{note.title || "Untitled"}&rdquo; will be moved to Trash. You can restore it
          from there for 30 days.
        </p>
        <div className="modal-actions">
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              setConfirmDelete(false);
              onDelete();
            }}
          >
            Move to Trash
          </Button>
        </div>
      </Modal>
      <div className="editor__panes" style={{ fontSize: fontSizePx }}>
        <Suspense fallback={<div className="editor__codemirror" />}>
          <MarkdownEditor
            noteId={note.id}
            value={content}
            notes={notes}
            sourceMode={sourceMode}
            focusMode={focusMode}
            typewriterMode={typewriterMode}
            placeholder="Start writing…"
            onChange={onChange}
            onNavigate={onNavigate}
            onNotify={onNotify}
            attachFilesRef={attachFilesRef}
          />
        </Suspense>
      </div>
    </div>
  );
}
