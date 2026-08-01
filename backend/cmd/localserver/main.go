// cmd/localserver — plain net/http server for local development,
// running the exact same router as cmd/api's Lambda handler. Not used
// in production (Lambda + API Gateway is), but lets you run
// `go run ./cmd/localserver` and hit http://localhost:8000 directly
// without needing SAM Local or a real AWS account while developing.
package main

import (
	"log"
	"log/slog"
	"net/http"
	"os"

	"github.com/marginpulse/backend/internal/httpapi"
	"github.com/marginpulse/backend/internal/logging"
)

func main() {
	logging.Configure()
	router := httpapi.NewRouter()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}

	slog.Info("starting local dev server", "port", port)
	if err := http.ListenAndServe(":"+port, router); err != nil {
		log.Fatal(err)
	}
}
