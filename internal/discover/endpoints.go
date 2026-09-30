package discover

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/fozagtx/100xAltcoin/internal/market"
	"github.com/fozagtx/100xAltcoin/internal/model"
	"github.com/fozagtx/100xAltcoin/internal/signals"
)

// SignalSet is the four signal components of a scored asset.
type SignalSet struct {
	Turnover   signals.Component `json:"turnover"`
	NewListing signals.Component `json:"new_listing"`
	RankClimb  signals.Component `json:"rank_climb"`
	SectorHeat signals.Component `json:"sector_heat"`
}

func signalSetOf(g signals.Gem) SignalSet {
	return SignalSet{
		Turnover:   g.Signals.Turnover,
		NewListing: g.Signals.NewListing,
		RankClimb:  g.Signals.RankClimb,
		SectorHeat: g.Signals.SectorHeat,
	}
}

// GemItem is one /v1/gems row.
type GemItem struct {
	Item
	Score      float64   `json:"score"`
	Confidence string    `json:"confidence"`
	Signals    SignalSet `json:"signals"`
	RiskFlags  []string  `json:"risk_flags"`
	Why        []string  `json:"why"`
	HotSectors []string  `json:"hot_sectors"`
}

// GemsParams selects which assets are scored for /v1/gems.
type GemsParams struct {
	MaxMarketCap     float64 // default 50e6
	MinMarketCap     float64 // default 1e6
	MinVolume        float64 // default 100e3
	ListedWithinDays int     // 0 = any age
	Sector           string  // when set, only assets carrying this tag
	IncludePumped    bool    // keep gems flagged already_pumped
	Limit            int     // 0 = all
}

// GemsResult is the /v1/gems payload plus response metadata.
type GemsResult struct {
	Items        []GemItem
	AsOf         time.Time
	HistoryHours int
	Warnings     []Warning
}

// Gems scores every eligible asset in the snapshot and returns the best,
// highest composite score first.
func (e *Engine) Gems(_ context.Context, p GemsParams) (*GemsResult, error) {
	snap := e.market.Snapshot()
	sec := e.sectorsFor(snap, sectorMinMembers)
	hours := e.market.HistoryHours()
	opts := signals.Options{
		Now:              e.now(),
		MaxMarketCap:     p.MaxMarketCap,
		MinMarketCap:     p.MinMarketCap,
		MinVolume24h:     p.MinVolume,
		ListedWithinDays: p.ListedWithinDays,
	}
	sector := NormalizeTag(p.Sector)
	gems := signals.Rank(snap, e.market.History, sec, hours, opts, 0)
	items := make([]GemItem, 0, min(len(gems), max(p.Limit, 0)))
	for _, g := range gems {
		if sector != "" && !hasTag(g.Quote, sector) {
			continue
		}
		if !p.IncludePumped && hasFlag(g.RiskFlags, "already_pumped") {
			continue
		}
		items = append(items, GemItem{
			Item:       itemOf(g.Quote),
			Score:      g.Score,
			Confidence: g.Confidence,
			Signals:    signalSetOf(g),
			RiskFlags:  nonNil(g.RiskFlags),
			Why:        nonNil(g.Why),
			HotSectors: nonNil(g.HotSectors),
		})
		if p.Limit > 0 && len(items) >= p.Limit {
			break
		}
	}
	return &GemsResult{
		Items:        items,
		AsOf:         snap.OldestFetch(),
		HistoryHours: hours,
		Warnings:     e.shortHistoryWarning(),
	}, nil
}

// ScreenParams filters the snapshot for /v1/screen.
type ScreenParams struct {
	MinMarketCap, MaxMarketCap float64
	MinVolume, MaxVolume       float64
	MinTurnover                float64
	MinChange1h, MaxChange1h   float64
	MinChange24h, MaxChange24h float64
	MinChange7d, MaxChange7d   float64
	HasMin1h, HasMax1h         bool
	HasMin24h, HasMax24h       bool
	HasMin7d, HasMax7d         bool
	Tags                       []string // match ANY
	ListedWithinDays           int
	ExcludeStablecoins         bool
	Sort                       string // change_1h_pct|change_24h_pct|change_7d_pct|volume_24h|market_cap|turnover|rank
	Order                      string // asc|desc
	Limit                      int
}

// ScreenResult is the /v1/screen payload plus response metadata.
type ScreenResult struct {
	Items []Item
	AsOf  time.Time
}

var stableTags = map[string]bool{
	"stablecoin": true, "asset-backed-stablecoin": true,
	"fiat-stablecoin": true, "wrapped-tokens": true,
}

// Screen filters the snapshot without scoring.
func (e *Engine) Screen(_ context.Context, p ScreenParams) (*ScreenResult, error) {
	snap := e.market.Snapshot()
	cutoff := e.now().Add(-time.Duration(p.ListedWithinDays) * 24 * time.Hour)
	tags := make([]string, 0, len(p.Tags))
	for _, t := range p.Tags {
		if t = NormalizeTag(t); t != "" {
			tags = append(tags, t)
		}
	}
	var out []Item
	for _, q := range snap.ByRank {
		if q.MarketCap < p.MinMarketCap || (p.MaxMarketCap > 0 && q.MarketCap > p.MaxMarketCap) {
			continue
		}
		if q.Volume24h < p.MinVolume || (p.MaxVolume > 0 && q.Volume24h > p.MaxVolume) {
			continue
		}
		if turnover(q) < p.MinTurnover {
			continue
		}
		if p.HasMin1h && q.Change1hPct < p.MinChange1h || p.HasMax1h && q.Change1hPct > p.MaxChange1h {
			continue
		}
		if p.HasMin24h && q.Change24hPct < p.MinChange24h || p.HasMax24h && q.Change24hPct > p.MaxChange24h {
			continue
		}
		if p.HasMin7d && q.Change7dPct < p.MinChange7d || p.HasMax7d && q.Change7dPct > p.MaxChange7d {
			continue
		}
		if len(tags) > 0 && !hasAnyTag(q, tags) {
			continue
		}
		if p.ListedWithinDays > 0 && (q.DateAdded.IsZero() || q.DateAdded.Before(cutoff)) {
			continue
		}
		if p.ExcludeStablecoins && hasAnyTagMap(q, stableTags) {
			continue
		}
		out = append(out, itemOf(q))
	}
	key := screenKey(p.Sort)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := key(&out[i]), key(&out[j])
		if a != b {
			if p.Order == "asc" {
				return a < b
			}
			return a > b
		}
		return out[i].ID < out[j].ID
	})
	if p.Limit > 0 && len(out) > p.Limit {
		out = out[:p.Limit]
	}
	return &ScreenResult{Items: out, AsOf: snap.OldestFetch()}, nil
}

func screenKey(sort string) func(*Item) float64 {
	switch sort {
	case "change_1h_pct":
		return func(i *Item) float64 { return i.Change1hPct }
	case "change_7d_pct":
		return func(i *Item) float64 { return i.Change7dPct }
	case "volume_24h":
		return func(i *Item) float64 { return i.Volume24h }
	case "market_cap":
		return func(i *Item) float64 { return i.MarketCap }
	case "turnover":
		return func(i *Item) float64 { return i.Turnover }
	case "rank":
		return func(i *Item) float64 {
			if i.Rank == 0 {
				return math.MaxFloat64
			}
			return float64(i.Rank)
		}
	default: // change_24h_pct
		return func(i *Item) float64 { return i.Change24hPct }
	}
}

// ClimbWindow is the look-back of /v1/climbers. Only the 24h window is
// offered: it is the one the Telegram alerts proved out, and a 7d window
// needs a week of uninterrupted history that restarts kept wiping.
const ClimbWindow = 24 * time.Hour

// ClimberItem is one /v1/climbers row.
type ClimberItem struct {
	Item
	RankThen      int     `json:"rank_then"`
	RankChange    int     `json:"rank_change"`
	RankChangePct float64 `json:"rank_change_pct"`
}

// ClimbersParams selects the direction and filters for /v1/climbers.
type ClimbersParams struct {
	Down         bool // largest drops instead of climbs
	MinVolume    float64
	MaxMarketCap float64 // 0 = none
	Limit        int
}

// ClimbersResult is the /v1/climbers payload plus response metadata.
type ClimbersResult struct {
	Items        []ClimberItem
	AsOf         time.Time
	HistoryHours int
	Warnings     []Warning
}

// Climbers ranks assets by rank change over the last 24h using retained
// history samples.
func (e *Engine) Climbers(_ context.Context, p ClimbersParams) (*ClimbersResult, error) {
	snap := e.market.Snapshot()
	var out []ClimberItem
	for _, q := range snap.ByRank {
		if q.Rank <= 0 || q.Volume24h < p.MinVolume {
			continue
		}
		if p.MaxMarketCap > 0 && q.MarketCap > p.MaxMarketCap {
			continue
		}
		then, ok := e.market.RankAt(q.ID, ClimbWindow)
		if !ok || then.Rank == 0 {
			continue
		}
		change := then.Rank - q.Rank
		if p.Down && change >= 0 || !p.Down && change <= 0 {
			continue
		}
		pct := float64(change) / float64(then.Rank)
		out = append(out, ClimberItem{
			Item:          itemOf(q),
			RankThen:      then.Rank,
			RankChange:    change,
			RankChangePct: math.Round(pct*10000) / 100,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.RankChangePct != b.RankChangePct {
			if p.Down {
				return a.RankChangePct < b.RankChangePct
			}
			return a.RankChangePct > b.RankChangePct
		}
		if a.RankChange != b.RankChange {
			if p.Down {
				return a.RankChange < b.RankChange
			}
			return a.RankChange > b.RankChange
		}
		return a.ID < b.ID
	})
	if p.Limit > 0 && len(out) > p.Limit {
		out = out[:p.Limit]
	}
	return &ClimbersResult{
		Items:        out,
		AsOf:         snap.OldestFetch(),
		HistoryHours: e.market.HistoryHours(),
		Warnings:     e.shortHistoryWarning(),
	}, nil
}

// Leader is a sector's top member by 24h change.
type Leader struct {
	ID           int64   `json:"id"`
	Symbol       string  `json:"symbol"`
	Name         string  `json:"name"`
	Change24hPct float64 `json:"change_24h_pct"`
}

// SectorOut is one sector row for /v1/sectors.
type SectorOut struct {
	Tag                string   `json:"tag"`
	Members            int      `json:"members"`
	MedianChange24hPct float64  `json:"median_change_24h_pct"`
	MedianChange7dPct  float64  `json:"median_change_7d_pct"`
	TotalVolume24h     float64  `json:"total_volume_24h"`
	TotalMarketCap     float64  `json:"total_market_cap"`
	Heat               float64  `json:"heat"`
	Leaders            []Leader `json:"leaders"`
}

// SectorNotFoundError is returned by Sectors when the requested tag is not
// tracked. Hottest lists the current five hottest tags for guidance.
type SectorNotFoundError struct {
	Tag     string
	Hottest []string
}

func (e *SectorNotFoundError) Error() string { return fmt.Sprintf("sector %q not found", e.Tag) }

// SectorsParams selects /v1/sectors output.
type SectorsParams struct {
	Sort       string // heat|change_24h_pct|change_7d_pct|volume_24h|market_cap
	MinMembers int    // default 5
	Sector     string // when set, return that tag's detail
	Limit      int
}

// SectorsResult is the /v1/sectors payload. Detail is set instead of
// Sectors when a single sector was requested.
type SectorsResult struct {
	Sectors []SectorOut // sector list view
	Detail  *SectorDetail
	AsOf    time.Time
}

// SectorDetail is one sector plus its member items.
type SectorDetail struct {
	Sector  SectorOut `json:"sector"`
	Members []Item    `json:"members"`
}

// Sectors aggregates the snapshot by tag, or returns one sector's detail.
// The sector name is matched loosely: "Account Abstraction" and
// "account_abstraction" both find "account-abstraction".
func (e *Engine) Sectors(_ context.Context, p SectorsParams) (*SectorsResult, error) {
	if p.MinMembers <= 0 {
		p.MinMembers = sectorMinMembers
	}
	snap := e.market.Snapshot()
	sec := e.sectorsFor(snap, p.MinMembers)
	if p.Sector != "" {
		tag := NormalizeTag(p.Sector)
		s, ok := sec.Sector(tag)
		if !ok {
			return nil, &SectorNotFoundError{Tag: p.Sector, Hottest: e.hottest(sec, 5)}
		}
		var members []*model.Quote
		for _, q := range snap.ByRank {
			if hasTag(q, tag) {
				members = append(members, q)
			}
		}
		sort.SliceStable(members, func(i, j int) bool {
			if members[i].Change24hPct != members[j].Change24hPct {
				return members[i].Change24hPct > members[j].Change24hPct
			}
			return members[i].ID < members[j].ID
		})
		if p.Limit > 0 && len(members) > p.Limit {
			members = members[:p.Limit]
		}
		return &SectorsResult{
			Detail: &SectorDetail{Sector: e.sectorOut(snap, s), Members: itemsOf(members)},
			AsOf:   snap.OldestFetch(),
		}, nil
	}
	sorted := sec.Sorted(p.Sort)
	if p.Limit > 0 && len(sorted) > p.Limit {
		sorted = sorted[:p.Limit]
	}
	out := make([]SectorOut, 0, len(sorted))
	for _, s := range sorted {
		out = append(out, e.sectorOut(snap, s))
	}
	return &SectorsResult{Sectors: out, AsOf: snap.OldestFetch()}, nil
}

func (e *Engine) sectorOut(snap *market.Snapshot, s signals.Sector) SectorOut {
	leaders := make([]Leader, 0, len(s.Leaders))
	for _, id := range s.Leaders {
		if q, ok := snap.Get(id); ok {
			leaders = append(leaders, Leader{ID: q.ID, Symbol: q.Symbol, Name: q.Name, Change24hPct: finite(q.Change24hPct)})
		}
	}
	return SectorOut{
		Tag:                s.Tag,
		Members:            s.Members,
		MedianChange24hPct: finite(s.MedianChange24hPct),
		MedianChange7dPct:  finite(s.MedianChange7dPct),
		TotalVolume24h:     finite(s.TotalVolume24h),
		TotalMarketCap:     finite(s.TotalMarketCap),
		Heat:               finite(s.Heat),
		Leaders:            leaders,
	}
}

func (e *Engine) hottest(sec *signals.Sectors, n int) []string {
	sorted := sec.Sorted("heat")
	out := make([]string, 0, n)
	for _, s := range sorted {
		out = append(out, s.Tag)
		if len(out) == n {
			break
		}
	}
	return out
}

// NormalizeTag turns a user-typed sector name into CMC's tag slug form:
// lower case, words joined by hyphens.
func NormalizeTag(s string) string {
	s = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(s), "_", " "))
	return strings.Join(strings.Fields(s), "-")
}

// AssetItem is the /v1/asset detail object.
type AssetItem struct {
	Item
	Slug              string    `json:"slug"`
	CirculatingSupply float64   `json:"circulating_supply"`
	TotalSupply       float64   `json:"total_supply"`
	MaxSupply         *float64  `json:"max_supply"`
	Platform          string    `json:"platform,omitempty"`
	Score             float64   `json:"score"`
	Confidence        string    `json:"confidence"`
	EligibleForGems   bool      `json:"eligible_for_gems"`
	Signals           SignalSet `json:"signals"`
	RiskFlags         []string  `json:"risk_flags"`
	Why               []string  `json:"why"`
	HotSectors        []string  `json:"hot_sectors"`
	// RankHistory is the asset's retained hourly rank samples, oldest
	// first, thinned to at most 48 points.
	RankHistory []RankPoint `json:"rank_history"`
}

// RankPoint is one retained rank sample.
type RankPoint struct {
	At   string `json:"at"`
	Rank int    `json:"rank"`
}

// AssetNotFoundError is returned by Asset when no tracked asset matches.
// Suggestions holds the closest tracked matches, best ranked first.
type AssetNotFoundError struct {
	Query       string
	Suggestions []Candidate
}

func (e *AssetNotFoundError) Error() string {
	return fmt.Sprintf("no tracked asset matches %q", e.Query)
}

// AssetResult is the /v1/asset payload plus response metadata.
type AssetResult struct {
	Item         AssetItem
	AsOf         time.Time
	HistoryHours int
	Warnings     []Warning
}

// Asset finds one asset in the tracked universe by CMC id, symbol, slug or
// name and scores it. It never calls CMC: assets outside the tracked top N
// are reported as not found, with suggestions.
func (e *Engine) Asset(_ context.Context, query string) (*AssetResult, error) {
	snap := e.market.Snapshot()
	q, alts := lookup(snap, query)
	if q == nil {
		return nil, &AssetNotFoundError{Query: query, Suggestions: suggest(snap, query, 5)}
	}
	var warns []Warning
	if len(alts) > 0 {
		rank := ""
		if q.Rank > 0 {
			rank = fmt.Sprintf(", rank %d", q.Rank)
		}
		cands := make([]Candidate, 0, min(len(alts), maxCandidates))
		for _, a := range alts {
			cands = append(cands, candidateOf(a))
			if len(cands) == maxCandidates {
				break
			}
		}
		warns = append(warns, Warning{
			Code: WarnByRank,
			Message: fmt.Sprintf("%q matches %d tracked assets; returned %s (id %d%s), the best ranked. Pass an id from candidates to get another.",
				query, len(alts)+1, q.Name, q.ID, rank),
			Query:      query,
			ChosenID:   q.ID,
			Candidates: cands,
		})
	}
	hours := e.market.HistoryHours()
	hist := e.market.History(q.ID)
	g := signals.Score(q, hist, e.sectorsFor(snap, sectorMinMembers), hours, signals.Options{Now: e.now()})
	item := AssetItem{
		Item:              itemOf(q),
		Slug:              q.Slug,
		CirculatingSupply: finite(q.CirculatingSupply),
		TotalSupply:       finite(q.TotalSupply),
		Platform:          q.Platform,
		Score:             g.Score,
		Confidence:        g.Confidence,
		EligibleForGems:   signals.Eligible(q, signals.Options{Now: e.now()}),
		Signals:           signalSetOf(g),
		RiskFlags:         nonNil(g.RiskFlags),
		Why:               nonNil(g.Why),
		HotSectors:        nonNil(g.HotSectors),
		RankHistory:       rankHistory(hist, 48),
	}
	if q.MaxSupply != nil && !math.IsNaN(*q.MaxSupply) && !math.IsInf(*q.MaxSupply, 0) {
		v := *q.MaxSupply
		item.MaxSupply = &v
	}
	asOf := q.FetchedAt
	if asOf.IsZero() {
		asOf = q.LastUpdated
	}
	return &AssetResult{Item: item, AsOf: asOf, HistoryHours: hours, Warnings: append(warns, e.shortHistoryWarning()...)}, nil
}

// lookup resolves query against the snapshot: a numeric CMC id first,
// then exact slug, symbol and name matches (case-insensitive). When a
// symbol or name matches several assets the best ranked wins and the
// others are returned as alternatives.
func lookup(snap *market.Snapshot, query string) (*model.Quote, []*model.Quote) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}
	if id, err := strconv.ParseInt(query, 10, 64); err == nil {
		if q, ok := snap.Get(id); ok {
			return q, nil
		}
	}
	for _, match := range []func(*model.Quote) bool{
		func(q *model.Quote) bool { return strings.EqualFold(q.Slug, query) },
		func(q *model.Quote) bool { return strings.EqualFold(q.Symbol, query) },
		func(q *model.Quote) bool { return strings.EqualFold(q.Name, query) },
	} {
		var hits []*model.Quote
		for _, q := range snap.ByRank { // ranked first, so hits[0] is the best ranked
			if match(q) {
				hits = append(hits, q)
			}
		}
		if len(hits) > 0 {
			return hits[0], hits[1:]
		}
	}
	return nil, nil
}

// suggest returns up to n tracked assets whose symbol or name contains
// query, best ranked first.
func suggest(snap *market.Snapshot, query string, n int) []Candidate {
	query = strings.ToLower(strings.TrimSpace(query))
	out := []Candidate{}
	if query == "" {
		return out
	}
	for _, q := range snap.ByRank {
		if strings.Contains(strings.ToLower(q.Symbol), query) || strings.Contains(strings.ToLower(q.Name), query) {
			out = append(out, candidateOf(q))
			if len(out) == n {
				break
			}
		}
	}
	return out
}

// rankHistory thins samples to at most n evenly spaced points, always
// keeping the newest.
func rankHistory(hist []model.Sample, n int) []RankPoint {
	out := make([]RankPoint, 0, min(len(hist), n))
	if len(hist) == 0 {
		return out
	}
	step := float64(len(hist)) / float64(n)
	if step < 1 {
		step = 1
	}
	for f := float64(len(hist) - 1); f >= 0 && len(out) < n; f -= step {
		s := hist[int(f)]
		out = append(out, RankPoint{At: formatTime(s.At), Rank: s.Rank})
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// DigestParams sizes the /v1/digest sections.
type DigestParams struct {
	Gems     int // default 5
	Climbers int // default 3
	Sectors  int // default 3
}

// Digest is the /v1/digest payload: the daily summary the Telegram bot
// used to post, as one call.
type Digest struct {
	TopGems    []GemItem     `json:"top_gems"`
	Climbers   []ClimberItem `json:"climbers"`
	HotSectors []SectorOut   `json:"hot_sectors"`
}

// DigestResult is the /v1/digest payload plus response metadata.
type DigestResult struct {
	Digest       Digest
	AsOf         time.Time
	HistoryHours int
	Warnings     []Warning
}

// Digest bundles the top gems, the 24h rank climbers and the hottest
// sectors. Climbers is empty (with an insufficient_history warning) until
// 24h of history exist.
func (e *Engine) Digest(ctx context.Context, p DigestParams) (*DigestResult, error) {
	if p.Gems <= 0 {
		p.Gems = 5
	}
	if p.Climbers <= 0 {
		p.Climbers = 3
	}
	if p.Sectors <= 0 {
		p.Sectors = 3
	}
	gems, err := e.Gems(ctx, GemsParams{Limit: p.Gems})
	if err != nil {
		return nil, err
	}
	climbs, err := e.Climbers(ctx, ClimbersParams{MinVolume: 100000, Limit: p.Climbers})
	if err != nil {
		return nil, err
	}
	secs, err := e.Sectors(ctx, SectorsParams{Sort: "heat", Limit: p.Sectors})
	if err != nil {
		return nil, err
	}
	return &DigestResult{
		Digest: Digest{
			TopGems:    gems.Items,
			Climbers:   nonNil(climbs.Items),
			HotSectors: nonNil(secs.Sectors),
		},
		AsOf:         gems.AsOf,
		HistoryHours: gems.HistoryHours,
		Warnings:     gems.Warnings,
	}, nil
}

// maxCandidates caps the candidates listed in a warning.
const maxCandidates = 10

func hasTag(q *model.Quote, tag string) bool {
	for _, t := range q.Tags {
		if strings.EqualFold(t, tag) {
			return true
		}
	}
	return false
}

func hasAnyTag(q *model.Quote, tags []string) bool {
	for _, want := range tags {
		if hasTag(q, want) {
			return true
		}
	}
	return false
}

func hasAnyTagMap(q *model.Quote, tags map[string]bool) bool {
	for _, t := range q.Tags {
		if tags[strings.ToLower(t)] {
			return true
		}
	}
	return false
}

func hasFlag(flags []string, want string) bool {
	for _, f := range flags {
		if f == want {
			return true
		}
	}
	return false
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
