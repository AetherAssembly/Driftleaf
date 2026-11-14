import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../lib/focusTrap";
import type { NoteMeta, SearchResult } from "../../shared/ipc";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  commands: Command[];
  // Notes are matched by title here and by content through `onSearchNotes` (the same
  // full-text index the sidebar search uses), so Ctrl/Cmd+K reaches any note in the branch.
  notes: NoteMeta[];
  onOpenNote: (id: string) => void;
  onSearchNotes: (query: string) => Promise<SearchResult[]>;
  onClose: () => void;
}

const MAX_TITLE_MATCHES = 20;
const MAX_CONTENT_MATCHES = 10;
const CONTENT_SEARCH_DEBOUNCE_MS = 150;

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

export function CommandPalette({
  open,
  commands,
  notes,
  onOpenNote,
  onSearchNotes,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [contentMatches, setContentMatches] = useState<SearchResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Only the most recent content search may land; see handleSearchChange in App.tsx for the
  // same guard on the sidebar search.
  const searchRequestId = useRef(0);
  // This overlay is a plain positioned <div>, not a native <dialog> — without a trap, Tab
  // can move focus into the sidebar/editor hidden behind it, and focus never returns to
  // whatever triggered it (Ctrl+K) on close.
  useFocusTrap(panelRef, { active: open, onEscape: onClose });

  const trimmed = query.trim();

  useEffect(() => {
    const requestId = ++searchRequestId.current;
    if (!open || !trimmed) {
      setContentMatches([]);
      return;
    }
    const timer = setTimeout(() => {
      onSearchNotes(trimmed).then(
        (results) => {
          if (requestId === searchRequestId.current) setContentMatches(results);
        },
        () => {
          // Title matches still work; a failed content search just adds nothing.
          if (requestId === searchRequestId.current) setContentMatches([]);
        },
      );
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // onSearchNotes is recreated by the parent on every render; depending on it would
    // re-run the search each time the parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, trimmed]);

  const items = useMemo((): Command[] => {
    const matchedCommands = commands.filter((c) => fuzzyMatch(query, c.label));
    if (!trimmed) return matchedCommands;

    const lowered = trimmed.toLowerCase();
    const titleOf = (note: NoteMeta) => note.title || "Untitled";
    const containing = notes.filter((note) => titleOf(note).toLowerCase().includes(lowered));
    // The loose subsequence match is only useful once there is enough typed to be selective.
    const loose =
      trimmed.length >= 3
        ? notes.filter((note) => !containing.includes(note) && fuzzyMatch(trimmed, titleOf(note)))
        : [];
    const titleMatches = [...containing, ...loose].slice(0, MAX_TITLE_MATCHES);
    const shown = new Set(titleMatches.map((note) => note.id));

    return [
      ...matchedCommands,
      ...titleMatches.map(
        (note): Command => ({
          id: `note:${note.id}`,
          label: titleOf(note),
          hint: note.folderPath ? `Note in ${note.folderPath}` : "Note",
          run: () => onOpenNote(note.id),
        }),
      ),
      ...contentMatches
        .filter((result) => !shown.has(result.id))
        .slice(0, MAX_CONTENT_MATCHES)
        .map(
          (result): Command => ({
            id: `match:${result.id}`,
            label: result.title || "Untitled",
            hint: "Matches note text",
            run: () => onOpenNote(result.id),
          }),
        ),
    ];
  }, [commands, notes, contentMatches, query, trimmed, onOpenNote]);

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

  // Results arriving later can shorten the list under the highlighted row.
  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(items.length - 1, 0)));
  }, [items.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".command-palette__item--active")
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function runActive() {
    const item = items[activeIndex];
    if (item) {
      onClose();
      item.run();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
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
      <div ref={panelRef} className="command-palette__panel">
        <input
          ref={inputRef}
          className="command-palette__input"
          placeholder="Search notes or type a command…"
          aria-label="Search notes and commands"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <ul ref={listRef} className="command-palette__list">
          {items.map((item, i) => (
            <li key={item.id}>
              <button
                className={`command-palette__item${i === activeIndex ? " command-palette__item--active" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => {
                  onClose();
                  item.run();
                }}
              >
                <span>{item.label}</span>
                {item.hint && <span className="command-palette__item-hint">{item.hint}</span>}
              </button>
            </li>
          ))}
          {items.length === 0 && (
            <li className="command-palette__empty">No matching notes or commands</li>
          )}
        </ul>
      </div>
    </div>
  );
}
