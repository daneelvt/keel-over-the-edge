// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The world's values are checked here for what the schema cannot say:
// ranges that run from low to high, the ids a biome names, size classes in
// order.

// checkWorld fails on world values the schema cannot judge.
func checkWorld(doc map[string]any) error {
	var problems []string
	bad := func(format string, args ...any) { problems = append(problems, "  "+fmt.Sprintf(format, args...)) }
	num := func(v any) float64 {
		n, _ := v.(json.Number)
		f, err := n.Float64()
		if err != nil {
			return math.NaN()
		}
		return f
	}
	ranged := func(where string, v any) {
		r, _ := v.([]any)
		if len(r) == 2 && !(num(r[0]) <= num(r[1])) {
			bad("%s: %v runs from high to low", where, v)
		}
	}
	world, _ := doc["world"].(map[string]any)
	var walk func(where string, v any)
	walk = func(where string, v any) {
		switch t := v.(type) {
		case map[string]any:
			for k, c := range t {
				// A light's steps are its light and dark, not a range.
				if k != "steps" {
					walk(where+"."+k, c)
				}
			}
		case []any:
			if len(t) == 2 {
				if _, ok := t[0].(json.Number); ok {
					ranged(where, t)
					return
				}
			}
			for i, c := range t {
				walk(fmt.Sprintf("%s[%d]", where, i), c)
			}
		}
	}
	walk("world", world)

	surfaces := map[string]bool{}
	list, _ := world["surfaces"].([]any)
	if len(list) > physics.GroundSurfaces {
		bad("world.surfaces: %d, more than the %d a hexagon's surface may index", len(list), physics.GroundSurfaces)
	}
	for _, s := range list {
		m, _ := s.(map[string]any)
		id, _ := m["id"].(string)
		surfaces[id] = true
	}
	biomes := map[string]bool{}
	bl, _ := world["biomes"].([]any)
	for _, b := range bl {
		m, _ := b.(map[string]any)
		id, _ := m["id"].(string)
		biomes[id] = true
		ss, _ := m["surfaces"].(map[string]any)
		keys := make([]string, 0, len(ss))
		for k := range ss {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if s, _ := ss[k].(string); !surfaces[s] {
				bad("world.biomes[%s].surfaces.%s: %q is not a surface", id, k, s)
			}
		}
		if num(m["hills"])+num(m["ridges"])+num(m["cone"]) > 1+1e-9 {
			bad("world.biomes[%s]: hills, ridges and cone add up to more than 1", id)
		}
	}
	hz, _ := world["hazards"].(map[string]any)
	if id, _ := hz["rockSurface"].(string); !surfaces[id] {
		bad("world.hazards.rockSurface: %q is not a surface", id)
	}
	port, _ := world["mainPort"].(map[string]any)
	if id, _ := port["biome"].(string); !biomes[id] {
		bad("world.mainPort.biome: %q is not a biome", id)
	}
	sizes, _ := world["sizes"].([]any)
	prev := 0.0
	for i, s := range sizes {
		m, _ := s.(map[string]any)
		if b := num(m["below"]); !(b > prev) {
			bad("world.sizes[%d]: below %v is not above the class before's", i, b)
		} else {
			prev = b
		}
	}
	zs, _ := world["zones"].(map[string]any)
	if !(num(zs["centre"]) < num(zs["middle"])) {
		bad("world.zones: the centre must end before the middle waters")
	}
	nm, _ := world["names"].(map[string]any)
	prefixes, _ := nm["prefixes"].([]any)
	for i, p := range prefixes {
		if pair, _ := p.([]any); len(pair) != 2 {
			bad("world.names.prefixes[%d]: %d entries, not a pair", i, len(pair))
		}
	}
	places, _ := world["places"].(map[string]any)
	sites := map[string]bool{}
	kinds, _ := places["kinds"].([]any)
	for _, k := range kinds {
		m, _ := k.(map[string]any)
		site, _ := m["site"].(string)
		if sites[site] {
			bad("world.places.kinds: two kinds have the site %q", site)
		}
		sites[site] = true
	}
	classes := map[string]bool{}
	for _, s := range sizes {
		m, _ := s.(map[string]any)
		c, _ := m["class"].(string)
		classes[c] = true
	}
	village, _ := places["village"].(map[string]any)
	vs, _ := village["sizes"].([]any)
	for _, v := range vs {
		if s, _ := v.(string); !classes[s] {
			bad("world.places.village.sizes: %q is not a size class", s)
		}
	}
	lights, _ := world["lights"].(map[string]any)
	notations := map[string]bool{}
	chars, _ := lights["characters"].([]any)
	for i, c := range chars {
		m, _ := c.(map[string]any)
		n, _ := m["notation"].(string)
		if notations[n] {
			bad("world.lights.characters[%d]: %q twice", i, n)
		}
		notations[n] = true
		if steps, _ := m["steps"].([]any); len(steps)%2 != 0 {
			bad("world.lights.characters[%d]: %d steps, not light and dark in pairs", i, len(steps))
		}
	}
	if n, _ := lights["mainPortCharacter"].(string); !notations[n] {
		bad("world.lights.mainPortCharacter: %q is not a character of the list", n)
	}
	shelter, _ := world["shelter"].(map[string]any)
	if !(num(shelter["near"]) < num(shelter["far"])) {
		bad("world.shelter: near must be less than far")
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return fmt.Errorf("the world:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}
