import { useCallback, useEffect, useRef, useState } from "react";
import { UnlockScreen } from "./components/UnlockScreen";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { SettingsModal } from "./components/SettingsModal";
import { MoveNoteModal } from "./components/MoveNoteModal";
import { WelcomeModal } from "./components/WelcomeModal";
import { QuickCapture } from "./components/QuickCapture";
import { CommandPalette, type Command } from "./components/CommandPalette";
import type { AppSettings, NoteMeta, SearchResult, VaultRecoveryReport } from "../shared/ipc";

const WELCOMED_KEY = "driftleaf:welcomed";
const DAILY_FOLDER = "Daily";

function todayNoteTitle(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function describeRecovery(report: VaultRecoveryReport): string | null {
  const parts: string[] = [];
  if (report.recoveredOrphans.length > 0) {
    parts.push(`recovered ${report.recoveredOrphans.length} note(s) missing from the index`);
  }
  if (report.renamedLegacy.length > 0) {
    parts.push(`renamed ${report.renamedLegacy.length} note file(s) to match their title`);
  }
  if (report.removedDangling.length > 0) {
    parts.push(`removed ${report.removedDangling.length} stale entr${report.removedDangling.length === 1 ? "y" : "ies"}`);
  }
  if (parts.length === 0) return null;
  return `Vault self-check: ${parts.join(", ")}.`;
}

const SEARCH_DEBOUNCE_MS = 200;

export default function App() {
  const [unlocked, setUnlocked] = useState(false);
  const [folders, setFolders] = useState<string[]>([""]);
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("");
  const [selectedNote, setSelectedNote] = useState<NoteMeta | null>(null);
  const [content, setContent] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [settings, setSettings] = useState<AppSettings>({
    lastVaultPath: null,
    theme: "system",
    editorFontSizePx: 15,
    autosaveIntervalMs: 500,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [moveNoteId, setMoveNoteId] = useState<string | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (unlocked) {
      void refreshVaultState();
      void window.driftleaf.settings.read().then((s) => {
        setSettings(s);
        applyTheme(s.theme);
      });
    }
  }, [unlocked, refreshVaultState]);

  // Global hotkey (registered in main/index.ts) works even when the window wasn't focused.
  useEffect(() => {
    return window.driftleaf.events.onQuickCapture(() => {
      if (unlocked) setQuickCaptureOpen(true);
    });
  }, [unlocked]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (unlocked) setCommandPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [unlocked]);

  function applyTheme(theme: AppSettings["theme"]) {
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }

  async function handlePatchSettings(update: Partial<AppSettings>) {
    const next = await window.driftleaf.settings.patch(update);
    setSettings(next);
    if (update.theme !== undefined) applyTheme(update.theme);
  }

  async function openNote(id: string) {
    const note = notes.find((n) => n.id === id) ?? (await findNoteAnywhere(id));
    if (!note) return;
    try {
      const text = await window.driftleaf.notes.read(id);
      setSelectedNote(note);
      setSelectedFolder(note.folderPath);
      setContent(text);
      setSaveStatus("idle");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to open note");
    }
  }

  async function findNoteAnywhere(id: string): Promise<NoteMeta | undefined> {
    const all = await window.driftleaf.notes.list();
    return all.find((n) => n.id === id);
  }

  function scheduleSave(id: string, nextContent: string) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveStatus("saving");
    saveTimer.current = setTimeout(() => {
      void window.driftleaf.notes
        .write(id, nextContent)
        .then(() => setSaveStatus("saved"))
        .catch((err) => {
          setSaveStatus("idle");
          showToast(err instanceof Error ? err.message : "Failed to save note");
        });
    }, settings.autosaveIntervalMs);
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
      void window.driftleaf.notes
        .rename(updated.id, title)
        .catch((err) => showToast(err instanceof Error ? err.message : "Failed to rename note"));
    }, settings.autosaveIntervalMs);
  }

  async function handleCreateNote() {
    try {
      const meta = await window.driftleaf.notes.create(selectedFolder, "Untitled");
      setNotes((prev) => [...prev, meta]);
      setSelectedNote(meta);
      setContent("");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to create note");
    }
  }

  async function handleCreateFolder(folderPath: string) {
    try {
      await window.driftleaf.folders.create(folderPath);
      await refreshVaultState();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to create folder");
    }
  }

  async function handleDeleteNote() {
    if (!selectedNote) return;
    try {
      await window.driftleaf.notes.remove(selectedNote.id);
      setNotes((prev) => prev.filter((n) => n.id !== selectedNote.id));
      setSelectedNote(null);
      setContent("");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to delete note");
    }
  }

  async function handleQuickCapture(text: string) {
    const firstLine = text.split("\n")[0].trim();
    const title = firstLine ? firstLine.slice(0, 60) : "Untitled";
    try {
      const meta = await window.driftleaf.notes.create("", title);
      await window.driftleaf.notes.write(meta.id, text);
      setNotes((prev) => [...prev, { ...meta, title }]);
      showToast(`Saved "${title}"`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save quick capture");
    }
  }

  async function handleOpenDailyNote() {
    const title = todayNoteTitle();
    const existing = notes.find((n) => n.folderPath === DAILY_FOLDER && n.title === title);
    if (existing) {
      await openNote(existing.id);
      return;
    }
    try {
      await window.driftleaf.folders.create(DAILY_FOLDER);
      const meta = await window.driftleaf.notes.create(DAILY_FOLDER, title);
      setNotes((prev) => [...prev, meta]);
      setFolders((prev) => (prev.includes(DAILY_FOLDER) ? prev : [...prev, DAILY_FOLDER].sort()));
      setSelectedFolder(DAILY_FOLDER);
      setSelectedNote(meta);
      setContent("");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to open daily note");
    }
  }

  async function handleImport() {
    const paths = await window.driftleaf.vault.pickImportFiles();
    if (!paths || paths.length === 0) return;
    try {
      const result = await window.driftleaf.notes.import(paths, selectedFolder);
      await refreshVaultState();
      const noun = result.imported === 1 ? "note" : "notes";
      if (result.skipped.length > 0) {
        showToast(`Imported ${result.imported} ${noun}. Skipped: ${result.skipped.join("; ")}`);
      } else {
        showToast(`Imported ${result.imported} ${noun}.`);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Import failed");
    }
  }

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }

  async function handleMoveNote(id: string, targetFolder: string) {
    try {
      const meta = await window.driftleaf.notes.move(id, targetFolder);
      setNotes((prev) => prev.map((n) => (n.id === id ? meta : n)));
      if (selectedNote?.id === id) {
        setSelectedNote(meta);
        setSelectedFolder(targetFolder);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to move note");
    }
  }

  async function handleRenameFolder(oldPath: string, newPath: string) {
    try {
      await window.driftleaf.folders.rename(oldPath, newPath);
      await refreshVaultState();
      if (selectedFolder === oldPath) setSelectedFolder(newPath);
      if (selectedNote?.folderPath === oldPath) {
        setSelectedNote((n) => (n ? { ...n, folderPath: newPath } : n));
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to rename folder");
    }
  }

  async function handleDeleteFolder(folderPath: string) {
    try {
      const deletedIds = await window.driftleaf.folders.delete(folderPath);
      await refreshVaultState();
      if (deletedIds.includes(selectedNote?.id ?? "")) {
        setSelectedNote(null);
        setContent("");
      }
      if (selectedFolder === folderPath || selectedFolder.startsWith(folderPath + "/")) {
        setSelectedFolder("");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to delete folder");
    }
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
    return (
      <UnlockScreen
        onUnlocked={(recovery) => {
          setUnlocked(true);
          if (recovery) {
            const message = describeRecovery(recovery);
            if (message) showToast(message);
          }
          if (!localStorage.getItem(WELCOMED_KEY)) {
            setShowWelcome(true);
            localStorage.setItem(WELCOMED_KEY, "1");
          }
        }}
      />
    );
  }

  const commands: Command[] = [
    { id: "new-note", label: "New note", run: () => void handleCreateNote() },
    { id: "import", label: "Import notes (.md / .zip)…", run: () => void handleImport() },
    { id: "daily-note", label: "Daily note (today)", run: () => void handleOpenDailyNote() },
    { id: "open-settings", label: "Open settings", run: () => setSettingsOpen(true) },
    { id: "lock-vault", label: "Lock vault", run: () => void handleLock() },
    ...folders.map((f): Command => ({
      id: `goto-${f || "root"}`,
      label: `Go to folder: ${f || "All notes"}`,
      run: () => setSelectedFolder(f),
    })),
  ];

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
        onImport={() => void handleImport()}
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        searchResults={searchResults}
        onSelectSearchResult={(id) => void openNote(id)}
        onLock={() => void handleLock()}
        onOpenSettings={() => setSettingsOpen(true)}
        onMoveNote={(id) => setMoveNoteId(id)}
        onRenameFolder={(old, next) => void handleRenameFolder(old, next)}
        onDeleteFolder={(fp) => void handleDeleteFolder(fp)}
      />
      <main className="main">
        {selectedNote ? (
          <Editor
            note={selectedNote}
            content={content}
            saveStatus={saveStatus}
            fontSizePx={settings.editorFontSizePx}
            onChange={handleContentChange}
            onRenameTitle={handleRenameTitle}
            onDelete={() => void handleDeleteNote()}
          />
        ) : (
          <div className="main__empty">Select or create a note to start writing.</div>
        )}
      </main>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onPatch={(update) => void handlePatchSettings(update)}
      />
      {moveNoteId && (
        <MoveNoteModal
          noteTitle={notes.find((n) => n.id === moveNoteId)?.title ?? ""}
          currentFolder={notes.find((n) => n.id === moveNoteId)?.folderPath ?? ""}
          folders={folders}
          onMove={(targetFolder) => void handleMoveNote(moveNoteId, targetFolder)}
          onClose={() => setMoveNoteId(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
      <WelcomeModal open={showWelcome} onClose={() => setShowWelcome(false)} />
      <QuickCapture
        open={quickCaptureOpen}
        onCapture={(text) => void handleQuickCapture(text)}
        onClose={() => setQuickCaptureOpen(false)}
      />
      <CommandPalette
        open={commandPaletteOpen}
        commands={commands}
        onClose={() => setCommandPaletteOpen(false)}
      />
    </div>
  );
}
