// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The sea bed about an island. A sandy shore's profile is Dean's
// equilibrium profile, h = A x^(2/3) at x metres from the shore (Bruun
// 1954; Dean 1977, 1991), A by the sand: wide shallows off a sandy cay,
// steep water off a rocky one. Below the closure depth the shelf falls more
// steeply, to the deep. A tropical island has a fringing reef: a crest just
// awash, a flat behind it, the fore reef falling outside, and passes
// through it; a sandy one has bars in its shallows; a rocky or volcanic
// one has stacks standing off its coast.

// seabedOf sets the depth of each hexagon of the island's grid that is not
// land.
func (c *config) seabedOf(s stream, m *made, b *biome, w *work) {
	g := &m.grid
	total := g.w * g.h
	sb := &c.seabed
	deep := sb.Deep
	reach := min(sb.ReachBase+float64(sb.ReachPerRadius*m.radius), sb.ReachMost)
	a := max(b.dean, 0.01)
	closureAt := pow(sb.Closure/a, 1.5)
	noise := s.seed32()
	varies := s.seed32()
	var reef struct {
		on              bool
		at, crest, flat float64
		passes          [4]float64
		phase           [4]float64
		threshold       float64
	}
	if b.reef && m.kind != kindRock {
		reef.on = true
		reef.at = min(s.in(c.reef.Offshore[0], c.reef.Offshore[1]), float64(0.8*reach))
		reef.crest = s.in(c.reef.Crest[0], c.reef.Crest[1])
		reef.flat = s.in(c.reef.Flat[0], c.reef.Flat[1])
		for k := range reef.passes {
			reef.passes[k], reef.phase[k] = s.in(0.3, 1)/float64(k+1), s.angle()
		}
		var samples [360]float64
		for k := range samples {
			samples[k] = reefPass(&reef.passes, &reef.phase, float64(float64(k)*(2*math.Pi/360)))
		}
		slices.Sort(samples[:])
		reef.threshold = samples[min(359, round(float64(c.reef.Passes*360)))]
		m.reef = true
		m.lagoon = reef.at - physics.HexAcross
		m.reefAt = reef.at
	}
	var bar struct {
		on            bool
		at, high, wid float64
	}
	if b.bars {
		bar.on = true
		bar.at = s.in(40, 120)
		bar.high = s.in(0.8, 1.6)
		bar.wid = 14
		m.barAt = bar.at
	}
	dean := func(x float64) float64 {
		if x < closureAt {
			return float64(a * pow(max(x, 0.5), 2.0/3))
		}
		return sb.Closure + (x-closureAt)/sb.Shelf
	}
	for i := range total {
		if w.land[i] {
			continue
		}
		// From the coast's line, half a hexagon short of the land's
		// centres, stretched and squeezed along the coast so that the
		// shallows are not rings.
		px, py := g.centre(i)
		x := max(w.dout[i]-physics.HexAcross/2, 0.5)
		x = x / (1 + float64(sb.ReachVaries*fbm(float64(px/300), float64(py/300), varies, 0, 3)))
		d := dean(x)
		if reef.on {
			ang := physics.Atan2(px-m.x, py-m.y)
			pass := reefPass(&reef.passes, &reef.phase, ang) < reef.threshold
			half := float64(physics.HexAcross)
			switch {
			case x < reef.at-half:
				d = min(d, reef.flat)
			case x <= reef.at+half:
				d = reef.crest
				if pass {
					d = reef.flat + 1
				} else {
					m.crest = append(m.crest, i)
				}
			default:
				out := x - (reef.at + half)
				fore := lerp(smoothstep(0, c.reef.ForeWidth, out), reef.crest, c.reef.Fore)
				if pass {
					fore = max(fore, reef.flat+1)
				}
				d = max(fore, c.reef.Fore+(out-c.reef.ForeWidth)/sb.Shelf)
			}
		}
		if bar.on {
			e := (x - bar.at) / bar.wid
			d = max(d-float64(bar.high*physics.Exp(-float64(e*e))), min(d, 0.4))
			if math.Abs(x-bar.at) <= physics.HexAcross/2 {
				m.bar = append(m.bar, i)
			}
		}
		d = float64(d * (1 + float64(0.15*fbm(float64(px/90), float64(py/90), noise, 0, 3))))
		d = lerp(smoothstep(float64(0.65*reach), reach, x), d, deep)
		w.height[i] = -clamp(d, 0.1, deep)
	}
}

// reefPass is the smooth function of the direction from the island's
// centre whose low stretches are passes through its reef.
func reefPass(amp, phase *[4]float64, a float64) float64 {
	var sum float64
	for k := range amp {
		sum += float64(amp[k] * physics.Sin(float64(float64(k+1)*a)+phase[k]))
	}
	return sum
}

// stackReach is how far off its coast an island's stacks may stand, m.
const stackReach = 100

// stacksOf stands stacks off the island's coast: pillars of one to four
// hexagons, 3 to 25 m tall, in water within stackReach of its coast.
func (c *config) stacksOf(s stream, m *made, b *biome, w *work) {
	g := &m.grid
	n := s.pick(b.stacks[0], b.stacks[1])
	if m.kind == kindMain {
		n = s.pick(c.port.rocks[0], c.port.rocks[1])
	}
	if m.kind == kindRock || n == 0 {
		return
	}
	var spots []int32
	total := g.w * g.h
	for i := range total {
		if !w.land[i] && w.dout[i] >= 10 && w.dout[i] <= stackReach {
			spots = append(spots, i)
		}
	}
	if len(spots) == 0 {
		return
	}
	var nb [6]int32
	top := 0.0
	for i := range total {
		if w.land[i] {
			top = max(top, w.height[i])
		}
	}
	for range n {
		i := spots[s.r.IntN(len(spots))]
		if w.land[i] {
			continue
		}
		h := s.in(3, 25)
		if top > 0 {
			h = min(h, max(top, 3))
		}
		w.land[i], w.cliff[i], w.height[i] = true, true, h
		k := g.neighbours(i, &nb)
		for e := range s.pick(0, 3) {
			j := nb[e%k]
			if !w.land[j] {
				w.land[j], w.cliff[j] = true, true
				w.height[j] = max(float64(h*s.in(0.4, 0.9)), c.land[0])
			}
		}
		m.stacks++
	}
}
