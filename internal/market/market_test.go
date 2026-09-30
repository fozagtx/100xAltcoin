package market

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/fozagtx/100xAltcoin/internal/cmc"
	"github.com/fozagtx/100xAltcoin/internal/model"
)

var t0 = time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)

// clock is a manually advanced time source.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// fakeUp is an in-memory cmc.Upstream with call counters and injectable
// failures. Every listings call costs one credit.
type fakeUp struct {
	mu       sync.Mutex
	ranked   []model.Quote // index 0 is rank 1
	failPage map[int]error // by listings start
	key      model.KeyUsage
	starts   []int
}

var _ cmc.Upstream = (*fakeUp)(nil)

func (f *fakeUp) ListingsLatest(_ context.Context, start, limit int) ([]model.Quote, cmc.Meta, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts = append(f.starts, start)
	if err := f.failPage[start]; err != nil {
		return nil, cmc.Meta{}, err
	}
	var out []model.Quote
	for i := start - 1; i < start-1+limit && i < len(f.ranked); i++ {
		out = append(out, f.ranked[i])
	}
	return out, cmc.Meta{CreditCount: 1, HTTPStatus: 200}, nil
}

func (f *fakeUp) KeyInfo(context.Context) (model.KeyUsage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.key, nil
}

func (f *fakeUp) takeStarts() []int {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.starts
	f.starts = nil
	return s
}

func asset(id int64, rank int, updated time.Time) model.Quote {
	return model.Quote{
		ID:          id,
		Symbol:      fmt.Sprintf("A%d", id),
		Name:        fmt.Sprintf("Asset %d", id),
		Rank:        rank,
		Price:       float64(id),
		MarketCap:   float64(1e9 / rank),
		LastUpdated: updated,
	}
}

func assets(n int, updated time.Time) []model.Quote {
	qs := make([]model.Quote, n)
	for i := range qs {
		qs[i] = asset(int64(1001+i), i+1, updated)
	}
	return qs
}

func newTestMarket(tweak func(*Config)) (*Market, *fakeUp, *clock) {
	clk := &clock{t: t0}
	up := &fakeUp{failPage: map[int]error{}}
	cfg := Config{Now: clk.Now, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if tweak != nil {
		tweak(&cfg)
	}
	return New(up, cfg), up, clk
}

func TestPollOncePublishesSnapshotAndHistory(t *testing.T) {
	m, up, clk := newTestMarket(func(c *Config) { c.TopN, c.PageSize = 4, 2 })
	up.ranked = assets(4, t0)
	if err := m.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	snap := m.Snapshot()
	if snap.Len() != 4 || snap.ByRank[0].ID != 1001 || snap.ByRank[3].ID != 1004 {
		t.Fatalf("snapshot = %d assets", snap.Len())
	}
	if h := m.History(1001); len(h) != 1 || h[0].Rank != 1 {
		t.Fatalf("history = %+v", h)
	}

	// Inside the same hourly bucket no sample is added; past it one is.
	clk.Advance(30 * time.Minute)
	_ = m.PollOnce(context.Background())
	if h := m.History(1001); len(h) != 1 {
		t.Fatalf("history len = %d", len(h))
	}
	clk.Advance(31 * time.Minute)
	_ = m.PollOnce(context.Background())
	if h := m.History(1001); len(h) != 2 {
		t.Fatalf("history len = %d", len(h))
	}
	st := m.Status()
	if st.HistoryAssets != 4 || st.HistoryHours != 1 || st.CacheSize != 4 {
		t.Fatalf("status = %+v", st)
	}
	if st.CreditsUsedToday != 6 || st.UpstreamCalls != 6 {
		t.Fatalf("credits = %d, calls = %d", st.CreditsUsedToday, st.UpstreamCalls)
	}
}

func TestSlowTierRefreshesOnlyWhenDue(t *testing.T) {
	m, up, clk := newTestMarket(func(c *Config) {
		c.TopN, c.FastN, c.PageSize = 4, 2, 2
		c.PollInterval, c.SlowInterval = time.Minute, 10*time.Minute
	})
	up.ranked = assets(4, t0)
	_ = m.poll(context.Background(), true)
	if got := up.takeStarts(); len(got) != 2 {
		t.Fatalf("first poll fetched %v, want both pages", got)
	}
	clk.Advance(time.Minute)
	_ = m.poll(context.Background(), false)
	if got := up.takeStarts(); len(got) != 1 || got[0] != 1 {
		t.Fatalf("fast poll fetched %v, want only page 1", got)
	}
	clk.Advance(10 * time.Minute)
	_ = m.poll(context.Background(), false)
	if got := up.takeStarts(); len(got) != 2 {
		t.Fatalf("due poll fetched %v, want both pages", got)
	}
}

func TestPartialFailureKeepsPreviousPage(t *testing.T) {
	m, up, clk := newTestMarket(func(c *Config) { c.TopN, c.PageSize = 4, 2 })
	up.ranked = assets(4, t0)
	_ = m.PollOnce(context.Background())

	clk.Advance(time.Minute)
	up.failPage[3] = &cmc.APIError{HTTPStatus: 500, Message: "boom", Endpoint: "/v1/cryptocurrency/listings/latest"}
	err := m.PollOnce(context.Background())
	if err == nil {
		t.Fatal("want an error for the failed page")
	}
	if n := m.Snapshot().Len(); n != 4 {
		t.Fatalf("snapshot has %d assets, want 4 (failed page kept)", n)
	}
	st := m.Status()
	if st.LastError == "" || !st.LastSuccessAt.Equal(t0) {
		t.Fatalf("status = %+v", st)
	}

	// A fully failed poll keeps the previous snapshot entirely.
	up.failPage[1] = errors.New("down")
	_ = m.PollOnce(context.Background())
	if n := m.Snapshot().Len(); n != 4 {
		t.Fatalf("snapshot has %d assets after full failure", n)
	}
}

func TestSeedAndHistoryRoundTrip(t *testing.T) {
	m, up, _ := newTestMarket(func(c *Config) { c.TopN, c.PageSize = 4, 2 })
	hist := map[int64][]model.Sample{
		1001: {{At: t0.Add(-25 * time.Hour), Rank: 9}, {At: t0.Add(-time.Hour), Rank: 3}},
		1002: {{At: t0.Add(-8 * 24 * time.Hour), Rank: 50}}, // outside the 7-day window
	}
	m.SeedHistory(hist)
	m.Seed(assets(4, t0.Add(-time.Hour)), t0.Add(-time.Hour))
	if !m.Ready() {
		t.Fatal("seeded market should be ready")
	}
	if s, ok := m.RankAt(1001, 24*time.Hour); !ok || s.Rank != 9 {
		t.Fatalf("RankAt 24h = %+v, %v", s, ok)
	}
	if got := m.ExportHistory(); len(got) != 1 || len(got[1001]) != 2 {
		t.Fatalf("export = %+v", got)
	}
	if h := m.HistoryHours(); h != 25 {
		t.Fatalf("history hours = %d", h)
	}

	// A poll replaces the seeded snapshot; a later Seed does not override it.
	up.ranked = assets(4, t0)
	_ = m.PollOnce(context.Background())
	m.Seed(assets(2, t0.Add(time.Hour)), t0.Add(time.Hour))
	if n := m.Snapshot().Len(); n != 4 {
		t.Fatalf("Seed after a poll replaced the snapshot (%d assets)", n)
	}
}

func TestKeyInfoCredits(t *testing.T) {
	m, up, _ := newTestMarket(nil)
	up.key = model.KeyUsage{CreditLimitMonthly: 10000, CreditsUsedToday: 40, CreditsUsedMonth: 900, FetchedAt: t0}
	m.refreshKeyInfo(context.Background())
	st := m.Status()
	if st.CreditLimitMonthly != 10000 || st.CreditsUsedToday != 40 || st.CreditsUsedMonth != 900 {
		t.Fatalf("status = %+v", st)
	}
}
