package config

import (
	"strings"
	"testing"
	"time"
)

func env(kv map[string]string) func(string) string {
	return func(k string) string { return kv[k] }
}

const addr = "0x2222222222222222222222222222222222222222"

func TestDefaults(t *testing.T) {
	c, err := Load(env(map[string]string{"CMC_API_KEY": "k", "X402_PAY_TO": addr}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Preset != "startup" || c.TopN != 3000 || c.FastN != 200 || c.PollInterval != 2*time.Minute {
		t.Fatalf("preset defaults: %+v", c)
	}
	if !c.X402.Enabled || c.X402.Network != "eip155:84532" || c.X402.FacilitatorURL != DefaultFacilitatorURL {
		t.Fatalf("x402 defaults: %+v", c.X402)
	}
	if c.X402.Prices["gems"] != "$0.02" || c.X402.Prices["digest"] != "$0.03" || len(c.X402.Prices) != len(PaidEndpoints) {
		t.Fatalf("prices: %v", c.X402.Prices)
	}
	// Freshness follows the slow tier: 15m + 2*2m.
	if c.StaleAfter != 19*time.Minute || c.MaxStale != 45*time.Minute {
		t.Fatalf("freshness: stale %s max %s", c.StaleAfter, c.MaxStale)
	}
	if got := c.ProjectedCreditsPerDay(); got != 720+14*96 {
		t.Fatalf("projected credits = %d", got)
	}
}

func TestFreePresetFitsBasicPlan(t *testing.T) {
	c, err := Load(env(map[string]string{"CMC_API_KEY": "k", "X402_PAY_TO": addr, "PRESET": "free"}))
	if err != nil {
		t.Fatal(err)
	}
	if month := c.ProjectedCreditsPerDay() * 31; month > 10000 {
		t.Fatalf("free preset burns %d credits/month, over the 10k Basic plan", month)
	}
}

func TestRenderURLAndOverrides(t *testing.T) {
	c, err := Load(env(map[string]string{
		"CMC_API_KEY": "k", "X402_PAY_TO": addr, "RENDER_EXTERNAL_URL": "https://x.onrender.com/",
		"PRICE_GEMS": "$0.05", "X402_NETWORK": "eip155:8453", "TOP_N": "100", "FAST_N": "500",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.PublicURL != "https://x.onrender.com" || c.X402.Prices["gems"] != "$0.05" || c.X402.Network != "eip155:8453" {
		t.Fatalf("overrides: %+v", c)
	}
	if c.FastN != 100 {
		t.Fatalf("FastN should clamp to TopN, got %d", c.FastN)
	}
}

func TestErrors(t *testing.T) {
	for name, kv := range map[string]map[string]string{
		"missing key":     {"X402_PAY_TO": addr},
		"missing pay_to":  {"CMC_API_KEY": "k"},
		"bad pay_to":      {"CMC_API_KEY": "k", "X402_PAY_TO": "0x123"},
		"bad network":     {"CMC_API_KEY": "k", "X402_PAY_TO": addr, "X402_NETWORK": "solana:mainnet"},
		"bad price":       {"CMC_API_KEY": "k", "X402_PAY_TO": addr, "PRICE_ASSET": "0.01"},
		"bad preset":      {"CMC_API_KEY": "k", "X402_PAY_TO": addr, "PRESET": "huge"},
		"bad bool":        {"CMC_API_KEY": "k", "X402_ENABLED": "maybe"},
		"bad public url":  {"CMC_API_KEY": "k", "X402_PAY_TO": addr, "PUBLIC_URL": "example.com"},
		"stale inversion": {"CMC_API_KEY": "k", "X402_PAY_TO": addr, "STALE_AFTER": "2h", "MAX_STALE": "1h"},
	} {
		if _, err := Load(env(kv)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
	// Payments off needs no pay_to; a fake CMC needs no key.
	if _, err := Load(env(map[string]string{"X402_ENABLED": "false", "CMC_BASE_URL": "http://localhost:8181"})); err != nil {
		t.Fatalf("dev config: %v", err)
	}
	_, err := Load(env(map[string]string{"CMC_API_KEY": "k", "X402_PAY_TO": "nope"}))
	if err == nil || !strings.Contains(err.Error(), "X402_PAY_TO") {
		t.Fatalf("error should name the variable: %v", err)
	}
}
