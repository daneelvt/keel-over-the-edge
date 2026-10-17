// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"fmt"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The harbour's and the towns' rules.

// townRules are Port Royal's harbour's and town's rules, and every town's.
func (c *config) townRules(w *world) []Rule {
	var rules []Rule
	add := func(name string, pass bool, measured, wants string, args ...any) {
		rules = append(rules, Rule{Name: name, Measured: measured, Wants: fmt.Sprintf(wants, args...), Pass: pass})
	}
	hc := &c.port.harbour
	port := w.islands[0]
	h := port.harbour
	if h == nil {
		add("main port's harbour", false, "none", "a basin through a narrows")
		return rules
	}
	// The basin: its width, its depth, room to turn, sheltered.
	g := w.ground
	deepest := 0.0
	clear := true
	tq, tr := physics.HexAt(h.x, h.y)
	rings := toInt32(h.turning/(0.866*physics.HexAcross)) + 1
	for dq := -rings; dq <= rings; dq++ {
		for dr := max(-rings, -dq-rings); dr <= min(rings, -dq+rings); dr++ {
			hx, hy := physics.HexCentre(tq+dq, tr+dr)
			if hypot(hx-h.x, hy-h.y) > h.turning {
				continue
			}
			e, _ := g.At(hx, hy)
			deepest = max(deepest, -e)
			if e > -hc.Depth[0] {
				clear = false
			}
		}
	}
	sheltered := 0
	for d := range int32(physics.FetchDirections) {
		if c.radialTo(g, w.coarse, h.x, h.y, float64(float64(d)*(2*math.Pi/physics.FetchDirections)), 300) < 300 {
			sheltered++
		}
	}
	width := 2 * h.radius
	add("main port's harbour",
		width >= hc.Across[0]-1e-9 && width <= hc.Across[1]+1e-9 && clear && deepest >= hc.Depth[1]-0.5 && sheltered >= 14,
		fmt.Sprintf("a basin %.0f m across, %.1f m deep at most, its turning circle %s, sheltered in %d of 16 directions",
			width, deepest, map[bool]string{true: "clear", false: "fouled"}[clear], sheltered),
		"%.0f–%.0f m across, %.0f m deep in its middle, a circle %.0f m across clear and %.0f m deep, a fetch under 300 m in 14 of 16 directions",
		hc.Across[0], hc.Across[1], hc.Depth[1], hc.Turning, hc.Depth[0])
	// The narrows: its width and its channel along its middle third.
	shallow := math.Inf(1)
	for t := h.edge; t <= h.mouth; t += physics.HexAcross {
		for o := -h.inner / 6; o <= h.inner/6; o += physics.HexAcross / 2 {
			x := h.x + float64(t*h.sin) + float64(o*h.cos)
			y := h.y + float64(t*h.cos) - float64(o*h.sin)
			e, _ := g.At(x, y)
			shallow = min(shallow, -e)
		}
	}
	if math.IsInf(shallow, 1) {
		shallow = 0
	}
	add("main port's narrows", h.inner >= hc.Narrows[0]-1e-9 && shallow >= hc.Channel-0.05,
		fmt.Sprintf("%.0f m wide, %.1f m deep along its middle third at least", h.inner, shallow),
		"at least %.0f m wide, %.0f m deep along its middle third", hc.Narrows[0], hc.Channel)
	add("moorings", w.start.Moorings >= c.moorings.Least, fmt.Sprintf("%d", w.start.Moorings), "at least %d, before the roads", c.moorings.Least)

	// The towns.
	var main *Town
	var ports, villages []*Town
	for i := range w.towns {
		switch t := &w.towns[i]; t.Kind {
		case townMain:
			main = t
		case townPort:
			ports = append(ports, t)
		case townVillage:
			villages = append(villages, t)
		}
	}
	has := func(t *Town, st catalog.Stands) int {
		n := 0
		for _, k := range c.standing(st) {
			if !k.prop && int(k.index) < len(t.Counts) {
				n += t.Counts[k.index]
			}
		}
		return n
	}
	if main == nil {
		add("main port's town", false, "none", "a town")
	} else {
		lo := c.towns.Size.Main[0]
		add("main port's town", main.Buildings >= lo && main.Square != nil && has(main, catalog.StandsAbove) > 0 && has(main, catalog.StandsSquare) > 0,
			fmt.Sprintf("%d buildings, %s square, %d church, %d harbourmaster's", main.Buildings,
				map[bool]string{true: "a", false: "no"}[main.Square != nil], has(main, catalog.StandsAbove), has(main, catalog.StandsSquare)),
			"at least %d buildings, its square, church and harbourmaster's house", lo)
	}
	var off []string
	for _, t := range ports {
		long := 0.0
		for _, p := range t.Piers {
			long = max(long, p.Length)
		}
		if len(t.Quay) == 0 || len(t.Piers) == 0 || t.Buildings < c.towns.Size.Port[0] || long > c.places.Harbour.Pier+physics.HexAcross {
			off = append(off, fmt.Sprintf("%s: quay %d m, %d piers, %d buildings", t.Name, len(t.Quay)*physics.HexAcross, len(t.Piers), t.Buildings))
		}
	}
	add("ports' towns", len(off) == 0, fmt.Sprintf("%d ports, %d amiss", len(ports), len(off)),
		"each its quay, a pier to %.0f m of water at most %.0f m long, at least %d buildings%s",
		c.places.Harbour.Depth, c.places.Harbour.Pier, c.towns.Size.Port[0], suffix(off))
	off = nil
	for _, t := range villages {
		if len(t.Piers) == 0 || t.Buildings < c.towns.Size.Village[0] {
			off = append(off, fmt.Sprintf("%s: %d jetty, %d buildings", t.Name, len(t.Piers), t.Buildings))
		}
	}
	add("villages", len(off) == 0, fmt.Sprintf("%d villages, %d amiss", len(villages), len(off)),
		"each its jetty and at least %d buildings%s", c.towns.Size.Village[0], suffix(off))
	bad := c.unsound(w)
	add("towns sound", len(bad) == 0, fmt.Sprintf("%d amiss", len(bad)),
		"no building on another, a way or the water; every plot level; every house facing a way%s", suffix(bad[:min(len(bad), 5)]))
	return rules
}

// unsound lists what is wrong with the towns' buildings: one on another, on
// a way or in the water, on a plot not level, or a house in a town with no
// way before its door.
func (c *config) unsound(w *world) []string {
	g := w.ground
	var bad []string
	owner := map[int64]int{}
	ways := map[uint8]bool{c.townSurface.street: true, c.townSurface.quay: true}
	for bi, b := range w.buildings {
		k := &c.buildings[b.Kind]
		if k.prop {
			continue
		}
		// Its plot, as it was laid: the hexagons under it and half a metre.
		over := k.stands == catalog.StandsWater || k.stands == catalog.StandsSlip
		for _, a := range underFootprint(b.X, b.Y, b.Heading, b.Frontage, b.Depth, 0.5) {
			key := int64(a[0])<<32 | int64(uint32(a[1]))
			if o, ok := owner[key]; ok && o != bi {
				bad = append(bad, fmt.Sprintf("building %d on building %d", bi, o))
				goto next
			}
			owner[key] = bi
			cc, jj := physics.HexCell(a[0], a[1])
			e := elevationAt(g, cc, jj)
			if over && e <= 0 {
				continue
			}
			var s uint8
			if n, i, ok := physics.ChunkOf(cc, jj); ok && g.Chunks[n] != nil {
				s = g.Chunks[n].Surface[i]
			}
			switch {
			case e <= 0:
				bad = append(bad, fmt.Sprintf("building %d in the water", bi))
				goto next
			case ways[s]:
				bad = append(bad, fmt.Sprintf("building %d on a way", bi))
				goto next
			case e != b.Level:
				bad = append(bad, fmt.Sprintf("building %d's plot not level", bi))
				goto next
			}
		}
		// A house on a street faces it: a way within reach before its door.
		if k.stands == catalog.StandsStreet || k.stands == catalog.StandsQuay {
			sh, ch := sincos(b.Heading)
			found := false
			for t := b.Depth / 2; t <= float64(b.Depth/2)+c.towns.Plan.SetBack[1]+c.towns.Plan.Quay+physics.HexAcross && !found; t += 1 {
				for f := -b.Frontage / 2; f <= b.Frontage/2; f += 1 {
					x := b.X + float64(t*sh) + float64(f*ch)
					y := b.Y + float64(t*ch) - float64(f*sh)
					if _, s := g.At(x, y); ways[uint8(s)] || uint8(s) == c.townSurface.deck {
						found = true
						break
					}
				}
			}
			if !found {
				bad = append(bad, fmt.Sprintf("building %d faces no way", bi))
			}
		}
	next:
	}
	return bad
}

// townSummary is the towns' counts for a rule's measure.
func townSummary(towns []Town) string {
	var parts []string
	for _, t := range towns {
		parts = append(parts, fmt.Sprintf("%s %d", t.Name, t.Buildings))
	}
	return strings.Join(parts, ", ")
}
