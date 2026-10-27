// Upload validation: extension allow-list + magic-byte check + size cap.
// The client-supplied Content-Type is never trusted; the stored MIME is
// derived from the verified file signature.

const MAX_BYTES = 15 * 1024 * 1024;

interface Kind { mime: string; sigs: number[][] }
const KINDS: Record<string, Kind> = {
  pdf: { mime: "application/pdf", sigs: [[0x25, 0x50, 0x44, 0x46]] },
  png: { mime: "image/png", sigs: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  jpg: { mime: "image/jpeg", sigs: [[0xff, 0xd8, 0xff]] },
  jpeg: { mime: "image/jpeg", sigs: [[0xff, 0xd8, 0xff]] },
  webp: { mime: "image/webp", sigs: [[0x52, 0x49, 0x46, 0x46]] }, // RIFF....WEBP
  tif: { mime: "image/tiff", sigs: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]] },
  tiff: { mime: "image/tiff", sigs: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]] },
  bmp: { mime: "image/bmp", sigs: [[0x42, 0x4d]] },
};

export type UploadVerdict = { ok: true; mime: string } | { ok: false; status: 400 | 413 | 415; error: string };

export function validateUpload(filename: string, size: number, head: Uint8Array): UploadVerdict {
  if (size <= 0) return { ok: false, status: 400, error: "file is empty" };
  if (size > MAX_BYTES) return { ok: false, status: 413, error: "file exceeds 15MB limit" };
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const kind = KINDS[ext];
  if (!kind) return { ok: false, status: 415, error: "unsupported file type — allowed: PDF, PNG, JPG, WEBP, TIFF, BMP (use the dataset import for CSV/XLSX/JSON/XML)" };
  const matches = kind.sigs.some((sig) => sig.every((b, i) => head[i] === b));
  if (!matches) return { ok: false, status: 415, error: "file content does not match its extension" };
  if (ext === "webp" && !(head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50)) {
    return { ok: false, status: 415, error: "file content does not match its extension" };
  }
  return { ok: true, mime: kind.mime };
}

// Strip path separators, quotes, control chars (blocks header injection and
// path tricks); keep it short and printable.
export function safeFilename(name: string): string {
  const cleaned = name.replace(/[\\/\u0000-\u001F\u007F"';<>|:*?]/g, "_").replace(/\.{2,}/g, ".").trim().slice(-120);
  return cleaned || "file";
}
