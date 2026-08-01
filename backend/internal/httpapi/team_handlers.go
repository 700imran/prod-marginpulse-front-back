package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/marginpulse/backend/internal/email"
	"github.com/marginpulse/backend/internal/repository"
)

const maxTeamMembers = 10 // matches the Python version's plan-tier-agnostic cap

type teamMemberOut struct {
	TeamMemberID string `json:"team_member_id"`
	InvitedEmail string `json:"invited_email"`
	Role         string `json:"role"`
	Status       string `json:"status"`
	InvitedAt    string `json:"invited_at"`
}

func teamMemberOutFromItem(m repository.TeamMemberItem) teamMemberOut {
	return teamMemberOut{
		TeamMemberID: m.TeamMemberID, InvitedEmail: m.InvitedEmail, Role: m.Role,
		Status: m.Status, InvitedAt: m.InvitedAt,
	}
}

// HandleListTeamMembers mirrors GET /team.
func HandleListTeamMembers(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	repo := repository.NewTeamMembersRepo()
	items, err := repo.ListByTenant(r.Context(), tc.Tenant.TenantID)
	if err != nil {
		slog.Error("list team members failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not list team members")
		return
	}
	out := make([]teamMemberOut, len(items))
	for i, m := range items {
		out[i] = teamMemberOutFromItem(m)
	}
	WriteJSON(w, http.StatusOK, out)
}

type inviteTeamMemberRequest struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

// HandleInviteTeamMember mirrors POST /team/invite.
func HandleInviteTeamMember(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	var req inviteTeamMemberRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if req.Email == "" {
		WriteError(w, http.StatusBadRequest, "email is required")
		return
	}
	role := req.Role
	if role == "" {
		role = "VIEWER"
	}

	repo := repository.NewTeamMembersRepo()
	count, err := repo.CountActiveOrPending(r.Context(), tc.Tenant.TenantID)
	if err != nil {
		slog.Error("count team members failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not process invite")
		return
	}
	if count >= maxTeamMembers {
		WriteError(w, http.StatusBadRequest, "Team member limit reached")
		return
	}
	if existing, err := repo.FindActiveOrPendingForEmail(r.Context(), tc.Tenant.TenantID, req.Email); err == nil && existing != nil {
		WriteError(w, http.StatusConflict, "This email already has a pending or active invitation")
		return
	}

	member, err := repo.Create(r.Context(), repository.CreateTeamMemberInput{
		TenantID: tc.Tenant.TenantID, InvitedEmail: req.Email, Role: role,
	})
	if err != nil {
		slog.Error("create team member invite failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not create invite")
		return
	}

	if err := email.SendTeamInvite(member.InvitedEmail, tc.Tenant.BusinessName, member.InviteToken, member.Role); err != nil {
		slog.Error("failed to send team invite email", "error", err)
	}

	WriteJSON(w, http.StatusCreated, teamMemberOutFromItem(*member))
}

// HandleRevokeTeamMember mirrors POST /team/{id}/revoke — returns the
// updated member object (status=REVOKED) so the frontend can update its
// list in place without a re-fetch.
func HandleRevokeTeamMember(w http.ResponseWriter, r *http.Request, tc *TenantContext, teamMemberID string) {
	repo := repository.NewTeamMembersRepo()
	if _, err := repo.GetByID(r.Context(), tc.Tenant.TenantID, teamMemberID); err != nil {
		WriteError(w, http.StatusNotFound, "Team member not found")
		return
	}
	updated, err := repo.UpdateFields(r.Context(), tc.Tenant.TenantID, teamMemberID, []repository.FieldUpdate{
		repository.F("status", "REVOKED"),
	})
	if err != nil {
		slog.Error("revoke team member failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not revoke team member")
		return
	}
	WriteJSON(w, http.StatusOK, teamMemberOutFromItem(*updated))
}
