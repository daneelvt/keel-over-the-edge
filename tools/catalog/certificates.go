// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// checkCertificates fails when the certificates do not hold together: a
// boat they open that is not in the catalog, or opened by two of them, or
// the boat each sailor brings to the fleet opened by any (it is always
// open); a certificate needing more tasks than it has; a task id twice in
// one certificate; a course task without both ways, or with a measure; a
// log task without its measure and mark, or with a course; a way asking
// for one run on each course of a task of one course.
func checkCertificates(doc map[string]any) error {
	certs := asList(doc["certificates"])
	if len(certs) == 0 {
		return nil
	}
	var problems []string
	boats := map[string]bool{}
	sailors := map[string]bool{}
	for _, b := range asList(doc["boats"]) {
		id, _ := b["id"].(string)
		boats[id] = true
		if f, _ := b["fleet"].(string); f == "sailor" {
			sailors[id] = true
		}
	}
	opened := map[string]string{}
	for _, c := range certs {
		id, _ := c["id"].(string)
		opens, _ := c["opens"].([]any)
		for _, o := range opens {
			boat, _ := o.(string)
			switch {
			case !boats[boat]:
				problems = append(problems, fmt.Sprintf("  %s opens %q, not a boat of the catalog", id, boat))
			case sailors[boat]:
				problems = append(problems, fmt.Sprintf("  %s opens %q, the boat every sailor brings: it is always open", id, boat))
			case opened[boat] != "":
				problems = append(problems, fmt.Sprintf("  %s opens %q, which %s opens already", id, boat, opened[boat]))
			default:
				opened[boat] = id
			}
		}
		tasks := asList(c["tasks"])
		if n := number(c["needs"]); n > float64(len(tasks)) {
			problems = append(problems, fmt.Sprintf("  %s needs %v tasks of %d", id, n, len(tasks)))
		}
		seen := map[string]bool{}
		for _, t := range tasks {
			tid, _ := t["id"].(string)
			if seen[tid] {
				problems = append(problems, fmt.Sprintf("  %s: task %q is listed twice", id, tid))
			}
			seen[tid] = true
			courses, isCourse := t["courses"].([]any)
			_, hasMeasure := t["measure"]
			_, hasAt := t["at"]
			hand, hasHand := t["hand"].(map[string]any)
			venture, hasVenture := t["venture"].(map[string]any)
			switch {
			case isCourse && (!hasHand || !hasVenture):
				problems = append(problems, fmt.Sprintf("  %s: course task %q needs its hand and its venture", id, tid))
			case isCourse && (hasMeasure || hasAt):
				problems = append(problems, fmt.Sprintf("  %s: course task %q has a measure", id, tid))
			case !isCourse && (!hasMeasure || !hasAt):
				problems = append(problems, fmt.Sprintf("  %s: task %q is neither a course task nor a log task with its measure and mark", id, tid))
			case !isCourse && (hasHand || hasVenture):
				problems = append(problems, fmt.Sprintf("  %s: log task %q has a way of sailing a course", id, tid))
			}
			for _, w := range []map[string]any{hand, venture} {
				if each, _ := w["each"].(bool); each && len(courses) < 2 {
					problems = append(problems, fmt.Sprintf("  %s: task %q asks for one run on each of one course", id, tid))
				}
			}
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return fmt.Errorf("the certificates:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}

// number is a catalog's number, 0 for none.
func number(v any) float64 {
	switch n := v.(type) {
	case json.Number:
		f, _ := n.Float64()
		return f
	case float64:
		return n
	}
	return 0
}
