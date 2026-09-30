package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/fozagtx/100xAltcoin/internal/discover"
	"github.com/fozagtx/100xAltcoin/internal/paywall"
)

// endpoints is the route table: every paid endpoint maps to a Telegram bot
// command whose output proved it works. /new (CMC listings/new, Startup
// plan only), /resolve and the 7d climbers window were dropped.
func (s *Server) endpoints() []endpoint {
	return []endpoint{
		{
			name: "gems", path: "/v1/gems", paid: true, telegram: "/gems",
			summary: "Top-scored early altcoin candidates: composite 0-100 score from turnover, rank climb, listing age and sector heat, with reasons and risk flags.",
			params: []paramSpec{
				{name: "max_market_cap", kind: kindNumber, def: "50000000", min: 0, maxLen: 30, desc: "Largest market cap (USD) still considered early.", example: "50000000"},
				{name: "min_market_cap", kind: kindNumber, def: "1000000", min: 0, maxLen: 30, desc: "Smallest market cap (USD); filters out dust.", example: "1000000"},
				{name: "min_volume", kind: kindNumber, def: "100000", min: 0, maxLen: 30, desc: "Minimum 24h volume (USD).", example: "100000"},
				{name: "listed_within_days", kind: kindInt, def: "0", min: 0, max: 365, maxLen: 10, desc: "Only assets listed on CMC within this many days; 0 = any age.", example: "30"},
				{name: "sector", kind: kindString, maxLen: 60, desc: "Only assets carrying this CMC tag, e.g. ai-big-data or \"Account Abstraction\".", example: "ai-big-data"},
				{name: "include_pumped", kind: kindBool, def: "false", maxLen: 10, desc: "Keep assets already up >100% in 24h or >300% in 7d.", example: "false"},
				paramLimit("10", 50),
			},
			handler: s.handleGems,
			example: `{"data":[{"symbol":"AGRIPPA","name":"Agrippa","market_cap":3500000,"volume_24h":2000000,"turnover":0.57,"change_24h_pct":-13.8,"score":55,"confidence":"low","why":["Listed 7 days ago","Turnover 0.57 (volume vs market cap)"],"risk_flags":["insufficient_history","micro_cap","new_and_unproven"]}]}`,
		},
		{
			name: "screen", path: "/v1/screen", paid: true, telegram: "/screen",
			summary: "Filter the tracked universe by market cap, volume, turnover, price change, tags and listing age; defaults to the top turnover under $50M.",
			params: []paramSpec{
				optionalNumber("min_market_cap", "Minimum market cap (USD).", "1000000"),
				{name: "max_market_cap", kind: kindNumber, def: "50000000", min: 0, maxLen: 30, desc: "Maximum market cap (USD); 0 = no cap.", example: "50000000"},
				optionalNumber("min_volume", "Minimum 24h volume (USD).", "100000"),
				optionalNumber("max_volume", "Maximum 24h volume (USD).", "50000000"),
				optionalNumber("min_turnover", "Minimum turnover (24h volume / market cap).", "0.5"),
				optionalNumber("min_change_1h_pct", "Minimum 1h price change, percent.", "-5"),
				optionalNumber("max_change_1h_pct", "Maximum 1h price change, percent.", "20"),
				optionalNumber("min_change_24h_pct", "Minimum 24h price change, percent.", "0"),
				optionalNumber("max_change_24h_pct", "Maximum 24h price change, percent.", "100"),
				optionalNumber("min_change_7d_pct", "Minimum 7d price change, percent.", "0"),
				optionalNumber("max_change_7d_pct", "Maximum 7d price change, percent.", "300"),
				{name: "tag", kind: kindString, maxLen: 300, desc: "Comma list of CMC tags; an asset matches if it carries ANY of them (up to 10).", example: "memes,solana-ecosystem"},
				{name: "listed_within_days", kind: kindInt, def: "0", min: 0, max: 365, maxLen: 10, desc: "Only assets listed within this many days; 0 = any age.", example: "30"},
				{name: "exclude_stablecoins", kind: kindBool, def: "true", maxLen: 10, desc: "Drop stablecoins and wrapped tokens.", example: "true"},
				{name: "sort", kind: kindEnum, def: "turnover", enum: []string{"turnover", "change_1h_pct", "change_24h_pct", "change_7d_pct", "volume_24h", "market_cap", "rank"}, maxLen: 30, desc: "Sort key.", example: "turnover"},
				{name: "order", kind: kindEnum, enum: []string{"asc", "desc"}, maxLen: 10, desc: "Sort order; desc by default (asc for rank).", example: "desc"},
				paramLimit("10", 50),
			},
			handler: s.handleScreen,
			example: `{"data":[{"symbol":"QUQ","market_cap":1600000,"volume_24h":119000000,"turnover":73.96,"change_24h_pct":0.0},{"symbol":"AEON","market_cap":12600000,"volume_24h":441500000,"turnover":35.02,"change_24h_pct":0.7}]}`,
		},
		{
			name: "climbers", path: "/v1/climbers", paid: true, telegram: "/climbers",
			summary: "Biggest CMC rank climbers over the last 24h, from the service's own hourly rank history.",
			params: []paramSpec{
				{name: "direction", kind: kindEnum, def: "up", enum: []string{"up", "down"}, maxLen: 10, desc: "up = biggest climbers, down = biggest fallers.", example: "up"},
				{name: "min_volume", kind: kindNumber, def: "100000", min: 0, maxLen: 30, desc: "Minimum 24h volume (USD).", example: "100000"},
				{name: "max_market_cap", kind: kindNumber, def: "0", min: 0, maxLen: 30, desc: "Maximum market cap (USD); 0 = no cap.", example: "100000000"},
				paramLimit("10", 50),
			},
			handler:      s.handleClimbers,
			needsHistory: discover.HistoryWarnHours,
			example:      `{"data":[{"symbol":"KSM","name":"Kusama","rank":197,"market_cap":98400000,"volume_24h":23200000,"change_24h_pct":11.9,"rank_then":265,"rank_change":68,"rank_change_pct":25.66}]}`,
		},
		{
			name: "sectors", path: "/v1/sectors", paid: true, telegram: "/sectors, /sector <tag>",
			summary: "Hottest CMC sectors (tags) ranked by heat, with leaders; pass sector= for one sector's members.",
			params: []paramSpec{
				{name: "sort", kind: kindEnum, def: "heat", enum: []string{"heat", "change_24h_pct", "change_7d_pct", "volume_24h", "market_cap"}, maxLen: 30, desc: "Sort key for the sector list.", example: "heat"},
				{name: "min_members", kind: kindInt, def: "5", min: 2, max: 200, maxLen: 10, desc: "Smallest sector size listed.", example: "5"},
				{name: "sector", kind: kindString, maxLen: 60, desc: "Return this sector's members instead of the list; matched loosely (\"AI Big Data\" = ai-big-data).", example: "account-abstraction"},
				paramLimit("10", 50),
			},
			handler: s.handleSectors,
			example: `{"data":[{"tag":"account-abstraction","median_change_24h_pct":3.0,"heat":20,"leaders":[{"symbol":"PHA"},{"symbol":"NEAR"},{"symbol":"ADX"}]}]}`,
		},
		{
			name: "asset", path: "/v1/asset", paid: true, telegram: "/asset <query>",
			summary: "One tracked asset in detail: price, supply, composite score, signal breakdown, risk flags and rank history.",
			params: []paramSpec{
				{name: "asset", kind: kindString, required: true, maxLen: 100, desc: "CMC id, symbol, slug or name of an asset in the tracked top N.", example: "MOVR"},
			},
			handler: s.handleAsset,
			example: `{"data":{"symbol":"MOVR","name":"Moonriver","rank":663,"market_cap":22400000,"volume_24h":118700000,"turnover":5.29,"change_24h_pct":76.4,"score":52,"confidence":"low","why":["Turnover 5.29 (volume vs market cap)","Climbed 22% in rank over 24h (#846 -> #663)"]}}`,
		},
		{
			name: "digest", path: "/v1/digest", paid: true, telegram: "daily digest",
			summary: "The daily digest in one call: top gems, 24h rank climbers and the hottest sectors.",
			params: []paramSpec{
				{name: "gems", kind: kindInt, def: "5", min: 1, max: 20, maxLen: 10, desc: "Number of top gems.", example: "5"},
				{name: "climbers", kind: kindInt, def: "3", min: 1, max: 20, maxLen: 10, desc: "Number of rank climbers (empty until 24h of history).", example: "3"},
				{name: "sectors", kind: kindInt, def: "3", min: 1, max: 20, maxLen: 10, desc: "Number of hot sectors.", example: "3"},
			},
			handler: s.handleDigest,
			example: `{"data":{"top_gems":[{"symbol":"PAID","score":67,"market_cap":10500000,"change_24h_pct":-15.4}],"climbers":[{"symbol":"KSM","rank_then":265,"rank":197}],"hot_sectors":[{"tag":"account-abstraction","heat":20}]}}`,
		},
		{
			name: "status", path: "/v1/status", telegram: "/status",
			summary: "Service health, data freshness, CMC credit usage, prices and payment settings. Free.",
			handler: s.handleStatus,
		},
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

// splitComma splits a comma list, trimming entries and dropping empties.
func splitComma(s string) []string {
	var out []string
	for part := range strings.SplitSeq(s, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func joinComma(xs []string) string { return strings.Join(xs, ", ") }

func (s *Server) handleGems(w http.ResponseWriter, r *http.Request, q *queryParams) *apiError {
	var p discover.GemsParams
	var e *apiError
	if p.MaxMarketCap, e = q.number("max_market_cap"); e != nil {
		return e
	}
	if p.MinMarketCap, e = q.number("min_market_cap"); e != nil {
		return e
	}
	if p.MaxMarketCap < p.MinMarketCap {
		return invalidParam("max_market_cap", "max_market_cap is below min_market_cap.",
			"Retry with max_market_cap >= min_market_cap.", nil)
	}
	if p.MinVolume, e = q.number("min_volume"); e != nil {
		return e
	}
	if p.ListedWithinDays, e = q.int("listed_within_days"); e != nil {
		return e
	}
	if p.Sector, e = q.str("sector"); e != nil {
		return e
	}
	if p.IncludePumped, e = q.boolean("include_pumped"); e != nil {
		return e
	}
	if p.Limit, e = q.int("limit"); e != nil {
		return e
	}
	res, err := s.engine.Gems(r.Context(), p)
	if err != nil {
		return s.engineError(err)
	}
	h := res.HistoryHours
	return s.respond(w, &envelope{Note: disclaimer, HistoryHours: &h, Data: res.Items, Warnings: res.Warnings}, res.AsOf)
}

func (s *Server) handleScreen(w http.ResponseWriter, r *http.Request, q *queryParams) *apiError {
	var p discover.ScreenParams
	var e *apiError
	num := func(name string, dst *float64, has *bool) {
		if e != nil {
			return
		}
		v, ok, err := q.optNumber(name)
		if err != nil {
			e = err
			return
		}
		*dst = v
		if has != nil {
			*has = ok
		}
	}
	num("min_market_cap", &p.MinMarketCap, nil)
	num("min_volume", &p.MinVolume, nil)
	num("max_volume", &p.MaxVolume, nil)
	num("min_turnover", &p.MinTurnover, nil)
	num("min_change_1h_pct", &p.MinChange1h, &p.HasMin1h)
	num("max_change_1h_pct", &p.MaxChange1h, &p.HasMax1h)
	num("min_change_24h_pct", &p.MinChange24h, &p.HasMin24h)
	num("max_change_24h_pct", &p.MaxChange24h, &p.HasMax24h)
	num("min_change_7d_pct", &p.MinChange7d, &p.HasMin7d)
	num("max_change_7d_pct", &p.MaxChange7d, &p.HasMax7d)
	if e != nil {
		return e
	}
	if p.MaxMarketCap, e = q.number("max_market_cap"); e != nil {
		return e
	}
	if tags, _ := q.str("tag"); tags != "" {
		p.Tags = splitComma(tags)
		if len(p.Tags) > 10 {
			return invalidParam("tag", "tag takes at most 10 tags.", "Send at most 10 comma-separated tags.", nil)
		}
	}
	if p.ListedWithinDays, e = q.int("listed_within_days"); e != nil {
		return e
	}
	if p.ExcludeStablecoins, e = q.boolean("exclude_stablecoins"); e != nil {
		return e
	}
	if p.Sort, e = q.enum("sort"); e != nil {
		return e
	}
	if p.Order, e = q.enum("order"); e != nil {
		return e
	}
	if p.Order == "" {
		p.Order = "desc"
		if p.Sort == "rank" {
			p.Order = "asc"
		}
	}
	if p.Limit, e = q.int("limit"); e != nil {
		return e
	}
	res, err := s.engine.Screen(r.Context(), p)
	if err != nil {
		return s.engineError(err)
	}
	return s.respond(w, &envelope{Note: disclaimer, Data: nonNilItems(res.Items)}, res.AsOf)
}

func (s *Server) handleClimbers(w http.ResponseWriter, r *http.Request, q *queryParams) *apiError {
	var p discover.ClimbersParams
	dir, e := q.enum("direction")
	if e != nil {
		return e
	}
	p.Down = dir == "down"
	if p.MinVolume, e = q.number("min_volume"); e != nil {
		return e
	}
	if p.MaxMarketCap, e = q.number("max_market_cap"); e != nil {
		return e
	}
	if p.Limit, e = q.int("limit"); e != nil {
		return e
	}
	res, err := s.engine.Climbers(r.Context(), p)
	if err != nil {
		return s.engineError(err)
	}
	h := res.HistoryHours
	data := res.Items
	if data == nil {
		data = []discover.ClimberItem{}
	}
	return s.respond(w, &envelope{Note: disclaimer, HistoryHours: &h, Data: data, Warnings: res.Warnings}, res.AsOf)
}

func (s *Server) handleSectors(w http.ResponseWriter, r *http.Request, q *queryParams) *apiError {
	var p discover.SectorsParams
	var e *apiError
	if p.Sort, e = q.enum("sort"); e != nil {
		return e
	}
	if p.MinMembers, e = q.int("min_members"); e != nil {
		return e
	}
	if p.Sector, e = q.str("sector"); e != nil {
		return e
	}
	if p.Limit, e = q.int("limit"); e != nil {
		return e
	}
	res, err := s.engine.Sectors(r.Context(), p)
	if err != nil {
		return s.engineError(err)
	}
	var data any = res.Sectors
	if res.Detail != nil {
		data = res.Detail
	} else if res.Sectors == nil {
		data = []discover.SectorOut{}
	}
	return s.respond(w, &envelope{Note: disclaimer, Data: data}, res.AsOf)
}

func (s *Server) handleAsset(w http.ResponseWriter, r *http.Request, q *queryParams) *apiError {
	query, e := q.str("asset")
	if e != nil {
		return e
	}
	res, err := s.engine.Asset(r.Context(), query)
	if err != nil {
		return s.engineError(err)
	}
	h := res.HistoryHours
	return s.respond(w, &envelope{Note: disclaimer, HistoryHours: &h, Data: res.Item, Warnings: res.Warnings}, res.AsOf)
}

func (s *Server) handleDigest(w http.ResponseWriter, r *http.Request, q *queryParams) *apiError {
	var p discover.DigestParams
	var e *apiError
	if p.Gems, e = q.int("gems"); e != nil {
		return e
	}
	if p.Climbers, e = q.int("climbers"); e != nil {
		return e
	}
	if p.Sectors, e = q.int("sectors"); e != nil {
		return e
	}
	res, err := s.engine.Digest(r.Context(), p)
	if err != nil {
		return s.engineError(err)
	}
	h := res.HistoryHours
	return s.respond(w, &envelope{Note: disclaimer, HistoryHours: &h, Data: res.Digest, Warnings: res.Warnings}, res.AsOf)
}

// engineError maps discovery errors onto API errors.
func (s *Server) engineError(err error) *apiError {
	var anf *discover.AssetNotFoundError
	var snf *discover.SectorNotFoundError
	switch {
	case errors.As(err, &anf):
		e := newError(http.StatusNotFound, codeAssetNotFound,
			fmt.Sprintf("No tracked asset matches %q.", truncate(anf.Query, 60)),
			"Retry with a CMC id, symbol, slug or name from suggestions; only assets in the tracked top N are covered.")
		e.detail.Param = "asset"
		e.detail.Query = truncate(anf.Query, 100)
		e.detail.Suggestions = anf.Suggestions
		return e
	case errors.As(err, &snf):
		next := "Call /v1/sectors without sector= to list tracked sectors."
		if len(snf.Hottest) > 0 {
			next = fmt.Sprintf("Retry with a tracked sector, e.g. one of the hottest now: %s.", joinComma(snf.Hottest))
		}
		e := newError(http.StatusNotFound, codeSectorNotFound, fmt.Sprintf("Sector %q is not tracked.", truncate(snf.Tag, 60)), next)
		e.detail.Param = "sector"
		return e
	}
	s.log.Error("discovery engine", "err", err)
	return errInternal()
}

// statusBody is the /v1/status payload.
type statusBody struct {
	Status                 string            `json:"status"`
	Version                string            `json:"version"`
	Preset                 string            `json:"preset"`
	UptimeSeconds          int64             `json:"uptime_seconds"`
	LastPollAt             *string           `json:"last_poll_at"`
	LastSuccessAt          *string           `json:"last_success_at"`
	LastError              string            `json:"last_error"`
	DataAgeSeconds         *int64            `json:"data_age_seconds"`
	CacheSize              int               `json:"cache_size"`
	TopN                   int               `json:"top_n"`
	PollIntervalSeconds    int64             `json:"poll_interval_seconds"`
	HistoryAssets          int               `json:"history_assets"`
	HistoryHours           int               `json:"history_hours"`
	ClimbersAvailable      bool              `json:"climbers_available"`
	CreditsUsedToday       int               `json:"credits_used_today"`
	CreditsUsedMonth       int               `json:"credits_used_month"`
	CreditLimitMonthly     int               `json:"credit_limit_monthly"`
	ProjectedCreditsPerDay int               `json:"projected_credits_per_day"`
	UpstreamCalls          int64             `json:"upstream_calls"`
	UpstreamErrors         int64             `json:"upstream_errors"`
	RequestsTotal          int64             `json:"requests_total"`
	Prices                 map[string]string `json:"prices"`
	Payments               paywall.Status    `json:"payments"`
}

func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request, _ *queryParams) *apiError {
	now := s.now()
	st := s.market.Status()
	body := statusBody{
		Version:                s.cfg.Version,
		Preset:                 s.cfg.Preset,
		UptimeSeconds:          int64(now.Sub(s.started) / time.Second),
		LastPollAt:             optionalTime(st.LastPollAt),
		LastSuccessAt:          optionalTime(st.LastSuccessAt),
		LastError:              st.LastError,
		CacheSize:              st.CacheSize,
		TopN:                   st.TopN,
		PollIntervalSeconds:    int64(st.PollInterval / time.Second),
		HistoryAssets:          st.HistoryAssets,
		HistoryHours:           st.HistoryHours,
		ClimbersAvailable:      st.HistoryHours >= discover.HistoryWarnHours,
		CreditsUsedToday:       st.CreditsUsedToday,
		CreditsUsedMonth:       st.CreditsUsedMonth,
		CreditLimitMonthly:     st.CreditLimitMonthly,
		ProjectedCreditsPerDay: st.ProjectedCreditsPerDay,
		UpstreamCalls:          st.UpstreamCalls,
		UpstreamErrors:         st.UpstreamErrors,
		RequestsTotal:          s.requests.Load(),
		Prices:                 map[string]string{},
	}
	for _, ep := range s.eps {
		if ep.paid {
			body.Prices[ep.path] = s.cfg.Prices[ep.name]
		}
	}
	if s.cfg.Paywall != nil {
		body.Payments = s.cfg.Paywall.Status()
	}
	status := http.StatusOK
	body.Status = "ok"
	if s.market.Ready() {
		age := ageSeconds(now, s.market.Snapshot().OldestFetch())
		body.DataAgeSeconds = &age
		switch {
		case time.Duration(age)*time.Second > s.cfg.MaxStale:
			body.Status, status = "down", http.StatusServiceUnavailable
		case time.Duration(age)*time.Second > s.cfg.StaleAfter:
			body.Status = "degraded"
		}
	} else {
		body.Status, status = "starting", http.StatusServiceUnavailable
	}
	if s.cfg.Paywall != nil && !body.Payments.Ready && body.Status == "ok" {
		body.Status = "degraded"
	}
	if s.cfg.Paywall == nil {
		body.Payments = paywall.Status{Enabled: false}
	}
	s.writeJSON(w, status, body, "no-store")
	return nil
}

func nonNilItems(items []discover.Item) []discover.Item {
	if items == nil {
		return []discover.Item{}
	}
	return items
}
