// Renderer-side handling of encrypted attachments: turning a pasted or picked File into an
// attachment in the branch, and turning an `attachment:<id>` reference back into something
// the editor can show. The bytes cross the bridge as base64 (see DriftleafApi.attachments).
import type { AttachmentMeta } from "../../shared/ipc";

// Keep in step with ATTACHMENT_MAX_BYTES in src/main/vault.ts, which is the enforced limit;
// this copy only lets the UI refuse an oversized file before reading it into memory.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const ATTACHMENT_URL =
  /^attachment:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// Raster formats only. SVG is deliberately absent: it is a document format, and although an
// <img> will not run its scripts, there is no reason to render attacker-authored markup
// inline when it can be saved and opened deliberately instead.
const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

export interface LoadedAttachment {
  meta: AttachmentMeta;
  // An object URL for the decrypted bytes when the attachment is an image the editor will
  // show inline; null for every other kind of file.
  imageUrl: string | null;
}

export function attachmentIdFromUrl(url: string): string | null {
  return ATTACHMENT_URL.exec(url.trim())?.[1] ?? null;
}

export function isInlineImage(mimeType: string): boolean {
  return INLINE_IMAGE_TYPES.has(mimeType.toLowerCase());
}

const cache = new Map<string, Promise<LoadedAttachment>>();
const objectUrls = new Set<string>();

async function base64ToBlob(dataBase64: string, mimeType: string): Promise<Blob> {
  // The browser's own decoder, off the main thread, rather than a character loop in JS.
  const response = await fetch(`data:${mimeType};base64,${dataBase64}`);
  return response.blob();
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

// Decrypted image bytes are held as object URLs only while the note showing them is open
// (see releaseAttachments). Loads are shared, so a note that shows one image twice, or
// redraws it on every keystroke, decrypts it once.
export function loadAttachment(id: string): Promise<LoadedAttachment> {
  const key = id.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const loading = (async (): Promise<LoadedAttachment> => {
    const { meta, dataBase64 } = await window.driftleaf.attachments.read(id);
    if (!isInlineImage(meta.mimeType)) return { meta, imageUrl: null };
    const imageUrl = URL.createObjectURL(await base64ToBlob(dataBase64, meta.mimeType));
    objectUrls.add(imageUrl);
    return { meta, imageUrl };
  })();
  cache.set(key, loading);
  // A failed load is not remembered, so the image can appear once the cause is fixed.
  loading.catch(() => {
    if (cache.get(key) === loading) cache.delete(key);
  });
  return loading;
}

// Drops every decrypted image held in memory. Called when the open note changes and when
// the branch locks, so plaintext image data does not outlive the view that needed it.
export function releaseAttachments(): void {
  cache.clear();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
}

export async function addAttachmentFromFile(file: File): Promise<AttachmentMeta> {
  if (file.size === 0) throw new Error(`"${file.name || "That file"}" is empty`);
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `"${file.name || "That file"}" is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`,
    );
  }
  // Pasted screenshots arrive with a generic name or none at all.
  const extension = file.type.startsWith("image/") ? `.${file.type.slice(6).split("+")[0]}` : "";
  const name = file.name || `pasted-image${extension}`;
  return window.driftleaf.attachments.add(
    name,
    file.type || "application/octet-stream",
    await fileToBase64(file),
  );
}

// The Markdown that refers to an attachment: an image for anything shown inline, a plain
// link for every other file.
export function attachmentMarkdown(meta: AttachmentMeta): string {
  const label = meta.name.replace(/[[\]\\]/g, "");
  return isInlineImage(meta.mimeType)
    ? `![${label}](attachment:${meta.id})`
    : `[${label}](attachment:${meta.id})`;
}
