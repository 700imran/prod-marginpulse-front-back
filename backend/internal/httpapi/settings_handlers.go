package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/marginpulse/backend/internal/repository"
)

type reconciliationSettingsOut struct {
	FuzzyVendorMatching    bool `json:"fuzzy_vendor_matching"`
	DateDriftTolerance     bool `json:"date_drift_tolerance"`
	OCRConfidenceThreshold int  `json:"ocr_confidence_threshold"`
}

func HandleGetReconciliationSettings(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	repo := repository.NewSettingsRepo()
	s, err := repo.GetOrCreateReconciliation(r.Context(), tc.Tenant.TenantID)
	if err != nil {
		slog.Error("get reconciliation settings failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not load settings")
		return
	}
	WriteJSON(w, http.StatusOK, reconciliationSettingsOut{
		FuzzyVendorMatching: s.FuzzyVendorMatching, DateDriftTolerance: s.DateDriftTolerance,
		OCRConfidenceThreshold: s.OCRConfidenceThreshold,
	})
}

type reconciliationSettingsUpdate struct {
	FuzzyVendorMatching    *bool `json:"fuzzy_vendor_matching"`
	DateDriftTolerance     *bool `json:"date_drift_tolerance"`
	OCRConfidenceThreshold *int  `json:"ocr_confidence_threshold"`
}

func HandleUpdateReconciliationSettings(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	var req reconciliationSettingsUpdate
	if !DecodeJSON(w, r, &req) {
		return
	}
	var updates []repository.FieldUpdate
	if req.FuzzyVendorMatching != nil {
		updates = append(updates, repository.F("fuzzy_vendor_matching", *req.FuzzyVendorMatching))
	}
	if req.DateDriftTolerance != nil {
		updates = append(updates, repository.F("date_drift_tolerance", *req.DateDriftTolerance))
	}
	if req.OCRConfidenceThreshold != nil {
		updates = append(updates, repository.F("ocr_confidence_threshold", int64(*req.OCRConfidenceThreshold)))
	}
	repo := repository.NewSettingsRepo()
	s, err := repo.UpdateReconciliation(r.Context(), tc.Tenant.TenantID, updates)
	if err != nil {
		slog.Error("update reconciliation settings failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not update settings")
		return
	}
	WriteJSON(w, http.StatusOK, reconciliationSettingsOut{
		FuzzyVendorMatching: s.FuzzyVendorMatching, DateDriftTolerance: s.DateDriftTolerance,
		OCRConfidenceThreshold: s.OCRConfidenceThreshold,
	})
}

type notificationSettingsOut struct {
	CriticalITCMissingAlert bool    `json:"critical_itc_missing_alert"`
	CriticalITCThresholdINR float64 `json:"critical_itc_threshold_inr"`
	WeeklyAuditSummary      bool    `json:"weekly_audit_summary"`
}

func HandleGetNotificationSettings(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	repo := repository.NewSettingsRepo()
	s, err := repo.GetOrCreateNotifications(r.Context(), tc.Tenant.TenantID)
	if err != nil {
		slog.Error("get notification settings failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not load settings")
		return
	}
	WriteJSON(w, http.StatusOK, notificationSettingsOut{
		CriticalITCMissingAlert: s.CriticalITCMissingAlert, CriticalITCThresholdINR: s.CriticalITCThresholdINR,
		WeeklyAuditSummary: s.WeeklyAuditSummary,
	})
}

type notificationSettingsUpdate struct {
	CriticalITCMissingAlert *bool    `json:"critical_itc_missing_alert"`
	CriticalITCThresholdINR *float64 `json:"critical_itc_threshold_inr"`
	WeeklyAuditSummary      *bool    `json:"weekly_audit_summary"`
}

func HandleUpdateNotificationSettings(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	var req notificationSettingsUpdate
	if !DecodeJSON(w, r, &req) {
		return
	}
	var updates []repository.FieldUpdate
	if req.CriticalITCMissingAlert != nil {
		updates = append(updates, repository.F("critical_itc_missing_alert", *req.CriticalITCMissingAlert))
	}
	if req.CriticalITCThresholdINR != nil {
		updates = append(updates, repository.F("critical_itc_threshold_inr", *req.CriticalITCThresholdINR))
	}
	if req.WeeklyAuditSummary != nil {
		updates = append(updates, repository.F("weekly_audit_summary", *req.WeeklyAuditSummary))
	}
	repo := repository.NewSettingsRepo()
	s, err := repo.UpdateNotifications(r.Context(), tc.Tenant.TenantID, updates)
	if err != nil {
		slog.Error("update notification settings failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not update settings")
		return
	}
	WriteJSON(w, http.StatusOK, notificationSettingsOut{
		CriticalITCMissingAlert: s.CriticalITCMissingAlert, CriticalITCThresholdINR: s.CriticalITCThresholdINR,
		WeeklyAuditSummary: s.WeeklyAuditSummary,
	})
}

type integrationSettingsOut struct {
	GSTAutoSyncEnabled      bool `json:"gst_auto_sync_enabled"`
	GSTAutoSyncDayOfMonth   int  `json:"gst_auto_sync_day_of_month"`
	WhatsAppOutboundEnabled bool `json:"whatsapp_outbound_enabled"`
}

func HandleGetIntegrationSettings(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	repo := repository.NewSettingsRepo()
	s, err := repo.GetOrCreateIntegrations(r.Context(), tc.Tenant.TenantID)
	if err != nil {
		slog.Error("get integration settings failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not load settings")
		return
	}
	WriteJSON(w, http.StatusOK, integrationSettingsOut{
		GSTAutoSyncEnabled: s.GSTAutoSyncEnabled, GSTAutoSyncDayOfMonth: s.GSTAutoSyncDayOfMonth,
		WhatsAppOutboundEnabled: s.WhatsAppOutboundEnabled,
	})
}

type integrationSettingsUpdate struct {
	GSTAutoSyncEnabled      *bool `json:"gst_auto_sync_enabled"`
	GSTAutoSyncDayOfMonth   *int  `json:"gst_auto_sync_day_of_month"`
	WhatsAppOutboundEnabled *bool `json:"whatsapp_outbound_enabled"`
}

func HandleUpdateIntegrationSettings(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	var req integrationSettingsUpdate
	if !DecodeJSON(w, r, &req) {
		return
	}
	var updates []repository.FieldUpdate
	if req.GSTAutoSyncEnabled != nil {
		updates = append(updates, repository.F("gst_auto_sync_enabled", *req.GSTAutoSyncEnabled))
	}
	if req.GSTAutoSyncDayOfMonth != nil {
		updates = append(updates, repository.F("gst_auto_sync_day_of_month", int64(*req.GSTAutoSyncDayOfMonth)))
	}
	if req.WhatsAppOutboundEnabled != nil {
		updates = append(updates, repository.F("whatsapp_outbound_enabled", *req.WhatsAppOutboundEnabled))
	}
	repo := repository.NewSettingsRepo()
	s, err := repo.UpdateIntegrations(r.Context(), tc.Tenant.TenantID, updates)
	if err != nil {
		slog.Error("update integration settings failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not update settings")
		return
	}
	WriteJSON(w, http.StatusOK, integrationSettingsOut{
		GSTAutoSyncEnabled: s.GSTAutoSyncEnabled, GSTAutoSyncDayOfMonth: s.GSTAutoSyncDayOfMonth,
		WhatsAppOutboundEnabled: s.WhatsAppOutboundEnabled,
	})
}
