package discover

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fozagtx/100xAltcoin/internal/market"
	"github.com/fozagtx/100xAltcoin/internal/model"
)

var testNow = time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)

// fakeMarket is an in-memory discover.Market for tests.
type fakeMarket struct {
	snap  *market.Snapshot
	hist  map[int64][]model.Sample
	hours int
}

var _ Market = (*fakeMarket)(nil)

func (f *fakeMarket) Snapshot() *market.Snapshot      { return f.snap }
func (f *fakeMarket) History(id int64) []model.Sample { return f.hist[id] }
func (f *fakeMarket) RankAt(id int64, ago time.Duration) (model.Sample, bool) {
	ring := f.hist[id]
	if len(ring) == 0 {
		return model.Sample{}, false
	}
	target := testNow.Add(-ago)
	best := ring[0]
	bestDist := absDur(best.At.Sub(target))
	for _, s := range ring[1:] {
		if d := absDur(s.At.Sub(target)); d < bestDist {
			best, bestDist = s, d
		}
	}
	tol := ago / 4
	if tol < 30*time.Minute {
		tol = 30 * time.Minute
	}
	if bestDist > tol {
		return model.Sample{}, false
	}
	return best, true
}
func (f *fakeMarket) HistoryHours() int { return f.hours }
func (f *fakeMarket) Status() model.MarketStatus {
	return model.MarketStatus{TopN: 3000, CacheSize: f.snap.Len(), LastSuccessAt: testNow}
}

func absDur(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

func quote(id int64, sym, name string, rank int, mcap, vol, c24 float64, tags ...string) model.Quote {
	return model.Quote{
		ID: id, Symbol: sym, Name: name, Slug: name,
		Rank: rank, Price: 1.5, MarketCap: mcap, Volume24h: vol,
		Change24hPct: c24, Change7dPct: 2 * c24,
		DateAdded:   testNow.Add(-30 * 24 * time.Hour),
		Tags:        tags,
		LastUpdated: testNow.Add(-time.Minute),
		FetchedAt:   testNow.Add(-time.Minute),
	}
}

func newEngine(t *testing.T, m *fakeMarket) *Engine {
	t.Helper()
	return New(m, func() time.Time { return testNow })
}

func TestGemsSortedWithSignals(t *testing.T) {
	m := &fakeMarket{snap: market.NewSnapshot([]model.Quote{
		quote(1, "AAA", "Alpha", 500, 20e6, 4e6, 10, "depin"),
		quote(2, "BBB", "Beta", 501, 10e6, 0.5e6, 5, "memes"),
		quote(3, "STBL", "Stable", 502, 20e6, 5e6, 0.1, "stablecoin"),
	}, testNow), hours: 48}
	e := newEngine(t, m)
	res, err := e.Gems(context.Background(), GemsParams{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 2 {
		t.Fatalf("want 2 gems (stablecoin excluded), got %d", len(res.Items))
	}
	if res.Items[0].Symbol != "AAA" {
		t.Fatalf("AAA should outrank BBB on turnover, got %s", res.Items[0].Symbol)
	}
	if res.Items[0].RiskFlags == nil {
		t.Fatal("risk_flags must never be null")
	}
	if res.Items[0].Signals.Turnover.Score <= 0 {
		t.Fatal("turnover signal missing")
	}
}

func TestGemsWarningsAndFilters(t *testing.T) {
	m := &fakeMarket{snap: market.NewSnapshot([]model.Quote{
		quote(1, "AAA", "Alpha", 500, 20e6, 4e6, 10, "depin"),
		quote(2, "PMP", "Pumped", 501, 20e6, 4e6, 150, "depin"),
	}, testNow)}
	e := newEngine(t, m)
	res, err := e.Gems(context.Background(), GemsParams{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if res.HistoryHours != 0 || len(res.Warnings) != 1 || res.Warnings[0].Code != WarnInsufficientHistory {
		t.Fatalf("want one insufficient_history warning, got %+v", res.Warnings)
	}
	// PMP is already_pumped and excluded by default.
	if len(res.Items) != 1 || res.Items[0].Symbol != "AAA" {
		t.Fatalf("pumped asset should be excluded, got %+v", res.Items)
	}
	res, _ = e.Gems(context.Background(), GemsParams{Limit: 10, IncludePumped: true})
	if len(res.Items) != 2 {
		t.Fatalf("include_pumped should keep both, got %d", len(res.Items))
	}
	res, _ = e.Gems(context.Background(), GemsParams{Limit: 10, Sector: "nope"})
	if len(res.Items) != 0 {
		t.Fatalf("sector filter should empty the list, got %d", len(res.Items))
	}
}

func TestScreenFiltersAndSort(t *testing.T) {
	m := &fakeMarket{snap: market.NewSnapshot([]model.Quote{
		quote(1, "AAA", "Alpha", 100, 20e6, 4e6, 10, "depin"),
		quote(2, "BBB", "Beta", 200, 40e6, 1e6, -5, "gaming"),
		quote(3, "STBL", "Stable", 300, 30e6, 9e6, 0.1, "stablecoin"),
	}, testNow)}
	e := newEngine(t, m)

	res, err := e.Screen(context.Background(), ScreenParams{
		MinVolume: 2e6, Sort: "market_cap", Order: "desc", Limit: 10, ExcludeStablecoins: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 1 || res.Items[0].Symbol != "AAA" {
		t.Fatalf("min_volume+stablecoin exclusion leaves AAA, got %+v", res.Items)
	}

	res, _ = e.Screen(context.Background(), ScreenParams{
		HasMin24h: true, MinChange24h: -10, Sort: "rank", Order: "asc", Limit: 10,
	})
	if len(res.Items) != 3 {
		t.Fatalf("no exclusion: want 3, got %d", len(res.Items))
	}
	if res.Items[0].Rank != 100 {
		t.Fatalf("rank asc expected rank 100 first, got %d", res.Items[0].Rank)
	}
}

func TestClimbersWithAndWithoutHistory(t *testing.T) {
	m := &fakeMarket{snap: market.NewSnapshot([]model.Quote{
		quote(1, "AAA", "Alpha", 700, 20e6, 4e6, 10, "depin"),
	}, testNow)}
	e := newEngine(t, m)

	res, err := e.Climbers(context.Background(), ClimbersParams{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 0 || len(res.Warnings) != 1 {
		t.Fatalf("no history: want empty + warning, got %+v", res.Items)
	}

	m.hist = map[int64][]model.Sample{
		1: {{At: testNow.Add(-24 * time.Hour), Rank: 1000}},
	}
	m.hours = 24
	res, err = e.Climbers(context.Background(), ClimbersParams{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 1 || res.Items[0].RankChange != 300 || res.Items[0].RankThen != 1000 {
		t.Fatalf("want climb 1000→700, got %+v", res.Items)
	}
	if res.Items[0].RankChangePct != 30 {
		t.Fatalf("rank_change_pct want 30, got %v", res.Items[0].RankChangePct)
	}
}

func TestSectorsListAndDetail(t *testing.T) {
	mk := func(id int64, sym string, c24 float64) model.Quote {
		return quote(id, sym, sym, int(id)+100, 20e6, 4e6, c24, "depin")
	}
	qs := []model.Quote{mk(1, "A", 30), mk(2, "B", 20), mk(3, "C", 10), mk(4, "D", 0), mk(5, "E", -5)}
	m := &fakeMarket{snap: market.NewSnapshot(qs, testNow), hours: 100}
	e := newEngine(t, m)

	res, err := e.Sectors(context.Background(), SectorsParams{Sort: "heat", MinMembers: 2, Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Sectors) != 1 || res.Sectors[0].Tag != "depin" || res.Sectors[0].Heat <= 60 {
		t.Fatalf("unexpected sectors %+v", res.Sectors)
	}
	if len(res.Sectors[0].Leaders) != 3 || res.Sectors[0].Leaders[0].Symbol != "A" {
		t.Fatalf("leaders wrong: %+v", res.Sectors[0].Leaders)
	}

	det, err := e.Sectors(context.Background(), SectorsParams{Sector: "depin", Limit: 2})
	if err != nil || det.Detail == nil {
		t.Fatalf("detail: %+v %v", det, err)
	}
	if len(det.Detail.Members) != 2 || det.Detail.Members[0].Symbol != "A" {
		t.Fatalf("members sorted by 24h desc: %+v", det.Detail.Members)
	}

	_, err = e.Sectors(context.Background(), SectorsParams{Sector: "nope"})
	var snf *SectorNotFoundError
	if !errors.As(err, &snf) || len(snf.Hottest) == 0 {
		t.Fatalf("want SectorNotFoundError with hottest tags, got %v", err)
	}
}

func TestAssetLooksUpTheSnapshot(t *testing.T) {
	sol := quote(1, "SOL", "Solana", 5, 100e9, 3e9, 2, "layer-1")
	sol.Slug = "solana"
	fake := quote(2, "SOL", "Solana Fork", 900, 20e6, 4e6, 5)
	m := &fakeMarket{
		snap:  market.NewSnapshot([]model.Quote{sol, fake}, testNow),
		hist:  map[int64][]model.Sample{1: {{At: testNow.Add(-2 * time.Hour), Rank: 6}, {At: testNow.Add(-time.Hour), Rank: 5}}},
		hours: 100,
	}
	e := newEngine(t, m)
	for _, q := range []string{"SOL", "sol", "solana", "Solana", "1"} {
		res, err := e.Asset(context.Background(), q)
		if err != nil {
			t.Fatalf("%q: %v", q, err)
		}
		if res.Item.ID != 1 || res.Item.Slug != "solana" {
			t.Fatalf("%q resolved to %+v", q, res.Item.Item)
		}
		if res.Item.Confidence != "high" || res.Item.EligibleForGems {
			t.Fatalf("want high confidence, ineligible (mcap too big): %+v", res.Item)
		}
		if len(res.Item.RankHistory) != 2 || res.Item.RankHistory[1].Rank != 5 {
			t.Fatalf("rank history = %+v", res.Item.RankHistory)
		}
	}
	res, _ := e.Asset(context.Background(), "SOL")
	if len(res.Warnings) != 1 || res.Warnings[0].Code != WarnByRank || res.Warnings[0].Candidates[0].ID != 2 {
		t.Fatalf("duplicate ticker should warn with the alternative: %+v", res.Warnings)
	}
	if res, _ := e.Asset(context.Background(), "2"); res.Item.ID != 2 {
		t.Fatalf("id lookup should reach the fork, got %d", res.Item.ID)
	}

	_, err := e.Asset(context.Background(), "sola")
	var nf *AssetNotFoundError
	if !errors.As(err, &nf) || len(nf.Suggestions) != 2 || nf.Suggestions[0].ID != 1 {
		t.Fatalf("want AssetNotFoundError with suggestions, got %v %+v", err, nf)
	}
}

func TestSectorNameIsNormalized(t *testing.T) {
	mk := func(id int64, c24 float64) model.Quote {
		return quote(id, "S"+string(rune('A'+id)), "N", int(id)+100, 20e6, 4e6, c24, "account-abstraction")
	}
	m := &fakeMarket{snap: market.NewSnapshot([]model.Quote{mk(1, 5), mk(2, 4), mk(3, 3), mk(4, 2), mk(5, 1)}, testNow)}
	e := newEngine(t, m)
	for _, name := range []string{"account-abstraction", "Account Abstraction", "ACCOUNT_ABSTRACTION"} {
		res, err := e.Sectors(context.Background(), SectorsParams{Sector: name})
		if err != nil || res.Detail == nil || len(res.Detail.Members) != 5 {
			t.Fatalf("%q: %+v %v", name, res, err)
		}
	}
	gems, _ := e.Gems(context.Background(), GemsParams{Sector: "Account Abstraction"})
	if len(gems.Items) != 5 {
		t.Fatalf("gems sector filter found %d", len(gems.Items))
	}
}

func TestClimbersSkipNonMovers(t *testing.T) {
	m := &fakeMarket{
		snap: market.NewSnapshot([]model.Quote{
			quote(1, "UP", "Up", 700, 20e6, 4e6, 10),
			quote(2, "FLAT", "Flat", 800, 20e6, 4e6, 0),
			quote(3, "DOWN", "Down", 900, 20e6, 4e6, -10),
		}, testNow),
		hist: map[int64][]model.Sample{
			1: {{At: testNow.Add(-24 * time.Hour), Rank: 1000}},
			2: {{At: testNow.Add(-24 * time.Hour), Rank: 800}},
			3: {{At: testNow.Add(-24 * time.Hour), Rank: 600}},
		},
		hours: 30,
	}
	e := newEngine(t, m)
	up, _ := e.Climbers(context.Background(), ClimbersParams{Limit: 10})
	if len(up.Items) != 1 || up.Items[0].Symbol != "UP" {
		t.Fatalf("up = %+v", up.Items)
	}
	down, _ := e.Climbers(context.Background(), ClimbersParams{Down: true, Limit: 10})
	if len(down.Items) != 1 || down.Items[0].Symbol != "DOWN" || down.Items[0].RankChange != -300 {
		t.Fatalf("down = %+v", down.Items)
	}
}

func TestDigestBundlesSections(t *testing.T) {
	var qs []model.Quote
	for i := int64(1); i <= 8; i++ {
		qs = append(qs, quote(i, "G"+string(rune('A'+i)), "Gem", int(i)+500, 10e6, float64(i)*2e6, float64(i), "depin"))
	}
	m := &fakeMarket{snap: market.NewSnapshot(qs, testNow), hours: 3}
	e := newEngine(t, m)
	res, err := e.Digest(context.Background(), DigestParams{})
	if err != nil {
		t.Fatal(err)
	}
	d := res.Digest
	if len(d.TopGems) != 5 || len(d.HotSectors) != 1 || d.Climbers == nil || len(d.Climbers) != 0 {
		t.Fatalf("digest = %d gems, %d sectors, climbers %v", len(d.TopGems), len(d.HotSectors), d.Climbers)
	}
	if len(res.Warnings) != 1 || res.Warnings[0].Code != WarnInsufficientHistory {
		t.Fatalf("warnings = %+v", res.Warnings)
	}
}

func TestNormalizeTag(t *testing.T) {
	for in, want := range map[string]string{
		"  AI Big Data ":    "ai-big-data",
		"real_world_assets": "real-world-assets",
		"depin":             "depin",
		"":                  "",
	} {
		if got := NormalizeTag(in); got != want {
			t.Errorf("NormalizeTag(%q) = %q, want %q", in, got, want)
		}
	}
}
