// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"log/slog"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// TestNoStormNews: the process's own issuer, updated over a day of the
// sample week at every five minutes while the week's storms form in it,
// writes nothing to the news. The news tells what is charted and the
// world's own notices; the weather is the chart's and the forecast's.
func TestNoStormNews(t *testing.T) {
	cat := testCatalog(t)
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		t.Fatal(err)
	}
	db := &memDB{}
	p := &process{db: db, cat: cat, log: slog.New(slog.DiscardHandler)}
	rw := &readyWorld{charts: newWorldChart(worldgen.Empty(1), cat, [16]byte{1}, []byte("key"))}
	is := p.forecastsOf(rw, store.World{Number: 1}, tl)
	day := int64(24 * 3600 * physics.StepsPerSecond)
	ctx := context.Background()
	for tick := int64(0); tick < day; tick += weather.PastEvery {
		is.Update(ctx, tick, nil, nil)
	}
	if is.Latest() == nil {
		t.Fatal("no forecast issued")
	}
	storms := 0
	for _, s := range tl.Week().Systems {
		if at := int64(s.Born) + tl.Origin(); s.Kind == float64(tl.Config().Week.Storms) && at >= 0 && at < day {
			storms++
		}
	}
	if storms == 0 {
		t.Fatal("no storm forms in the day: the test shows nothing")
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	if len(db.news) != 0 {
		t.Fatalf("%d items written to the news: %+v", len(db.news), db.news)
	}
	t.Logf("%d storms formed in the day, no news", storms)
}
