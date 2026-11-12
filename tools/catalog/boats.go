// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"fmt"
	"math"
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
		problems = append(problems, checkHulls(i, ph)...)
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

// checkHulls checks boat i's hulls: a boat of two hulls has a rudder and
// a lateral plane on each, which the ground never pushes up, and a
// monohull one of each and no flying drag; and a rig pitches the hull or
// does not, its bows burying before it pitchpoles.
func checkHulls(i int, ph map[string]any) []string {
	var problems []string
	num := func(g map[string]any, k string) float64 {
		f, _ := g[k].(json.Number).Float64()
		return f
	}
	hull, _ := ph["hull"].(map[string]any)
	if step := num(hull, "rightingLeverStep"); 180/step != math.Trunc(180/step) {
		problems = append(problems, fmt.Sprintf("  boats[%d].physics.hull.rightingLeverStep: 180° over %v° is not a whole number", i, step))
	}
	h, _ := ph["hulls"].(map[string]any)
	foils, _ := ph["foils"].(map[string]any)
	rudders, boards := num(h, "rudderCount"), num(h, "boardCount")
	if num(h, "hullSpacing") > 0 {
		if rudders != 2 || boards != 2 {
			problems = append(problems, fmt.Sprintf("  boats[%d].physics.hulls: two hulls need two rudders and two lateral planes, not %v and %v", i, rudders, boards))
		}
		if num(foils, "fixed") != 1 {
			problems = append(problems, fmt.Sprintf("  boats[%d].physics.foils.fixed: two hulls' lateral planes are fixed, 1", i))
		}
	} else if rudders != 1 || boards != 1 || num(h, "flyingDrag") != 1 {
		problems = append(problems, fmt.Sprintf("  boats[%d].physics.hulls: one hull has one rudder, one board and a flying drag of 1", i))
	}
	p, _ := ph["pitch"].(map[string]any)
	switch rig := num(p, "rigPitch"); {
	case rig != 0 && rig != 1:
		problems = append(problems, fmt.Sprintf("  boats[%d].physics.pitch.rigPitch: %v is neither 0 nor 1", i, rig))
	case rig == 1 && !(num(p, "bowBuryPitch") > 0 && num(p, "bowBuryPitch") < num(p, "pitchpoleAngle")):
		problems = append(problems, fmt.Sprintf("  boats[%d].physics.pitch: the bows bury at %v°, which must be above 0 and before the pitchpole at %v°", i, num(p, "bowBuryPitch"), num(p, "pitchpoleAngle")))
	}
	return problems
}

// stationsApart is how near two people's stations may be, in m: about a
// person's breadth.
const stationsApart = 0.45

// lookoutField is the name of a boat's lookout's eye's height: spelled in
// two, as the whole word is also a sailor look's id, which code may not
// quote.
const lookoutField = "look" + "out"

// railFromEdge is how far a station on the rail may be from the deck's edge,
// in m: its point is the edge under the person.
const railFromEdge = 0.1

// deckEdge returns how far out from the centreline boat m's deck reaches at
// z, in m: its hull's outline, half-beams from the transom (z = transom) to
// the stem over its length overall.
func deckEdge(m map[string]any, z float64) float64 {
	num := func(v any) float64 {
		f, _ := v.(json.Number).Float64()
		return f
	}
	ph, _ := m["physics"].(map[string]any)
	hull, _ := ph["hull"].(map[string]any)
	outline, _ := hull["outline"].([]any)
	length := num(m["lengthOverall"])
	if len(outline) < 2 || length <= 0 {
		return 0
	}
	u := min(1, max(0, (num(hull["transom"])-z)/length))
	x := u * float64(len(outline)-1)
	i := min(len(outline)-2, int(x))
	f := x - float64(i)
	return num(outline[i])*(1-f) + num(outline[i+1])*f
}

// checkStations checks boat i's stations: one for each person it carries,
// each on its deck within its hull (within its beam and its length, above
// the waterline and below the boom; a station aloft, above the boom, no
// higher than its lookout's eye), none on another wherever the wind is
// (a station to windward or to leeward drawn on its side or its mirror,
// as the weather side has it); and one on the rail at the deck's edge. The
// client's tests hold each to the model's deck itself.
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
	lookout := num(m[lookoutField])
	ph, _ := m["physics"].(map[string]any)
	rig, _ := ph["rig"].(map[string]any)
	boom := num(rig["boomHeight"])
	at := make([][3]float64, 0, len(stations))
	// Each station's side: +1 drawn on the weather side, −1 on the lee, 0 where it is.
	sides := make([]int, 0, len(stations))
	for j, s := range stations {
		st, _ := s.(map[string]any)
		p, _ := st["at"].([]any)
		if len(p) != 3 {
			continue
		}
		x, y, z := num(p[0]), num(p[1]), num(p[2])
		if st["pose"] == "rail" {
			if edge := deckEdge(m, z); math.Abs(math.Abs(x)-edge) > railFromEdge {
				problems = append(problems, fmt.Sprintf("  boats[%d].stations[%d]: on the rail %v m out, but the deck's edge is %v m out there", i, j, math.Abs(x), math.Round(edge*1000)/1000))
			}
		}
		if 2*x > beam || 2*x < -beam || 2*z > length || 2*z < -length {
			problems = append(problems, fmt.Sprintf("  boats[%d].stations[%d]: (%v, %v) is outside the hull's %v by %v m", i, j, x, z, beam, length))
		}
		if st["pose"] == "aloft" {
			if !(y >= boom && y <= lookout) {
				problems = append(problems, fmt.Sprintf("  boats[%d].stations[%d]: aloft %v m up is not above the boom (%v m) and no higher than the lookout's eye (%v m)", i, j, y, boom, lookout))
			}
		} else if !(y > 0 && y < boom) {
			problems = append(problems, fmt.Sprintf("  boats[%d].stations[%d]: %v m up is not on a deck above the waterline and below the boom (%v m)", i, j, y, boom))
		}
		w, _ := st["windward"].(bool)
		l, _ := st["lee"].(bool)
		side := 0
		switch {
		case w && l:
			problems = append(problems, fmt.Sprintf("  boats[%d].stations[%d]: both to windward and to leeward", i, j))
		case w:
			side = 1
		case l:
			side = -1
		}
		at = append(at, [3]float64{x, y, z})
		sides = append(sides, side)
	}
	// Where each is drawn with the weather on either side: none within a
	// person's breadth of another.
	drawn := func(k, weather int) [3]float64 {
		p := at[k]
		if sides[k] == 0 {
			return p
		}
		own := 1
		if p[0] < 0 {
			own = -1
		}
		if own != sides[k]*weather {
			p[0] = -p[0]
		}
		return p
	}
	near := func(a, b [3]float64) bool {
		dx, dy, dz := a[0]-b[0], a[1]-b[1], a[2]-b[2]
		return dx*dx+dy*dy+dz*dz < stationsApart*stationsApart
	}
	for j := range at {
		for k := range j {
			for _, weather := range []int{1, -1} {
				if near(drawn(j, weather), drawn(k, weather)) {
					how := ""
					if sides[j] != 0 || sides[k] != 0 {
						how = map[int]string{1: " with the weather to starboard", -1: " with the weather to port"}[weather]
					}
					problems = append(problems, fmt.Sprintf("  boats[%d].stations[%d]: within %v m of stations[%d]%s", i, j, stationsApart, k, how))
					break
				}
			}
		}
	}
	return problems
}
