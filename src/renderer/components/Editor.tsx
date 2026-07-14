import { useMemo, useState } from "react";
import { Button, Modal } from "@aetherAssembly/ui";
import type { NoteMeta } from "../../shared/ipc";
import { renderMarkdown } from "../lib/markdown";

interface EditorProps {
  note: NoteMeta;
  content: string;
  saveStatus: "idle" | "saving" | "saved";
  fontSizePx: number;
  onChange: (content: string) => void;
  onRenameTitle: (title: string) => void;
  onDelete: () => void;
}

export function Editor({ note, content, saveStatus, fontSizePx, onChange, onRenameTitle, onDelete }: EditorProps) {
  const [showPreview, setShowPreview] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const html = useMemo(() => renderMarkdown(content), [content]);

  return (
    <div className="editor">
      <div className="editor__toolbar">
        <input
          className="editor__title"
          value={note.title}
          onChange={(e) => onRenameTitle(e.target.value)}
          placeholder="Untitled"
        />
        <div className="editor__toolbar-actions">
          {saveStatus === "saving" && <span className="editor__save-status">Saving…</span>}
          {saveStatus === "saved" && <span className="editor__save-status">Saved</span>}
          <Button variant="ghost" size="sm" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? "Hide preview" : "Show preview"}
          </Button>
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      </div>

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
      <div className={`editor__panes${showPreview ? "" : " editor__panes--single"}`}>
        <textarea
          className="editor__textarea"
          value={content}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Start writing…"
          spellCheck
          style={{ fontSize: fontSizePx }}
        />
        {showPreview ? (
          <div className="editor__preview" dangerouslySetInnerHTML={{ __html: html }} />
        ) : null}
      </div>
    </div>
  );
}
