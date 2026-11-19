// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// A polar of two winds and three angles, its numbers easy to read between.
func smallPolar() *Polar {
	return &Polar{
		Winds:  []float64{10, 20},
		Angles: []float64{40, 90, 140},
		Speeds: [][]float64{{2, 4, 3}, {4, 8, 6}},
		Up:     [][2]float64{{40, 1.5}, {40, 3}},
		Down:   [][2]float64{{140, 2.3}, {140, 4.6}},
	}
}

func polarNear(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

// The table is read between its winds and its angles, either side of the
// wind, and nothing closer to the wind than its first angle.
func TestPolarSpeed(t *testing.T) {
	p := smallPolar()
	deg := math.Pi / 180
	for _, c := range []struct {
		knots, angle, want float64
	}{
		{10, 90, 4}, {20, 90, 8}, {15, 90, 6}, {10, 65, 3}, {15, 115, 5.25}, {10, -90, 4}, {10, 270, 4},
		{30, 90, 8}, {5, 90, 2}, {10, 30, 0}, {10, 180, 3},
	} {
		got := p.Speed(c.knots*Knot, c.angle*deg) / Knot
		if !polarNear(got, c.want) {
			t.Errorf("%v knots at %v°: %v knots, want %v", c.knots, c.angle, got, c.want)
		}
	}
	if got := p.VMG(10*Knot, 140*deg) / Knot; !polarNear(got, 3*math.Cos(140*deg)) {
		t.Errorf("VMG at 140° in 10 knots: %v knots", got)
	}
	var none *Polar
	if none.Speed(5, 1) != 0 {
		t.Error("no polar sails")
	}
}

// A leg closer to the wind than the best angle up it is beaten, one
// further off it run at the best angle down it, the rest sailed straight.
func TestPolarLegTime(t *testing.T) {
	p := smallPolar()
	deg := math.Pi / 180
	tws := 10 * Knot
	// Dead to windward: 1 NM made good at 1.5 knots, an hour less a fifth.
	if got := p.LegTime(tws, 0, 1852); !polarNear(got, 3600/1.5) {
		t.Errorf("dead to windward: %v s", got)
	}
	// 20° off: the same VMG, the leg's share toward the wind.
	if got := p.LegTime(tws, 20*deg, 1852); !polarNear(got, 3600/1.5*math.Cos(20*deg)) {
		t.Errorf("20° off the wind: %v s", got)
	}
	if !p.Beats(tws, 20*deg) || p.Beats(tws, 60*deg) {
		t.Error("a beat is closer to the wind than the best angle up it")
	}
	// Abeam: straight at 4 knots.
	if got := p.LegTime(tws, 90*deg, 1852); !polarNear(got, 3600/4.0) {
		t.Errorf("abeam: %v s", got)
	}
	// Dead downwind: made good at 2.3 knots.
	if got := p.LegTime(tws, math.Pi, 1852); !polarNear(got, 3600/2.3) {
		t.Errorf("dead downwind: %v s", got)
	}
	up, vmg := p.BestUp(15 * Knot)
	if !polarNear(up, 40*deg) || !polarNear(vmg, 2.25*Knot) {
		t.Errorf("best up in 15 knots: %v rad at %v m/s", up, vmg)
	}
}
