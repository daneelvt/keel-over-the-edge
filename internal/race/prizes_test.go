// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// The races' colours are the game's own, the same on every phone: these
// are what the client's ribbons give the same codes.
func TestRaceColoursAreTheClients(t *testing.T) {
	for code, want := range map[string]int{"abcdefghij": 5, "k2m3n4p5q6": 3, "zzzzzzzzzz": 0, "a2a2a2a2a2": 1, "qwertyuiop": 1, "mnbvcxz234": 5} {
		if got := RaceColour(code, 6); got != want {
			t.Errorf("%s: colour %d, want %d", code, got, want)
		}
	}
}

// A sailor's records in a world make their prize code: a pennant for each
// of the latest wins, in its race's colour; the burgee by races sailed;
// the spoons hung; the committee's flag by races run.
func TestPrizesFromRecords(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	rules := PrizeRulesOf(cat)
	if rules.Colours != 6 || rules.Pennants != 5 || rules.Spoons != 3 || rules.Burgee >= rules.Gilded {
		t.Fatalf("the catalog's rules: %+v", rules)
	}
	if p := PrizesFrom(store.RacePrizes{}, rules); p != 0 || p.Cockade() {
		t.Errorf("no records: %#x", uint32(p))
	}
	wins := []string{"abcdefghij", "k2m3n4p5q6", "zzzzzzzzzz", "a2a2a2a2a2", "qwertyuiop", "mnbvcxz234"}
	p := PrizesFrom(store.RacePrizes{Sailed: rules.Burgee, Wins: wins[:2], Spoons: 1}, rules)
	if p.Pennants() != 2 || p.Pennant(0) != 5 || p.Pennant(1) != 3 || !p.Cockade() {
		t.Errorf("two wins: %d pennants, %d and %d", p.Pennants(), p.Pennant(0), p.Pennant(1))
	}
	if p.Burgee() != BurgeeRacing || p.Spoons() != 1 || p.Committee() {
		t.Errorf("burgee %d, %d spoons, committee %v", p.Burgee(), p.Spoons(), p.Committee())
	}
	p = PrizesFrom(store.RacePrizes{Sailed: rules.Gilded + 10, Wins: wins, Spoons: 9, Ran: rules.Ran}, rules)
	if p.Pennants() != rules.Pennants || p.Pennant(4) != 1 || p.Burgee() != BurgeeGilded || p.Spoons() != rules.Spoons || !p.Committee() {
		t.Errorf("a world's worth: %d pennants (last %d), burgee %d, %d spoons, committee %v",
			p.Pennants(), p.Pennant(4), p.Burgee(), p.Spoons(), p.Committee())
	}
	if p := PrizesFrom(store.RacePrizes{Sailed: rules.Burgee - 1, Ran: rules.Ran - 1}, rules); p != 0 {
		t.Errorf("short of the burgee and the flag: %#x", uint32(p))
	}
}

// The pendant is of the highest certificate held, whatever the order
// they were earned in, and leaves the rest of the code alone; none
// without one, nor for an id the catalog no longer has.
func TestPendantFromCertificates(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	rules := PrizeRulesOf(cat)
	if len(cat.Certificates) != 5 {
		t.Fatalf("%d certificates", len(cat.Certificates))
	}
	id := func(i int) string { return string(cat.Certificates[i].ID) }
	if p := PrizesFrom(store.RacePrizes{Held: []string{"no such certificate"}}, rules); p.Pendant() != 0 || p != 0 {
		t.Errorf("an unknown certificate: %#x", uint32(p))
	}
	for i := range cat.Certificates {
		if p := PrizesFrom(store.RacePrizes{Held: []string{id(i)}}, rules); p.Pendant() != i+1 {
			t.Errorf("%s: pendant %d", id(i), p.Pendant())
		}
	}
	p := PrizesFrom(store.RacePrizes{Sailed: rules.Gilded, Wins: []string{"abcdefghij"}, Spoons: 3, Ran: rules.Ran,
		Held: []string{id(0), id(4), id(1)}}, rules)
	if p.Pendant() != 5 || p.Pennants() != 1 || p.Burgee() != BurgeeGilded || p.Spoons() != 3 || !p.Committee() {
		t.Errorf("the Master's with every prize: pendant %d, code %#x", p.Pendant(), uint32(p))
	}
}

// A sailor is read once asked for, at the next turn, and shows nothing
// till then; read again when asked again; asked again after a failed read.
func TestPrizeBoardReadsWhenAsked(t *testing.T) {
	b := newPrizeBoard()
	a, c := bus.Account{1}, bus.Account{2}
	var reads [][]store.AccountID
	fail := false
	read := func(ids []store.AccountID) (map[store.AccountID]Prizes, error) {
		reads = append(reads, ids)
		if fail {
			return nil, errors.New("no database")
		}
		return map[store.AccountID]Prizes{store.AccountID(a): 7}, nil
	}
	ctx := context.Background()
	if p := b.of(a); p != 0 {
		t.Fatalf("before a read: %d", p)
	}
	b.of(c)
	if err := b.load(ctx, 10, read); err != nil {
		t.Fatal(err)
	}
	if len(reads) != 1 || len(reads[0]) != 2 {
		t.Fatalf("reads: %v", reads)
	}
	if b.of(a) != 7 || b.of(c) != 0 {
		t.Errorf("read: %d and %d", b.of(a), b.of(c))
	}
	// Known sailors are not read again unless asked.
	if err := b.load(ctx, 10, read); err != nil || len(reads) != 1 {
		t.Errorf("read again unasked: %v, %v", reads, err)
	}
	b.want(a)
	fail = true
	if err := b.load(ctx, 10, read); err == nil {
		t.Error("a failed read not told")
	}
	if b.of(a) != 7 {
		t.Error("a failed read lost what was known")
	}
	fail = false
	if err := b.load(ctx, 10, read); err != nil || len(reads) != 3 {
		t.Errorf("not asked again after a failed read: %v, %v", reads, err)
	}
}

// A sailor's pendant is read from the certificates they hold, kept for
// good: read again once asked after an earning, and worn in the next world
// too.
func TestPendantReadAgainOnEarning(t *testing.T) {
	s := newSea(t)
	sailor := s.human()
	a := bus.Account(sailor.ID)
	read := func(svc *Service) Prizes {
		t.Helper()
		svc.PrizesOf(a)
		if err := svc.LoadPrizes(s.ctx); err != nil {
			t.Fatal(err)
		}
		return svc.PrizesOf(a)
	}
	if p := read(s.svc); p.Pendant() != 0 {
		t.Fatalf("no certificate: pendant %d", p.Pendant())
	}
	earn := func(i int) {
		t.Helper()
		c := store.Certificate{ID: string(s.cat.Certificates[i].ID), Earned: time.Now(), World: s.world.Number}
		if ok, err := s.db.Exam().Earn(s.ctx, sailor.ID, &c, s.cat.Certificates[i].Name, nil, 0); err != nil || !ok {
			t.Fatalf("earning %s: %v, %v", c.ID, ok, err)
		}
	}
	earn(0)
	earn(1)
	if p := s.svc.PrizesOf(a); p.Pendant() != 0 {
		t.Errorf("read again unasked: pendant %d", p.Pendant())
	}
	s.svc.Reread(a)
	if err := s.svc.LoadPrizes(s.ctx); err != nil {
		t.Fatal(err)
	}
	if p := s.svc.PrizesOf(a); p.Pendant() != 2 {
		t.Errorf("after earning the second: pendant %d", p.Pendant())
	}
	next := New(Config{Store: s.db, Catalog: s.cat, World: World{ID: s.world.ID, Number: s.world.Number + 1}})
	if p := read(next); p.Pendant() != 2 || p.Pennants() != 0 {
		t.Errorf("the next world: %#x", uint32(p))
	}
}

// Only the world sailed now shows afloat: a sailor's wins of an earlier
// world stay in their log, and a new world starts bare.
func TestANewWorldStartsBare(t *testing.T) {
	s := newSea(t)
	winner, other := s.human(), s.human()
	pool := storetest.PoolOn(t, s.url)
	put := func(id store.AccountID, world int, n int, role string, place int, fleet int) {
		t.Helper()
		if _, err := pool.Exec(s.ctx, `INSERT INTO race_record (account_id, source, world, at, code, race_name, kind, course_name, boat,
			role, how, place, fleet, hung, awards)
			VALUES ($1, $2, $3, now() + make_interval(secs => $4), 'abcdefghij', 'A race', 'race', 'A course', 'a boat', $5, 'finished',
			nullif($6, 0), $7, $6 = 9, CASE WHEN $6 = 9 THEN '{spoon}'::text[] ELSE '{}' END)`,
			id, fmt.Sprintf("test:%d:%d", world, n), world, n, role, place, fleet); err != nil {
			t.Fatal(err)
		}
	}
	// Won twice in this world, once in a race of two boats (which
	// counts for nothing), and a spoon hung; won in the world before.
	put(winner.ID, s.world.Number, 1, store.RoleSkipper, 1, 3)
	put(winner.ID, s.world.Number, 2, store.RoleCrew, 1, 4)
	put(winner.ID, s.world.Number, 3, store.RoleSkipper, 1, 2)
	put(winner.ID, s.world.Number, 4, store.RoleSkipper, 9, 5)
	put(other.ID, s.world.Number+1, 1, store.RoleSkipper, 1, 3)
	for i := range 5 {
		put(other.ID, s.world.Number, 10+i, store.RoleOwner, 0, 3)
	}
	a, o := bus.Account(winner.ID), bus.Account(other.ID)
	s.svc.PrizesOf(a)
	s.svc.PrizesOf(o)
	if err := s.svc.LoadPrizes(s.ctx); err != nil {
		t.Fatal(err)
	}
	p := s.svc.PrizesOf(a)
	if p.Pennants() != 2 || !p.Cockade() || p.Spoons() != 1 || p.Burgee() != BurgeeRacing || p.Committee() {
		t.Errorf("this world's winner: %d pennants, %d spoons, burgee %d, committee %v", p.Pennants(), p.Spoons(), p.Burgee(), p.Committee())
	}
	if p := s.svc.PrizesOf(o); p.Pennants() != 0 || !p.Committee() {
		t.Errorf("a race owner with a win in another world: %d pennants, committee %v", p.Pennants(), p.Committee())
	}
	// The next world: the same sailors, nothing afloat.
	next := New(Config{Store: s.db, Catalog: s.cat, World: World{ID: s.world.ID, Number: s.world.Number + 2}})
	next.PrizesOf(a)
	next.PrizesOf(o)
	if err := next.LoadPrizes(s.ctx); err != nil {
		t.Fatal(err)
	}
	if p, q := next.PrizesOf(a), next.PrizesOf(o); p != 0 || q != 0 {
		t.Errorf("a new world: %#x and %#x", uint32(p), uint32(q))
	}
}
