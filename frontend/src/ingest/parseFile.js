/**
 * parseFile.js — turns any supported data file into row grids (one per sheet) that the backend's dataset
 * normaliser understands. Everything runs in the browser and is lazy-loaded, so none of it costs anything
 * until someone uploads a data file.
 *
 * Supported data files:
 *   .xlsx .xlsm (every sheet) · .csv .tsv .txt .dat .tab .psv .prn (delimiter auto-detected; UTF-8 / UTF-16 /
 *   windows-1252; fixed-width reports) · .json (records, nested, GST-portal GSTR-2B/2A/1) · .ndjson .jsonl ·
 *   .xml (generic repeating records, Tally vouchers) · .html .htm (tables) · .xls that is really HTML /
 *   SpreadsheetML / text (many bank downloads).
 * Not supported: genuine legacy BIFF .xls (binary) — it needs a parser with a long security history, so the error
 * tells the user to re-save as .xlsx / .csv. PDFs and images go through the document (OCR) path instead.
 */
import { decodeBytes, isOle2, sniffText, fixedWidthToRows, looksFixedWidth, looksSingleColumn, jsonToSheets, ndjsonToSheets, xmlToSheets, htmlToSheets, spreadsheetMlToSheets, normaliseCells } from './grids';

export const DATA_EXTENSIONS = ['csv', 'tsv', 'txt', 'dat', 'tab', 'psv', 'prn', 'xlsx', 'xlsm', 'xls', 'json', 'ndjson', 'jsonl', 'xml', 'html', 'htm'];
export const DOCUMENT_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp'];
export const ACCEPT_ATTR = [...DATA_EXTENSIONS, ...DOCUMENT_EXTENSIONS].map((e) => `.${e}`).join(',');
const MAX_BYTES = 15 * 1024 * 1024;
export const MAX_ROWS = 20000;

export function fileKind(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (DATA_EXTENSIONS.includes(ext)) return 'data';
  if (DOCUMENT_EXTENSIONS.includes(ext) || /^image\//.test(file.type) || file.type === 'application/pdf') return 'document';
  return 'unsupported';
}

const readBytes = async (file) => new Uint8Array(await file.arrayBuffer());
const parseDom = (text, type) => new DOMParser().parseFromString(text, type);

async function parseDelimited(text) {
  if (looksFixedWidth(text)) return fixedWidthToRows(text);
  const Papa = (await import('papaparse')).default;
  const res = Papa.parse(text, { skipEmptyLines: 'greedy', delimitersToGuess: [',', '\t', '|', ';'] });
  const rows = res.data;
  return looksSingleColumn(rows) ? fixedWidthToRows(text) : rows;
}

async function parseXlsx(file) {
  const { default: readXlsxFile } = await import('read-excel-file/browser');
  const sheets = await readXlsxFile(file); // v9: [{ sheet, data }] — dates arrive as Date, numbers as numbers
  const list = Array.isArray(sheets) && sheets[0]?.data ? sheets : [{ sheet: 'Sheet1', data: sheets }];
  return list.map((x, i) => ({ name: String(x.sheet ?? `Sheet${i + 1}`), rows: x.data }));
}

/** Returns [{ name, rows }] — one entry per sheet / table (CSV and JSON give exactly one). */
export async function parseFileToSheets(file) {
  if (file.size > MAX_BYTES) throw new Error('File is larger than 15 MB — split it and upload the parts.');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const bytes = await readBytes(file);

  let sheets;
  if (isOle2(bytes)) throw new Error('This is an old binary Excel (.xls) file. Open it in Excel and use Save As → .xlsx (or CSV), then upload that.');
  if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    if (!['xlsx', 'xlsm', 'xls'].includes(ext)) throw new Error('This looks like a zipped / Office file. Upload the .xlsx or .csv inside it.');
    sheets = await parseXlsx(file);
  } else {
    const text = decodeBytes(bytes);
    const kind = ext === 'json' ? 'json' : ext === 'ndjson' || ext === 'jsonl' ? 'ndjson' : sniffText(text);
    if (kind === 'spreadsheetml') sheets = spreadsheetMlToSheets(parseDom(text, 'application/xml'));
    else if (kind === 'html') sheets = htmlToSheets(parseDom(text, 'text/html'));
    else if (kind === 'xml') sheets = xmlToSheets(parseDom(text, 'application/xml'));
    else if (kind === 'ndjson') sheets = ndjsonToSheets(text);
    else if (kind === 'json') {
      let value;
      try { value = JSON.parse(text); } catch { throw new Error('This JSON file could not be read (is it valid JSON?).'); }
      sheets = jsonToSheets(value);
    } else sheets = [{ name: 'Sheet1', rows: await parseDelimited(text) }];
  }

  sheets = sheets.map((s) => ({ name: s.name, rows: normaliseCells(s.rows) })).filter((s) => s.rows.some((r) => r.some((c) => c !== '')));
  if (!sheets.length) throw new Error('No data rows were found in this file.');
  const total = sheets.reduce((n, s) => n + s.rows.length, 0);
  if (total > MAX_ROWS) throw new Error(`This file has ${total.toLocaleString('en-IN')} rows (limit ${MAX_ROWS.toLocaleString('en-IN')}). Split it by quarter and upload the parts.`);
  return sheets;
}

/** Back-compat: the single best grid (most filled rows). */
export async function parseFileToGrid(file) {
  const sheets = await parseFileToSheets(file);
  const filled = (d) => d.filter((r) => r.some((c) => c !== null && c !== '')).length;
  return [...sheets].sort((a, b) => filled(b.rows) - filled(a.rows))[0].rows;
}
