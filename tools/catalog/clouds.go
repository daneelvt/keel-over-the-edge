// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
)

// heapedForms are the forms of cloud drawn from a recipe of puffs, each in
// art/clouds/<form>.json. The fair-weather cumulus and the islands' caps
// are drawn by the cumulus's.
var heapedForms = []string{"cumulus", "cumulonimbus", "storm"}

// checkClouds checks what the schema cannot: that every heaped form has its
// recipe, that each kind's cloud's top is above its base and its deck's
// top too, and that the sheets' layers lie in order, low under middle under
// cirrus, with the fair-weather cumulus's and the caps' tops above their
// base.
func checkClouds(root string, doc map[string]any) error {
	w, _ := doc["weather"].(map[string]any)
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

	for _, form := range heapedForms {
		p := filepath.Join(root, artDir, cloudsDir, form+".json")
		if _, err := os.Stat(p); err != nil {
			bad("the %s form has no recipe: %s/%s/%s.json does not exist", form, artDir, cloudsDir, form)
		}
	}
	systems, _ := w["systems"].([]any)
	for _, k := range systems {
		m, _ := k.(map[string]any)
		id, _ := m["id"].(string)
		c, _ := m["cloud"].(map[string]any)
		form, _ := c["form"].(string)
		heaped := false
		for _, f := range heapedForms {
			heaped = heaped || f == form
		}
		if !heaped {
			continue
		}
		base, top := num(c["base"]), num(c["top"])
		if !(base < top) {
			bad("weather.systems[%s].cloud: its top (%v) must be above its base (%v)", id, c["top"], c["base"])
		}
		if reach, deckTop := at(c["deck"], 0), at(c["deck"], 1); reach > 0 && !(base < deckTop) {
			bad("weather.systems[%s].cloud.deck: its top (%v) must be above its base (%v)", id, deckTop, c["base"])
		}
		if s, ok := c["sheets"].(map[string]any); ok {
			for _, l := range []string{"cirrus", "middle", "low"} {
				if !(at(s[l], 1) <= at(s[l], 0)) {
					bad("weather.systems[%s].cloud.sheets.%s: it must be whole (%v) within where it begins (%v)", id, l, at(s[l], 1), at(s[l], 0))
				}
			}
		}
	}

	c, _ := w["clouds"].(map[string]any)
	if !(num(c["low"]) < num(c["middle"]) && num(c["middle"]) < num(c["cirrus"])) {
		bad("weather.clouds: the layers must lie low (%v) under middle (%v) under cirrus (%v)", c["low"], c["middle"], c["cirrus"])
	}
	for _, f := range []string{"cumulusTops", "cumulusSize", "capSun", "capTops"} {
		if !(at(c[f], 0) <= at(c[f], 1)) {
			bad("weather.clouds.%s: %v is not from low to high", f, c[f])
		}
	}
	if !(num(c["cumulusBase"]) < at(c["cumulusTops"], 0)) {
		bad("weather.clouds: the cumulus's tops (%v) must be above its base (%v)", c["cumulusTops"], c["cumulusBase"])
	}
	if !(num(c["cumulusBase"]) < at(c["capTops"], 0)) {
		bad("weather.clouds: the caps' tops (%v) must be above the cumulus's base (%v)", c["capTops"], c["cumulusBase"])
	}
	for _, f := range []string{"frontCirrus", "frontMiddle"} {
		if !(at(c[f], 1) <= at(c[f], 0)) || !(at(c[f], 2) <= at(c[f], 3)) {
			bad("weather.clouds.%s: %v must be whole within where it begins ahead, and clear before it is gone behind", f, c[f])
		}
	}
	words, _ := c["rainWords"].([]any)
	for i := 1; i < len(words); i++ {
		if !(num(words[i-1]) < num(words[i])) {
			bad("weather.clouds.rainWords: %v does not rise", c["rainWords"])
			break
		}
	}

	if len(problems) > 0 {
		return fmt.Errorf("the clouds:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}
