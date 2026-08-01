// cmd/api — AWS Lambda entry point for the HTTP API, behind API Gateway
// (HTTP API, payload format 2.0). Replaces main.py's `handler =
// Mangum(app)`. A hand-written adapter is used instead of a third-party
// Lambda-to-net/http bridge — the translation is small and worth keeping
// in-house and auditable rather than adding another dependency for it.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"

	"github.com/marginpulse/backend/internal/httpapi"
	"github.com/marginpulse/backend/internal/logging"
)

var router http.Handler

func init() {
	logging.Configure()
	router = httpapi.NewRouter()
}

func handleRequest(ctx context.Context, req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	httpReq, err := toHTTPRequest(ctx, req)
	if err != nil {
		slog.Error("failed to translate API Gateway event", "error", err)
		return events.APIGatewayV2HTTPResponse{StatusCode: 400, Body: `{"detail":"Malformed request"}`}, nil
	}

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httpReq)
	return toAPIGatewayResponse(recorder), nil
}

func toHTTPRequest(ctx context.Context, req events.APIGatewayV2HTTPRequest) (*http.Request, error) {
	method := req.RequestContext.HTTP.Method
	path := req.RawPath
	if req.RawQueryString != "" {
		path += "?" + req.RawQueryString
	}

	var bodyReader *bytes.Reader
	if req.IsBase64Encoded {
		decoded, err := base64.StdEncoding.DecodeString(req.Body)
		if err != nil {
			return nil, err
		}
		bodyReader = bytes.NewReader(decoded)
	} else {
		bodyReader = bytes.NewReader([]byte(req.Body))
	}

	httpReq, err := http.NewRequestWithContext(ctx, method, path, bodyReader)
	if err != nil {
		return nil, err
	}
	for k, v := range req.Headers {
		// API Gateway HTTP API joins multi-value headers with a comma
		// into a single string per key — split back out so multiple
		// request headers aren't mangled into one value.
		for _, part := range strings.Split(v, ",") {
			httpReq.Header.Add(k, strings.TrimSpace(part))
		}
	}
	httpReq.RemoteAddr = req.RequestContext.HTTP.SourceIP
	if httpReq.Header.Get("X-Forwarded-For") == "" && req.RequestContext.HTTP.SourceIP != "" {
		httpReq.Header.Set("X-Forwarded-For", req.RequestContext.HTTP.SourceIP)
	}
	return httpReq, nil
}

func toAPIGatewayResponse(recorder *httptest.ResponseRecorder) events.APIGatewayV2HTTPResponse {
	headers := map[string]string{}
	for k, v := range recorder.Header() {
		headers[k] = strings.Join(v, ",")
	}
	return events.APIGatewayV2HTTPResponse{
		StatusCode: recorder.Code,
		Headers:    headers,
		Body:       recorder.Body.String(),
	}
}

func main() {
	lambda.Start(handleRequest)
}
