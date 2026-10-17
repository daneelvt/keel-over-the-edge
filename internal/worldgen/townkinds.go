// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

// The kinds of building a town is built of, as the catalog lists them:
// each with its footprint, its storeys, where it stands and how many of it
// each kind of town has. The generator reads their properties, never their
// names.

// The kinds of town.
const (
	townMain    = "main" // Port Royal
	townPort    = "port"
	townVillage = "village"
)

// storeyHeight is a storey's height, m, and roofHeight a roof's above the
// top storey, as the kits build them.
const (
	storeyHeight = 3.0
	roofHeight   = 3.0
)

// buildingKind is a kind of building as the generator uses it.
type buildingKind struct {
	index    uint8
	prop     bool
	frontage [2]float64
	depth    [2]float64
	storeys  [2]int
	stands   catalog.Stands
	fill     float64
	counts   map[string][2]int // by kind of town; none where it fills the streets
	chimney  float64
	flag     bool
	lantern  float64
	top      float64
}

// kindsOf reads the catalog's kinds of building.
func kindsOf(cat []catalog.BuildingKind) []buildingKind {
	out := make([]buildingKind, len(cat))
	for i, k := range cat {
		o := buildingKind{
			index:    uint8(i),
			prop:     k.Prop != nil && *k.Prop,
			frontage: pair(k.Frontage),
			depth:    pair(k.Depth),
			storeys:  ipair(k.Storeys),
			stands:   k.Stands,
			counts:   map[string][2]int{},
		}
		if k.Fill != nil {
			o.fill = *k.Fill
		}
		for town, c := range map[string][]int{townMain: k.Main, townPort: k.Port, townVillage: k.Village} {
			if len(c) == 2 {
				o.counts[town] = ipair(c)
			}
		}
		if k.Chimney != nil {
			o.chimney = *k.Chimney
		}
		o.flag = k.Flag != nil && *k.Flag
		if k.Lantern != nil {
			o.lantern = *k.Lantern
		}
		if k.Top != nil {
			o.top = *k.Top
		}
		out[i] = o
	}
	return out
}

// standing are the kinds that stand where given, in the catalog's order.
func (c *config) standing(where catalog.Stands) []*buildingKind {
	var out []*buildingKind
	for i := range c.buildings {
		if c.buildings[i].stands == where {
			out = append(out, &c.buildings[i])
		}
	}
	return out
}

// height is how high a building of the kind stands above its plot, m.
func (k *buildingKind) height(storeys int) float64 {
	if k.top > 0 {
		return k.top
	}
	return float64(float64(storeys)*storeyHeight) + roofHeight
}
