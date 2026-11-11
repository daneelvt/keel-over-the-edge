// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A boat with no published polar is checked as raced, against the
// Portsmouth Yardstick: the time it takes round a course of four equal
// legs, a beat, a beam reach, a broad reach and a run, each sailed at its
// best, against another boat's time round the same course, as the ratio of
// their Portsmouth Numbers. The reference may name a crew to sail it with
// in place of the catalog's one sailor, as the yardstick's boats are
// raced: the crew's mass and the reach of its centre of mass to windward
// replace the sailor's, and the boat's displacement takes the difference.
// The catalog is untouched.

// crew is the crew a boat is raced with, in a reference.
type crew struct {
	Mass   float64 `json:"mass"`  // kg
	Reach  float64 `json:"reach"` // the crew's centre of mass furthest to windward, m
	Source string  `json:"source"`
}

// courseLegs are the course's reaches, true wind angles, degrees, between
// its beat and its run.
var courseLegs = []float64{90, 135}

// crewed is the kind sailed by the crew in place of its sailor.
func (k *kind) crewed(c *crew) *kind {
	p := *k.p
	p.Displacement += c.Mass - p.SailorMass
	p.SailorMass = c.Mass
	p.HikeReach = c.Reach
	return k.with(&p, k.name+", raced")
}

// with is the kind with other parameters, prepared for flat water.
func (k *kind) with(p *physics.Params, name string) *kind {
	b := new(physics.Prepared)
	physics.Prepare(p, nil, b)
	c := newKind(k.id, name, b, p, k.height, k.startSheet)
	c.reefWords = k.reefWords
	return c
}

// at10 is the kind with its winds given 10 m up, the game's own height.
func (k *kind) at10() *kind {
	c := *k
	c.height = 10
	return &c
}

// courseTime is the time the kind takes round the course in a wind of
// knots 10 m up, in hours a nautical mile of each leg, and its legs' speeds
// made good: the beat's VMG, the reaches' speeds and the run's VMG.
func courseTime(k *kind, wind float64) (float64, []float64, error) {
	k = k.at10()
	p := sailPolars(k, []float64{wind}, chartAngles)[0]
	up, _, down, _ := vmg(p)
	speeds := []float64{up}
	for _, a := range courseLegs {
		pt := at(p, a)
		if !pt.OK {
			return 0, nil, fmt.Errorf("the course in %g knots: at %g° the %s %s", wind, a, k.name, pt.cannot())
		}
		speeds = append(speeds, pt.Speed)
	}
	speeds = append(speeds, down)
	t := 0.0
	for _, v := range speeds {
		if !(v > 0) {
			return 0, nil, fmt.Errorf("the course in %g knots: the %s makes no way on a leg", wind, k.name)
		}
		t += 1 / v
	}
	return t, speeds, nil
}

// courseRatio is the kind's time round the course over the other's, in a
// wind of knots 10 m up, and both boats' legs in words.
func courseRatio(k, other *kind, wind float64) (float64, string, error) {
	t, mine, err := courseTime(k, wind)
	if err != nil {
		return 0, "", err
	}
	o, theirs, err := courseTime(other, wind)
	if err != nil {
		return 0, "", err
	}
	return t / o, fmt.Sprintf("beat VMG, 90°, 135°, run VMG: %.2f, %.2f, %.2f, %.2f against %.2f, %.2f, %.2f, %.2f",
		mine[0], mine[1], mine[2], mine[3], theirs[0], theirs[1], theirs[2], theirs[3]), nil
}

// reportDownwind prints, without failing, what the sources can show of a
// boat with a downwind sail beyond its references: the boat as sailed, by
// its one sailor, round the course against the other boat; its speeds in
// 8 m/s of wind beside the 470's measured ones (Masuyama and Ogihara 2020,
// under main and jib at 75°, under spinnaker at 115° and 125°); in each
// wind, the angle from which the downwind sail set sails faster than kept
// in, which the crew's angles are tuned to; and the best downwind angle.
func reportDownwind(k, other *kind, winds []float64) {
	fmt.Printf("  reported, not checked (winds 10 m up):\n")
	for _, w := range winds {
		r, legs, err := courseRatio(k, other, w)
		if err != nil {
			fmt.Printf("    %4g knots  the course as sailed: %v\n", w, err)
			continue
		}
		fmt.Printf("    %4g knots  the course as sailed by one sailor: %.3f of the %s's time (%s)\n", w, r, other.name, legs)
	}
	k10 := k.at10()
	masuyama := 8 / knot
	pl := sailPolars(k10, []float64{masuyama}, []float64{75, 115, 125})[0]
	fmt.Printf("    %4.1f knots  75° %.2f (the 470 under main and jib 9.4–10), 115° %.2f and 125° %.2f (under spinnaker 10.8–12)\n",
		masuyama, at(pl, 75).Speed, at(pl, 115).Speed, at(pl, 125).Speed)
	set, in := k.forcedDownwind(true).at10(), k.forcedDownwind(false).at10()
	angles := angles(60, 150, 5)
	for _, w := range []float64{6, 9, 12, 15, 20} {
		ps := sailPolars(set, []float64{w}, angles)[0]
		pi := sailPolars(in, []float64{w}, angles)[0]
		pays := math.NaN()
		for i := len(angles) - 1; i >= 0; i-- {
			s, n := ps.Points[i], pi.Points[i]
			if !s.OK || n.OK && s.Speed <= n.Speed {
				break
			}
			pays = angles[i]
		}
		full := sailPolars(k10, []float64{w}, chartAngles)[0]
		_, _, down, downAngle := vmg(full)
		fmt.Printf("    %4g knots  the downwind sail pays from %g° (crew sets it at %g°, takes it in at %g°); best downwind VMG %.2f at %g°\n",
			w, pays, k.p.SetAngle, k.p.DropAngle, down, downAngle)
	}
}

// forcedDownwind is the kind with its downwind sail always set, or never,
// at full sail: the crew's angles moved out of the way.
func (k *kind) forcedDownwind(set bool) *kind {
	p := *k.p
	if set {
		p.SetAngle, p.DropAngle = 0, -1
	} else {
		p.DownwindReefs = [3]float64{}
	}
	return k.with(&p, k.name)
}
