import { buildReportHtml } from './printReport';

test('report HTML escapes everything that came from uploaded documents (no script/markup injection)', () => {
  const html = buildReportHtml({
    title: 'Report <script>alert(1)</script>', subtitle: 'Acme "Co" & Sons',
    summaryRows: [['Docs', 5]],
    sections: [{ heading: 'Open <b>exceptions</b>', rows: [['<img src=x onerror=alert(1)>', 'HIGH', "O'Brien & Partners <iframe>"]] }],
  });
  expect(html).not.toMatch(/<script>alert|<img src=x|<iframe>|<b>exceptions/);
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(html).toContain('Acme &quot;Co&quot; &amp; Sons');
  expect(html).toContain('O&#39;Brien &amp; Partners');
});

test('report contains the summary and every section', () => {
  const html = buildReportHtml({ title: 'T', subtitle: 'S', summaryRows: [['Documents processed', 12]], sections: [{ heading: 'Suppliers', rows: [['Acme', '$10.00', '2 open']] }] });
  expect(html).toContain('Documents processed'); expect(html).toContain('Suppliers'); expect(html).toContain('Acme');
  expect(html).toMatch(/no currency conversion/);
});
