// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"fmt"
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A fog bank's wall: a bank seen from outside is its depth edge-on, a
// whitening of the horizon toward it before it brings very poor
// visibility. The horizon toward a bank whitens where its own fog along
// the horizontal ray from an eye 2 m up toward its centre reaches an
// optical depth of 1. A boat sailing toward a bank at its strongest, at the
// 4 knots a sailor in light air makes, from each of eight ways, has that
// warning before very poor visibility: three minutes or more at nineteen
// approaches in twenty. And at each place a bank brings very poor
// visibility, as it drifts and grows, the same warning is tallied for a
// boat lying there; it is shorter, since a bank grows where it lies.

// fogWarning is the least warning a fog bank's wall gives at nineteen
// places in twenty, minutes; wallDepth the optical depth of the bank's own
// fog along the ray at which the horizon is taken to whiten; wallRay how
// far the ray is followed, m: beyond it, it is a kilometre up.
const (
	fogWarning = 3
	wallDepth  = 1
	wallRay    = 3000
)

// fogWall is the tally of the banks' walls: how many banks; of the
// approaches that met very poor visibility, how many, at how many the wall
// gave less than its warning, and the warnings, minutes; and the same at
// the places a bank brought it to as it grew and drifted.
type fogWall struct {
	banks, approaches, short, places, placesShort int
	leads, placeLeads                             []float64
}

// fogVisibility is the visibility at (x, y), 2 m up, in the clear air and
// the bank's fog alone, the mist band's left out: a boat sailing in from
// beyond the lip meets the bank's, not the mist's.
func fogVisibility(p *physics.WeatherPrepared, own *physics.WeatherTick, x, y float64) float64 {
	return p.Contrast() / (p.ClearExtinction() + physics.FogAt(own, x, y, 2))
}

// approachSpeed is how fast a boat sails toward a bank, m/s: 4 knots.
const approachSpeed = 4 * nauticalMile / 3600

// wallSeen reports whether the horizon toward (cx, cy) whitens from (x, y)
// in the weather own, beside the weather empty without the bank: the bank's
// own fog along the horizontal ray 2 m up toward it, over the dome.
func wallSeen(own, empty *physics.WeatherTick, dome, x, y, cx, cy, hs, hc float64) bool {
	ux, uy := cx-x, cy-y
	d := math.Hypot(ux, uy)
	if d < 1 {
		ux, uy, d = hs, hc, 1
	}
	ux, uy = ux/d, uy/d
	x1, y1, h1 := x+wallRay*ux, y+wallRay*uy, 2+wallRay*wallRay/(2*dome)
	return physics.OpticalDepth(own, x, y, 2, x1, y1, h1)-physics.OpticalDepth(empty, x, y, 2, x1, y1, h1) >= wallDepth
}

// checkFogWall tallies the week's fog banks' walls on a grid step apart
// over the disk, inside the mist band, every half minute of each bank's
// life, each bank alone in still air.
func checkFogWall(cat *catalog.Catalog, tl *Timeline, w *Week, step float64, tally *weeksTally) {
	p := tl.Prepared()
	dome := cat.World.Handout.Dome
	inside := 0.9 * float64(cat.World.Disk.Mist*nauticalMile)
	veryPoor := cat.Weather.Visibility.Words[0]
	empty := &physics.WeatherTick{}
	physics.WeatherAt(&physics.Weather{Prepared: p}, empty, 0)
	type place struct {
		x, y       float64
		wall, poor int64
	}
	for _, s := range w.Systems {
		r := &s.SystemRecord
		if cat.Weather.Systems[int(r.Kind)].Fog == nil {
			continue
		}
		tally.fog.banks++
		// Approaches at its strongest, from eight ways.
		best, strongest := int64(r.Born), 0.0
		for tick := int64(r.Born); tick < int64(r.Gone); tick += ticksPerMinute / 2 {
			if k := physics.SystemAt(r, float64(tick)); k.Strength > strongest {
				best, strongest = tick, k.Strength
			}
		}
		own := stormOnly(tl, best, s.Slot)
		k := physics.SystemAt(r, float64(best))
		cx, cy := k.East/4, k.North/4
		heading := k.Heading * (2 * math.Pi / turn)
		hs, hc := physics.SinCos(heading)
		for way := range 8 {
			ws, wc := physics.SinCos(heading + float64(way)*math.Pi/4)
			wall, poor := -1.0, -1.0
			for d := r.Size*4 + wallRay; d > 0; d -= 10 {
				x, y := cx+d*ws, cy+d*wc
				if wall < 0 && wallSeen(own, empty, dome, x, y, cx, cy, hs, hc) {
					wall = d
				}
				if fogVisibility(p, own, x, y) < veryPoor {
					poor = d
					break
				}
			}
			if poor < 0 {
				continue
			}
			tally.fog.approaches++
			lead := math.Inf(-1)
			if wall >= 0 {
				lead = (wall - poor) / approachSpeed / 60
			}
			tally.fog.leads = append(tally.fog.leads, lead)
			if lead < fogWarning {
				tally.fog.short++
			}
		}
		// At the places it brings very poor visibility to as it grows and
		// drifts, a boat lying there.
		var places []place
		for x := -inside; x <= inside; x += step {
			for y := -inside; y <= inside; y += step {
				if math.Hypot(x, y) <= inside {
					places = append(places, place{x: x, y: y, wall: -1, poor: -1})
				}
			}
		}
		for tick := int64(r.Born); tick < int64(r.Gone); tick += ticksPerMinute / 2 {
			own := stormOnly(tl, tick, s.Slot)
			k := physics.SystemAt(r, float64(tick))
			cx, cy := k.East/4, k.North/4
			hs, hc := physics.SinCos(k.Heading * (2 * math.Pi / turn))
			for i := range places {
				pl := &places[i]
				if pl.poor >= 0 {
					continue
				}
				if pl.wall < 0 && wallSeen(own, empty, dome, pl.x, pl.y, cx, cy, hs, hc) {
					pl.wall = tick
				}
				if fogVisibility(p, own, pl.x, pl.y) < veryPoor {
					pl.poor = tick
				}
			}
		}
		for _, pl := range places {
			if pl.poor < 0 {
				continue
			}
			tally.fog.places++
			lead := math.Inf(-1)
			if pl.wall >= 0 {
				lead = float64(pl.poor-pl.wall) / ticksPerMinute
			}
			tally.fog.placeLeads = append(tally.fog.placeLeads, lead)
			if lead < fogWarning {
				tally.fog.placesShort++
			}
		}
	}
}

// fogMarkdown is the fog's wall's part of the tally.
func (t *weeksTally) fogMarkdown() string {
	f := &t.fog
	if f.approaches == 0 {
		return ""
	}
	return fmt.Sprintf("\nA fog bank's wall, the horizon toward it whitening (its own fog's optical depth %d along the horizontal ray 2 m up), before very poor visibility.\n\n"+
		"| Where | Banks | Cases | Warning: 10th percentile, median | Share under %d min |\n|---|---|---|---|---|\n"+
		"| Sailing toward it at 4 knots, at its strongest, from eight ways | %d | %d | %.1f, %.1f min | %.1f%% |\n"+
		"| Lying at a place it reaches as it grows and drifts | %d | %d | %.1f, %.1f min | %.1f%% |\n",
		wallDepth, fogWarning, f.banks, f.approaches, percentile(f.leads, 0.1), percentile(f.leads, 0.5), share(f.short, f.approaches),
		f.banks, f.places, percentile(f.placeLeads, 0.1), percentile(f.placeLeads, 0.5), share(f.placesShort, f.places))
}
