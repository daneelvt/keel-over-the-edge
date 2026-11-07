// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"io"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/life"
)

// The targets each row is set beside.
const (
	targetGap      = "6–10 min"
	targetLong     = "20–30 min, common"
	targetPassing  = "4–6 near islands, 1–2 outer"
	targetWorking  = "about 1"
	targetNoTarget = ""
)

// write prints the tally as Markdown: the rows the targets are set for,
// each kind's row, and with kinds each kind in each habitat.
func (t *tally) write(w io.Writer, o options, kinds bool) {
	day, all := &t.hours[byDay], &t.hours[allHours]
	fmt.Fprintf(w, "%d worlds, %d routes of %g h at 5 kn: %.0f h sailed, %.0f h by day (%.0f h near the islands, %.0f h in the outer water).\n\n",
		t.worlds, t.routes, o.Hours, all[everywhere], day[everywhere], day[nearIslands], day[outerWater])
	fmt.Fprintln(w, "By day, an hour sailed, unless it says otherwise; all hours counts the night's hours too, when no bird is seen.")
	fmt.Fprintln(w, "Near the islands is within 1.5 NM of land, short of the outer water, beyond 3.5 NM of the centre.")
	fmt.Fprintln(w, "A gap runs from one group coming in sight to the next in the same daylight, an empty stretch while none is in sight;")
	fmt.Fprintln(w, "the night and the route's ends cut both. A gap cut is not counted, so long gaps are under-counted: the mean gap is")
	fmt.Fprintln(w, "the daylight sailed over the groups seen. The longest empty stretch is of the routes sailed an hour or more by day.")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "| | Near islands | Outer water | Everywhere | All hours | Target |")
	fmt.Fprintln(w, "|---|---:|---:|---:|---:|---|")
	row := func(name string, c *[2][waters]float64, target string) {
		fmt.Fprintf(w, "| %s | %s | %s | %s | %s | %s |\n", name,
			per(c[byDay][nearIslands], day[nearIslands]), per(c[byDay][outerWater], day[outerWater]),
			per(c[byDay][everywhere], day[everywhere]), per(c[allHours][everywhere], all[everywhere]), orDash(target))
	}
	gaps := slices.Sorted(slices.Values(t.gaps))
	empty := slices.Sorted(slices.Values(t.empty))
	longest := slices.Sorted(slices.Values(t.longest))
	single := func(name, v, target string) {
		fmt.Fprintf(w, "| %s | | | %s | | %s |\n", name, v, orDash(target))
	}
	mean := -1.0
	if n := t.groups[byDay][everywhere]; n > 0 {
		mean = 3600 * day[everywhere] / n
	}
	single("Something in sight: mean gap between groups coming in sight, daylight over groups", minutes(mean), targetNoTarget)
	single("Something in sight: median gap between groups coming in sight", minutes(median(gaps)), targetGap)
	single("Gaps of 20 min or more", share(atLeast(gaps, 1200), len(gaps)), targetNoTarget)
	single("Empty stretch with nothing in sight, median", minutes(median(empty)), targetNoTarget)
	single("Empty stretches of 20 min or more", share(atLeast(empty, 1200), len(empty)), "common")
	single("Empty stretches of 30 min or more", share(atLeast(empty, 1800), len(empty)), targetNoTarget)
	single("Longest empty stretch a route, median", minutes(median(longest)), targetLong)
	single("Longest empty stretch a route, the longest", minutes(last(longest)), targetNoTarget)
	single("Daylight with something in sight", share(t.inSight/3600, day[everywhere]), targetNoTarget)
	row("Groups in sight", &t.groups, targetNoTarget)
	row("Birds passing", &t.passing, targetPassing)
	row("Birds working the water", &t.working, targetWorking)
	fmt.Fprintf(w, "| Groups following the boat | | | %s | %s | — |\n", per(t.followed[byDay], day[everywhere]), per(t.followed[allHours], all[everywhere]))
	water := false
	for i := range t.kinds {
		water = water || t.kinds[i].Form != catalog.LifeFormBird
	}
	if water {
		row("Life in the water: dolphins, turtles, whales", &t.inWater, targetNoTarget)
	} else {
		fmt.Fprintln(w, "| Life in the water: dolphins, turtles, whales | — | — | — | — | — |")
	}
	for i := range t.kinds {
		k := &t.kinds[i]
		c := [2][waters]float64{t.sighted[byDay][i], t.sighted[allHours][i]}
		row(k.Plural, &c, targetNoTarget)
	}
	if !kinds {
		return
	}
	order := [...]int{life.Harbour, life.Reef, life.Shelf, life.Deep, life.Outer}
	names := [...]string{life.Harbour: "Harbour", life.Reef: "Reef", life.Shelf: "Shelf", life.Deep: "Deep", life.Outer: "Outer"}
	fmt.Fprintln(w)
	fmt.Fprintln(w, "By day, an hour sailed in each habitat where the boat is.")
	fmt.Fprintln(w)
	fmt.Fprint(w, "| Kind |")
	for _, h := range order {
		fmt.Fprintf(w, " %s |", names[h])
	}
	fmt.Fprint(w, "\n|---|")
	for range order {
		fmt.Fprint(w, "---:|")
	}
	fmt.Fprint(w, "\n| Hours sailed |")
	for _, h := range order {
		fmt.Fprintf(w, " %.0f |", day[habitats+h])
	}
	fmt.Fprintln(w)
	for i := range t.kinds {
		fmt.Fprintf(w, "| %s |", t.kinds[i].Plural)
		for _, h := range order {
			fmt.Fprintf(w, " %s |", per(t.sighted[byDay][i][habitats+h], day[habitats+h]))
		}
		fmt.Fprintln(w)
	}
}

// per is n an hour of h hours, to two places: a dash with no hours.
func per(n, h float64) string {
	if !(h > 0) {
		return "—"
	}
	return fmt.Sprintf("%.2f", n/h)
}

// share is n of m as a percentage: a dash of none.
func share[N int | float64](n, m N) string {
	if m <= 0 {
		return "—"
	}
	return fmt.Sprintf("%.0f%%", 100*float64(n)/float64(m))
}

// minutes is s seconds in minutes: a dash for none.
func minutes(s float64) string {
	if s < 0 {
		return "—"
	}
	return fmt.Sprintf("%.1f min", s/60)
}

// orDash is a target, a dash for none.
func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

// median is the middle of sorted values, −1 of none.
func median(v []float64) float64 {
	if len(v) == 0 {
		return -1
	}
	if len(v)%2 == 1 {
		return v[len(v)/2]
	}
	return (v[len(v)/2-1] + v[len(v)/2]) / 2
}

// last is the greatest of sorted values, −1 of none.
func last(v []float64) float64 {
	if len(v) == 0 {
		return -1
	}
	return v[len(v)-1]
}

// atLeast is how many of sorted values are at least s.
func atLeast(v []float64, s float64) int {
	i, _ := slices.BinarySearch(v, s)
	return len(v) - i
}
