// Package email ports app/services/email_service.py — sends
// transactional emails (team invites, GST sync summaries) via SMTP
// using only the Go standard library (net/smtp), no third-party
// dependency needed for this.
package email

import (
	"crypto/tls"
	"fmt"
	"log/slog"
	"net/smtp"
	"strings"

	"github.com/marginpulse/backend/internal/config"
)

// Send delivers a plain-text/HTML email. If SMTP isn't configured
// (SMTP_HOST empty — typical for local dev), it logs the email instead
// of sending, matching the graceful-degradation pattern used elsewhere
// in this app (e.g. insights falling back to a rule-based summary when
// ANTHROPIC_API_KEY is unset) rather than erroring out a request whose
// core purpose (e.g. "create the team invite") already succeeded.
func Send(to, subject, htmlBody string) error {
	cfg := config.Get()
	if cfg.SMTPHost == "" {
		slog.Info("smtp_not_configured_logging_instead", "to", to, "subject", subject)
		return nil
	}

	from := cfg.IngestEmailAddress
	msg := buildMessage(from, to, subject, htmlBody)
	addr := fmt.Sprintf("%s:%d", cfg.SMTPHost, cfg.SMTPPort)

	auth := smtp.PlainAuth("", cfg.SMTPUser, cfg.SMTPPassword, cfg.SMTPHost)

	// Port 465 is implicit TLS (SMTPS); 587 (the common default) uses
	// STARTTLS, which smtp.SendMail negotiates automatically. Both paths
	// are supported since different providers (SendGrid, SES, Gmail)
	// default to different ports.
	if cfg.SMTPPort == 465 {
		return sendImplicitTLS(addr, cfg.SMTPHost, auth, from, to, msg)
	}
	return smtp.SendMail(addr, auth, from, []string{to}, msg)
}

func sendImplicitTLS(addr, host string, auth smtp.Auth, from, to string, msg []byte) error {
	conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: host})
	if err != nil {
		return err
	}
	defer conn.Close()

	client, err := smtp.NewClient(conn, host)
	if err != nil {
		return err
	}
	defer client.Close()

	if auth != nil {
		if err := client.Auth(auth); err != nil {
			return err
		}
	}
	if err := client.Mail(from); err != nil {
		return err
	}
	if err := client.Rcpt(to); err != nil {
		return err
	}
	w, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(msg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return client.Quit()
}

func buildMessage(from, to, subject, htmlBody string) []byte {
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + subject + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	b.WriteString("\r\n")
	b.WriteString(htmlBody)
	return []byte(b.String())
}

// SendTeamInvite mirrors email_service.py's send_team_invite_email().
func SendTeamInvite(toEmail, businessName, inviteToken, role string) error {
	subject := fmt.Sprintf("You've been invited to join %s on MarginPulse Pro", businessName)
	body := fmt.Sprintf(
		`<p>You've been invited to join <strong>%s</strong> on MarginPulse Pro as a <strong>%s</strong>.</p>
<p><a href="https://app.marginpulse.io/accept-invite?token=%s">Accept invitation</a></p>`,
		businessName, role, inviteToken,
	)
	return Send(toEmail, subject, body)
}
