package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/fozagtx/100xAltcoin/internal/discover"
)

// source is the value of every envelope's "source" field.
const source = "coinmarketcap"

// disclaimer rides on every paid endpoint's envelope.
const disclaimer = "Market data for information only, not financial advice."

// Error codes. Every error is returned before payment is settled, so a
// client that receives one has not been charged.
const (
	codeAssetNotFound       = "asset_not_found"
	codeSectorNotFound      = "sector_not_found"
	codeUpstream            = "upstream_unavailable"
	codeInsufficientHistory = "insufficient_history"
	codeInvalidParam        = "invalid_parameter"
	codeNotFound            = "not_found"
	codeMethodNotAllowed    = "method_not_allowed"
	codeInternal            = "internal_error"
)

// warnStale is added when data is older than the freshness limit.
const warnStale = "stale_data"

// envelope is the success shape shared by the paid endpoints.
type envelope struct {
	AsOf       string `json:"as_of"`
	AgeSeconds int64  `json:"age_seconds"`
	Source     string `json:"source"`
	Note       string `json:"note,omitempty"`
	// HistoryHours is the depth of retained history; a pointer so 0 is
	// emitted (the ring is still warming up) while nil omits the field.
	HistoryHours *int               `json:"history_hours,omitempty"`
	Data         any                `json:"data"`
	Warnings     []discover.Warning `json:"warnings,omitempty"`
}

// errorDetail is the "error" object of an error response.
type errorDetail struct {
	Code              string               `json:"code"`
	Message           string               `json:"message"`
	NextStep          string               `json:"next_step"`
	Param             string               `json:"param,omitempty"`
	Query             string               `json:"query,omitempty"`
	AllowedValues     []string             `json:"allowed_values,omitzero"`
	Suggestions       []discover.Candidate `json:"suggestions,omitzero"`
	RetryAfterSeconds int                  `json:"retry_after_seconds,omitempty"`
}

// apiError is an error the handlers turn into an HTTP error response.
type apiError struct {
	status int
	detail errorDetail
}

func (e *apiError) Error() string { return e.detail.Code + ": " + e.detail.Message }

func newError(status int, code, message, next string) *apiError {
	return &apiError{status: status, detail: errorDetail{Code: code, Message: message, NextStep: next}}
}

func invalidParam(param, message, next string, allowed []string) *apiError {
	e := newError(http.StatusBadRequest, codeInvalidParam, message, next)
	e.detail.Param = param
	e.detail.AllowedValues = allowed
	return e
}

func errInternal() *apiError {
	return newError(http.StatusInternalServerError, codeInternal, "The server hit an unexpected error.",
		"Retry the request; you have not been charged. If it keeps failing, report the X-Request-ID response header.")
}

// unavailable is a 503 with a retry hint; code says why.
func unavailable(code, message string, retry time.Duration) *apiError {
	secs := int(math.Ceil(retry.Seconds()))
	if secs <= 0 {
		secs = 30
	}
	e := newError(http.StatusServiceUnavailable, code, message,
		fmt.Sprintf("Retry in %d seconds; you have not been charged.", secs))
	e.detail.RetryAfterSeconds = secs
	return e
}

// respond fills in the freshness fields of env from asOf and writes it.
// Data older than StaleAfter gets a stale_data warning; data older than
// MaxStale is refused with 503 (and so never charged).
func (s *Server) respond(w http.ResponseWriter, env *envelope, asOf time.Time) *apiError {
	now := s.now()
	asOf = asOf.UTC().Truncate(time.Second)
	age := ageSeconds(now, asOf)
	if asOf.IsZero() || time.Duration(age)*time.Second > s.cfg.MaxStale {
		return s.staleError(age)
	}
	env.AsOf = formatTime(asOf)
	env.AgeSeconds = age
	env.Source = source
	if time.Duration(age)*time.Second > s.cfg.StaleAfter {
		env.Warnings = append(env.Warnings, discover.Warning{
			Code: warnStale,
			Message: fmt.Sprintf("Data is %d s old, past the %d s freshness limit; CoinMarketCap updates are delayed.",
				age, int64(s.cfg.StaleAfter/time.Second)),
		})
	}
	s.writeJSON(w, http.StatusOK, env, "no-store")
	return nil
}

func (s *Server) staleError(age int64) *apiError {
	if age <= 0 || age > int64(365*24*time.Hour/time.Second) {
		return unavailable(codeUpstream, "Market data is not loaded yet: the first CoinMarketCap poll has not finished.", 30*time.Second)
	}
	return unavailable(codeUpstream, fmt.Sprintf(
		"CoinMarketCap data has not refreshed: the newest data available is %d s old, past the %d s limit.",
		age, int64(s.cfg.MaxStale/time.Second)), 60*time.Second)
}

// writeError writes e as an error response.
func (s *Server) writeError(w http.ResponseWriter, e *apiError) {
	if e.detail.RetryAfterSeconds > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(e.detail.RetryAfterSeconds))
	}
	s.writeJSON(w, e.status, map[string]*errorDetail{"error": &e.detail}, "no-store")
}

var bufPool = sync.Pool{New: func() any { return new(bytes.Buffer) }}

// fallbackErrorBody is written if a response cannot be encoded.
var fallbackErrorBody = []byte(`{"error":{"code":"internal_error","message":"The server could not encode the response.","next_step":"Retry the request; you have not been charged."}}` + "\n")

// writeJSON encodes v and writes it with the given status.
func (s *Server) writeJSON(w http.ResponseWriter, status int, v any, cacheControl string) {
	buf := bufPool.Get().(*bytes.Buffer)
	buf.Reset()
	defer func() {
		if buf.Cap() <= 1<<20 {
			bufPool.Put(buf)
		}
	}()
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	body := fallbackErrorBody
	if err := enc.Encode(v); err != nil {
		s.log.Error("encoding response", "err", err)
		status = http.StatusInternalServerError
	} else {
		body = buf.Bytes()
	}
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	if cacheControl != "" {
		h.Set("Cache-Control", cacheControl)
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// ageSeconds returns whole seconds from asOf to now, never negative.
func ageSeconds(now, asOf time.Time) int64 {
	d := now.Sub(asOf)
	if d < 0 {
		return 0
	}
	return int64(d / time.Second)
}

// formatTime renders t as ISO 8601 UTC with second precision.
func formatTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}

// optionalTime renders t, or nil (JSON null) for the zero time.
func optionalTime(t time.Time) *string {
	if t.IsZero() {
		return nil
	}
	s := formatTime(t)
	return &s
}
