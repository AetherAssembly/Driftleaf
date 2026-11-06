import { lazy, Suspense, useState } from "react";
import { Button, Modal } from "@aetherAssembly/ui";
import type { NoteMeta } from "../../shared/ipc";

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
  onChange: (content: string) => void;
  onRenameTitle: (title: string) => void;
  onDelete: () => void;
  onNavigate: (id: string) => void;
}

export function Editor({
  note,
  notes,
  backlinks,
  mentions,
  content,
  saveStatus,
  fontSizePx,
  onChange,
  onRenameTitle,
  onDelete,
  onNavigate,
}: EditorProps) {
  const [sourceMode, setSourceMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
          <Button variant="ghost" size="sm" onClick={() => setSourceMode((v) => !v)}>
            {sourceMode ? "Live preview" : "Source mode"}
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
          &ldquo;{note.title || "Untitled"}&rdquo; will be permanently deleted. This cannot be
          undone.
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
            Yes, delete
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
            placeholder="Start writing…"
            onChange={onChange}
            onNavigate={onNavigate}
          />
        </Suspense>
      </div>
    </div>
  );
}
