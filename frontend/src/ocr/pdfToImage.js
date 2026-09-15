/**
 * pdfToImage.js — rasterizes a PDF's first page to a canvas, since
 * neither the Shape Detection API nor Tesseract.js can read a PDF
 * directly (both need an image). This is the client-side equivalent
 * of what PyMuPDF did in the now-removed AWS Lambda (see
 * backend-cloudflare/src/pipelines/ocr.ts's header comment).
 *
 * Only the first page is rasterized. Multi-page invoices/statements
 * are rare for the single-document upload flow this feeds; if that
 * turns out to matter, extend renderFirstPageToCanvas to loop over
 * pdf.numPages and merge the OCR lines from each page.
 */
import * as pdfjsLib from 'pdfjs-dist';

// pdfjs-dist needs its worker file served as a static asset. Create
// React App's webpack config (react-scripts 5) doesn't reliably
// support the `new URL(..., import.meta.url)` / `?url` bundler tricks
// other build tools use for this without ejecting, so the worker file
// is copied into public/ instead (see public/pdf.worker.min.mjs) and
// referenced by its served path. If you upgrade the pdfjs-dist
// dependency, re-copy node_modules/pdfjs-dist/build/pdf.worker.min.mjs
// to public/pdf.worker.min.mjs to match.
pdfjsLib.GlobalWorkerOptions.workerSrc = `${process.env.PUBLIC_URL || ''}/pdf.worker.min.mjs`;

const RENDER_SCALE = 2; // higher = sharper text for OCR, at the cost of more CPU/memory

export async function isPdf(file) {
  return file.type === 'application/pdf' || file.name?.toLowerCase().endsWith('.pdf');
}

/**
 * Returns an HTMLCanvasElement with the PDF's first page rendered onto
 * it, or throws if the file isn't a valid PDF pdf.js can parse.
 */
export async function pdfFirstPageToCanvas(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: RENDER_SCALE });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');

  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}
