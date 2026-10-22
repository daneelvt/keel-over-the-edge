// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The lights' fog signals, the fog banks' fog and lightning are checked
// here for what the schema cannot say: every device has its sound's
// recipe, every pattern begins with a blast and ends with a silence, each
// role's device has patterns enough for the lights near one another to
// differ, and the visibility's words and the kinds' ranges run in order.

// fogSignalsLeast is how many patterns a role's device must have: up to
// nine other lights stand within two nautical miles of one in the worlds
// made, so ten let each differ from all of them. Port Royal's, one a
// world, needs one.
const fogSignalsLeast = 10

// checkFog fails on fog signals, fog or lightning the schema cannot judge.
func checkFog(root string, doc map[string]any) error {
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
	at := func(v any, i int) float64 {
		a, _ := v.([]any)
		if i >= len(a) {
			return math.NaN()
		}
		return num(a[i])
	}

	w, _ := doc["weather"].(map[string]any)
	vis, _ := w["visibility"].(map[string]any)
	words, _ := vis["words"].([]any)
	for i := 1; i < len(words); i++ {
		if !(num(words[i-1]) < num(words[i])) {
			bad("weather.visibility.words: %v does not rise", vis["words"])
			break
		}
	}
	systems, _ := w["systems"].([]any)
	for _, k := range systems {
		m, _ := k.(map[string]any)
		id, _ := m["id"].(string)
		if f, ok := m["fog"].(map[string]any); ok && !(at(f["core"], 0) <= at(f["core"], 1)) {
			bad("weather.systems[%s].fog.core: %v is not from low to high", id, f["core"])
		}
		if l, ok := m["lightning"].(map[string]any); ok && !(at(l["within"], 0) <= at(l["within"], 1)) {
			bad("weather.systems[%s].lightning.within: %v is not from low to high", id, l["within"])
		}
	}

	world, _ := doc["world"].(map[string]any)
	lights, _ := world["lights"].(map[string]any)
	signals, _ := lights["fogSignals"].([]any)
	count := map[string]int{}
	seen := map[string]bool{}
	for i, s := range signals {
		m, _ := s.(map[string]any)
		device, _ := m["device"].(string)
		notation, _ := m["notation"].(string)
		count[device]++
		if seen[device+" "+notation] {
			bad("world.lights.fogSignals[%d]: %q twice for the %s", i, notation, device)
		}
		seen[device+" "+notation] = true
		if steps, _ := m["steps"].([]any); len(steps)%2 != 0 {
			bad("world.lights.fogSignals[%d]: %d steps, ending on a blast: blasts and silences go in pairs", i, len(steps))
		}
	}
	devices := make([]string, 0, len(count))
	for d := range count {
		devices = append(devices, d)
	}
	sort.Strings(devices)
	for _, d := range devices {
		p := filepath.Join(root, artDir, soundDir, d+".json")
		if _, err := os.Stat(p); err != nil {
			bad("the %s has no recipe: %s/%s/%s.json does not exist", d, artDir, soundDir, d)
		}
	}
	rule, _ := lights["fogSignal"].(map[string]any)
	roles, _ := rule["devices"].(map[string]any)
	for _, role := range []string{"mainPort", "port", "edge", "hazard"} {
		d, _ := roles[role].(string)
		least := fogSignalsLeast
		if role == "mainPort" {
			least = 1
		}
		if count[d] < least {
			bad("world.lights.fogSignal.devices.%s: the %s has %d patterns, fewer than %d", role, d, count[d], least)
		}
	}

	if len(problems) > 0 {
		sort.Strings(problems)
		return fmt.Errorf("fog, fog signals and lightning:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}
