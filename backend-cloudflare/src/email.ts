import type { Env } from "./config";

// DELIBERATE PROVIDER CHANGE, not a straight port: internal/email/email.go
// spoke raw SMTP (net/smtp, including a hand-rolled STARTTLS/implicit-TLS
// path) directly over a TCP socket. Workers can open raw TCP sockets via
// `cloudflare:sockets`, but reimplementing the SMTP protocol by hand over
// that socket (EHLO, STARTTLS upgrade, AUTH PLAIN, MAIL FROM/RCPT TO/DATA)
// is real protocol work that's easy to get subtly wrong and hard to test
// from this environment — not something to fake as "done."
//
// This uses Resend's HTTP API instead (https://resend.com/docs/api-reference/emails/send-email)
// — one fetch() call, no TCP/TLS/SMTP protocol handling needed, which is
// the standard pattern for sending email from Workers. Swap the fetch
// target/body shape here if you'd rather use Postmark, SendGrid, or
// Mailgun's HTTP APIs instead; the graceful "not configured" fallback
// behavior below is preserved exactly as the Go version had it.
export async function sendEmail(env: Env, to: string, subject: string, htmlBody: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log("email not configured — logging instead of sending", { to, subject });
    return;
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.INGEST_EMAIL_ADDRESS, to, subject, html: htmlBody }),
  });
  if (!resp.ok) {
    console.error("email send failed", { status: resp.status, body: await resp.text() });
  }
}

export async function sendTeamInvite(env: Env, toEmail: string, businessName: string, inviteToken: string, role: string): Promise<void> {
  const subject = `You've been invited to join ${businessName} on MarginPulse Pro`;
  const body = `<p>You've been invited to join <strong>${businessName}</strong> on MarginPulse Pro as a <strong>${role}</strong>.</p>
<p><a href="${env.FRONTEND_ORIGIN}/accept-invite?token=${inviteToken}">Accept invitation</a></p>`;
  await sendEmail(env, toEmail, subject, body);
}
