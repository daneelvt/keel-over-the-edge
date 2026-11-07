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
// that run from low to high, a bird with a look to draw it by and a
// swimmer with a body, a kind that stays over a patch or with a boat with
// a stay to keep, a ground with a patch, and the groups a kind brings
// among the kinds.

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
	if flush, _ := life["flush"].(map[string]any); flush != nil {
		ranged("life.flush.ahead", flush["ahead"])
	}
	kinds, _ := life["kinds"].([]any)
	ids := map[string]bool{}
	for _, k := range kinds {
		kind, _ := k.(map[string]any)
		id, _ := kind["id"].(string)
		ids[id] = true
	}
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
		if f := kind["form"]; f != "bird" && f != "bait" && f != "glow" && kind["swim"] == nil {
			bad("%s: a swimmer with no swim to draw it by", where)
		}
		if swim, _ := kind["swim"].(map[string]any); swim != nil {
			for _, r := range []string{"spins", "glide", "breaths", "dive"} {
				ranged(where+".swim."+r, swim[r])
			}
		}
		ranged(where+".patch", kind["patch"])
		if (kind["binds"] == "flush" || kind["form"] == "bait") && kind["patch"] == nil {
			bad("%s: a ground or a boil with no patch", where)
		}
		brings, _ := kind["brings"].([]any)
		for j, b := range brings {
			bring, _ := b.(map[string]any)
			ranged(fmt.Sprintf("%s.brings[%d].count", where, j), bring["count"])
			if other, _ := bring["kind"].(string); !ids[other] || other == id {
				bad("%s.brings[%d]: %v is not another of the life's kinds", where, j, bring["kind"])
			}
		}
		_, binds := kind["binds"]
		if p := kind["path"]; p == "soar" || p == "work" || p == "stay" || p == "drift" || binds {
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
