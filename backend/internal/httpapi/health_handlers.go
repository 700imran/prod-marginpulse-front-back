package httpapi

import (
	"net/http"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"github.com/marginpulse/backend/internal/config"
	"github.com/marginpulse/backend/internal/db"
)

// HandleHealth mirrors GET /health — liveness only, deliberately
// dependency-free.
func HandleHealth(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]string{
		"status": "healthy", "version": "2.0.0-go", "environment": config.Get().AppEnv,
	})
}

// HandleReady mirrors GET /health/ready — checks DynamoDB connectivity
// (replaces the Python version's Postgres + Redis check; Redis is still
// used for rate limiting/token blocklist/AI budget but a brief Redis
// blip already fails open in all three of those, by design, so it's
// intentionally not part of the readiness gate — DynamoDB is the one
// dependency this API cannot function at all without).
func HandleReady(w http.ResponseWriter, r *http.Request) {
	checks := map[string]string{}
	healthy := true

	_, err := db.Client().DescribeTable(r.Context(), &dynamodb.DescribeTableInput{
		TableName: aws.String(db.TableName()),
	})
	if err != nil {
		checks["dynamodb"] = "error: " + err.Error()
		healthy = false
	} else {
		checks["dynamodb"] = "ok"
	}

	status := http.StatusOK
	statusStr := "ready"
	if !healthy {
		status = http.StatusServiceUnavailable
		statusStr = "not_ready"
	}
	WriteJSON(w, status, map[string]interface{}{
		"status": statusStr, "checks": checks, "version": "2.0.0-go", "environment": config.Get().AppEnv,
	})
}
