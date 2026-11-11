// RFC-4180 quoting + CSV/Excel formula-injection neutralisation.
// A vendor name like `=HYPERLINK("http://evil","click")` or `@SUM(A1:A9)` becomes executable when an
// accountant opens the export in Excel/Sheets. OWASP's rule: prefix cells that begin with = + - @ TAB or CR
// with a single quote. Plain numbers (incl. negatives) are left alone so amounts stay numeric.
const NUMERIC = /^[+-]?\d+(\.\d+)?$/;

export function csvCell(v: unknown): string {
  let s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}
