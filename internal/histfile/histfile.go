// Package histfile persists the market's hourly history ring and last
// snapshot to one gzip-compressed JSON file, so a restart does not wipe
// the 24h of rank history that /v1/climbers and the rank-climb signal need.
// (In the Telegram bot the digest kept reporting "not enough history yet"
// after restarts for exactly this reason.)
package histfile

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/fozagtx/100xAltcoin/internal/model"
)

// formatVersion is bumped when the file layout changes incompatibly.
const formatVersion = 1

// State is what the file holds.
type State struct {
	Version     int                      `json:"version"`
	SavedAt     time.Time                `json:"saved_at"`
	PublishedAt time.Time                `json:"published_at"`
	Quotes      []model.Quote            `json:"quotes"`
	History     map[int64][]model.Sample `json:"history"`
}

// Save writes st to path atomically: it writes a temporary file in the
// same directory and renames it over path.
func Save(path string, st State) error {
	st.Version = formatVersion
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("histfile: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".history-*.tmp")
	if err != nil {
		return fmt.Errorf("histfile: %w", err)
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename
	gz := gzip.NewWriter(tmp)
	if err := json.NewEncoder(gz).Encode(st); err != nil {
		tmp.Close()
		return fmt.Errorf("histfile: encode: %w", err)
	}
	if err := gz.Close(); err != nil {
		tmp.Close()
		return fmt.Errorf("histfile: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("histfile: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("histfile: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("histfile: %w", err)
	}
	return nil
}

// Load reads the state saved at path. A missing file returns ok=false and
// no error.
func Load(path string) (st State, ok bool, err error) {
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return State{}, false, nil
	}
	if err != nil {
		return State{}, false, fmt.Errorf("histfile: %w", err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return State{}, false, fmt.Errorf("histfile: %w", err)
	}
	defer gz.Close()
	if err := json.NewDecoder(gz).Decode(&st); err != nil {
		return State{}, false, fmt.Errorf("histfile: decode: %w", err)
	}
	if st.Version != formatVersion {
		return State{}, false, fmt.Errorf("histfile: unsupported version %d", st.Version)
	}
	return st, true, nil
}
