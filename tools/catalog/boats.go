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
// fixed or not, and that its reefs only shorten its sails; and that the
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
