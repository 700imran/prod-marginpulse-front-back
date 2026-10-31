/**
 * Browser-print report (Save as PDF from the print dialog). Everything dynamic is HTML-escaped: report
 * rows contain supplier names and free-text descriptions that came from uploaded documents.
 */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const table = (rows) => `<table>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;

export function buildReportHtml({ title, subtitle, generatedAt = new Date(), summaryRows = [], sections = [] }) {
  const when = generatedAt instanceof Date && !Number.isNaN(generatedAt.getTime()) ? generatedAt.toLocaleString() : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2a37;margin:32px}
  .brand{color:#0f6e56;font-weight:800;letter-spacing:.3px}
  h1{font-size:22px;margin:4px 0}.sub{color:#6b6b6b;font-size:13px;margin-bottom:18px}
  h2{font-size:15px;margin:22px 0 6px;border-bottom:2px solid #18c496;padding-bottom:4px}
  table{width:100%;border-collapse:collapse;font-size:12.5px}td{padding:6px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top}
  tr td:first-child{font-weight:600}.foot{margin-top:28px;color:#98a2b3;font-size:11px}
  @media print{body{margin:14mm}}
</style></head><body>
<div class="brand">MarginPulse</div><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}${when ? ` · Generated ${esc(when)}` : ''}</div>
<h2>Summary</h2>${table(summaryRows)}
${sections.map((s) => `<h2>${esc(s.heading)}</h2>${table(s.rows || [])}`).join('')}
<div class="foot">Figures are shown as recorded in your ledger; no currency conversion is applied.</div>
</body></html>`;
}

export function printMarginPulseReport(opts) {
  const html = buildReportHtml(opts);
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const cleanup = () => { try { frame.remove(); } catch { /* already gone */ } };
  const doc = frame.contentDocument;
  doc.open(); doc.write(html); doc.close();
  const go = () => {
    try { frame.contentWindow.focus(); frame.contentWindow.print(); } finally { setTimeout(cleanup, 60000); }
  };
  if (doc.readyState === 'complete') go(); else frame.onload = go;
}
