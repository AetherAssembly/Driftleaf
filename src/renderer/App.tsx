import { draftWrites } from "./lib/draft-writes";
import { MigrationNotice } from "./components/MigrationNotice";
import { useCallback, useEffect, useRef, useState } from "react";
import { UnlockScreen } from "./components/UnlockScreen";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { SettingsModal } from "./components/SettingsModal";
import { MoveNoteModal } from "./components/MoveNoteModal";
import { WelcomeModal } from "./components/WelcomeModal";
import { QuickCapture } from "./components/QuickCapture";
import { VaultToolsModal } from "./components/VaultToolsModal";
import { DatabaseView } from "./components/DatabaseView";
import { GraphView } from "./components/GraphView";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { ExtensionsModal } from "./components/ExtensionsModal";
import { UpdateBanner } from "./components/UpdateBanner";
import { CanvasView } from "./components/CanvasView";
import { backlinksFor, unlinkedMentionsFor } from "../shared/note-links";
import type {
  AppSettings,
  CanvasItem,
  CommunityReleaseItem,
  DatabaseMeta,
  ExtensionPermission,
  ExtensionSample,
  ExtensionSummary,
  NoteMeta,
  NoteGraph,
  SearchResult,
  UpdateStatus,
  VaultRecoveryReport,
} from "../shared/ipc";

const WELCOMED_KEY = "driftleaf:welcomed";
const DAILY_FOLDER = "Daily";

function applyTheme(theme: AppSettings["theme"]) {
  const prefersDark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const resolvedTheme =
    theme === "system" ? (prefersDark ? "dark" : "light") : theme;
  document.documentElement.setAttribute("data-theme", resolvedTheme);
  document.documentElement.style.colorScheme = resolvedTheme === "light" ? "light" : "dark";
}

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
    parts.push(
      `removed ${report.removedDangling.length} stale entr${report.removedDangling.length === 1 ? "y" : "ies"}`,
    );
  }
  if (parts.length === 0) return null;
  return `Branch self-check: ${parts.join(", ")}.`;
}

const SEARCH_DEBOUNCE_MS = 200;

export default function App() {
  const [unlocked, setUnlocked] = useState(false);
  const [folders, setFolders] = useState<string[]>([""]);
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [databases, setDatabases] = useState<DatabaseMeta[]>([]);
  const [noteGraph, setNoteGraph] = useState<NoteGraph>({
    nodes: [],
    edges: [],
    unlinkedMentions: [],
  });
  const [canvasItems, setCanvasItems] = useState<CanvasItem[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("");
  const [selectedNote, setSelectedNote] = useState<NoteMeta | null>(null);
  const [selectedDatabaseId, setSelectedDatabaseId] = useState<string | null>(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [extensions, setExtensions] = useState<ExtensionSummary[]>([]);
  const [extensionSamples, setExtensionSamples] = useState<ExtensionSample[]>([]);
  const [communityItems, setCommunityItems] = useState<CommunityReleaseItem[]>([]);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    state: "idle",
    currentVersion: "…",
    availableVersion: null,
    downloadUrl: null,
    checkedAt: null,
    message: "Checking update status…",
    automaticInstall: false,
  });
  const [content, setContent] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [settings, setSettings] = useState<AppSettings>({
    lastVaultPath: null,
    theme: "system",
    editorFontSizePx: 15,
    autosaveIntervalMs: 500,
    checkUpdatesAutomatically: true,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [vaultToolsOpen, setVaultToolsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [moveNoteId, setMoveNoteId] = useState<string | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Independent debounce timers share a durable-in-session draft queue. Failed
  // writes remain dirty, and flushing also waits for already-dispatched writes.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const refreshNoteGraph = useCallback(async () => {
    try {
      setNoteGraph(await window.driftleaf.notes.graph());
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not update note links");
    }
  }, []);

  const flushPendingWrites = useCallback(async (): Promise<boolean> => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (renameTimer.current) clearTimeout(renameTimer.current);
    try {
      await draftWrites.flush();
      setSaveStatus("saved");
      void refreshNoteGraph();
      return true;
    } catch (error) {
      setSaveStatus("idle");
      showToast(`Edits are still unsaved. Retry saving before leaving: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }, [refreshNoteGraph]);

  useEffect(() => window.driftleaf.events.onCloseCancelled(() => {
    document.body.inert = false;
  }), []);

  useEffect(() => window.driftleaf.events.onBeforeClose(async () => {
    document.body.inert = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (renameTimer.current) clearTimeout(renameTimer.current);
    try {
      await draftWrites.flush();
    } catch (error) {
      document.body.inert = false;
      throw error;
    }
  }), []);

  const refreshVaultState = useCallback(async () => {
    const [folderList, noteList, databaseList, canvasList] = await Promise.all([
      window.driftleaf.notes.listFolders(),
      window.driftleaf.notes.list(),
      window.driftleaf.databases.list(),
      window.driftleaf.canvas.read(),
    ]);
    setFolders(folderList);
    setNotes(noteList);
    setDatabases(databaseList);
    setCanvasItems(canvasList);
  }, []);

  useEffect(() => {
    if (unlocked) void refreshVaultState();
    void window.driftleaf.settings.read().then(setSettings);
  }, [unlocked, refreshVaultState]);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.driftleaf.events.onUpdateStatus((next) => {
      if (active) setUpdateStatus(next);
    });
    void window.driftleaf.updates
      .status()
      .then((next) => {
        if (active) setUpdateStatus(next);
      })
      .catch((error: unknown) => {
        if (active) {
          setUpdateStatus((current) => ({
            ...current,
            state: "error",
            message: error instanceof Error ? error.message : String(error),
          }));
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (unlocked) void refreshNoteGraph();
  }, [unlocked, refreshNoteGraph]);

  useEffect(() => {
    applyTheme(settings.theme);
    if (settings.theme !== "system") return;

    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => applyTheme("system");
    systemTheme.addEventListener("change", handleSystemThemeChange);
    return () => systemTheme.removeEventListener("change", handleSystemThemeChange);
  }, [settings.theme]);

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
        if (settingsOpen || vaultToolsOpen || moveNoteId || quickCaptureOpen || showWelcome) return;
        setCommandPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [unlocked, settingsOpen, vaultToolsOpen, moveNoteId, quickCaptureOpen, showWelcome]);

  useEffect(() => {
    const retrySave = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && unlocked) {
        event.preventDefault();
        void flushPendingWrites();
      }
    };
    window.addEventListener("keydown", retrySave);
    return () => window.removeEventListener("keydown", retrySave);
  }, [unlocked, flushPendingWrites]);

  async function handlePatchSettings(update: Partial<AppSettings>) {
    const next = await window.driftleaf.settings.patch(update);
    setSettings(next);
  }

  async function openNote(id: string) {
    if (!(await flushPendingWrites())) return;
    const note = notes.find((n) => n.id === id) ?? (await findNoteAnywhere(id));
    if (!note) return;
    try {
      const text = await window.driftleaf.notes.read(id);
      setGraphOpen(false);
      setCanvasOpen(false);
      setSelectedNote(note);
      setSelectedDatabaseId(null);
      setSelectedFolder(note.folderPath);
      setContent(text);
      setSaveStatus("idle");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to open note");
    }
  }

  async function openGraph() {
    if (!(await flushPendingWrites())) return;
    await refreshNoteGraph();
    setGraphOpen(true);
    setCanvasOpen(false);
    setSelectedDatabaseId(null);
  }

  async function openDatabase(id: string) {
    if (!(await flushPendingWrites())) return;
    setGraphOpen(false);
    setCanvasOpen(false);
    setSelectedNote(null);
    setSelectedDatabaseId(id);
  }

  async function openCanvas() {
    if (!(await flushPendingWrites())) return;
    setGraphOpen(false);
    setCanvasOpen((current) => !current);
    setSelectedNote(null);
    setSelectedDatabaseId(null);
  }

  async function updateCanvas(items: CanvasItem[]) {
    setCanvasItems(items);
    draftWrites.set("canvas", () => window.driftleaf.canvas.update(items));
    try {
      await draftWrites.flush();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not save canvas; changes retained for retry");
    }
  }

  async function findNoteAnywhere(id: string): Promise<NoteMeta | undefined> {
    const all = await window.driftleaf.notes.list();
    return all.find((n) => n.id === id);
  }

  function scheduleSave(id: string, nextContent: string) {
    draftWrites.set(`note:${id}`, () => window.driftleaf.notes.write(id, nextContent));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveStatus("saving");
    saveTimer.current = setTimeout(() => { void flushPendingWrites(); }, settings.autosaveIntervalMs);
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
    draftWrites.set(`title:${updated.id}`, () => window.driftleaf.notes.rename(updated.id, title));
    if (renameTimer.current) clearTimeout(renameTimer.current);
    renameTimer.current = setTimeout(() => { void flushPendingWrites(); }, settings.autosaveIntervalMs);
  }

  async function handleCreateNote() {
    if (!(await flushPendingWrites())) return;
    try {
      const meta = await window.driftleaf.notes.create(selectedFolder, "Untitled");
      setNotes((prev) => [...prev, meta]);
      await refreshNoteGraph();
      setSelectedNote(meta);
      setSelectedDatabaseId(null);
      setContent("");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to create note");
    }
  }

  async function handleCreateDatabase(title: string) {
    if (!(await flushPendingWrites())) return;
    try {
      const database = await window.driftleaf.databases.create(title, selectedFolder);
      setDatabases((previous) => [...previous, database]);
      setSelectedNote(null);
      setSelectedDatabaseId(database.id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to create database");
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
    try {
      await window.driftleaf.notes.remove(selectedNote.id);
      draftWrites.remove(`note:${selectedNote.id}`);
      draftWrites.remove(`title:${selectedNote.id}`);
      setNotes((prev) => prev.filter((n) => n.id !== selectedNote.id));
      await refreshNoteGraph();
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
      await refreshNoteGraph();
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
    if (!(await flushPendingWrites())) return;
    try {
      await window.driftleaf.folders.create(DAILY_FOLDER);
      const meta = await window.driftleaf.notes.create(DAILY_FOLDER, title);
      setNotes((prev) => [...prev, meta]);
      await refreshNoteGraph();
      setFolders((prev) => (prev.includes(DAILY_FOLDER) ? prev : [...prev, DAILY_FOLDER].sort()));
      setSelectedFolder(DAILY_FOLDER);
      setSelectedNote(meta);
      setSelectedDatabaseId(null);
      setContent("");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to open daily note");
    }
  }

  async function handleImport() {
    const paths = await window.driftleaf.vault.pickImportFiles();
    if (!paths || paths.length === 0) return;
    try {
      await draftWrites.flush();
      const result = await window.driftleaf.notes.import(paths, selectedFolder);
      await refreshVaultState();
      await refreshNoteGraph();
      const importedParts: string[] = [];
      if (result.imported > 0) {
        importedParts.push(`${result.imported} ${result.imported === 1 ? "note" : "notes"}`);
      }
      if (result.importedDatabases > 0) {
        importedParts.push(
          `${result.importedDatabases} ${result.importedDatabases === 1 ? "database" : "databases"}`,
        );
      }
      const summary =
        importedParts.length > 0
          ? `Imported ${importedParts.join(" and ")}.`
          : "Nothing was imported.";
      if (result.skipped.length > 0) {
        showToast(`${summary} Skipped: ${result.skipped.join("; ")}`);
      } else {
        showToast(summary);
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

  async function checkForUpdates() {
    try {
      setUpdateStatus(await window.driftleaf.updates.check());
    } catch (error) {
      showToast(`Update check failed: ${String(error)}`);
    }
  }

  async function downloadUpdate() {
    try {
      setUpdateStatus(await window.driftleaf.updates.download());
    } catch (error) {
      showToast(`Update download failed: ${String(error)}`);
    }
  }

  async function installUpdate() {
    try {
      await window.driftleaf.updates.install();
    } catch (error) {
      showToast(`Could not install update: ${String(error)}`);
    }
  }

  async function openUpdateDownload() {
    try {
      await window.driftleaf.updates.openDownload();
    } catch (error) {
      showToast(`Could not open update download: ${String(error)}`);
    }
  }

  async function openExtensions() {
    try {
      const [installed, samples] = await Promise.all([
        window.driftleaf.extensions.list(),
        window.driftleaf.extensions.samples(),
      ]);
      setExtensions(installed);
      setExtensionSamples(samples);
      setExtensionsOpen(true);
      void refreshCommunityCatalog();
    } catch (error) {
      showToast(`Couldn't load extensions: ${String(error)}`);
    }
  }

  async function refreshCommunityCatalog() {
    setCommunityLoading(true);
    setCommunityError(null);
    try {
      const catalog = await window.driftleaf.extensions.community();
      setCommunityItems(catalog.items);
      setCommunityError(catalog.errors.length > 0 ? catalog.errors.join("\n") : null);
    } catch (error) {
      setCommunityError(error instanceof Error ? error.message : String(error));
    } finally {
      setCommunityLoading(false);
    }
  }

  async function installCommunityExtension(assetId: number) {
    try {
      const extension = await window.driftleaf.extensions.installCommunityExtension(assetId);
      setExtensions((current) => [...current, extension]);
      showToast(`Installed ${extension.name}. Review its permissions before running it.`);
    } catch (error) {
      showToast(`Couldn't install community extension: ${String(error)}`);
    }
  }

  async function installCommunityTemplate(assetId: number) {
    try {
      const result = await window.driftleaf.extensions.installCommunityTemplate(assetId);
      await refreshVaultState();
      await refreshNoteGraph();
      showToast(
        `Template imported: ${result.imported} notes, ${result.importedDatabases} databases${
          result.skipped.length ? `; ${result.skipped.length} items skipped` : ""
        }.`,
      );
    } catch (error) {
      showToast(`Couldn't install community template: ${String(error)}`);
    }
  }

  async function installExtensionSample(sampleId: string) {
    try {
      const extension = await window.driftleaf.extensions.installSample(sampleId);
      setExtensions((current) => [...current, extension]);
      showToast(`Added ${extension.name}. Review its permissions before running it.`);
    } catch (error) {
      showToast(`Couldn't add sample extension: ${String(error)}`);
    }
  }

  async function installExtension() {
    try {
      const extension = await window.driftleaf.extensions.install();
      if (!extension) return;
      setExtensions((current) => [...current, extension]);
      showToast(`Installed ${extension.name}. Review its permissions before running it.`);
    } catch (error) {
      showToast(`Couldn't install extension: ${String(error)}`);
    }
  }

  async function changeExtensionPermissions(
    id: string,
    permissions: ExtensionPermission[],
    databaseIds: string[],
  ) {
    try {
      await window.driftleaf.extensions.setPermissions(id, permissions, databaseIds);
      setExtensions((current) =>
        current.map((extension) =>
          extension.id === id ? { ...extension, permissions, databaseIds } : extension,
        ),
      );
    } catch (error) {
      showToast(`Couldn't update extension permissions: ${String(error)}`);
    }
  }

  async function runExtension(id: string) {
    try {
      await window.driftleaf.extensions.run(id);
    } catch (error) {
      showToast(`Couldn't run extension: ${String(error)}`);
    }
  }

  async function removeExtension(id: string) {
    try {
      await window.driftleaf.extensions.remove(id);
      setExtensions((current) => current.filter((extension) => extension.id !== id));
    } catch (error) {
      showToast(`Couldn't remove extension: ${String(error)}`);
    }
  }

  async function handleMoveNote(id: string, targetFolder: string) {
    try {
      const meta = await window.driftleaf.notes.move(id, targetFolder);
      setNotes((prev) => prev.map((n) => (n.id === id ? meta : n)));
      await refreshNoteGraph();
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
      await refreshNoteGraph();
      // Functional updaters read the latest state at update time regardless of how stale
      // this closure is, so these two don't need the selectedNoteRef workaround above.
      setSelectedFolder((prev) => (prev === oldPath ? newPath : prev));
      setSelectedNote((prev) =>
        prev?.folderPath === oldPath ? { ...prev, folderPath: newPath } : prev,
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to rename folder");
    }
  }

  async function handleDeleteFolder(folderPath: string) {
    if (!(await flushPendingWrites())) return;
    try {
      const deletingSelectedDatabase = databases.some(
        (database) =>
          database.id === selectedDatabaseId &&
          (database.folderPath === folderPath || database.folderPath.startsWith(folderPath + "/")),
      );
      const deletedIds = await window.driftleaf.folders.delete(folderPath);
      await refreshVaultState();
      await refreshNoteGraph();
      if (deletingSelectedDatabase) setSelectedDatabaseId(null);
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
    // Prevent new input after the final flush and before the backend lock.
    document.body.inert = true;
    try {
      if (!(await flushPendingWrites())) return;
      await window.driftleaf.vault.lock();
      setUnlocked(false);
      setSelectedNote(null);
      setSelectedDatabaseId(null);
      setContent("");
      setNoteGraph({ nodes: [], edges: [], unlinkedMentions: [] });
      setCanvasItems([]);
      setGraphOpen(false);
      setCanvasOpen(false);
      setSearchQuery("");
      setSearchResults([]);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not lock branch");
    } finally {
      document.body.inert = false;
    }
  }

  if (!unlocked) {
    return (
      <>
        <MigrationNotice />
        <UpdateBanner
          status={updateStatus}
          onDownload={() => void downloadUpdate()}
          onInstall={() => void installUpdate()}
          onOpenDownload={() => void openUpdateDownload()}
        />
        <UnlockScreen
          version={updateStatus.currentVersion}
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
      </>
    );
  }

  const commands: Command[] = [
    { id: "new-note", label: "New note", run: () => void handleCreateNote() },
    {
      id: "import",
      label: "Import notes or databases (.md / .csv / .json / .zip)…",
      run: () => void handleImport(),
    },
    { id: "daily-note", label: "Daily note (today)", run: () => void handleOpenDailyNote() },
    { id: "note-graph", label: "Open note graph", run: () => void openGraph() },
    {
      id: "workspace-canvas",
      label: "Open workspace canvas",
      run: () => { void openCanvas(); },
    },
    { id: "extensions", label: "Open extensions", run: () => void openExtensions() },
    { id: "open-settings", label: "Open settings", run: () => setSettingsOpen(true) },
    { id: "lock-vault", label: "Lock branch", run: () => void handleLock() },
    ...folders.map((f): Command => ({
      id: `goto-${f || "root"}`,
      label: `Go to folder: ${f || "All notes"}`,
      run: () => setSelectedFolder(f),
    })),
  ];
  const backlinkIds = new Set(selectedNote ? backlinksFor(noteGraph, selectedNote.id) : []);
  const mentionIds = new Set(selectedNote ? unlinkedMentionsFor(noteGraph, selectedNote.id) : []);

  return (
    <div className="app">
      <MigrationNotice />
      <UpdateBanner
        status={updateStatus}
        onDownload={() => void downloadUpdate()}
        onInstall={() => void installUpdate()}
        onOpenDownload={() => void openUpdateDownload()}
      />
      <Sidebar
        folders={folders}
        notes={notes}
        databases={databases}
        selectedFolder={selectedFolder}
        onSelectFolder={(folder) => {
          void flushPendingWrites().then((saved) => {
            if (!saved) return;
            setGraphOpen(false);
            setCanvasOpen(false);
            setSelectedFolder(folder);
            setSelectedDatabaseId(null);
          });
        }}
        selectedNoteId={selectedNote?.id ?? null}
        selectedDatabaseId={selectedDatabaseId}
        onSelectNote={(id) => void openNote(id)}
        onSelectDatabase={openDatabase}
        onCreateNote={() => void handleCreateNote()}
        onCreateDatabase={(title) => void handleCreateDatabase(title)}
        onCreateFolder={(path) => void handleCreateFolder(path)}
        onImport={() => void handleImport()}
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        searchResults={searchResults}
        onSelectSearchResult={(id) => void openNote(id)}
        onLock={() => void handleLock()}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenExtensions={() => void openExtensions()}
        graphOpen={graphOpen}
        canvasOpen={canvasOpen}
        onOpenGraph={() => {
          if (graphOpen) setGraphOpen(false);
          else void openGraph();
        }}
        onOpenCanvas={() => { void openCanvas(); }}
        onMoveNote={(id) => setMoveNoteId(id)}
        onRenameFolder={(old, next) => void handleRenameFolder(old, next)}
        onDeleteFolder={(fp) => void handleDeleteFolder(fp)}
      />
      <main className="main">
        {graphOpen ? (
          <GraphView
            graph={noteGraph}
            focusedNoteId={selectedNote?.id ?? null}
            onOpenNote={(id) => void openNote(id)}
          />
        ) : canvasOpen ? (
          <CanvasView
            items={canvasItems}
            notes={notes}
            databases={databases}
            onUpdate={(items) => void updateCanvas(items)}
            onOpenNote={(id) => void openNote(id)}
            onOpenDatabase={openDatabase}
          />
        ) : selectedDatabaseId ? (
          <DatabaseView
            key={selectedDatabaseId}
            databaseId={selectedDatabaseId}
            onRenamed={(meta) =>
              setDatabases((current) => current.map((database) => database.id === meta.id ? meta : database))
            }
            onDeleted={() => {
              setSelectedDatabaseId(null);
              void refreshVaultState();
            }}
          />
        ) : selectedNote ? (
          <Editor
            note={selectedNote}
            notes={notes}
            backlinks={notes.filter((note) => backlinkIds.has(note.id))}
            mentions={notes.filter((note) => mentionIds.has(note.id))}
            onNavigate={(id) => void openNote(id)}
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
        onOpenTools={() => {
          setSettingsOpen(false);
          setVaultToolsOpen(true);
        }}
        settings={settings}
        updateStatus={updateStatus}
        onCheckUpdates={() => void checkForUpdates()}
        onDownloadUpdate={() => void downloadUpdate()}
        onInstallUpdate={() => void installUpdate()}
        onOpenUpdateDownload={() => void openUpdateDownload()}
        onPatch={(update) => void handlePatchSettings(update)}
      />
      <VaultToolsModal
        open={vaultToolsOpen}
        onClose={() => setVaultToolsOpen(false)}
        theme={settings.theme}
        noteCount={notes.length}
      />
      <ExtensionsModal
        open={extensionsOpen}
        extensions={extensions}
        samples={extensionSamples}
        communityItems={communityItems}
        communityLoading={communityLoading}
        communityError={communityError}
        databases={databases}
        onClose={() => setExtensionsOpen(false)}
        onInstall={() => void installExtension()}
        onInstallSample={(sampleId) => void installExtensionSample(sampleId)}
        onRefreshCommunity={() => void refreshCommunityCatalog()}
        onInstallCommunityExtension={(assetId) => void installCommunityExtension(assetId)}
        onInstallCommunityTemplate={(assetId) => void installCommunityTemplate(assetId)}
        onRun={(id) => void runExtension(id)}
        onRemove={(id) => void removeExtension(id)}
        onPermissionsChange={(id, permissions, databaseIds) =>
          void changeExtensionPermissions(id, permissions, databaseIds)
        }
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
