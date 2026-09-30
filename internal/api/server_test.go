package api

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	evmclient "github.com/x402-foundation/x402/go/mechanisms/evm/exact/client"
	evmsigners "github.com/x402-foundation/x402/go/signers/evm"

	"github.com/fozagtx/100xAltcoin/internal/market"
	"github.com/fozagtx/100xAltcoin/internal/model"
	"github.com/fozagtx/100xAltcoin/internal/paywall"
)

var testNow = time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)

// stubMarket is an in-memory Market.
type stubMarket struct {
	snap  *market.Snapshot
	hist  map[int64][]model.Sample
	hours int
}

func (m *stubMarket) Snapshot() *market.Snapshot      { return m.snap }
func (m *stubMarket) Ready() bool                     { return m.snap.Len() > 0 }
func (m *stubMarket) History(id int64) []model.Sample { return m.hist[id] }
func (m *stubMarket) HistoryHours() int               { return m.hours }
func (m *stubMarket) Status() model.MarketStatus {
	return model.MarketStatus{TopN: 3000, CacheSize: m.snap.Len(), LastSuccessAt: testNow, HistoryHours: m.hours}
}
func (m *stubMarket) RankAt(id int64, ago time.Duration) (model.Sample, bool) {
	for _, s := range m.hist[id] {
		if d := s.At.Sub(testNow.Add(-ago)); d > -time.Hour && d < time.Hour {
			return s, true
		}
	}
	return model.Sample{}, false
}

func quote(id int64, sym string, rank int, mcap, vol, c24 float64, tags ...string) model.Quote {
	return model.Quote{
		ID: id, Symbol: sym, Name: sym + " Token", Slug: strings.ToLower(sym),
		Rank: rank, Price: 1.5, MarketCap: mcap, Volume24h: vol,
		Change24hPct: c24, Change7dPct: 2 * c24,
		DateAdded:   testNow.Add(-10 * 24 * time.Hour),
		Tags:        tags,
		LastUpdated: testNow.Add(-time.Minute),
		FetchedAt:   testNow.Add(-time.Minute),
	}
}

func newStubMarket() *stubMarket {
	var qs []model.Quote
	for i := int64(1); i <= 6; i++ {
		qs = append(qs, quote(i, "GEM"+string(rune('A'+i)), 600+int(i), 5e6*float64(i), 4e6, float64(i), "depin"))
	}
	qs = append(qs, quote(100, "BIG", 5, 90e9, 3e9, 1, "layer-1"))
	return &stubMarket{snap: market.NewSnapshot(qs, testNow), hist: map[int64][]model.Sample{}}
}

var prices = map[string]string{"gems": "$0.02", "screen": "$0.01", "climbers": "$0.01", "sectors": "$0.01", "asset": "$0.01", "digest": "$0.03"}

func newServer(t *testing.T, m Market, pw Paywall) *httptest.Server {
	t.Helper()
	s := New(Config{
		Prices:  prices,
		Paywall: pw,
		Now:     func() time.Time { return testNow },
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}, m)
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return srv
}

func get(t *testing.T, c *http.Client, url string) (*http.Response, map[string]any) {
	t.Helper()
	if c == nil {
		c = http.DefaultClient
	}
	resp, err := c.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]any
	raw, _ := io.ReadAll(resp.Body)
	_ = json.Unmarshal(raw, &body)
	return resp, body
}

func errCode(body map[string]any) string {
	e, _ := body["error"].(map[string]any)
	s, _ := e["code"].(string)
	return s
}

func TestFreeModeEndpoints(t *testing.T) {
	srv := newServer(t, newStubMarket(), nil)
	for _, tc := range []struct {
		path   string
		status int
		code   string
	}{
		{"/v1/gems?limit=3", 200, ""},
		{"/v1/screen", 200, ""},
		{"/v1/sectors?min_members=2", 200, ""},
		{"/v1/sectors?sector=DePIN", 200, ""},
		{"/v1/sectors?sector=nope", 404, codeSectorNotFound},
		{"/v1/asset?asset=gemb", 200, ""},
		{"/v1/asset?asset=nope", 404, codeAssetNotFound},
		{"/v1/asset", 400, codeInvalidParam},
		{"/v1/digest", 200, ""},
		{"/v1/climbers", 503, codeInsufficientHistory},
		{"/v1/gems?limit=0", 400, codeInvalidParam},
		{"/v1/gems?unknown=1", 400, codeInvalidParam},
		{"/v1/gems?min_market_cap=9&max_market_cap=1", 400, codeInvalidParam},
		{"/v1/new-listings", 404, codeNotFound},
		{"/v1/resolve?query=BTC", 404, codeNotFound},
		{"/v1/status", 200, ""},
	} {
		resp, body := get(t, nil, srv.URL+tc.path)
		if resp.StatusCode != tc.status || errCode(body) != tc.code {
			t.Errorf("%s: got %d %q, want %d %q (%v)", tc.path, resp.StatusCode, errCode(body), tc.status, tc.code, body)
		}
	}

	_, body := get(t, nil, srv.URL+"/v1/gems?limit=3")
	data := body["data"].([]any)
	if len(data) != 3 || body["note"] == nil || body["as_of"] == nil {
		t.Fatalf("gems envelope = %v", body)
	}
	if w, _ := body["warnings"].([]any); len(w) != 1 {
		t.Fatalf("want an insufficient_history warning, got %v", body["warnings"])
	}
	_, body = get(t, nil, srv.URL+"/v1/screen")
	first := body["data"].([]any)[0].(map[string]any)
	if first["symbol"] != "GEMB" { // highest turnover under $50M: 4M/5M
		t.Fatalf("screen should default to top turnover under $50M, got %v", first["symbol"])
	}
}

func TestClimbersWithHistory(t *testing.T) {
	m := newStubMarket()
	m.hours = 30
	m.hist[1] = []model.Sample{{At: testNow.Add(-24 * time.Hour), Rank: 900}}
	srv := newServer(t, m, nil)
	resp, body := get(t, nil, srv.URL+"/v1/climbers")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d: %v", resp.StatusCode, body)
	}
	data := body["data"].([]any)
	if len(data) != 1 || data[0].(map[string]any)["rank_then"].(float64) != 900 {
		t.Fatalf("climbers = %v", data)
	}
}

func TestNotReadyAndStale(t *testing.T) {
	m := &stubMarket{snap: market.NewSnapshot(nil, testNow)}
	srv := newServer(t, m, nil)
	resp, body := get(t, nil, srv.URL+"/v1/gems")
	if resp.StatusCode != 503 || errCode(body) != codeUpstream || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("not ready: %d %v", resp.StatusCode, body)
	}
	resp, body = get(t, nil, srv.URL+"/v1/status")
	if resp.StatusCode != 503 || body["status"] != "starting" {
		t.Fatalf("status while starting: %d %v", resp.StatusCode, body["status"])
	}

	old := quote(1, "OLD", 700, 5e6, 4e6, 1)
	old.FetchedAt = testNow.Add(-2 * time.Hour)
	m.snap = market.NewSnapshot([]model.Quote{old}, testNow.Add(-2*time.Hour))
	resp, body = get(t, nil, srv.URL+"/v1/gems")
	if resp.StatusCode != 503 || errCode(body) != codeUpstream {
		t.Fatalf("stale: %d %v", resp.StatusCode, body)
	}
}

func TestOpenAPIAndDocs(t *testing.T) {
	srv := newServer(t, newStubMarket(), nil)
	resp, body := get(t, nil, srv.URL+"/v1/openapi.json")
	if resp.StatusCode != 200 || body["openapi"] != "3.0.3" {
		t.Fatalf("openapi: %d", resp.StatusCode)
	}
	paths := body["paths"].(map[string]any)
	for _, p := range []string{"/v1/gems", "/v1/screen", "/v1/climbers", "/v1/sectors", "/v1/asset", "/v1/digest", "/v1/status"} {
		if paths[p] == nil {
			t.Errorf("openapi missing %s", p)
		}
	}
	gems := paths["/v1/gems"].(map[string]any)["get"].(map[string]any)
	if gems["x-payment"].(map[string]any)["price"] != "$0.02" || gems["responses"].(map[string]any)["402"] == nil {
		t.Fatalf("gems op lacks payment info: %v", gems)
	}
	if paths["/v1/new-listings"] != nil {
		t.Fatal("removed endpoint still documented")
	}

	r, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != 200 || !strings.Contains(string(page), "/v1/gems") || !strings.Contains(string(page), "$0.02") {
		t.Fatalf("docs page: %d", r.StatusCode)
	}
}

func TestCORSPreflight(t *testing.T) {
	srv := newServer(t, newStubMarket(), nil)
	req, _ := http.NewRequest(http.MethodOptions, srv.URL+"/v1/gems", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 204 || !strings.Contains(resp.Header.Get("Access-Control-Allow-Headers"), "PAYMENT-SIGNATURE") {
		t.Fatalf("preflight: %d %v", resp.StatusCode, resp.Header)
	}
}

// fakeFacilitator accepts every payment and records what it was asked.
type fakeFacilitator struct {
	mu       sync.Mutex
	verifies int
	settles  int
	lastReq  map[string]any
}

func (f *fakeFacilitator) GetSupported(context.Context) (x402.SupportedResponse, error) {
	return x402.SupportedResponse{Kinds: []x402.SupportedKind{{X402Version: 2, Scheme: "exact", Network: "eip155:84532"}}}, nil
}

func (f *fakeFacilitator) Verify(_ context.Context, payload, reqs []byte) (*x402.VerifyResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.verifies++
	_ = json.Unmarshal(reqs, &f.lastReq)
	var p struct {
		Payload struct {
			Authorization struct {
				From string `json:"from"`
			} `json:"authorization"`
		} `json:"payload"`
	}
	_ = json.Unmarshal(payload, &p)
	return &x402.VerifyResponse{IsValid: true, Payer: p.Payload.Authorization.From}, nil
}

func (f *fakeFacilitator) Settle(context.Context, []byte, []byte) (*x402.SettleResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.settles++
	return &x402.SettleResponse{Success: true, Transaction: "0xfeed", Network: "eip155:84532"}, nil
}

func (f *fakeFacilitator) counts() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.verifies, f.settles
}

const payTo = "0x2222222222222222222222222222222222222222"

func payingClient(t *testing.T) *http.Client {
	t.Helper()
	key, err := ecdsa.GenerateKey(crypto.S256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := evmsigners.NewClientSignerFromPrivateKey(hex.EncodeToString(crypto.FromECDSA(key)))
	if err != nil {
		t.Fatal(err)
	}
	client := x402.Newx402Client().Register("eip155:*", evmclient.NewExactEvmScheme(signer, nil))
	return x402http.WrapHTTPClientWithPayment(&http.Client{Timeout: 10 * time.Second}, x402http.Newx402HTTPClient(client))
}

func TestX402PaymentFlow(t *testing.T) {
	fac := &fakeFacilitator{}
	pw, err := paywall.New(paywall.Config{
		PayTo:       payTo,
		Network:     "eip155:84532",
		Routes:      PaidRoutes(prices),
		Facilitator: fac,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := newServer(t, newStubMarket(), pw)

	// Before the facilitator sync, paid routes refuse without asking for money.
	resp, body := get(t, nil, srv.URL+"/v1/gems")
	if resp.StatusCode != 503 || errCode(body) != "payments_unavailable" {
		t.Fatalf("before sync: %d %v", resp.StatusCode, body)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pw.Run(ctx)
	if !pw.Ready() {
		t.Fatal("paywall not ready after Run")
	}

	// Unpaid: 402 with the x402 v2 requirements in PAYMENT-REQUIRED.
	resp, body = get(t, nil, srv.URL+"/v1/gems?limit=2")
	if resp.StatusCode != http.StatusPaymentRequired || errCode(body) != "payment_required" {
		t.Fatalf("unpaid: %d %v", resp.StatusCode, body)
	}
	raw, err := base64.StdEncoding.DecodeString(resp.Header.Get("PAYMENT-REQUIRED"))
	if err != nil {
		t.Fatalf("PAYMENT-REQUIRED header: %v", err)
	}
	var req struct {
		X402Version int `json:"x402Version"`
		Accepts     []struct {
			Scheme, Network, Asset, Amount, PayTo string
		} `json:"accepts"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		t.Fatal(err)
	}
	a := req.Accepts[0]
	if req.X402Version != 2 || a.Scheme != "exact" || a.Network != "eip155:84532" || a.Amount != "20000" || !strings.EqualFold(a.PayTo, payTo) {
		t.Fatalf("requirements = %+v", req)
	}

	// Validation and readiness failures come before the 402.
	if resp, body := get(t, nil, srv.URL+"/v1/gems?limit=99"); resp.StatusCode != 400 {
		t.Fatalf("bad param should be 400 before payment, got %d %v", resp.StatusCode, body)
	}
	if resp, body := get(t, nil, srv.URL+"/v1/climbers"); resp.StatusCode != 503 || errCode(body) != codeInsufficientHistory {
		t.Fatalf("climbers without history should be 503 before payment, got %d %v", resp.StatusCode, body)
	}
	if v, s := fac.counts(); v != 0 || s != 0 {
		t.Fatalf("facilitator touched before any payment: verify=%d settle=%d", v, s)
	}

	// Paid: the SDK client signs, the facilitator verifies and settles.
	payer := payingClient(t)
	resp, body = get(t, payer, srv.URL+"/v1/gems?limit=2")
	if resp.StatusCode != 200 || len(body["data"].([]any)) != 2 {
		t.Fatalf("paid gems: %d %v", resp.StatusCode, body)
	}
	receipt, err := base64.StdEncoding.DecodeString(resp.Header.Get("PAYMENT-RESPONSE"))
	if err != nil || !strings.Contains(string(receipt), "0xfeed") {
		t.Fatalf("PAYMENT-RESPONSE = %q, %v", receipt, err)
	}
	if v, s := fac.counts(); v != 1 || s != 1 {
		t.Fatalf("after paid call: verify=%d settle=%d", v, s)
	}
	if amt := fac.lastReq["amount"]; amt != "20000" {
		t.Fatalf("verified amount = %v, want 20000 ($0.02 USDC)", amt)
	}

	// A paid call whose handler fails (unknown asset) is verified but never settled.
	resp, body = get(t, payer, srv.URL+"/v1/asset?asset=doesnotexist")
	if resp.StatusCode != 404 || errCode(body) != codeAssetNotFound {
		t.Fatalf("paid unknown asset: %d %v", resp.StatusCode, body)
	}
	if _, s := fac.counts(); s != 1 {
		t.Fatalf("failed call was settled (settles=%d)", s)
	}

	// Digest costs $0.03.
	resp, _ = get(t, payer, srv.URL+"/v1/digest")
	if resp.StatusCode != 200 || fac.lastReq["amount"] != "30000" {
		t.Fatalf("digest: %d amount %v", resp.StatusCode, fac.lastReq["amount"])
	}
	if st := pw.Status(); st.PaymentsSettled != 2 || !st.Ready {
		t.Fatalf("paywall status = %+v", st)
	}
}
