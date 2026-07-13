import { useCallback, useEffect, useRef, useState } from "react";
import { UnlockScreen } from "./components/UnlockScreen";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import type { NoteMeta, SearchResult } from "../shared/ipc";

const SAVE_DEBOUNCE_MS = 500;
const SEARCH_DEBOUNCE_MS = 200;

export default function App() {
  const [unlocked, setUnlocked] = useState(false);
  const [folders, setFolders] = useState<string[]>([""]);
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("");
  const [selectedNote, setSelectedNote] = useState<NoteMeta | null>(null);
  const [content, setContent] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshVaultState = useCallback(async () => {
    const [folderList, noteList] = await Promise.all([
      window.driftleaf.notes.listFolders(),
      window.driftleaf.notes.list(),
    ]);
    setFolders(folderList);
    setNotes(noteList);
  }, []);

  useEffect(() => {
    if (unlocked) void refreshVaultState();
  }, [unlocked, refreshVaultState]);

  async function openNote(id: string) {
    const note = notes.find((n) => n.id === id) ?? (await findNoteAnywhere(id));
    if (!note) return;
    const text = await window.driftleaf.notes.read(id);
    setSelectedNote(note);
    setSelectedFolder(note.folderPath);
    setContent(text);
  }

  async function findNoteAnywhere(id: string): Promise<NoteMeta | undefined> {
    const all = await window.driftleaf.notes.list();
    return all.find((n) => n.id === id);
  }

  function scheduleSave(id: string, nextContent: string) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void window.driftleaf.notes.write(id, nextContent);
    }, SAVE_DEBOUNCE_MS);
  }

  function handleContentChange(next: string) {
    setContent(next);
    if (selectedNote) scheduleSave(selectedNote.id, next);
  }

  function handleRenameTitle(title: string) {
    if (!selectedNote) return;
    const updated = { ...selectedNote, title };
    setSelectedNote(updated);
    setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void window.driftleaf.notes.rename(updated.id, title);
    }, SAVE_DEBOUNCE_MS);
  }

  async function handleCreateNote() {
    const meta = await window.driftleaf.notes.create(selectedFolder, "Untitled");
    setNotes((prev) => [...prev, meta]);
    setSelectedNote(meta);
    setContent("");
  }

  async function handleCreateFolder(folderPath: string) {
    await window.driftleaf.folders.create(folderPath);
    await refreshVaultState();
  }

  async function handleDeleteNote() {
    if (!selectedNote) return;
    await window.driftleaf.notes.remove(selectedNote.id);
    setNotes((prev) => prev.filter((n) => n.id !== selectedNote.id));
    setSelectedNote(null);
    setContent("");
  }

  function handleSearchChange(text: string) {
    setSearchQuery(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!text.trim()) {
      setSearchResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      const results = await window.driftleaf.search.query(text);
      setSearchResults(results);
    }, SEARCH_DEBOUNCE_MS);
  }

  async function handleLock() {
    await window.driftleaf.vault.lock();
    setUnlocked(false);
    setSelectedNote(null);
    setContent("");
    setSearchQuery("");
    setSearchResults([]);
  }

  if (!unlocked) {
    return <UnlockScreen onUnlocked={() => setUnlocked(true)} />;
  }

  return (
    <div className="app">
      <Sidebar
        folders={folders}
        notes={notes}
        selectedFolder={selectedFolder}
        onSelectFolder={setSelectedFolder}
        selectedNoteId={selectedNote?.id ?? null}
        onSelectNote={(id) => void openNote(id)}
        onCreateNote={() => void handleCreateNote()}
        onCreateFolder={(path) => void handleCreateFolder(path)}
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        searchResults={searchResults}
        onSelectSearchResult={(id) => void openNote(id)}
        onLock={() => void handleLock()}
      />
      <main className="main">
        {selectedNote ? (
          <Editor
            note={selectedNote}
            content={content}
            onChange={handleContentChange}
            onRenameTitle={handleRenameTitle}
            onDelete={() => void handleDeleteNote()}
          />
        ) : (
          <div className="main__empty">Select or create a note to start writing.</div>
        )}
      </main>
    </div>
  );
}
