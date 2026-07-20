import { useEffect, useRef, useState } from "react";
import { Button } from "@aetherAssembly/ui";

interface QuickCaptureProps {
  open: boolean;
  onCapture: (content: string) => void;
  onClose: () => void;
}

// Minimal overlay for the Ctrl+Shift+N global hotkey: no title, no folder picker, just
// text in and Ctrl+Enter to save — friction is the enemy of "jot this down before I forget."
export function QuickCapture({ open, onCapture, onClose }: QuickCaptureProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setText("");
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text]);

  function submit() {
    if (!text.trim()) {
      onClose();
      return;
    }
    onCapture(text);
    onClose();
  }

  if (!open) return null;

  return (
    <div className="quick-capture__overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="quick-capture__panel">
        <textarea
          ref={textareaRef}
          className="quick-capture__textarea"
          placeholder="Jot something down…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="quick-capture__footer">
          <span className="quick-capture__hint">Ctrl/Cmd+Enter to save · Esc to cancel</span>
          <Button variant="primary" size="sm" onClick={submit}>
            Save note
          </Button>
        </div>
      </div>
    </div>
  );
}
