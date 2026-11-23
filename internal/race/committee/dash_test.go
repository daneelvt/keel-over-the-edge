// SPDX-License-Identifier: AGPL-3.0-only

package committee

import (
	"bytes"
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// dashCall is a race on the Dash for n boats of a kind.
func dashCall(id byte, kind uint16, n int) *bus.RaceCall {
	return &bus.RaceCall{ID: [16]byte{id}, Course: 1, Across: true, Dash: true, Kind: kind, Entrants: entrants(n)}
}

// TestLayingADash: in each of eight winds, for every kind of boat the
// area takes and fleets of one to the most it races, the Dash lies inside
// the smallest racing area with room behind its line for the boats placed
// there; its start line and its finish line lie along the wind, the
// finish up the wind of the start and DashApart of the boat's lengths
// beyond its end where the way home allows it (always for a fleet of
// Jolly boats in light to fresh wind); its one mark lies straight
// across the wind, to port, on the side that makes the turn a tack; no
// leg lies closer to the wind than 70°; and the boats placed face the
// mark and cross the start line on their way to it. The long Dash the
// same, its mark further where the area holds it.
func TestLayingADash(t *testing.T) {
	s := stage(t)
	f := bus.NewFrame(4)
	a := s.Areas[0]
	for kind := range s.Kinds {
		k := s.Kinds[kind]
		if k.Length > 15 {
			continue
		}
		for _, n := range []int{1, 2, 8, 12} {
			for w := range 16 {
				from := wrap(float64(w%8) * math.Pi / 4)
				long := w >= 8
				for _, knots := range []float64{4, 10, 22, 40} {
					call := dashCall(1, uint16(kind), n)
					call.Long = long
					c := s.Lay(f, call, knots*physics.Knot, from, n)
					if c == nil || !c.Across || !c.Dash || c.Triangle || c.Island || c.Laps != 1 || len(c.Way) != 3 || len(c.Checks) != 3 {
						t.Fatalf("kind %d, wind from %.2f: laid %+v", kind, from, c)
					}
					spots := Spots(c, k.Length)
					// The rows the fleet's boats are placed in.
					perRow := max(int(hypot(c.Committee[0]-c.Pin[0], c.Committee[1]-c.Pin[1])/(rowBack*k.Length)+0.01), 1)
					placed := min((n+perRow-1)/perRow*perRow, len(spots))
					points := append(append([][2]float64{}, c.Way...), c.Committee, c.Pin, c.FinishA, c.FinishB, [2]float64{c.Marks[0].X, c.Marks[0].Y})
					for _, sp := range spots[:placed] {
						points = append(points, [2]float64{sp.X, sp.Y})
					}
					for _, p := range points {
						if hypot(p[0]-a.X, p[1]-a.Y) > a.Radius+1e-6 {
							t.Errorf("kind %d, %d boats, wind from %.2f at %.0f kn: %v outside the area", kind, n, from, knots, p)
						}
					}
					for i := 1; i < len(c.Way); i++ {
						if off := offWind(from, c.Way[i-1], c.Way[i]); off < 70*math.Pi/180-1e-9 {
							t.Errorf("kind %d, %d boats, wind from %.2f at %.0f kn: leg %d lies %.1f° off the wind", kind, n, from, knots, i, off*180/math.Pi)
						}
					}
					// Both lines along the wind, on one line, the finish up it
					// of the start: DashApart lengths beyond its end, or as far
					// as a way home 70° off the wind lets it lie.
					if offWind(from, c.Committee, c.Pin) > 1e-6 || offWind(from, c.FinishB, c.FinishA) > 1e-6 || offWind(from, c.Way[0], c.Way[2]) > 1e-6 {
						t.Errorf("kind %d, wind from %.2f: the lines are not along the wind, the finish up it of the start", kind, from)
					}
					apart := hypot(c.FinishB[0]-c.Pin[0], c.FinishB[1]-c.Pin[1])
					if offWind(from, c.Pin, c.FinishB) > math.Pi/2 {
						apart = -apart
					}
					legOut := hypot(c.Way[1][0]-c.Way[0][0], c.Way[1][1]-c.Way[0][1])
					home := offWind(from, c.Way[1], c.Way[2])
					if math.Abs(apart-DashApart*k.Length) > 1e-6 && math.Abs(home-70*math.Pi/180) > 1e-6 {
						t.Errorf("kind %d, %d boats: the finish %.1f m beyond the start's end, %.1f lengths, the way home %.1f° off the wind (leg %.0f m)",
							kind, n, apart, apart/k.Length, home*180/math.Pi, legOut)
					}
					if kind == 0 && knots <= 22 && apart < DashApart*k.Length-1e-6 {
						t.Errorf("kind %d, %d boats at %.0f kn: the finish only %.1f lengths beyond the start, the leg %.0f m", kind, n, knots, apart/k.Length, legOut)
					}
					if len(c.Marks) != 1 || c.Marks[0].Side != bus.MarkPort || c.Marks[0].Number != 1 {
						t.Fatalf("kind %d: marks %+v", kind, c.Marks)
					}
					out := bearing(c.Way[1][0]-c.Way[0][0], c.Way[1][1]-c.Way[0][1])
					if side := wrap(from - out); !(side < 0) {
						t.Errorf("kind %d, wind from %.2f: the wind not over the port side going out", kind, from)
					}
					for _, sp := range spots[:min(n, len(spots))] {
						if d := math.Abs(wrap(sp.Heading - out)); d > 1e-9 {
							t.Errorf("kind %d: a boat placed faces %.2f, the mark bears %.2f", kind, sp.Heading, out)
						}
						if ch := &c.Checks[0]; lineCross(ch, sp.X, sp.Y, sp.X+float64(legOut*math.Sin(out)), sp.Y+float64(legOut*math.Cos(out))) != ch.Want {
							t.Errorf("kind %d, wind from %.2f: a boat placed at (%.0f, %.0f) does not cross the line on her way out", kind, from, sp.X, sp.Y)
						}
					}
				}
			}
		}
	}
	// The Jolly boat's, in a breeze the area holds it in: six minutes.
	c := s.Lay(f, dashCall(1, 0, 6), 8*physics.Knot, 1, 6)
	if math.Abs(c.Expected-DashSeconds) > 30 {
		t.Errorf("a Dash the Jolly boat sails in %.0f s", c.Expected)
	}
	// And the long one, in a light wind: twelve minutes, its mark twice as
	// far; in a breeze, as far as the area holds, still further than the
	// Dash's.
	long := dashCall(1, 0, 6)
	long.Long = true
	l := s.Lay(f, long, 4*physics.Knot, 1, 6)
	d := s.Lay(f, dashCall(1, 0, 6), 4*physics.Knot, 1, 6)
	leg := func(c *bus.RaceCourse) float64 { return hypot(c.Way[1][0]-c.Way[0][0], c.Way[1][1]-c.Way[0][1]) }
	if math.Abs(l.Expected-LongDashSeconds) > 45 || math.Abs(leg(l)-2*leg(d)) > 0.05*leg(d) {
		t.Errorf("a long Dash the Jolly boat sails in %.0f s, its leg %.0f m, the Dash's %.0f m", l.Expected, leg(l), leg(d))
	}
	if l, d := s.Lay(f, long, 10*physics.Knot, 1, 6), s.Lay(f, dashCall(1, 0, 6), 10*physics.Knot, 1, 6); !(l.Expected > d.Expected+60) {
		t.Errorf("in 10 kn a long Dash of %.0f s, the Dash %.0f s", l.Expected, d.Expected)
	}
}

// dashRoute is a boat's way round Dash c from where she is placed: over
// the start line, past the mark on its far side from the wind, round it
// to port, and home over the finish line; or, with start, back over the
// start line instead.
func dashRoute(c *bus.RaceCourse, start bool) [][2]float64 {
	us, uc := physics.SinCos(c.From)
	mark := c.Checks[1]
	ox, oy := mark.S, mark.C
	at := func(out, up float64) [2]float64 {
		return [2]float64{mark.X + out*ox + up*us, mark.Y + out*oy + up*uc}
	}
	home := c.Way[2]
	if start {
		home = c.Way[0]
	}
	return [][2]float64{
		{c.Way[0][0] + 10*ox, c.Way[0][1] + 10*oy},
		at(-5, -15), at(15, -15), at(15, 15), at(-5, 15),
		{home[0] + 10*ox, home[1] + 10*oy},
		{home[0] - 20*ox, home[1] - 20*oy},
	}
}

// TestAFleetHomeOverTheDashsFinish: two boats race a Dash; the one that
// sails home over the finish line is finished, the one that sails back
// over the start line is not, and is placed by its progress.
func TestAFleetHomeOverTheDashsFinish(t *testing.T) {
	defer func(a int64) { DriftAfter = a }(DriftAfter)
	DriftAfter = 1 << 40
	s := stage(t)
	w := newWorld(t, 2)
	c := w.begin(s, dashCall(31, 0, 2))
	if r := &w.cur.Races[0]; r.Alone || r.Start == 0 {
		t.Fatalf("a race of two sailed as %+v", r)
	}
	speed := 2 * c.Length / c.Expected
	boats := []*sailor{{speed: speed, way: dashRoute(c, false), hold: true}, {speed: speed, way: dashRoute(c, true), hold: true}}
	start := w.cur.Races[0].Start
	w.until(func(s int, st *physics.State) {
		if w.nxt.Tick >= start {
			boats[s].hold = false
		}
		boats[s].move(st)
	}, func() bool { return false })
	if rc := w.racer(1); rc.State != bus.RacerFinished || rc.Place != 1 {
		t.Errorf("home over the finish: state %d, place %d", rc.State, rc.Place)
	}
	if rc := w.racer(2); rc.State != bus.RacerPlacedAtEnd || rc.Next != 2 || rc.Place != 2 {
		t.Errorf("back over the start: state %d, next %d, place %d", rc.State, rc.Next, rc.Place)
	}
}

// TestADashInASnapshot: a Dash's race is written and read back the same,
// its flags among the course's.
func TestADashInASnapshot(t *testing.T) {
	s := stage(t)
	w := newWorld(t, 2)
	c := w.begin(s, dashCall(32, 0, 2))
	b := &sailor{speed: c.Length / c.Expected, way: dashRoute(c, false)}
	for range 2000 {
		w.tick(func(_ int, st *physics.State) { b.move(st) })
	}
	snap := AppendSnapshot(nil, w.cur)
	f := bus.NewFrame(16)
	if _, err := ReadSnapshot(snap, f); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(AppendSnapshot(nil, f), snap) || len(f.Races) != 1 || !f.Races[0].Course.Across || !f.Races[0].Course.Dash {
		t.Error("a Dash's snapshot read back differently")
	}
}

// TestARaceOfOneIsSailedAlone: a race with one boat as its boats are
// placed is judged as a time trial is: no signals, its clock from the
// boat's crossing, no calls, a medal against its expected time, and its
// race flagged alone in the snapshot; a race of two is not.
func TestARaceOfOneIsSailedAlone(t *testing.T) {
	s := stage(t)
	w := newWorld(t, 1)
	c := w.begin(s, dashCall(33, 0, 1))
	r := &w.cur.Races[0]
	if !r.Alone || r.Trial || r.Start != 0 || r.Prizes || len(events(w.cur, bus.RaceSignalled)) != 0 {
		t.Fatalf("a race of one begun as %+v, signals %+v", r, events(w.cur, bus.RaceSignalled))
	}
	b := &sailor{speed: c.Length / c.Expected, way: dashRoute(c, false)}
	var signals int
	w.until(func(_ int, st *physics.State) { b.move(st) }, func() bool {
		for _, e := range events(w.cur, bus.RaceSignalled) {
			if e.Signal != bus.SignalFinish {
				signals++
			}
		}
		return false
	})
	r, rc := &w.cur.Races[0], w.racer(1)
	if rc.State != bus.RacerFinished || rc.Medal == 0 || signals != 0 || r.Start != rc.Crossed {
		t.Errorf("sailed alone at the expected speed: state %d, medal %d, %d signals, start %d crossed %d", rc.State, rc.Medal, signals, r.Start, rc.Crossed)
	}
	snap := AppendSnapshot(nil, w.cur)
	f := bus.NewFrame(16)
	if _, err := ReadSnapshot(snap, f); err != nil || !f.Races[0].Alone {
		t.Errorf("a race sailed alone read back: %v", err)
	}
	// A race whose one boat never crosses ends at the trial's wait.
	w = newWorld(t, 1)
	w.begin(s, dashCall(34, 0, 1))
	w.until(nil, func() bool { return false })
	if r := &w.cur.Races[0]; r.Ended-r.Warning != TrialWait || w.racer(1).State != bus.RacerRetired {
		t.Errorf("a race sailed alone, never crossed: ended %d ticks on, state %d", r.Ended-r.Warning, w.racer(1).State)
	}
}

// TestTheWindowLetsTheSlowFinish: the first boat home opens a window as
// long again as its time, ten minutes at least; a boat at a third of its
// speed is home inside it.
func TestTheWindowLetsTheSlowFinish(t *testing.T) {
	defer func(a int64) { DriftAfter = a }(DriftAfter)
	DriftAfter = 1 << 40
	s := stage(t)
	w := newWorld(t, 2)
	c := w.begin(s, dashCall(35, 0, 2))
	fast := 2 * c.Length / c.Expected
	boats := []*sailor{{speed: fast, way: dashRoute(c, false), hold: true}, {speed: fast / 2.5, way: dashRoute(c, false), hold: true}}
	start := w.cur.Races[0].Start
	w.until(func(s int, st *physics.State) {
		if w.nxt.Tick >= start {
			boats[s].hold = false
		}
		boats[s].move(st)
	}, func() bool { return false })
	r := &w.cur.Races[0]
	first := w.racer(1)
	if want := r.Home + max(first.Home-r.Start, Window); r.Closes != want {
		t.Errorf("the window closes at %d, want %d", r.Closes, want)
	}
	if rc := w.racer(2); rc.State != bus.RacerFinished {
		t.Errorf("the slow boat: state %d, home %d, the window closed %d", rc.State, rc.Home, r.Closes)
	}
	if Window != 600*Second || RaceLimit != 4 {
		t.Errorf("a window of %d s and a limit of %.0f expected times", Window/Second, RaceLimit)
	}
}

// TestStillRacing: a boat asked whether it still races answers by coming
// DriftGain nearer than where it was asked, however far it drifted from
// its nearest before; or by saying so; and is asked again after
// DriftAfter more without progress.
func TestStillRacing(t *testing.T) {
	defer func(a, b int64) { DriftAfter, DriftAnswer = a, b }(DriftAfter, DriftAnswer)
	DriftAfter, DriftAnswer = 20*Second, 10*Second
	s := stage(t)
	for _, tap := range []bool{false, true} {
		w := newWorld(t, 2)
		c := w.begin(s, dashCall(36, 0, 2))
		start := w.cur.Races[0].Start
		// Over the line, then far off away from the mark, then still.
		mark := [2]float64{c.Marks[0].X, c.Marks[0].Y}
		away := [2]float64{c.Way[0][0] - (mark[0] - c.Way[0][0]), c.Way[0][1] - (mark[1] - c.Way[0][1])}
		b := &sailor{speed: 3, way: [][2]float64{{(c.Way[0][0] + mark[0]) / 2, (c.Way[0][1] + mark[1]) / 2}, away}, hold: true}
		asked, answered, retired := int64(0), false, false
		w.until(func(s int, st *physics.State) {
			if s != 0 {
				return
			}
			if w.nxt.Tick >= start {
				b.hold = false
			}
			if asked != 0 && !answered && !tap {
				// Sails 12 m back toward the mark from where she was
				// asked: still far worse than her nearest.
				b.way, b.at, b.speed = append(b.way, [2]float64{st.X + float64(12*(mark[0]-st.X)/hypot(mark[0]-st.X, mark[1]-st.Y)),
					st.Y + float64(12*(mark[1]-st.Y)/hypot(mark[0]-st.X, mark[1]-st.Y))}), len(b.way), 2
				answered = true
			}
			b.move(st)
		}, func() bool {
			for _, e := range events(w.cur, bus.RaceDrifting) {
				if e.Number == 1 && asked == 0 {
					asked = w.cur.Tick
					if tap {
						if !StillRacing(w.cur, bus.Account{1}) || StillRacing(w.cur, bus.Account{1}) {
							t.Error("the tap not taken once")
						}
						answered = true
					}
				}
			}
			for _, e := range events(w.cur, bus.RaceRetired) {
				retired = retired || e.Number == 1
			}
			return asked != 0 && w.cur.Tick > asked+DriftAnswer+Second
		})
		if asked == 0 || retired || w.racer(1).State != bus.RacerRacing {
			t.Errorf("tap %v: asked at %d, retired %v, state %d", tap, asked, retired, w.racer(1).State)
		}
		if StillRacing(w.cur, bus.Account{9}) {
			t.Error("a boat in no race still racing")
		}
	}
}

// TestACallOff: a race called off is in the frame ended as it began, its
// entrants kept, none placed, and is let go once written.
func TestACallOff(t *testing.T) {
	s := stage(t)
	f := bus.NewFrame(4)
	call := dashCall(37, 0, 3)
	c := s.Lay(f, call, 26, 0, 3)
	key := CallOff(f, call, c)
	if len(f.Races) != 1 || !f.Races[0].CalledOff || f.Races[0].Phase != bus.RaceEnded || f.Races[0].Key != key || len(f.Racers) != 3 {
		t.Fatalf("called off: %+v, %d racers", f.Races, len(f.Racers))
	}
	for _, rc := range f.Racers {
		if rc.State != bus.RacerDNS || rc.Slot != -1 {
			t.Errorf("a racer of a race called off: %+v", rc)
		}
	}
	if got := events(f, bus.RaceOver); len(got) != 1 {
		t.Errorf("events %+v", f.RaceEvents)
	}
	snap := AppendSnapshot(nil, f)
	g := bus.NewFrame(4)
	if _, err := ReadSnapshot(snap, g); err != nil || !g.Races[0].CalledOff {
		t.Errorf("a race called off read back: %v", err)
	}
	if !Drop(f, call.ID, 0) || len(f.Races) != 0 || len(f.Racers) != 0 {
		t.Error("a race called off not let go")
	}
}
