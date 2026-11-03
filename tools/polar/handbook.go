// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"math"
	"os"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The machine sailors' handbook prints a table of the fastest sheet: the
// boom at a few true wind angles in three strengths, from the polar. -check
// fails when the physics has moved a number, and -handbook prints the table
// to put in the page.
const handbookPath = "internal/agentapi/handbook/trim.md"

var (
	trimWinds  = []float64{6, 12, 20}
	trimAngles = []float64{40, 60, 90, 120, 150, 170, 180}
)

// trimTable is the handbook's table, a line for each angle with the boom
// in each of trimWinds, "- 40°: 4, 4, 10", from polars that include them.
func trimTable(polars []polar) (string, error) {
	var b strings.Builder
	for _, a := range trimAngles {
		fmt.Fprintf(&b, "- %g°:", a)
		for i, w := range trimWinds {
			p, ok := polarAt(polars, w)
			if !ok {
				return "", fmt.Errorf("no polar for %g knots", w)
			}
			pt := at(p, a)
			if !pt.OK {
				return "", fmt.Errorf("the boat capsizes at %g° in %g knots", a, w)
			}
			sep := ","
			if i == 0 {
				sep = ""
			}
			fmt.Fprintf(&b, "%s %d", sep, boomRounded(pt.Boom))
		}
		b.WriteString("\n")
	}
	return b.String(), nil
}

// boomRounded is a boom's angle as the handbook gives it: 4 hauled in
// hard, otherwise to the nearest 5°.
func boomRounded(deg float64) int {
	if deg < 4.5 {
		return 4
	}
	return 5 * int(math.Round(deg/5))
}

func polarAt(polars []polar, wind float64) (polar, bool) {
	for _, p := range polars {
		if p.Wind == wind {
			return p, true
		}
	}
	return polar{}, false
}

// checkHandbook fails unless the handbook's page carries the table the
// polars give.
func checkHandbook(polars []polar) error {
	want, err := trimTable(polars)
	if err != nil {
		return err
	}
	page, err := os.ReadFile(handbookPath)
	if err != nil {
		return err
	}
	if !strings.Contains(string(page), want) {
		return fmt.Errorf("%s's trim table is not the polar's: rewrite it with go run ./tools/polar -handbook, which gives\n%s", handbookPath, want)
	}
	fmt.Printf("  ok   the handbook's trim table\n")
	return nil
}

// checkWords fails unless the sail says drawing at the fastest sheet at
// every angle and strength the boat sails without capsizing.
func checkWords(polars []polar) error {
	var bad []string
	for _, p := range polars {
		for _, pt := range p.Points {
			if pt.OK && pt.Word != physics.SailDrawing {
				bad = append(bad, fmt.Sprintf("%g knots at %g°, boom %.0f°, apparent %.0f°: %s", p.Wind, pt.TWA, pt.Boom, pt.Apparent, sailWords[pt.Word]))
			}
		}
	}
	if len(bad) > 0 {
		return fmt.Errorf("the sail's word at the fastest sheet is not drawing:\n  %s", strings.Join(bad, "\n  "))
	}
	fmt.Printf("  ok   the sail says drawing at the fastest sheet, %g to %g knots\n", polars[0].Wind, polars[len(polars)-1].Wind)
	return nil
}

// runHandbook prints the handbook's trim table.
func runHandbook(b *physics.Prepared) error {
	t, err := trimTable(sailPolars(b, trimWinds, chartAngles))
	if err != nil {
		return err
	}
	fmt.Print(t)
	return nil
}
