// Package paywall puts x402 payments in front of the paid endpoints. It
// wraps the official x402 Go SDK (x402-foundation/x402/go): unpaid
// requests get HTTP 402 with a PAYMENT-REQUIRED header describing the USDC
// price on Base, paid requests are verified and settled through an x402
// facilitator, and the settlement receipt rides back in PAYMENT-RESPONSE.
//
// Two guarantees on top of the SDK:
//   - the facilitator sync that the SDK only attempts once at startup is
//     retried in the background until it succeeds, and until then paid
//     routes answer 503 instead of asking for a payment nobody can verify;
//   - a handler that answers 4xx/5xx is never settled, so clients are not
//     charged for errors (the SDK skips settlement for those responses).
package paywall

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	"github.com/x402-foundation/x402/go/http/nethttp"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/server"
)

// Route is one paid endpoint.
type Route struct {
	Name        string // short name, e.g. "gems"
	Path        string // e.g. "/v1/gems"
	Price       string // USD, e.g. "$0.02"
	Description string // one sentence shown to paying clients
}

// Config configures a Paywall.
type Config struct {
	PayTo           string
	Network         string // CAIP-2, e.g. eip155:84532
	FacilitatorURL  string
	FacilitatorAuth string // optional Authorization header value
	// PublicURL, when set, is the base of each route's resource URL
	// (otherwise the SDK derives it from the request).
	PublicURL string
	AppName   string
	Routes    []Route
	Logger    *slog.Logger
	// Facilitator overrides the HTTP facilitator client; for tests.
	Facilitator x402.FacilitatorClient
}

// Status is the paywall summary /v1/status reports.
type Status struct {
	Enabled         bool       `json:"enabled"`
	Ready           bool       `json:"ready"`
	Network         string     `json:"network,omitempty"`
	NetworkName     string     `json:"network_name,omitempty"`
	Asset           string     `json:"asset,omitempty"`
	PayTo           string     `json:"pay_to,omitempty"`
	Facilitator     string     `json:"facilitator,omitempty"`
	LastError       string     `json:"last_error,omitempty"`
	PaymentsSettled int64      `json:"payments_settled"`
	LastSettledAt   *time.Time `json:"last_settled_at"`
}

// Paywall is the x402 middleware plus its facilitator sync loop.
type Paywall struct {
	cfg    Config
	log    *slog.Logger
	server x402HTTPServer
	mw     func(http.Handler) http.Handler
	asset  string

	ready   atomic.Bool
	settled atomic.Int64
	mu      sync.Mutex
	lastErr string
	lastAt  time.Time
}

// x402HTTPServer is the part of the SDK's HTTP resource server we use.
type x402HTTPServer interface {
	Initialize(ctx context.Context) error
}

// New builds a Paywall. It validates every price against the network (the
// SDK converts "$0.01" into USDC base units) and does not contact the
// facilitator; call Run for that.
func New(cfg Config) (*Paywall, error) {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.AppName == "" {
		cfg.AppName = "100xAltcoin"
	}
	network := x402.Network(cfg.Network)
	scheme := evm.NewExactEvmScheme()
	var asset string
	for _, rt := range cfg.Routes {
		amt, err := scheme.ParsePrice(x402.Price(rt.Price), network)
		if err != nil {
			return nil, fmt.Errorf("paywall: price %q for %s on %s: %w", rt.Price, rt.Path, cfg.Network, err)
		}
		if amt.Amount == "0" {
			return nil, fmt.Errorf("paywall: price for %s rounds to zero", rt.Path)
		}
		asset = amt.Asset
	}

	fac := cfg.Facilitator
	if fac == nil {
		fcfg := &x402http.FacilitatorConfig{URL: cfg.FacilitatorURL, Timeout: 30 * time.Second}
		if cfg.FacilitatorAuth != "" {
			fcfg.AuthProvider = staticAuth(cfg.FacilitatorAuth)
		}
		fac = x402http.NewHTTPFacilitatorClient(fcfg)
	}

	routes := x402http.RoutesConfig{}
	for _, rt := range cfg.Routes {
		rc := x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{{
				Scheme:  "exact",
				PayTo:   cfg.PayTo,
				Price:   x402.Price(rt.Price),
				Network: network,
			}},
			Description:        rt.Description,
			MimeType:           "application/json",
			ServiceName:        cfg.AppName,
			Tags:               []string{"crypto", "altcoins", "market-data", "coinmarketcap"},
			UnpaidResponseBody: unpaidBody(rt, cfg.Network),
		}
		if cfg.PublicURL != "" {
			rc.Resource = cfg.PublicURL + rt.Path
		}
		routes["GET "+rt.Path] = rc
	}

	resourceServer := x402.Newx402ResourceServer(x402.WithFacilitatorClient(fac)).
		Register(network, scheme)
	httpServer := x402http.Wrappedx402HTTPResourceServer(routes, resourceServer)

	p := &Paywall{cfg: cfg, log: cfg.Logger.With("component", "paywall"), server: httpServer, asset: asset}
	testnet := cfg.Network == "eip155:84532"
	p.mw = nethttp.PaymentMiddlewareFromHTTPServer(httpServer,
		nethttp.WithSyncFacilitatorOnStart(false), // Run syncs, with retries
		nethttp.WithTimeout(30*time.Second),
		nethttp.WithPaywallConfig(&x402http.PaywallConfig{AppName: cfg.AppName, Testnet: testnet}),
		nethttp.WithSettlementHandler(p.onSettled),
	)
	return p, nil
}

// staticAuth sends one fixed Authorization header on every facilitator call.
type staticAuth string

func (a staticAuth) GetAuthHeaders(context.Context) (x402http.AuthHeaders, error) {
	h := map[string]string{"Authorization": string(a)}
	return x402http.AuthHeaders{Verify: h, Settle: h, Supported: h, Bazaar: h}, nil
}

// unpaidBody explains the 402 in the body for humans and agents that do
// not read the PAYMENT-REQUIRED header yet.
func unpaidBody(rt Route, network string) x402http.UnpaidResponseBodyFunc {
	return func(context.Context, x402http.HTTPRequestContext) (*x402http.UnpaidResponse, error) {
		return &x402http.UnpaidResponse{
			ContentType: "application/json",
			Body: map[string]any{
				"error": map[string]any{
					"code":    "payment_required",
					"message": fmt.Sprintf("%s costs %s in USDC on %s, paid per call with x402.", rt.Path, rt.Price, networkName(network)),
					"next_step": "Decode the base64 PAYMENT-REQUIRED response header, sign the USDC authorization it describes " +
						"and retry with a PAYMENT-SIGNATURE header; any x402 v2 client (e.g. @x402/fetch, x402 Go/Python SDKs) does this automatically.",
				},
				"price":   rt.Price,
				"network": network,
				"docs":    "/",
			},
		}, nil
	}
}

func networkName(network string) string {
	switch network {
	case "eip155:84532":
		return "Base Sepolia"
	case "eip155:8453":
		return "Base"
	}
	return network
}

// Run syncs with the facilitator (its supported networks and schemes)
// until it succeeds or ctx is done, backing off from 2 s to 5 min.
func (p *Paywall) Run(ctx context.Context) {
	backoff := 2 * time.Second
	for ctx.Err() == nil {
		ictx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := p.server.Initialize(ictx)
		cancel()
		if err == nil {
			p.ready.Store(true)
			p.setErr("")
			p.log.Info("x402 facilitator synced", "facilitator", p.cfg.FacilitatorURL, "network", p.cfg.Network, "pay_to", p.cfg.PayTo)
			return
		}
		if ctx.Err() != nil {
			return
		}
		p.setErr(err.Error())
		p.log.Warn("x402 facilitator sync failed; paid routes answer 503 until it succeeds", "err", err, "retry_in", backoff.String())
		t := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		backoff = min(backoff*2, 5*time.Minute)
	}
}

// Ready reports whether payments can be verified.
func (p *Paywall) Ready() bool { return p.ready.Load() }

// Middleware returns the x402 middleware. Until the facilitator sync has
// succeeded it answers 503 payments_unavailable instead.
func (p *Paywall) Middleware(next http.Handler) http.Handler {
	paid := p.mw(next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !p.ready.Load() {
			writeUnavailable(w, p.lastError())
			return
		}
		paid.ServeHTTP(w, r)
	})
}

func (p *Paywall) onSettled(_ http.ResponseWriter, r *http.Request, resp *x402.SettleResponse) {
	p.settled.Add(1)
	p.mu.Lock()
	p.lastAt = time.Now().UTC()
	p.mu.Unlock()
	p.log.Info("x402 payment settled", "path", r.URL.Path, "tx", resp.Transaction, "network", resp.Network, "payer", resp.Payer)
}

func (p *Paywall) setErr(s string) {
	p.mu.Lock()
	p.lastErr = s
	p.mu.Unlock()
}

func (p *Paywall) lastError() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lastErr
}

// Status reports the paywall's configuration and health.
func (p *Paywall) Status() Status {
	p.mu.Lock()
	defer p.mu.Unlock()
	st := Status{
		Enabled:         true,
		Ready:           p.ready.Load(),
		Network:         p.cfg.Network,
		NetworkName:     networkName(p.cfg.Network),
		Asset:           p.asset,
		PayTo:           p.cfg.PayTo,
		Facilitator:     p.cfg.FacilitatorURL,
		LastError:       p.lastErr,
		PaymentsSettled: p.settled.Load(),
	}
	if !p.lastAt.IsZero() {
		t := p.lastAt
		st.LastSettledAt = &t
	}
	return st
}

// retryAfterUnavailable is suggested while the facilitator is unreachable.
const retryAfterUnavailable = 30

func writeUnavailable(w http.ResponseWriter, detail string) {
	msg := "Payments cannot be verified right now: the x402 facilitator has not been reached yet."
	if detail != "" {
		msg += " Last error: " + detail
	}
	body, _ := json.Marshal(map[string]any{"error": map[string]any{
		"code":                "payments_unavailable",
		"message":             msg,
		"next_step":           fmt.Sprintf("Retry in %d seconds; you have not been charged.", retryAfterUnavailable),
		"retry_after_seconds": retryAfterUnavailable,
	}})
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Retry-After", strconv.Itoa(retryAfterUnavailable))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write(append(body, '\n'))
}
