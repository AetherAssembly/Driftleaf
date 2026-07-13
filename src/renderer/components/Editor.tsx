import { useMemo, useState } from "react";
import { Button } from "@aetherAssembly/ui";
import type { NoteMeta } from "../../shared/ipc";
import { renderMarkdown } from "../lib/markdown";

interface EditorProps {
  note: NoteMeta;
  content: string;
  onChange: (content: string) => void;
  onRenameTitle: (title: string) => void;
  onDelete: () => void;
}

export function Editor({ note, content, onChange, onRenameTitle, onDelete }: EditorProps) {
  const [showPreview, setShowPreview] = useState(true);
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
          <Button variant="ghost" size="sm" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? "Hide preview" : "Show preview"}
          </Button>
          <Button variant="danger" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>
      <div className={`editor__panes${showPreview ? "" : " editor__panes--single"}`}>
        <textarea
          className="editor__textarea"
          value={content}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Start writing…"
          spellCheck
        />
        {showPreview ? (
          <div className="editor__preview" dangerouslySetInnerHTML={{ __html: html }} />
        ) : null}
      </div>
    </div>
  );
}
