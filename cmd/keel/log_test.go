// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"slices"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The in-memory database keeps the log's rows the world writes, and
// knows no sailor to read a log of.

func (d *memDB) logRows() store.LogRows {
	d.mu.Lock()
	defer d.mu.Unlock()
	return store.LogRows{Voyages: slices.Clone(d.log.Voyages), Entries: slices.Clone(d.log.Entries)}
}

func (*memDB) LogSailorByKey(context.Context, string) (store.LogSailor, error) {
	return store.LogSailor{}, store.ErrNotFound
}

func (*memDB) LogSailorByID(context.Context, store.AccountID) (store.LogSailor, error) {
	return store.LogSailor{}, store.ErrNotFound
}

func (*memDB) LogPeople(context.Context, []store.AccountID) (map[store.AccountID]store.LogPerson, error) {
	return map[store.AccountID]store.LogPerson{}, nil
}

func (*memDB) SetLogShown(context.Context, store.AccountID, string) error { return store.ErrNotFound }

func (*memDB) LogTotals(context.Context, store.AccountID) (store.LogTotals, error) {
	return store.LogTotals{}, nil
}

func (*memDB) LogWorlds(context.Context, store.AccountID) ([]store.LogWorld, error) { return nil, nil }

func (d *memDB) LogVoyages(_ context.Context, id store.AccountID, world int) ([]store.LogVoyage, error) {
	var out []store.LogVoyage
	for _, v := range d.logRows().Voyages {
		if v.Account == id && v.World == world {
			out = append(out, v)
		}
	}
	return out, nil
}

func (d *memDB) LogEntries(_ context.Context, id store.AccountID, world int) ([]store.LogEntry, error) {
	var out []store.LogEntry
	for _, e := range d.logRows().Entries {
		if e.Account == id && e.World == world {
			out = append(out, e)
		}
	}
	return out, nil
}

func (*memDB) LogFinds(context.Context, store.AccountID) ([]store.LogKept, error) { return nil, nil }

func (d *memDB) LogFrom(context.Context) (time.Time, error) { return d.epoch, nil }

func (*memDB) LogFigures(context.Context, []store.AccountID) (map[store.AccountID]store.LogFigures, error) {
	return map[store.AccountID]store.LogFigures{}, nil
}

func (*memDB) KeptWorlds(context.Context) ([]store.KeptWorld, error) { return nil, nil }

func (*memDB) BackfillChartings(context.Context, [16]byte, time.Time) ([]store.Charting, error) {
	return nil, nil
}

func (*memDB) BackfillEvents(context.Context, [16]byte, time.Time) ([]store.StoredEvent, error) {
	return nil, nil
}

func (d *memDB) WriteLog(_ context.Context, lease int64, rows store.LogRows) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.log.Voyages = append(d.log.Voyages, rows.Voyages...)
	d.log.Entries = append(d.log.Entries, rows.Entries...)
	return nil
}
