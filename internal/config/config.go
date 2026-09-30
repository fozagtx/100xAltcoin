// Package config reads 100xAltcoin's settings from environment variables.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Config is the full runtime configuration.
type Config struct {
	Port       string
	LogLevel   slog.Level
	CMCAPIKey  string
	CMCBaseURL string
	CMCRPM     int

	Preset       string
	TopN         int
	FastN        int
	PageSize     int
	PollInterval time.Duration
	SlowInterval time.Duration

	StaleAfter time.Duration
	MaxStale   time.Duration

	HistoryFile      string
	HistorySaveEvery time.Duration

	// PublicURL is the externally visible base URL (https://...), used as
	// the x402 resource URL; empty means "derive from the request".
	PublicURL string

	X402 X402
}

// X402 configures the payment wall.
type X402 struct {
	// Enabled turns the paywall on. Off is for local development only.
	Enabled bool
	// PayTo is the EVM address that receives USDC.
	PayTo string
	// Network is the CAIP-2 chain id: eip155:84532 (Base Sepolia) or
	// eip155:8453 (Base mainnet).
	Network string
	// FacilitatorURL verifies and settles payments.
	FacilitatorURL string
	// FacilitatorAuth, when set, is sent as the Authorization header on
	// every facilitator call (for facilitators that take a static token).
	FacilitatorAuth string
	// Prices maps endpoint name (gems, screen, climbers, sectors, asset,
	// digest) to a USD price string such as "$0.01".
	Prices map[string]string
}

// DefaultCMCBaseURL is the production CoinMarketCap Pro API.
const DefaultCMCBaseURL = "https://pro-api.coinmarketcap.com"

// DefaultFacilitatorURL is the public x402 facilitator (Base Sepolia).
const DefaultFacilitatorURL = "https://x402.org/facilitator"

// Networks lists the chains 100xAltcoin can take USDC payments on.
var Networks = map[string]string{
	"eip155:84532": "Base Sepolia (testnet)",
	"eip155:8453":  "Base",
}

// PaidEndpoints lists the priced endpoints and their default prices.
var PaidEndpoints = []struct{ Name, DefaultPrice string }{
	{"gems", "$0.02"},
	{"screen", "$0.01"},
	{"climbers", "$0.01"},
	{"sectors", "$0.01"},
	{"asset", "$0.01"},
	{"digest", "$0.03"},
}

// FromEnv builds a Config from the process environment.
func FromEnv() (Config, error) { return Load(os.Getenv) }

// preset is a named polling schedule, selected with PRESET. The preset
// supplies the defaults; each individual env var still wins when set.
type preset struct {
	topN, fastN int
	poll, slow  time.Duration
}

var presets = map[string]preset{
	// free fits CMC's 10k-credit Basic plan (~190 credits/day).
	"free":     {topN: 1000, fastN: 200, poll: 15 * time.Minute, slow: time.Hour},
	"startup":  {topN: 3000, fastN: 200, poll: 2 * time.Minute, slow: 15 * time.Minute},
	"standard": {topN: 5000, fastN: 500, poll: time.Minute, slow: 10 * time.Minute},
}

// ProjectedCreditsPerDay estimates the configured schedule's daily CMC
// credit burn: fast-tier pages every PollInterval and slow-tier pages every
// SlowInterval, one credit per 200 assets per call. /key/info is free.
func (c Config) ProjectedCreditsPerDay() int {
	ceilDiv := func(n, d int) int { return (n + d - 1) / d }
	fast := ceilDiv(c.FastN, 200) * int((24*time.Hour)/c.PollInterval)
	slow := ceilDiv(c.TopN-c.FastN, 200) * int((24*time.Hour)/c.SlowInterval)
	return fast + slow
}

var (
	evmAddress = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
	usdPrice   = regexp.MustCompile(`^\$(0|[1-9][0-9]*)(\.[0-9]{1,6})?$`)
)

// Load builds a Config using getenv to read variables.
func Load(getenv func(string) string) (Config, error) {
	p := parser{getenv: getenv}
	presetName := strings.ToLower(p.str("PRESET", "startup"))
	pr, ok := presets[presetName]
	if !ok {
		p.fail("PRESET", presetName, "want free, startup or standard")
		pr = presets["startup"]
	}
	c := Config{
		Port:             p.str("PORT", "8080"),
		CMCAPIKey:        strings.TrimSpace(getenv("CMC_API_KEY")),
		CMCBaseURL:       strings.TrimRight(p.str("CMC_BASE_URL", DefaultCMCBaseURL), "/"),
		CMCRPM:           p.int("CMC_RPM", 25, 1, 10000),
		Preset:           presetName,
		TopN:             p.int("TOP_N", pr.topN, 1, 10000),
		PageSize:         p.int("PAGE_SIZE", 1000, 1, 5000),
		PollInterval:     p.dur("POLL_INTERVAL", pr.poll, 10*time.Second),
		SlowInterval:     p.dur("SLOW_INTERVAL", pr.slow, 10*time.Second),
		HistoryFile:      strings.TrimSpace(getenv("HISTORY_FILE")),
		HistorySaveEvery: p.dur("HISTORY_SAVE_EVERY", 10*time.Minute, 10*time.Second),
		PublicURL:        strings.TrimRight(p.str("PUBLIC_URL", strings.TrimSpace(getenv("RENDER_EXTERNAL_URL"))), "/"),
	}
	c.FastN = p.int("FAST_N", pr.fastN, 1, 10000)
	if c.FastN > c.TopN {
		c.FastN = c.TopN
	}
	c.LogLevel = p.level("LOG_LEVEL", slog.LevelInfo)

	// Freshness is judged by when each page last came back from CMC, so
	// the limits follow the slow tier's schedule.
	c.StaleAfter = p.dur("STALE_AFTER", c.SlowInterval+2*c.PollInterval, time.Second)
	c.MaxStale = p.dur("MAX_STALE", max(3*c.SlowInterval, 30*time.Minute), time.Second)
	if c.MaxStale < c.StaleAfter {
		p.errs = append(p.errs, errors.New("MAX_STALE must be >= STALE_AFTER"))
	}
	if c.CMCAPIKey == "" && c.CMCBaseURL == DefaultCMCBaseURL {
		p.errs = append(p.errs, errors.New("CMC_API_KEY is required (or point CMC_BASE_URL at cmd/fakecmc)"))
	}
	if c.PublicURL != "" && !strings.HasPrefix(c.PublicURL, "http://") && !strings.HasPrefix(c.PublicURL, "https://") {
		p.fail("PUBLIC_URL", c.PublicURL, "want an absolute http(s) URL")
	}

	c.X402 = X402{
		Enabled:         p.boolean("X402_ENABLED", true),
		PayTo:           strings.TrimSpace(getenv("X402_PAY_TO")),
		Network:         p.str("X402_NETWORK", "eip155:84532"),
		FacilitatorURL:  strings.TrimRight(p.str("X402_FACILITATOR_URL", DefaultFacilitatorURL), "/"),
		FacilitatorAuth: strings.TrimSpace(getenv("X402_FACILITATOR_AUTH")),
		Prices:          map[string]string{},
	}
	for _, ep := range PaidEndpoints {
		name := "PRICE_" + strings.ToUpper(ep.Name)
		price := p.str(name, ep.DefaultPrice)
		if !usdPrice.MatchString(price) {
			p.fail(name, price, `want a USD amount like "$0.01" (at most 6 decimals)`)
			price = ep.DefaultPrice
		}
		c.X402.Prices[ep.Name] = price
	}
	if c.X402.Enabled {
		if _, ok := Networks[c.X402.Network]; !ok {
			p.fail("X402_NETWORK", c.X402.Network, "want eip155:84532 (Base Sepolia) or eip155:8453 (Base)")
		}
		if !evmAddress.MatchString(c.X402.PayTo) {
			p.fail("X402_PAY_TO", c.X402.PayTo, "want the 0x-prefixed EVM address that receives USDC")
		}
		if !strings.HasPrefix(c.X402.FacilitatorURL, "https://") && !strings.HasPrefix(c.X402.FacilitatorURL, "http://") {
			p.fail("X402_FACILITATOR_URL", c.X402.FacilitatorURL, "want an absolute http(s) URL")
		}
	}
	return c, errors.Join(p.errs...)
}

type parser struct {
	getenv func(string) string
	errs   []error
}

func (p *parser) fail(name, val, why string) {
	p.errs = append(p.errs, fmt.Errorf("%s=%q: %s", name, val, why))
}

func (p *parser) str(name, def string) string {
	if v := strings.TrimSpace(p.getenv(name)); v != "" {
		return v
	}
	return def
}

func (p *parser) int(name string, def, lo, hi int) int {
	v := strings.TrimSpace(p.getenv(name))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < lo || n > hi {
		p.fail(name, v, fmt.Sprintf("want an integer in [%d, %d]", lo, hi))
		return def
	}
	return n
}

func (p *parser) boolean(name string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(p.getenv(name)))
	switch v {
	case "":
		return def
	case "on", "true", "1", "yes":
		return true
	case "off", "false", "0", "no":
		return false
	}
	p.fail(name, v, "use true or false")
	return def
}

func (p *parser) dur(name string, def, min time.Duration) time.Duration {
	v := strings.TrimSpace(p.getenv(name))
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		// Bare integers are seconds.
		n, nerr := strconv.Atoi(v)
		if nerr != nil {
			p.fail(name, v, "want a duration like 60s or 5m")
			return def
		}
		d = time.Duration(n) * time.Second
	}
	if d < min {
		p.fail(name, v, fmt.Sprintf("must be at least %s", min))
		return def
	}
	return d
}

func (p *parser) level(name string, def slog.Level) slog.Level {
	v := strings.TrimSpace(p.getenv(name))
	if v == "" {
		return def
	}
	var l slog.Level
	if err := l.UnmarshalText([]byte(v)); err != nil {
		p.fail(name, v, "use debug, info, warn or error")
		return def
	}
	return l
}
