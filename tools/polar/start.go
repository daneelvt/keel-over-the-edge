// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A start from rest, as the game starts a new boat: at rest, its boom on
// the centreline, its helm centred and never touched, the sheet fixed. Its
// weather helm rounds it up toward a close reach. For each angle off the
// wind and each wind, the speed through the water 20 s on by the sheet,
// the best marked: what a boat's start sheet in the catalog is chosen by.

var (
	startAngles = []float64{90, 110, 130}
	startWinds  = []float64{3, 5, 8} // knots, 10 m up
)

// runStart prints the sweep.
func runStart(b *physics.Prepared, name string, table [][]float64) error {
	fmt.Printf("%s from rest, untouched: knots through the water 20 s on, by the sheet; * the best\n", name)
	sheets := make([]float64, 0, 21)
	for s := 0; s <= 20; s++ {
		sheets = append(sheets, float64(s)/20)
	}
	for _, off := range startAngles {
		for _, wind := range startWinds {
			speeds := make([]float64, len(sheets))
			best := 0
			for i, sheet := range sheets {
				speeds[i] = startSpeed(b, wind, off, sheet)
				if speeds[i] > speeds[best] {
					best = i
				}
			}
			fmt.Printf("%3.0f° off %.0f knots:", off, wind)
			for i, v := range speeds {
				mark := " "
				if i == best {
					mark = "*"
				}
				fmt.Printf(" %.2f%s%.2f", sheets[i], mark, v)
			}
			fmt.Println()
		}
	}
	fmt.Printf("the catalog's start sheet: %v\n", table)
	return nil
}

// startSpeed is the boat's speed through the water, knots, 20 s after it
// starts at rest off degrees off wind knots with the sheet fixed.
func startSpeed(b *physics.Prepared, wind, off, sheet float64) float64 {
	bt := &boat{b: b}
	bt.e.WindSpeed = wind * knot
	bt.s.Heading = off * deg
	bt.c.Sheet = sheet
	for range 20 * physics.StepsPerSecond {
		bt.step()
	}
	return math.Sqrt(bt.s.Surge*bt.s.Surge+bt.s.Sway*bt.s.Sway) / knot
}
