/**
 * textDetectorEngine.js — uses the browser's native Shape Detection
 * API (window.TextDetector) to read text out of an image. This is the
 * fastest, zero-download option, but it's Chrome/Edge (Chromium)
 * only — Safari and Firefox don't implement it, so
 * tesseractEngine.js exists as the fallback for those.
 *
 * Known limitation, stated plainly: TextDetector.detect() doesn't
 * return a confidence score at all (unlike Tesseract.js) — the API
 * simply doesn't expose one. CONFIDENCE below is a fixed heuristic,
 * not a measurement. This matters because ocr_confidence_threshold
 * (default 0.75, see db/schema.sql) is compared against whatever this
 * produces — a fixed value here means that threshold check is
 * effectively bypassed whenever this engine is the one that ran. If
 * that turns out to matter for your reconciliation accuracy, the
 * honest fix is weighting confidence some other way (e.g. how many
 * fields extraction actually finds), not inventing a fake per-line
 * number this API can't give you.
 */
const ASSUMED_CONFIDENCE = 0.9;

export function isTextDetectorSupported() {
  return typeof window !== 'undefined' && 'TextDetector' in window;
}

/**
 * source: an ImageBitmap, HTMLCanvasElement, HTMLImageElement, or Blob.
 * Returns { lines: [{ text, confidence }] } or null if nothing was
 * detected (never throws for "no text found" — only for a genuine
 * engine error, which the caller should catch and fall back from).
 */
export async function runTextDetector(source) {
  if (!isTextDetectorSupported()) return null;

  // eslint-disable-next-line no-undef
  const detector = new window.TextDetector();
  const detections = await detector.detect(source);
  if (!detections || detections.length === 0) return null;

  const lines = detections
    .map((d) => (d.rawValue || '').trim())
    .filter((text) => text !== '')
    .map((text) => ({ text, confidence: ASSUMED_CONFIDENCE }));

  return lines.length > 0 ? { lines, engine: 'text-detector' } : null;
}
