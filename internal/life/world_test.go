// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// harbourAt is in the test world's harbour, off its town.
var harbourAt = [2]float64{island.x + 650, island.y + 40}

// sailing is a frame of one boat, boat 1, sailing east at speed m/s from
// (x, y) at tick.
func sailing(tick int64, x, y, speed float64) *bus.Frame {
	f := bus.NewFrame(4)
	f.Tick = tick
	f.Live = append(f.Live, 0)
	f.Occupied[0] = true
	f.Boat[0] = 1
	f.State[0] = physics.State{X: x, Y: y, Heading: math.Pi / 2, Surge: speed}
	return f
}

// follower is the index of the first kind that follows boats.
func follower(t *testing.T, s *Schedule) int {
	t.Helper()
	for i := range s.kinds {
		if s.kinds[i].Follows {
			return i
		}
	}
	t.Fatal("no kind follows boats")
	return -1
}

// sail ticks w from f's tick for ticks, the boat sailing on as it heads.
func sail(w *World, f *bus.Frame, ticks int64) {
	for range ticks {
		f.Tick++
		st := &f.State[0]
		st.X += float64(st.Surge * math.Sin(st.Heading) / physics.StepsPerSecond)
		st.Y += float64(st.Surge * math.Cos(st.Heading) / physics.StepsPerSecond)
		w.Tick(f, steady{wind: 6})
	}
}

// TestAGullFollowsABoat: a gull raised by a boat sailing steadily out of
// harbour follows it, keeps astern of it, and leaves within its stay and
// its flight out; the boat is quiet after.
func TestAGullFollowsABoat(t *testing.T) {
	s := testSchedule(t, 9)
	k := follower(t, s)
	kind := &s.kinds[k]
	w := NewWorld(s, 4)
	f := sailing(900_000, harbourAt[0], harbourAt[1], 3)
	sail(w, f, 30*15) // steady for fifteen seconds
	w.Raise(f, k, f.State[0].X+100, f.State[0].Y+50)
	var e *bus.LifeEncounter
	for i := range f.Life {
		if f.Life[i].ID>>63 == 1 {
			e = &f.Life[i]
		}
	}
	if e == nil || e.Boat != 1 || e.Slot != 0 {
		t.Fatalf("the gull took no boat: %+v", e)
	}
	most := float64(2*kind.Arrive(kind.SpeedLow)) + kind.StayHigh
	if life := float64(e.End-e.Start) / physics.StepsPerSecond; life > most || life < kind.StayLow {
		t.Errorf("it follows for %.0f s, its kind from %.0f to %.0f", life, kind.StayLow, most)
	}
	if kind.StayHigh > 180 {
		t.Errorf("a gull follows for up to %.0f s, more than 3 minutes", kind.StayHigh)
	}
	rec := *e
	// Astern of the boat while it keeps with it.
	sail(w, f, int64(kind.Arrive(rec.Speed)*physics.StepsPerSecond)+30)
	st := &f.State[0]
	x, y, _, ok := FlockAt(&rec, kind, float64(f.Tick), &Pose{X: st.X, Y: st.Y, Heading: st.Heading})
	if !ok {
		t.Fatal("not alive while following")
	}
	if ahead := float64((x-st.X)*math.Sin(st.Heading)) + float64((y-st.Y)*math.Cos(st.Heading)); ahead > -10 || ahead < -40 {
		t.Errorf("the gulls keep %.1f m ahead of the boat, not astern", ahead)
	}
	// Gone by its end.
	sail(w, f, rec.End-f.Tick)
	for _, l := range f.Life {
		if l.ID == rec.ID {
			t.Fatalf("still alive at its end: %+v", l)
		}
	}
	// Quiet after: a gull meeting it now passes it by.
	if b := w.boats[0]; b.quiet < rec.End+s.p.Quiet {
		t.Errorf("quiet until %d, want %d", b.quiet, rec.End+s.p.Quiet)
	}
	e2 := rec
	e2.ID, e2.Boat, e2.Slot, e2.Start = 77, 0, -1, f.Tick
	e2.East, e2.North = f.State[0].X+50, f.State[0].Y
	w.begin(f, e2, false)
	if got := w.alive[len(w.alive)-1]; got.Boat != 0 {
		t.Errorf("followed again %.0f minutes after", float64(f.Tick-rec.End)/physics.StepsPerSecond/60)
	}
	// And followed once the quiet is over.
	sail(w, f, s.p.Quiet+30)
	e3 := e2
	e3.ID, e3.Start = 78, f.Tick
	e3.East, e3.North = f.State[0].X+50, f.State[0].Y
	w.begin(f, e3, false)
	if got := w.alive[len(w.alive)-1]; got.Boat != 1 {
		t.Error("not followed once the quiet was over")
	}
}

// TestNoBoatAtRest: a gull meeting a boat at rest, or one turning, passes.
func TestNoBoatAtRest(t *testing.T) {
	s := testSchedule(t, 9)
	k := follower(t, s)
	w := NewWorld(s, 4)
	f := sailing(900_000, harbourAt[0], harbourAt[1], 0.5)
	sail(w, f, 30*15)
	w.Raise(f, k, f.State[0].X, f.State[0].Y)
	if e := f.Life[len(f.Life)-1]; e.Boat != 0 {
		t.Error("followed a boat at half a metre a second")
	}
	f.State[0].Surge = 3
	for range 20 {
		f.State[0].Heading += 0.4
		sail(w, f, 15)
	}
	w.Raise(f, k, f.State[0].X, f.State[0].Y)
	if e := f.Life[len(f.Life)-1]; e.Boat != 0 {
		t.Error("followed a boat turning circles")
	}
}

// TestRestart: a world opened again has the same encounters alive, from
// the schedule alone, and no boat followed.
func TestRestart(t *testing.T) {
	s := testSchedule(t, 4)
	a := NewWorld(s, 4)
	f := sailing(3_000_000, -3000, -3000, 3)
	sail(a, f, 30*60*20)
	k := follower(t, s)
	a.Raise(f, k, f.State[0].X, f.State[0].Y)
	sail(a, f, 30*20)
	before := append([]bus.LifeEncounter(nil), f.Life...)
	if len(before) == 0 {
		t.Fatal("twenty minutes and nothing alive")
	}
	b := NewWorld(s, 4)
	g := sailing(f.Tick, f.State[0].X, f.State[0].Y, 3)
	b.Tick(g, steady{wind: 6})
	byID := map[uint64]bus.LifeEncounter{}
	for _, e := range g.Life {
		byID[e.ID] = e
		if e.Boat != 0 {
			t.Errorf("a group is with a boat after the restart: %+v", e)
		}
	}
	for _, e := range before {
		if e.ID>>63 == 1 {
			if _, ok := byID[e.ID]; ok {
				t.Error("a group raised by hand outlived the restart")
			}
			continue
		}
		if e.Boat != 0 {
			continue
		}
		if got, ok := byID[e.ID]; !ok || got != e {
			t.Errorf("%+v is %+v after the restart", e, got)
		}
	}
}
