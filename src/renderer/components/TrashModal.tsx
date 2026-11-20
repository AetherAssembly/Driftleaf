import { useCallback, useEffect, useState } from "react";
import { Button, Modal } from "@aetherAssembly/ui";
import type { TrashItem } from "../../shared/ipc";

interface TrashModalProps {
  open: boolean;
  onClose: () => void;
  // Called after anything is restored, so the sidebar, graph, and search reflect it.
  onRestored: () => void;
  // Lets the sidebar keep its Trash count current without a second round trip.
  onCountChange: (count: number) => void;
}

function daysLeft(expiresAt: number): string {
  const days = Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "Removed the next time this branch is unlocked";
  return days === 1 ? "Removed in 1 day" : `Removed in ${days} days`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function TrashModal({ open, onClose, onRestored, onCountChange }: TrashModalProps) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<TrashItem | "all" | null>(null);

  const refresh = useCallback(async () => {
    const list = await window.driftleaf.trash.list();
    setItems(list);
    onCountChange(list.length);
    return list;
  }, [onCountChange]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setStatus(null);
    setConfirming(null);
    setLoading(true);
    refresh()
      .catch((err: unknown) => setError(errorText(err, "Could not load Trash")))
      .finally(() => setLoading(false));
  }, [open, refresh]);

  async function run(key: string, action: () => Promise<string>) {
    setBusyKey(key);
    setError(null);
    setStatus(null);
    try {
      const message = await action();
      await refresh();
      setStatus(message);
    } catch (err) {
      setError(errorText(err, "That did not work"));
      await refresh().catch(() => {});
    } finally {
      setBusyKey(null);
    }
  }

  function restore(item: TrashItem) {
    void run(`${item.kind}:${item.id}`, async () => {
      const before = items.length;
      await window.driftleaf.trash.restore(item.kind, item.id);
      onRestored();
      const after = (await window.driftleaf.trash.list()).length;
      const where = item.folderPath || "All notes";
      // Restoring a database also restores the databases it links to.
      return before - after > 1
        ? `Restored "${item.title || "Untitled"}" and ${before - after - 1} linked database(s).`
        : `Restored "${item.title || "Untitled"}" to ${where}.`;
    });
  }

  function purge(item: TrashItem) {
    setConfirming(null);
    void run(`${item.kind}:${item.id}`, async () => {
      await window.driftleaf.trash.purge(item.kind, item.id);
      return `Permanently deleted "${item.title || "Untitled"}".`;
    });
  }

  function emptyAll() {
    setConfirming(null);
    void run("all", async () => {
      const removed = await window.driftleaf.trash.empty();
      return `Permanently deleted ${removed} item(s).`;
    });
  }

  const busy = busyKey !== null;

  return (
    <Modal open={open} onClose={onClose} title="Trash">
      <div className="trash">
        <p className="trash__intro">
          Deleted notes and databases stay here, still encrypted, for 30 days. Restoring one
          puts it back in the folder it came from.
        </p>

        {loading ? (
          <p className="trash__empty">Loading…</p>
        ) : items.length === 0 ? (
          <p className="trash__empty">Trash is empty.</p>
        ) : (
          <ul className="trash__list" aria-label="Items in Trash">
            {items.map((item) => {
              const title = item.title || "Untitled";
              return (
                <li className="trash__item" key={`${item.kind}:${item.id}`}>
                  <div className="trash__item-text">
                    <strong>{title}</strong>
                    <span>
                      {item.kind === "database" ? "Database" : "Note"} in{" "}
                      {item.folderPath || "All notes"} · deleted{" "}
                      {new Date(item.deletedAt).toLocaleDateString()} · {daysLeft(item.expiresAt)}
                    </span>
                  </div>
                  <div className="trash__item-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      loading={busyKey === `${item.kind}:${item.id}`}
                      onClick={() => restore(item)}
                      aria-label={`Restore ${title}`}
                    >
                      Restore
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirming(item)}
                      aria-label={`Delete ${title} permanently`}
                    >
                      Delete forever
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {confirming && (
          <div className="trash__confirm" role="alertdialog" aria-label="Confirm permanent deletion">
            <p>
              {confirming === "all"
                ? `Permanently delete all ${items.length} item(s) in Trash?`
                : `Permanently delete "${confirming.title || "Untitled"}"?`}{" "}
              This cannot be undone.
            </p>
            <div className="modal-actions">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => (confirming === "all" ? emptyAll() : purge(confirming))}
              >
                Delete permanently
              </Button>
            </div>
          </div>
        )}

        <p className="trash__status" role="status" aria-live="polite">
          {status}
        </p>
        {error && (
          <p className="trash__error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <Button
            variant="danger"
            size="sm"
            disabled={busy || items.length === 0}
            loading={busyKey === "all"}
            onClick={() => setConfirming("all")}
          >
            Empty Trash
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
