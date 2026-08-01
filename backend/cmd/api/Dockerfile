# ═══════════════════════════════════════════════════════════════════════════
#  MarginPulse Pro (Go) — API Lambda container image
#
#  Go compiles to a single static binary — no runtime dependencies, no
#  pip/venv, no system packages needed for the API itself (unlike the
#  Python version, which needed the full CPython runtime + all its
#  libraries baked into the image). This makes the image dramatically
#  smaller and the cold start faster.
# ═══════════════════════════════════════════════════════════════════════════
FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /bootstrap ./cmd/api

FROM public.ecr.aws/lambda/provided:al2023
COPY --from=build /bootstrap ${LAMBDA_RUNTIME_DIR}/bootstrap
CMD ["bootstrap"]
