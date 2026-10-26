// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The gust ring, part of the wind overlay: a ring on the water round each
// gust heading for the boat. The gust field the boat feels is sampled on a
// grid upwind of the boat, the catalog's depth up the mean wind and its
// width across it at its spacing; its patches of strong gust are found,
// each set of neighbouring points whose gust factor is at least the
// threshold's share of the way from 1 to the spell's; and each patch whose
// edge, carried with the field past the boat as it sails, passes within
// the ring's reach of the boat within its horizon gets a ring, the soonest
// first, as many as the catalog allows. Only gusts are ringed, never
// lulls. The page's twin is client/src/render/gustring.ts; both are held
// to testdata/gustring.json.

// GustPatch is a patch of gust on the grid.
type GustPatch struct {
	// East and North are its middle, m, weighed by how strong the gust is;
	// Radius that of a circle of its area, m; Peak its strongest gust
	// factor.
	East   float64 `json:"east"`
	North  float64 `json:"north"`
	Radius float64 `json:"radius"`
	Peak   float64 `json:"peak"`
}

// RingedPatch is a patch that gets a ring: when its track passes nearest
// the boat, s from now, and how near its edge comes then, m, 0 if it passes
// over the boat.
type RingedPatch struct {
	GustPatch
	Arrives float64 `json:"arrives"`
	Miss    float64 `json:"miss"`
}

// RingGridSize is the ring's grid: its rows upwind and its columns across
// the wind.
func RingGridSize(o *catalog.WeatherRing) (rows, cols int) {
	return max(1, int(round(o.Depth/o.Spacing))), max(1, int(round(o.Width/o.Spacing)))
}

// RingGrid writes to out the grid's points, east then north of each, row
// by row from the boat upwind: upwind of a boat at (east, north) in a mean
// wind from a direction in rad, centred across the wind on the boat. out
// holds two values for each of the grid's points.
func RingGrid(east, north, from float64, o *catalog.WeatherRing, out []float64) {
	rows, cols := RingGridSize(o)
	ue, un := physics.SinCos(from)
	for i := range rows {
		along := (float64(i) + 0.5) * o.Spacing
		for j := range cols {
			across := (float64(j) - float64(cols-1)/2) * o.Spacing
			k := (i*cols + j) * 2
			// Across the wind is a quarter turn clockwise of upwind.
			out[k] = east + float64(along*ue) + float64(across*un)
			out[k+1] = north + float64(along*un) - float64(across*ue)
		}
	}
}

// FindPatches are the patches of gust on the grid, in the order the page
// finds them: factor is the gust factor at each point and points their
// places, as RingGrid lays them; excess the spell's gust factor less 1.
func FindPatches(factor, points []float64, excess float64, o *catalog.WeatherRing) []GustPatch {
	rows, cols := RingGridSize(o)
	var patches []GustPatch
	if !(excess > 0) {
		return patches
	}
	least := 1 + float64(o.Threshold*excess)
	seen := make([]bool, rows*cols)
	var stack []int
	for start := range rows * cols {
		if seen[start] || !(factor[start] >= least) {
			continue
		}
		var weight, east, north, peak float64
		count := 0
		stack = append(stack, start)
		seen[start] = true
		for len(stack) > 0 {
			p := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			f := factor[p]
			w := f - 1
			weight += w
			east += float64(w * points[p*2])
			north += float64(w * points[p*2+1])
			peak = math.Max(peak, f)
			count++
			i, j := p/cols, p%cols
			for _, d := range [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
				ni, nj := i+d[0], j+d[1]
				q := ni*cols + nj
				if ni >= 0 && ni < rows && nj >= 0 && nj < cols && !seen[q] && factor[q] >= least {
					seen[q] = true
					stack = append(stack, q)
				}
			}
		}
		patches = append(patches, GustPatch{
			East:   east / weight,
			North:  north / weight,
			Radius: math.Sqrt(float64(float64(count)*o.Spacing*o.Spacing) / math.Pi),
			Peak:   peak,
		})
	}
	return patches
}

// ChooseRings are the patches that get a ring: those which, carried at
// (driftEast, driftNorth) m/s past a boat at (east, north) moving at
// (boatEast, boatNorth) m/s, pass within the ring's reach of the boat
// within its horizon, by their edge; the soonest first, at most the
// catalog's rings.
func ChooseRings(patches []GustPatch, east, north, boatEast, boatNorth, driftEast, driftNorth float64, o *catalog.WeatherRing) []RingedPatch {
	// The patch as the boat sees it: where it is from the boat, and how it moves.
	ve, vn := driftEast-boatEast, driftNorth-boatNorth
	v2 := float64(ve*ve) + float64(vn*vn)
	var out []RingedPatch
	for _, p := range patches {
		de, dn := p.East-east, p.North-north
		t := 0.0
		if v2 > 0 {
			t = math.Min(math.Max(-(float64(de*ve)+float64(dn*vn))/v2, 0), o.Horizon)
		}
		x, y := de+float64(ve*t), dn+float64(vn*t)
		miss := math.Max(0, math.Sqrt(float64(x*x)+float64(y*y))-p.Radius)
		if miss <= o.Reach {
			out = append(out, RingedPatch{GustPatch: p, Arrives: t, Miss: miss})
		}
	}
	slices.SortStableFunc(out, func(a, b RingedPatch) int {
		switch {
		case a.Arrives < b.Arrives:
			return -1
		case a.Arrives > b.Arrives:
			return 1
		}
		return 0
	})
	if len(out) > o.Rings {
		out = out[:o.Rings]
	}
	return out
}

// Gust is a gust the ring shows heading for the boat.
type Gust struct {
	RingedPatch
	// Bearing is the patch's middle's true bearing from the boat, degrees
	// 0 to 360, and Distance how far its edge is now, m, 0 with the boat
	// in it.
	Bearing  float64 `json:"bearing"`
	Distance float64 `json:"distance"`
	// Stronger is how much stronger than the mean wind its strongest gust
	// is, in whole percent.
	Stronger int `json:"stronger"`
}

// GustBoat is the boat as the ring reads it.
type GustBoat struct {
	// East and North are where it is, m; VelEast and VelNorth how it moves
	// over the ground, m/s; MeanFrom the direction the mean wind at it comes
	// from, rad.
	East, North, VelEast, VelNorth, MeanFrom float64
}

// GustsOf is what the ring shows of the patches chosen for a boat at
// (east, north).
func GustsOf(rings []RingedPatch, east, north float64) []Gust {
	out := make([]Gust, len(rings))
	for i, r := range rings {
		de, dn := r.East-east, r.North-north
		b := physics.Atan2(de, dn) * 180 / math.Pi
		if b < 0 {
			b += 360
		}
		out[i] = Gust{
			RingedPatch: r,
			Bearing:     b,
			Distance:    math.Max(0, math.Sqrt(float64(de*de)+float64(dn*dn))-r.Radius),
			Stronger:    int(round((r.Peak - 1) * 100)),
		}
	}
	return out
}

// GustRings are the gusts the ring shows a boat in the wind at the time t
// was set to, sh the land's shelter the wind reads (nil for open water): the
// field sampled as the page samples it from the physics module, the same
// code.
func GustRings(t *physics.WeatherTick, sh *physics.Shelter, boat GustBoat, o *catalog.WeatherRing) []Gust {
	var frame physics.GustFrame
	physics.GustFrameAt(t, &frame)
	if !(frame.Excess > 0) {
		// A steady wind, or one with no gusts: nothing to sample.
		return nil
	}
	rows, cols := RingGridSize(o)
	points := make([]float64, rows*cols*2)
	factor := make([]float64, rows*cols)
	RingGrid(boat.East, boat.North, boat.MeanFrom, o, points)
	var w physics.WindPoint
	for i := range factor {
		physics.WindPointAt(t, points[2*i], points[2*i+1], &w, sh)
		factor[i] = w.Factor
	}
	physics.WindPointAt(t, boat.East, boat.North, &w, sh)
	rings := ChooseRings(FindPatches(factor, points, frame.Excess, o),
		boat.East, boat.North, boat.VelEast, boat.VelNorth, w.DriftEast, w.DriftNorth, o)
	return GustsOf(rings, boat.East, boat.North)
}
