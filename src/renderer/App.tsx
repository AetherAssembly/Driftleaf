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

  // Content autosave and title-rename autosave each get their own timer/pending-write
  // ref — they used to share one `saveTimer`, so editing the title and then quickly editing
  // the body (or vice versa) would cancel whichever debounced write hadn't fired yet, with
  // no error and no indication the edit was ever dropped.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSave = useRef<{ noteId: string; content: string } | null>(null);
  const renameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRename = useRef<{ noteId: string; title: string } | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every dispatched search query; a response only gets applied if it's still the
  // most recent one in flight, so a slow early keystroke's results can't overwrite a faster
  // later keystroke's results if they resolve out of order.
  const searchRequestId = useRef(0);
  // Mirrors `selectedNote` for reading the *current* selection from inside an async
  // callback after an `await` — the `selectedNote` closure variable itself is only ever as
  // fresh as the render that created the callback.
  const selectedNoteRef = useRef<NoteMeta | null>(null);
  useEffect(() => {
    selectedNoteRef.current = selectedNote;
  }, [selectedNote]);

  // Immediately performs (rather than waits out the debounce for) any save/rename still
  // pending, so switching notes, deleting, or locking never silently drops the last edit
  // still sitting in a debounce window.
  const flushPendingSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const pending = pendingSave.current;
    if (!pending) return;
    pendingSave.current = null;
    try {
      await window.driftleaf.notes.write(pending.noteId, pending.content);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save note");
    }
  }, []);

  const flushPendingRename = useCallback(async () => {
    if (renameTimer.current) {
      clearTimeout(renameTimer.current);
      renameTimer.current = null;
    }
    const pending = pendingRename.current;
    if (!pending) return;
    pendingRename.current = null;
    try {
      await window.driftleaf.notes.rename(pending.noteId, pending.title);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to rename note");
    }
  }, []);

  const flushPendingWrites = useCallback(async () => {
    await Promise.all([flushPendingSave(), flushPendingRename()]);
  }, [flushPendingSave, flushPendingRename]);

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
        if (!unlocked) return;
        // Don't stack the command palette on top of another already-open overlay — none of
        // these native/hand-rolled modals currently stop this window-level listener from
        // firing while they're focused.
        if (settingsOpen || moveNoteId || quickCaptureOpen || showWelcome) return;
        setCommandPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [unlocked, settingsOpen, moveNoteId, quickCaptureOpen, showWelcome]);

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
    await flushPendingWrites();
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
    pendingSave.current = { noteId: id, content: nextContent };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveStatus("saving");
    saveTimer.current = setTimeout(() => {
      const pending = pendingSave.current;
      if (!pending) return;
      pendingSave.current = null;
      void window.driftleaf.notes
        .write(pending.noteId, pending.content)
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
    pendingRename.current = { noteId: updated.id, title };
    if (renameTimer.current) clearTimeout(renameTimer.current);
    renameTimer.current = setTimeout(() => {
      const pending = pendingRename.current;
      if (!pending) return;
      pendingRename.current = null;
      void window.driftleaf.notes
        .rename(pending.noteId, pending.title)
        .catch((err) => showToast(err instanceof Error ? err.message : "Failed to rename note"));
    }, settings.autosaveIntervalMs);
  }

  async function handleCreateNote() {
    await flushPendingWrites();
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
    // Cancel (don't flush) any pending debounced write for this note — it's about to be
    // deleted, so a stale write landing afterward would either fail with a confusing
    // "note not found" error or resurrect a file the user just asked to remove.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (renameTimer.current) clearTimeout(renameTimer.current);
    pendingSave.current = null;
    pendingRename.current = null;
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
    await flushPendingWrites();
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
      // Read the *current* selection via the ref, not the `selectedNote` closure captured
      // when this function was called — if the user switched to a different note while the
      // move was in flight, that stale closure would still match `id` and yank the editor
      // back to a note the user already navigated away from.
      if (selectedNoteRef.current?.id === id) {
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
      // Functional updaters read the latest state at update time regardless of how stale
      // this closure is, so these two don't need the selectedNoteRef workaround above.
      setSelectedFolder((prev) => (prev === oldPath ? newPath : prev));
      setSelectedNote((prev) => (prev?.folderPath === oldPath ? { ...prev, folderPath: newPath } : prev));
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
      searchRequestId.current += 1; // invalidate any response still in flight
      setSearchResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      const requestId = ++searchRequestId.current;
      const results = await window.driftleaf.search.query(text);
      // A faster, later query can resolve before this one — only apply the response if
      // it's still the most recent request, so a slow stale result can't overwrite fresher
      // results already on screen.
      if (requestId === searchRequestId.current) {
        setSearchResults(results);
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  async function handleLock() {
    // Flush before locking, not after — an error toast can only render while `unlocked` is
    // still true (the toast element only exists in that branch below), so any failure here
    // needs to surface before we flip back to the lock screen.
    await flushPendingWrites();
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
