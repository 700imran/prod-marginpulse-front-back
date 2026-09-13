// Port of internal/integrations/connector.go.
//
// STATUS OF EACH PROVIDER — read before wiring one into a live account:
//   - Razorpay: FULLY IMPLEMENTED, calls the real Settlements API.
//   - Stripe:   FULLY IMPLEMENTED, calls the real Payouts API.
//   - Slack:    FULLY IMPLEMENTED OAuth connect + incoming webhook send.
//   - PayPal, Square, Notion, QuickBooks, Xero, Tally, HubSpot,
//     Salesforce, SAP, NetSuite: NOT implemented — deliberately not
//     mocked. A fake connector that "succeeds" with fabricated
//     transaction data would produce wrong reconciliation results that
//     look correct, which is worse than no button at all in a financial
//     product. See the Go source's stub.go comment for what each of
//     these would actually need (real dev accounts, and for
//     SAP/NetSuite a vendor partnership, not just code).

export interface FetchedTransaction {
  externalId: string;
  narration: string;
  date: string; // ISO YYYY-MM-DD
  amount: number;
  currency: string;
  fee?: number;
}

export interface DataConnector {
  provider(): string;
  connect(credentials: Record<string, string>): Promise<{ externalAccountId: string; externalAccountName: string }>;
  fetchTransactions(credentials: Record<string, string>, sinceISO: string): Promise<FetchedTransaction[]>;
}
