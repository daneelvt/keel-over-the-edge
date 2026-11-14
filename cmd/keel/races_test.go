// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// noRaces is a database in memory's races: none made, the limits and the
// timetable their defaults, the harbour races' job finding nothing to do.
type noRaces struct{}

func (noRaces) RaceRecordsOf(context.Context, store.AccountID, int) ([]store.RaceRecord, error) {
	return nil, nil
}
func (noRaces) RaceSettings(context.Context) (store.RaceSettings, error) {
	return store.RaceSettings{Ahead: 2, Daily: 8, Made: 8, Owned: 3, Cutoff: 3 * time.Hour, Every: 3, GreenhornUS: 50}, nil
}
func (noRaces) SetRaceSettings(context.Context, store.RaceSettings, store.Action) error {
	return errNoAccounts
}
func (noRaces) MakeRace(context.Context, *store.NewRace, time.Time, time.Time, time.Time, func(store.RaceMaking, *store.NewRace) error) (string, error) {
	return "", errNoAccounts
}
func (noRaces) MakeHarbourRaces(context.Context, int64, []store.NewRace) (int, error) { return 0, nil }
func (noRaces) RaceByCode(context.Context, string) (store.Race, error) {
	return store.Race{}, store.ErrNotFound
}
func (noRaces) HarbourRaces(context.Context, [16]byte, int, time.Time, int) ([]store.Race, error) {
	return nil, nil
}
func (noRaces) RacesOf(context.Context, [16]byte, int, store.AccountID) ([]store.Race, error) {
	return nil, nil
}
func (noRaces) RaceEntrants(context.Context, *store.Race) ([]store.RaceEntrant, error) {
	return nil, nil
}
func (noRaces) RaceEntryOf(context.Context, *store.Race, store.AccountID) (store.RaceEntry, bool, error) {
	return store.RaceEntry{}, false, nil
}
func (noRaces) EntriesOf(context.Context, store.AccountID, time.Time) ([]store.EntryStart, error) {
	return nil, nil
}
func (noRaces) RacesBy(context.Context, store.AccountID, time.Time) ([]time.Time, int, error) {
	return nil, 0, nil
}
func (noRaces) EnterRace(context.Context, *store.Race, store.AccountID, bool, bool, time.Time, time.Time, func(store.RaceEntering) error) error {
	return store.ErrNotFound
}
func (noRaces) WithdrawEntry(context.Context, *store.Race, store.AccountID, time.Time) (bool, error) {
	return false, nil
}
func (noRaces) RemoveEntry(context.Context, *store.Race, int) (store.AccountID, error) {
	return store.AccountID{}, store.ErrNotFound
}
func (noRaces) SetRaceState(context.Context, *store.Race, string, []string, time.Time) (bool, error) {
	return false, nil
}
func (noRaces) MoveRace(context.Context, *store.Race, time.Time) (bool, error) { return false, nil }
func (noRaces) RacesSailed(context.Context, store.AccountID) (int, error)      { return 0, nil }
func (noRaces) HarbourDays(context.Context, [16]byte) ([]store.HarbourDay, error) {
	return nil, nil
}
func (noRaces) SetHarbourDays(context.Context, int64, [16]byte, []store.HarbourDay) error { return nil }
func (noRaces) BusyAreas(context.Context, [16]byte, time.Time, time.Time) ([]store.BuoyStart, error) {
	return nil, nil
}
func (noRaces) DueRaces(context.Context, [16]byte, int, time.Time, time.Time) ([]store.Race, error) {
	return nil, nil
}
func (noRaces) RaceIn(context.Context, [16]byte, int, [16]byte) (store.Race, error) {
	return store.Race{}, store.ErrNotFound
}
func (noRaces) PendingRuns(context.Context, [16]byte) ([]store.PendingRun, error)     { return nil, nil }
func (noRaces) StartRace(context.Context, int64, *store.RaceStart) error              { return nil }
func (noRaces) EndRace(context.Context, int64, store.NewsRules, *store.RaceEnd) error { return nil }
func (noRaces) HangSpoon(context.Context, store.AccountID, int, string, bool) error {
	return store.ErrNotFound
}
func (noRaces) RaceResults(context.Context, [16]byte, [16]byte) ([]store.RaceRun, error) {
	return nil, nil
}

func (noRaces) RaceRuns(context.Context, [16]byte, [16]byte) ([]store.RaceLaid, error) {
	return nil, nil
}

func (noRaces) RaceRecordsByCode(context.Context, string) ([]store.RaceRecord, error) {
	return nil, nil
}

func (noRaces) RaceRibbonsOf(context.Context, store.AccountID, int, int) ([]store.RaceRecord, error) {
	return nil, nil
}

func (noRaces) RaceCountsOf(context.Context, store.AccountID) (store.RaceCounts, error) {
	return store.RaceCounts{}, nil
}
