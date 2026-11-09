// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// checkBoats checks what the schema cannot of each boat: that its start
// sheet's angles rise and its sheets lie from 0 to 1, that its keel is
// fixed or not, that its reefs only shorten its sails, and that its
// stations are one for each person it carries, on its deck; and that the
// physics module holds every kind.
func checkBoats(doc map[string]any) error {
	var problems []string
	boats, _ := doc["boats"].([]any)
	if len(boats) > physics.BoatKinds {
		problems = append(problems, fmt.Sprintf("  %d boats, more than the physics module's %d kinds", len(boats), physics.BoatKinds))
	}
	for i, b := range boats {
		m, _ := b.(map[string]any)
		ph, _ := m["physics"].(map[string]any)
		foils, _ := ph["foils"].(map[string]any)
		if f, _ := foils["fixed"].(json.Number).Float64(); f != 0 && f != 1 {
			problems = append(problems, fmt.Sprintf("  boats[%d].physics.foils.fixed: %v is neither 0 nor 1", i, f))
		}
		for _, r := range []struct{ group, area, reefs string }{
			{"rig", "sailArea", "reefs"},
			{"headsails", "headsailArea", "headsailReefs"},
			{"square", "squareForeArea", "squareReefs"},
		} {
			g, _ := ph[r.group].(map[string]any)
			if a, _ := g[r.area].(json.Number).Float64(); !(a > 0) {
				continue
			}
			reefs, _ := g[r.reefs].([]any)
			last := 1.0
			for j, v := range reefs {
				x, _ := v.(json.Number).Float64()
				if !(x > 0 && x <= last) || j == 0 && x != 1 {
					problems = append(problems, fmt.Sprintf("  boats[%d].physics.%s.%s[%d]: %v does not shorten the sail from full", i, r.group, r.reefs, j, x))
				}
				last = x
			}
		}
		problems = append(problems, checkDownwind(i, ph)...)
		problems = append(problems, checkStations(i, m)...)
		pairs, _ := m["startSheet"].([]any)
		last := -1.0
		for j, p := range pairs {
			pair, _ := p.([]any)
			if len(pair) != 2 {
				continue
			}
			angle, _ := pair[0].(json.Number).Float64()
			sheet, _ := pair[1].(json.Number).Float64()
			if !(angle > last) {
				problems = append(problems, fmt.Sprintf("  boats[%d].startSheet[%d]: %v° does not rise", i, j, angle))
			}
			if !(sheet >= 0 && sheet <= 1) {
				problems = append(problems, fmt.Sprintf("  boats[%d].startSheet[%d]: the sheet %v is not from 0 to 1", i, j, sheet))
			}
			last = angle
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("the boats:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}

// checkDownwind checks boat i's downwind sail, if it has one: its reefs
// each 1, set, or 0, kept in, at full sail 1, for a downwind sail is kept
// in by the reef, never shortened; and the crew's band, setting it further
// off the wind than it takes it in.
func checkDownwind(i int, ph map[string]any) []string {
	var problems []string
	g, _ := ph["downwind"].(map[string]any)
	num := func(v any) float64 {
		f, _ := v.(json.Number).Float64()
		return f
	}
	if !(num(g["downwindArea"]) > 0) {
		return nil
	}
	reefs, _ := g["downwindReefs"].([]any)
	for j, v := range reefs {
		if x := num(v); x != 0 && x != 1 || j == 0 && x != 1 {
			problems = append(problems, fmt.Sprintf("  boats[%d].physics.downwind.downwindReefs[%d]: %v is neither set at full sail, 1, nor kept in, 0", i, j, x))
		}
	}
	if set, drop := num(g["setAngle"]), num(g["dropAngle"]); !(set > drop) {
		problems = append(problems, fmt.Sprintf("  boats[%d].physics.downwind: setAngle %v is not beyond dropAngle %v", i, set, drop))
	}
	if !(num(g["hoistTime"]) > 0 && num(g["dropTime"]) > 0 && num(g["downwindInertia"]) > 0 && num(g["downwindOut"]) > 0) {
		problems = append(problems, fmt.Sprintf("  boats[%d].physics.downwind: a downwind sail needs its hoist and drop times, its clew's inertia and its travel", i))
	}
	return problems
}

// stationsApart is how near two people's stations may be, in m: about a
// person's breadth.
const stationsApart = 0.45

// checkStations checks boat i's stations: one for each person it carries,
// each on its deck within its hull (within its beam and its length, above
// the waterline and below the boom), none on another. The client's tests
// hold each to the model's deck itself.
func checkStations(i int, m map[string]any) []string {
	var problems []string
	stations, _ := m["stations"].([]any)
	capacity, _ := m["capacity"].(json.Number).Int64()
	if int64(len(stations)) != capacity {
		problems = append(problems, fmt.Sprintf("  boats[%d].stations: %d, not one for each of the %d it carries", i, len(stations), capacity))
	}
	num := func(v any) float64 {
		f, _ := v.(json.Number).Float64()
		return f
	}
	beam, length := num(m["beam"]), num(m["lengthOverall"])
	ph, _ := m["physics"].(map[string]any)
	rig, _ := ph["rig"].(map[string]any)
	boom := num(rig["boomHeight"])
	at := make([][3]float64, 0, len(stations))
	for j, s := range stations {
		st, _ := s.(map[string]any)
		p, _ := st["at"].([]any)
		if len(p) != 3 {
			continue
		}
		x, y, z := num(p[0]), num(p[1]), num(p[2])
		if 2*x > beam || 2*x < -beam || 2*z > length || 2*z < -length {
			problems = append(problems, fmt.Sprintf("  boats[%d].stations[%d]: (%v, %v) is outside the hull's %v by %v m", i, j, x, z, beam, length))
		}
		if !(y > 0 && y < boom) {
			problems = append(problems, fmt.Sprintf("  boats[%d].stations[%d]: %v m up is not on a deck above the waterline and below the boom (%v m)", i, j, y, boom))
		}
		for k, o := range at {
			dx, dy, dz := x-o[0], y-o[1], z-o[2]
			if dx*dx+dy*dy+dz*dz < stationsApart*stationsApart {
				problems = append(problems, fmt.Sprintf("  boats[%d].stations[%d]: within %v m of stations[%d]", i, j, stationsApart, k))
			}
		}
		at = append(at, [3]float64{x, y, z})
	}
	return problems
}
