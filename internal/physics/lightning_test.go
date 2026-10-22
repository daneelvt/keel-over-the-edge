// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// A squall flashes only at or above its kind's strength, at its rate
// there over many slots: none below, its catalog's rate at full strength
// and half of it halfway; each flash struck within its ring, a quarter to
// the sea, a third of a single stroke and 3.67 strokes in the mean, its
// strokes 60 ms apart at the geometric mean.
func TestFlashes(t *testing.T) {
	p, kinds := testSystems(t)
	k := &p.kinds[kinds["squall"]].lightning
	slots := 30000.0
	for _, c := range []struct {
		strength float64
		rate     float64 // a minute
	}{
		{k.above - 0.01, 0},
		{1, k.rate},
		{(1 + k.above) / 2, k.rate / 2},
	} {
		sq := systemAt(kinds["squall"], 500, -300, 60, 0.5*nm, 16, 3)
		sq.Strength = math.Round(c.strength * strengthSteps)
		sq.Seed = 777
		tk, _ := tickOf(p, worldTick, map[int]System{0: sq})
		st := &tk.sys[0]
		var out [MaxFlashes]Flash
		n, sea, single, strokes := 0, 0, 0, 0
		logGap, gaps := 0.0, 0
		for slot := range int(slots) {
			m := Flashes(tk, float64(slot), out[:])
			for _, f := range out[:m] {
				n++
				r := math.Hypot(f.East-st.cx, f.North-st.cy)
				if r > 0.42*st.size*(1+1e-9) {
					t.Fatalf("a flash %.0f m from the squall's centre, beyond its core", r)
				}
				if f.Tick < float64(slot)*p.SlotTicks() || f.Tick >= float64(slot+1)*p.SlotTicks() {
					t.Fatalf("slot %d's flash at tick %g", slot, f.Tick)
				}
				if f.Sea == 1 {
					sea++
				}
				strokes += int(f.Strokes)
				if f.Strokes == 1 {
					single++
				}
				if f.Strokes > MaxStrokes || f.Strokes < 1 {
					t.Fatalf("%g strokes", f.Strokes)
				}
				for j := 1; j < int(f.Strokes); j++ {
					gap := f.Stroke[j] - f.Stroke[j-1]
					if !(gap >= 0.03-1e-12 && gap <= 0.12+1e-12) {
						t.Fatalf("strokes %.3f s apart", gap)
					}
					logGap += math.Log(gap)
					gaps++
				}
			}
		}
		perMinute := float64(n) / (slots * p.vis.slotSeconds / 60)
		if c.rate == 0 {
			if n != 0 {
				t.Errorf("strength %.2f, under %.2f: %d flashes", c.strength, k.above, n)
			}
			continue
		}
		// Three standard deviations of a count of that many slots.
		chance := c.rate * p.vis.slotSeconds / 60
		spread := 3 * math.Sqrt(slots*chance*(1-chance)) / (slots * p.vis.slotSeconds / 60)
		if math.Abs(perMinute-c.rate) > spread {
			t.Errorf("strength %.2f: %.3f flashes a minute, want %.3f ± %.3f", c.strength, perMinute, c.rate, spread)
		}
		if s := float64(sea) / float64(n); math.Abs(s-0.25) > 0.02 {
			t.Errorf("%.3f of flashes to the sea, want 0.25", s)
		}
		if s := float64(single) / float64(n); math.Abs(s-0.33) > 0.02 {
			t.Errorf("%.3f of flashes single, want 0.33", s)
		}
		if m := float64(strokes) / float64(n); math.Abs(m-3.67) > 0.1 {
			t.Errorf("%.2f strokes in the mean, want 3.67", m)
		}
		if g := math.Exp(logGap / float64(gaps)); math.Abs(g-0.06) > 0.002 {
			t.Errorf("strokes %.4f s apart at the geometric mean, want 0.06", g)
		}
	}
}

// A storm's flashes strike in its outer bands, and the same slot gives the
// same flash.
func TestFlashesStorm(t *testing.T) {
	p, kinds := testSystems(t)
	storm := systemAt(kinds["storm"], -3000, 2000, 300, 2*nm, 22, 15)
	tk, _ := tickOf(p, worldTick, map[int]System{3: storm})
	st := &tk.sys[0]
	var a, b [MaxFlashes]Flash
	n := 0
	for slot := range 5000 {
		m := Flashes(tk, float64(slot), a[:])
		if Flashes(tk, float64(slot), b[:]) != m || a != b {
			t.Fatalf("slot %d gave two flashes", slot)
		}
		for _, f := range a[:m] {
			n++
			r := math.Hypot(f.East-st.cx, f.North-st.cy) / st.size
			if r < 0.7-1e-9 || r > 1.3+1e-9 || f.Slot != 3 || f.Base != 350 {
				t.Fatalf("a storm's flash at %.2f of its size, slot %g, base %g", r, f.Slot, f.Base)
			}
		}
	}
	if n < 1000 {
		t.Errorf("%d flashes in 5,000 slots", n)
	}
}
