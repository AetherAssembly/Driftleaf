import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}

function fuzzyMatch(query: string, label: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  if (l.includes(q)) return true;
  // subsequence fallback so "gpd" matches "Go to Projects/Driftleaf"
  let qi = 0;
  for (let li = 0; li < l.length && qi < q.length; li++) {
    if (l[li] === q[qi]) qi++;
  }
  return qi === q.length;
}

export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => commands.filter((c) => fuzzyMatch(query, c.label)),
    [commands, query],
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function runActive() {
    const cmd = filtered[activeIndex];
    if (cmd) {
      onClose();
      cmd.run();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runActive();
    }
  }

  if (!open) return null;

  return (
    <div className="command-palette__overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="command-palette__panel">
        <input
          ref={inputRef}
          className="command-palette__input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <ul className="command-palette__list">
          {filtered.map((cmd, i) => (
            <li key={cmd.id}>
              <button
                className={`command-palette__item${i === activeIndex ? " command-palette__item--active" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => {
                  onClose();
                  cmd.run();
                }}
              >
                <span>{cmd.label}</span>
                {cmd.hint && <span className="command-palette__item-hint">{cmd.hint}</span>}
              </button>
            </li>
          ))}
          {filtered.length === 0 && <li className="command-palette__empty">No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}
