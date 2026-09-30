// Package api is 100xAltcoin's HTTP layer: the x402-paid discovery
// endpoints, the free status/OpenAPI/docs routes, and the middleware in
// front of them.
//
// A paid request goes through three stages, in this order:
//
//  1. precheck: parameters are validated and the data is checked to be
//     ready (snapshot loaded, fresh enough, and for /v1/climbers at least
//     24h of history). Failures answer 4xx/5xx before any payment is asked.
//  2. paywall: the x402 middleware answers 402 with the price, or verifies
//     the PAYMENT-SIGNATURE header with the facilitator.
//  3. handler: computes the answer. Only a 2xx answer is settled on-chain.
package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"runtime/debug"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/fozagtx/100xAltcoin/internal/discover"
	"github.com/fozagtx/100xAltcoin/internal/paywall"
)

// Market is the market-data side the API reads from; *market.Market
// implements it.
type Market interface {
	discover.Market
	Ready() bool
}

// Paywall is the x402 payment wall; *paywall.Paywall implements it.
type Paywall interface {
	Middleware(next http.Handler) http.Handler
	Status() paywall.Status
}

// Config tunes the HTTP layer. Zero values get the documented defaults.
type Config struct {
	// Version is reported by /v1/status; "dev" when empty.
	Version string
	// StaleAfter is the data age beyond which responses carry a stale_data
	// warning; 20 min when zero.
	StaleAfter time.Duration
	// MaxStale is the data age beyond which paid endpoints answer 503
	// (before payment); 45 min when zero.
	MaxStale time.Duration
	// Preset is the polling preset name, shown in /v1/status.
	Preset string
	// PublicURL is the externally visible base URL, used in the docs page.
	PublicURL string
	// Prices maps endpoint name to its USD price, e.g. "gems": "$0.02".
	Prices map[string]string
	// Paywall charges for the paid endpoints. Nil serves them for free
	// (local development only).
	Paywall Paywall
	// Now returns the current time; time.Now when nil.
	Now func() time.Time
	// Logger receives errors and, at Debug level, one access-log line per
	// request; slog.Default() when nil.
	Logger *slog.Logger
}

// Server is the 100xAltcoin HTTP API. Create one with New and serve its
// Handler. It is safe for concurrent use.
type Server struct {
	cfg      Config
	engine   *discover.Engine
	market   Market
	log      *slog.Logger
	started  time.Time
	eps      []endpoint
	openapi  []byte
	docs     []byte
	router   chi.Router
	requests atomic.Int64
}

// handlerFunc is an endpoint handler: it writes a success response itself
// and returns an error for the shared error writer.
type handlerFunc func(w http.ResponseWriter, r *http.Request, q *queryParams) *apiError

// endpoint is one registered route.
type endpoint struct {
	name     string // price key for paid endpoints
	path     string
	paid     bool
	summary  string // one sentence
	telegram string // the Telegram bot command it replaces
	params   []paramSpec
	handler  handlerFunc
	// needsHistory refuses the call (before payment) until this many
	// hours of history exist.
	needsHistory int
	// example is a trimmed example response for the docs.
	example string
}

// New builds a Server over m. It panics on a nil Market.
func New(cfg Config, m Market) *Server {
	if m == nil {
		panic("api: New needs a Market")
	}
	if cfg.Version == "" {
		cfg.Version = "dev"
	}
	if cfg.StaleAfter <= 0 {
		cfg.StaleAfter = 20 * time.Minute
	}
	if cfg.MaxStale <= 0 {
		cfg.MaxStale = 45 * time.Minute
	}
	if cfg.MaxStale < cfg.StaleAfter {
		cfg.MaxStale = cfg.StaleAfter
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Prices == nil {
		cfg.Prices = map[string]string{}
	}
	s := &Server{
		cfg:     cfg,
		engine:  discover.New(m, cfg.Now),
		market:  m,
		log:     cfg.Logger,
		started: cfg.Now(),
	}
	s.eps = s.endpoints()
	s.openapi = s.buildOpenAPI()
	s.docs = s.buildDocsPage()
	s.router = s.buildRouter()
	return s
}

// Handler returns the HTTP handler serving every route.
func (s *Server) Handler() http.Handler { return s.router }

// PaidRoutes lists the paid endpoints with their prices, for building the
// paywall before the Server that uses it.
func PaidRoutes(prices map[string]string) []paywall.Route {
	s := &Server{cfg: Config{Prices: prices}}
	var out []paywall.Route
	for _, ep := range s.endpoints() {
		if ep.paid {
			out = append(out, paywall.Route{Name: ep.name, Path: ep.path, Price: prices[ep.name], Description: ep.summary})
		}
	}
	return out
}

func (s *Server) buildRouter() chi.Router {
	r := chi.NewRouter()
	r.Use(s.requestID, s.recoverer, cors, s.accessLog)
	r.NotFound(s.wrapPlain(s.handleNotFound))
	r.MethodNotAllowed(s.wrapPlain(s.handleMethodNotAllowed))
	r.Get("/", s.handleDocs)
	r.Get("/v1/openapi.json", s.handleOpenAPI)
	for _, ep := range s.eps {
		h := http.Handler(s.wrap(ep))
		if ep.paid {
			if s.cfg.Paywall != nil {
				h = s.cfg.Paywall.Middleware(h)
			}
			h = s.precheck(ep, h)
		}
		r.Method(http.MethodGet, ep.path, h)
	}
	return r
}

// wrap adapts an endpoint handler: it parses the query and writes returned
// errors.
func (s *Server) wrap(ep endpoint) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q, e := parseQuery(r, ep.path, ep.params)
		if e == nil {
			e = ep.handler(w, r, q)
		}
		if e != nil {
			s.writeError(w, e)
		}
	}
}

func (s *Server) wrapPlain(h func(http.ResponseWriter, *http.Request) *apiError) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if e := h(w, r); e != nil {
			s.writeError(w, e)
		}
	}
}

// precheck rejects a paid request before the paywall sees it when the
// parameters are invalid or the service cannot answer yet, so clients are
// never asked to pay for a call that would fail.
func (s *Server) precheck(ep endpoint, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q, e := parseQuery(r, ep.path, ep.params)
		if e == nil {
			e = q.validate()
		}
		if e == nil {
			e = s.readiness(ep)
		}
		if e != nil {
			s.writeError(w, e)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// readiness reports why ep cannot be answered right now, or nil.
func (s *Server) readiness(ep endpoint) *apiError {
	if !s.market.Ready() {
		return s.staleError(0)
	}
	age := ageSeconds(s.now(), s.market.Snapshot().OldestFetch())
	if time.Duration(age)*time.Second > s.cfg.MaxStale {
		return s.staleError(age)
	}
	if ep.needsHistory > 0 {
		if h := s.market.HistoryHours(); h < ep.needsHistory {
			wait := ep.needsHistory - h
			e := unavailable(codeInsufficientHistory,
				"Rank climbers compare today's CMC rank with the rank 24 h ago; the service has only "+
					itoa(h)+" h of history so far.",
				time.Duration(wait)*time.Hour)
			e.detail.NextStep = "Retry in about " + itoa(wait) + " h (GET /v1/status shows climbers_available); you have not been charged."
			return e
		}
	}
	return nil
}

func (s *Server) now() time.Time { return s.cfg.Now() }

func (s *Server) handleNotFound(w http.ResponseWriter, r *http.Request) *apiError {
	return newError(http.StatusNotFound, codeNotFound, "No endpoint at this path.",
		"Use one of /v1/gems, /v1/screen, /v1/climbers, /v1/sectors, /v1/asset or /v1/digest; GET /v1/openapi.json describes them all.")
}

func (s *Server) handleMethodNotAllowed(w http.ResponseWriter, r *http.Request) *apiError {
	w.Header().Set("Allow", "GET, OPTIONS")
	return newError(http.StatusMethodNotAllowed, codeMethodNotAllowed,
		"Method "+r.Method+" is not allowed here.", "Use GET; every endpoint is read-only.")
}

type ctxKey int

const requestIDKey ctxKey = iota

// requestID tags each request with an X-Request-ID (the client's, when it
// sent a sane one).
func (s *Server) requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.requests.Add(1)
		id := r.Header.Get("X-Request-ID")
		if id == "" || len(id) > 64 {
			var b [8]byte
			_, _ = rand.Read(b[:])
			id = hex.EncodeToString(b[:])
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
	})
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				s.log.Error("panic serving request", "path", r.URL.Path, "panic", rec, "stack", string(debug.Stack()))
				s.writeError(w, errInternal())
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// cors lets browser-based x402 clients call the API: the payment headers
// must be allowed on the request and exposed on the response.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Request-ID, Retry-After")
		if r.Method == http.MethodOptions {
			h.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "PAYMENT-SIGNATURE, Content-Type, Accept, X-Request-ID")
			h.Set("Access-Control-Max-Age", "86400")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// statusRecorder captures the status code for the access log.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *Server) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		lvl := slog.LevelDebug
		if rec.status >= 500 {
			lvl = slog.LevelWarn
		}
		s.log.Log(r.Context(), lvl, "request", "method", r.Method, "path", r.URL.Path, "status", rec.status,
			"ms", time.Since(start).Milliseconds(), "request_id", r.Context().Value(requestIDKey),
			"paid", r.Header.Get("PAYMENT-SIGNATURE") != "")
	})
}
