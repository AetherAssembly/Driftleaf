// Whole-branch plaintext export: every note as a Markdown file in its folder, every database
// as CSV and JSON, and every attachment as an ordinary file. This is the "you can always
// leave" path, so the output must be readable with no Driftleaf at all. It is the one place
// decrypted content is deliberately written to disk; the caller is responsible for making
// sure the user asked for that and chose the destination.
import { randomUUID } from "node:crypto";
import { access, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import type { PlaintextExportResult } from "../shared/ipc";
import { exportDatabase } from "./database-export";
import {
  listAttachments,
  listDatabases,
  listFolders,
  listNotes,
  pathIsWithin,
  readAttachment,
  readNote,
  branchLabel,
  safeSegment,
  type Vault,
} from "./vault";


function splitExtension(fileName: string): { stem: string; extension: string } {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || fileName.length - dot > 12) return { stem: fileName, extension: "" };
  return { stem: fileName.slice(0, dot), extension: fileName.slice(dot) };
}

// Hands out file names that are unique within a directory, compared case-insensitively so
// the export also unpacks cleanly on case-insensitive filesystems.
class NameRegistry {
  private readonly used = new Map<string, Set<string>>();

  claim(directory: string, stem: string, extension: string): string {
    // The directory is compared the same way as the name: "Case" and "case" are one
    // folder on macOS and Windows, so they must share one set of taken names.
    const key = directory.toLowerCase();
    const names = this.used.get(key) ?? new Set<string>();
    this.used.set(key, names);
    let candidate = `${stem}${extension}`;
    for (let suffix = 2; names.has(candidate.toLowerCase()); suffix++) {
      candidate = `${stem} (${suffix})${extension}`;
    }
    names.add(candidate.toLowerCase());
    return candidate;
  }
}

function exportFolderFor(folderPath: string): string {
  return folderPath
    .split("/")
    .filter(Boolean)
    .map((segment) => safeSegment(segment, "folder"))
    .join("/");
}

// Markdown link targets cannot contain raw spaces or parentheses.
function encodeLinkPath(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment) =>
      segment === ".."
        ? segment
        : encodeURIComponent(segment).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`),
    )
    .join("/");
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/, "Z");
}

export async function exportBranchPlaintext(
  vault: Vault,
  destinationParent: string,
): Promise<PlaintextExportResult> {
  const sourcePath = await realpath(vault.rootPath);
  const destinationPath = await realpath(destinationParent);
  if (pathIsWithin(sourcePath, destinationPath)) {
    throw new Error("Choose an export destination outside the open branch folder");
  }

  const baseName = `Driftleaf-Export-${branchLabel(sourcePath)}-${timestamp()}`;
  let exportName = baseName;
  for (let suffix = 2; ; suffix++) {
    try {
      await access(path.join(destinationPath, `${exportName}.zip`));
      exportName = `${baseName}-${suffix}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  // The export is one .zip holding a single top-level folder of the same name, which is
  // what other notes apps import. The plain files are staged in a hidden work folder beside
  // it, archived into a hidden temporary file, and only that finished archive is renamed
  // into place; the work folder is removed either way.
  const finalPath = path.join(destinationPath, `${exportName}.zip`);
  const workPath = path.join(destinationPath, `.${exportName}.tmp-${randomUUID()}`);
  const temporaryZip = path.join(destinationPath, `.${exportName}.zip.tmp-${randomUUID()}`);

  const names = new NameRegistry();
  const skipped: string[] = [];
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let notes = 0;
  let databases = 0;
  let attachments = 0;

  try {
    await mkdir(workPath);

    // Attachments first, so notes can be rewritten to point at the exported files.
    const attachmentFiles = new Map<string, string>();
    const attachmentMetas = listAttachments(vault);
    if (attachmentMetas.length > 0) await mkdir(path.join(workPath, "attachments"));
    for (const meta of attachmentMetas) {
      try {
        const { data } = await readAttachment(vault, meta.id);
        const { stem, extension } = splitExtension(meta.name);
        const fileName = names.claim(
          "attachments",
          safeSegment(stem, "attachment"),
          safeSegment(extension, "") && extension.startsWith(".") ? extension : "",
        );
        await writeFile(path.join(workPath, "attachments", fileName), data, { flag: "wx" });
        attachmentFiles.set(meta.id.toLowerCase(), `attachments/${fileName}`);
        attachments++;
      } catch (error) {
        skipped.push(`${meta.name} (${reason(error)})`);
      }
    }

    for (const folder of listFolders(vault)) {
      await mkdir(path.join(workPath, ...exportFolderFor(folder).split("/").filter(Boolean)), {
        recursive: true,
      });
    }

    for (const meta of listNotes(vault)) {
      try {
        const folder = exportFolderFor(meta.folderPath);
        const depth = folder ? folder.split("/").length : 0;
        const content = (await readNote(vault, meta.id)).replace(
          /attachment:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
          (whole, id: string) => {
            const exported = attachmentFiles.get(id.toLowerCase());
            return exported ? encodeLinkPath(`${"../".repeat(depth)}${exported}`) : whole;
          },
        );
        const directory = path.join(workPath, ...folder.split("/").filter(Boolean));
        await mkdir(directory, { recursive: true });
        const fileName = names.claim(folder, safeSegment(meta.title, "Untitled"), ".md");
        await writeFile(path.join(directory, fileName), content, { encoding: "utf8", flag: "wx" });
        notes++;
      } catch (error) {
        skipped.push(`${meta.title || "Untitled"} (${reason(error)})`);
      }
    }

    for (const meta of await listDatabases(vault)) {
      try {
        const folder = exportFolderFor(meta.folderPath);
        const directory = path.join(workPath, ...folder.split("/").filter(Boolean));
        await mkdir(directory, { recursive: true });
        const stem = safeSegment(meta.title, "Database");
        for (const format of ["csv", "json"] as const) {
          const { content } = await exportDatabase(vault, meta.id, format);
          const fileName = names.claim(folder, stem, `.${format}`);
          await writeFile(path.join(directory, fileName), content, {
            encoding: "utf8",
            flag: "wx",
          });
        }
        databases++;
      } catch (error) {
        skipped.push(`${meta.title || "Database"} (${reason(error)})`);
      }
    }

    const archive = new AdmZip();
    archive.addLocalFolder(workPath, exportName);
    await new Promise<void>((resolve, reject) =>
      archive.writeZip(temporaryZip, (error) => (error ? reject(error) : resolve())),
    );
    await rename(temporaryZip, finalPath);
  } catch (error) {
    await rm(temporaryZip, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(workPath, { recursive: true, force: true }).catch(() => {});
  }

  return { path: finalPath, notes, databases, attachments, skipped };
}
