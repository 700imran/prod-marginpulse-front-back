/**
 * grids.js — pure converters from "whatever the file contained" to row grids (array of arrays) that the
 * backend's dataset normaliser understands. No file / network access here, so every converter is unit-testable.
 * DOM-based converters take an already-parsed Document (DOMParser in the browser, jsdom in tests).
 */

// ── text decoding ─────────────────────────────────────────────────────────
// Excel's "Unicode Text" export is UTF-16LE; Indian bank CSVs are often windows-1252 (a lone ₹ breaks UTF-8).
export function decodeBytes(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u.length >= 2 && u[0] === 0xff && u[1] === 0xfe) return new TextDecoder('utf-16le').decode(u.subarray(2));
  if (u.length >= 2 && u[0] === 0xfe && u[1] === 0xff) return new TextDecoder('utf-16be').decode(u.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u).replace(/^﻿/, ''); }
  catch { return new TextDecoder('windows-1252').decode(u); }
}

export const isOle2 = (bytes) => bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0; // legacy binary .xls
export const isZip = (bytes) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;

// What is this text, really? (A ".xls" from many banks is an HTML table; Tally exports XML; APIs emit NDJSON.)
export function sniffText(text) {
  const head = text.slice(0, 2000).trimStart();
  if (/^<\?xml[\s\S]*urn:schemas-microsoft-com:office:spreadsheet/i.test(text.slice(0, 1500)) || /^<Workbook[\s>]/i.test(head)) return 'spreadsheetml';
  if (/^<!doctype html|^<html|^<table|^<body|^<meta/i.test(head)) return 'html';
  if (/^<\?xml|^<[A-Za-z]/.test(head)) return 'xml';
  if (/^[[{]/.test(head)) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > 1 && lines.slice(0, 5).every((l) => /^\{.*\}\s*,?$/.test(l.trim()))) return 'ndjson';
    return 'json';
  }
  return 'delimited';
}

// Fixed-width reports ("Date   Narration    Debit   Credit" aligned with spaces) have no delimiter at all.
/**
 * Fixed-width report (no delimiter; columns are aligned with spaces). Splitting on "2+ spaces" loses column
 * identity as soon as a cell is empty (a Credit-only row would land under Debit), so we find the real column
 * gutters instead: character positions that are blank on (almost) every table line.
 *  - The header row anchors the columns: any position the header prints on is never a gutter, so a sparse column
 *    (e.g. one single credit in the whole statement) cannot be mistaken for empty space.
 *  - Banner lines above the header (bank name, account number, period) are ignored when finding gutters, and
 *    total / page-footer lines below it are skipped; ≤5% of the remaining lines may still cross a gutter.
 */
export function fixedWidthToRows(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const splitGap = (l) => l.trim().split(/\s{2,}/);
  const isTableish = (l) => /\S {2,}\S/.test(l);
  const isTotal = (l) => /^\s*(total|grand total|sub ?total|closing|opening|balance (b\/f|c\/f)|page\b)/i.test(l);

  // Header = first multi-token line without digits that is followed by a line with digits.
  let hdr = -1;
  for (let i = 0; i < Math.min(lines.length - 1, 40); i += 1) {
    const t = splitGap(lines[i]);
    if (t.length >= 2 && !t.some((x) => /\d/.test(x)) && /\d/.test(lines[i + 1])) { hdr = i; break; }
  }
  const body = (hdr >= 0 ? lines.slice(hdr) : lines).filter((l) => isTableish(l) && !isTotal(l));
  if (body.length < 2) return lines.map(splitGap);

  const header = hdr >= 0 ? lines[hdr] : '';
  const width = Math.max(...body.map((l) => l.length));
  const allowed = Math.floor(body.length * 0.05);
  const blankAt = (i) => !(header[i] && header[i] !== ' ') && body.reduce((n, l) => n + (l[i] && l[i] !== ' ' ? 1 : 0), 0) <= allowed;
  const runs = [];
  for (let i = 0; i < width;) {
    const gap = blankAt(i);
    let j = i;
    while (j < width && blankAt(j) === gap) j += 1;
    if (!gap) runs.push([i, j]);
    i = j;
  }
  // Merge "columns" separated by a single blank position — that is a space inside a value, not a gutter.
  const cols = [];
  for (const [a, b] of runs) {
    const last = cols[cols.length - 1];
    if (last && a - last[1] < 2) last[1] = b; else cols.push([a, b]);
  }
  if (cols.length < 2) return lines.map(splitGap);
  const padded = (l) => { const t = splitGap(l); return [...t, ...Array(Math.max(0, cols.length - t.length)).fill('')]; };
  // Banner lines (above the header) and total / footer lines are free text — don't let column cuts slice words.
  return lines.map((l, i) => (i < hdr || isTotal(l) ? padded(l) : cols.map(([a], k) => l.slice(a, k + 1 < cols.length ? cols[k + 1][0] : undefined).trim())));
}

/** Delimiter that appears the same (non-zero) number of times on the header line and on ≥80% of lines. */
function hasConsistentDelimiter(lines) {
  const count = (l, d) => l.split(d).length - 1;
  return [',', '\t', '|', ';'].some((d) => {
    const first = count(lines[0], d);
    return first > 0 && lines.filter((l) => count(l, d) === first).length / lines.length >= 0.8;
  });
}

/** True for space-aligned text with no usable delimiter (checked BEFORE a CSV parser can mangle "11,800.00"). */
export function looksFixedWidth(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 60);
  if (lines.length < 2) return false;
  if (hasConsistentDelimiter(lines)) return false;
  return lines.filter((l) => /\S {2,}\S/.test(l)).length / lines.length >= 0.8;
}

export function looksSingleColumn(rows) {
  const sample = rows.slice(0, 50).filter((r) => r.length);
  return sample.length >= 2 && sample.filter((r) => r.length === 1).length / sample.length > 0.8;
}

// ── JSON ───────────────────────────────────────────────────────────────────
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function objectsToGrid(list) {
  const keys = [];
  list.forEach((o) => Object.keys(o || {}).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));
  return [keys, ...list.map((o) => keys.map((k) => (o?.[k] !== null && typeof o?.[k] === 'object' ? JSON.stringify(o[k]) : o?.[k] ?? '')))];
}

export function findRecordArray(node) {
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => Array.isArray(x))) return { grid: node };
    return node.length && typeof node[0] === 'object' ? { records: node } : null;
  }
  if (isObj(node)) {
    // Prefer the LONGEST array of records (the data), not the first one found (often a tiny metadata array).
    let best = null;
    for (const v of Object.values(node)) {
      const r = findRecordArray(v);
      const len = r ? (r.records || r.grid).length : 0;
      if (r && (!best || len > (best.records || best.grid).length)) best = r;
    }
    return best;
  }
  return null;
}

// GST-portal JSON (GSTR-2B, GSTR-2A, GSTR-1): suppliers → invoices → items. Flattened to one row per invoice / note.
const GST_SECTIONS = ['b2b', 'b2ba', 'cdnr', 'cdnra', 'cdn', 'cdna'];
function findGstRoot(v, depth = 0) {
  if (!isObj(v) || depth > 4) return null;
  if (GST_SECTIONS.some((k) => Array.isArray(v[k]))) return v;
  for (const x of Object.values(v)) { const r = findGstRoot(x, depth + 1); if (r) return r; }
  return null;
}
const n2 = (x) => (x === undefined || x === null || x === '' ? 0 : Number(x) || 0);
function itemTotals(items) {
  const t = { txval: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const it of items || []) {
    const d = it.itm_det || it;
    t.txval += n2(d.txval); t.igst += n2(d.igst ?? d.iamt); t.cgst += n2(d.cgst ?? d.camt); t.sgst += n2(d.sgst ?? d.samt); t.cess += n2(d.cess ?? d.csamt);
  }
  return t;
}
export function flattenGst(json) {
  const root = findGstRoot(json);
  if (!root) return null;
  const sales = root.cur_gt !== undefined || root.gt !== undefined; // GSTR-1 is the OUTWARD return (customers)
  const header = [sales ? 'GSTIN of recipient' : 'GSTIN of supplier', sales ? 'Customer name' : 'Trade/Legal name', 'Invoice number', 'Invoice type', 'Invoice Date', 'Invoice Value(₹)', 'Taxable Value (₹)', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)'];
  const rows = [header];
  for (const section of GST_SECTIONS) {
    for (const party of root[section] || []) {
      const docs = party.inv || party.nt || party.ntinv || [];
      for (const d of docs) {
        const isNote = section.startsWith('cdn');
        const no = isNote ? (d.ntnum ?? d.nt_num ?? d.inum ?? '') : (d.inum ?? '');
        const kind = isNote ? ({ C: 'Credit note', D: 'Debit note' }[d.typ ?? d.ntty] || 'Credit note') : (d.typ || d.inv_typ || 'Regular');
        const t = itemTotals(d.items || d.itms);
        rows.push([party.ctin ?? '', party.trdnm ?? party.tradeNam ?? party.lgnm ?? '', String(no), kind, d.dt ?? d.idt ?? d.nt_dt ?? '', n2(d.val), t.txval, t.igst, t.cgst, t.sgst, t.cess]);
      }
    }
  }
  return rows.length > 1 ? rows : null;
}

export function jsonToSheets(value) {
  const gst = flattenGst(value);
  if (gst) return [{ name: 'GSTR', rows: gst }];
  const found = findRecordArray(value);
  if (!found) {
    if (isObj(value) && Object.values(value).every((v) => Array.isArray(v) && (v.length === 0 || typeof v[0] !== 'object'))) { // columnar {col: [..]}
      const keys = Object.keys(value); const len = Math.max(0, ...keys.map((k) => value[k].length));
      return [{ name: 'Sheet1', rows: [keys, ...Array.from({ length: len }, (_, i) => keys.map((k) => value[k][i] ?? ''))] }];
    }
    throw new Error('JSON must contain an array of records (rows).');
  }
  return [{ name: 'Sheet1', rows: found.grid || objectsToGrid(found.records) }];
}

export function ndjsonToSheets(text) {
  const list = text.split(/\r?\n/).map((l) => l.trim().replace(/,$/, '')).filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`Line ${i + 1} is not valid JSON.`); }
  });
  return jsonToSheets(list);
}

// ── XML ────────────────────────────────────────────────────────────────────
const textOf = (el, tag) => el.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';

// Tally "Day Book" / voucher export: only purchase-side vouchers are payables.
export function tallyVoucherGrid(doc) {
  const vouchers = [...doc.getElementsByTagName('VOUCHER')];
  if (!vouchers.length) return null;
  const rows = [['Date', 'Voucher Type', 'Voucher No.', 'Party Name', 'Amount', 'Narration']];
  for (const v of vouchers) {
    const type = v.getAttribute('VCHTYPE') || textOf(v, 'VOUCHERTYPENAME');
    if (!/purchase|debit\s*note/i.test(type)) continue;
    const party = textOf(v, 'PARTYLEDGERNAME');
    const entries = [...v.getElementsByTagName('LEDGERENTRIES.LIST'), ...v.getElementsByTagName('ALLLEDGERENTRIES.LIST')];
    const mine = entries.find((e) => textOf(e, 'LEDGERNAME') === party) || entries.find((e) => /yes/i.test(textOf(e, 'ISPARTYLEDGER')));
    const amount = mine ? Math.abs(parseFloat(textOf(mine, 'AMOUNT')) || 0) : Math.max(0, ...entries.map((e) => Math.abs(parseFloat(textOf(e, 'AMOUNT')) || 0)));
    rows.push([textOf(v, 'DATE'), type, textOf(v, 'VOUCHERNUMBER'), party, amount, textOf(v, 'NARRATION')]);
  }
  return rows.length > 1 ? rows : null;
}

export function xmlToSheets(doc) {
  if (doc.querySelector('parsererror')) throw new Error('This XML file could not be read.');
  const tally = tallyVoucherGrid(doc);
  if (tally) return [{ name: 'Vouchers', rows: tally }];
  // Rows = the most common repeated child element anywhere in the tree.
  const counts = new Map();
  doc.querySelectorAll('*').forEach((el) => { const p = el.parentElement; if (p) { const k = `${p.tagName}>${el.tagName}`; counts.set(k, (counts.get(k) || 0) + 1); } });
  const [bestKey] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  if (!bestKey) throw new Error('No repeating records found in this XML.');
  const tag = bestKey.split('>')[1];
  const records = [...doc.getElementsByTagName(tag)].map((el) => {
    const o = {};
    [...el.attributes].forEach((a) => { o[a.name] = a.value; });
    const walk = (node, prefix) => [...node.children].forEach((ch) => {
      if (!ch.children.length) o[prefix + ch.tagName] = ch.textContent.trim();
      else if (prefix === '') walk(ch, `${ch.tagName}.`); // one level of nesting (e.g. <Invoice><Party><Name>)
    });
    walk(el, '');
    return o;
  });
  return [{ name: 'Sheet1', rows: objectsToGrid(records) }];
}

// ── HTML tables & SpreadsheetML (what many bank ".xls" downloads actually are) ──
export function htmlToSheets(doc) {
  const tables = [...doc.getElementsByTagName('table')];
  if (!tables.length) throw new Error('No table found in this HTML file.');
  return tables.map((t, i) => ({
    name: `Table${i + 1}`,
    rows: [...t.getElementsByTagName('tr')].map((tr) => [...tr.children].filter((c) => /^t[dh]$/i.test(c.tagName)).flatMap((c) => {
      const span = Math.min(parseInt(c.getAttribute('colspan') || '1', 10) || 1, 50);
      return [c.textContent.replace(/\s+/g, ' ').trim(), ...Array(span - 1).fill('')];
    })),
  })).filter((s) => s.rows.length > 1);
}

export function spreadsheetMlToSheets(doc) {
  const sheets = [...doc.getElementsByTagName('Worksheet')].map((ws, i) => ({
    name: ws.getAttribute('ss:Name') || ws.getAttribute('Name') || `Sheet${i + 1}`,
    rows: [...ws.getElementsByTagName('Row')].map((row) => {
      const out = [];
      for (const cell of row.getElementsByTagName('Cell')) {
        const idx = parseInt(cell.getAttribute('ss:Index') || cell.getAttribute('Index') || '0', 10);
        while (idx && out.length < idx - 1) out.push('');
        const data = cell.getElementsByTagName('Data')[0];
        const type = data?.getAttribute('ss:Type') || data?.getAttribute('Type');
        const raw = data?.textContent ?? '';
        out.push(type === 'Number' && raw !== '' ? Number(raw) : raw);
      }
      return out;
    }),
  })).filter((s) => s.rows.length > 0);
  if (!sheets.length) throw new Error('No worksheet found in this file.');
  return sheets;
}

// ── dates from XLSX readers ────────────────────────────────────────────────
// Readers hand back JS Dates; depending on the library they are UTC-midnight or local-midnight. Pick whichever
// interpretation lands on a whole day so an Indian (UTC+5:30) browser never shifts every date by one.
export function dateCellToISO(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return d;
  const utcMid = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
  const p = (n) => String(n).padStart(2, '0');
  return utcMid ? `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export const normaliseCells = (rows) => rows.map((r) => r.map((c) => (c instanceof Date ? dateCellToISO(c) : c === null || c === undefined ? '' : c)));
