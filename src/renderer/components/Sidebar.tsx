import { useState } from "react";
import { Button, Input, Badge } from "@aetherAssembly/ui";
import type { NoteMeta, SearchResult } from "../../shared/ipc";

interface SidebarProps {
  folders: string[];
  notes: NoteMeta[];
  selectedFolder: string;
  onSelectFolder: (folderPath: string) => void;
  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
  onCreateNote: () => void;
  onCreateFolder: (folderPath: string) => void;
  searchQuery: string;
  onSearchChange: (text: string) => void;
  searchResults: SearchResult[];
  onSelectSearchResult: (id: string) => void;
  onLock: () => void;
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
  searchQuery,
  onSearchChange,
  searchResults,
  onSelectSearchResult,
  onLock,
}: SidebarProps) {
  const [newFolderName, setNewFolderName] = useState("");
  const isSearching = searchQuery.trim().length > 0;

  return (
    <aside className="sidebar">
      <div className="sidebar__search">
        <Input
          placeholder="Search notes…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      {isSearching ? (
        <ul className="sidebar__list">
          {searchResults.map((result) => (
            <li key={result.id}>
              <button
                className={`sidebar__item${result.id === selectedNoteId ? " sidebar__item--active" : ""}`}
                onClick={() => onSelectSearchResult(result.id)}
              >
                <strong>{result.title || "Untitled"}</strong>
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
          <div className="sidebar__folders">
            {folders.map((folder) => (
              <button
                key={folder || "root"}
                className={`sidebar__folder${folder === selectedFolder ? " sidebar__folder--active" : ""}`}
                onClick={() => onSelectFolder(folder)}
              >
                {folderLabel(folder)}
                <Badge variant="default">
                  {notes.filter((n) => n.folderPath === folder).length}
                </Badge>
              </button>
            ))}
          </div>

          <form
            className="sidebar__new-folder"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newFolderName.trim()) return;
              const path = selectedFolder
                ? `${selectedFolder}/${newFolderName.trim()}`
                : newFolderName.trim();
              onCreateFolder(path);
              setNewFolderName("");
            }}
          >
            <Input
              placeholder="New folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
            />
          </form>

          <div className="sidebar__notes-header">
            <span>{folderLabel(selectedFolder)}</span>
            <Button size="sm" variant="secondary" onClick={onCreateNote}>
              + Note
            </Button>
          </div>

          <ul className="sidebar__list">
            {notes
              .filter((n) => n.folderPath === selectedFolder)
              .map((note) => (
                <li key={note.id}>
                  <button
                    className={`sidebar__item${note.id === selectedNoteId ? " sidebar__item--active" : ""}`}
                    onClick={() => onSelectNote(note.id)}
                  >
                    {note.title || "Untitled"}
                  </button>
                </li>
              ))}
          </ul>
        </>
      )}

      <div className="sidebar__footer">
        <Button variant="ghost" size="sm" onClick={onLock}>
          Lock vault
        </Button>
      </div>
    </aside>
  );
}
