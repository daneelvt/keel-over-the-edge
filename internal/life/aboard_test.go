// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// percher is the index of the first kind that perches on boats.
func percher(t *testing.T, s *Schedule) int {
	t.Helper()
	for i := range s.kinds {
		if s.kinds[i].Perches() {
			return i
		}
	}
	t.Fatal("no kind perches on boats")
	return -1
}

// skySchedule is a schedule of the test world under the catalog's sky.
func skySchedule(t *testing.T, seed uint64) *Schedule {
	t.Helper()
	cat := testCatalog(t)
	p, kinds := Prepare(cat)
	return NewSchedule(&Config{Params: p, Kinds: kinds, Habitat: NewHabitat(p, testGround(), testPlaces, testDisk), Seed: seed,
		Sky: cat.PrepareSky(), Epoch: 1_793_577_600_000_000})
}

// TestPerch: a booby that perches takes the nearest boat within its range,
// whatever her speed or course, and keeps to her for its stay; with no boat
// in range it is not met; the boat is quiet after; a booby whose boat goes
// flies on alone.
func TestPerch(t *testing.T) {
	s := testSchedule(t, 4)
	k := percher(t, s)
	kind := &s.kinds[k]
	w := NewWorld(s, 4)
	f := sailing(900_000, -3000, -3000, 0.5)
	sail(w, f, 2)
	w.Raise(f, k, f.State[0].X+0.8*kind.Range, f.State[0].Y)
	e := raised(f)
	if e == nil || e.Boat != 1 || e.Kind != uint16(k) {
		t.Fatalf("a booby within its range of a slow boat did not take her: %+v", e)
	}
	stay := Stay(kind, e.Seed)
	if want := e.Start + lifeTicks(float64(2*kind.Arrive(e.Speed))+stay); e.End != want {
		t.Errorf("ends at %d, want %d (in, its stay, out)", e.End, want)
	}
	if w.boats[0].quiet != e.End+s.p.Quiet {
		t.Errorf("the boat is quiet until %d, want %d", w.boats[0].quiet, e.End+s.p.Quiet)
	}
	// Out of range of any boat, none is met.
	before := len(f.Life)
	w.Raise(f, k, f.State[0].X+2*kind.Range, f.State[0].Y)
	if len(f.Life) != before {
		t.Errorf("a booby with no boat in range was met: %+v", f.Life[len(f.Life)-1])
	}
	// Her boat gone, it flies on alone.
	sail(w, f, 30)
	f.Unseen[0] = true
	sail(w, f, 1)
	if got := byID(f, e.ID); got == nil || got.Boat != 0 || got.Rev != 1 {
		t.Errorf("its boat gone: %+v", got)
	}
}

// TestRaiseAboard: a fish raised aboard lands on the nearest boat within
// 300 m and lies there its stay; gone at once when its boat is.
func TestRaiseAboard(t *testing.T) {
	s := testSchedule(t, 4)
	w := NewWorld(s, 4)
	f := sailing(900_000, -3000, -3000, 3)
	sail(w, f, 2)
	if w.RaiseAboard(f, f.State[0].X+400, f.State[0].Y) {
		t.Fatal("a fish landed on a boat 400 m off")
	}
	if !w.RaiseAboard(f, f.State[0].X+10, f.State[0].Y) {
		t.Fatal("no fish landed on a boat 10 m off")
	}
	e := f.Life[len(f.Life)-1]
	if !Aboard(&e) || e.Boat != 1 || e.Kind != uint16(s.p.AboardKind) || e.End-e.Start != s.p.AboardStay {
		t.Fatalf("landed %+v", e)
	}
	sail(w, f, 30)
	if byID(f, e.ID) == nil {
		t.Fatal("gone a second after it landed")
	}
	f.Unseen[0] = true
	sail(w, f, 1)
	if byID(f, e.ID) != nil {
		t.Error("still aboard a boat gone")
	}
}

// TestAboardAtNight: under the sky, fish land aboard boats sailing at
// night over water their kind lives in, now and then, and never by day,
// nor on a boat at rest; the same boat and slot always draw the same.
func TestAboardAtNight(t *testing.T) {
	s := skySchedule(t, 4)
	night, day := int64(-1), int64(-1)
	for tick := int64(0); tick < 4*3600*physics.StepsPerSecond && (night < 0 || day < 0); tick += 60 * physics.StepsPerSecond {
		if a := s.Sun(tick, -3000, -3000); a < -0.1 && night < 0 {
			night = tick
		} else if a > 0.3 && day < 0 {
			day = tick
		}
	}
	if night < 0 || day < 0 {
		t.Fatal("no night and day in four hours")
	}
	count := func(start int64, speed float64) int {
		w := NewWorld(s, 4)
		f := sailing(start, -3000, -3000, speed)
		n := 0
		for range 40 * physics.StepsPerSecond * 60 / s.p.AboardEvery {
			f.Tick += s.p.AboardEvery
			f.State[0].X = -3000
			w.Tick(f, steady{wind: 6})
			for i := range f.Life {
				if Aboard(&f.Life[i]) && f.Life[i].Start == f.Tick {
					n++
					if s.Sun(f.Tick, f.State[0].X, f.State[0].Y) >= 0 {
						t.Errorf("a fish aboard with the sun up at %d", f.Tick)
					}
				}
			}
		}
		return n
	}
	// Forty minutes of night at the catalog's chance a minute.
	if n := count(night, 3); n < 1 && s.p.AboardChance*40 > 3 {
		t.Errorf("no fish aboard in forty minutes of night at %.3f a minute", s.p.AboardChance)
	}
	count(day, 3)
	if n := count(night, 0.5); n != 0 {
		t.Errorf("%d fish aboard a boat at rest", n)
	}
	a, b := aboardDraws(7, 12345), aboardDraws(7, 12345)
	if a != b || a == aboardDraws(8, 12345) {
		t.Error("the draws are not of the boat and the slot")
	}
}

// TestDark: glowing water shows on a dark night only, under the sky.
func TestDark(t *testing.T) {
	s := skySchedule(t, 4)
	var glow *Kind
	for i := range s.kinds {
		if s.kinds[i].GlowMoon > 0 {
			glow = &s.kinds[i]
		}
	}
	if glow == nil {
		t.Fatal("no glowing water in the catalog")
	}
	dark, light := 0, 0
	for tick := int64(0); tick < 30*24*3600*physics.StepsPerSecond; tick += 600 * physics.StepsPerSecond {
		if s.Dark(glow, tick, 0, 0) {
			dark++
			if s.Sun(tick, 0, 0) >= 0 {
				t.Fatalf("dark with the sun up at %d", tick)
			}
		} else if s.Sun(tick, 0, 0) < -0.1 {
			light++
		}
	}
	if dark == 0 || light == 0 {
		t.Errorf("of the nights, %d samples dark and %d moonlit", dark, light)
	}
}
