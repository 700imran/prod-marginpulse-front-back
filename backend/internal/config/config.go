package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
)

type Settings struct {
	AppEnv         string
	AppSecretKey   string
	AppDebug       bool
	AllowedOrigins []string

	DynamoDBTableName   string
	DynamoDBEndpointURL string

	RedisURL string

	AWSRegion            string
	SQSQueueURLOCR       string
	SQSQueueURLReconcile string
	SQSQueueURLGST       string
	SQSQueueURLTaxID     string
	SQSQueueURLBankAcct  string

	StorageBackend   string
	LocalStoragePath string
	S3BucketName     string
	S3Region         string
	AWSAccessKeyID   string
	AWSSecretKey     string
	S3EndpointURL    string

	MaxUploadSizeMB int

	WhatsAppVerifyToken   string
	WhatsAppAccessToken   string
	WhatsAppPhoneNumberID string
	WhatsAppAPIVersion    string

	WebhookIngestSecret string

	IngestEmailAddress string
	SMTPHost           string
	SMTPPort           int
	SMTPUser           string
	SMTPPassword       string

	AnthropicAPIKey string
	LLMModel        string
	LLMMaxTokens    int

	GSTAPIBaseURL      string
	GSTAPIClientID     string
	GSTAPIClientSecret string
	GSTAPIUsername     string

	JWTSecretKey                string
	JWTAlgorithm                string
	JWTAccessTokenExpireMinutes int
	JWTRefreshTokenExpireDays   int

	FieldEncryptionKey string

	OCRLambdaFunctionName string

	RustCoreEnabled               bool
	ReconcileConfidenceThreshold  float64
	ReconcileAutoApproveThreshold float64

	SentryDSN string
	LogLevel  string

	AIMaxPromptTokens            int
	AIMaxCompletionTokens        int
	AIRequestsPerMinutePerTenant int
	AIDailyTokenBudgetPerTenant  int

	SecretRotationDays int

	GoogleClientID     string
	GoogleClientSecret string
	GoogleRedirectURI  string

	AppleClientID    string
	AppleTeamID      string
	AppleKeyID       string
	ApplePrivateKey  string
	AppleRedirectURI string

	FrontendBaseURL string

	SlackClientID     string
	SlackClientSecret string
	SlackRedirectURI  string
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvRequired(key, fallback string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v != "" {
		return v
	}
	if strings.EqualFold(strings.TrimSpace(getEnv("APP_ENV", "development")), "production") {
		panic(fmt.Sprintf("missing required env var %s for production", key))
	}
	return fallback
}

func getEnvBool(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return b
}

func getEnvInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	i, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return i
}

func getEnvFloat(key string, fallback float64) float64 {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return fallback
	}
	return f
}

func parseAllowedOrigins(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}

func load() *Settings {
	appEnv := strings.ToLower(strings.TrimSpace(getEnv("APP_ENV", "development")))
	allowedOrigins := parseAllowedOrigins(getEnv("ALLOWED_ORIGINS", ""))
	if appEnv == "production" && len(allowedOrigins) == 0 {
		panic("production requires ALLOWED_ORIGINS to be set")
	}
	if appEnv == "production" && strings.Contains(getEnv("ALLOWED_ORIGINS", ""), "*") {
		panic("production must not use wildcard CORS origins")
	}

	return &Settings{
		AppEnv:         appEnv,
		AppSecretKey:   getEnvRequired("APP_SECRET_KEY", "insecure-dev-key-change-in-production"),
		AppDebug:       getEnvBool("APP_DEBUG", false),
		AllowedOrigins: allowedOrigins,

		DynamoDBTableName:   getEnv("DYNAMODB_TABLE_NAME", "marginpulse"),
		DynamoDBEndpointURL: getEnv("DYNAMODB_ENDPOINT_URL", ""),

		RedisURL: getEnv("REDIS_URL", "redis://redis:6379/0"),

		AWSRegion:            getEnv("AWS_REGION", "ap-south-1"),
		SQSQueueURLOCR:       getEnv("SQS_QUEUE_URL_OCR", ""),
		SQSQueueURLReconcile: getEnv("SQS_QUEUE_URL_RECONCILE", ""),
		SQSQueueURLGST:       getEnv("SQS_QUEUE_URL_GST", ""),
		SQSQueueURLTaxID:     getEnv("SQS_QUEUE_URL_TAX_IDENTIFIER", ""),
		SQSQueueURLBankAcct:  getEnv("SQS_QUEUE_URL_BANK_ACCOUNT", ""),

		StorageBackend:   getEnv("STORAGE_BACKEND", "local"),
		LocalStoragePath: getEnv("LOCAL_STORAGE_PATH", "/app/uploads"),
		S3BucketName:     getEnv("S3_BUCKET_NAME", "marginpulse-documents"),
		S3Region:         getEnv("S3_REGION", "auto"),
		AWSAccessKeyID:   getEnv("AWS_ACCESS_KEY_ID", ""),
		AWSSecretKey:     getEnv("AWS_SECRET_ACCESS_KEY", ""),
		S3EndpointURL:    getEnv("S3_ENDPOINT_URL", ""),

		MaxUploadSizeMB: getEnvInt("MAX_UPLOAD_SIZE_MB", 25),

		WhatsAppVerifyToken:   getEnv("WHATSAPP_VERIFY_TOKEN", "dev-verify-token"),
		WhatsAppAccessToken:   getEnv("WHATSAPP_ACCESS_TOKEN", ""),
		WhatsAppPhoneNumberID: getEnv("WHATSAPP_PHONE_NUMBER_ID", ""),
		WhatsAppAPIVersion:    getEnv("WHATSAPP_API_VERSION", "v19.0"),

		WebhookIngestSecret: getEnv("WEBHOOK_INGEST_SECRET", ""),

		IngestEmailAddress: getEnv("INGEST_EMAIL_ADDRESS", "docs@marginpulse.io"),
		SMTPHost:           getEnv("SMTP_HOST", ""),
		SMTPPort:           getEnvInt("SMTP_PORT", 587),
		SMTPUser:           getEnv("SMTP_USER", ""),
		SMTPPassword:       getEnv("SMTP_PASSWORD", ""),

		AnthropicAPIKey: getEnv("ANTHROPIC_API_KEY", ""),
		LLMModel:        getEnv("LLM_MODEL", "claude-sonnet-4-20250514"),
		LLMMaxTokens:    getEnvInt("LLM_MAX_TOKENS", 1024),

		GSTAPIBaseURL:      getEnv("GST_API_BASE_URL", "https://api.gst.gov.in/commonapi"),
		GSTAPIClientID:     getEnv("GST_API_CLIENT_ID", ""),
		GSTAPIClientSecret: getEnv("GST_API_CLIENT_SECRET", ""),
		GSTAPIUsername:     getEnv("GST_API_USERNAME", ""),

		JWTSecretKey:                getEnvRequired("JWT_SECRET_KEY", "insecure-jwt-dev-key-change-in-production"),
		JWTAlgorithm:                getEnv("JWT_ALGORITHM", "HS256"),
		JWTAccessTokenExpireMinutes: getEnvInt("JWT_ACCESS_TOKEN_EXPIRE_MINUTES", 60),
		JWTRefreshTokenExpireDays:   getEnvInt("JWT_REFRESH_TOKEN_EXPIRE_DAYS", 30),

		FieldEncryptionKey: getEnvRequired("FIELD_ENCRYPTION_KEY", "insecure-field-encryption-key-change-in-production"),

		OCRLambdaFunctionName: getEnv("OCR_LAMBDA_FUNCTION_NAME", "marginpulse-ocr-service"),

		RustCoreEnabled:               false,
		ReconcileConfidenceThreshold:  getEnvFloat("RECONCILE_CONFIDENCE_THRESHOLD", 0.85),
		ReconcileAutoApproveThreshold: getEnvFloat("RECONCILE_AUTO_APPROVE_THRESHOLD", 0.90),

		SentryDSN: getEnv("SENTRY_DSN", ""),
		LogLevel:  getEnv("LOG_LEVEL", "INFO"),

		AIMaxPromptTokens:            getEnvInt("AI_MAX_PROMPT_TOKENS", 8000),
		AIMaxCompletionTokens:        getEnvInt("AI_MAX_COMPLETION_TOKENS", 2000),
		AIRequestsPerMinutePerTenant: getEnvInt("AI_REQUESTS_PER_MINUTE_PER_TENANT", 20),
		AIDailyTokenBudgetPerTenant:  getEnvInt("AI_DAILY_TOKEN_BUDGET_PER_TENANT", 200_000),

		SecretRotationDays: getEnvInt("SECRET_ROTATION_DAYS", 90),

		GoogleClientID:     getEnv("GOOGLE_CLIENT_ID", ""),
		GoogleClientSecret: getEnv("GOOGLE_CLIENT_SECRET", ""),
		GoogleRedirectURI:  getEnv("GOOGLE_REDIRECT_URI", ""),

		AppleClientID:    getEnv("APPLE_CLIENT_ID", ""),
		AppleTeamID:      getEnv("APPLE_TEAM_ID", ""),
		AppleKeyID:       getEnv("APPLE_KEY_ID", ""),
		ApplePrivateKey:  getEnv("APPLE_PRIVATE_KEY", ""),
		AppleRedirectURI: getEnv("APPLE_REDIRECT_URI", ""),

		FrontendBaseURL: getEnv("FRONTEND_BASE_URL", "http://localhost:3000"),

		SlackClientID:     getEnv("SLACK_CLIENT_ID", ""),
		SlackClientSecret: getEnv("SLACK_CLIENT_SECRET", ""),
		SlackRedirectURI:  getEnv("SLACK_REDIRECT_URI", ""),
	}
}

var (
	once     sync.Once
	instance *Settings
)

func Get() *Settings {
	once.Do(func() {
		instance = load()
	})
	return instance
}
