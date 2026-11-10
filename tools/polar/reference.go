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
	Measure   string  `json:"measure"`
	Against   string  `json:"against,omitempty"`
	AtMost    bool    `json:"atMost,omitempty"`
	TWA       float64 `json:"twa,omitempty"`
	Wind      float64 `json:"wind"`
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
	if p.AtMost {
		ok = got <= p.Value*(1+p.Tolerance)
		return ok, fmt.Sprintf("%5.2f, at most %5.2f", got, p.Value)
	}
	ok = off >= -p.Tolerance && off <= p.Tolerance
	return ok, fmt.Sprintf("%5.2f against %5.2f (%+.1f%%, within ±%.0f%%)", got, p.Value, 100*off, 100*p.Tolerance)
}

func (p refPoint) label() string {
	switch p.Measure {
	case "speed":
		return fmt.Sprintf("speed at %g°", p.TWA)
	case "upwindAngle":
		return "upwind angle"
	case "upwindLeeway":
		return "upwind leeway"
	case "course":
		return "course / " + p.Against
	}
	return p.Measure
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
		if p.Measure == "course" {
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
		if p.Measure == "course" {
			other := kindsByID[p.Against]
			if other == nil {
				return fmt.Errorf("a course against %q, which is not a boat of the catalog", p.Against)
			}
			var legs string
			got, legs, err = courseRatio(rk, other, p.Wind)
			if err == nil {
				fmt.Printf("       %4g knots  %s\n", p.Wind, legs)
			}
		} else {
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
			failed = append(failed, fmt.Sprintf("%g knots, %s: %s", p.Wind, p.label(), text))
		}
		fmt.Printf("  %s %4g knots  %-16s %s\n", mark, p.Wind, p.label(), text)
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
