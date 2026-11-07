// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
)

// The sea's life is checked here for what the schema cannot say: ranges
// that run from low to high, a bird with a look to draw it by, and a kind
// that stays over a patch or with a boat with a stay to keep.

// checkLife fails on life values the schema cannot judge.
func checkLife(doc map[string]any) error {
	life, ok := doc["life"].(map[string]any)
	if !ok {
		return nil
	}
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
	ranged("life.dusk", life["dusk"])
	kinds, _ := life["kinds"].([]any)
	for i, k := range kinds {
		kind, _ := k.(map[string]any)
		id, _ := kind["id"].(string)
		where := fmt.Sprintf("life.kinds[%d] (%s)", i, id)
		for _, r := range []string{"wind", "group", "stay", "speed", "height"} {
			ranged(where+"."+r, kind[r])
		}
		if kind["form"] == "bird" && kind["look"] == nil {
			bad("%s: a bird with no look", where)
		}
		_, binds := kind["binds"]
		if p := kind["path"]; p == "soar" || p == "work" || binds {
			if st, _ := kind["stay"].([]any); len(st) == 2 && !(num(st[1]) > 0) {
				bad("%s: stays over a patch or with a boat, with no stay", where)
			}
		}
		if sp, _ := kind["speed"].([]any); len(sp) == 2 && !(num(sp[0]) > 0) {
			bad("%s: a speed of nothing never arrives", where)
		}
	}
	towns, _ := life["towns"].(map[string]any)
	ranged("life.towns.count", towns["count"])
	ranged("life.towns.wheel", towns["wheel"])
	ranged("life.towns.height", towns["height"])
	found := false
	for _, k := range kinds {
		kind, _ := k.(map[string]any)
		if kind["id"] == towns["kind"] && kind["form"] == "bird" {
			found = true
		}
	}
	if !found {
		bad("life.towns.kind: %v is not a bird of the life's kinds", towns["kind"])
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return fmt.Errorf("the sea's life:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}
