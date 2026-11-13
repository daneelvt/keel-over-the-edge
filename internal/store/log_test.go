// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// TestLogWritten: the log's rows are written with the world's batch, once
// by their source; a charting's entry only with its charting; finds
// counted, a first find an entry of its own; the totals counted from the
// rows; names copied as they were; and a row of an account deleted
// meanwhile dropped without failing the batch.
func TestLogWritten(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	world, err := s.ActiveOrFirstWorld(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	ann, err := s.CreateAccount(ctx, storetest.NewAccount("Ann Bonny", "annbonny", [32]byte{1}))
	if err != nil {
		t.Fatal(err)
	}
	tom, err := s.CreateAccount(ctx, storetest.NewAccount("Tom Bowline", "tornbowline", [32]byte{2}))
	if err != nil {
		t.Fatal(err)
	}
	mary, err := s.CreateMachine(ctx, ann, store.NewMachine{Name: "Iron Mary", NameKey: "ironrnary", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat")
	if err != nil {
		t.Fatal(err)
	}
	epoch := take(t, newLease(t, u, "keel-a dev", store.LeaseOptions{}))
	p, err := store.OpenPersister(ctx, u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	t0 := time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC)
	boats := []store.LogFind{{Group: "boats", Kind: "jolly-boat"}}
	voyage := store.LogVoyage{
		Account: ann, Source: "v:1:4:30", World: 1, Boat: 4, BoatKind: "jolly-boat", BoatName: "Gull", Began: t0, Ended: t0.Add(time.Hour),
		How: store.LogOver, Run: 8400, Logged: true, Place: "Keyhole Rock", Least: 12.5, Survived: true, BumpsAt: 1, BumpsNot: 2,
		Met: store.LogMetGale | store.LogRodeGale | store.LogMetNight, GalePlace: "Gull Reach",
		Crew:  []store.LogMate{{ID: tom, Seconds: 600}, {ID: mary, Machine: true, Seconds: 300}},
		Finds: append(boats, store.LogFind{Group: "edge", Kind: "within-20m"}),
	}
	aboard := store.LogVoyage{
		Account: tom, Source: "a:1:4:90", World: 1, Aboard: true, Boat: 4, BoatKind: "jolly-boat", BoatName: "Gull", Began: t0,
		Ended: t0.Add(10 * time.Minute), How: store.LogAshore, Run: 1200, Logged: true, Skipper: ann, Finds: boats,
	}
	charted := store.LogEntry{
		Account: ann, Source: "c:1:island:7", World: 1, At: t0.Add(time.Minute), Kind: store.LogCharted, Title: "Keyhole Rock",
		What: "an island of the rim", Worth: 24, X: 100, Y: 200, Charting: &store.ChartKey{Subject: "island", Number: 7},
		Finds: []store.LogFind{{Group: "islands", Kind: "rocky"}, {Group: "sizes", Kind: "small"}},
	}
	sighted := charted
	sighted.Account, sighted.Kind, sighted.Other, sighted.OtherBoat = tom, store.LogSighted, ann, "Gull"
	unwritten := store.LogEntry{
		Account: ann, Source: "c:1:island:8", World: 1, At: t0, Kind: store.LogCharted, Title: "Charted already",
		Charting: &store.ChartKey{Subject: "island", Number: 8},
	}
	bump := store.LogEntry{
		Account: ann, Source: "b:1:500:4:5", World: 1, At: t0.Add(2 * time.Minute), Kind: store.LogBump, Other: tom, OtherBoat: "Kittiwake",
		Article: "10", Fault: store.FaultMine, Place: "Keyhole Rock",
	}
	b := store.Batch{World: world.ID, Epoch: epoch, Charting: []store.Charting{
		{Subject: "island", Number: 7, Credited: true, Account: ann, Boat: 4, Tick: 90, Worth: 24},
	}, Log: store.LogRows{Voyages: []store.LogVoyage{voyage, aboard}, Entries: []store.LogEntry{charted, sighted, unwritten, bump}}}
	// Island 8 is charted already: its entry is not written.
	if err := p.Write(ctx, store.Batch{World: world.ID, Epoch: epoch, Charting: []store.Charting{{Subject: "island", Number: 8, Tick: 1}}}); err != nil {
		t.Fatal(err)
	}
	b.Charting = append(b.Charting, store.Charting{Subject: "island", Number: 8, Credited: true, Account: ann, Boat: 4, Tick: 91})
	if err := p.Write(ctx, b); err != nil {
		t.Fatal(err)
	}
	// Written again, by a retry or the backfill: once.
	b.Charting = nil
	if err := p.Write(ctx, b); err != nil {
		t.Fatal(err)
	}

	vs, err := s.LogVoyages(ctx, ann, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(vs) != 1 {
		t.Fatalf("Ann's voyages: %+v", vs)
	}
	v := vs[0]
	if v.How != store.LogOver || v.Run != 8400 || !v.Logged || v.Least != 12.5 || !v.Survived || v.BumpsAt != 1 || v.BumpsNot != 2 ||
		v.Met != voyage.Met || v.GalePlace != "Gull Reach" || v.BoatName != "Gull" || !v.Began.Equal(t0) {
		t.Errorf("the voyage read back: %+v", v)
	}
	if len(v.Crew) != 2 || v.Crew[0] != (store.LogMate{ID: tom, Name: "Tom Bowline", Seconds: 600}) ||
		v.Crew[1] != (store.LogMate{ID: mary, Name: "Iron Mary", Machine: true, Seconds: 300}) {
		t.Errorf("its crew: %+v", v.Crew)
	}
	tv, err := s.LogVoyages(ctx, tom, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(tv) != 1 || !tv[0].Aboard || tv[0].Skipper != ann || tv[0].SkipperName != "Ann Bonny" {
		t.Errorf("Tom's time aboard: %+v", tv)
	}
	es, err := s.LogEntries(ctx, ann, 1)
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]int{}
	for _, e := range es {
		kinds[e.Kind]++
	}
	// Charted, bumped, and first finds: a boat, a rung, a biome, a size.
	if kinds[store.LogCharted] != 1 || kinds[store.LogBump] != 1 || kinds[store.LogFound] != 4 || len(es) != 6 {
		t.Errorf("Ann's entries: %v", kinds)
	}
	for _, e := range es {
		if e.Kind == store.LogBump && (e.OtherName != "Tom Bowline" || e.Other != tom || e.Fault != store.FaultMine || e.Article != "10") {
			t.Errorf("the bump: %+v", e)
		}
	}
	finds, err := s.LogFinds(ctx, ann)
	if err != nil {
		t.Fatal(err)
	}
	if len(finds) != 4 {
		t.Errorf("Ann's collection: %+v", finds)
	}
	tf, err := s.LogFinds(ctx, tom)
	if err != nil {
		t.Fatal(err)
	}
	// Tom sighted the island aboard: its kinds are his too; and the boat.
	if len(tf) != 3 {
		t.Errorf("Tom's collection: %+v", tf)
	}

	// Another voyage of the same boat's kind counts it again, and adds no
	// first find.
	again := voyage
	again.Source, again.How, again.Crew, again.Finds, again.Survived = "v:1:4:900", store.LogReturned, nil, boats, false
	if err := p.Write(ctx, store.Batch{World: world.ID, Epoch: epoch, Log: store.LogRows{Voyages: []store.LogVoyage{again}}}); err != nil {
		t.Fatal(err)
	}
	finds, _ = s.LogFinds(ctx, ann)
	for _, f := range finds {
		if f.Group == "boats" && (f.Count != 2 || f.FirstWorld != 1 || f.LastWorld != 1) {
			t.Errorf("the boat found twice: %+v", f)
		}
	}
	tot, err := s.LogTotals(ctx, ann)
	if err != nil {
		t.Fatal(err)
	}
	if tot.Voyages != 2 || tot.Run != 16800 || tot.Falls != 1 || tot.Least != 12.5 || !tot.Survived || tot.BumpsAt != 2 ||
		tot.Gales != 2 || tot.Nights != 2 || tot.Charted != 1 || tot.Worlds != 1 || tot.Crewed != 1 || !tot.LoggedFrom.Equal(t0) {
		t.Errorf("Ann's totals: %+v", tot)
	}
	worlds, err := s.LogWorlds(ctx, ann)
	if err != nil || len(worlds) != 1 || worlds[0].Number != 1 {
		t.Errorf("Ann's worlds: %+v, %v", worlds, err)
	}

	// A sailor deleted while their voyage was being written: the row is
	// dropped, the batch goes through.
	gone := voyage
	gone.Account, gone.Source = store.AccountID{9}, "v:1:9:1"
	if err := p.Write(ctx, store.Batch{World: world.ID, Epoch: epoch, Log: store.LogRows{Voyages: []store.LogVoyage{gone}}}); err != nil {
		t.Fatalf("a voyage of no account: %v", err)
	}

	// Tom deletes his account: his rows go, and in Ann's log he is a
	// former sailor.
	if _, err := s.DeleteAccount(ctx, tom); err != nil {
		t.Fatal(err)
	}
	vs, _ = s.LogVoyages(ctx, ann, 1)
	es, _ = s.LogEntries(ctx, ann, 1)
	for _, v := range vs {
		for _, m := range v.Crew {
			if m.Name == "Tom Bowline" || m.ID == tom {
				t.Errorf("Tom kept in Ann's crew: %+v", v.Crew)
			}
		}
	}
	if v := vs[0]; len(v.Crew) != 2 || v.Crew[0] != (store.LogMate{Seconds: 600}) || v.Crew[1].Name != "Iron Mary" {
		t.Errorf("Ann's crew after Tom left: %+v", v.Crew)
	}
	for _, e := range es {
		if e.Kind == store.LogBump && (e.OtherName != "" || e.Other != (store.AccountID{}) || e.OtherBoat != "Kittiwake") {
			t.Errorf("Tom kept in Ann's bump: %+v", e)
		}
	}
	if tv, _ := s.LogVoyages(ctx, tom, 1); len(tv) != 0 {
		t.Errorf("Tom's own log kept: %+v", tv)
	}
}

// TestLogShown: who may read a log is a human's to set; a machine
// sailor's is always sailors'.
func TestLogShown(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	ann, err := s.CreateAccount(ctx, storetest.NewAccount("Ann Bonny", "annbonny", [32]byte{1}))
	if err != nil {
		t.Fatal(err)
	}
	mary, err := s.CreateMachine(ctx, ann, store.NewMachine{Name: "Iron Mary", NameKey: "ironrnary", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat")
	if err != nil {
		t.Fatal(err)
	}
	l, err := s.LogSailorByKey(ctx, "annbonny")
	if err != nil || l.ID != ann || l.Shown != store.LogShownDefault || l.Name != "Ann Bonny" || l.Kind != store.Human {
		t.Fatalf("Ann: %+v, %v", l, err)
	}
	if err := s.SetLogShown(ctx, ann, store.LogShownMe); err != nil {
		t.Fatal(err)
	}
	if err := s.SetLogShown(ctx, mary, store.LogShownMe); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("a machine sailor's log kept from sailors: %v", err)
	}
	pool := storetest.PoolOn(t, u)
	refused(t, exec(t, pool, "UPDATE account SET log_shown = 'me' WHERE id = $1", mary), "23514")
	refused(t, exec(t, pool, "UPDATE account SET log_shown = 'everyone' WHERE id = $1", ann), "23514")
	must(t, pool, "UPDATE account SET log_shown = 'sailors' WHERE id = $1", mary)
	people, err := s.LogPeople(ctx, []store.AccountID{ann, mary, {7}})
	if err != nil {
		t.Fatal(err)
	}
	if len(people) != 2 || people[ann].Shown != store.LogShownMe || people[mary].Kind != store.AI || people[mary].Owner != ann {
		t.Errorf("the people: %+v", people)
	}
	m, err := s.LogSailorByID(ctx, mary)
	if err != nil || m.Kind != store.AI || m.Owner != ann {
		t.Errorf("Iron Mary: %+v, %v", m, err)
	}
	if _, err := s.LogSailorByKey(ctx, "nobody"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("no sailor: %v", err)
	}
}
