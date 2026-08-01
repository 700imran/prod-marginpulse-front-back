package httpapi

import (
	"log/slog"
	"net/http"
	"regexp"

	"github.com/marginpulse/backend/internal/queue"
	"github.com/marginpulse/backend/internal/repository"
	"github.com/marginpulse/backend/internal/security"
)

type bankAccountOut struct {
	BankAccountID             string `json:"bank_account_id"`
	BankName                  string `json:"bank_name"`
	AccountHolderName         string `json:"account_holder_name"`
	AccountNumberLast4        string `json:"account_number_last4"`
	IFSCCode                  string `json:"ifsc_code"`
	AccountType               string `json:"account_type"`
	VerificationStatus        string `json:"verification_status"`
	VerifiedAccountHolderName string `json:"verified_account_holder_name,omitempty"`
	IsPrimary                 bool   `json:"is_primary"`
	CreatedAt                 string `json:"created_at"`
}

func bankAccountOutFromItem(b repository.BankAccountItem) bankAccountOut {
	return bankAccountOut{
		BankAccountID: b.BankAccountID, BankName: b.BankName, AccountHolderName: b.AccountHolderName,
		AccountNumberLast4: b.AccountNumberLast4, IFSCCode: b.IFSCCode, AccountType: b.AccountType,
		VerificationStatus: b.VerificationStatus, VerifiedAccountHolderName: b.VerifiedAccountHolderName,
		IsPrimary: b.IsPrimary, CreatedAt: b.CreatedAt,
	}
}

// HandleListBankAccounts mirrors GET /bank-accounts.
func HandleListBankAccounts(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	repo := repository.NewBankAccountsRepo()
	items, err := repo.ListByTenant(r.Context(), tc.Tenant.TenantID)
	if err != nil {
		slog.Error("list bank accounts failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not list bank accounts")
		return
	}
	out := make([]bankAccountOut, len(items))
	for i, b := range items {
		out[i] = bankAccountOutFromItem(b)
	}
	WriteJSON(w, http.StatusOK, out)
}

type createBankAccountRequest struct {
	BankName          string `json:"bank_name"`
	AccountHolderName string `json:"account_holder_name"`
	AccountNumber     string `json:"account_number"`
	IFSCCode          string `json:"ifsc_code"`
	AccountType       string `json:"account_type"`
}

var ifscPattern = regexp.MustCompile(`^[A-Z]{4}0[A-Z0-9]{6}$`)

// HandleCreateBankAccount mirrors POST /bank-accounts — encrypts the
// account number at rest, warns (does not block) on a likely duplicate,
// and queues async verification.
func HandleCreateBankAccount(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	var req createBankAccountRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if req.BankName == "" || req.AccountHolderName == "" || req.AccountNumber == "" || req.IFSCCode == "" {
		WriteError(w, http.StatusBadRequest, "bank_name, account_holder_name, account_number, and ifsc_code are required")
		return
	}
	if !ifscPattern.MatchString(req.IFSCCode) {
		WriteError(w, http.StatusBadRequest, "Invalid IFSC code format")
		return
	}

	last4 := security.MaskAccountNumber(req.AccountNumber)
	repo := repository.NewBankAccountsRepo()
	if existing, err := repo.FindByLast4AndIFSC(r.Context(), tc.Tenant.TenantID, last4, req.IFSCCode); err == nil && existing != nil {
		slog.Warn("possible duplicate bank account", "tenant_id", tc.Tenant.TenantID, "bank_account_id", existing.BankAccountID)
	}

	encrypted, err := security.EncryptField(req.AccountNumber)
	if err != nil {
		slog.Error("bank account encryption failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not save bank account")
		return
	}

	accountType := req.AccountType
	if accountType == "" {
		accountType = "CURRENT"
	}

	item, err := repo.Create(r.Context(), repository.CreateBankAccountInput{
		TenantID: tc.Tenant.TenantID, BankName: req.BankName, AccountHolderName: req.AccountHolderName,
		AccountNumberEncrypted: encrypted, AccountNumberLast4: last4, IFSCCode: req.IFSCCode, AccountType: accountType,
	})
	if err != nil {
		slog.Error("create bank account failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not create bank account")
		return
	}

	if _, err := queue.EnqueueBankAccountVerification(r.Context(), item.BankAccountID, tc.Tenant.TenantID); err != nil {
		slog.Error("failed to enqueue bank account verification", "error", err)
	}

	WriteJSON(w, http.StatusCreated, bankAccountOutFromItem(*item))
}

// HandleSetPrimaryBankAccount mirrors POST /bank-accounts/{id}/set-primary.
func HandleSetPrimaryBankAccount(w http.ResponseWriter, r *http.Request, tc *TenantContext, bankAccountID string) {
	repo := repository.NewBankAccountsRepo()
	if _, err := repo.GetByID(r.Context(), tc.Tenant.TenantID, bankAccountID); err != nil {
		WriteError(w, http.StatusNotFound, "Bank account not found")
		return
	}
	if err := repo.ClearPrimary(r.Context(), tc.Tenant.TenantID, bankAccountID); err != nil {
		slog.Error("clear primary bank account failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not update primary bank account")
		return
	}
	updated, err := repo.UpdateFields(r.Context(), tc.Tenant.TenantID, bankAccountID, []repository.FieldUpdate{
		repository.F("is_primary", true),
	})
	if err != nil {
		slog.Error("set primary bank account failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not set primary bank account")
		return
	}
	WriteJSON(w, http.StatusOK, bankAccountOutFromItem(*updated))
}

// HandleDeleteBankAccount mirrors DELETE /bank-accounts/{id}.
func HandleDeleteBankAccount(w http.ResponseWriter, r *http.Request, tc *TenantContext, bankAccountID string) {
	repo := repository.NewBankAccountsRepo()
	if _, err := repo.GetByID(r.Context(), tc.Tenant.TenantID, bankAccountID); err != nil {
		WriteError(w, http.StatusNotFound, "Bank account not found")
		return
	}
	if err := repo.Delete(r.Context(), tc.Tenant.TenantID, bankAccountID); err != nil {
		slog.Error("delete bank account failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not delete bank account")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
