// Command 100xaltcoin serves pay-per-call altcoin discovery over x402.
//
// Usage:
//
//	100xaltcoin [serve]    run the API (configured by environment variables)
//	100xaltcoin version
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/fozagtx/100xAltcoin/internal/api"
	"github.com/fozagtx/100xAltcoin/internal/cmc"
	"github.com/fozagtx/100xAltcoin/internal/config"
	"github.com/fozagtx/100xAltcoin/internal/histfile"
	"github.com/fozagtx/100xAltcoin/internal/market"
	"github.com/fozagtx/100xAltcoin/internal/model"
	"github.com/fozagtx/100xAltcoin/internal/paywall"
)

var version = "dev"

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "100xaltcoin:", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer) error {
	loadDotEnv(".env")
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "serve":
		return serve()
	case "version":
		fmt.Fprintln(out, version)
		return nil
	case "help", "-h", "--help":
		fmt.Fprint(out, usage)
		return nil
	default:
		return fmt.Errorf("unknown command %q\n%s", cmd, usage)
	}
}

const usage = `usage:
  100xaltcoin [serve]
  100xaltcoin version
`

// maxSeedAge is the oldest saved snapshot that is republished at startup
// (it only bridges the seconds until the first poll lands).
const maxSeedAge = 24 * time.Hour

func serve() error {
	cfg, err := config.FromEnv()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(logger)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	client := cmc.New(cmc.Options{
		BaseURL:           cfg.CMCBaseURL,
		APIKey:            cfg.CMCAPIKey,
		RequestsPerMinute: cfg.CMCRPM,
		Logger:            logger,
	})
	mk := market.New(client, market.Config{
		TopN:                   cfg.TopN,
		FastN:                  cfg.FastN,
		PageSize:               cfg.PageSize,
		PollInterval:           cfg.PollInterval,
		SlowInterval:           cfg.SlowInterval,
		ProjectedCreditsPerDay: cfg.ProjectedCreditsPerDay(),
		Logger:                 logger,
	})

	if cfg.HistoryFile != "" {
		st, ok, err := histfile.Load(cfg.HistoryFile)
		switch {
		case err != nil:
			logger.Warn("could not load history file; starting with empty history", "path", cfg.HistoryFile, "err", err)
		case ok:
			mk.SeedHistory(st.History)
			if time.Since(st.PublishedAt) < maxSeedAge {
				mk.Seed(st.Quotes, st.PublishedAt)
			}
			logger.Info("history restored", "path", cfg.HistoryFile, "assets", len(st.History), "history_hours", mk.HistoryHours(), "saved_at", st.SavedAt)
		}
	} else {
		logger.Warn("HISTORY_FILE not set: history lives in memory only, so /v1/climbers needs 24h after every restart")
	}

	var pw api.Paywall
	var payRun func(context.Context)
	if cfg.X402.Enabled {
		p, err := paywall.New(paywall.Config{
			PayTo:           cfg.X402.PayTo,
			Network:         cfg.X402.Network,
			FacilitatorURL:  cfg.X402.FacilitatorURL,
			FacilitatorAuth: cfg.X402.FacilitatorAuth,
			PublicURL:       cfg.PublicURL,
			Routes:          api.PaidRoutes(cfg.X402.Prices),
			Logger:          logger,
		})
		if err != nil {
			return err
		}
		pw, payRun = p, p.Run
	} else {
		logger.Warn("X402_ENABLED=false: every paid endpoint is FREE; use only for local development")
	}

	srv := api.New(api.Config{
		Version:    version,
		StaleAfter: cfg.StaleAfter,
		MaxStale:   cfg.MaxStale,
		Preset:     cfg.Preset,
		PublicURL:  cfg.PublicURL,
		Prices:     cfg.X402.Prices,
		Paywall:    pw,
		Logger:     logger,
	}, mk)

	bgCtx, stopBg := context.WithCancel(context.Background())
	defer stopBg()
	marketDone := make(chan struct{})
	go func() {
		defer close(marketDone)
		if err := mk.Run(bgCtx); err != nil {
			logger.Error("market poller stopped", "err", err)
		}
	}()
	if payRun != nil {
		go payRun(bgCtx)
	}
	saverDone := make(chan struct{})
	go func() {
		defer close(saverDone)
		if cfg.HistoryFile != "" {
			saveLoop(bgCtx, mk, cfg.HistoryFile, cfg.HistorySaveEvery, logger)
		}
	}()

	httpSrv := &http.Server{
		Addr:              net.JoinHostPort("", cfg.Port),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      60 * time.Second, // covers facilitator verify + settle
		IdleTimeout:       90 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
	serveErr := make(chan error, 1)
	go func() {
		logger.Info("100xaltcoin listening", "addr", httpSrv.Addr, "version", version, "upstream", cfg.CMCBaseURL,
			"preset", cfg.Preset, "top_n", cfg.TopN, "poll_interval", cfg.PollInterval.String(),
			"projected_credits_per_day", cfg.ProjectedCreditsPerDay(),
			"x402", cfg.X402.Enabled, "network", cfg.X402.Network, "pay_to", cfg.X402.PayTo)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
		close(serveErr)
	}()

	select {
	case <-ctx.Done():
		logger.Info("shutting down")
	case err := <-serveErr:
		if err != nil {
			stopBg()
			return fmt.Errorf("http server: %w", err)
		}
	}

	// Finish in-flight requests (and their settlements), stop polling,
	// then write the history one last time.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		logger.Warn("http shutdown", "err", err)
	}
	stopBg()
	waitOrTimeout(marketDone, 10*time.Second)
	waitOrTimeout(saverDone, 10*time.Second)
	if cfg.HistoryFile != "" {
		saveHistory(mk, cfg.HistoryFile, logger)
	}
	logger.Info("stopped")
	return nil
}

// saveLoop writes the history file every interval until ctx is done.
func saveLoop(ctx context.Context, mk *market.Market, path string, every time.Duration, logger *slog.Logger) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			saveHistory(mk, path, logger)
		}
	}
}

func saveHistory(mk *market.Market, path string, logger *slog.Logger) {
	if !mk.Ready() {
		return
	}
	snap := mk.Snapshot()
	quotes := make([]model.Quote, 0, snap.Len())
	for _, q := range snap.ByRank {
		quotes = append(quotes, *q)
	}
	st := histfile.State{
		SavedAt:     time.Now().UTC(),
		PublishedAt: snap.PublishedAt,
		Quotes:      quotes,
		History:     mk.ExportHistory(),
	}
	if err := histfile.Save(path, st); err != nil {
		logger.Warn("saving history failed", "path", path, "err", err)
		return
	}
	logger.Debug("history saved", "path", path, "assets", len(st.History))
}

func waitOrTimeout(done <-chan struct{}, d time.Duration) {
	select {
	case <-done:
	case <-time.After(d):
	}
}

// loadDotEnv reads KEY=VALUE lines from path into the environment, without
// overriding variables that are already set. Blank lines and comments are
// skipped; values may be single- or double-quoted. A missing file is fine.
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		if len(val) >= 2 && (val[0] == '"' && val[len(val)-1] == '"' || val[0] == '\'' && val[len(val)-1] == '\'') {
			val = val[1 : len(val)-1]
		} else if i := strings.Index(val, " #"); i >= 0 {
			val = strings.TrimSpace(val[:i])
		} else if strings.HasPrefix(val, "#") {
			val = ""
		}
		if key == "" || os.Getenv(key) != "" {
			continue
		}
		_ = os.Setenv(key, val)
	}
}
