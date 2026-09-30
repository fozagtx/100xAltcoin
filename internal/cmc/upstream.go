// Package cmc is the CoinMarketCap Pro API client. The rest of 100xAltcoin
// depends only on the Upstream interface below, so the poller can be tested
// against an in-memory fake and run against cmd/fakecmc locally.
//
// Only /v1/cryptocurrency/listings/latest (and the credit-free /v1/key/info)
// are used: listings/latest is available on every CMC plan, including the
// free Basic tier, and it is the one call every discovery signal is built
// from. /listings/new (Startup plan and up), /quotes/latest, /map and /info
// were dropped because the features built on them did not work reliably.
package cmc

import (
	"context"
	"fmt"
	"time"

	"github.com/fozagtx/100xAltcoin/internal/model"
)

// Meta is the per-call accounting CMC returns in its "status" object.
type Meta struct {
	CreditCount int           // status.credit_count: credits this call consumed
	Timestamp   time.Time     // status.timestamp
	Elapsed     time.Duration // status.elapsed (server-side milliseconds)
	HTTPStatus  int
}

// Upstream is everything 100xAltcoin needs from CoinMarketCap. All prices
// are in USD. Implementations must be safe for concurrent use.
type Upstream interface {
	// ListingsLatest returns assets ranked [start, start+limit) by market
	// cap (start is 1-based), from /v1/cryptocurrency/listings/latest.
	ListingsLatest(ctx context.Context, start, limit int) ([]model.Quote, Meta, error)

	// KeyInfo returns plan limits and credit usage from /v1/key/info
	// (this call does not consume credits).
	KeyInfo(ctx context.Context) (model.KeyUsage, error)
}

// APIError is a non-success answer from CMC (HTTP status >= 400, or a
// non-zero status.error_code), or a transport failure (HTTPStatus 0).
type APIError struct {
	HTTPStatus int           // 0 for transport errors (timeout, DNS, reset)
	Code       int           // CMC status.error_code (e.g. 1008 minute rate limit)
	Message    string        // CMC status.error_message or the transport error text
	RetryAfter time.Duration // hint for 429s and 5xx; 0 when unknown
	Endpoint   string        // e.g. "/v1/cryptocurrency/listings/latest"
}

func (e *APIError) Error() string {
	if e.HTTPStatus == 0 {
		return fmt.Sprintf("cmc %s: %s", e.Endpoint, e.Message)
	}
	return fmt.Sprintf("cmc %s: http %d code %d: %s", e.Endpoint, e.HTTPStatus, e.Code, e.Message)
}

// Temporary reports whether retrying later may succeed: transport errors,
// rate limits (429) and server errors (5xx).
func (e *APIError) Temporary() bool {
	return e.HTTPStatus == 0 || e.HTTPStatus == 429 || e.HTTPStatus >= 500
}

// PlanRestricted reports whether CMC refused the call because the plan does
// not include the endpoint (HTTP 403, or error codes 1005-1007).
func (e *APIError) PlanRestricted() bool {
	return e.HTTPStatus == 403 || (e.Code >= 1005 && e.Code <= 1007)
}
