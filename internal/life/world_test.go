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

// kindWhere is the index of the first kind that holds.
func kindWhere(t *testing.T, s *Schedule, what string, ok func(*Kind) bool) int {
	t.Helper()
	for i := range s.kinds {
		if ok(&s.kinds[i]) {
			return i
		}
	}
	t.Fatalf("no kind %s", what)
	return -1
}

// rider is the index of the first kind that rides bows and passes.
func rider(t *testing.T, s *Schedule) int {
	return kindWhere(t, s, "rides bows", func(k *Kind) bool { return k.Rides() && k.Path == PathPass })
}

// raised is the last encounter raised by hand in f, nil for none.
func raised(f *bus.Frame) *bus.LifeEncounter {
	for i := len(f.Life) - 1; i >= 0; i-- {
		if f.Life[i].ID>>63 == 1 && f.Life[i].Over == 0 {
			return &f.Life[i]
		}
	}
	return nil
}

// byID is the encounter of id in f, nil for none.
func byID(f *bus.Frame, id uint64) *bus.LifeEncounter {
	for i := range f.Life {
		if f.Life[i].ID == id {
			return &f.Life[i]
		}
	}
	return nil
}

// poseOf is boat 1's pose in f.
func poseOf(f *bus.Frame) *Pose {
	st := &f.State[0]
	return &Pose{X: st.X, Y: st.Y, Heading: st.Heading}
}

// riding raises a pod that rides bows by a boat sailing east at speed,
// steady for fifteen seconds, and sails on until it is at the bow.
func riding(t *testing.T, s *Schedule, speed float64) (*World, *bus.Frame, bus.LifeEncounter) {
	t.Helper()
	k := rider(t, s)
	w := NewWorld(s, 4)
	f := sailing(900_000, -3000, -3000, speed)
	sail(w, f, 30*15)
	w.Raise(f, k, f.State[0].X+100, f.State[0].Y+50)
	e := raised(f)
	if e == nil || e.Boat != 1 {
		t.Fatalf("the pod took no boat at %.1f m/s: %+v", speed, e)
	}
	rec := *e
	sail(w, f, int64(s.kinds[k].Arrive(rec.Speed)*physics.StepsPerSecond)+30)
	x, y, _, ok := FlockAt(&rec, &s.kinds[k], float64(f.Tick), poseOf(f))
	if !ok || math.Hypot(x-f.State[0].X, y-f.State[0].Y) > 1e-6 {
		t.Fatalf("not at the bow once in: (%.1f, %.1f), the boat at (%.1f, %.1f)", x, y, f.State[0].X, f.State[0].Y)
	}
	if got := byID(f, rec.ID); got == nil || got.Boat != 1 {
		t.Fatalf("left the bow on a steady course: %+v", got)
	}
	return w, f, rec
}

// TestNoRideBelowTwo: a pod meeting a boat slower than the binding's
// 2 m/s passes it by, even raised by hand.
func TestNoRideBelowTwo(t *testing.T) {
	s := testSchedule(t, 9)
	w := NewWorld(s, 4)
	f := sailing(900_000, -3000, -3000, 1.9)
	sail(w, f, 30*15)
	w.Raise(f, rider(t, s), f.State[0].X+100, f.State[0].Y)
	if e := raised(f); e == nil || e.Boat != 0 {
		t.Errorf("rode the bow of a boat at 1.9 m/s: %+v", e)
	}
}

// TestRideLeavesOnATurn: a pod at the bow leaves it at once when the boat
// turns more than 40° from the heading the ride began on, from where it
// is, heading back toward where it met the boat; a turn of less keeps it.
func TestRideLeavesOnATurn(t *testing.T) {
	s := testSchedule(t, 9)
	w, f, rec := riding(t, s, 3)
	k := &s.kinds[rec.Kind]
	met := Pose{X: f.State[0].X, Y: f.State[0].Y}
	met.X -= float64(f.Tick-rec.Start-int64(k.Arrive(rec.Speed)*physics.StepsPerSecond)) * 3 / physics.StepsPerSecond
	f.State[0].Heading += 30 * math.Pi / 180
	sail(w, f, 30)
	if got := byID(f, rec.ID); got == nil || got.Boat != 1 {
		t.Fatalf("left on a turn of 30°: %+v", got)
	}
	f.State[0].Heading += 15 * math.Pi / 180
	before := *poseOf(f)
	sail(w, f, 1)
	got := byID(f, rec.ID)
	if got == nil || got.Boat != 0 || got.Rev != 1 {
		t.Fatalf("kept the bow on a turn of 45°: %+v", got)
	}
	// From the bow, where the boat was a tick before.
	x, y, _, ok := FlockAt(got, k, float64(f.Tick), nil)
	if !ok || math.Hypot(x-before.X, y-before.Y) > 0.2 {
		t.Errorf("left from (%.1f, %.1f), the bow at (%.1f, %.1f)", x, y, before.X, before.Y)
	}
	// Back toward where they met.
	if back := physics.Atan2(met.X-x, met.Y-y); math.Abs(wrap(got.Heading-back)) > 0.05 {
		t.Errorf("heading %.2f rad, where they met %.2f", got.Heading, back)
	}
}

// TestRideLeavesASlowBoat: a pod at the bow leaves it at once when the
// boat slows below 2 m/s; the boat stays quiet until 45 minutes after the
// ride's end, for riders and followers both.
func TestRideLeavesASlowBoat(t *testing.T) {
	s := testSchedule(t, 9)
	w, f, rec := riding(t, s, 3)
	f.State[0].Surge = 1.8
	sail(w, f, 1)
	if got := byID(f, rec.ID); got == nil || got.Boat != 0 {
		t.Fatalf("kept the bow of a boat at 1.8 m/s: %+v", got)
	}
	f.State[0].Surge = 3
	if b := w.boats[0]; b.quiet != rec.End+s.p.Quiet {
		t.Errorf("quiet until %d, want %d", b.quiet, rec.End+s.p.Quiet)
	}
	if s.p.Quiet != 45*60*physics.StepsPerSecond {
		t.Errorf("the quiet is %d ticks, not 45 minutes", s.p.Quiet)
	}
	// Neither a pod nor a gull takes it while it is quiet.
	sail(w, f, rec.End+s.p.Quiet-f.Tick-30)
	for i, k := range []int{rider(t, s), follower(t, s)} {
		e := bus.LifeEncounter{ID: uint64(90 + i), Kind: uint16(k), Start: f.Tick, End: f.Tick + 30*600, Slot: -1,
			East: f.State[0].X + 50, North: f.State[0].Y, Speed: 3}
		w.begin(f, e, false)
		if got := w.alive[len(w.alive)-1]; got.Boat != 0 {
			t.Errorf("%s took the boat a second before its quiet is over", s.kinds[k].Name)
		}
	}
	// Raised by hand, a pod takes a quiet boat.
	w.Raise(f, rider(t, s), f.State[0].X+100, f.State[0].Y)
	if e := raised(f); e == nil || e.Boat != 1 {
		t.Errorf("a pod raised by hand took no quiet boat: %+v", e)
	}
	// And once the quiet is over, a pod drawn takes it.
	w2 := NewWorld(s, 4)
	g := sailing(f.Tick, f.State[0].X, f.State[0].Y, 3)
	sail(w2, g, 30*15)
	w2.boats[0].quiet = g.Tick
	e := bus.LifeEncounter{ID: 99, Kind: uint16(rider(t, s)), Start: g.Tick, End: g.Tick + 30*600, Slot: -1,
		East: g.State[0].X + 50, North: g.State[0].Y, Speed: 3}
	w2.begin(g, e, false)
	if got := w2.alive[len(w2.alive)-1]; got.Boat != 1 {
		t.Error("a pod drawn took no boat once its quiet was over")
	}
}

// bait is the index of the first kind that brings others.
func bait(t *testing.T, s *Schedule) int {
	return kindWhere(t, s, "that brings others", func(k *Kind) bool { return len(k.Brings) > 0 })
}

// TestBrings: the groups that come with another are drawn from it alone,
// over its centre for its life, of their own kinds and ids; raised, it
// brings them too.
func TestBrings(t *testing.T) {
	s := testSchedule(t, 3)
	enc := slots(s, 10000, 6000, steady{wind: 6})
	parents, brought := 0, 0
	for i, e := range enc {
		if len(s.kinds[e.Kind].Brings) == 0 || e.Over != 0 {
			continue
		}
		parents++
		want := s.Bring(&e, nil)
		if len(want) == 0 && s.kinds[e.Kind].Brings[0].Share >= 1 {
			t.Fatalf("%+v brought none", e)
		}
		for j, c := range want {
			got := enc[i+1+j]
			if got != c {
				t.Fatalf("after %+v, %+v, not %+v", e, got, c)
			}
			if c.Over != e.ID || c.Start != e.Start || c.End != e.End || c.East != e.East || c.North != e.North || c.ID == e.ID || c.ID&(1<<56-1) != e.ID {
				t.Errorf("%+v does not come with %+v", c, e)
			}
			brought++
		}
	}
	if parents == 0 || brought <= parents {
		t.Fatalf("%d boils bringing %d groups", parents, brought)
	}
	// Raised by hand.
	w := NewWorld(s, 4)
	f := sailing(900_000, -3000, -3000, 3)
	sail(w, f, 30)
	w.Raise(f, bait(t, s), -2000, -2000)
	e := raised(f)
	if e == nil {
		t.Fatal("no bait raised")
	}
	n := 0
	for _, c := range f.Life {
		if c.Over == e.ID {
			n++
			if c.ID>>63 != 1 || c.ID == e.ID {
				t.Errorf("a raised bait's companion's id is %x", c.ID)
			}
		}
	}
	if n != len(s.Bring(e, nil)) || n == 0 {
		t.Errorf("a raised bait brought %d", n)
	}
}

// TestBaitBreaksUp: a boat through a boil's middle ends it within a
// minute, and the groups over it leave from where they are, with no jump,
// whether they are coming in or over it.
func TestBaitBreaksUp(t *testing.T) {
	s := testSchedule(t, 3)
	for _, after := range []int64{30 * 40, 30 * 200} {
		w := NewWorld(s, 4)
		f := sailing(900_000, -3000, -3000, 3)
		sail(w, f, 30)
		w.Raise(f, bait(t, s), -1000, -2500)
		e := *raised(f)
		k := &s.kinds[e.Kind]
		sail(w, f, after)
		var before []bus.LifeEncounter
		for _, c := range f.Life {
			if c.Over == e.ID {
				before = append(before, c)
			}
		}
		if len(before) == 0 {
			t.Fatal("the bait brought nothing")
		}
		x, y, _, _ := FlockAt(&e, k, float64(f.Tick), nil)
		f.State[0].X, f.State[0].Y = x-30, y
		sail(w, f, 30*15)
		got := byID(f, e.ID)
		if got == nil || got.End > f.Tick+breakUp || got.Rev != 1 {
			t.Fatalf("a boat through bait left it %+v at %d", got, f.Tick)
		}
		broke := got.End - breakUp
		if bx, by, _, _ := FlockAt(got, k, float64(f.Tick), nil); math.Hypot(bx-x, by-y) > 15*0.3+0.01 {
			t.Errorf("the bait jumped to (%.1f, %.1f) from (%.1f, %.1f)", bx, by, x, y)
		}
		for _, c := range before {
			now := byID(f, c.ID)
			ck := &s.kinds[c.Kind]
			if now == nil {
				t.Fatalf("%s gone", ck.Name)
			}
			if !lingers(ck.PathOf(&c)) {
				continue
			}
			if now.Rev != 1 || now.End >= c.End {
				t.Errorf("%s over the bait did not leave with it: %+v, was %+v", ck.Name, now, c)
			}
			for _, tick := range []int64{broke, broke + 30, f.Tick} {
				ax, ay, _, _ := FlockAt(&c, ck, float64(tick), nil)
				bx, by, _, ok := FlockAt(now, ck, float64(tick), nil)
				if tick == broke && (!ok || math.Hypot(ax-bx, ay-by) > 1e-9) {
					t.Errorf("%s jumped from (%.1f, %.1f) to (%.1f, %.1f) as the bait broke up", ck.Name, ax, ay, bx, by)
				}
				// Never further than its speed takes it in a tick from
				// where it was a tick before.
				px, py, _, _ := FlockAt(now, ck, float64(tick-1), nil)
				if tick > broke && math.Hypot(bx-px, by-py) > now.Speed/physics.StepsPerSecond+1e-9 {
					t.Errorf("%s jumped %.1f m in a tick", ck.Name, math.Hypot(bx-px, by-py))
				}
			}
		}
	}
}

// flusher is the index of the first kind that is a ground of fish.
func flusher(t *testing.T, s *Schedule) int {
	return kindWhere(t, s, "flushed by boats", (*Kind).Flushes)
}

// flushes are the flushes alive in f from the ground of id.
func flushes(f *bus.Frame, id uint64) []bus.LifeEncounter {
	var out []bus.LifeEncounter
	for _, e := range f.Life {
		if e.Over == id {
			out = append(out, e)
		}
	}
	return out
}

// TestFlushes: a boat sailing through a ground of fish at 2 m/s or faster
// flushes them ahead of its bow, from time to time; a slower one, or one
// outside the ground, flushes none; the ground is never seen itself.
func TestFlushes(t *testing.T) {
	s := testSchedule(t, 3)
	k := flusher(t, s)
	kind := &s.kinds[k]
	for _, c := range []struct {
		name  string
		speed float64
		off   float64 // the ground's centre from the boat, m east
		want  bool
	}{
		{"at 3 m/s in the ground", 3, 100, true},
		{"at 1.9 m/s", 1.9, 100, false},
		{"outside the ground", 3, -kind.PatchHigh - 200, false},
	} {
		w := NewWorld(s, 4)
		f := sailing(900_000, -3000, -3000, c.speed)
		sail(w, f, 30)
		w.Raise(f, k, f.State[0].X+c.off, f.State[0].Y)
		last := w.grounds[len(w.grounds)-1]
		if last.e.ID>>63 != 1 || last.reach != kind.PatchHigh {
			t.Fatalf("%s: grounds %+v", c.name, w.grounds)
		}
		g := last.e
		if byID(f, g.ID) != nil {
			t.Fatalf("%s: the ground is in the frame", c.name)
		}
		seen := map[uint64]bus.LifeEncounter{}
		for range 60 {
			sail(w, f, 30)
			for _, e := range flushes(f, g.ID) {
				seen[e.ID] = e
			}
		}
		if got := len(seen) > 0; got != c.want {
			t.Errorf("%s: %d flushes in a minute", c.name, len(seen))
		}
		for _, e := range seen {
			if e.Boat != 0 || int(e.Kind) != k || e.ID>>62 != 1 {
				t.Errorf("%s: flush %+v", c.name, e)
			}
			if e.Count < uint16(kind.GroupLow) || e.Count > uint16(kind.GroupHigh) || e.Speed < kind.SpeedLow-1e-6 || e.Speed > kind.SpeedHigh+1e-6 {
				t.Errorf("%s: flush %+v outside its kind's", c.name, e)
			}
		}
	}
}

// TestFlushIsPure: the same boat, ground, slot and bow flush the same
// fish; ahead of the bow and beside its course, as the catalog says;
// at about the catalog's chance.
func TestFlushIsPure(t *testing.T) {
	s := testSchedule(t, 3)
	k := &s.kinds[flusher(t, s)]
	p := s.p
	g := bus.LifeEncounter{ID: 77, Kind: uint16(k.Index), Seed: 12345, East: 100, North: 200}
	bow := Pose{X: 120, Y: 210, Heading: 1}
	n, tries := 0, 4000
	for sl := range int64(tries) {
		a, okA := Flush(p, k, &g, 1<<40|7, sl, bow, 3000)
		b, okB := Flush(p, k, &g, 1<<40|7, sl, bow, 3000)
		if a != b || okA != okB {
			t.Fatalf("slot %d: %+v and %+v", sl, a, b)
		}
		if !okA {
			continue
		}
		n++
		sin, cos := math.Sin(bow.Heading), math.Cos(bow.Heading)
		dx, dy := a.East-bow.X, a.North-bow.Y
		ahead, beside := dx*sin+dy*cos, dx*cos-dy*sin
		if ahead < p.FlushAheadLow-0.02 || ahead > p.FlushAheadHigh+0.02 || math.Abs(beside) > p.FlushBeside+0.02 {
			t.Fatalf("flushed %.1f m ahead and %.1f m beside", ahead, beside)
		}
		if a.Start != 3000+p.FlushLead || a.Over != 77 || a.End <= a.Start {
			t.Fatalf("flush %+v", a)
		}
	}
	if share := float64(n) / float64(tries); math.Abs(share-p.FlushChance) > 0.03 {
		t.Errorf("flushed %.2f of the slots, the catalog's chance %.2f", share, p.FlushChance)
	}
	// Another boat flushes others.
	same := 0
	for sl := range int64(200) {
		a, okA := Flush(p, k, &g, 1<<40|7, sl, bow, 3000)
		b, okB := Flush(p, k, &g, 1<<40|8, sl, bow, 3000)
		if okA && okB && a == b || okA != okB {
			same++
		}
	}
	if same == 0 {
		t.Error("two boats flush alike")
	}
}
