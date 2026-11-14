// SPDX-License-Identifier: AGPL-3.0-only

package committee

import (
	"bytes"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// until ticks w, moving its boats, until done says so or the race ends,
// gathering the events of the kinds asked.
func (w *world) until(move func(s int, st *physics.State), done func() bool, kinds ...uint8) []bus.RaceEvent {
	var out []bus.RaceEvent
	for range 200000 {
		if done() || len(w.cur.Races) > 0 && w.cur.Races[0].Phase == bus.RaceEnded {
			return out
		}
		w.tick(move)
		for _, e := range w.cur.RaceEvents {
			if e.Tick == w.cur.Tick && slices.Contains(kinds, e.Kind) {
				out = append(out, e)
			}
		}
	}
	w.t.Fatal("the race never ended")
	return nil
}

// racer is boat number n of the first race.
func (w *world) racer(n int16) *bus.Racer {
	for i := range w.cur.Racers {
		if w.cur.Racers[i].Number == n {
			return &w.cur.Racers[i]
		}
	}
	w.t.Fatalf("no boat %d", n)
	return nil
}

func TestOverEarlyAddsTenSeconds(t *testing.T) {
	s := stage(t)
	w := newWorld(t, 3)
	c := w.begin(s, &bus.RaceCall{ID: [16]byte{1}, Course: 1, Entrants: entrants(3)})
	start := w.cur.Races[0].Start
	mid := c.Checks[0]
	// Boat 1 creeps over the line in the last seconds.
	got := w.until(func(sl int, st *physics.State) {
		if sl == 0 {
			toward(st, (mid.X+mid.X2)/2, (mid.Y+mid.Y2)/2+20, 3)
		}
	}, func() bool { return w.cur.Tick > start }, bus.RaceOverEarly, bus.RaceSignalled)
	var over, recall int
	for _, e := range got {
		if e.Kind == bus.RaceOverEarly {
			over++
			if e.Number != 1 || e.Added != 10 {
				t.Errorf("over early: %+v", e)
			}
		}
		if e.Kind == bus.RaceSignalled && e.Signal == bus.SignalRecall {
			recall++
		}
	}
	if over != 1 || recall != 1 {
		t.Errorf("%d over early and %d recalls", over, recall)
	}
	if r := w.racer(1); !r.Over || r.Added != Penalty || r.Next != 1 {
		t.Errorf("boat 1 over early: %+v", r)
	}
	if r := w.racer(2); r.Over || r.Added != 0 || r.Next != 0 {
		t.Errorf("boat 2 behind the line: %+v", r)
	}
}

func TestABumpIsCalled(t *testing.T) {
	s := stage(t)
	w := newWorld(t, 3)
	w.begin(s, &bus.RaceCall{ID: [16]byte{2}, Course: 1, Entrants: entrants(2)})
	r := w.cur.Races[0]
	bump := func(a, b int32, fault uint8) bus.Bump {
		return bus.Bump{A: a, B: b, BoatA: uint64(a + 1), BoatB: uint64(b + 1), Fault: fault, Article: physics.Article10}
	}
	// Before the preparatory signal: no call.
	w.tick(nil, bump(0, 1, physics.First))
	if got := events(w.cur, bus.RaceCalled); len(got) != 0 {
		t.Fatalf("a call before the preparatory: %+v", got)
	}
	for w.cur.Tick < r.Start-Preparatory {
		w.tick(nil)
	}
	// From it: the boat at fault has 10 s added; a passer-by is no one's
	// business, nor a bump with no fault.
	w.tick(nil, bump(0, 1, physics.Second), bump(0, 2, physics.First), bump(0, 1, physics.Neither))
	got := events(w.cur, bus.RaceCalled)
	if len(got) != 1 || got[0].Number != 2 || got[0].Other != 1 || got[0].Article != physics.Article10 || got[0].Added != 10 {
		t.Fatalf("calls %+v", got)
	}
	if w.racer(2).Added != Penalty || w.racer(1).Added != 0 {
		t.Errorf("added %d and %d", w.racer(1).Added, w.racer(2).Added)
	}
}

func TestAMissedMark(t *testing.T) {
	s := stage(t)
	w := newWorld(t, 1)
	c := w.begin(s, &bus.RaceCall{ID: [16]byte{3}, Course: 1, Entrants: entrants(1)})
	start := w.cur.Races[0].Start
	mark := c.Checks[1]
	line := c.Checks[0]
	// Up three quarters of the way to the mark, then back over the line.
	b := &sailor{speed: 8, hold: true, way: [][2]float64{
		{line.AtX, line.AtY + 10},
		{line.AtX + 0.75*(mark.X-line.AtX), line.AtY + 0.75*(mark.Y-line.AtY)},
		{line.AtX, line.AtY - 20},
	}}
	got := w.until(func(_ int, st *physics.State) {
		b.hold = w.nxt.Tick < start
		b.move(st)
	}, func() bool { return b.at >= len(b.way) }, bus.RaceMissed, bus.RaceFinished)
	if len(got) != 1 || got[0].Kind != bus.RaceMissed || got[0].Mark != 1 {
		t.Fatalf("events %+v: want mark 1 missed, and no finish", got)
	}
	// It goes back for it, and finishes.
	b.way, b.at = route(c)[1:], 0
	got = w.until(func(_ int, st *physics.State) { b.move(st) }, func() bool { return false }, bus.RaceFinished)
	if len(got) != 1 || w.racer(1).Place != 1 {
		t.Errorf("events %+v; boat 1 in place %d", got, w.racer(1).Place)
	}
}

func TestTheWindowPlacesTheRestByProgress(t *testing.T) {
	defer func(a int64) { DriftAfter = a }(DriftAfter)
	DriftAfter = 1 << 40
	s := stage(t)
	w := newWorld(t, 3)
	c := w.begin(s, &bus.RaceCall{ID: [16]byte{4}, Course: 1, Entrants: entrants(3)})
	start := w.cur.Races[0].Start
	// Boat 1 sails the course fast; boat 2 gets half way up the first
	// leg; boat 3 stays on the line.
	mark := c.Checks[1]
	line := c.Checks[0]
	boats := []*sailor{
		{speed: 20, way: route(c)},
		{speed: 3, way: [][2]float64{{line.AtX, line.AtY + 10}, {(line.AtX + mark.X) / 2, (line.AtY + mark.Y) / 2}}},
		{speed: 3},
	}
	var home int64
	got := w.until(func(sl int, st *physics.State) {
		boats[sl].hold = w.nxt.Tick < start
		boats[sl].move(st)
	}, func() bool { return false }, bus.RaceFinished, bus.RaceOver)
	for _, e := range got {
		if e.Kind == bus.RaceFinished {
			home = e.Tick
		}
	}
	r := w.cur.Races[0]
	want := home + max((home-start)/2, Window)
	if r.Ended != want || home == 0 {
		t.Errorf("ended at %d, boat 1 home at %d, want %d", r.Ended, home, want)
	}
	for n, place := range map[int16]int16{1: 1, 2: 2, 3: 3} {
		rc := w.racer(n)
		if rc.Place != place {
			t.Errorf("boat %d in place %d, want %d", n, rc.Place, place)
		}
	}
	if s := w.racer(2).State; s != bus.RacerPlacedAtEnd {
		t.Errorf("boat 2 in state %d, want placed by its progress", s)
	}
	if !(w.racer(2).ToGo < w.racer(3).ToGo) {
		t.Errorf("boat 2 has %.0f m to go, boat 3 %.0f", w.racer(2).ToGo, w.racer(3).ToGo)
	}
}

func TestTheTimeLimit(t *testing.T) {
	defer func(a int64) { DriftAfter = a }(DriftAfter)
	DriftAfter = 1 << 40
	s := stage(t)
	w := newWorld(t, 2)
	c := w.begin(s, &bus.RaceCall{ID: [16]byte{5}, Course: 1, Entrants: entrants(2)})
	start := w.cur.Races[0].Start
	w.until(nil, func() bool { return false })
	if r := w.cur.Races[0]; r.Ended != start+limit(&r) || limit(&r) != int64(2*c.Expected*Second)+1 && limit(&r) != int64(2*c.Expected*Second) {
		t.Errorf("ended at %d: start %d, expected %.0f s", r.Ended, start, c.Expected)
	}
	if w.racer(1).Place != 1 || w.racer(2).Place != 2 {
		t.Error("everyone not placed at the time limit")
	}
}

func TestDriftingRetires(t *testing.T) {
	defer func(a, b int64) { DriftAfter, DriftAnswer = a, b }(DriftAfter, DriftAnswer)
	DriftAfter, DriftAnswer = 20*Second, 10*Second
	s := stage(t)
	w := newWorld(t, 1)
	w.begin(s, &bus.RaceCall{ID: [16]byte{6}, Course: 1, Entrants: entrants(1)})
	got := w.until(nil, func() bool { return false }, bus.RaceDrifting, bus.RaceRetired)
	if len(got) != 2 || got[0].Kind != bus.RaceDrifting || got[1].Kind != bus.RaceRetired || got[1].Tick-got[0].Tick != DriftAnswer {
		t.Errorf("events %+v", got)
	}
	if rc := w.racer(1); rc.State != bus.RacerRetired || rc.Place != 0 {
		t.Errorf("a drifting boat: %+v", rc)
	}
}

func TestRetiringAndLeaving(t *testing.T) {
	s := stage(t)
	w := newWorld(t, 3)
	w.begin(s, &bus.RaceCall{ID: [16]byte{8}, Course: 1, Entrants: entrants(3)})
	if !Retire(w.cur, bus.Account{2}) || Retire(w.cur, bus.Account{9}) {
		t.Fatal("retiring at the skipper's word")
	}
	// Boat 3's boat leaves the water.
	w.cur.Occupied[2] = false
	w.tick(nil)
	if w.racer(2).State != bus.RacerRetired || w.racer(3).State != bus.RacerRetired || w.racer(1).State != bus.RacerPlaced {
		t.Errorf("states %d %d %d", w.racer(1).State, w.racer(2).State, w.racer(3).State)
	}
}

func TestATrialsMedal(t *testing.T) {
	s := stage(t)
	w := newWorld(t, 1)
	c := w.begin(s, &bus.RaceCall{ID: [16]byte{9}, Run: 1, Trial: true, Entrants: entrants(1)})
	if r := w.cur.Races[0]; r.Start != 0 || len(events(w.cur, bus.RaceSignalled)) != 0 {
		t.Fatalf("a trial with a start %d before its crossing, or a gun", r.Start)
	}
	b := &sailor{speed: 3 * c.Length / c.Expected, way: route(c)}
	w.until(func(_ int, st *physics.State) { b.move(st) }, func() bool { return false })
	rc := w.racer(1)
	if rc.State != bus.RacerFinished || rc.Place != 1 || rc.Medal != bus.MedalHarbourmaster {
		t.Errorf("a run at three times the expected speed: %+v", rc)
	}
	if r := w.cur.Races[0]; r.Start != rc.Crossed || r.Start == 0 {
		t.Errorf("the trial's clock from %d, its crossing at %d", r.Start, rc.Crossed)
	}
	for _, m := range []struct {
		secs float64
		want uint8
	}{{89, bus.MedalHarbourmaster}, {100, bus.MedalGold}, {119, bus.MedalSilver}, {150, bus.MedalBronze}, {151, 0}} {
		if got := Medal(m.secs, 100); got != m.want {
			t.Errorf("%.0f s against a par of 100: medal %d, want %d", m.secs, got, m.want)
		}
	}
}

func TestAnIslandCourse(t *testing.T) {
	s := stage(t)
	ic := &s.Courses[0]
	for i := range ic.Rays {
		ic.Rays[i].Crossings = -1
	}
	ic.Rays[0].Along, ic.Rays[1].Along, ic.Rays[2].Along, ic.Rays[3].Along = 1062, 1662, 2262, 2862
	w := newWorld(t, 1)
	c := w.begin(s, &bus.RaceCall{ID: [16]byte{10}, Island: true, Course: 3, Entrants: entrants(1)})
	start := w.cur.Races[0].Start
	// Round the island, across its south ray below it, and over the
	// finish.
	b := &sailor{speed: 10, way: append([][2]float64{{c.Way[0][0], c.Way[0][1] + 20}}, c.Way[1:len(c.Way)-1]...)}
	b.way = append(b.way, [2]float64{20, -900}, [2]float64{5, -1040})
	got := w.until(func(_ int, st *physics.State) {
		b.hold = w.nxt.Tick < start
		b.move(st)
	}, func() bool { return false }, bus.RaceRounded, bus.RaceFinished)
	if len(got) != 5 || got[4].Kind != bus.RaceFinished {
		t.Errorf("events %+v: want four rays passed and the finish", got)
	}
	// The wrong way round: the rays crossed clockwise are not passed.
	w = newWorld(t, 1)
	c = w.begin(s, &bus.RaceCall{ID: [16]byte{11}, Island: true, Course: 3, Entrants: entrants(1)})
	start = w.cur.Races[0].Start
	rev := slices.Clone(c.Way)
	slices.Reverse(rev)
	b = &sailor{speed: 10, way: append([][2]float64{{c.Way[0][0], c.Way[0][1] + 20}}, rev[1:]...)}
	got = w.until(func(_ int, st *physics.State) {
		b.hold = w.nxt.Tick < start
		b.move(st)
	}, func() bool { return b.at >= len(b.way) }, bus.RaceRounded, bus.RaceFinished)
	if len(got) != 0 {
		t.Errorf("events %+v round the island the wrong way", got)
	}
}

// ended is a frame of one race of four boats, each its own account,
// finished or placed as given, ended.
func ended(racers []bus.Racer, prizes bool) *bus.Frame {
	f := bus.NewFrame(8)
	f.Tick = 100000
	c := &bus.RaceCourse{Checks: make([]bus.RaceCheck, 3), Way: [][2]float64{{0, 0}, {0, 1}}, Length: 1000, Expected: 600}
	f.Races = []bus.Race{{Key: 1, Course: c, Warning: 1000, Start: 1000 + Warning, Phase: bus.RaceStarted, Prizes: prizes}}
	f.NextRace = 2
	for i := range racers {
		rc := &racers[i]
		rc.Race, rc.Number, rc.Account = 1, int16(i+1), bus.Account{byte(i + 1)}
	}
	f.Racers = racers
	end(f, 0)
	return f
}

func TestEveryAward(t *testing.T) {
	start := int64(1000 + Warning)
	home := func(s int64) int64 { return start + s*Second }
	f := ended([]bus.Racer{
		// Home first, after a poor first mark: the biggest comeback.
		{State: bus.RacerFinished, Home: home(600), Crossed: start + 9*Second, First: 4},
		// The best start, home second.
		{State: bus.RacerFinished, Home: home(650), Crossed: start + 2*Second, First: 1},
		// Home a second behind: a photo finish with the next.
		{State: bus.RacerFinished, Home: home(700), Crossed: start + 5*Second, First: 2},
		{State: bus.RacerFinished, Home: home(701), Crossed: start + 6*Second, First: 3, Cheers: 9},
		// Last, still racing: the spoon.
		{State: bus.RacerRacing, Next: 1, ToGo: 400, Crossed: start + 7*Second, First: 5},
		// Retired: nothing.
		{State: bus.RacerRetired},
	}, true)
	want := []uint8{0, bus.AwardBestStart, bus.AwardPhoto, bus.AwardPhoto, bus.AwardSpoon, 0}
	for i, rc := range f.Racers {
		if rc.Awards != want[i] {
			t.Errorf("boat %d's awards %b, want %b", rc.Number, rc.Awards, want[i])
		}
	}
	// With no photo finish, the comeback and then the crowd come in.
	f = ended([]bus.Racer{
		{State: bus.RacerFinished, Home: home(600), Crossed: start + 9*Second, First: 4},
		{State: bus.RacerFinished, Home: home(650), Crossed: start + 2*Second, First: 1},
		{State: bus.RacerFinished, Home: home(700), Crossed: start + 5*Second, First: 2, Cheers: 9},
		{State: bus.RacerFinished, Home: home(720), Crossed: start + 6*Second, First: 3},
	}, true)
	want = []uint8{bus.AwardComeback, bus.AwardBestStart, 0, bus.AwardSpoon}
	for i, rc := range f.Racers {
		if rc.Awards != want[i] {
			t.Errorf("no photo: boat %d's awards %b, want %b", rc.Number, rc.Awards, want[i])
		}
	}
	f = ended([]bus.Racer{
		{State: bus.RacerFinished, Home: home(600), Crossed: start + 9*Second, First: 1},
		{State: bus.RacerFinished, Home: home(650), Crossed: start + 2*Second, First: 2},
		{State: bus.RacerFinished, Home: home(700), Crossed: start + 5*Second, First: 3, Cheers: 9},
		{State: bus.RacerFinished, Home: home(720), Crossed: start + 6*Second, First: 4},
	}, true)
	if got := f.Racers[2].Awards; got != bus.AwardCrowd {
		t.Errorf("the most cheered's awards %b", got)
	}
	if n := len(Awards(bus.AwardSpoon | bus.AwardCrowd)); n != 2 {
		t.Errorf("%d award names", n)
	}
}

func TestPrizesNeedThreeAccounts(t *testing.T) {
	s := stage(t)
	w := newWorld(t, 3)
	// Three boats, two accounts: boat 3's skipper is boat 1's.
	w.cur.Owner[2] = bus.Account{1}
	e := entrants(3)
	e[2].Account = bus.Account{1}
	w.begin(s, &bus.RaceCall{ID: [16]byte{12}, Course: 1, Entrants: e})
	if w.cur.Races[0].Prizes {
		t.Error("prizes for a race of two accounts")
	}
	w = newWorld(t, 3)
	w.begin(s, &bus.RaceCall{ID: [16]byte{13}, Course: 1, Entrants: entrants(3)})
	if !w.cur.Races[0].Prizes {
		t.Error("no prizes for a race of three accounts")
	}
	f := ended([]bus.Racer{{State: bus.RacerFinished, Home: 9000}, {State: bus.RacerFinished, Home: 9500}}, false)
	for _, rc := range f.Racers {
		if rc.Awards != 0 || rc.Place == 0 {
			t.Errorf("a race without prizes: %+v", rc)
		}
	}
}

func TestSnapshotRoundTrip(t *testing.T) {
	s := stage(t)
	w := newWorld(t, 3)
	w.begin(s, &bus.RaceCall{ID: [16]byte{14}, Course: 1, Triangle: true, Long: true, Entrants: entrants(3)})
	for range 4000 {
		w.tick(func(_ int, st *physics.State) { st.X += 0.05 })
	}
	b := AppendSnapshot(nil, w.cur)
	f := bus.NewFrame(16)
	rest, err := ReadSnapshot(append(b, 7), f)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(rest, []byte{7}) || !bytes.Equal(AppendSnapshot(nil, f), b) {
		t.Error("a snapshot's races read back differently")
	}
	if _, err := ReadSnapshot(b[:len(b)-3], bus.NewFrame(16)); err == nil {
		t.Error("a snapshot cut short read")
	}
}
