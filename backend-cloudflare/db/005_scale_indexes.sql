-- MarginPulse Pro — scale indexes (idempotent; safe to re-run). Mirrored in schema.sql.
-- Found by running EXPLAIN (ANALYZE) on every hot query against a seeded database (1,500 tenants, 3 of them with 30k documents
-- / 60k bank rows each; ~1.8 lakh documents and ~3.6 lakh bank rows in total). Numbers are from that run — see docs/SCALABILITY_CHECKLIST.md.
--
-- Running this on a table that already holds a lot of data: a plain CREATE INDEX blocks writes to the table while it builds.
-- On a live database run each statement on its own with CREATE INDEX CONCURRENTLY (it cannot run inside a transaction block).

-- 1. Foreign keys that had no index on the referencing column. Whenever a parent row (a document or a bank row) is deleted,
--    Postgres runs one lookup per referencing table per row — a sequential scan each time. Measured: deleting 60 documents
--    took 2,959 ms (1,412 + 1,457 + 89 ms of foreign-key checks); with these indexes 2.7 ms. Partial (NOT NULL only), so rows
--    that are never matched/duplicated add nothing to the index and bulk inserts are not slowed (measured: no difference).
create index if not exists idx_documents_duplicate_of   on public.documents         (duplicate_of_document_id)    where duplicate_of_document_id    is not null;
create index if not exists idx_documents_matched_tx     on public.documents         (matched_bank_transaction_id) where matched_bank_transaction_id is not null;
create index if not exists idx_banktx_matched_document  on public.bank_transactions (matched_document_id)        where matched_document_id         is not null;
create index if not exists idx_anomalies_document       on public.anomalies         (document_id)                 where document_id                 is not null;
create index if not exists idx_anomalies_related_tx     on public.anomalies         (related_transaction_id)      where related_transaction_id      is not null;
--    (idx_anomalies_related_tx also serves the "is there already an open anomaly for this bank row" check that runs once per
--    bank row in missing-invoice detection: 1.3 ms → 0.01 ms for a tenant with 1,666 open anomalies.)

-- 2. Duplicate-invoice check (same tenant + vendor + invoice number), run for every processed document. Before: it read the
--    tenant's whole document list (30k rows, 7.3 ms, growing linearly with the tenant); now an index lookup (0.05 ms).
create index if not exists idx_documents_tenant_vendor_invoice on public.documents (tenant_id, vendor_name, invoice_number);

-- 3. Monthly free-plan quota counts (created_at >= start of month) read every row the tenant ever stored. Now only this month's.
--    Measured for a tenant with 60k bank rows: 16.0 ms → 2.5 ms (index-only scan over this month's rows). The documents side
--    already has idx_documents_tenant_created, so only bank_transactions needs a new index.
create index if not exists idx_banktx_tenant_created on public.bank_transactions (tenant_id, created_at);
