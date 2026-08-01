// Package aibudget ports app/core/ai_budget.py — per-tenant Denial-of-Wallet
// protection for the Anthropic API calls in the insights pipeline.
package aibudget

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/marginpulse/backend/internal/config"
)

const (
	rpmPrefix   = "mp:ai_rpm:"
	dailyPrefix = "mp:ai_daily_tokens:"
)

var client *redis.Client

func redisDBSuffix(url string, db int) string {
	idx := strings.LastIndex(url, "/")
	if idx == -1 {
		return url
	}
	return fmt.Sprintf("%s/%d", url[:idx], db)
}

func getClient() *redis.Client {
	if client == nil {
		// Separate logical namespace (db=5) — same instance as rate
		// limiting (db 0) and token blocklist (db 4), no collision risk.
		opts, err := redis.ParseURL(redisDBSuffix(config.Get().RedisURL, 5))
		if err != nil {
			slog.Error("invalid REDIS_URL for AI budget guard", "error", err)
			opts = &redis.Options{Addr: "localhost:6379"}
		}
		opts.DialTimeout = 5 * time.Second
		opts.ReadTimeout = 5 * time.Second
		client = redis.NewClient(opts)
	}
	return client
}

// CheckBudget mirrors check_ai_budget(): returns (allowed, reason).
// Fails OPEN on Redis errors — a cost-control guard, not a security
// boundary, so a brief Redis outage should degrade to "no budget
// enforcement" rather than breaking the dashboard entirely.
func CheckBudget(ctx context.Context, tenantID string) (bool, string) {
	cfg := config.Get()
	c := getClient()

	rpmKey := fmt.Sprintf("%s%s:%d", rpmPrefix, tenantID, time.Now().Unix()/60)
	currentRPM, err := c.Incr(ctx, rpmKey).Result()
	if err != nil {
		slog.Warn("ai budget check failed open", "tenant_id", tenantID, "error", err)
		return true, ""
	}
	if currentRPM == 1 {
		c.Expire(ctx, rpmKey, 60*time.Second)
	}
	if currentRPM > int64(cfg.AIRequestsPerMinutePerTenant) {
		return false, fmt.Sprintf("AI request rate limit exceeded (%d/min per tenant)", cfg.AIRequestsPerMinutePerTenant)
	}

	today := time.Now().UTC().Format("20060102")
	dailyKey := fmt.Sprintf("%s%s:%s", dailyPrefix, tenantID, today)
	usedToday, err := c.Get(ctx, dailyKey).Int64()
	if err != nil && err != redis.Nil {
		slog.Warn("ai budget check failed open", "tenant_id", tenantID, "error", err)
		return true, ""
	}
	if usedToday >= int64(cfg.AIDailyTokenBudgetPerTenant) {
		return false, fmt.Sprintf("Daily AI token budget exhausted (%d tokens/day per tenant)", cfg.AIDailyTokenBudgetPerTenant)
	}

	return true, ""
}

// RecordUsage mirrors record_ai_usage() — call after a successful
// Anthropic API call to charge the daily budget.
func RecordUsage(ctx context.Context, tenantID string, totalTokens int) {
	if totalTokens <= 0 {
		return
	}
	c := getClient()
	today := time.Now().UTC().Format("20060102")
	dailyKey := fmt.Sprintf("%s%s:%s", dailyPrefix, tenantID, today)

	pipe := c.Pipeline()
	pipe.IncrBy(ctx, dailyKey, int64(totalTokens))
	pipe.Expire(ctx, dailyKey, 48*time.Hour) // 2 days — covers timezone edges
	if _, err := pipe.Exec(ctx); err != nil {
		slog.Warn("ai usage record failed", "tenant_id", tenantID, "error", err)
	}
}
