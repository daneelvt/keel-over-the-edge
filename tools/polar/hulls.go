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
// held where it sails her fastest in 16 knots. A boat of two hulls whose
// sailor never falls in (a cruising catamaran) is also sailed close-hauled
// at full sail with her sheet hauled in, in a rising wind, for the
// apparent wind in which her windward hull lifts, which her reference may
// hold to a least; her heel close-hauled is printed; and she is told to
// reef by the wind, before any hull lifts (reefWind).

// reefWord is the reef's level in the catalog's words.
func (k *kind) reefWord(reef float64) string {
	if i := int(reef); i >= 0 && i < len(k.reefWords) {
		return k.reefWords[i]
	}
	return fmt.Sprintf("reef %g", reef)
}

// liftWinds are the winds, 10 m up, the hull's lifting is looked for in.
var liftWinds = []float64{4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20}

// cruising reports whether a kind is a boat of two hulls whose sailor never
// falls in: she is knocked down, not capsized, and her heel tells her
// sailor little.
func (k *kind) cruising() bool {
	return k.p.HullSpacing > 0 && k.p.FallOutHeel >= 180
}

// apparent is the apparent wind's speed, knots, over a boat sailing speed
// knots at twa degrees off a true wind of wind knots.
func apparent(wind, speed, twa float64) float64 {
	return math.Sqrt(wind*wind + speed*speed + 2*wind*speed*math.Cos(twa*deg))
}

// The winds, knots at the kind's height, a hull's lifting close-hauled
// hauled in is looked for in: every knot from liftFrom to liftTo.
const (
	liftFrom = 12
	liftTo   = 70
)

// liftWind sails the kind close-hauled, at her catalog's angle, at full sail
// with her sheet hauled in, in winds rising a knot at a time, and returns
// the first in which her windward hull is half clear of the water (her
// liftHeel and half the lift's range) or she is knocked further: the
// apparent wind there and the true, knots at her height; 0, 0 if she never
// lifts it up to liftTo.
func liftWind(k *kind) (apparentWind, trueWind float64) {
	half := k.p.LiftHeel + 2.5
	twa := k.p.CloseHauled
	for w := float64(liftFrom); w <= liftTo; w++ {
		h := k.helmsmanOf(twa)
		bt := newBoat(k, k.wind10(w), h.target, 0, 0)
		settled := k.settleAt(k.wind10(w))
		n := int((settled + k.measure) * physics.StepsPerSecond)
		start := int(settled * physics.StepsPerSecond)
		var heel, speed float64
		for i := range n {
			bt.c.Helm = h.helm(&bt.s)
			bt.step()
			if i >= start {
				heel += math.Abs(bt.s.Heel)
				speed += math.Hypot(bt.s.Surge, bt.s.Sway)
			}
		}
		per := 1 / float64(n-start)
		if bt.capsized || heel*per >= half*deg {
			return apparent(w, speed*per/knot, twa), w
		}
	}
	return 0, 0
}

func reportHulls(k *kind) {
	k10 := k.at10()
	fmt.Printf("  reported, not checked (winds 10 m up), as sailed alone:\n")
	if k.cruising() {
		fmt.Printf("    told to reef close-hauled from %g knots, where the apparent wind reaches %g knots, her builder's plate's\n", reefWind(k), k.plate)
	}
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
