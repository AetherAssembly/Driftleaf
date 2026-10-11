import { useState } from "react";
import { Button } from "@aetherAssembly/ui";
import type { CanvasItem, DatabaseMeta, NoteMeta } from "../../shared/ipc";

interface CanvasViewProps {
  items: CanvasItem[];
  notes: NoteMeta[];
  databases: DatabaseMeta[];
  onUpdate: (items: CanvasItem[]) => void;
  onOpenNote: (id: string) => void;
  onOpenDatabase: (id: string) => void;
}

export function CanvasView({
  items,
  notes,
  databases,
  onUpdate,
  onOpenNote,
  onOpenDatabase,
}: CanvasViewProps) {
  const [selectedNoteId, setSelectedNoteId] = useState("");
  const [selectedDatabaseId, setSelectedDatabaseId] = useState("");

  function add(kind: CanvasItem["kind"], targetId: string) {
    if (!targetId || items.some((item) => item.kind === kind && item.targetId === targetId)) return;
    const column = items.length % 3;
    const row = Math.floor(items.length / 3);
    const item: CanvasItem = {
      id: crypto.randomUUID(),
      kind,
      targetId,
      x: 48 + column * 310,
      y: 48 + row * 225,
    };
    onUpdate([...items, item]);
    if (kind === "note") setSelectedNoteId("");
    else setSelectedDatabaseId("");
  }

  function moveItem(id: string, event: React.DragEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(10_000, event.clientX - bounds.left + event.currentTarget.scrollLeft));
    const y = Math.max(0, Math.min(10_000, event.clientY - bounds.top + event.currentTarget.scrollTop));
    onUpdate(items.map((item) => (item.id === id ? { ...item, x, y } : item)));
  }

  const draggedItem = (event: React.DragEvent<HTMLDivElement>) =>
    event.dataTransfer.getData("application/driftleaf-canvas-item");

  return (
    <section className="canvas-view" aria-label="Workspace canvas">
      <header className="canvas-view__header">
        <div>
          <span className="settings__eyebrow">YOUR WORKSPACE</span>
          <h1>Canvas</h1>
          <p>Arrange notes and database views into a visual workspace. Drag cards to move them.</p>
        </div>
        <div className="canvas-view__add">
          <label>
            <span>Add a note</span>
            <select
              value={selectedNoteId}
              onChange={(event) => setSelectedNoteId(event.target.value)}
              aria-label="Choose a note to add"
            >
              <option value="">Choose note…</option>
              {notes
                .filter(
                  (note) => !items.some((item) => item.kind === "note" && item.targetId === note.id),
                )
                .map((note) => (
                  <option key={note.id} value={note.id}>
                    {note.title || "Untitled"}
                  </option>
                ))}
            </select>
          </label>
          <Button
            variant="secondary"
            size="sm"
            disabled={!selectedNoteId}
            onClick={() => add("note", selectedNoteId)}
          >
            Add note
          </Button>
          <label>
            <span>Add a database</span>
            <select
              value={selectedDatabaseId}
              onChange={(event) => setSelectedDatabaseId(event.target.value)}
              aria-label="Choose a database to add"
            >
              <option value="">Choose database…</option>
              {databases
                .filter(
                  (database) =>
                    !items.some(
                      (item) => item.kind === "database" && item.targetId === database.id,
                    ),
                )
                .map((database) => (
                  <option key={database.id} value={database.id}>
                    {database.title}
                  </option>
                ))}
            </select>
          </label>
          <Button
            variant="secondary"
            size="sm"
            disabled={!selectedDatabaseId}
            onClick={() => add("database", selectedDatabaseId)}
          >
            Add database
          </Button>
        </div>
      </header>
      <div
        className="canvas-view__scroller"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const id = draggedItem(event);
          if (id) moveItem(id, event);
        }}
      >
        <div className="canvas-view__stage">
          {items.map((item) => {
            const note = item.kind === "note" ? notes.find((entry) => entry.id === item.targetId) : null;
            const database =
              item.kind === "database"
                ? databases.find((entry) => entry.id === item.targetId)
                : null;
            if (!note && !database) return null;
            return (
              <article
                key={item.id}
                className={`canvas-card${item.kind === "database" ? " canvas-card--database" : ""}`}
                style={{ left: item.x, top: item.y }}
                draggable
                onDragStart={(event) =>
                  event.dataTransfer.setData("application/driftleaf-canvas-item", item.id)
                }
              >
                <div className="canvas-card__handle" aria-label="Drag to reposition">
                  <span aria-hidden="true">⠿</span>
                  {item.kind === "note" ? "NOTE" : "DATABASE VIEW"}
                </div>
                <div className="canvas-card__body">
                  <strong>{note?.title ?? database?.title}</strong>
                  <small>{note ? note.folderPath || "All notes" : "Saved database view"}</small>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      note ? onOpenNote(note.id) : database && onOpenDatabase(database.id)
                    }
                  >
                    Open
                  </Button>
                </div>
                <button
                  className="canvas-card__remove"
                  type="button"
                  aria-label={`Remove ${note?.title ?? database?.title} from canvas`}
                  onClick={() => onUpdate(items.filter((entry) => entry.id !== item.id))}
                >
                  ×
                </button>
              </article>
            );
          })}
          {items.length === 0 && (
            <div className="canvas-view__empty">
              <span aria-hidden="true">✦</span>
              <strong>Give your ideas some room</strong>
              <p>Add notes and databases above, then arrange them into a visual workspace.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
