// SPDX-License-Identifier: AGPL-3.0-only

// Package chart is the world's shared chart: what can be charted in it and
// what each is worth (World, from the world's bundle), each charted
// island's model, and the chart itself as the game shows it, made from what
// is written (Model).
package chart

import (
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/light"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// Subject is a thing that can be charted, as the chart tells of it.
type Subject struct {
	sight.Subject
	// Name is its own name: an island's, a place's; none for a feature,
	// which is named by its kind and its island. Title is how the news
	// heads it: its name, or "a sea arch on Keyhole Rock".
	Name, Title string
	// Group is the name of the group of rocks an island is in.
	Group string
	// Sort is its sort: an island's size class, a place's or a feature's
	// kind, by its index in the catalog's list.
	Sort int
	// Worth is what charting it is worth; News, that its charting is an
	// item of the news of its own.
	Worth float64
	News  bool
	// An island's: its land's bounds, m east and north (west, south, east,
	// north), its highest, its zone and its class of scenery, and its
	// model, by its index in World.Models, or -1.
	Bounds  [4]float64
	Highest float64
	Zone    string
	Class   string
	Model   int
	// Light is a lighthouse's light, by its index in the bundle's lights,
	// or -1; Ship a wreck's ship's name; Sunk, that she lies sunk.
	Light int
	Ship  string
	Sunk  bool
}

// World is what can be charted in a world.
type World struct {
	Subjects []Subject
	Table    *sight.Table
	// Models are the islands' models, by World.Subjects' Model: each an
	// island's grid, gzipped.
	Models []IslandModel
	// Known are the subjects charted from the world's start, credited to
	// no one: the main port's island and everything on it.
	Known []int32
	// Lookouts are the boats' kinds' lookouts, by kind, as the table's
	// eyes take them.
	Lookouts []float64
	// Lights are the world's lights, as its bundle holds them, and
	// FogSignals each one's fog signal, by its index in the catalog's.
	Lights     []worldgen.Light
	FogSignals []int
	// Weather is the catalog's weather, prepared: what Calm sees by.
	Weather *physics.WeatherPrepared

	byIsland, byPlace, byFeature map[int32]int32
}

// The kinds of subject, as the database and the wire name them.
const (
	IslandWord  = "island"
	PlaceWord   = "place"
	FeatureWord = "feature"
)

// KindWord is a subject kind's word.
func KindWord(k uint8) string {
	switch k {
	case sight.Island:
		return IslandWord
	case sight.Place:
		return PlaceWord
	}
	return FeatureWord
}

// KindOf is the subject kind a word names, or 0.
func KindOf(w string) uint8 {
	switch w {
	case IslandWord:
		return sight.Island
	case PlaceWord:
		return sight.Place
	case FeatureWord:
		return sight.Feature
	}
	return 0
}

// Index is the subject of a kind and number, or −1.
func (w *World) Index(kind uint8, number int32) int32 {
	var m map[int32]int32
	switch kind {
	case sight.Island:
		m = w.byIsland
	case sight.Place:
		m = w.byPlace
	case sight.Feature:
		m = w.byFeature
	}
	if i, ok := m[number]; ok {
		return i
	}
	return -1
}

// zoneTimes is a zone's times by the catalog's zones.
func zoneTimes(z catalog.BiomeZones, zone string) float64 {
	switch zone {
	case "middle":
		return z.Middle
	case "rim":
		return z.Rim
	}
	return z.Centre
}

// classTimes is a class of scenery's times.
func classTimes(c catalog.Classes, class string) float64 {
	switch class {
	case "A":
		return c.A
	case "B":
		return c.B
	}
	return c.C
}

// townReach is how far from a town's waterfront its buildings stand, m, at
// most.
const townReach = 200

// Build finds what can be charted in the world b, and builds its sight
// table and its islands' models.
func Build(b *worldgen.Bundle, cat *catalog.Catalog) *World {
	w := &World{byIsland: map[int32]int32{}, byPlace: map[int32]int32{}, byFeature: map[int32]int32{}}
	cs := &cat.World.Chart
	sizes := map[string]int{}
	for i, s := range cat.World.Sizes {
		sizes[s.Class] = i
	}
	placeKinds := map[string]int{}
	for i, k := range cat.World.Places.Kinds {
		placeKinds[string(k.ID)] = i
	}
	featureKinds := map[string]int{}
	for i, k := range cat.World.Features.Kinds {
		featureKinds[string(k.ID)] = i
	}
	rigs, ages := map[string]float64{}, map[string]float64{}
	for _, r := range cat.World.Places.Rigs {
		rigs[string(r.ID)] = r.Mast
	}
	for _, a := range cat.World.Places.Ages {
		ages[string(a.ID)] = a.Masts
	}

	grid := newLandGrid(b, cat, cs.Model.Cell)
	main := int32(-1)
	for i := range b.Islands {
		is := &b.Islands[i]
		if is.Kind == worldgen.KindMain && main < 0 {
			main = int32(i)
		}
		s := Subject{
			Subject: sight.Subject{Kind: sight.Island, Number: is.Number, Island: -1, X: is.X, Y: is.Y, Top: is.Highest, Seen: sight.ByLand},
			Name:    is.Name, Title: is.Name, Sort: sizes[is.Size], Highest: is.Highest, Zone: is.Zone, Class: is.Class, Model: -1, Light: -1,
			News: true,
		}
		if is.Group >= 0 {
			for _, g := range b.Groups {
				if g.Number == is.Group {
					s.Group = g.Name
				}
			}
		}
		if k, ok := sizes[is.Size]; ok {
			s.Worth = cat.World.Sizes[k].Worth * zoneTimes(cs.Worth.Zones, is.Zone) * classTimes(cs.Worth.Classes, is.Class)
		}
		w.byIsland[is.Number] = int32(len(w.Subjects))
		w.Subjects = append(w.Subjects, s)
	}
	islandName := func(n int32) string {
		if i, ok := w.byIsland[n]; ok {
			return w.Subjects[i].Name
		}
		return ""
	}
	towers := map[int32]int{}
	marks := map[int32]float64{}
	for i, l := range b.Lights {
		towers[l.Place] = i
		marks[l.Marks] = max(marks[l.Marks], l.Focal)
	}
	for _, p := range b.Places {
		k := placeKinds[p.Kind]
		kind := &cat.World.Places.Kinds[k]
		s := Subject{
			Subject: sight.Subject{Kind: sight.Place, Number: p.Number, Island: -1, X: p.X, Y: p.Y, Seen: sight.ByView},
			Name:    p.Name, Title: p.Name, Sort: k, Worth: kind.Worth, News: kind.News != nil && *kind.News, Model: -1, Light: -1,
			Zone: p.Zone,
		}
		if i, ok := w.byIsland[p.Island]; ok {
			s.Island = i
		}
		switch {
		case kind.Water != nil && *kind.Water:
			s.Seen, s.Reach = sight.ByWater, cs.Sight.Water
		case kind.Awash != nil && *kind.Awash:
			s.Seen, s.Reach = sight.Awash, cs.Sight.Awash
		}
		if l, ok := towers[p.Number]; ok {
			s.Light, s.Top = l, b.Lights[l].Focal
		}
		// A port's or a village's town, by its tallest building, and its
		// light.
		for _, t := range b.Towns {
			if t.Place != p.Number {
				continue
			}
			for _, bd := range b.Buildings {
				if math.Hypot(bd.X-t.X, bd.Y-t.Y) <= townReach {
					s.Top = max(s.Top, bd.Top)
				}
			}
			s.Top = max(s.Top, marks[p.Number])
		}
		if sh := p.Details.Ship; sh != nil {
			s.Ship, s.Sunk = sh.Name, sh.Sunk
			masts := rigs[sh.Rig] * ages[sh.Age]
			if sh.Sunk || masts < 1 {
				s.Seen, s.Reach = sight.Awash, cs.Sight.Awash
			} else {
				s.Top = masts
			}
		}
		if s.Seen == sight.ByView && s.Top <= 0 {
			s.Seen, s.Reach = sight.Awash, cs.Sight.Awash
		}
		w.byPlace[p.Number] = int32(len(w.Subjects))
		w.Subjects = append(w.Subjects, s)
	}
	for _, f := range b.Features {
		k := featureKinds[f.Kind]
		kind := &cat.World.Features.Kinds[k]
		s := Subject{
			Subject: sight.Subject{Kind: sight.Feature, Number: f.Number, Island: -1, X: f.X, Y: f.Y,
				Top: max(f.Height, 1), Seen: sight.ByView, Reach: cs.Sight.Features},
			Title: article(kind.Name) + " on " + islandName(f.Island), Sort: k, Worth: kind.Worth, Model: -1, Light: -1,
		}
		if i, ok := w.byIsland[f.Island]; ok {
			s.Island = i
			s.Zone = w.Subjects[i].Zone
		}
		if !f.Seen {
			s.Seen = sight.Hidden
		}
		w.byFeature[f.Number] = int32(len(w.Subjects))
		w.Subjects = append(w.Subjects, s)
	}

	// The islands' land, cell by cell, and their models.
	var cells []sight.Cell
	for i := range b.Islands {
		s := &w.Subjects[w.byIsland[b.Islands[i].Number]]
		land := grid.island(int32(i))
		if len(land) == 0 {
			// Too small for a cell of its own: seen by its highest.
			cells = append(cells, sight.Cell{X: s.X, Y: s.Y, Top: s.Highest, Subject: w.byIsland[b.Islands[i].Number]})
			s.Bounds = [4]float64{s.X - 5, s.Y - 5, s.X + 5, s.Y + 5}
			continue
		}
		s.Bounds = [4]float64{math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)}
		for _, k := range land {
			x, y := grid.centre(k)
			cells = append(cells, sight.Cell{X: x, Y: y, Top: float64(grid.top[k]), Subject: w.byIsland[b.Islands[i].Number]})
			s.Bounds[0], s.Bounds[1] = min(s.Bounds[0], x), min(s.Bounds[1], y)
			s.Bounds[2], s.Bounds[3] = max(s.Bounds[2], x), max(s.Bounds[3], y)
		}
		s.Model = len(w.Models)
		w.Models = append(w.Models, grid.model(int32(i), land, b.Islands[i].Number))
	}

	w.Lights = b.Lights
	w.FogSignals = FogSignals(b.Lights, cat)
	var lights []sight.Light
	for i, l := range b.Lights {
		if p, ok := w.byPlace[l.Place]; ok {
			lights = append(lights, sight.Light{X: l.X, Y: l.Y, Focal: l.Focal, Range: l.Range, Subject: p})
			w.Subjects[p].Light = i
		}
	}
	for _, k := range cat.Boats {
		w.Lookouts = append(w.Lookouts, k.Lookout)
	}
	eyes := slices.Clone(w.Lookouts)
	slices.Sort(eyes)
	eyes = slices.Compact(eyes)
	subjects := make([]sight.Subject, len(w.Subjects))
	for i := range w.Subjects {
		subjects[i] = w.Subjects[i].Subject
	}
	w.Weather = cat.PrepareWeather()
	w.Table = sight.Build(&sight.Input{
		Ground: b.Ground, Subjects: subjects, Cells: cells, Lights: lights, Eyes: eyes,
		Dome: cat.World.Handout.Dome, Rays: cs.Sight.Rays, Grid: cs.Sight.Grid, Lip: cat.World.Disk.Radius,
		Clear: cat.World.Lights.ClearAir * light.NauticalMile, Contrast: cat.Weather.Visibility.Contrast,
		Threshold: cat.World.Lights.Threshold,
	})

	// The main port's island and everything on it are known from the start.
	if main >= 0 {
		mi := w.byIsland[b.Islands[main].Number]
		for i := range w.Subjects {
			if int32(i) == mi || w.Subjects[i].Island == mi {
				w.Known = append(w.Known, int32(i))
			}
		}
	}
	return w
}

// Calm is the weather of no fog, rain or system: the clear air and the
// mist band alone, as a look sees by when no weather is given.
func (w *World) Calm() *physics.WeatherTick {
	t := new(physics.WeatherTick)
	physics.WeatherAt(&physics.Weather{Prepared: w.Weather}, t, 0)
	return t
}

// FogSignals gives each of a world's lights, by their numbers' order, its
// fog signal, by its index in the catalog's: its role's device's first
// pattern that no light within the catalog's distance has.
func FogSignals(lights []worldgen.Light, cat *catalog.Catalog) []int {
	rule := &cat.World.Lights.FogSignal
	places := make([][2]float64, len(lights))
	devices := make([]string, len(lights))
	order := make([]int, len(lights))
	for i := range lights {
		order[i] = i
	}
	slices.SortStableFunc(order, func(a, b int) int { return int(lights[a].Number - lights[b].Number) })
	for k, i := range order {
		places[k] = [2]float64{lights[i].X, lights[i].Y}
		devices[k] = string(DeviceOf(rule, lights[i].Role))
	}
	patterns := make([]string, len(cat.World.Lights.FogSignals))
	for j, f := range cat.World.Lights.FogSignals {
		patterns[j] = string(f.Device)
	}
	got := light.AssignFogSignals(places, devices, patterns, rule.Apart*light.NauticalMile)
	out := make([]int, len(lights))
	for k, i := range order {
		out[i] = got[k]
	}
	return out
}

// DeviceOf is the device of the fog signal of a light of a role.
func DeviceOf(rule *catalog.FogSignalRule, role string) catalog.FogSignalDevice {
	switch role {
	case worldgen.RoleMain:
		return rule.Devices.MainPort
	case worldgen.RolePort:
		return rule.Devices.Port
	case worldgen.RoleEdge:
		return rule.Devices.Edge
	}
	return rule.Devices.Hazard
}

// article is a kind's name as a phrase: "a sea arch", "an ruined chapel".
func article(name string) string {
	if name == "" {
		return name
	}
	lower := []rune(name)
	if lower[0] >= 'A' && lower[0] <= 'Z' {
		lower[0] += 'a' - 'A'
	}
	a := "a "
	switch lower[0] {
	case 'a', 'e', 'i', 'o', 'u':
		a = "an "
	}
	return a + string(lower)
}
