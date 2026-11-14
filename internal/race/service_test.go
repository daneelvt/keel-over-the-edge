// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"context"
	"crypto/sha256"
	"fmt"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// sea is a world's races on a real database, with a clock the test moves.
type sea struct {
	t      *testing.T
	ctx    context.Context
	db     *store.Store
	cat    *catalog.Catalog
	svc    *Service
	world  store.World
	now    time.Time
	ends   time.Time
	blocks map[[2]store.AccountID]bool
	n      int
	url    string
	lease  int64
}

func newSea(t *testing.T) *sea {
	t.Helper()
	db, u := storetest.Store(t, store.Options{})
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := time.Date(2026, time.November, 17, 15, 0, 0, 0, time.UTC)
	w, err := db.CreateWorld(ctx, now.Add(-48*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	s := &sea{t: t, ctx: ctx, db: db, cat: cat, world: w, now: now, ends: now.Add(4 * 24 * time.Hour),
		blocks: map[[2]store.AccountID]bool{}, url: u}
	l, err := store.NewLease(u, store.LeaseOptions{Holder: "keel-a test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Release(context.Background()) })
	if s.lease, err = l.Take(ctx); err != nil {
		t.Fatal(err)
	}
	// The island course is offered to every boat but the jolly boat
	// (the first), in half an hour.
	island := Course{Number: 3, Kind: "round", Name: "Round Gannet Holm", Length: 4000,
		Way: [][2]float64{{0, 0}, {1000, 2000}}, Boats: map[string]float64{}}
	for _, b := range cat.Boats[1:] {
		island.Boats[string(b.ID)] = 1800
	}
	s.svc = New(Config{
		Store: db, Catalog: cat, World: World{ID: w.ID, Number: w.Number, Seed: 7, Begins: now.Add(-48 * time.Hour)},
		Ends: func() time.Time { return s.ends },
		Courses: func() Courses {
			return Courses{Areas: []Area{{Number: 1}, {Number: 2}}, Island: []Course{island}}
		},
		Blocks: func(a, b store.AccountID) bool {
			return s.blocks[[2]store.AccountID{a, b}] || s.blocks[[2]store.AccountID{b, a}]
		},
		Origin: "https://play.example",
		Now:    func() time.Time { return s.now },
	})
	return s
}

// human is a new human sailor, an adult.
func (s *sea) human() Sailor {
	s.t.Helper()
	return s.born(199001)
}

// born is a new human sailor born in a month (200901: January 2009).
func (s *sea) born(month int32) Sailor {
	s.t.Helper()
	s.n++
	name := fmt.Sprintf("Sailor %c%c", 'a'+s.n%26, 'a'+s.n/26)
	a := storetest.NewAccount(name, moderation.Key(name), sha256.Sum256([]byte(name)))
	id, err := s.db.CreateAccount(s.ctx, a)
	if err != nil {
		s.t.Fatal(err)
	}
	if err := s.db.SetBorn(s.ctx, id, month); err != nil {
		s.t.Fatal(err)
	}
	return Sailor{ID: id}
}

// machine is a new machine sailor of a new human's.
func (s *sea) machine() Sailor {
	s.t.Helper()
	owner := s.human()
	s.n++
	name := fmt.Sprintf("Engine %c%c", 'a'+s.n%26, 'a'+s.n/26)
	id, err := s.db.CreateMachine(s.ctx, owner.ID, store.NewMachine{Name: name, NameKey: moderation.Key(name), Version: "v", Finish: "f", Colour: "c"}, s.jolly())
	if err != nil {
		s.t.Fatal(err)
	}
	return Sailor{ID: id, Machine: true, Owner: owner.ID}
}

func (s *sea) jolly() string { return string(s.cat.Boats[0].ID) }

// make makes a race of the jolly boat on a short triangle starting in
// in, by by, or fails the test.
func (s *sea) make(by Sailor, in time.Duration, who string) Card {
	s.t.Helper()
	c, err := s.svc.Make(s.ctx, by, Making{Kind: KindRace, Course: "buoy:triangle:short", Boat: s.jolly(), At: s.now.Add(in), Who: who})
	if err != nil {
		s.t.Fatalf("making a race: %v", err)
	}
	return c
}

// harbour makes harbour races of boat starting at the times given, with
// no owner: races any limit lets anyone make.
func (s *sea) harbour(boat string, starts ...time.Time) []string {
	s.t.Helper()
	var races []store.NewRace
	for i, at := range starts {
		races = append(races, store.NewRace{World: s.world.ID, Kind: KindRace, CourseKind: CourseBuoy, Course: 1 + i%2,
			Shape: ShapeTriangle, Boat: boat, Who: WhoEveryone, Name: fmt.Sprintf("Race %d", i), StartsAt: at, Harbour: at.Hour(), MadeAt: s.now})
	}
	if _, err := s.db.MakeHarbourRaces(s.ctx, s.lease, races); err != nil {
		s.t.Fatal(err)
	}
	var codes []string
	for _, at := range starts {
		rs, err := s.db.HarbourRaces(s.ctx, s.world.ID, s.world.Number, at.Add(-time.Second), 1)
		if err != nil || len(rs) != 1 {
			s.t.Fatalf("the harbour race at %s: %v %v", at, rs, err)
		}
		codes = append(codes, rs[0].Code)
	}
	return codes
}

// refused checks err is a refusal for reason, and is it.
func refused(t *testing.T, err error, reason string) *Refusal {
	t.Helper()
	r, ok := RefusalOf(err)
	if !ok || r.Reason != reason {
		t.Fatalf("refused %v, want %q", err, reason)
	}
	return r
}

// TestMakingLimits: three races owned not finished, eight made in a day,
// cancelled ones counted toward the day but not toward those owned; the
// same for a human and a machine sailor.
func TestMakingLimits(t *testing.T) {
	s := newSea(t)
	for _, who := range []string{"human", "machine"} {
		t.Run(who, func(t *testing.T) {
			by := s.human()
			if who == "machine" {
				by = s.machine()
			}
			first := s.now
			var cards []Card
			for i := range 3 {
				cards = append(cards, s.make(by, time.Duration(10+15*i)*time.Minute, WhoEveryone))
			}
			_, err := s.svc.Make(s.ctx, by, Making{Kind: KindRace, Course: "buoy:triangle:short", Boat: s.jolly(), At: s.now.Add(time.Hour), Who: WhoEveryone})
			refused(t, err, RefuseOwned)
			// Cancelled, they make room among those owned but not in the day.
			for made := 3; made < 8; made++ {
				if _, err := s.svc.Cancel(s.ctx, by, cards[0].Code); err != nil {
					t.Fatal(err)
				}
				s.now = s.now.Add(time.Minute)
				cards = append(cards[1:], s.make(by, 70*time.Minute+time.Duration(made)*11*time.Minute, WhoEveryone))
			}
			if _, err := s.svc.Cancel(s.ctx, by, cards[0].Code); err != nil {
				t.Fatal(err)
			}
			_, err = s.svc.Make(s.ctx, by, Making{Kind: KindRace, Course: "island:3", Boat: string(s.cat.Boats[1].ID), At: s.now.Add(3 * time.Hour), Who: WhoEveryone})
			if r := refused(t, err, RefuseMade); !r.Until.Equal(first.Add(Day)) {
				t.Errorf("the next race may be made at %s, want a day after the first", r.Until)
			}
			b, err := s.svc.Board(s.ctx, by)
			if err != nil {
				t.Fatal(err)
			}
			if b.Make.Can.OK || b.Make.Can.Reason != RefuseMade {
				t.Errorf("the board says %+v", b.Make.Can)
			}
			// A day after the first, one more.
			s.now = first.Add(Day)
			s.make(by, 10*time.Minute, WhoEveryone)
		})
	}
}

// TestCutOff: a race may start up to the cut-off before the world's end,
// not a second after; nor in less than Lead; a trial opens only before it.
func TestCutOff(t *testing.T) {
	s := newSea(t)
	by := s.human()
	latest := s.ends.Add(-3 * time.Hour)
	_, err := s.svc.Make(s.ctx, by, Making{Kind: KindRace, Course: "buoy:windward-leeward:long", Boat: s.jolly(), At: latest.Add(time.Second), Who: WhoEveryone})
	if r := refused(t, err, RefuseLate); !r.Until.Equal(latest) {
		t.Errorf("latest %s, want %s", r.Until, latest)
	}
	_, err = s.svc.Make(s.ctx, by, Making{Kind: KindRace, Course: "buoy:triangle:short", Boat: s.jolly(), At: s.now.Add(Lead - time.Second), Who: WhoEveryone})
	refused(t, err, RefuseSoon)
	if c, err := s.svc.Make(s.ctx, by, Making{Kind: KindRace, Course: "buoy:windward-leeward:long", Boat: s.jolly(), At: latest, Who: WhoEveryone}); err != nil {
		t.Fatal(err)
	} else if c.Course.Name != "Long windward–leeward off Port Royal" || c.Minutes != LongMinutes || c.Phase != PhaseOpen {
		t.Errorf("the card %+v", c)
	}
	s.now = latest.Add(time.Minute)
	_, err = s.svc.Make(s.ctx, by, Making{Kind: KindTrial, Course: "buoy:triangle:short", Boat: s.jolly(), Who: WhoEveryone})
	refused(t, err, RefuseLate)
}

// TestMakingRefused: a course not offered, a tall ship on a buoy course,
// a machine sailor's race for humans, a name the filter refuses, and the
// racing areas all taken.
func TestMakingRefused(t *testing.T) {
	s := newSea(t)
	by, engine := s.human(), s.machine()
	var tall string
	for _, b := range s.cat.Boats {
		if b.LengthOverall > s.cat.World.Courses.Areas.Longest {
			tall = string(b.ID)
		}
	}
	for _, m := range []struct {
		by     Sailor
		making Making
		reason string
	}{
		{by, Making{Kind: KindRace, Course: "island:3", Boat: s.jolly(), Who: WhoEveryone}, RefuseCourse},
		{by, Making{Kind: KindRace, Course: "island:9", Boat: tall, Who: WhoEveryone}, RefuseCourse},
		{by, Making{Kind: KindRace, Course: "buoy:triangle:short", Boat: tall, Who: WhoEveryone}, RefuseCourse},
		{by, Making{Kind: KindRace, Course: "buoy:square:short", Boat: s.jolly(), Who: WhoEveryone}, RefuseCourse},
		{by, Making{Kind: KindRace, Course: "buoy:triangle:short", Boat: "no-boat", Who: WhoEveryone}, RefuseBoat},
		{engine, Making{Kind: KindRace, Course: "buoy:triangle:short", Boat: s.jolly(), Who: WhoHumans}, RefuseWho},
		{engine, Making{Kind: KindRace, Course: "buoy:triangle:short", Boat: s.jolly(), Who: WhoNewcomers}, RefuseWho},
		{by, Making{Kind: KindRace, Course: "buoy:triangle:short", Boat: s.jolly(), Who: WhoEveryone, Name: "x"}, RefuseName},
	} {
		m.making.At = s.now.Add(time.Hour)
		_, err := s.svc.Make(s.ctx, m.by, m.making)
		refused(t, err, m.reason)
	}
	// Two areas: two races at one time, a third refused, another ten
	// minutes on.
	other := s.human()
	s.make(by, time.Hour, WhoEveryone)
	s.make(other, time.Hour+time.Minute, WhoEveryone)
	_, err := s.svc.Make(s.ctx, s.human(), Making{Kind: KindRace, Course: "buoy:triangle:long", Boat: s.jolly(), At: s.now.Add(time.Hour), Who: WhoEveryone})
	refused(t, err, RefuseAreas)
	s.make(by, time.Hour+AreaApart, WhoEveryone)
	// A trial's area is laid at each run: never busy.
	if _, err := s.svc.Make(s.ctx, other, Making{Kind: KindTrial, Course: "buoy:triangle:short", Boat: s.jolly(), Who: WhoEveryone}); err != nil {
		t.Fatal(err)
	}
}

// TestEnteringLimits: two races entered ahead, eight started in a day,
// for a human and a machine sailor alike; crewing and a trial's runs not
// counted.
func TestEnteringLimits(t *testing.T) {
	s := newSea(t)
	for _, who := range []string{"human", "machine"} {
		t.Run(who, func(t *testing.T) {
			by := s.human()
			if who == "machine" {
				by = s.machine()
			}
			base := s.now
			var starts []time.Time
			for i := range 10 {
				starts = append(starts, base.Add(time.Duration(30+30*i)*time.Minute))
			}
			codes := s.harbour(s.jolly(), starts...)
			// Two ahead, the third waits for the sooner to start.
			for _, c := range codes[:2] {
				if _, err := s.svc.Enter(s.ctx, by, c, false); err != nil {
					t.Fatal(err)
				}
			}
			_, err := s.svc.Enter(s.ctx, by, codes[2], false)
			if r := refused(t, err, RefuseAhead); !r.Until.Equal(starts[0]) {
				t.Errorf("the third may be entered at %s, want %s", r.Until, starts[0])
			}
			card, err := s.svc.Card(s.ctx, by, codes[2])
			if err != nil {
				t.Fatal(err)
			}
			if card.Enter.OK || card.Enter.Reason != RefuseAhead || card.Enter.Until != starts[0].UnixMilli() {
				t.Errorf("the card says %+v", card.Enter)
			}
			// Entered again after withdrawing: the same number.
			if _, err := s.svc.Withdraw(s.ctx, by, codes[1]); err != nil {
				t.Fatal(err)
			}
			if c, err := s.svc.Enter(s.ctx, by, codes[1], true); err != nil {
				t.Fatal(err)
			} else if !c.Mine.Entered || !c.Mine.WithCrew || c.Mine.Number != 1 {
				t.Errorf("entered again: %+v", c.Mine)
			}
			_, err = s.svc.Enter(s.ctx, by, codes[1], false)
			refused(t, err, RefuseEntered)
			// Each a few minutes before its start: eight start, the ninth is
			// refused until a day after the first.
			for i := 2; i < 8; i++ {
				s.now = starts[i].Add(-5 * time.Minute)
				if _, err := s.svc.Enter(s.ctx, by, codes[i], false); err != nil {
					t.Fatalf("race %d: %v", i, err)
				}
			}
			s.now = starts[8].Add(-5 * time.Minute)
			_, err = s.svc.Enter(s.ctx, by, codes[8], false)
			if r := refused(t, err, RefuseDaily); !r.Until.Equal(starts[0].Add(Day)) {
				t.Errorf("the next may start at %s, want a day after the first", r.Until)
			}
			// A trial's runs are never counted.
			if trial, err := s.svc.Make(s.ctx, s.human(), Making{Kind: KindTrial, Course: "buoy:triangle:short", Boat: s.jolly(), Who: WhoEveryone}); err != nil {
				t.Fatal(err)
			} else if _, err := s.svc.Enter(s.ctx, by, trial.Code, false); err != nil {
				t.Errorf("a trial at the day's limit: %v", err)
			}
			s.now = base.Add(Day + time.Hour)
		})
	}
}

// TestEntryRefused: full, who may enter, newcomers, a block, a clash, and
// past the warning signal; and the owner's hand: closed, removed,
// cancelled, moved once.
func TestEntryRefused(t *testing.T) {
	s := newSea(t)
	owner := s.human()
	var tall string
	most := 0
	for _, b := range s.cat.Boats[1:] {
		if most == 0 || b.Racers < most {
			tall, most = string(b.ID), b.Racers
		}
	}
	full, err := s.svc.Make(s.ctx, owner, Making{Kind: KindRace, Course: "island:3", Boat: tall, At: s.now.Add(time.Hour), Who: WhoEveryone})
	if err != nil {
		t.Fatal(err)
	}
	for range most {
		if _, err := s.svc.Enter(s.ctx, s.human(), full.Code, false); err != nil {
			t.Fatal(err)
		}
	}
	_, err = s.svc.Enter(s.ctx, s.machine(), full.Code, false)
	refused(t, err, RefuseFull)

	humans := s.make(owner, 2*time.Hour, WhoHumans)
	_, err = s.svc.Enter(s.ctx, s.machine(), humans.Code, false)
	refused(t, err, RefuseHumans)
	machines := s.make(s.human(), 2*time.Hour+time.Minute, WhoMachines)
	_, err = s.svc.Enter(s.ctx, s.human(), machines.Code, false)
	refused(t, err, RefuseMachines)
	if _, err := s.svc.Enter(s.ctx, s.machine(), machines.Code, false); err != nil {
		t.Fatal(err)
	}

	greenhorns := s.make(s.human(), 3*time.Hour, WhoNewcomers)
	old, fresh := s.human(), s.machine()
	pool := storetest.PoolOn(t, s.url)
	for i := range Newcomer {
		if _, err := pool.Exec(s.ctx, `INSERT INTO race_record (account_id, source, world, at, code, race_name, kind, course_name, boat, role, how)
			VALUES ($1, $2, 1, now(), 'abcdefghij', 'A race', 'race', 'A course', 'a boat', 'skipper', 'finished')`,
			old.ID, fmt.Sprintf("test:%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	_, err = s.svc.Enter(s.ctx, old, greenhorns.Code, false)
	refused(t, err, RefuseNewcomers)
	if c, err := s.svc.Enter(s.ctx, fresh, greenhorns.Code, false); err != nil {
		t.Fatal(err)
	} else if !c.Entrants[0].Newcomer || !c.Entrants[0].Machine || c.Entrants[0].Name == nil {
		t.Errorf("a machine newcomer on the card: %+v", c.Entrants[0])
	}

	blocked := s.human()
	s.blocks[[2]store.AccountID{owner.ID, blocked.ID}] = true
	_, err = s.svc.Enter(s.ctx, blocked, humans.Code, false)
	refused(t, err, RefuseBlocked)

	// A boat sails one race at a time.
	near := s.make(s.human(), 2*time.Hour+10*time.Minute, WhoEveryone)
	sailor := s.human()
	if _, err := s.svc.Enter(s.ctx, sailor, humans.Code, false); err != nil {
		t.Fatal(err)
	}
	_, err = s.svc.Enter(s.ctx, sailor, near.Code, false)
	refused(t, err, RefuseClash)

	// The owner's hand: removed boats cannot come back; a start moved
	// once; closed; cancelled; nothing once the warning signal is made.
	if c, err := s.svc.Remove(s.ctx, owner, humans.Code, 1); err != nil {
		t.Fatal(err)
	} else if len(c.Entrants) != 0 {
		t.Errorf("entrants after the removal: %+v", c.Entrants)
	}
	_, err = s.svc.Enter(s.ctx, sailor, humans.Code, false)
	refused(t, err, RefuseBlocked)
	if _, err := s.svc.Remove(s.ctx, s.human(), humans.Code, 1); err != ErrNotOwner {
		t.Errorf("removed by another: %v", err)
	}
	if c, err := s.svc.Move(s.ctx, owner, humans.Code, s.now.Add(5*time.Hour)); err != nil {
		t.Fatal(err)
	} else if !c.Mine.Moved || c.StartsAt != s.now.Add(5*time.Hour).UnixMilli() {
		t.Errorf("moved: %+v", c)
	}
	_, err = s.svc.Move(s.ctx, owner, humans.Code, s.now.Add(6*time.Hour))
	refused(t, err, RefuseMoved)
	if c, err := s.svc.Close(s.ctx, owner, humans.Code); err != nil || c.Phase != PhaseClosed {
		t.Fatalf("closed: %v %v", c.Phase, err)
	}
	_, err = s.svc.Enter(s.ctx, s.human(), humans.Code, false)
	refused(t, err, RefuseClosed)
	if c, err := s.svc.Cancel(s.ctx, owner, humans.Code); err != nil || c.Phase != PhaseCancelled {
		t.Fatalf("cancelled: %v %v", c.Phase, err)
	}
	_, err = s.svc.Enter(s.ctx, s.human(), humans.Code, false)
	refused(t, err, RefuseCancelled)
	_, err = s.svc.Again(s.ctx, owner, humans.Code)
	refused(t, err, RefuseNotFinished)

	s.now = time.UnixMilli(machines.StartsAt).Add(-Warning)
	c, err := s.svc.Card(s.ctx, s.human(), machines.Code)
	if err != nil {
		t.Fatal(err)
	}
	if c.Phase != PhaseStarting {
		t.Errorf("at the warning signal the race is %s", c.Phase)
	}
	_, err = s.svc.Enter(s.ctx, s.machine(), machines.Code, false)
	refused(t, err, RefuseStarted)
	if _, err := s.svc.Card(s.ctx, owner, "nosuchrace"); err != ErrNotFound {
		t.Errorf("no such race: %v", err)
	}
}

// TestNamesOnTheCard: a machine sailor is named to everyone, with its
// mark; a human to a reader of their band whose log they may read; a teen
// to an adult is shown by boat and number instead.
func TestNamesOnTheCard(t *testing.T) {
	s := newSea(t)
	owner, adult, engine := s.human(), s.human(), s.machine()
	teen := s.born(int32(s.now.Year()-15)*100 + 1)
	c := s.make(owner, time.Hour, WhoEveryone)
	for _, by := range []Sailor{adult, engine, teen} {
		if _, err := s.svc.Enter(s.ctx, by, c.Code, false); err != nil {
			t.Fatal(err)
		}
	}
	card, err := s.svc.Card(s.ctx, owner, c.Code)
	if err != nil {
		t.Fatal(err)
	}
	if len(card.Entrants) != 3 || card.Entrants[0].Name == nil || card.Entrants[1].Name == nil || !card.Entrants[1].Machine ||
		card.Entrants[2].Name != nil || card.Entrants[2].Number != 3 {
		t.Errorf("the entrants as the owner reads them: %+v %+v %+v", card.Entrants[0], card.Entrants[1], card.Entrants[2])
	}
	if card.Owner == nil || card.Owner.Name == nil || !card.Mine.Owner {
		t.Errorf("the owner: %+v", card.Owner)
	}
	if card.Link != "https://play.example/?r="+c.Code {
		t.Errorf("link %s", card.Link)
	}
	mine, err := s.svc.Card(s.ctx, teen, c.Code)
	if err != nil {
		t.Fatal(err)
	}
	if !mine.Entrants[2].Me || mine.Entrants[2].Name == nil || mine.Entrants[0].Name != nil {
		t.Errorf("the entrants as the teen reads them: %+v", mine.Entrants)
	}
	file, name, err := s.svc.Calendar(s.ctx, owner, c.Code)
	if err != nil || len(file) == 0 || name == "" {
		t.Errorf("the calendar file %q: %v", name, err)
	}
}

// TestHarbourJob: the harbour races of the hours ahead made once, each
// named for its hour or the Greenhorn Cup, the week's newcomers' hours
// set once; the board lists the next three.
func TestHarbourJob(t *testing.T) {
	s := newSea(t)
	lease := s.lease
	made, _, err := s.svc.Harbour(s.ctx, lease, s.now)
	if err != nil {
		t.Fatal(err)
	}
	if made != 3 {
		t.Errorf("%d harbour races made for nine hours of every three", made)
	}
	again, _, err := s.svc.Harbour(s.ctx, lease, s.now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if again != 0 {
		t.Errorf("%d made again", again)
	}
	days, err := s.db.HarbourDays(s.ctx, s.world.ID)
	if err != nil || len(days) == 0 {
		t.Fatalf("the newcomers' days: %v %v", days, err)
	}
	if _, _, err := s.svc.Harbour(s.ctx, lease, s.now.Add(3*time.Hour)); err != nil {
		t.Fatal(err)
	}
	b, err := s.svc.Board(s.ctx, s.human())
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Harbour) != 3 || len(b.Greenhorn) != len(days) {
		t.Fatalf("the board: %d harbour races, %d newcomers' races", len(b.Harbour), len(b.Greenhorn))
	}
	for _, h := range b.Harbour {
		if !h.Harbour || h.Most == 0 || !h.Enter.OK || h.Phase != PhaseOpen {
			t.Errorf("a harbour race on the board: %+v", h)
		}
		if h.Who == WhoNewcomers && h.Name != Greenhorn {
			t.Errorf("the newcomers' race named %q", h.Name)
		}
	}
	if len(b.Make.Courses) != 5 || !b.Make.Can.OK {
		t.Errorf("make: %d courses, %+v", len(b.Make.Courses), b.Make.Can)
	}
}
