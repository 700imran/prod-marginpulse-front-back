/**
 * parseFile.js — turns any supported data file into a plain row grid
 * (array of arrays) that the backend's dataset normaliser understands.
 * Everything runs in the browser and is lazy-loaded, so none of it
 * costs anything until someone uploads a data file.
 *
 * Supported: .csv .tsv .txt .xlsx .json .xml
 * Not supported: legacy binary .xls (needs a parser with a known
 * security history) — the error tells the user to re-save as .xlsx/.csv.
 */
export const DATA_EXTENSIONS = ['csv', 'tsv', 'txt', 'xlsx', 'json', 'xml'];
export const DOCUMENT_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp'];
export const ACCEPT_ATTR = [...DATA_EXTENSIONS, ...DOCUMENT_EXTENSIONS, 'xls'].map((e) => `.${e}`).join(',');
const MAX_BYTES = 15 * 1024 * 1024;

export function fileKind(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (DATA_EXTENSIONS.includes(ext)) return 'data';
  if (DOCUMENT_EXTENSIONS.includes(ext) || /^image\//.test(file.type) || file.type === 'application/pdf') return 'document';
  if (ext === 'xls') return 'legacy-xls';
  return 'unsupported';
}

function objectsToGrid(list) {
  const keys = [];
  list.forEach((o) => Object.keys(o || {}).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));
  return [keys, ...list.map((o) => keys.map((k) => (o?.[k] !== null && typeof o?.[k] === 'object' ? JSON.stringify(o[k]) : o?.[k] ?? '')))];
}

function findRecordArray(node) {
  if (Array.isArray(node)) return node.length && typeof node[0] === 'object' ? node : null;
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) { const r = findRecordArray(v); if (r) return r; }
  }
  return null;
}

async function parseDelimited(text) {
  const Papa = (await import('papaparse')).default;
  const res = Papa.parse(text.replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy', delimitersToGuess: [',', '\t', '|', ';'] });
  return res.data;
}

export async function parseFileToGrid(file) {
  if (file.size > MAX_BYTES) throw new Error('File is larger than 15 MB — split it and upload the parts.');
  const ext = (file.name.split('.').pop() || '').toLowerCase();

  if (ext === 'xlsx') {
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    const sheets = await readXlsxFile(file); // v9: [{ sheet, data }]; dates arrive as ISO strings/Date, numbers as numbers
    const list = Array.isArray(sheets) && sheets[0]?.data ? sheets : [{ data: sheets }];
    // Use the sheet with the most filled rows (skips empty cover sheets).
    const filled = (d) => d.filter((r) => r.some((c) => c !== null && c !== '')).length;
    return list.map((x) => x.data).sort((a, b) => filled(b) - filled(a))[0] || [];
  }
  if (ext === 'json') {
    const data = JSON.parse(await file.text());
    const list = findRecordArray(data);
    if (!list) throw new Error('JSON must contain an array of records (rows).');
    return objectsToGrid(list);
  }
  if (ext === 'xml') {
    const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('This XML file could not be read.');
    // Rows = the most common repeated child element anywhere in the tree.
    const counts = new Map();
    doc.querySelectorAll('*').forEach((el) => { const p = el.parentElement; if (p) { const k = `${p.tagName}>${el.tagName}`; counts.set(k, (counts.get(k) || 0) + 1); } });
    const [bestKey] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    if (!bestKey) throw new Error('No repeating records found in this XML.');
    const tag = bestKey.split('>')[1];
    const records = [...doc.getElementsByTagName(tag)].map((el) => {
      const o = {};
      [...el.attributes].forEach((a) => { o[a.name] = a.value; });
      [...el.children].forEach((ch) => { if (!ch.children.length) o[ch.tagName] = ch.textContent.trim(); });
      return o;
    });
    return objectsToGrid(records);
  }
  // csv / tsv / txt (delimiter auto-detected)
  return parseDelimited(await file.text());
}
