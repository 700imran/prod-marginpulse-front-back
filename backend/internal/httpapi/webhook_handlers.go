package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/marginpulse/backend/internal/config"
	"github.com/marginpulse/backend/internal/queue"
	"github.com/marginpulse/backend/internal/repository"
	"github.com/marginpulse/backend/internal/storage"
)

// HandleWhatsAppVerify mirrors GET /webhook/whatsapp (Meta's webhook
// verification handshake).
func HandleWhatsAppVerify(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("hub.mode") == "subscribe" && q.Get("hub.verify_token") == config.Get().WhatsAppVerifyToken {
		w.Write([]byte(q.Get("hub.challenge")))
		return
	}
	WriteError(w, http.StatusForbidden, "Verification failed")
}

type waWebhookPayload struct {
	Entry []struct {
		Changes []struct {
			Value struct {
				Messages []struct {
					From     string `json:"from"`
					ID       string `json:"id"`
					Type     string `json:"type"`
					Document *struct {
						ID       string `json:"id"`
						MimeType string `json:"mime_type"`
						Filename string `json:"filename"`
					} `json:"document"`
					Image *struct {
						ID       string `json:"id"`
						MimeType string `json:"mime_type"`
					} `json:"image"`
				} `json:"messages"`
			} `json:"value"`
		} `json:"changes"`
	} `json:"entry"`
}

// HandleWhatsAppIngest mirrors POST /webhook/whatsapp — receives inbound
// document/image messages, maps the sender phone to a tenant, downloads
// the media from Meta's API, and queues it for OCR exactly like a web
// upload would be.
func HandleWhatsAppIngest(w http.ResponseWriter, r *http.Request) {
	var payload waWebhookPayload
	if !DecodeJSON(w, r, &payload) {
		return
	}

	tenantsRepo := repository.NewTenantsRepo()
	docsRepo := repository.NewDocumentsRepo()

	for _, entry := range payload.Entry {
		for _, change := range entry.Changes {
			for _, msg := range change.Value.Messages {
				var mediaID, mimeType, filename string
				if msg.Document != nil {
					mediaID, mimeType, filename = msg.Document.ID, msg.Document.MimeType, msg.Document.Filename
				} else if msg.Image != nil {
					mediaID, mimeType, filename = msg.Image.ID, msg.Image.MimeType, "whatsapp-image"
				} else {
					continue
				}

				tenant, err := tenantsRepo.GetByWhatsAppPhone(r.Context(), msg.From)
				if err != nil {
					slog.Warn("whatsapp message from unbound number", "from", msg.From)
					continue
				}

				data, downloadedMime, err := downloadWhatsAppMedia(r.Context(), mediaID)
				if err != nil {
					slog.Error("whatsapp media download failed", "error", err, "media_id", mediaID)
					continue
				}
				if downloadedMime != "" {
					mimeType = downloadedMime
				}

				s3Key := fmt.Sprintf("%s/%s/%s", tenant.TenantID, time.Now().UTC().Format("2006/01/02"), uuid.NewString())
				if _, err := storage.UploadBytes(r.Context(), data, s3Key, mimeType); err != nil {
					slog.Error("whatsapp document storage failed", "error", err)
					continue
				}

				doc, err := docsRepo.Create(r.Context(), repository.CreateDocumentInput{
					TenantID: tenant.TenantID, DocType: "INVOICE", OriginalFilename: filename,
					S3Key: s3Key, MimeType: mimeType, IngestChannel: "WHATSAPP",
					WhatsAppMessageID: msg.ID, SenderPhone: msg.From,
				})
				if err != nil {
					slog.Error("whatsapp document record creation failed", "error", err)
					continue
				}
				if _, err := queue.EnqueueOCRPipeline(r.Context(), doc.DocumentID, s3Key, mimeType, tenant.TenantID); err != nil {
					slog.Error("failed to enqueue OCR for whatsapp document", "error", err)
				}
			}
		}
	}
	WriteJSON(w, http.StatusOK, map[string]string{"status": "received"})
}

// downloadWhatsAppMedia fetches media bytes from Meta's Graph API
// (two-step: resolve media ID to a URL, then download from that URL
// with the same bearer token) — kept as a narrow, single-purpose
// function rather than a full package since this app only ever
// downloads WhatsApp media from this one call site.
func downloadWhatsAppMedia(ctx context.Context, mediaID string) ([]byte, string, error) {
	cfg := config.Get()
	if cfg.WhatsAppAccessToken == "" {
		return nil, "", fmt.Errorf("WHATSAPP_ACCESS_TOKEN not configured")
	}

	urlLookup := fmt.Sprintf("https://graph.facebook.com/%s/%s", cfg.WhatsAppAPIVersion, mediaID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, urlLookup, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.WhatsAppAccessToken)
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	var meta struct {
		URL      string `json:"url"`
		MimeType string `json:"mime_type"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
		return nil, "", err
	}
	if meta.URL == "" {
		return nil, "", fmt.Errorf("no media URL returned for media_id %s", mediaID)
	}

	req2, err := http.NewRequestWithContext(ctx, http.MethodGet, meta.URL, nil)
	if err != nil {
		return nil, "", err
	}
	req2.Header.Set("Authorization", "Bearer "+cfg.WhatsAppAccessToken)
	resp2, err := client.Do(req2)
	if err != nil {
		return nil, "", err
	}
	defer resp2.Body.Close()

	data, err := io.ReadAll(resp2.Body)
	if err != nil {
		return nil, "", err
	}
	return data, meta.MimeType, nil
}

// HandleEmailIngest mirrors POST /webhook/email-ingest — receives an
// inbound email (from a transactional email relay), maps the recipient
// alias to a tenant, and queues each attachment for OCR.
func HandleEmailIngest(w http.ResponseWriter, r *http.Request) {
	cfg := config.Get()
	if cfg.WebhookIngestSecret != "" {
		provided := r.Header.Get("X-Webhook-Secret")
		if provided != cfg.WebhookIngestSecret {
			WriteError(w, http.StatusUnauthorized, "Invalid webhook secret")
			return
		}
	}

	var payload struct {
		To          string `json:"to"`
		From        string `json:"from"`
		Attachments []struct {
			Filename    string `json:"filename"`
			ContentType string `json:"content_type"`
			ContentB64  string `json:"content_base64"`
		} `json:"attachments"`
	}
	if !DecodeJSON(w, r, &payload) {
		return
	}

	alias := extractEmailAlias(payload.To)
	tenantsRepo := repository.NewTenantsRepo()
	tenant, err := tenantsRepo.GetByIngestEmailAlias(r.Context(), alias)
	if err != nil {
		WriteError(w, http.StatusNotFound, "No tenant bound to this ingest address")
		return
	}

	docsRepo := repository.NewDocumentsRepo()
	queued := 0
	for _, att := range payload.Attachments {
		data, err := base64.StdEncoding.DecodeString(att.ContentB64)
		if err != nil {
			continue
		}
		s3Key := fmt.Sprintf("%s/%s/%s-%s", tenant.TenantID, time.Now().UTC().Format("2006/01/02"), uuid.NewString(), att.Filename)
		if _, err := storage.UploadBytes(r.Context(), data, s3Key, att.ContentType); err != nil {
			slog.Error("email attachment storage failed", "error", err)
			continue
		}
		doc, err := docsRepo.Create(r.Context(), repository.CreateDocumentInput{
			TenantID: tenant.TenantID, DocType: "INVOICE", OriginalFilename: att.Filename,
			S3Key: s3Key, MimeType: att.ContentType, IngestChannel: "EMAIL",
		})
		if err != nil {
			slog.Error("email document record creation failed", "error", err)
			continue
		}
		if _, err := queue.EnqueueOCRPipeline(r.Context(), doc.DocumentID, s3Key, att.ContentType, tenant.TenantID); err != nil {
			slog.Error("failed to enqueue OCR for email document", "error", err)
			continue
		}
		queued++
	}
	WriteJSON(w, http.StatusOK, map[string]interface{}{"status": "received", "documents_queued": queued})
}

func extractEmailAlias(to string) string {
	at := strings.Index(to, "@")
	if at == -1 {
		return strings.ToLower(strings.TrimSpace(to))
	}
	return strings.ToLower(strings.TrimSpace(to[:at]))
}
