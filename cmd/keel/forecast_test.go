// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"log/slog"
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// TestStormNews: each storm of the sample week is named once in the news as
// it forms, where it is and which way it moves, in the general situation's
// words; told again, after a restart, it writes nothing. No gale warning
// is in the news.
func TestStormNews(t *testing.T) {
	cat := testCatalog(t)
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		t.Fatal(err)
	}
	db := &memDB{}
	p := &process{db: db, cat: cat, log: slog.New(slog.DiscardHandler)}
	sit := situationOf(cat, nil)
	row := store.World{Number: 1}
	ctx := context.Background()
	formed := func(_ context.Context, s forecast.Storm) { p.stormNews(ctx, row, s, &sit) }
	day := int64(24 * 3600 * physics.StepsPerSecond)
	is := forecast.New(forecast.Config{Timeline: tl, Formed: formed})
	for tick := int64(0); tick < day; tick += weather.PastEvery {
		is.Update(ctx, tick, nil, nil)
	}
	// Begun again: those told are not written again.
	n := len(db.gales)
	again := forecast.New(forecast.Config{Timeline: tl, Formed: formed})
	again.Update(ctx, day-weather.PastEvery, nil, nil)
	if len(db.gales) != n || n == 0 {
		t.Fatalf("%d storms in the news, %d after a restart", n, len(db.gales))
	}
	seen := map[int32]bool{}
	for _, g := range db.gales {
		if seen[g.Number] || g.Title != "STORM" || g.Column != worldColumn(cat) || math.Hypot(g.X, g.Y) == 0 {
			t.Fatalf("an item %+v", g)
		}
		seen[g.Number] = true
		t.Logf("%s: %s", g.Title, g.What)
	}
	want := sit.FormedText("a storm", db.gales[0].X, db.gales[0].Y, 0, 0)
	if got := db.gales[0].What; got[:len("A storm has formed ")] != want[:len("A storm has formed ")] {
		t.Fatalf("the words %q", got)
	}
}
