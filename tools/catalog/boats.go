// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

// checkBoats checks what the schema cannot of each boat: that its start
// sheet's angles rise and its sheets lie from 0 to 1.
func checkBoats(doc map[string]any) error {
	var problems []string
	boats, _ := doc["boats"].([]any)
	for i, b := range boats {
		m, _ := b.(map[string]any)
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
