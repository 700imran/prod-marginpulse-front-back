// Package db provides the DynamoDB client and the single source of
// truth for every key-string format used across the single-table
// design — ported from app/db/dynamodb.py. See DYNAMODB_SCHEMA.md at
// the repo root for the full human-readable key schema; the same
// schema is used unchanged from the Python version, since only the
// implementation language changed, not the data model.
package db

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"github.com/marginpulse/backend/internal/config"
)

var (
	clientOnce sync.Once
	client     *dynamodb.Client
)

// Client returns the shared DynamoDB client, constructed once per
// process/execution-environment (a Lambda cold start builds this once;
// warm invocations reuse it — the same rationale as the Python worker's
// module-level SQLAlchemy engine reuse, just without a connection pool
// to manage since DynamoDB's SDK is HTTP-based).
func Client() *dynamodb.Client {
	clientOnce.Do(func() {
		cfg := config.Get()
		ctx := context.Background()

		optFns := []func(*awsconfig.LoadOptions) error{
			awsconfig.WithRegion(cfg.AWSRegion),
		}
		if cfg.AWSAccessKeyID != "" {
			optFns = append(optFns, awsconfig.WithCredentialsProvider(
				credentials.NewStaticCredentialsProvider(cfg.AWSAccessKeyID, cfg.AWSSecretKey, ""),
			))
		}
		awsCfg, err := awsconfig.LoadDefaultConfig(ctx, optFns...)
		if err != nil {
			panic(fmt.Sprintf("failed to load AWS config: %v", err))
		}

		var dynamoOptFns []func(*dynamodb.Options)
		if cfg.DynamoDBEndpointURL != "" {
			dynamoOptFns = append(dynamoOptFns, func(o *dynamodb.Options) {
				o.BaseEndpoint = aws.String(cfg.DynamoDBEndpointURL)
			})
		}
		client = dynamodb.NewFromConfig(awsCfg, dynamoOptFns...)
	})
	return client
}

// TableName returns the configured table name — every repository call
// passes this rather than hardcoding it, so tests can point at a
// DynamoDB Local table via DYNAMODB_TABLE_NAME without code changes.
func TableName() string {
	return config.Get().DynamoDBTableName
}

// ── Key builders — see app/db/dynamodb.py for the parallel Python
// versions and the full rationale for the single-table + 3-GSI design.

func TenantPK(tenantID string) string { return "TENANT#" + tenantID }

const TenantSK = "METADATA"

func DocumentSK(documentID string) string { return "DOCUMENT#" + documentID }

func DocumentGSI1PK(tenantID, status string) string {
	return fmt.Sprintf("TENANT#%s#STATUS#%s", tenantID, status)
}

func DocumentGSI1SK(createdAtISO, documentID string) string {
	return fmt.Sprintf("DOC#%s#%s", createdAtISO, documentID)
}

func DocumentGSI2PK(tenantID, gstPortalStatus string) string {
	return fmt.Sprintf("TENANT#%s#GSTSTATUS#%s", tenantID, gstPortalStatus)
}

func BankTxnSK(transactionDateISO, transactionID string) string {
	return fmt.Sprintf("BANKTXN#%s#%s", transactionDateISO, transactionID)
}

func BankTxnGSI2PKUnmatched(tenantID string) string {
	return fmt.Sprintf("TENANT#%s#UNMATCHED", tenantID)
}

func TaxIdentifierSK(taxIdentifierID string) string { return "TAXID#" + taxIdentifierID }

func TaxIdentifierGuardSK(idType, idValue string) string {
	return fmt.Sprintf("TAXID_GUARD#%s#%s", idType, idValue)
}

func BankAccountSK(bankAccountID string) string { return "BANKACCT#" + bankAccountID }

func TeamMemberSK(teamMemberID string) string { return "TEAMMEMBER#" + teamMemberID }

func TeamMemberGSI3PKInvite(inviteToken string) string { return "INVITE_TOKEN#" + inviteToken }

func AnomalySK(createdAtISO, anomalyID string) string {
	return fmt.Sprintf("ANOMALY#%s#%s", createdAtISO, anomalyID)
}

func AuditLogSK(createdAtISO, auditLogID string) string {
	return fmt.Sprintf("AUDITLOG#%s#%s", createdAtISO, auditLogID)
}

func TenantGSI1PKEmail(ownerEmail string) string {
	return "EMAIL#" + normalizeEmail(ownerEmail)
}

func TenantGSI2PKWhatsApp(phone string) string { return "WHATSAPP#" + phone }

func TenantGSI3PKIngestEmail(alias string) string {
	return "INGEST_EMAIL#" + normalizeEmail(alias)
}

const (
	SettingsSKReconciliation = "SETTINGS#RECONCILIATION"
	SettingsSKNotifications  = "SETTINGS#NOTIFICATIONS"
	SettingsSKIntegrations   = "SETTINGS#INTEGRATIONS"
)

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}
