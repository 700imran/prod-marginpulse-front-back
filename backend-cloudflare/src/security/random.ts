// Replaces internal/security/random.go's GenerateToken — used for
// team invite tokens and Slack OAuth state.
export function generateToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Invite/reset tokens are stored only as a SHA-256 digest: a database leak or
// a read-only SQL mistake can no longer be replayed as a live invite link.
export async function hashToken(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
