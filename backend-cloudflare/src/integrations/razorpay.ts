import type { DataConnector, FetchedTransaction } from "./connector";

// Exact port of internal/integrations/razorpay.go against Razorpay's
// real Settlements API (https://razorpay.com/docs/api/settlements/) —
// API-key authenticated (Basic Auth with key_id:key_secret), no OAuth.
export class RazorpayConnector implements DataConnector {
  provider(): string {
    return "RAZORPAY";
  }

  async connect(credentials: Record<string, string>): Promise<{ externalAccountId: string; externalAccountName: string }> {
    const { key_id: keyId, key_secret: keySecret } = credentials;
    if (!keyId || !keySecret) throw new Error("key_id and key_secret are required");

    const resp = await fetch("https://api.razorpay.com/v1/settlements?count=1", {
      headers: { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}` },
    });
    if (resp.status === 401) throw new Error("Razorpay rejected these credentials — check the key_id/key_secret");
    if (!resp.ok) throw new Error(`Razorpay API returned HTTP ${resp.status}`);

    const displayId = keyId.length > 12 ? `${keyId.slice(0, 12)}…` : keyId;
    return { externalAccountId: keyId, externalAccountName: displayId };
  }

  async fetchTransactions(credentials: Record<string, string>, sinceISO: string): Promise<FetchedTransaction[]> {
    const { key_id: keyId, key_secret: keySecret } = credentials;
    let url = "https://api.razorpay.com/v1/settlements?count=100";
    if (sinceISO) {
      const unix = Math.floor(new Date(`${sinceISO}T00:00:00Z`).getTime() / 1000);
      if (!Number.isNaN(unix)) url += `&from=${unix}`;
    }

    const resp = await fetch(url, { headers: { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}` } });
    if (!resp.ok) throw new Error(`Razorpay settlements fetch failed: HTTP ${resp.status}`);
    const body = (await resp.json()) as { items: { id: string; amount: number; fees: number; created_at: number; status: string }[] };

    return body.items
      .filter((s) => s.status === "processed") // only completed settlements represent real bank credits
      .map((s) => ({
        externalId: s.id,
        narration: `Razorpay settlement ${s.id}`,
        date: new Date(s.created_at * 1000).toISOString().slice(0, 10),
        amount: s.amount / 100,
        currency: "INR",
        fee: s.fees / 100,
      }));
  }
}
