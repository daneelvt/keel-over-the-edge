// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"regexp"
	"testing"
	"time"
)

// plainWordsBanned are racing words a newcomer does not know, which no
// name a card shows may hold.
var plainWordsBanned = regexp.MustCompile(`(?i)windward.?leeward|warning signal|preparatory|\b(RET|DNS|DNF)\b`)

// TestCourseNamesInPlainWords: every buoy course's name, and the names
// suggested for races and trials on it, are in plain words.
func TestCourseNamesInPlainWords(t *testing.T) {
	at := time.Date(2026, 11, 24, 15, 0, 0, 0, time.UTC)
	for _, shape := range []string{ShapeWindwardLeeward, ShapeTriangle, ShapeReach, ShapeDash} {
		for _, long := range []bool{false, true} {
			names := []string{BuoyName(shape, long, "Port Royal"), BuoyName(shape, long, ""), StandingName(CourseBuoy, shape, long, "")}
			for seed := range uint64(8) {
				names = append(names, Suggest(KindRace, CourseBuoy, shape, "", "Port Royal", at, time.UTC, seed),
					Suggest(KindTrial, CourseBuoy, shape, "", "Port Royal", at, time.UTC, seed))
			}
			for _, n := range names {
				if plainWordsBanned.MatchString(n) {
					t.Errorf("%s, long %v: the name %q", shape, long, n)
				}
			}
		}
	}
	if got := BuoyName(ShapeWindwardLeeward, false, "Port Royal"); got != "Short upwind and back off Port Royal" {
		t.Errorf("the short windward–leeward is called %q", got)
	}
	if got := BuoyName(ShapeDash, false, "Port Royal"); got != "Dash off Port Royal" {
		t.Errorf("the Dash is called %q", got)
	}
}
