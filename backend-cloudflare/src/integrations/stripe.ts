import type { DataConnector, FetchedTransaction } from "./connector";

// Exact port of internal/integrations/stripe.go against Stripe's real
// Payouts API (https://stripe.com/docs/api/payouts) — API-key
// authenticated (Bearer secret key). Stripe Connect's OAuth flow (for a
// platform managing OTHER businesses' accounts) is a different, larger
// feature not implemented here.
export class StripeConnector implements DataConnector {
  provider(): string {
    return "STRIPE";
  }

  async connect(credentials: Record<string, string>): Promise<{ externalAccountId: string; externalAccountName: string }> {
    const secretKey = credentials.secret_key;
    if (!secretKey) throw new Error("secret_key is required");

    const resp = await fetch("https://api.stripe.com/v1/account", { headers: { Authorization: `Bearer ${secretKey}` } });
    if (resp.status === 401) throw new Error("Stripe rejected this secret key");
    if (!resp.ok) throw new Error(`Stripe API returned HTTP ${resp.status}`);

    const account = (await resp.json()) as { id: string; business_name?: string; display_name?: string; email?: string };
    const name = account.business_name || account.display_name || account.email || "";
    return { externalAccountId: account.id, externalAccountName: name };
  }

  async fetchTransactions(credentials: Record<string, string>, sinceISO: string): Promise<FetchedTransaction[]> {
    const secretKey = credentials.secret_key;
    let url = "https://api.stripe.com/v1/payouts?limit=100";
    if (sinceISO) {
      const unix = Math.floor(new Date(`${sinceISO}T00:00:00Z`).getTime() / 1000);
      if (!Number.isNaN(unix)) url += `&arrival_date[gte]=${unix}`;
    }

    const resp = await fetch(url, { headers: { Authorization: `Bearer ${secretKey}` } });
    if (!resp.ok) throw new Error(`Stripe payouts fetch failed: HTTP ${resp.status}`);
    const body = (await resp.json()) as { data: { id: string; amount: number; currency: string; status: string; arrival_date: number }[] };

    return body.data
      .filter((p) => p.status === "paid")
      .map((p) => ({
        externalId: p.id,
        narration: `Stripe payout ${p.id}`,
        date: new Date(p.arrival_date * 1000).toISOString().slice(0, 10),
        amount: p.amount / 100,
        currency: p.currency.toUpperCase(),
      }));
  }
}
