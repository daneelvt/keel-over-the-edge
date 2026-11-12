// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
)

// referenceFile is internal/physics/testdata/reference.json.
type referenceFile struct {
	Description string      `json:"description"`
	Boats       []reference `json:"boats"`
}

// reference is the measured performance of one boat's original.
type reference struct {
	Boat     string `json:"boat"`
	Original string `json:"original"`
	// Height is the height its winds are given at, m.
	Height float64 `json:"height"`
	// Crew, if set, sails the reference's points in place of the
	// catalog's sailor (course.go).
	Crew   *crew      `json:"crew,omitempty"`
	Points []refPoint `json:"points"`
	Notes  []string   `json:"notes"`
}

type refPoint struct {
	// Measure is speed (at TWA), upwindVMG or downwindVMG, in knots;
	// upwindAngle, the true wind angle of the best upwind VMG, degrees;
	// upwindLeeway, the leeway there, degrees; or course, the time round
	// the course over the boat Against's, its wind 10 m up (course.go).
	Measure string `json:"measure"`
	Against string `json:"against,omitempty"`
	// AtMost holds the model to at most the value, and its tolerance;
	// AtLeast to at least it, less its tolerance.
	AtMost  bool    `json:"atMost,omitempty"`
	AtLeast bool    `json:"atLeast,omitempty"`
	TWA     float64 `json:"twa,omitempty"`
	Wind    float64 `json:"wind"`
	// Winds, if set, in place of Wind: the point is the boat's best in
	// any of them, at any reef.
	Winds []float64 `json:"winds,omitempty"`
	// Alone sails the point with the catalog's one sailor, not the
	// reference's crew: the boat as players sail it.
	Alone bool `json:"alone,omitempty"`
	// Reef sails a course reefed, 0 to 2.
	Reef float64 `json:"reef,omitempty"`
	// Report prints the point beside its value and never fails.
	Report    bool    `json:"report,omitempty"`
	Value     float64 `json:"value"`
	Tolerance float64 `json:"tolerance"`
	Source    string  `json:"source"`
}

func readReference() (*referenceFile, error) {
	data, err := os.ReadFile(referencePath)
	if err != nil {
		return nil, err
	}
	var r referenceFile
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, fmt.Errorf("%s: %w", referencePath, err)
	}
	return &r, nil
}

func (r *referenceFile) boat(id string) *reference {
	for i := range r.Boats {
		if r.Boats[i].Boat == id {
			return &r.Boats[i]
		}
	}
	return nil
}

// model returns what the polar gives for a reference point.
func (p refPoint) model(polars []polar) (float64, error) {
	for _, pl := range polars {
		if pl.Wind != p.Wind {
			continue
		}
		up, upAngle, down, _ := vmg(pl)
		switch p.Measure {
		case "upwindVMG":
			return up, nil
		case "upwindAngle":
			return upAngle, nil
		case "upwindLeeway":
			return at(pl, upAngle).Leeway, nil
		case "downwindVMG":
			return down, nil
		case "speed":
			pt := at(pl, p.TWA)
			if !pt.OK {
				return 0, fmt.Errorf("at %g° in %g knots the boat %s", p.TWA, p.Wind, pt.cannot())
			}
			return pt.Speed, nil
		}
		return 0, fmt.Errorf("unknown measure %q", p.Measure)
	}
	return 0, fmt.Errorf("no polar for %g knots", p.Wind)
}

// verdict compares the model with a reference point.
func (p refPoint) verdict(got float64) (ok bool, text string) {
	off := got/p.Value - 1
	switch {
	case p.Report:
		return true, fmt.Sprintf("%5.2f beside %5.2f (%+.1f%%), reported", got, p.Value, 100*off)
	case p.AtMost:
		ok = got <= p.Value*(1+p.Tolerance)
		return ok, fmt.Sprintf("%5.2f, at most %5.2f", got, p.Value)
	case p.AtLeast:
		ok = got >= p.Value*(1-p.Tolerance)
		return ok, fmt.Sprintf("%5.2f, at least %5.2f", got, p.Value)
	}
	ok = off >= -p.Tolerance && off <= p.Tolerance
	return ok, fmt.Sprintf("%5.2f against %5.2f (%+.1f%%, within ±%.0f%%)", got, p.Value, 100*off, 100*p.Tolerance)
}

func (p refPoint) label() string {
	l := p.Measure
	switch p.Measure {
	case "speed":
		l = fmt.Sprintf("speed at %g°", p.TWA)
	case "upwindAngle":
		l = "upwind angle"
	case "upwindLeeway":
		l = "upwind leeway"
	case "course":
		l = "course / " + p.Against
	}
	if p.Reef > 0 {
		l += fmt.Sprintf(", reef %g", p.Reef)
	}
	if p.Alone {
		l += ", alone"
	}
	return l
}

// windWords is the point's wind, or its winds.
func (p refPoint) windWords() string {
	if len(p.Winds) == 0 {
		return fmt.Sprintf("%4g knots", p.Wind)
	}
	return fmt.Sprintf("%g–%g knots", p.Winds[0], p.Winds[len(p.Winds)-1])
}

// bestIn is the kind's fastest point at a true wind angle in any of the
// winds, at any reef: its speed, and the wind and reef it is sailed in.
func bestIn(k *kind, twa float64, winds []float64) (speed, wind, reef float64) {
	for r := 0.0; r <= 2; r++ {
		for _, pl := range reefedPolars(k, winds, []float64{twa}, r) {
			if pt := pl.Points[0]; pt.OK && pt.Speed > speed {
				speed, wind, reef = pt.Speed, pl.Wind, r
			}
		}
	}
	return speed, wind, reef
}

// runCheck sails the polar at the reference's winds and angles and fails
// outside the tolerances, then at the chart's winds, and fails unless the
// sail says drawing at the fastest sheet, and unless the handbook's trim
// table and reefing advice for the kind are the polar's. Every wind and
// angle is sailed once, together.
func runCheck(k *kind, ref *reference) error {
	winds := append(slices.Clone(chartWinds), k.trimWinds()...)
	angles := slices.Clone(chartAngles)
	// The reference's points, sailed by its crew if it names one.
	rk := k
	if ref.Crew != nil {
		rk = k.crewed(ref.Crew)
	}
	var refWinds []float64
	for _, p := range ref.Points {
		if p.Measure == "course" || p.Alone || len(p.Winds) > 0 {
			continue
		}
		refWinds = append(refWinds, p.Wind)
		if p.Measure == "speed" {
			angles = append(angles, p.TWA)
		}
	}
	if rk == k {
		winds = append(winds, refWinds...)
	}
	slices.Sort(winds)
	slices.Sort(angles)
	angles = slices.Compact(angles)
	polars := sailPolars(k, slices.Compact(winds), angles)
	refPolars := polars
	if rk != k && len(refWinds) > 0 {
		slices.Sort(refWinds)
		refPolars = sailPolars(rk, slices.Compact(refWinds), angles)
	}
	var failed []string
	fmt.Printf("%s against %s, winds %s\n", k.id, ref.Original, k.heightWords())
	if ref.Crew != nil {
		fmt.Printf("  raced by a crew of %g kg reaching %g m to windward\n", ref.Crew.Mass, ref.Crew.Reach)
	}
	for _, p := range ref.Points {
		var got float64
		var err error
		pk := rk
		if p.Alone {
			pk = k
		}
		switch {
		case p.Measure == "course":
			other := kindsByID[p.Against]
			if other == nil {
				return fmt.Errorf("a course against %q, which is not a boat of the catalog", p.Against)
			}
			var legs string
			got, legs, err = courseRatio(pk, other, p.Wind, p.Reef)
			if err == nil {
				fmt.Printf("       %4g knots  %s\n", p.Wind, legs)
			}
		case len(p.Winds) > 0:
			if p.Measure != "speed" {
				return fmt.Errorf("a point over winds measures speed, not %s", p.Measure)
			}
			var wind, reef float64
			got, wind, reef = bestIn(pk.at10(), p.TWA, p.Winds)
			fmt.Printf("       %s  at its fastest in %g knots, %s\n", p.windWords(), wind, k.reefWord(reef))
		case p.Alone:
			got, err = p.model(sailPolars(k, []float64{p.Wind}, []float64{p.TWA}))
		default:
			got, err = p.model(refPolars)
		}
		if err != nil {
			failed = append(failed, err.Error())
			continue
		}
		ok, text := p.verdict(got)
		mark := "ok  "
		if !ok {
			mark = "FAIL"
			failed = append(failed, fmt.Sprintf("%s, %s: %s", p.windWords(), p.label(), text))
		}
		fmt.Printf("  %s %s  %-16s %s\n", mark, p.windWords(), p.label(), text)
	}
	if k.p.HullSpacing > 0 || k.p.RigPitch != 0 {
		reportHulls(k)
	}
	if k.p.DownwindArea > 0 {
		var courseWinds []float64
		other := ""
		for _, p := range ref.Points {
			if p.Measure == "course" {
				courseWinds, other = append(courseWinds, p.Wind), p.Against
			}
		}
		if o := kindsByID[other]; o != nil {
			reportDownwind(k, o, courseWinds)
		}
	}
	if len(failed) > 0 {
		return errors.New("outside the reference's tolerances:\n  " + strings.Join(failed, "\n  "))
	}
	var chart []polar
	for _, w := range chartWinds {
		p, _ := polarAt(polars, w)
		chart = append(chart, p)
	}
	if err := checkWords(chart); err != nil {
		return err
	}
	return checkHandbook(k, polars)
}
