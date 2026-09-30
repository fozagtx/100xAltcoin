// Package model holds the plain data types shared by every part of
// 100xAltcoin: the CMC client, the poller, the scoring engine and the HTTP
// handlers. It has no dependencies beyond the standard library.
package model

import (
	"errors"
	"time"
)

// Quote is the flattened, latest market data for one asset, priced in USD.
// It is the unit the snapshot stores and the API serves. Quotes are
// immutable once published in a snapshot; copy before changing.
type Quote struct {
	ID                int64     `json:"id"`
	Symbol            string    `json:"symbol"`
	Name              string    `json:"name"`
	Slug              string    `json:"slug"`
	Rank              int       `json:"rank"` // CMC rank; 0 when CMC reports none
	Price             float64   `json:"price"`
	MarketCap         float64   `json:"market_cap"`
	Volume24h         float64   `json:"volume_24h"`
	Change1hPct       float64   `json:"change_1h_pct"`
	Change24hPct      float64   `json:"change_24h_pct"`
	Change7dPct       float64   `json:"change_7d_pct"`
	CirculatingSupply float64   `json:"circulating_supply"`
	TotalSupply       float64   `json:"total_supply"`
	MaxSupply         *float64  `json:"max_supply"` // nil when uncapped or unknown
	Platform          string    `json:"platform,omitempty"`
	DateAdded         time.Time `json:"date_added"`
	Tags              []string  `json:"tags"`
	LastUpdated       time.Time `json:"last_updated"` // CMC's own last_updated for this quote
	FetchedAt         time.Time `json:"fetched_at"`   // when this service received it from CMC
}

// KeyUsage is the plan and usage information from CMC's /v1/key/info.
type KeyUsage struct {
	CreditLimitMonthly      int
	CreditLimitMonthlyReset string // CMC's human description, e.g. "In 19 days, 2 hours"
	RateLimitMinute         int
	CreditsUsedToday        int
	CreditsUsedMonth        int
	CreditsLeftMonth        int
	FetchedAt               time.Time
}

// Sample is one point of an asset's history: rank, price, market cap and
// volume as of At. The market layer keeps an hourly ring per asset.
type Sample struct {
	At        time.Time `json:"at"`
	Rank      int       `json:"rank"`
	Price     float64   `json:"price"`
	MarketCap float64   `json:"market_cap"`
	Volume24h float64   `json:"volume_24h"`
}

// PollRun records one upstream call made by the poller, for credit
// accounting and /v1/status.
type PollRun struct {
	Kind          string // "listings", "keyinfo"
	StartedAt     time.Time
	FinishedAt    time.Time
	OK            bool
	HTTPStatus    int // 0 when the request never got a response
	CreditsUsed   int
	AssetsFetched int
	Error         string
}

// MarketStatus is the poller's view of its own health.
type MarketStatus struct {
	LastPollAt         time.Time // last attempt of the top-N listings poll
	LastSuccessAt      time.Time // last fully successful top-N poll
	LastError          string    // "" when the last poll succeeded
	CacheSize          int       // assets in the published snapshot
	TopN               int
	PollInterval       time.Duration
	CreditsUsedToday   int // per CMC /key/info when available, else counted locally
	CreditsUsedMonth   int
	CreditLimitMonthly int // 0 when unknown
	UpstreamCalls      int64
	UpstreamErrors     int64
	HistoryAssets      int // assets with at least one history sample
	HistoryHours       int // age in hours of the oldest retained sample
	// ProjectedCreditsPerDay is the configured schedule's projected daily
	// CMC credit burn; informational only.
	ProjectedCreditsPerDay int
}

// ErrUpstreamUnavailable is returned (wrapped) by the market layer when CMC
// could not be reached or refused the call and no usable data is cached.
var ErrUpstreamUnavailable = errors.New("upstream unavailable")
