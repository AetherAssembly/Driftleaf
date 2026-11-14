import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal } from "@aetherAssembly/ui";
import type { AttachmentUsage } from "../../shared/ipc";
import { isInlineImage } from "../lib/attachments";
import { draftWrites } from "../lib/draft-writes";

interface AttachmentsModalProps {
  open: boolean;
  onClose: () => void;
  onOpenNote: (id: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

// A decrypted preview of one image attachment, loaded only once its row scrolls into view so
// opening this screen on a branch with hundreds of images does not decrypt them all at once.
// Its object URL belongs to this component alone and is revoked when the row goes away; the
// editor's own image cache (lib/attachments.ts) is deliberately not shared, because that one
// is released whenever the open note changes.
function Preview({ item }: { item: AttachmentUsage }) {
  const holder = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const image = isInlineImage(item.mimeType);

  useEffect(() => {
    if (!image || !holder.current) return;
    let cancelled = false;
    let created: string | null = null;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      window.driftleaf.attachments
        .read(item.id)
        .then(async ({ meta, dataBase64 }) => {
          const blob = await (await fetch(`data:${meta.mimeType};base64,${dataBase64}`)).blob();
          if (cancelled) return;
          created = URL.createObjectURL(blob);
          setUrl(created);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    });
    observer.observe(holder.current);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (created) URL.revokeObjectURL(created);
    };
  }, [image, item.id]);

  return (
    <div className="attachments__preview" ref={holder} aria-hidden={!url}>
      {url ? (
        <img src={url} alt={`Preview of ${item.name}`} />
      ) : (
        <span>{failed ? "Unreadable" : image ? "…" : (item.name.split(".").pop() ?? "file").slice(0, 5).toUpperCase()}</span>
      )}
    </div>
  );
}

export function AttachmentsModal({ open, onClose, onOpenNote }: AttachmentsModalProps) {
  const [items, setItems] = useState<AttachmentUsage[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AttachmentUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Unsaved edits may be the only place a just-added attachment is referenced.
    await draftWrites.flush().catch(() => {});
    setItems(await window.driftleaf.attachments.listUsage());
  }, []);

  useEffect(() => {
    if (!open) {
      setItems(null);
      return;
    }
    setError(null);
    setStatus(null);
    setConfirming(null);
    refresh().catch((err: unknown) => setError(errorText(err, "Could not list attachments")));
  }, [open, refresh]);

  async function remove(item: AttachmentUsage) {
    setConfirming(null);
    setBusyId(item.id);
    setError(null);
    setStatus(null);
    try {
      await window.driftleaf.attachments.remove(item.id);
      setStatus(`Deleted "${item.name}".`);
      await refresh();
    } catch (err) {
      setError(errorText(err, "Could not delete that attachment"));
    } finally {
      setBusyId(null);
    }
  }

  async function saveCopy(item: AttachmentUsage) {
    setError(null);
    setStatus(null);
    try {
      if (await window.driftleaf.attachments.saveCopy(item.id)) {
        setStatus(`Saved a decrypted copy of "${item.name}".`);
      }
    } catch (err) {
      setError(errorText(err, "Could not save that attachment"));
    }
  }

  const total = (items ?? []).reduce((sum, item) => sum + item.size, 0);

  return (
    <Modal open={open} onClose={onClose} title="Attachments">
      <div className="attachments">
        <p className="attachments__intro">
          Every image and file encrypted into this branch.{" "}
          {items && items.length > 0
            ? `${items.length} attachment(s), ${formatBytes(total)} in total.`
            : null}
        </p>

        {items === null && !error ? (
          <p className="attachments__empty">Loading…</p>
        ) : items && items.length === 0 ? (
          <p className="attachments__empty">This branch has no attachments.</p>
        ) : (
          <ul className="attachments__list" aria-label="Attachments in this branch">
            {(items ?? []).map((item) => (
              <li className="attachments__item" key={item.id}>
                <Preview item={item} />
                <div className="attachments__text">
                  <strong title={item.name}>{item.name}</strong>
                  <span>
                    {formatBytes(item.size)} · added {new Date(item.createdAt).toLocaleDateString()}
                  </span>
                  {item.usedBy.length === 0 ? (
                    <span className="attachments__unused">Not used by any note</span>
                  ) : (
                    <span className="attachments__used">
                      Used by{" "}
                      {item.usedBy.map((note, index) => (
                        <span key={note.id}>
                          {index > 0 ? ", " : ""}
                          {note.trashed ? (
                            `${note.title || "Untitled"} (in Trash)`
                          ) : (
                            <button
                              type="button"
                              className="attachments__note-link"
                              onClick={() => {
                                onClose();
                                onOpenNote(note.id);
                              }}
                            >
                              {note.title || "Untitled"}
                            </button>
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <div className="attachments__actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void saveCopy(item)}
                    aria-label={`Save a copy of ${item.name}`}
                  >
                    Save copy
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyId !== null}
                    loading={busyId === item.id}
                    onClick={() => setConfirming(item)}
                    aria-label={`Delete ${item.name}`}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {confirming && (
          <div className="trash__confirm" role="alertdialog" aria-label="Confirm deleting attachment">
            <p>
              Permanently delete &ldquo;{confirming.name}&rdquo;? This cannot be undone and it
              does not go to Trash.
              {confirming.usedBy.length > 0
                ? ` ${confirming.usedBy.length === 1 ? "One note still uses" : `${confirming.usedBy.length} notes still use`} it (${confirming.usedBy
                    .map((note) => note.title || "Untitled")
                    .join(", ")}) and will show "Attachment unavailable" in its place.`
                : ""}
            </p>
            <div className="modal-actions">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={() => void remove(confirming)}>
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
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
