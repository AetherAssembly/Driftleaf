// In-memory SQLite FTS5 index over the unlocked vault's notes (see docs/ARCHITECTURE.md).
// Rebuilt each session from decrypted content and never written to disk — notes are
// encrypted at rest, so nothing indexable ever touches disk in plaintext.

import Database from "better-sqlite3";
import type { Vault, NoteMeta } from "./vault";
import { listNotes, readNote } from "./vault";

export interface SearchIndex {
  db: Database.Database;
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
  index.db.exec("DELETE FROM notes_fts");
  const insert = index.db.prepare(
    "INSERT INTO notes_fts (id, title, folderPath, content) VALUES (?, ?, ?, ?)",
  );
  for (const meta of listNotes(vault)) {
    const content = await readNote(vault, meta.id);
    insert.run(meta.id, meta.title, meta.folderPath, content);
  }
}

export function reindexNote(index: SearchIndex, meta: NoteMeta, content: string): void {
  index.db.prepare("DELETE FROM notes_fts WHERE id = ?").run(meta.id);
  index.db
    .prepare("INSERT INTO notes_fts (id, title, folderPath, content) VALUES (?, ?, ?, ?)")
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
  const matchQuery = toMatchQuery(query);
  if (!matchQuery) return [];
  const rows = index.db
    .prepare(
      `SELECT id, title, folderPath, snippet(notes_fts, 3, '<mark>', '</mark>', '…', 12) AS snippet
       FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT 50`,
    )
    .all(matchQuery) as SearchResult[];
  return rows;
}
