import { useState } from "react";
import { Button, Input, Badge, Modal } from "@aetherAssembly/ui";
import DOMPurify from "dompurify";
import type { DatabaseMeta, NoteMeta, SearchResult } from "../../shared/ipc";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

function SidebarActionIcon({
  name,
}: {
  name: "graph" | "canvas" | "import" | "folder";
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === "graph" && (
        <>
          <path d="m5 5 10 3M5 15l10-3" />
          <circle cx="4" cy="4.5" r="2" />
          <circle cx="16" cy="10" r="2" />
          <circle cx="4" cy="15.5" r="2" />
        </>
      )}
      {name === "canvas" && (
        <>
          <rect x="2.5" y="3" width="7" height="6" rx="1" />
          <rect x="11.5" y="3" width="6" height="10" rx="1" />
          <rect x="2.5" y="11" width="7" height="6" rx="1" />
        </>
      )}
      {name === "import" && (
        <>
          <path d="M10 2.5v10M6.5 9l3.5 3.5L13.5 9M3 13v3.5A1.5 1.5 0 0 0 4.5 18h11a1.5 1.5 0 0 0 1.5-1.5V13" />
        </>
      )}
      {name === "folder" && (
        <>
          <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h4l2 2h6A1.5 1.5 0 0 1 17.5 7.5v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z" />
          <path d="M10 8.5v5M7.5 11h5" />
        </>
      )}
    </svg>
  );
}

interface SidebarProps {
  folders: string[];
  notes: NoteMeta[];
  databases: DatabaseMeta[];
  selectedFolder: string;
  onSelectFolder: (folderPath: string) => void;
  selectedNoteId: string | null;
  selectedDatabaseId: string | null;
  onSelectNote: (id: string) => void;
  onSelectDatabase: (id: string) => void;
  onCreateNote: () => void;
  onCreateDatabase: (title: string) => void;
  onCreateFolder: (folderPath: string) => void;
  onImport: () => void;
  searchQuery: string;
  onSearchChange: (text: string) => void;
  searchResults: SearchResult[];
  onSelectSearchResult: (id: string) => void;
  onLock: () => void;
  onOpenSettings: () => void;
  onOpenExtensions: () => void;
  graphOpen: boolean;
  canvasOpen: boolean;
  onOpenGraph: () => void;
  onOpenCanvas: () => void;
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
  databases,
  selectedFolder,
  onSelectFolder,
  selectedNoteId,
  selectedDatabaseId,
  onSelectNote,
  onSelectDatabase,
  onCreateNote,
  onCreateDatabase,
  onCreateFolder,
  onImport,
  searchQuery,
  onSearchChange,
  searchResults,
  onSelectSearchResult,
  onLock,
  onOpenSettings,
  onOpenExtensions,
  graphOpen,
  canvasOpen,
  onOpenGraph,
  onOpenCanvas,
  onMoveNote,
  onRenameFolder,
  onDeleteFolder,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem("driftleaf:sidebar-collapsed") === "true",
  );
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
  const [creatingDatabase, setCreatingDatabase] = useState(false);
  const [newDatabaseName, setNewDatabaseName] = useState("");
  const [keyboardFocusedNoteIndex, setKeyboardFocusedNoteIndex] = useState<number | null>(null);
  const isSearching = searchQuery.trim().length > 0;

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("driftleaf:sidebar-collapsed", String(next));
      return next;
    });
  }

  const visibleNotes = isSearching
    ? (searchResults.map((r) => notes.find((n) => n.id === r.id)).filter(Boolean) as NoteMeta[])
    : notes.filter((n) => n.folderPath === selectedFolder);

  function noteCountForFolder(folder: string) {
    if (folder === "") return notes.length;
    return notes.filter((n) => n.folderPath === folder || n.folderPath.startsWith(folder + "/"))
      .length;
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
      const newIndex =
        keyboardFocusedNoteIndex === null
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

  function submitCreateDatabase(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newDatabaseName.trim();
    if (!title) return;
    onCreateDatabase(title);
    setCreatingDatabase(false);
    setNewDatabaseName("");
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
      : [{ label: "Move to…", onClick: () => onMoveNote(contextMenu.target) }]
    : [];

  return (
    <aside className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`}>
      <div className="sidebar__collapse-row">
        {!collapsed && <strong>Driftleaf</strong>}
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? "›" : "‹"}
        </Button>
      </div>
      {!collapsed && <div className="sidebar__content">
      <div className="sidebar__search">
        <Input
          placeholder="Search notes…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={handleSearchKeydown}
          aria-label="Search notes"
        />
      </div>

      <div className="sidebar__quick-actions" role="group" aria-label="Sidebar actions">
        <Button
          variant={graphOpen ? "secondary" : "ghost"}
          size="sm"
          onClick={onOpenGraph}
          aria-label="Open note graph"
          aria-pressed={graphOpen}
          title="Graph"
        >
          <SidebarActionIcon name="graph" />
        </Button>
        <Button
          variant={canvasOpen ? "secondary" : "ghost"}
          size="sm"
          onClick={onOpenCanvas}
          aria-label="Open workspace canvas"
          aria-pressed={canvasOpen}
          title="Canvas"
        >
          <SidebarActionIcon name="canvas" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onImport}
          title="Import Markdown notes and CSV/JSON databases, including from ZIP files"
          aria-label="Import files"
        >
          <SidebarActionIcon name="import" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowNewFolder(true)}
          aria-label="Create new folder"
          title="New folder"
        >
          <SidebarActionIcon name="folder" />
        </Button>
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
                <span className="sidebar__result-folder">{result.folderPath || "Root"}</span>
                <span
                  className="sidebar__snippet"
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(result.snippet, {
                      ALLOWED_TAGS: ["mark"],
                      ALLOWED_ATTR: [],
                    }),
                  }}
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
            <div className="sidebar__notes-header-actions">
              <Button
                size="sm"
                variant="secondary"
                onClick={onCreateNote}
                aria-label="Create new note"
              >
                + Note
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setNewDatabaseName("");
                  setCreatingDatabase(true);
                }}
                aria-label="Create new database"
              >
                + Database
              </Button>
            </div>
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
              (notes.length === 0 && databases.length === 0 ? (
                <li className="sidebar__empty">
                  Your vault is empty. Click &ldquo;+ Note&rdquo; to create your first note.
                </li>
              ) : (
                <li className="sidebar__empty">This folder is empty.</li>
              ))}
          </ul>
          {databases.filter((database) => database.folderPath === selectedFolder).length > 0 && (
            <>
              <div className="sidebar__notes-header">Databases</div>
              <ul className="sidebar__list">
                {databases
                  .filter((database) => database.folderPath === selectedFolder)
                  .map((database) => (
                    <li key={database.id}>
                      <button
                        className={`sidebar__item${database.id === selectedDatabaseId ? " sidebar__item--active" : ""}`}
                        onClick={() => onSelectDatabase(database.id)}
                        aria-label={`${database.title} database`}
                      >
                        {database.title}
                      </button>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </>
      )}
      </div>}

      <div className="sidebar__footer" aria-label="Sidebar actions">
        <Button variant="ghost" size="sm" onClick={onOpenExtensions} aria-label="Open extensions" title="Extensions">
          {collapsed ? "Ex" : "Extensions"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenSettings} aria-label="Open settings" title="Settings">
          {collapsed ? "⚙" : "Settings"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onLock} aria-label="Lock vault" title="Lock vault">
          {collapsed ? "⌑" : "Lock vault"}
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

      <Modal open={!!deletingFolder} onClose={() => setDeletingFolder(null)} title="Delete folder?">
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

      <Modal
        open={creatingDatabase}
        onClose={() => setCreatingDatabase(false)}
        title="Create database"
      >
        <form onSubmit={submitCreateDatabase}>
          <Input
            autoFocus
            label="Database name"
            placeholder="Untitled database"
            value={newDatabaseName}
            onChange={(event) => setNewDatabaseName(event.target.value)}
          />
          <div className="modal-actions">
            <Button variant="ghost" size="sm" onClick={() => setCreatingDatabase(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="submit" disabled={!newDatabaseName.trim()}>
              Create
            </Button>
          </div>
        </form>
      </Modal>
    </aside>
  );
}
