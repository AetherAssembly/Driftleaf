import { mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { BRANCH_LOCK_FILENAME } from "../shared/storage";

const nativeRequire = createRequire(__filename);
const Database = nativeRequire("better-sqlite3") as typeof import("better-sqlite3");

export interface BranchLock {
  rootPath: string;
  release(): void;
}

export async function acquireBranchLock(rootPath: string, create = false): Promise<BranchLock> {
  if (create) await mkdir(rootPath, { recursive: true });
  const canonicalPath = await realpath(rootPath);
  const db = new Database(path.join(canonicalPath, BRANCH_LOCK_FILENAME), { timeout: 0 });
  try {
    // Use SQLite's OS file locks, not a PID file or an expiring lease. The OS
    // releases this transaction even after a crash. Never unlink the file:
    // replacing its inode would let another process acquire a different lock.
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    const code = (error as { code?: string }).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      throw new Error(
        "This branch is already open in another Driftleaf window or process. Lock or close it there first.",
        { cause: error },
      );
    }
    throw error;
  }
  let released = false;
  return {
    rootPath: canonicalPath,
    release() {
      if (released) return;
      db.close();
      released = true;
    },
  };
}
