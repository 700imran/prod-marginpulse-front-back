// Replaces internal/security/random.go's GenerateToken — used for
// team invite tokens and Slack OAuth state.
export function generateToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
