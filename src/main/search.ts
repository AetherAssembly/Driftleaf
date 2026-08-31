// In-memory SQLite FTS5 index over the unlocked vault's notes (see docs/ARCHITECTURE.md).
// Rebuilt each session from decrypted content and never written to disk — notes are
// encrypted at rest, so nothing indexable ever touches disk in plaintext.

import { createRequire } from "node:module";
import type { Vault, NoteMeta } from "./vault";
import { listNotes, readNote } from "./vault";

const require = createRequire(__filename);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

export interface SearchIndex {
  db: InstanceType<typeof Database>;
}

export interface SearchResult {
  id: string;
  title: string;
  folderPath: string;
  snippet: string;
}

export function openIndex(): SearchIndex {
  const db = new Database(":memory:");
  db.exec(
    "CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title, folderPath UNINDEXED, content)",
  );
  return { db };
}

export async function buildIndex(index: SearchIndex, vault: Vault): Promise<void> {
  const buildStart = Date.now();
  const noteList = listNotes(vault);
  const noteCount = noteList.length;
  
  if (noteCount === 0) {
    index.db.exec("DELETE FROM notes_fts");
    return;
  }

  // Decrypt all notes in parallel to reduce I/O blocking. Promise.allSettled (not
  // Promise.all) so one corrupted or dangling note doesn't take search down for the whole
  // vault — readNote() already promises corruption is reported per-note rather than losing
  // access to other notes, and the index build should honor that same guarantee.
  const decryptStart = Date.now();
  const settled = await Promise.allSettled(
    noteList.map(async (meta) => ({
      ...meta,
      content: await readNote(vault, meta.id),
    })),
  );
  const decryptedNotes = settled
    .filter(
      (r): r is PromiseFulfilledResult<NoteMeta & { content: string }> => r.status === "fulfilled",
    )
    .map((r) => r.value);
  const failedCount = settled.length - decryptedNotes.length;
  const decryptDuration = Date.now() - decryptStart;

  // Insert all notes in a single transaction for better SQLite performance
  const insertStart = Date.now();
  index.db.exec("DELETE FROM notes_fts");
  index.db.exec("BEGIN TRANSACTION");
  const insert = index.db.prepare(
    "INSERT INTO notes_fts (id, title, folderPath, content) VALUES (?, ?, ?, ?)",
  );
  for (const note of decryptedNotes) {
    insert.run(note.id, note.title, note.folderPath, note.content);
  }
  index.db.exec("COMMIT");
  const insertDuration = Date.now() - insertStart;
  const buildDuration = Date.now() - buildStart;

  if (process.env.DEBUG_SEARCH) {
    console.log(
      `[search] buildIndex: ${buildDuration}ms total (decrypt: ${decryptDuration}ms, insert: ${insertDuration}ms) for ${noteCount} notes (${(buildDuration / noteCount).toFixed(2)}ms/note)${failedCount > 0 ? `, ${failedCount} note(s) skipped (failed to decrypt)` : ""}`,
    );
  }
}

export function reindexNote(index: SearchIndex, meta: NoteMeta, content: string): void {
  // REPLACE INTO is atomic and more efficient than DELETE + INSERT
  index.db
    .prepare("REPLACE INTO notes_fts (id, title, folderPath, content) VALUES (?, ?, ?, ?)")
    .run(meta.id, meta.title, meta.folderPath, content);
}

export function removeFromIndex(index: SearchIndex, id: string): void {
  index.db.prepare("DELETE FROM notes_fts WHERE id = ?").run(id);
}

// Build an FTS5 MATCH expression from free-text input. Each word becomes a quoted
// prefix term so user input can't break out into FTS5 query syntax (NOT/AND/columns/etc).
function toMatchQuery(query: string): string {
  const words = query.trim().split(/\s+/).filter(Boolean);
  return words.map((w) => `"${w.replace(/"/g, "")}"*`).join(" ");
}

export function search(index: SearchIndex, query: string): SearchResult[] {
  const searchStart = Date.now();
  const matchQuery = toMatchQuery(query);
  if (!matchQuery) return [];
  const rows = index.db
    .prepare(
      `SELECT id, title, folderPath, snippet(notes_fts, 3, '<mark>', '</mark>', '…', 12) AS snippet
       FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT 50`,
    )
    .all(matchQuery) as SearchResult[];
  const searchDuration = Date.now() - searchStart;
  if (process.env.DEBUG_SEARCH) {
    console.log(`[search] query "${query}": ${searchDuration}ms, ${rows.length} results`);
  }
  return rows;
}
