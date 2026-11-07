// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The harbours' gulls: a few laughing gulls wheel over each town by day,
// over its square, its harbourmaster's house, or over its quay where it
// has none, so that the gulls heard in a harbour are where they are seen.
// The page draws them (client/src/life/gulls.ts) and plays their calls
// from them; this finds the same gulls in the same places, for what a
// machine sailor hears. Each town's wheel is over the one of its buildings
// standing on its square (not a prop), else at its quay, else at its
// quay's edge: the one of the lowest own number, then east, then north;
// their number, paths and calls are drawn from the town's number and that
// building's.

// GullBuilding is a building as the gulls' wheel is found from it: its
// kind, by its index in the catalog's list, its middle, m east and north,
// its own number, its town's and its plot's height, m.
type GullBuilding struct {
	Kind        int
	East, North float64
	Seed        uint32
	Town        int32
	Level       float64
}

// GullTown is a town's gulls: their wheel's centre, m east and north, its
// ground's height, m, and their own number.
type GullTown struct {
	Town  int32   `json:"town"`
	East  float64 `json:"east"`
	North float64 `json:"north"`
	Level float64 `json:"level"`
	Seed  uint32  `json:"seed"`
}

// gullOver is where a town's wheel is, the first found of them.
var gullOver = [...]catalog.Stands{catalog.StandsSquare, catalog.StandsQuay, catalog.StandsEdge}

// GullTowns are each town's gulls from its buildings, in the towns'
// order: towns with none of a square, a quay or a quay's edge have none.
func GullTowns(buildings []GullBuilding, kinds []catalog.BuildingKind) []GullTown {
	type held struct {
		rank int
		b    GullBuilding
	}
	best := map[int32]held{}
	var towns []int32
	for _, b := range buildings {
		if b.Kind < 0 || b.Kind >= len(kinds) || b.Town < 0 {
			continue
		}
		k := &kinds[b.Kind]
		rank := slices.Index(gullOver[:], k.Stands)
		if rank < 0 || k.Stands == catalog.StandsSquare && k.Prop != nil && *k.Prop {
			continue
		}
		h, ok := best[b.Town]
		if !ok {
			towns = append(towns, b.Town)
		}
		if !ok || rank < h.rank || rank == h.rank && (b.Seed < h.b.Seed ||
			b.Seed == h.b.Seed && (b.East < h.b.East || b.East == h.b.East && b.North < h.b.North)) {
			best[b.Town] = held{rank, b}
		}
	}
	out := make([]GullTown, 0, len(towns))
	slices.Sort(towns)
	for _, town := range towns {
		h := best[town]
		out = append(out, GullTown{Town: town, East: h.b.East, North: h.b.North, Level: h.b.Level,
			Seed: hash32(uint32(town) ^ hash32(h.b.Seed+1))})
	}
	return out
}

// GullCount is how many gulls wheel over a town.
func GullCount(t *GullTown, r *catalog.LifeTowns) int {
	lo, hi := 0, 0
	if len(r.Count) > 0 {
		lo, hi = r.Count[0], r.Count[0]
	}
	if len(r.Count) > 1 {
		hi = r.Count[1]
	}
	return lo + int(hash32(t.Seed^hash32(1))%uint32(max(hi-lo, 0)+1))
}

// GullPlace is where a gull is: m east, north and up, and its heading,
// rad clockwise from north.
type GullPlace struct {
	East, North, Up, Heading float64
}

// pairOr is a pair's i-th value, or or where it has none.
func pairOr(p []float64, i int, or float64) float64 {
	if i < len(p) {
		return p[i]
	}
	return or
}

// GullAt is where a town's gull k is at world time t, s: wheeling about
// the town's centre, its radius breathing in and out, rising and falling.
func GullAt(t *GullTown, r *catalog.LifeTowns, k int, time float64) GullPlace {
	s := hash32(t.Seed ^ hash32(uint32(100+k)))
	speed := 7 + float64(4*Own(s, 1))
	radius := lerp(pairOr(r.Wheel, 0, 25), pairOr(r.Wheel, 1, 70), Own(s, 2))
	dir := -1.0
	if Own(s, 3) < 0.5 {
		dir = 1
	}
	a := float64(float64(Own(s, 4)*2)*math.Pi) + float64(float64(dir*(speed/radius))*time)
	reach := float64(radius * (0.8 + float64(0.2*physics.Sin(float64(a*0.6)+float64(Own(s, 5)*6)))))
	sin, cos := physics.Sin(a), physics.Cos(a)
	return GullPlace{
		East:    t.East + float64(reach*sin),
		North:   t.North + float64(reach*cos),
		Up:      t.Level + lerp(pairOr(r.Height, 0, 8), pairOr(r.Height, 1, 28), Own(s, 6)) + float64(3*physics.Sin(float64(a*1.1)+float64(Own(s, 7)*6))),
		Heading: a + float64(float64(dir*math.Pi)/2),
	}
}
