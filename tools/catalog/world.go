// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/names"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The world's values are checked here for what the schema cannot say:
// ranges that run from low to high, the ids a biome names, size classes in
// order. The names under shared/catalog/names are the server's alone:
// they are checked against the world's vocabulary and the avoid list and
// written, parsed, into internal/names, never into the catalog's JSON.

const (
	namesDir     = "shared/catalog/names"
	namesGenPath = "internal/names/names.gen.json"
)

// zones are the words a name's zone may hold besides any.
var zones = []string{"centre", "middle", "rim"}

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
				walk(where+"."+k, c)
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

// namesFile reads the names, checks them against the world's vocabulary,
// and returns names.gen.json.
func namesFile(root string, doc map[string]any) ([]byte, error) {
	files := map[string][]byte{}
	for _, f := range names.Files {
		data, err := os.ReadFile(filepath.Join(root, namesDir, f))
		if err != nil {
			return nil, err
		}
		files[f] = data
	}
	db, err := names.Parse(files)
	if err != nil {
		return nil, err
	}
	if problems := db.Check(vocabulary(doc)); len(problems) > 0 {
		return nil, fmt.Errorf("the names in %s:\n  %s", namesDir, strings.Join(problems, "\n  "))
	}
	var b bytes.Buffer
	if err := names.Encode(&b, db); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// vocabulary is what the world lets a name's tags hold.
func vocabulary(doc map[string]any) names.Vocabulary {
	var v names.Vocabulary
	world, _ := doc["world"].(map[string]any)
	words := func(list any, key string) []string {
		var out []string
		items, _ := list.([]any)
		for _, it := range items {
			m, _ := it.(map[string]any)
			if s, ok := m[key].(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	v.Sizes = words(world["sizes"], "class")
	v.Biomes = words(world["biomes"], "id")
	nm, _ := world["names"].(map[string]any)
	v.Features = words(nm["features"], "word")
	v.Tones = words(nm["tones"], "word")
	v.Zones = slices.Clone(zones)
	partners, _ := nm["partners"].([]any)
	for _, p := range partners {
		pair, _ := p.([]any)
		if len(pair) == 2 {
			a, _ := pair[0].(string)
			b, _ := pair[1].(string)
			v.Partners = append(v.Partners, [2]string{a, b})
		}
	}
	port, _ := world["mainPort"].(map[string]any)
	if n, ok := port["name"].(string); ok {
		v.Reserved = []string{n}
	}
	return v
}
