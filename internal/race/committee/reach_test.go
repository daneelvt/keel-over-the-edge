// SPDX-License-Identifier: AGPL-3.0-only

package committee

import (
	"bytes"
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// offWind is how far off the wind from from the way from a to b lies, rad.
func offWind(from float64, a, b [2]float64) float64 {
	return math.Abs(wrap(from - bearing(b[0]-a[0], b[1]-a[1])))
}

// TestLayingAReach: in each of eight winds and for every kind of boat the
// area takes, the reach lies inside the racing area, its line along the
// wind with the committee boat at its downwind end, its one mark straight
// across the wind, to port and on the side that makes the turn a tack; no
// leg lies closer to the wind than 80°; and the boat placed faces the
// mark.
func TestLayingAReach(t *testing.T) {
	s := stage(t)
	f := bus.NewFrame(4)
	a := s.Areas[0]
	for kind := range s.Kinds {
		k := s.Kinds[kind]
		if k.Length > 15 {
			continue
		}
		for w := range 8 {
			from := wrap(float64(w) * math.Pi / 4)
			for _, knots := range []float64{4, 10, 22} {
				c := s.Lay(f, &bus.RaceCall{Trial: true, Across: true, Kind: uint16(kind), Entrants: entrants(1)}, knots*physics.Knot, from, 1)
				if c == nil || !c.Across || c.Triangle || c.Island || c.Laps != 1 {
					t.Fatalf("kind %d, wind from %.2f: laid %+v", kind, from, c)
				}
				for _, p := range append(append([][2]float64{}, c.Way...), c.Committee, c.Pin, c.FinishA, c.FinishB, [2]float64{c.Marks[0].X, c.Marks[0].Y}) {
					if hypot(p[0]-a.X, p[1]-a.Y) > a.Radius+1e-6 {
						t.Errorf("kind %d, wind from %.2f at %.0f kn: %v outside the area", kind, from, knots, p)
					}
				}
				for i := 1; i < len(c.Way); i++ {
					if off := offWind(from, c.Way[i-1], c.Way[i]); off < 80*math.Pi/180 {
						t.Errorf("kind %d, wind from %.2f: leg %d lies %.0f° off the wind", kind, from, i, off*180/math.Pi)
					}
				}
				// The line along the wind: the pin up it, the committee boat down it.
				if off := offWind(from, c.Committee, c.Pin); off > 1e-6 {
					t.Errorf("kind %d, wind from %.2f: the line lies %.2f rad off the wind", kind, from, off)
				}
				if len(c.Marks) != 1 || c.Marks[0].Side != bus.MarkPort || c.Marks[0].Number != 1 || len(c.Checks) != 3 {
					t.Fatalf("kind %d: marks %+v, %d checks", kind, c.Marks, len(c.Checks))
				}
				// Sailing out, the wind is over the port side: turning to
				// port round the mark is turning up, through the wind.
				out := bearing(c.Way[1][0]-c.Way[0][0], c.Way[1][1]-c.Way[0][1])
				if side := wrap(from - out); !(side < 0) {
					t.Errorf("kind %d, wind from %.2f: the wind %.2f rad off the way out, not over the port side", kind, from, side)
				}
				spots := Spots(c, k.Length)
				if d := math.Abs(wrap(spots[0].Heading - out)); d > 1e-9 {
					t.Errorf("kind %d: the boat placed faces %.2f, the mark bears %.2f", kind, spots[0].Heading, out)
				}
				// Behind the line: the start is ahead of the boat placed.
				if ch := &c.Checks[0]; lineCross(ch, spots[0].X, spots[0].Y, c.Way[1][0], c.Way[1][1]) != ch.Want {
					t.Errorf("kind %d, wind from %.2f: the boat placed at %v does not cross the line on her way to the mark", kind, from, spots[0])
				}
			}
		}
	}
	// The Jolly boat's, in a breeze the area holds it in: five minutes.
	c := s.Lay(f, &bus.RaceCall{Trial: true, Across: true, Entrants: entrants(1)}, 8*physics.Knot, 1, 1)
	if math.Abs(c.Expected-ReachSeconds) > 20 {
		t.Errorf("a reach the Jolly boat sails in %.0f s", c.Expected)
	}
}

// reachRoute is a boat's way round reach c from where she is placed: over
// the line, past the mark on its far side from the wind, round it to
// port and home; the other way round with wrong.
func reachRoute(c *bus.RaceCourse, wrong bool) [][2]float64 {
	us, uc := physics.SinCos(c.From)
	mark := c.Checks[1]
	// Out along the ray's own direction, and up the wind.
	ox, oy := mark.S, mark.C
	down := -15.0
	if wrong {
		down = 15
	}
	at := func(out, up float64) [2]float64 {
		return [2]float64{mark.X + out*ox + up*us, mark.Y + out*oy + up*uc}
	}
	home := c.Way[0]
	return [][2]float64{
		{home[0] + 10*ox, home[1] + 10*oy},
		at(-5, down), at(15, down), at(15, -down), at(-5, -down),
		{home[0] + 10*ox, home[1] + 10*oy},
		{home[0] - 20*ox, home[1] - 20*oy},
	}
}

// reachRun begins a trial's run on the reach for one boat, placed.
func reachRun(t *testing.T) (*world, *bus.RaceCourse) {
	t.Helper()
	s := stage(t)
	w := newWorld(t, 1)
	c := w.begin(s, &bus.RaceCall{ID: [16]byte{21}, Run: 1, Trial: true, Across: true, Entrants: entrants(1)})
	return w, c
}

// TestARunRoundTheReach: a run out to the mark, round it to port and
// home is finished, with its medal.
func TestARunRoundTheReach(t *testing.T) {
	w, c := reachRun(t)
	b := &sailor{speed: c.Length / c.Expected, way: reachRoute(c, false)}
	got := w.until(func(_ int, st *physics.State) { b.move(st) }, func() bool { return false }, bus.RaceRounded, bus.RaceMissed)
	rc := w.racer(1)
	if rc.State != bus.RacerFinished || rc.Medal == 0 {
		t.Fatalf("a run round the reach at the expected speed: state %d, medal %d", rc.State, rc.Medal)
	}
	if len(got) != 1 || got[0].Kind != bus.RaceRounded || got[0].Mark != 1 {
		t.Errorf("events %+v, want mark 1 rounded", got)
	}
}

// TestTheReachsMarkIsLeftToPort: a boat that goes round the mark the
// other way and comes home is told she missed it, and is not finished;
// she goes back, unwinds her turn, rounds it to port and finishes.
func TestTheReachsMarkIsLeftToPort(t *testing.T) {
	defer func(a int64) { DriftAfter = a }(DriftAfter)
	DriftAfter = 1 << 40
	w, c := reachRun(t)
	wrong := reachRoute(c, true)
	right := reachRoute(c, false)
	// The wrong way round and home; back the way she came to unwind it;
	// then the right way round and home.
	way := append([][2]float64{}, wrong...)
	for i := len(wrong) - 2; i >= 1; i-- {
		way = append(way, wrong[i])
	}
	way = append(way, right[1:]...)
	b := &sailor{speed: 4 * c.Length / c.Expected, way: way}
	missed, home := false, int64(0)
	w.until(func(_ int, st *physics.State) {
		b.move(st)
		if b.at == len(wrong) && home == 0 {
			home = w.nxt.Tick
		}
	}, func() bool {
		for _, e := range events(w.cur, bus.RaceMissed) {
			missed = missed || e.Mark == 1
		}
		if home != 0 && w.cur.Tick == home && w.racer(1).State != bus.RacerRacing {
			t.Fatalf("home the wrong way round: state %d", w.racer(1).State)
		}
		return false
	})
	if !missed {
		t.Error("no word of the mark missed")
	}
	if rc := w.racer(1); rc.State != bus.RacerFinished {
		t.Errorf("after going back for the mark: state %d, next %d, net %d", rc.State, rc.Next, rc.Net)
	}
}

// TestATrialsTimeLimit: a trial's run has four times its course's
// expected time, a race twice: a run at a third of the expected speed is
// finished, with no medal, and a boat that stops on the course is placed
// at four times.
func TestATrialsTimeLimit(t *testing.T) {
	defer func(a int64) { DriftAfter = a }(DriftAfter)
	DriftAfter = 1 << 40
	for _, across := range []bool{true, false} {
		s := stage(t)
		w := newWorld(t, 1)
		c := w.begin(s, &bus.RaceCall{ID: [16]byte{22}, Run: 1, Trial: true, Across: across, Entrants: entrants(1)})
		way := route(c)
		if across {
			way = reachRoute(c, false)
		}
		b := &sailor{speed: c.Length / c.Expected / 3, way: way}
		w.until(func(_ int, st *physics.State) { b.move(st) }, func() bool { return false })
		rc, r := w.racer(1), &w.cur.Races[0]
		if secs := Elapsed(r, rc); rc.State != bus.RacerFinished || rc.Medal != 0 || !(secs > 2.5*c.Expected) {
			t.Errorf("across %v: a slow run: state %d, medal %d, %.0f s against %.0f expected", across, rc.State, rc.Medal, secs, c.Expected)
		}

		// A boat that crosses the line and stops.
		w = newWorld(t, 1)
		c = w.begin(s, &bus.RaceCall{ID: [16]byte{23}, Run: 1, Trial: true, Across: across, Entrants: entrants(1)})
		stop := &sailor{speed: 3, way: way[:1]}
		w.until(func(_ int, st *physics.State) { stop.move(st) }, func() bool { return false })
		r = &w.cur.Races[0]
		if want := int64(math.Ceil(4 * c.Expected * Second)); r.Start == 0 || r.Ended != r.Start+want || limit(r) != want {
			t.Errorf("across %v: ended %d ticks after the start, want %d", across, r.Ended-r.Start, want)
		}
		if rc := w.racer(1); rc.State != bus.RacerPlacedAtEnd {
			t.Errorf("across %v: the boat left on the course in state %d", across, rc.State)
		}
	}
	if RaceLimit != 2 || TrialLimit != 4 {
		t.Errorf("limits of %.0f and %.0f expected times", RaceLimit, TrialLimit)
	}
}

// TestAReachInASnapshot: a reach's race is written and read back the
// same; a course written before the reach was, with no flag for it, still
// reads, as no reach.
func TestAReachInASnapshot(t *testing.T) {
	w, c := reachRun(t)
	b := &sailor{speed: c.Length / c.Expected, way: reachRoute(c, false)}
	for range 2000 {
		w.tick(func(_ int, st *physics.State) { b.move(st) })
	}
	snap := AppendSnapshot(nil, w.cur)
	f := bus.NewFrame(16)
	if _, err := ReadSnapshot(snap, f); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(AppendSnapshot(nil, f), snap) || len(f.Races) != 1 || !f.Races[0].Course.Across {
		t.Error("a reach's snapshot read back differently")
	}

	s := stage(t)
	for _, call := range []*bus.RaceCall{{Course: 1, Entrants: entrants(2)}, {Course: 1, Triangle: true, Long: true, Entrants: entrants(2)},
		{Island: true, Course: 3, Entrants: entrants(2)}} {
		old := s.Lay(bus.NewFrame(4), call, 5, 0, 2)
		enc := appendCourse(nil, old)
		// Its flags are the two an older build wrote.
		if enc[0]&^(courseIsland|courseTriangle) != 0 {
			t.Fatalf("flags %d for a course that is no reach", enc[0])
		}
		r := &reader{b: enc}
		got := r.course()
		if r.err != nil || got.Across || got.Triangle != old.Triangle || got.Island != old.Island || !bytes.Equal(appendCourse(nil, got), enc) {
			t.Errorf("an older course read back as %+v: %v", got, r.err)
		}
	}
	// A flag nobody writes is still refused.
	enc := appendCourse(nil, c)
	enc[0] |= 8
	if r := (&reader{b: enc}); r.course() == nil || r.err == nil {
		t.Error("a course with an unknown flag read")
	}
}
