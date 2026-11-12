// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// What tools/polar reports, without failing, of a boat of two hulls or a
// rig that pitches her: the wind in which her windward hull lifts,
// close-hauled and on a beam reach; her best downwind angle in each wind;
// and the wind and angle in which she first pitchpoles with the sheet
// held where it sails her fastest in 16 knots.

// reefWord is the reef's level in the catalog's words.
func (k *kind) reefWord(reef float64) string {
	if i := int(reef); i >= 0 && i < len(k.reefWords) {
		return k.reefWords[i]
	}
	return fmt.Sprintf("reef %g", reef)
}

// liftWinds are the winds, 10 m up, the hull's lifting is looked for in.
var liftWinds = []float64{4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20}

func reportHulls(k *kind) {
	k10 := k.at10()
	fmt.Printf("  reported, not checked (winds 10 m up), as sailed alone:\n")
	if k.p.HullSpacing > 0 {
		flying := k.p.LiftHeel + 2.5
		for _, twa := range []float64{45, 90} {
			polars := sailPolars(k10, liftWinds, []float64{twa})
			found := false
			for _, pl := range polars {
				pt := pl.Points[0]
				if pt.OK && math.Abs(pt.Heel) >= flying {
					fmt.Printf("    the windward hull clear at %g° from %g knots, heeled %.1f°, at %.2f knots\n", twa, pl.Wind, pt.Heel, pt.Speed)
					found = true
					break
				}
			}
			if !found {
				fmt.Printf("    the windward hull never clear at %g° up to %g knots\n", twa, liftWinds[len(liftWinds)-1])
			}
		}
		polars := sailPolars(k10, chartWinds, angles(110, 180, 5))
		for _, pl := range polars {
			_, _, down, downAngle := vmg(pl)
			fmt.Printf("    %4g knots  best downwind VMG %.2f at %g°\n", pl.Wind, down, downAngle)
		}
	}
	if k.p.RigPitch != 0 {
		reportPitchpole(k10)
	}
}

// reportPitchpole sails each angle from a beam reach to a run with the
// sheet that sails it fastest in 16 knots, held, in winds rising from 16
// knots, and prints the first wind and angle she pitchpoles in.
func reportPitchpole(k *kind) {
	twas := angles(90, 165, 15)
	base := sailPolars(k, []float64{16}, twas)[0]
	first := ""
	for wind := 16.0; wind <= 36 && first == ""; wind += 2 {
		for _, pt := range base.Points {
			if !pt.OK {
				continue
			}
			if pitchpoles(k, wind, pt.TWA, pt.Sheet) {
				first = fmt.Sprintf("%g knots at %g°, the sheet held at %.2f", wind, pt.TWA, pt.Sheet)
				break
			}
		}
	}
	if first == "" {
		first = "never, up to 36 knots"
	}
	fmt.Printf("    she first pitchpoles with the 16-knot sheet held: %s\n", first)
}

// pitchpoles reports whether the kind, sailed at twa in a wind of knots
// with its sheet fixed, throws its sailor off over the bow: the sailor in
// the water with the boat heeled less than her fall-out heel.
func pitchpoles(k *kind, knots, twa, sheet float64) bool {
	h := k.helmsmanOf(twa)
	bt := newBoat(k, k.wind10(knots), h.target, sheet, 0)
	for range int((k.settle + k.measure) * physics.StepsPerSecond) {
		bt.c.Helm = h.helm(&bt.s)
		bt.step()
		if bt.s.SailorMode == physics.InWater {
			return math.Abs(bt.s.Heel) < k.p.FallOutHeel*deg
		}
	}
	return false
}
