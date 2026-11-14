// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"sort"
	"strings"
)

// checkCommittee fails when the committee's signal flags do not hold
// together: a flag's rows of unequal length or naming a dye not listed, a
// class pennant for a boat that is not in the catalog or for a boat that
// has another, a boat with none, or one of the other signals flown by no
// flag or by two.
func checkCommittee(doc map[string]any) error {
	world, _ := doc["world"].(map[string]any)
	c, _ := world["committee"].(map[string]any)
	if c == nil {
		return nil
	}
	var problems []string
	dyes := map[string]bool{}
	for _, d := range asList(c["dyes"]) {
		letter, _ := d["letter"].(string)
		if dyes[letter] {
			problems = append(problems, fmt.Sprintf("  dye %q is listed twice", letter))
		}
		dyes[letter] = true
	}
	boats := map[string]bool{}
	for _, b := range asList(doc["boats"]) {
		id, _ := b["id"].(string)
		boats[id] = true
	}
	classes := map[string]string{}
	signals := map[string][]string{}
	for _, f := range asList(c["flags"]) {
		id, _ := f["id"].(string)
		signal, _ := f["signal"].(string)
		boat, hasBoat := f["boat"].(string)
		rows, _ := f["rows"].([]any)
		width := -1
		for i, r := range rows {
			row, _ := r.(string)
			if width >= 0 && len(row) != width {
				problems = append(problems, fmt.Sprintf("  flag %s: row %d is %d long, not %d", id, i, len(row), width))
			}
			width = len(row)
			for _, ch := range row {
				if !dyes[string(ch)] {
					problems = append(problems, fmt.Sprintf("  flag %s: row %d names dye %q, not listed", id, i, string(ch)))
				}
			}
		}
		if signal == "class" {
			switch {
			case !hasBoat:
				problems = append(problems, fmt.Sprintf("  flag %s: a class pennant names no boat", id))
			case !boats[boat]:
				problems = append(problems, fmt.Sprintf("  flag %s: boat %q is not in the catalog", id, boat))
			case classes[boat] != "":
				problems = append(problems, fmt.Sprintf("  flag %s: boat %q already has %s", id, boat, classes[boat]))
			default:
				classes[boat] = id
			}
			continue
		}
		if hasBoat {
			problems = append(problems, fmt.Sprintf("  flag %s: only a class pennant names a boat", id))
		}
		signals[signal] = append(signals[signal], id)
	}
	for id := range boats {
		if classes[id] == "" {
			problems = append(problems, fmt.Sprintf("  boat %s has no class pennant", id))
		}
	}
	for _, s := range []string{"preparatory", "recall", "postponement", "mark", "pin"} {
		if n := len(signals[s]); n != 1 {
			problems = append(problems, fmt.Sprintf("  signal %s is flown by %d flags, not one", s, n))
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return fmt.Errorf("the committee's flags:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}

// asList is a list of objects, or nil.
func asList(v any) []map[string]any {
	items, _ := v.([]any)
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		if m, ok := it.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}
