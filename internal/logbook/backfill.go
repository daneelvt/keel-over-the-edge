// SPDX-License-Identifier: AGPL-3.0-only

package logbook

import (
	"context"
	"fmt"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The backfill copies into the log what the worlds still kept recorded
// before the log was kept as it is now (store.LogFrom): each credited
// charting as its skipper's entry, with the kinds it adds to the
// collection; each voyage, from the events of its boat entering and
// leaving the water or going over the falls, with its closest approach to
// the lip and its bumps; and each bump as an entry of both sailors'. The
// distance run and the weather met were not recorded then, and are not
// made up: those voyages have no distance. Every row is made from its
// source rows, as the live log makes it, and written once by its source,
// so the backfill run twice writes once.

// BackfillStore is what the backfill reads and writes: internal/store.
type BackfillStore interface {
	LogFrom(ctx context.Context) (time.Time, error)
	KeptWorlds(ctx context.Context) ([]store.KeptWorld, error)
	BackfillChartings(ctx context.Context, world [16]byte, before time.Time) ([]store.Charting, error)
	BackfillEvents(ctx context.Context, world [16]byte, before time.Time) ([]store.StoredEvent, error)
	WriteLog(ctx context.Context, lease int64, rows store.LogRows) error
}

var _ BackfillStore = (*store.Store)(nil)

// BackfillConfig sets up a backfill.
type BackfillConfig struct {
	Store   BackfillStore
	Lease   int64 // the simulation lease's epoch, which every write is fenced by
	Catalog *catalog.Catalog
	// Chart is the chart of a kept world, by its ID: what can be charted
	// in it. nil, or a nil chart, leaves its chartings' entries unnamed.
	Chart func(ctx context.Context, world [16]byte) (*chart.World, error)
	// Fall is how many ticks a boat falls over the lip before its next
	// voyage begins.
	Fall int64
}

// BackfillDone is what a backfill wrote, before it was written once.
type BackfillDone struct {
	Worlds, Voyages, Entries int
}

// backfillBatch is how many rows a backfill writes in a transaction.
const backfillBatch = 500

// Backfill copies the kept worlds' records from before the log into it.
func Backfill(ctx context.Context, cfg BackfillConfig) (BackfillDone, error) {
	var done BackfillDone
	from, err := cfg.Store.LogFrom(ctx)
	if err != nil {
		return done, err
	}
	worlds, err := cfg.Store.KeptWorlds(ctx)
	if err != nil {
		return done, err
	}
	for _, w := range worlds {
		rows, err := backfillWorld(ctx, &cfg, w, from)
		if err != nil {
			return done, fmt.Errorf("world %d: %w", w.Number, err)
		}
		if rows.Empty() {
			continue
		}
		done.Worlds++
		done.Voyages += len(rows.Voyages)
		done.Entries += len(rows.Entries)
		for len(rows.Voyages) > 0 || len(rows.Entries) > 0 {
			var b store.LogRows
			n := min(len(rows.Voyages), backfillBatch)
			b.Voyages, rows.Voyages = rows.Voyages[:n], rows.Voyages[n:]
			m := min(len(rows.Entries), backfillBatch-n)
			b.Entries, rows.Entries = rows.Entries[:m], rows.Entries[m:]
			if err := cfg.Store.WriteLog(ctx, cfg.Lease, b); err != nil {
				return done, fmt.Errorf("world %d: %w", w.Number, err)
			}
		}
	}
	return done, nil
}

// backfillWorld makes the rows of one kept world's records before from.
func backfillWorld(ctx context.Context, cfg *BackfillConfig, w store.KeptWorld, from time.Time) (store.LogRows, error) {
	var rows store.LogRows
	charts, err := cfg.Store.BackfillChartings(ctx, w.ID, from)
	if err != nil {
		return rows, err
	}
	events, err := cfg.Store.BackfillEvents(ctx, w.ID, from)
	if err != nil {
		return rows, err
	}
	if len(charts) == 0 && len(events) == 0 {
		return rows, nil
	}
	var cw *chart.World
	if cfg.Chart != nil {
		if cw, err = cfg.Chart(ctx, w.ID); err != nil {
			return rows, err
		}
	}
	b := NewBook(Config{World: w.Number, Epoch: w.Epoch, Catalog: cfg.Catalog})
	var charted []int32
	if cw != nil {
		b.model = chart.NewModel(cw, cfg.Catalog, nil)
		b.model.Add(charts)
		charted = b.model.Charted()
	}
	place := func(x, y float64) string {
		if cw == nil {
			return ""
		}
		return NearestPlace(cw, charted, x, y)
	}
	backfillCharts(b, cw, charts, place, &rows)
	backfillVoyages(b, cfg.Fall, events, place, &rows)
	return rows, nil
}

// backfillCharts makes the skippers' entries of a world's chartings.
func backfillCharts(b *Book, cw *chart.World, charts []store.Charting, place func(x, y float64) string, rows *store.LogRows) {
	at := map[store.ChartKey]int{}
	for _, c := range charts {
		if c.WithSubject != "" {
			continue
		}
		e := store.LogEntry{
			Account: c.Account, Source: fmt.Sprintf("c:%d:%s:%d", b.world, c.Subject, c.Number), World: b.world, At: c.At,
			Kind: store.LogCharted, Worth: c.Worth, X: c.X, Y: c.Y,
		}
		if cw != nil {
			if i := cw.Index(chart.KindOf(c.Subject), c.Number); i >= 0 {
				s := &cw.Subjects[i]
				e.Title, e.What, e.X, e.Y = s.Title, b.model.What(i), s.X, s.Y
				e.Finds = b.findsOf(i, nil)
			}
		}
		e.Place = place(e.X, e.Y)
		at[store.ChartKey{Subject: c.Subject, Number: c.Number}] = len(rows.Entries)
		rows.Entries = append(rows.Entries, e)
	}
	if cw == nil {
		return
	}
	for _, c := range charts {
		if c.WithSubject == "" {
			continue
		}
		j, ok := at[store.ChartKey{Subject: c.WithSubject, Number: c.WithNumber}]
		if i := cw.Index(chart.KindOf(c.Subject), c.Number); ok && i >= 0 && rows.Entries[j].Account == c.Account {
			rows.Entries[j].Finds = b.findsOf(i, rows.Entries[j].Finds)
		}
	}
}

// voyageKey is a sailor's boat.
type voyageKey struct {
	account store.AccountID
	boat    uint64
}

// openVoyage is a voyage under way in a world's events: when it began,
// its bumps; and once ended, its row's index.
type openVoyage struct {
	began            int64
	bumpsAt, bumpsNt int
}

// backfillVoyages makes the voyages and bumps of a world's events.
func backfillVoyages(b *Book, fall int64, events []store.StoredEvent, place func(x, y float64) string, rows *store.LogRows) {
	open := map[voyageKey]*openVoyage{}
	// ended is each boat's voyage ended at the tick it ended, which an
	// approach of that tick belongs to.
	type endedAt struct {
		tick int64
		row  int
	}
	ended := map[voyageKey]endedAt{}
	voyage := func(k voyageKey, tick int64) *openVoyage {
		v := open[k]
		if v == nil {
			v = &openVoyage{began: tick}
			open[k] = v
		}
		return v
	}
	end := func(e *store.StoredEvent, how string) {
		k := voyageKey{store.AccountID(e.Account), e.Boat}
		v := voyage(k, e.Tick)
		delete(open, k)
		ended[k] = endedAt{tick: e.Tick, row: len(rows.Voyages)}
		rows.Voyages = append(rows.Voyages, store.LogVoyage{
			Account: k.account, Source: fmt.Sprintf("v:%d:%d:%d", b.world, e.Boat, v.began), World: b.world,
			Boat: e.Boat, Began: b.At(v.began), Ended: b.At(e.Tick), How: how, BumpsAt: v.bumpsAt, BumpsNot: v.bumpsNt,
		})
		if e.X != 0 || e.Y != 0 {
			rows.Voyages[len(rows.Voyages)-1].Place = place(e.X, e.Y)
		}
	}
	for i := range events {
		e := &events[i]
		k := voyageKey{store.AccountID(e.Account), e.Boat}
		switch e.Kind {
		case store.EventLaunched:
			open[k] = &openVoyage{began: e.Tick}
		case store.EventReturned:
			end(e, store.LogReturned)
		case store.EventExpired:
			end(e, store.LogExpired)
		case store.EventTaken:
			end(e, store.LogTaken)
		case store.EventOver:
			end(e, store.LogOver)
			open[k] = &openVoyage{began: e.Tick + fall}
		case store.EventApproach:
			if x, ok := ended[k]; ok && x.tick == e.Tick {
				v := &rows.Voyages[x.row]
				v.Least, v.Survived = e.Distance, true
				v.Finds = ladderFinds(e.Distance, v.Finds)
			}
		case store.EventBump:
			ok := voyageKey{store.AccountID(e.Other), e.OtherBoat}
			mine, theirs := store.FaultMine, store.FaultTheirs
			if e.Fault == store.FaultNone {
				mine, theirs = store.FaultNone, store.FaultNone
				voyage(k, e.Tick).bumpsNt++
			} else {
				voyage(k, e.Tick).bumpsAt++
			}
			voyage(ok, e.Tick).bumpsNt++
			at, where := b.At(e.Tick), place(e.X, e.Y)
			lo, hi := min(e.Boat, e.OtherBoat), max(e.Boat, e.OtherBoat)
			src := fmt.Sprintf("b:%d:%d:%d:%d", b.world, e.Tick, lo, hi)
			rows.Entries = append(rows.Entries,
				store.LogEntry{Account: k.account, Source: src, World: b.world, At: at, Kind: store.LogBump, X: e.X, Y: e.Y, Place: where,
					Other: ok.account, Article: e.Article, Fault: mine},
				store.LogEntry{Account: ok.account, Source: src, World: b.world, At: at, Kind: store.LogBump, X: e.X, Y: e.Y, Place: where,
					Other: k.account, Article: e.Article, Fault: theirs})
		}
	}
}
