import { useState } from "react";
import { Button, Input, Badge, Modal } from "@aetherAssembly/ui";
import type { NoteMeta, SearchResult } from "../../shared/ipc";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

interface SidebarProps {
  folders: string[];
  notes: NoteMeta[];
  selectedFolder: string;
  onSelectFolder: (folderPath: string) => void;
  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
  onCreateNote: () => void;
  onCreateFolder: (folderPath: string) => void;
  onImport: () => void;
  searchQuery: string;
  onSearchChange: (text: string) => void;
  searchResults: SearchResult[];
  onSelectSearchResult: (id: string) => void;
  onLock: () => void;
  onOpenSettings: () => void;
  onMoveNote: (id: string) => void;
  onRenameFolder: (oldPath: string, newPath: string) => void;
  onDeleteFolder: (folderPath: string) => void;
}

function folderLabel(folderPath: string): string {
  if (!folderPath) return "All notes";
  return folderPath.split("/").pop() ?? folderPath;
}

export function Sidebar({
  folders,
  notes,
  selectedFolder,
  onSelectFolder,
  selectedNoteId,
  onSelectNote,
  onCreateNote,
  onCreateFolder,
  onImport,
  searchQuery,
  onSearchChange,
  searchResults,
  onSelectSearchResult,
  onLock,
  onOpenSettings,
  onMoveNote,
  onRenameFolder,
  onDeleteFolder,
}: SidebarProps) {
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    type: "folder" | "note";
    target: string;
  } | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingFolder, setDeletingFolder] = useState<string | null>(null);
  const [keyboardFocusedNoteIndex, setKeyboardFocusedNoteIndex] = useState<number | null>(null);
  const isSearching = searchQuery.trim().length > 0;

  const visibleNotes = isSearching
    ? searchResults.map((r) => notes.find((n) => n.id === r.id)).filter(Boolean) as NoteMeta[]
    : notes.filter((n) => n.folderPath === selectedFolder);

  function noteCountForFolder(folder: string) {
    if (folder === "") return notes.length;
    return notes.filter(
      (n) => n.folderPath === folder || n.folderPath.startsWith(folder + "/"),
    ).length;
  }

  function folderDepth(folderPath: string): number {
    if (!folderPath) return 0;
    return folderPath.split("/").length;
  }

  function openFolderContext(e: React.MouseEvent, folder: string) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, type: "folder", target: folder });
  }

  function openNoteContext(e: React.MouseEvent, noteId: string) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, type: "note", target: noteId });
  }

  function handleSearchKeydown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Escape") {
      // Clear search
      onSearchChange("");
      setKeyboardFocusedNoteIndex(null);
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && visibleNotes.length > 0) {
      // Navigate notes list with arrow keys
      e.preventDefault();
      const newIndex = keyboardFocusedNoteIndex === null
        ? 0
        : Math.max(
            0,
            Math.min(
              visibleNotes.length - 1,
              keyboardFocusedNoteIndex + (e.key === "ArrowDown" ? 1 : -1),
            ),
          );
      setKeyboardFocusedNoteIndex(newIndex);
    } else if (e.key === "Enter" && keyboardFocusedNoteIndex !== null) {
      // Select focused note
      e.preventDefault();
      const focusedNote = visibleNotes[keyboardFocusedNoteIndex];
      if (focusedNote) {
        if (isSearching) {
          onSelectSearchResult(focusedNote.id);
        } else {
          onSelectNote(focusedNote.id);
        }
      }
    }
  }

  function startRenameFolder(folder: string) {
    setRenamingFolder(folder);
    setRenameValue(folder.split("/").pop() ?? folder);
  }

  function submitRenameFolder() {
    if (!renamingFolder || !renameValue.trim()) {
      setRenamingFolder(null);
      return;
    }
    const parent = renamingFolder.includes("/")
      ? renamingFolder.slice(0, renamingFolder.lastIndexOf("/"))
      : "";
    const newPath = parent ? `${parent}/${renameValue.trim()}` : renameValue.trim();
    if (newPath !== renamingFolder) onRenameFolder(renamingFolder, newPath);
    setRenamingFolder(null);
  }

  const contextMenuItems: ContextMenuItem[] = contextMenu
    ? contextMenu.type === "folder"
      ? [
          { label: "Rename", onClick: () => startRenameFolder(contextMenu.target) },
          {
            label: "Delete",
            danger: true,
            onClick: () => setDeletingFolder(contextMenu.target),
          },
        ]
      : [
          { label: "Move to…", onClick: () => onMoveNote(contextMenu.target) },
        ]
    : [];

  return (
    <aside className="sidebar">
      <div className="sidebar__search">
        <Input
          placeholder="Search notes…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={handleSearchKeydown}
          aria-label="Search notes"
        />
      </div>

      {isSearching ? (
        <ul className="sidebar__list">
          {searchResults.map((result, index) => (
            <li key={result.id}>
              <button
                className={`sidebar__item${result.id === selectedNoteId ? " sidebar__item--active" : ""}${
                  index === keyboardFocusedNoteIndex ? " sidebar__item--keyboard-focus" : ""
                }`}
                onClick={() => onSelectSearchResult(result.id)}
                aria-label={`${result.title || "Untitled"} in ${result.folderPath || "root"}`}
              >
                <strong>{result.title || "Untitled"}</strong>
                <span className="sidebar__result-folder">
                  {result.folderPath || "Root"}
                </span>
                <span
                  className="sidebar__snippet"
                  dangerouslySetInnerHTML={{ __html: result.snippet }}
                />
              </button>
            </li>
          ))}
          {searchResults.length === 0 ? <li className="sidebar__empty">No matches</li> : null}
        </ul>
      ) : (
        <>
          <div className="sidebar__folders-header">
            <span className="sidebar__section-label">Folders</span>
            <div className="sidebar__folders-header-actions">
              <Button variant="ghost" size="sm" onClick={onImport} title="Import .md or .zip files" aria-label="Import files">
                Import
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowNewFolder(true)} aria-label="Create new folder">
                + Folder
              </Button>
            </div>
          </div>

          <div className="sidebar__folders">
            {folders.map((folder) => (
              <div
                key={folder || "root"}
                className="sidebar__folder-row"
                style={{ paddingLeft: folderDepth(folder) * 12 }}
                onContextMenu={(e) => folder && openFolderContext(e, folder)}
              >
                {renamingFolder === folder ? (
                  <Input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={submitRenameFolder}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitRenameFolder();
                      if (e.key === "Escape") setRenamingFolder(null);
                    }}
                  />
                ) : (
                  <button
                    className={`sidebar__folder${folder === selectedFolder ? " sidebar__folder--active" : ""}`}
                    onClick={() => onSelectFolder(folder)}
                    role="treeitem"
                    aria-expanded={folder === selectedFolder}
                    aria-label={`${folderLabel(folder)} folder`}
                  >
                    {folderLabel(folder)}
                    <Badge variant="default">{noteCountForFolder(folder)}</Badge>
                  </button>
                )}
              </div>
            ))}
          </div>

          {showNewFolder && (
            <form
              className="sidebar__new-folder"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newFolderName.trim()) {
                  setShowNewFolder(false);
                  return;
                }
                const path = selectedFolder
                  ? `${selectedFolder}/${newFolderName.trim()}`
                  : newFolderName.trim();
                onCreateFolder(path);
                setNewFolderName("");
                setShowNewFolder(false);
              }}
            >
              <Input
                autoFocus
                placeholder="Folder name…"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onBlur={() => {
                  if (!newFolderName.trim()) setShowNewFolder(false);
                }}
              />
            </form>
          )}

          <div className="sidebar__notes-header">
            <span>{folderLabel(selectedFolder)}</span>
            <Button size="sm" variant="secondary" onClick={onCreateNote} aria-label="Create new note">
              + Note
            </Button>
          </div>

          <ul className="sidebar__list">
            {notes
              .filter((n) => n.folderPath === selectedFolder)
              .map((note, index) => (
                <li key={note.id}>
                  <button
                    className={`sidebar__item${note.id === selectedNoteId ? " sidebar__item--active" : ""}${
                      index === keyboardFocusedNoteIndex ? " sidebar__item--keyboard-focus" : ""
                    }`}
                    onClick={() => onSelectNote(note.id)}
                    onContextMenu={(e) => openNoteContext(e, note.id)}
                    aria-label={note.title || "Untitled"}
                  >
                    {note.title || "Untitled"}
                  </button>
                </li>
              ))}
            {notes.filter((n) => n.folderPath === selectedFolder).length === 0 &&
              (notes.length === 0 ? (
                <li className="sidebar__empty">
                  Your vault is empty. Click &ldquo;+ Note&rdquo; to create your first note.
                </li>
              ) : (
                <li className="sidebar__empty">This folder is empty.</li>
              ))}
          </ul>
        </>
      )}

      <div className="sidebar__footer">
        <Button variant="ghost" size="sm" onClick={onOpenSettings} aria-label="Open settings">
          Settings
        </Button>
        <Button variant="ghost" size="sm" onClick={onLock} aria-label="Lock vault">
          Lock vault
        </Button>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      <Modal
        open={!!deletingFolder}
        onClose={() => setDeletingFolder(null)}
        title="Delete folder?"
      >
        <p>
          &ldquo;{deletingFolder?.split("/").pop()}&rdquo; and all notes inside it will be
          permanently deleted.
        </p>
        <div className="modal-actions">
          <Button variant="ghost" size="sm" onClick={() => setDeletingFolder(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              if (deletingFolder) onDeleteFolder(deletingFolder);
              setDeletingFolder(null);
            }}
          >
            Yes, delete
          </Button>
        </div>
      </Modal>
    </aside>
  );
}
