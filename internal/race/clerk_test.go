// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"errors"
	"math"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// course is a sea's world to race in: the catalog's boats, ticking from
// the sea's now, with its racing areas laid out off its centre.
type course struct {
	*sea
	w     *sim.World
	epoch time.Time
	clerk *Clerk
}

func newCourse(s *sea) *course {
	s.t.Helper()
	const first = 3_000_000
	c := &course{sea: s, epoch: s.now.Add(-first * time.Second / physics.StepsPerSecond)}
	c.w = c.newWorld(first)
	c.clerk = c.newClerk()
	return c
}

// newWorld is a world of the catalog's boats from tick, with two racing
// areas.
func (c *course) newWorld(tick int64) *sim.World {
	s := c.sea
	_, kinds := s.cat.Prepare()
	st := &committee.Stage{Areas: []committee.Area{{Number: 1, Radius: 450}, {Number: 2, X: 2000, Radius: 450}}}
	for i := range s.cat.Boats {
		st.Kinds = append(st.Kinds, committee.Kind{Polar: s.cat.Polar(i), Length: s.cat.Boats[i].LengthOverall})
	}
	w, err := sim.New(sim.Config{Capacity: 16, Kinds: kinds, Workers: 1, Tick: tick, Capacities: s.cat.Capacities(), Races: st})
	if err != nil {
		s.t.Fatal(err)
	}
	s.t.Cleanup(w.Close)
	return w
}

// newClerk is a clerk of the course's world.
func (c *course) newClerk() *Clerk {
	return c.svc.Clerk(ClerkConfig{Bus: c.w.Bus(), Lease: c.lease,
		TickAt: func(t time.Time) int64 { return loop.TickAt(t, c.epoch) },
		TimeOf: func(tick int64) time.Time { return loop.TimeOf(tick, c.epoch) },
		Rules:  rulesOf(c.sea)})
}

// rulesOf are the news's rules of the sea's catalog.
func rulesOf(s *sea) store.NewsRules {
	r := store.NewsRules{Zone: "UTC"}
	for _, c := range s.cat.News.Columns {
		if c.Of == catalog.OfCharting && r.Column == "" {
			r.Column = string(c.ID)
		}
	}
	return r
}

// tick ticks the world n times, its clock the sea's, with commands sent
// before each tick.
func (c *course) tick(n int, before func()) {
	for range n {
		if before != nil {
			before()
		}
		c.w.Tick()
	}
	c.now = loop.TimeOf(c.w.Now(), c.epoch)
}

// skipTo moves the world on to the tick before t, at once.
func (c *course) skipTo(t time.Time) {
	if n := loop.TickAt(t, c.epoch) - c.w.Now() - 1; n > 0 {
		c.w.Skip(n)
	}
	c.tick(1, nil)
}

// once has the clerk do its work, or fails the test.
func (c *course) once() {
	c.t.Helper()
	if err := c.clerk.Once(c.ctx); err != nil {
		c.t.Fatal(err)
	}
}

// route is a boat's way round course rc: over the start line, round the
// outside of each mark to port, through each gate, and over the finish.
func route(rc *bus.RaceCourse) [][2]float64 {
	us, uc := physics.SinCos(rc.From)
	var out [][2]float64
	for k, ch := range rc.Checks {
		switch {
		case k == 0:
			out = append(out, [2]float64{ch.AtX + 10*us, ch.AtY + 10*uc})
		case ch.Line:
			out = append(out, [2]float64{ch.AtX + 5*us, ch.AtY + 5*uc}, [2]float64{ch.AtX - 15*us, ch.AtY - 15*uc})
		default:
			rx, ry := ch.C, -ch.S
			out = append(out,
				[2]float64{ch.X + 15*rx - 5*ch.S, ch.Y + 15*ry - 5*ch.C},
				[2]float64{ch.X + 15*rx + 15*ch.S, ch.Y + 15*ry + 15*ch.C},
				[2]float64{ch.X - 15*rx + 15*ch.S, ch.Y - 15*ry + 15*ch.C},
				[2]float64{ch.X - 15*rx - 5*ch.S, ch.Y - 15*ry - 5*ch.C})
		}
	}
	return append(out, [2]float64{out[len(out)-1][0] - 20*us, out[len(out)-1][1] - 20*uc})
}

// A race of three boats, made, entered, handed to the committee at its
// warning signal, sailed by scripted boats from the gun to the finish, and
// written: its boats started, everyone's result and track, the records,
// the story of the win, the race finished; and the committee lets it go.
func TestARaceFromMakingToResults(t *testing.T) {
	raceOfThree(t, 0)
}

// A race whose world restarts from its checkpoint half way round, a new
// clerk with it, as a new process: the race runs on and is written once,
// whole. (That the restored world runs the race as the first would have,
// tick for tick, the simulation's own test shows.)
func TestARaceRestarted(t *testing.T) {
	raceOfThree(t, 40)
}

// raceOfThree races three boats, the world restarted from a checkpoint
// after restart seconds of sailing (0 never).
func raceOfThree(t *testing.T, restart int) {
	s := newSea(t)
	c := newCourse(s)
	owner := s.human()
	card := s.make(owner, 10*time.Minute, WhoEveryone)
	sailors := []Sailor{s.human(), s.human(), s.human()}
	for i, sl := range sailors {
		if _, err := s.svc.Enter(s.ctx, sl, card.Code, false); err != nil {
			t.Fatal(err)
		}
		do := make(chan bus.Reply, 1)
		if err := c.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Join, Account: bus.Account(sl.ID), Conn: uint64(i + 1), Reply: do}); err != nil {
			t.Fatal(err)
		}
		c.tick(1, nil)
	}
	start := time.UnixMilli(card.StartsAt).UTC()
	// Nothing before the warning signal.
	c.once()
	c.tick(1, nil)
	if len(c.w.Latest().Races) != 0 {
		t.Fatal("a race handed to the committee before its warning")
	}
	c.skipTo(start.Add(-Warning))
	c.once()
	c.tick(1, nil)
	f := c.w.Latest()
	if len(f.Races) != 1 || len(f.Racers) != 3 {
		t.Fatalf("%d races of %d boats under way", len(f.Races), len(f.Racers))
	}
	c.once()
	r, err := s.db.RaceByCode(s.ctx, card.Code)
	if err != nil || r.State != store.RaceRacing {
		t.Fatalf("the race is %q: %v", r.State, err)
	}
	// Each boat sails the course, the first entered fastest, from the gun.
	rc := f.Races[0].Course
	slots := map[bus.Account]int32{}
	for _, s := range f.Live {
		slots[f.Owner[s]] = s
	}
	gun := f.Races[0].Start
	type boat struct {
		slot  int32
		way   [][2]float64
		at    int
		speed float64
		st    physics.State
	}
	var boats []*boat
	for i, sl := range sailors {
		s := slots[bus.Account(sl.ID)]
		boats = append(boats, &boat{slot: s, way: route(rc), speed: 9 - float64(i), st: f.State[s]})
	}
	dev := c.w.Bus().Commands.Developer()
	sail := func() {
		if c.w.Now()+1 < gun {
			return
		}
		for _, b := range boats {
			if b.at >= len(b.way) {
				continue
			}
			p := b.way[b.at]
			dx, dy := p[0]-b.st.X, p[1]-b.st.Y
			d := math.Hypot(dx, dy)
			step := b.speed / physics.StepsPerSecond
			if d <= step {
				b.st.X, b.st.Y = p[0], p[1]
				b.at++
			} else {
				b.st.X, b.st.Y = b.st.X+dx/d*step, b.st.Y+dy/d*step
			}
			b.st.Heading, b.st.Surge = math.Atan2(dx, dy), 0
			if err := dev.TrySend(bus.Command{Op: bus.Place, Boat: c.w.Latest().Boat[b.slot], State: b.st}); err != nil {
				t.Fatal(err)
			}
		}
	}
	for i := range 40000 {
		c.tick(30, sail)
		c.once()
		if f := c.w.Latest(); len(f.Races) == 0 {
			break
		}
		if i+1 == restart {
			c.restart()
			dev = c.w.Bus().Commands.Developer()
		}
	}
	if f := c.w.Latest(); len(f.Races) != 0 {
		t.Fatalf("the race not let go: phase %d", f.Races[0].Phase)
	}
	r, _ = s.db.RaceByCode(s.ctx, card.Code)
	if r.State != store.RaceFinished {
		t.Errorf("the race is %q", r.State)
	}
	results, err := s.db.RaceResults(s.ctx, s.world.ID, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 {
		t.Fatalf("%d results", len(results))
	}
	for i, x := range results {
		if x.Account != sailors[i].ID || x.Place != i+1 || x.How != store.HowFinished || len(x.Track) < 100 || !(x.Elapsed > 60) {
			t.Errorf("result %d: place %d, %s, %.1f s, a track of %d bytes", i, x.Place, x.How, x.Elapsed, len(x.Track))
		}
	}
	if aw := results[2].Awards; len(aw) != 1 || aw[0] != "spoon" {
		t.Errorf("the last boat's awards: %v", aw)
	}
	records := 0
	for _, sl := range append(sailors, owner) {
		recs, err := s.db.RaceRecordsOf(s.ctx, sl.ID, 10)
		if err != nil {
			t.Fatal(err)
		}
		for _, rec := range recs {
			if rec.Code == card.Code && (rec.Role == store.RoleSkipper && sl != owner || rec.Role == store.RoleOwner && sl == owner) {
				records++
			}
		}
	}
	day := s.now.UTC().Truncate(24 * time.Hour)
	stories, err := s.db.DayStories(s.ctx, s.world.ID, day)
	if err != nil {
		t.Fatal(err)
	}
	won := 0
	for _, st := range stories {
		if st.Story == store.StoryRace && st.Account == sailors[0].ID {
			won++
		}
	}
	if records != 4 || won != 1 {
		t.Errorf("%d records of the three skippers and the owner, %d stories of the win", records, won)
	}
	if c, err := s.db.RaceCountsOf(s.ctx, sailors[2].ID); err != nil || c.Sailed != 1 || c.Top3 != 1 || c.Spoons != 1 || c.Ran != 0 {
		t.Errorf("the last boat's counts: %+v, %v", c, err)
	}
	if c, err := s.db.RaceCountsOf(s.ctx, owner.ID); err != nil || c.Sailed != 0 || c.Ran != 1 {
		t.Errorf("the owner's counts: %+v, %v", c, err)
	}
	// The ribbons: the races sailed, by the page; the owner's run not one.
	if rbs, err := s.db.RaceRibbonsOf(s.ctx, sailors[2].ID, 0, 5); err != nil || len(rbs) != 1 || rbs[0].Code != card.Code {
		t.Errorf("the last boat's ribbons: %+v, %v", rbs, err)
	}
	if rbs, err := s.db.RaceRibbonsOf(s.ctx, sailors[2].ID, 1, 5); err != nil || len(rbs) != 0 {
		t.Errorf("the last boat's ribbons past the first: %+v, %v", rbs, err)
	}
	if rbs, err := s.db.RaceRibbonsOf(s.ctx, owner.ID, 0, 5); err != nil || len(rbs) != 0 {
		t.Errorf("the owner's ribbons: %+v, %v", rbs, err)
	}
	// The spoon hung by the last boat's skipper alone, and taken down.
	if err := s.svc.Spoon(s.ctx, sailors[0], card.Code, true); !errors.Is(err, ErrNotFound) {
		t.Errorf("the winner hangs a spoon: %v", err)
	}
	for _, hang := range []bool{true, false} {
		if err := s.svc.Spoon(s.ctx, sailors[2], card.Code, hang); err != nil {
			t.Fatal(err)
		}
		if n, err := s.db.SpoonsHung(s.ctx, sailors[2].ID, s.world.Number); err != nil || n != map[bool]int{true: 1}[hang] {
			t.Errorf("hung %v: %d spoons, %v", hang, n, err)
		}
	}
	// Written again, nothing changes.
	if err := s.db.EndRace(s.ctx, s.lease, rulesOf(s), &store.RaceEnd{World: s.world.ID, Race: r.ID,
		At: s.now}); err != nil {
		t.Fatal(err)
	}
}

// restart restarts the course's world from a checkpoint of it, with a
// clerk of its own, as a new process would.
func (c *course) restart() {
	c.t.Helper()
	cp := sim.AppendCheckpoint(nil, c.w.Latest())
	old := c.w
	c.w = c.newWorld(old.Now())
	if err := c.w.Load(cp); err != nil {
		c.t.Fatal(err)
	}
	old.Close()
	c.clerk = c.newClerk()
}

// A time trial's run: asked for by entering, handed to the committee at
// once, timed from its crossing of the line, written with its medal as a
// run of its own; entering again asks for the next.
func TestATrialsRun(t *testing.T) {
	s := newSea(t)
	c := newCourse(s)
	sl := s.human()
	card, err := s.svc.Make(s.ctx, s.human(), Making{Kind: KindTrial, Course: "buoy:windward-leeward:short", Boat: s.jolly(), Who: WhoEveryone})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Join, Account: bus.Account(sl.ID), Conn: 1}); err != nil {
		t.Fatal(err)
	}
	c.tick(1, nil)
	if _, err := s.svc.Enter(s.ctx, sl, card.Code, false); err != nil {
		t.Fatal(err)
	}
	c.once()
	c.tick(1, nil)
	f := c.w.Latest()
	if len(f.Races) != 1 || !f.Races[0].Trial || f.Races[0].Run != 1 {
		t.Fatalf("the run handed: %+v", f.Races)
	}
	c.once()
	// Round the course at twice the speed its par asks: the harbourmaster's
	// time.
	rc := f.Races[0].Course
	way := route(rc)
	slot := f.Live[0]
	st := f.State[slot]
	at := 0
	speed := 2 * rc.Length / rc.Expected
	dev := c.w.Bus().Commands.Developer()
	sail := func() {
		if at >= len(way) {
			return
		}
		p := way[at]
		dx, dy := p[0]-st.X, p[1]-st.Y
		d := math.Hypot(dx, dy)
		if step := speed / physics.StepsPerSecond; d <= step {
			st.X, st.Y = p[0], p[1]
			at++
		} else {
			st.X, st.Y = st.X+dx/d*step, st.Y+dy/d*step
		}
		_ = dev.TrySend(bus.Command{Op: bus.Place, Boat: c.w.Latest().Boat[slot], State: st})
	}
	for range 10000 {
		c.tick(30, sail)
		c.once()
		if len(c.w.Latest().Races) == 0 {
			break
		}
	}
	res, err := s.db.RaceResults(s.ctx, s.world.ID, card2ID(t, s, card.Code))
	if err != nil || len(res) != 1 {
		t.Fatalf("the run's results %+v: %v", res, err)
	}
	if res[0].Run != 1 || res[0].Medal != "harbourmaster" || res[0].Place != 1 {
		t.Errorf("run %d, medal %q, place %d", res[0].Run, res[0].Medal, res[0].Place)
	}
	runs, err := s.db.PendingRuns(s.ctx, s.world.ID)
	if err != nil || len(runs) != 0 {
		t.Fatalf("runs asked for after the run: %+v %v", runs, err)
	}
	if _, err := s.svc.Enter(s.ctx, sl, card.Code, false); err != nil {
		t.Fatal(err)
	}
	if runs, err = s.db.PendingRuns(s.ctx, s.world.ID); err != nil || len(runs) != 1 || runs[0].Run != 2 {
		t.Errorf("runs asked for: %+v %v", runs, err)
	}
}

// card2ID is the ID of the race of a code.
func card2ID(t *testing.T, s *sea, code string) [16]byte {
	t.Helper()
	r, err := s.db.RaceByCode(s.ctx, code)
	if err != nil {
		t.Fatal(err)
	}
	return r.ID
}
