import { useMemo, useState } from "react";
import { Button, Modal } from "@aetherAssembly/ui";
import type { NoteMeta } from "../../shared/ipc";
import { renderMarkdown } from "../lib/markdown";

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
  const [showPreview, setShowPreview] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const html = useMemo(() => renderMarkdown(content, notes), [content, notes]);

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
          <div
            className="editor__preview"
            onClick={(event) => {
              const target = event.target;
              if (!(target instanceof Element)) return;
              const link = target.closest("a");
              const match = link?.getAttribute("href")?.match(/^#driftleaf-note=(.+)$/);
              if (match) {
                event.preventDefault();
                onNavigate(decodeURIComponent(match[1]));
              }
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : null}
      </div>
    </div>
  );
}
