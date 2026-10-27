// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"math"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The land wake in seed 1's world: along the track as well as the heading,
// and as the water under the boat shoals.

// shoalEdge is where shoal water begins on the way from the roads to the
// nearest of it: its bearing from the roads, rad, and its range, m.
func (sc *scene) shoalEdge() (physics.State, float64, float64) {
	sc.t.Helper()
	at := sc.roads()
	for r := 20.0; r < 3000; r += 2 {
		for k := range 128 {
			b := float64(k) * 2 * math.Pi / 128
			sin, cos := physics.SinCos(b)
			if e, _ := sc.sea.Ground.At(at.X+sin*r, at.Y+cos*r); e > -shoal {
				return at, b, r
			}
		}
	}
	sc.t.Fatal("no shoal water within 3 km of the roads")
	return at, 0, 0
}

// waitLand waits as observe would for the land wake of the machine
// sailor's boat in slot sl, for up to seconds, and returns why it woke and
// after how long, or "" for nothing.
func (sc *scene) waitLand(sl int32, seconds float64) (string, float64) {
	h := sc.core.helmOf(sailor(byte(sl)+1, "Iron Mary"))
	w := newWaiter(time.Now(), []string{wakeLand})
	for i := range int(seconds * physics.StepsPerSecond) {
		if i%checkEvery == 0 {
			f := sc.w.Bus().Frames.Acquire()
			h.mu.Lock()
			h.sea, h.slot, h.boat = sc.sea, sl, f.Boat[sl]
			why := h.watch(sc.sea, f, sl, w, false)
			h.mu.Unlock()
			f.Release()
			if why != "" {
				return why, float64(i) / physics.StepsPerSecond
			}
		}
		sc.w.Tick()
	}
	return "", seconds
}

// A boat head to wind, blown astern toward shoal water, its bow away from
// it, is woken before it reaches it, told where the shoal lies.
func TestWokenDriftingAstern(t *testing.T) {
	sc := newScene(t, 2, 0)
	at, b, r := sc.shoalEdge()
	sc = newScene(t, 14, math.Mod(b*180/math.Pi+180, 360))
	sin, cos := physics.SinCos(b)
	st := at
	st.X, st.Y = at.X+sin*(r-60), at.Y+cos*(r-60)
	st.Heading, st.SheetLimit = wrap(b+math.Pi), 1.6
	me := sc.boat(st, true)
	why, after := sc.waitLand(me, 60)
	f := sc.w.Latest()
	e, _ := sc.sea.Ground.At(f.State[me].X, f.State[me].Y)
	t.Logf("woke after %.1f s, in %.1f m: %q", after, -e, why)
	if !strings.HasPrefix(why, "shoal water ") && !strings.HasPrefix(why, "land ") || !strings.HasSuffix(why, " m") {
		t.Fatalf("blown astern onto shoal water: woke for %q", why)
	}
	if -e < shoal {
		t.Errorf("woken only in %.1f m of water", -e)
	}
}

// A boat in shoal water as its wait begins, sailing onto shallower, is
// woken as it shoals; one lying on a bank is not woken by it, wait after
// wait.
func TestWokenAsItShoals(t *testing.T) {
	sc := newScene(t, 2, 0)
	at, b, r := sc.shoalEdge()
	sin, cos := physics.SinCos(b)
	st := at
	st.X, st.Y = at.X+sin*(r+2), at.Y+cos*(r+2)
	st.Heading, st.Surge = b, 1.5
	me := sc.boat(st, true)
	why, after := sc.waitLand(me, 30)
	t.Logf("sailing onto the shoal: woke after %.1f s: %q", after, why)
	if !strings.HasPrefix(why, "shoal water under you") {
		t.Fatalf("sailing onto shallower water: woke for %q", why)
	}

	// At rest on the bank, wait after wait.
	sc = newScene(t, 2, 0)
	var bank physics.State
	for d := 20.0; d < 3000 && bank.X == 0; d += 4 {
		for k := range 128 {
			sin, cos := physics.SinCos(float64(k) * 2 * math.Pi / 128)
			if e, _ := sc.sea.Ground.At(at.X+sin*d, at.Y+cos*d); e < -0.05 && e > -0.5 {
				bank = at
				bank.X, bank.Y = at.X+sin*d, at.Y+cos*d
				break
			}
		}
	}
	me = sc.boat(bank, true)
	for i := range 3 {
		if why, _ := sc.waitLand(me, 10); why != "" {
			t.Errorf("lying on a bank, wait %d: woke for %q", i, why)
		}
	}
}

// A tack ordered at rest in 3 knots, the sheet eased, stalls: the helm is
// told so, waking a wait on the pilot, and the report says what the
// autopilot holds; the same order again tacks again.
func TestATackStalls(t *testing.T) {
	sc := newScene(t, 3, 0)
	st := sc.start()
	st.X, st.Y, st.Heading, st.Surge = 1500, -1500, wrap(rad(-45)), 0
	me := sc.boat(st, true)
	sc.steer(me, 45, 50)
	h := sc.core.helmOf(sailor(byte(me)+1, "Iron Mary"))
	f := sc.w.Latest()
	h.mu.Lock()
	h.sea, h.slot, h.boat = sc.sea, me, f.Boat[me]
	h.mu.Unlock()
	w := newWaiter(time.Now(), []string{wakePilot})
	h.wait(w)
	order := func() written {
		f := sc.w.Bus().Frames.Acquire()
		defer f.Release()
		a := 45
		wr, refused := h.steer(sc.sea, f, me, &steerOrder{WindAngle: &a, Side: sidePort, Via: viaTack})
		if refused != "" {
			t.Fatal(refused)
		}
		return wr
	}
	look := func(seconds float64) {
		for i := range int(seconds * physics.StepsPerSecond) {
			sc.w.Tick()
			if i%checkEvery == 0 {
				f := sc.w.Bus().Frames.Acquire()
				h.look(sc.sea, f, false)
				f.Release()
			}
		}
	}
	look(1)
	if wr := order(); wr.turning != viaTack {
		t.Fatalf("the tack: %+v", wr)
	}
	look(12)
	select {
	case why := <-w.done:
		if why != "pilot" {
			t.Errorf("woke for %q", why)
		}
	default:
		t.Fatal("the stall woke no wait on the pilot")
	}
	evs, _ := h.ring.after(0)
	if len(evs) == 0 || evs[len(evs)-1].Kind != evStalled || !strings.Contains(evs[len(evs)-1].Words, "tack stalled") {
		t.Fatalf("the events: %+v", evs)
	}
	text, r := sc.reportOf(me, detailBrief)
	if !strings.HasPrefix(r.Pilot.Holds, "wind 4") || !strings.HasSuffix(r.Pilot.Holds, "° starboard, tack stalled") {
		t.Errorf("after the stall:\n%s", text)
	}
	if wr := order(); wr.already || wr.turning != viaTack {
		t.Errorf("the same tack again: %+v", wr)
	}
}
