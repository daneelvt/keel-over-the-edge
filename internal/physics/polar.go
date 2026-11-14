// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// A boat's polar: her steady speed in flat water by the true wind's speed
// and its angle off her heading, as the catalog's tables hold it
// (tools/polar sails them), and the speeds she makes good up and down the
// wind. A race's legs, its expected times and its checks are worked out
// from it on the server, with the float rules of the physics, the same on
// every machine.

// Polar is one boat's table: Speeds[i][j] her speed in Winds[i] at
// Angles[j], 0 where she cannot sail; Up[i] and Down[i] her best angle up
// and down the wind in Winds[i] and the speed she makes good toward or
// away from it there. The winds and the angles are evenly spaced and
// ascending; the winds are 10 m up. Units are the table's: knots and
// degrees. Use its methods, in m/s and radians.
type Polar struct {
	Winds  []float64
	Angles []float64
	Speeds [][]float64
	Up     [][2]float64
	Down   [][2]float64
}

// knotsPerMS is a knot's m/s, inverted.
const knotsPerMS = 3600 / 1852.0

// Knot is a knot, m/s.
const Knot = 1852 / 3600.0

// axisAt is where v lies along an evenly spaced, ascending axis: the index
// below it and how far toward the next, clamped to the axis.
func axisAt(axis []float64, v float64) (int, float64) {
	n := len(axis)
	if n < 2 || !(v > axis[0]) {
		return 0, 0
	}
	if v >= axis[n-1] {
		return n - 2, 1
	}
	step := (axis[n-1] - axis[0]) / float64(n-1)
	f := (v - axis[0]) / step
	i := min(int(toInt32(math.Floor(f))), n-2)
	return i, f - float64(i)
}

// lerpAt is a + t(b − a).
func lerpAt(t, a, b float64) float64 { return a + float64(t*(b-a)) }

// windAt is where a true wind of tws m/s lies along the table's winds, and
// the share of the lightest wind's speed a lighter one gives: below the
// table, a boat's speed falls with the wind.
func (p *Polar) windAt(tws float64) (int, float64, float64) {
	kn := float64(tws * knotsPerMS)
	scale := 1.0
	if len(p.Winds) > 0 && kn < p.Winds[0] && p.Winds[0] > 0 {
		scale = max(kn, 0) / p.Winds[0]
	}
	i, f := axisAt(p.Winds, kn)
	return i, f, scale
}

// Speed is her speed through the water, m/s, in a true wind of tws m/s
// at twa radians off her heading, either side: the table's, read between
// its winds and angles; 0 closer to the wind than its first angle.
func (p *Polar) Speed(tws, twa float64) float64 {
	if p == nil || len(p.Speeds) == 0 {
		return 0
	}
	deg := float64(math.Abs(wrapAngle(twa)) * (180 / math.Pi))
	if len(p.Angles) == 0 || deg < p.Angles[0] {
		return 0
	}
	i, f, scale := p.windAt(tws)
	j, g := axisAt(p.Angles, deg)
	lo := rowAt(p.Speeds[i], j, g)
	hi := lo
	if i+1 < len(p.Speeds) {
		hi = rowAt(p.Speeds[i+1], j, g)
	}
	return float64(float64(lerpAt(f, lo, hi)*scale) * Knot)
}

// rowAt is a row of the table read g of the way from column j to the next.
func rowAt(r []float64, j int, g float64) float64 {
	if j+1 >= len(r) {
		return r[len(r)-1]
	}
	return lerpAt(g, r[j], r[j+1])
}

// VMG is the speed she makes good toward the true wind of tws m/s, m/s,
// at twa radians off it; negative away from it.
func (p *Polar) VMG(tws, twa float64) float64 {
	_, c := SinCos(twa)
	return float64(p.Speed(tws, twa) * c)
}

// best is a best angle and speed made good in a true wind of tws m/s, from
// the table's rows: radians and m/s.
func (p *Polar) best(rows [][2]float64, tws float64) (float64, float64) {
	if p == nil || len(rows) == 0 {
		return 0, 0
	}
	i, f, scale := p.windAt(tws)
	lo := rows[min(i, len(rows)-1)]
	hi := rows[min(i+1, len(rows)-1)]
	angle := lerpAt(f, lo[0], hi[0])
	made := float64(lerpAt(f, lo[1], hi[1]) * scale)
	return float64(angle * (math.Pi / 180)), float64(made * Knot)
}

// BestUp is her best angle off the true wind of tws m/s to sail toward it,
// radians, and the speed she makes good toward it there, m/s.
func (p *Polar) BestUp(tws float64) (twa, vmg float64) { return p.best(p.Up, tws) }

// BestDown is her best angle off the true wind of tws m/s to sail away from
// it, radians, and the speed she makes good away from it there, m/s.
func (p *Polar) BestDown(tws float64) (twa, vmg float64) { return p.best(p.Down, tws) }

// LegTime is how long she takes to make good length m in a true wind of
// tws m/s whose direction is twa radians off the leg's: beating at her best
// angle up the wind if the leg lies closer to it, running at her best angle
// down it if the leg lies further off, else sailing the leg straight. +Inf
// if she cannot make way.
func (p *Polar) LegTime(tws, twa, length float64) float64 {
	a := math.Abs(wrapAngle(twa))
	_, c := SinCos(a)
	if up, vmg := p.BestUp(tws); a < up {
		if !(vmg > 0) {
			return math.Inf(1)
		}
		return float64(length*c) / vmg
	}
	if down, vmg := p.BestDown(tws); a > down {
		if !(vmg > 0) {
			return math.Inf(1)
		}
		return float64(length*-c) / vmg
	}
	v := p.Speed(tws, a)
	if !(v > 0) {
		return math.Inf(1)
	}
	return length / v
}

// Beats reports whether a leg whose direction is twa radians off the true
// wind of tws m/s is a beat for her: closer to the wind than her best angle
// up it, so that she must tack.
func (p *Polar) Beats(tws, twa float64) bool {
	up, _ := p.BestUp(tws)
	return math.Abs(wrapAngle(twa)) < up
}
