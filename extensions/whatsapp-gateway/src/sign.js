import { createHmac, timingSafeEqual } from "node:crypto";

/** `t=<unix>,v1=<hex hmac-sha256 of "t.rawBody">` — the same scheme the Worker verifies (billing/upi.ts → verifyTimestampedHmac). */
export const signBody = (secret, rawBody, nowSec = Math.floor(Date.now() / 1000)) =>
  `t=${nowSec},v1=${createHmac("sha256", secret).update(`${nowSec}.${rawBody}`).digest("hex")}`;

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
