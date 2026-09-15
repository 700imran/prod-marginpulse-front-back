/**
 * ocr/index.js — client-side OCR entry point. Replaces the AWS Lambda
 * call the backend used to make (backend-cloudflare/src/pipelines/
 * ocr.ts's header comment explains why: no AWS account for this
 * deployment). Everything happens in the browser; nothing here talks
 * to any server.
 *
 * Strategy: rasterize PDFs to an image first (neither engine reads
 * PDFs directly), then try the native Shape Detection API
 * (TextDetector) since it's fast and needs no download, and fall back
 * to Tesseract.js (WASM) for browsers that don't support it or if it
 * throws. If neither produces anything, return null — the caller
 * (api.js's uploadDocument) treats that exactly like an unsupported
 * browser: the document uploads without extracted fields, for manual
 * correction via the existing correction workflow.
 */
import { isPdf, pdfFirstPageToCanvas } from './pdfToImage';
import { isTextDetectorSupported, runTextDetector } from './textDetectorEngine';
import { runTesseract } from './tesseractEngine';

/**
 * file: the File object the user picked to upload.
 * Returns { lines: [{ text, confidence }], engine } or null.
 * Never throws — any engine failure is caught internally and treated
 * as "OCR unavailable for this file", not a fatal error, since OCR is
 * always a best-effort enhancement on top of the upload, never a
 * blocker for it.
 */
export async function getOcrLines(file) {
  let source = file;
  try {
    if (await isPdf(file)) {
      source = await pdfFirstPageToCanvas(file);
    }
  } catch (e) {
    console.warn('[ocr] PDF rasterization failed, skipping OCR for this file', e);
    return null;
  }

  if (isTextDetectorSupported()) {
    try {
      const result = await runTextDetector(source);
      if (result) return result;
    } catch (e) {
      console.warn('[ocr] TextDetector failed, falling back to Tesseract.js', e);
    }
  }

  try {
    return await runTesseract(source);
  } catch (e) {
    console.warn('[ocr] Tesseract.js failed, uploading without extracted fields', e);
    return null;
  }
}
