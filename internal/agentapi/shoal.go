// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The shoal water about the boat, as the bed's colour shows it through
// the water on the phone: in each of shoalSectors directions, how far off
// the first water under shoal lies, out to shoalReach, read from the
// ground the edge hands the phone. Neighbouring directions alike are told
// as one span of bearings; "clear" names the spans with no shoal water to
// the reach, the way out. A boat already in shoal water is told where the
// water deepens instead, and the spans clear beyond it.

// The shoal's reach and how its directions are read.
const (
	shoalSectors = 16
	shoalReach   = 300.0 // m
	// shoalBrief is how near shoal water must be for the brief report to
	// tell it, m.
	shoalBrief = 150.0
	// shoalStep is how far apart a ray is read, m, about a hexagon; each
	// sector is read along shoalRays rays across it.
	shoalStep = 4.0
	shoalRays = 3
	// shoalSlack is how far a span's ranges may part beyond twice the
	// nearest, m.
	shoalSlack = 20
)

// shoalSpan is a run of neighbouring sectors alike: their first and last
// bearings, degrees, and the nearest and furthest of their ranges, m,
// rounded as a lookout judges a distance; no range for a clear span.
type shoalSpan struct {
	From int `json:"from"`
	To   int `json:"to"`
	Near int `json:"nearM,omitempty"`
	Far  int `json:"farM,omitempty"`
}

// shoalFacts is the Shoal line's facts. Here says the boat is in shoal
// water itself: Spans are then where the water deepens, not where it
// shoals.
type shoalFacts struct {
	Under float64     `json:"underM"`
	Here  bool        `json:"here,omitempty"`
	Spans []shoalSpan `json:"spans,omitempty"`
	Clear []shoalSpan `json:"clear,omitempty"`
	// nearest is the nearest range of shoal water, m; +Inf for none.
	nearest float64
}

// shoalAbout reads the shoal water about (x, y), nil for none within the
// reach: on open sea, or with deep water all round.
func shoalAbout(g *physics.Ground, x, y float64) *shoalFacts {
	if g == nil {
		return nil
	}
	out := &shoalFacts{Under: shoal, nearest: math.Inf(1)}
	e, _ := g.At(x, y)
	out.Here = e > -shoal
	// Each sector's range: to the first shoal water, or from a boat in
	// shoal water to the first deeper; and whether it is clear beyond.
	var ranges [shoalSectors]float64
	var clear [shoalSectors]bool
	for k := range shoalSectors {
		ranges[k] = math.Inf(1)
		clear[k] = true
		for i := range shoalRays {
			b := rad(float64(k)*360/shoalSectors + (float64(i)-float64(shoalRays-1)/2)*360/shoalSectors/shoalRays)
			r, beyond := shoalRay(g, x, y, b, out.Here)
			ranges[k] = min(ranges[k], r)
			clear[k] = clear[k] && beyond
		}
	}
	if !out.Here {
		for k := range shoalSectors {
			out.nearest = min(out.nearest, ranges[k])
		}
		if math.IsInf(out.nearest, 1) {
			return nil
		}
	} else {
		out.nearest = 0
	}
	// The spans: of shoal water, or of deeper water for a boat in shoal
	// water; then those clear to the reach.
	// A run is broken where its ranges part by more than half, so that each
	// span's ranges say how far off it is.
	for _, run := range runs(func(k int) bool { return !math.IsInf(ranges[k], 1) }) {
		var sp shoalSpan
		for n := range (run[1]-run[0]+shoalSectors)%shoalSectors + 1 {
			k := (run[0] + n) % shoalSectors
			r := roundRange(ranges[k])
			switch {
			case n == 0:
				sp = shoalSpan{From: sectorBearing(k), Near: r, Far: r}
			case r > 2*sp.Near+shoalSlack || 2*r+shoalSlack < sp.Far:
				out.Spans = append(out.Spans, sp)
				sp = shoalSpan{From: sectorBearing(k), Near: r, Far: r}
			}
			sp.To, sp.Near, sp.Far = sectorBearing(k), min(sp.Near, r), max(sp.Far, r)
		}
		out.Spans = append(out.Spans, sp)
	}
	for _, run := range runs(func(k int) bool { return clear[k] && (!out.Here || !math.IsInf(ranges[k], 1)) }) {
		out.Clear = append(out.Clear, shoalSpan{From: sectorBearing(run[0]), To: sectorBearing(run[1])})
	}
	return out
}

// runs are the runs of neighbouring sectors for which in holds, each its
// first and last sector, clockwise from north; none cut at north unless
// every sector is in one.
func runs(in func(k int) bool) [][2]int {
	start := 0
	for k := range shoalSectors {
		if in(k) != in((k+shoalSectors-1)%shoalSectors) {
			start = k
			break
		}
	}
	var out [][2]int
	for n := range shoalSectors {
		k := (start + n) % shoalSectors
		switch {
		case !in(k):
		case n > 0 && in((k+shoalSectors-1)%shoalSectors):
			out[len(out)-1][1] = k
		default:
			out = append(out, [2]int{k, k})
		}
	}
	return out
}

// shoalRay reads the ground along bearing b from (x, y) out to the reach:
// the range of the first shoal water, or with deeper set the first water
// deeper than shoal; and whether, beyond that deeper water, no shoal
// water lies within the reach. +Inf for none found.
func shoalRay(g *physics.Ground, x, y, b float64, deeper bool) (float64, bool) {
	sin, cos := physics.SinCos(b)
	found := math.Inf(1)
	for r := shoalStep; r <= shoalReach; r += shoalStep {
		e, _ := g.At(x+sin*r, y+cos*r)
		shallow := e > -shoal
		switch {
		case deeper && math.IsInf(found, 1) && !shallow:
			found = r
		case !deeper && shallow:
			return r, false
		case deeper && !math.IsInf(found, 1) && shallow:
			return found, false
		}
	}
	return found, !deeper || !math.IsInf(found, 1)
}

// sectorBearing is sector k's bearing, to 5° as the eye reads it,
// degrees.
func sectorBearing(k int) int {
	return int(math.Floor(float64(k)*360/shoalSectors/5+0.5)) * 5
}

// roundRange is a range rounded as a lookout judges it: to 5 m within
// 50 m, 10 m to 200 m and 50 m beyond.
func roundRange(m float64) int {
	switch {
	case m < 50:
		return int(math.Floor(m/5+0.5)) * 5
	case m < 200:
		return int(math.Floor(m/10+0.5)) * 10
	}
	return int(math.Floor(m/50+0.5)) * 50
}

// text is the Shoal line: "under 1.5 m 040°–160°, 30–80 m · 200° ~150 m
// · clear 170°–030°"; or for a boat in shoal water, "under 1.5 m here ·
// deeper 080°–120°, 20–40 m · clear 080°–100°".
func (s *shoalFacts) text() string {
	parts := []string{fmt.Sprintf("under %.1f m", s.Under)}
	if s.Here {
		parts[0] += " here"
		if len(s.Spans) == 0 {
			return parts[0] + fmt.Sprintf(" and all round to %.0f m", shoalReach)
		}
	}
	for i, sp := range s.Spans {
		w := sp.bearings()
		if sp.From == sp.To {
			w += " " + sp.ranges()
		} else {
			w += ", " + sp.ranges()
		}
		if i == 0 && s.Here {
			w = "deeper " + w
		}
		if i == 0 && !s.Here {
			parts[0] += " " + w
			continue
		}
		parts = append(parts, w)
	}
	if len(s.Clear) > 0 {
		var cl []string
		for _, sp := range s.Clear {
			cl = append(cl, sp.bearings())
		}
		parts = append(parts, "clear "+strings.Join(cl, ", "))
	}
	return strings.Join(parts, " · ")
}

// bearings is a span's bearings: "040°–160°", or one.
func (sp shoalSpan) bearings() string {
	if sp.From == sp.To {
		return three(sp.From)
	}
	return three(sp.From) + "–" + three(sp.To)
}

// ranges is a span's ranges: "30–80 m", or "~150 m" for one.
func (sp shoalSpan) ranges() string {
	if sp.Near == sp.Far {
		return fmt.Sprintf("~%d m", sp.Near)
	}
	return fmt.Sprintf("%d–%d m", sp.Near, sp.Far)
}
