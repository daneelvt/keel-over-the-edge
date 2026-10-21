// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// The world's places and lights as the game connection sends them: what is
// drawn of each, by the catalog's indices, in centimetres and 65536ths of
// a turn, and never a name.

// turn is an angle, rad, in 65536ths of a turn.
func turn(a float64) uint32 {
	t := math.Round(a / (2 * math.Pi) * 65536)
	return uint32(int64(t) & 0xffff)
}

// cm is a length in centimetres.
func cm(m float64) int32 { return int32(math.Round(m * 100)) }

// wirePlaces are the bundle's places as the game connection sends them.
func wirePlaces(b *worldgen.Bundle, cat *catalog.Catalog) []*pb.Place {
	kinds := map[string]uint32{}
	for i, k := range cat.World.Places.Kinds {
		kinds[string(k.ID)] = uint32(i)
	}
	rigs, ages := map[string]uint32{}, map[string]uint32{}
	for i, r := range cat.World.Places.Rigs {
		rigs[string(r.ID)] = uint32(i)
	}
	for i, a := range cat.World.Places.Ages {
		ages[string(a.ID)] = uint32(i)
	}
	towers := map[int32]*worldgen.Light{}
	for i := range b.Lights {
		towers[b.Lights[i].Place] = &b.Lights[i]
	}
	out := make([]*pb.Place, 0, len(b.Places))
	for _, p := range b.Places {
		w := &pb.Place{Number: uint32(p.Number), Kind: kinds[p.Kind], East: cm(p.X), North: cm(p.Y), Heading: turn(p.Heading)}
		if l := towers[p.Number]; l != nil {
			w.Ground, w.Tower, w.Daymark = uint32(cm(l.Ground)), uint32(cm(l.Tower)), uint32(l.Daymark)
		}
		if s := p.Details.Ship; s != nil {
			w.Rig, w.Age, w.Sunk = rigs[s.Rig], ages[s.Age], s.Sunk
			w.Heel = int32(int16(turn(s.Heel)))
		}
		out = append(out, w)
	}
	return out
}

// wireLights are the bundle's lights as the game connection sends them:
// the main port's, which the Welcome carries, and the rest, sent by range.
func wireLights(b *worldgen.Bundle, cat *catalog.Catalog) (*pb.Light, *edge.Lights) {
	var main *pb.Light
	var rest []*pb.Light
	for _, l := range b.Lights {
		w := &pb.Light{Number: uint32(l.Number), East: cm(l.X), North: cm(l.Y), Focal: uint32(cm(l.Focal)),
			Character: uint32(l.Character), Phase: l.Phase, Range: uint32(math.Round(l.Range))}
		if l.Role == worldgen.RoleMain && main == nil {
			main = w
			continue
		}
		rest = append(rest, w)
	}
	return main, edge.NewLights(rest, cat.World.Lights.Drop)
}

// wireCaps are the bundle's islands as their caps are sent: each island's
// centre and width to 50 m, sent within sight of its cap and its street,
// and dropped beyond that by the lights' margin.
func wireCaps(b *worldgen.Bundle, cat *catalog.Catalog) *edge.Caps {
	w := cat.PrepareWeather()
	to50 := func(m float64) float64 { return 50 * math.Round(m/50) }
	var caps []*pb.IslandCap
	var reach []float64
	for i, is := range islandsOf(b) {
		width := to50(is.Across)
		caps = append(caps, &pb.IslandCap{Number: uint32(i), East: int32(to50(is.X)), North: int32(to50(is.Y)), Width: uint32(width)})
		reach = append(reach, w.CapReach(width, cat.World.Handout.Dome))
	}
	return edge.NewCaps(caps, reach, cat.World.Lights.Drop)
}
