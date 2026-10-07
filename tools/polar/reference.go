// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// referenceFile is internal/physics/testdata/reference.json.
type referenceFile struct {
	Description string      `json:"description"`
	Boats       []reference `json:"boats"`
}

// reference is the measured performance of one boat's original.
type reference struct {
	Boat     string     `json:"boat"`
	Original string     `json:"original"`
	Points   []refPoint `json:"points"`
	Notes    []string   `json:"notes"`
}

type refPoint struct {
	Measure   string  `json:"measure"` // speed, upwindVMG or downwindVMG
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
		up, _, down, _ := vmg(pl)
		switch p.Measure {
		case "upwindVMG":
			return up, nil
		case "downwindVMG":
			return down, nil
		case "speed":
			pt := at(pl, p.TWA)
			if !pt.OK {
				return 0, fmt.Errorf("the boat capsizes at %g° in %g knots", p.TWA, p.Wind)
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
	if p.Measure == "speed" {
		return fmt.Sprintf("speed at %g°", p.TWA)
	}
	return p.Measure
}

// runCheck sails the polar at the reference's winds and angles and fails
// outside the tolerances.
func runCheck(b *physics.Prepared, id string) error {
	r, err := readReference()
	if err != nil {
		return err
	}
	ref := r.boat(id)
	if ref == nil {
		return fmt.Errorf("%s has no reference data for %s", referencePath, id)
	}
	var winds []float64
	for _, p := range ref.Points {
		if !slices.Contains(winds, p.Wind) {
			winds = append(winds, p.Wind)
		}
	}
	slices.Sort(winds)
	polars := sailPolars(b, winds, chartAngles)
	var failed []string
	fmt.Printf("%s against %s\n", id, ref.Original)
	for _, p := range ref.Points {
		got, err := p.model(polars)
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
	if len(failed) > 0 {
		return errors.New("outside the reference's tolerances:\n  " + strings.Join(failed, "\n  "))
	}
	return nil
}
