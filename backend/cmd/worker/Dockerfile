# ═══════════════════════════════════════════════════════════════════════════
#  MarginPulse Pro (Go) — Worker Lambda container image
#
#  NO system packages needed anymore. OCR moved from shelling out to a
#  locally-installed tesseract/poppler-utils (which hit real dnf/al2023
#  base-image compatibility problems — installs stalling 30+ minutes
#  then failing) to invoking a separate small Python Lambda running
#  RapidOCR's real, tested package (see ../../ocr-service). This image
#  is back to being a plain static Go binary — fast, reliable build,
#  same as the API image.
# ═══════════════════════════════════════════════════════════════════════════
FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /bootstrap ./cmd/worker

FROM public.ecr.aws/lambda/provided:al2023
COPY --from=build /bootstrap ${LAMBDA_RUNTIME_DIR}/bootstrap
CMD ["bootstrap"]
