"""
ocr-service/handler.py — Small Python Lambda wrapping RapidOCR's REAL,
tested rapidocr-onnxruntime package. Invoked synchronously by the Go
worker (internal/pipelines/ocr/ocr.go) via AWS Lambda's Invoke API —
this is the ONLY thing in this repo that runs Python; everything else
stays Go. Kept deliberately tiny and boring: this file's job is "call
RapidOCR's own documented API, return JSON" — no reimplementation of
any OCR logic, since that logic already exists, tested, in the
rapidocr-onnxruntime package itself.

WHY A SEPARATE LAMBDA INSTEAD OF PORTING TO GO:
RapidOCR has no native Go implementation. Porting its detection
(DBNet-style box detection + perspective correction for rotated text)
and recognition (CRNN + CTC decoding) pipeline to Go from scratch, by an
AI assistant with no way to run real images through it and visually
verify the output, would produce code that compiles but has no verified
correctness — a wrong normalization constant or decoding threshold
would silently produce garbage extracted amounts/dates in a financial
app, with no error to signal it. Calling the real, maintained Python
package from a small Lambda avoids that risk entirely.

PDF HANDLING — free/open-source, not a paid cloud OCR call:
RapidOCR's ONNX models operate on raster images, not PDF bytes. Rather
than routing PDFs to a paid per-page cloud API (AWS Textract, Google
Document AI, etc.), PDFs are rasterized right here with PyMuPDF
(`pymupdf`, AGPL-3.0-licensed, free and open source) — pip-installable,
no system packages (poppler, ghostscript) needed, so it keeps the exact
same "pip install, no dnf" reliability property that fixed the original
tesseract/al2023 problem. Multi-page PDFs are rasterized page by page
and every page's OCR lines are concatenated, capped at MAX_PDF_PAGES so
a large PDF can't blow out this Lambda's execution time/memory.

CONTRACT (see internal/pipelines/ocr/ocr.go's invokeOCRLambda):
  Request:  {"file_base64": "<base64-encoded file bytes>",
             "mime_type": "application/pdf" | "image/png" | "image/jpeg" | ...}
  Response: {"lines": [{"text": "...", "confidence": 0.97}, ...]}
            or {"error": "..."} on failure.
"""
import base64
import json

import fitz  # PyMuPDF — pip install only, no system packages
from rapidocr_onnxruntime import RapidOCR

# Loaded once per cold start, reused across warm invocations — the model
# files are small (see Dockerfile comment: ~15-30MB combined) so this
# adds a modest, one-time cold-start cost rather than per-request cost.
_engine = RapidOCR()

# Rasterization DPI — 200 is a reasonable balance between OCR accuracy
# (higher DPI = crisper text = better recognition) and per-page
# time/memory cost inside a Lambda. Bump this if small print on scanned
# invoices is coming back with poor confidence.
RENDER_DPI = 200

# Hard cap on pages processed per PDF — protects this Lambda's
# execution time/memory from an unexpectedly huge upload. Invoices are
# essentially always 1-3 pages; this is generous headroom, not a tight
# limit.
MAX_PDF_PAGES = 5


def _rasterize_pdf(pdf_bytes):
    """Renders each page of a PDF to PNG bytes using PyMuPDF."""
    images = []
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        zoom = RENDER_DPI / 72.0  # PDF points are 72 per inch
        matrix = fitz.Matrix(zoom, zoom)
        page_count = min(doc.page_count, MAX_PDF_PAGES)
        for page_index in range(page_count):
            pixmap = doc.load_page(page_index).get_pixmap(matrix=matrix)
            images.append(pixmap.tobytes("png"))
    finally:
        doc.close()
    return images


def handler(event, context):
    try:
        file_b64 = event.get("file_base64") or event.get("image_base64", "")
        if not file_b64:
            return {"error": "file_base64 is required"}
        mime_type = (event.get("mime_type") or "").lower()

        file_bytes = base64.b64decode(file_b64)

        if "pdf" in mime_type:
            page_images = _rasterize_pdf(file_bytes)
            if not page_images:
                return {"error": "PDF has no pages to process"}
        else:
            page_images = [file_bytes]

        lines = []
        for image_bytes in page_images:
            result, _elapse = _engine(image_bytes)
            if result:
                for _box, text, confidence in result:
                    lines.append({"text": text, "confidence": float(confidence)})

        return {"lines": lines}
    except Exception as e:  # noqa: BLE001 — this Lambda's only job is to
        # never let an unexpected exception surface as a raw 500 to the
        # Go worker's Invoke call; a clean {"error": ...} JSON payload is
        # something ocr.go can log and fall back from gracefully.
        return {"error": "OCR processing failed: {}".format(e)}
