package histfile

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fozagtx/100xAltcoin/internal/model"
)

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "history.json.gz")
	if _, ok, err := Load(path); ok || err != nil {
		t.Fatalf("missing file: ok=%v err=%v", ok, err)
	}
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	max := 21e6
	in := State{
		SavedAt:     now,
		PublishedAt: now.Add(-time.Minute),
		Quotes:      []model.Quote{{ID: 1, Symbol: "BTC", Rank: 1, MaxSupply: &max, Tags: []string{"pow"}, LastUpdated: now}},
		History:     map[int64][]model.Sample{1: {{At: now.Add(-time.Hour), Rank: 1, Price: 100}}},
	}
	if err := Save(path, in); err != nil {
		t.Fatal(err)
	}
	out, ok, err := Load(path)
	if err != nil || !ok {
		t.Fatalf("load: ok=%v err=%v", ok, err)
	}
	if !out.SavedAt.Equal(now) || len(out.Quotes) != 1 || *out.Quotes[0].MaxSupply != max || out.History[1][0].Price != 100 {
		t.Fatalf("round trip lost data: %+v", out)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
}

func TestLoadRejectsGarbage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json.gz")
	if err := os.WriteFile(path, []byte("not gzip"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := Load(path); ok || err == nil {
		t.Fatalf("garbage file: ok=%v err=%v", ok, err)
	}
}
