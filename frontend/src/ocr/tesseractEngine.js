/**
 * tesseractEngine.js — Tesseract.js (WASM, runs entirely in the
 * browser) as the OCR fallback for Safari/Firefox and any other
 * browser without the Shape Detection API. Slower than TextDetector
 * (real OCR, not a native OS text reader) and downloads a language
 * data file (~2-4MB for English) on first use — tesseract.js caches
 * that download itself (IndexedDB) so it's a one-time cost per
 * browser, not per document.
 *
 * Unlike TextDetector, Tesseract.js gives a real per-line confidence
 * score, so this one isn't a heuristic guess like the other engine's.
 */
import { createWorker } from 'tesseract.js';

let workerPromise = null;

// Reused across calls in the same session instead of spinning up a
// new WASM worker per document.
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng');
  }
  return workerPromise;
}

/**
 * source: anything Tesseract.js accepts — a File/Blob, canvas,
 * ImageBitmap, or data URL.
 * Returns { lines: [{ text, confidence }] } or null on no text found.
 */
export async function runTesseract(source) {
  const worker = await getWorker();
  const { data } = await worker.recognize(source);

  const rawLines = data?.lines ?? [];
  const lines = rawLines
    .map((l) => ({ text: (l.text || '').trim(), confidence: Math.max(0, Math.min(1, (l.confidence ?? 0) / 100)) }))
    .filter((l) => l.text !== '');

  if (lines.length > 0) return { lines, engine: 'tesseract' };

  // Some documents don't split cleanly into data.lines depending on
  // page segmentation; fall back to the whole-page text as one line
  // rather than reporting nothing.
  const wholeText = (data?.text || '').trim();
  if (wholeText === '') return null;
  return { lines: [{ text: wholeText, confidence: Math.max(0, Math.min(1, (data?.confidence ?? 0) / 100)) }], engine: 'tesseract' };
}

/**
 * Releases the WASM worker. Not required (the tab closing cleans it up
 * anyway), but useful if a long-lived SPA session wants to free the
 * memory after a batch of uploads.
 */
export async function terminateTesseract() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}
