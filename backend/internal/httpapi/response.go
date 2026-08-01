package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// WriteJSON writes a JSON response with the given status code.
func WriteJSON(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// errorBody mirrors FastAPI's default {"detail": "..."} error shape so
// the existing frontend's error-handling code (which reads
// response.data.detail) keeps working unchanged.
type errorBody struct {
	Detail string `json:"detail"`
}

// WriteError writes a {"detail": message} error body — matches FastAPI's
// HTTPException(status_code=..., detail=...) response shape exactly.
func WriteError(w http.ResponseWriter, status int, message string) {
	WriteJSON(w, status, errorBody{Detail: message})
}

// DecodeJSON parses the request body into dst, returning false (and
// having already written a 400 response) on failure — a small helper to
// avoid repeating this 4-line pattern in every handler.
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst interface{}) bool {
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		WriteError(w, http.StatusUnprocessableEntity, "Invalid request body: "+err.Error())
		return false
	}
	return true
}

var errEmptyBody = errors.New("empty request body")

// decodeJSONBody is the shared low-level decode used by both DecodeJSON
// and DecodeJSONOptional — io.EOF (empty body) is normalized to
// errEmptyBody so callers can distinguish "nothing sent" (fine for
// optional bodies) from "sent but malformed" (a real error).
func decodeJSONBody(r *http.Request, dst interface{}) error {
	err := json.NewDecoder(r.Body).Decode(dst)
	if err != nil {
		if err == io.EOF {
			return errEmptyBody
		}
		return err
	}
	return nil
}
