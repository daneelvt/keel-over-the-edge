// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A volcanic island's cone, shaped as real cinder cones are: a fresh cone's
// height is 0.18 of its basal width and its crater 0.40 of it (Porter, GSA
// Bulletin 83, 1972; Wood, J. Volcanol. Geotherm. Res. 7, 1980); as it ages
// the first falls toward 0.10 and the second rises toward 0.83
// (Bloomfield 1975, as Parrot, MODSIM 2007, gives them). Its base is the
// island's coast, its flanks straight from the coast up to the crater's
// rim, no steeper than the ground's angle of repose, its crater a bowl, its
// floor dry ash. Each island's age is drawn from its stream. A young cone
// steams: fumaroles on its crater's rim and floor, "vents of steam and
// gas, a solfatara where sulphurous", the ground about them yellow with
// sulphur (the Sulfur Banks report); an old one is green to its rim.

// The ages, by the order of the catalog's weights.
const (
	ageYoung = iota
	ageMiddle
	ageOld
)

// ageNames are the ages as the records give them.
var ageNames = [3]string{"young", "middle", "old"}

// coneRays is how many bearings a cone's base is measured on.
const coneRays = 360

// coneWork is an island's cone: its centre, m east and north; its crater's
// width as a share of its base's; its age; and how far its coast is from
// its centre on each of coneRays bearings, m.
type coneWork struct {
	x, y   float64
	crater float64
	age    int
	base   [coneRays]float64
}

// measureBase measures the cone's base: on each bearing from its centre,
// how far the island's land runs before the first water.
func (k *coneWork) measureBase(g *islandGrid, w *work) {
	for r := range coneRays {
		sa, ca := sincos(float64(float64(r) * (2 * math.Pi / coneRays)))
		d := 0.0
		for ; d < 4000; d += 2 {
			q, rr := physics.HexAt(k.x+float64(d*sa), k.y+float64(d*ca))
			cc, jj := physics.HexCell(q, rr)
			cc, jj = cc-g.c0, jj-g.j0
			if cc < 0 || jj < 0 || cc >= g.w || jj >= g.h || !w.land[cc*g.h+jj] {
				break
			}
		}
		k.base[r] = max(d, physics.HexAcross)
	}
}

// coneShape is the cone's shape: its height and crater as shares of its
// base's width, and its crater's depth as a share of its height, at an
// age, between the fresh cone's and the old's.
func (c *config) coneShape(age int) (height, crater, depth float64) {
	t := float64(age) / 2
	f, o := &c.features.cone.Fresh, &c.features.cone.Old
	return lerp(t, f.Height, o.Height), lerp(t, f.Crater, o.Crater), lerp(t, f.Depth, o.Depth)
}

// drawAge is an island's age, by the catalog's weights.
func (c *config) drawAge(s stream) int {
	a := &c.features.cone.Ages
	return max(s.weighted([]float64{a.Young, a.Middle, a.Old}), 0)
}

// along is how far hexagon i of the grid is out from the cone's centre
// toward the coast, 0 at the centre and 1 at the coast: its distance from
// the centre over the base's on its bearing.
func (k *coneWork) along(g *islandGrid, w *work, i int32) float64 {
	x, y := g.centre(i)
	r := hypot(x-k.x, y-k.y)
	a := wrapAngle(physics.Atan2(x-k.x, y-k.y))
	n := min(int(toInt32(float64(a/(2*math.Pi))*coneRays)), coneRays-1)
	return min(r/k.base[n], 1)
}

// profile is the cone's height at a share t of the way from its centre to
// its coast, as a share of its rim's: its flank falls straight from the
// rim to the coast; inside the rim, its crater is a bowl depth deep.
func coneProfile(t, crater, depth float64) float64 {
	if t >= crater {
		return (1 - t) / max(1-crater, 1e-6)
	}
	u := t / max(crater, 1e-6)
	return (1 - depth) + float64(depth*float64(u*u))
}

// coneTop is the height a cone of the shape given stands on an island of
// the radius given, m: its share of its base's width, at most the land's
// highest, and no higher than its flanks can stand at the ground's angle
// of repose.
func (c *config) coneTop(radius, height, crater float64) float64 {
	repose := float64(0.95 * c.talus / physics.HexAcross)
	return min(float64(height*2*radius), c.land[1], float64(repose*float64((1-crater)*radius)))
}

// fumaroleSteam is how high a fumarole's steam is seen over its vent or
// its crater's rim, m.
const fumaroleSteam = 15

// fumarolesOf records island m's crater and, while it is young, its
// fumaroles: vents on its crater's floor and rim, apart from each other,
// with sulphur about each.
func (c *config) fumarolesOf(s stream, m *made, w *work) {
	k := m.cone
	if k == nil {
		return
	}
	g := &m.grid
	total := g.w * g.h
	ck := c.features.kind(catalog.FeatureSiteCrater, m.biome)
	_, crater, _ := c.coneShape(k.age)
	var inside []int32
	rim, centre, best := 0.0, int32(-1), 0.0
	for i := range total {
		if !w.own(i) {
			continue
		}
		t := k.along(g, w, i)
		if t <= crater+0.04 {
			inside = append(inside, i)
			rim = max(rim, w.height[i])
		}
		if x, y := g.centre(i); centre < 0 || hypot(x-k.x, y-k.y) < best {
			centre, best = i, hypot(x-k.x, y-k.y)
		}
	}
	if centre < 0 || len(inside) == 0 {
		return
	}
	if ck >= 0 {
		m.addFeature(ck, centre, 0, float64(float64(crater*2)*m.radius), rim)
	}
	fk := c.features.kind(catalog.FeatureSiteFumarole, m.biome)
	if k.age != ageYoung || fk < 0 {
		return
	}
	cf := &c.features.cone
	n := s.pick(cf.Fumaroles[0], cf.Fumaroles[1])
	var vents []int32
	for range 8 * n {
		if len(vents) >= n {
			break
		}
		i := inside[s.r.IntN(len(inside))]
		x, y := g.centre(i)
		apart := true
		for _, v := range vents {
			if vx, vy := g.centre(v); hypot(x-vx, y-vy) < 12 {
				apart = false
			}
		}
		if apart {
			vents = append(vents, i)
		}
	}
	if len(vents) == 0 {
		return
	}
	f := m.addFeature(fk, vents[0], 0, float64(len(vents)), w.height[vents[0]])
	// Its steam is seen over the rim.
	f.seen = max(w.height[vents[0]], rim) + fumaroleSteam
	for _, v := range vents {
		x, y := g.centre(v)
		f.parts = append(f.parts, Part{X: x, Y: y, Level: w.height[v], Size: s.in(1.5, 4), Seed: uint8(s.r.IntN(256))})
		for i := range total {
			if ix, iy := g.centre(i); w.own(i) && hypot(ix-x, iy-y) <= cf.Sulphur {
				m.sulphur = append(m.sulphur, i)
			}
		}
	}
}
