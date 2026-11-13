// SPDX-License-Identifier: AGPL-3.0-only

// Command lever heels a boat's model in still water and gives its righting
// lever, from the sections and appendages its model carries (the hull
// node's `lever` data: art/boats/<id>/build.ts writes them).
//
//	go run ./tools/lever -boat yacht          the lever, and the values for the catalog
//	go run ./tools/lever -boat yacht -check   fail unless the catalog's centre of gravity and lever are the model's
//
// The boat alone (the catalog's displacement less its sailor) is floated at
// each heel, sinking until it displaces its weight, at the trim it floats
// at upright. Its centre of gravity is set so that it gives the righting
// moment at 1° its reference data name (internal/physics/testdata/
// reference.json, the boat's `stability`), and its angle of vanishing
// stability is held to theirs; or, where no moment is published, the
// reference gives the centre of gravity itself, an estimate. Then the
// sailor is put aboard on the centreline, at the height of the `sailor`
// node (standing there if the boat is steered by a wheel, else seated), and
// the lever the physics reads (the whole boat's, its 19 values every
// rightingLeverStep from 0°) and the whole boat's centre of gravity are
// printed.
//
// A boat of two hulls (the catalog's hullSpacing) has her sections drawn
// round both: each section's starboard half runs from the centreline along
// the bridgedeck's underside, round the hull and back over its deck. The
// tool also gives the heel at which her windward hull leaves the water,
// held to the catalog's liftHeel; the heel of her greatest lever, held
// within the reference's `peak`; and the wind at which ISO 12217-2's Annex
// G has her reef, held to at least the reference's `reefWind`. Where the
// reference gives a `hold`, the lever falls past its greatest only to that
// share of it, and is held there: she never turns over. It runs from the
// repository root.
package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

const (
	referencePath = "internal/physics/testdata/reference.json"
	// waterDensity is the physics package's sea water, kg/m³.
	waterDensity = 1025.0
	// The sailor's centre of gravity above the `sailor` node: standing at a
	// wheel, or seated.
	standingHeight = 0.95
	seatedHeight   = 0.25
	// leverTolerance is how far the catalog's lever may be from the model's,
	// m: its two decimals.
	leverTolerance = 0.0051
	// uprightTolerance is how far the boat alone may float off her drawn
	// waterline, m: her model must displace her weight.
	uprightTolerance = 0.01
	// liftTolerance is how far the catalog's heel at which a windward hull
	// leaves the water may be from the model's, degrees.
	liftTolerance = 0.5
	// liftRange is how far a windward hull heels from leaving the water to
	// being clear of it in the physics, degrees.
	liftRange = 5.0
)

func main() {
	id := flag.String("boat", "", "the boat's catalog id")
	check := flag.Bool("check", false, "fail unless the catalog's centre of gravity and lever are the model's")
	flag.Parse()
	if err := run(*id, *check); err != nil {
		fmt.Fprintln(os.Stderr, "lever:", err)
		os.Exit(1)
	}
}

// stability is a boat's published stability, from its reference data.
type stability struct {
	// MomentAt1 is the boat alone's righting moment at 1° of heel, kg·m.
	MomentAt1 float64 `json:"momentAt1"`
	// CentreOfGravity is the boat alone's, m above the waterline: an
	// estimate, given where no moment is published, in its place.
	CentreOfGravity *float64 `json:"centreOfGravity"`
	// Vanishing is its angle of vanishing stability, degrees, held within
	// Tolerance degrees; 0 where none is published.
	Vanishing float64 `json:"vanishing"`
	Tolerance float64 `json:"tolerance"`
	// Hold is the share of its greatest lever the lever falls to past it,
	// and is held at beyond: 0 for the lever as it comes.
	Hold float64 `json:"hold"`
	// Peak is where the heel of the greatest lever must lie, degrees.
	Peak []float64 `json:"peak"`
	// ReefWind is the least apparent wind, knots, at which ISO 12217-2's
	// Annex G may have her reef: her builder's plate's.
	ReefWind float64 `json:"reefWind"`
	Source   string  `json:"source"`
}

func readStability(id string) (*stability, error) {
	data, err := os.ReadFile(referencePath)
	if err != nil {
		return nil, err
	}
	var r struct {
		Boats []struct {
			Boat      string     `json:"boat"`
			Stability *stability `json:"stability"`
		} `json:"boats"`
	}
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, fmt.Errorf("%s: %w", referencePath, err)
	}
	for _, b := range r.Boats {
		if b.Boat == id && b.Stability != nil {
			return b.Stability, nil
		}
	}
	return nil, fmt.Errorf("%s gives no stability for %s", referencePath, id)
}

// result is what run finds.
type result struct {
	alone, whole           float64 // the boat alone's and the whole boat's centre of gravity, m above the waterline
	vanishing              float64 // the boat alone's angle of vanishing stability, degrees
	aloneLever, wholeLever []float64
	held                   []float64 // the whole boat's, held past its fall at the reference's share of its greatest
	atOne                  float64   // the boat alone's righting moment at 1°, kg·m
	tableAtOne             float64   // as the physics reads it from the whole boat's table, kg·m
	upright                float64   // the boat alone's waterline upright, below the drawn one, m: how high she floats
	forVanishing           float64   // the boat alone's moment at 1° were her centre of gravity set for the reference's vanishing angle, kg·m
	peak, greatest         float64   // the whole boat's heel of her greatest lever, degrees, and that lever, m
	clear, lift            float64   // a boat of two hulls: the heel at which her windward hull is clear of the water, the whole boat, and at which the physics has it leave it, degrees
	annexG                 *annexG
}

// leverValues is how many values the physics' righting lever holds.
const leverValues = len(physics.Params{}.RightingLever)

func run(id string, check bool) error {
	if id == "" {
		return errors.New("name a boat: -boat <id>")
	}
	cat, err := catalog.Load()
	if err != nil {
		return err
	}
	var boat *catalog.Boat
	for i := range cat.Boats {
		if string(cat.Boats[i].ID) == id {
			boat = &cat.Boats[i]
		}
	}
	if boat == nil {
		return fmt.Errorf("no boat %q in the catalog", id)
	}
	st, err := readStability(id)
	if err != nil {
		return err
	}
	glb, err := os.ReadFile("art/" + string(boat.Art.Model))
	if err != nil {
		return err
	}
	m, err := readModel(glb)
	if err != nil {
		return fmt.Errorf("art/%s: %w", boat.Art.Model, err)
	}
	ph := catalog.PhysicsParams(boat)
	r := solve(m, ph.Displacement, ph.SailorMass, ph.RightingLeverStep, st)
	if ph.HullSpacing > 0 {
		r.clear = clearHeel(m, ph.Displacement/waterDensity)
		r.lift = r.clear - liftRange
	}
	if st.ReefWind > 0 {
		r.annexG = annexGOf(m, &ph, r.alone)
	}
	report(boat, st, m, r, ph.RightingLeverStep)
	if !check {
		return nil
	}
	var problems []string
	if math.Abs(r.upright) > uprightTolerance {
		problems = append(problems, fmt.Sprintf("the boat alone floats %.3f m off her drawn waterline, more than %g m", -r.upright, uprightTolerance))
	}
	if st.Vanishing > 0 && math.Abs(r.vanishing-st.Vanishing) > st.Tolerance {
		problems = append(problems, fmt.Sprintf("the angle of vanishing stability is %.1f°, not within %g° of %g°", r.vanishing, st.Tolerance, st.Vanishing))
	}
	if math.Abs(ph.CentreOfGravity-r.whole) > leverTolerance {
		problems = append(problems, fmt.Sprintf("the catalog's centre of gravity is %g m, the model's %.3f m", ph.CentreOfGravity, r.whole))
	}
	for i, v := range r.held {
		if math.Abs(ph.RightingLever[i]-v) > leverTolerance {
			problems = append(problems, fmt.Sprintf("the catalog's lever at %g° is %g m, the model's %.3f m", float64(i)*ph.RightingLeverStep, ph.RightingLever[i], v))
		}
	}
	if len(st.Peak) == 2 && (r.peak < st.Peak[0] || r.peak > st.Peak[1]) {
		problems = append(problems, fmt.Sprintf("her greatest lever is at %.1f°, not from %g° to %g°", r.peak, st.Peak[0], st.Peak[1]))
	}
	if ph.HullSpacing > 0 && math.Abs(ph.LiftHeel-r.lift) > liftTolerance {
		problems = append(problems, fmt.Sprintf("the catalog's windward hull leaves the water at %g°, the model's at %.1f°", ph.LiftHeel, r.lift))
	}
	if r.annexG != nil && r.annexG.wind < st.ReefWind {
		problems = append(problems, fmt.Sprintf("Annex G has her reef in %.1f knots of apparent wind, under her plate's %g", r.annexG.wind, st.ReefWind))
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "\n  "))
	}
	return nil
}

func report(boat *catalog.Boat, st *stability, m *model, r result, step float64) {
	fmt.Printf("%s: %d sections every %g m, %d appendage volumes; the boat alone %.0f kg\n",
		boat.Name, len(m.sections), m.step, len(m.elements), boat.Physics.Hull.Displacement-boat.Physics.Sailor.SailorMass)
	fmt.Printf("  upright her waterline is %.3f m above the drawn one\n", -r.upright)
	if st.CentreOfGravity != nil {
		fmt.Printf("  the boat alone: centre of gravity %.3f m (the reference's estimate), %.1f kg·m at 1°, vanishing at %.1f°\n",
			r.alone, r.atOne, r.vanishing)
	} else {
		fmt.Printf("  the boat alone: centre of gravity %.3f m, %.1f kg·m at 1° (%s's %g), vanishing at %.1f° (%g° ±%g)\n",
			r.alone, r.atOne, "the reference", st.MomentAt1, r.vanishing, st.Vanishing, st.Tolerance)
		fmt.Printf("  set for the reference's vanishing angle instead, she would give %.1f kg·m at 1°\n", r.forVanishing)
	}
	fmt.Printf("  the whole boat, her sailor aboard: centre of gravity %.3f m; the table's first step gives %.1f kg·m a degree\n", r.whole, r.tableAtOne)
	fmt.Printf("  her greatest lever %.3f m at %.1f°, %.1f t·m\n", r.greatest, r.peak, r.greatest*boat.Physics.Hull.Displacement/1000)
	if r.clear > 0 {
		fmt.Printf("  her windward hull clear of the water at %.1f°: the catalog's liftHeel %.1f°, %g° before\n", r.clear, r.lift, liftRange)
	}
	if g := r.annexG; g != nil {
		fmt.Printf("  ISO 12217-2 Annex G: BCB %.3f m, BWL %.3f m, LWL %g m, VCG %.3f m above the canoe bodies' bottom, the boat alone %.0f kg:\n",
			g.bcb, g.bwl, g.lwl, g.vcg, g.mass)
		fmt.Printf("    the greatest lever at %.1f° (G.4), LMT %.1f kN·m (G.3)\n", g.phi, g.lmt/1000)
		fmt.Printf("    above the underwater profile's centre (%.3f m): the hull and rig %.1f m² at %.2f m, the main %g m² at %.2f m, the headsails %g m² at %.2f m\n",
			g.centre, g.hullArea, g.hullHeight, g.mainArea, g.mainHeight, g.jibArea, g.jibHeight)
		fmt.Printf("    reef at %.1f knots of apparent wind (G.2), her plate %g knots\n", g.wind, st.ReefWind)
	}
	fmt.Println("  heel   alone   whole    held")
	for i := range r.wholeLever {
		fmt.Printf("  %4.0f° %7.3f %7.3f %7.3f\n", float64(i)*step, r.aloneLever[i], r.wholeLever[i], r.held[i])
	}
	vals := make([]string, len(r.held))
	for i, v := range r.held {
		vals[i] = fmt.Sprintf("%.2f", v+0) // +0: no "-0.00"
		if math.Abs(v) < 0.005 {
			vals[i] = "0"
		}
	}
	fmt.Printf("  catalog: centreOfGravity: %.2f\n  rightingLever: [%s]\n", r.whole, strings.Join(vals, ", "))
}

// solve finds the boat alone's centre of gravity from its moment at 1°, and
// both levers.
func solve(m *model, displacement, sailorMass, step float64, st *stability) result {
	alone := displacement - sailorMass
	aloneVolume := alone / waterDensity
	var r result
	r.upright = -m.waterline(0, aloneVolume)
	// GZ(1°) = X_B − z_G sin 1°: the centre of gravity that gives the moment.
	one := 1 * math.Pi / 180
	xb := m.buoyancy(one, aloneVolume)
	r.alone = (xb - st.MomentAt1/alone) / math.Sin(one)
	if st.CentreOfGravity != nil {
		r.alone = *st.CentreOfGravity
	}
	n := leverValues
	r.aloneLever = make([]float64, n)
	r.wholeLever = make([]float64, n)
	sailorY := m.sailorY + seatedHeight
	if m.wheel {
		sailorY = m.sailorY + standingHeight
	}
	r.whole = (alone*r.alone + sailorMass*sailorY) / displacement
	wholeVolume := displacement / waterDensity
	for i := range n {
		phi := float64(i) * step * math.Pi / 180
		r.aloneLever[i] = m.buoyancy(phi, aloneVolume) - r.alone*math.Sin(phi)
		r.wholeLever[i] = m.buoyancy(phi, wholeVolume) - r.whole*math.Sin(phi)
	}
	r.atOne = alone * (m.buoyancy(one, aloneVolume) - r.alone*math.Sin(one))
	r.tableAtOne = displacement * r.wholeLever[1] / step
	r.vanishing = vanishing(m, aloneVolume, r.alone)
	// The greatest lever, to a tenth of a degree, and the lever held past
	// its fall at the reference's share of it.
	for deg := 0.1; deg <= 90; deg += 0.1 {
		phi := deg * math.Pi / 180
		if gz := m.buoyancy(phi, wholeVolume) - r.whole*math.Sin(phi); gz > r.greatest {
			r.greatest, r.peak = gz, deg
		}
	}
	r.held = hold(r.wholeLever, st.Hold)
	// The other way about: the centre of gravity that gives the reference's
	// vanishing angle, and the moment at 1° it would give.
	lo, hi := r.alone-1, r.alone+1
	for range 40 {
		mid := (lo + hi) / 2
		if vanishing(m, aloneVolume, mid) > st.Vanishing {
			lo = mid
		} else {
			hi = mid
		}
	}
	r.forVanishing = alone * (xb - (lo+hi)/2*math.Sin(one))
	return r
}

// hold returns the lever falling past its greatest only to share of it, and
// held there from where it first falls so far: the lever as it is where
// share is 0.
func hold(lever []float64, share float64) []float64 {
	out := append([]float64(nil), lever...)
	if share <= 0 {
		return out
	}
	top := 0
	for i, v := range out {
		if v > out[top] {
			top = i
		}
	}
	floor := share * out[top]
	held := false
	for i := top + 1; i < len(out); i++ {
		if held || out[i] < floor {
			out[i], held = floor, true
		}
	}
	return out
}

// clearHeel is the heel, degrees to a tenth, at which a boat of two hulls
// displacing volume lifts her windward hull clear of the water: where none
// of the port side's volume is under it, heeled to starboard. The physics
// has the hull leave the water liftRange before (its liftHeel).
func clearHeel(m *model, volume float64) float64 {
	for deg := 0.1; deg < 60; deg += 0.1 {
		phi := deg * math.Pi / 180
		if v := m.immersedPort(phi, m.waterline(phi, volume)); v < 1e-4*volume {
			return math.Round(deg*10) / 10
		}
	}
	return 60
}

// vanishing is the heel past the greatest lever at which the lever comes to
// nothing, degrees, to a tenth: 180 if it never does.
func vanishing(m *model, volume, zg float64) float64 {
	lever := func(deg float64) float64 {
		phi := deg * math.Pi / 180
		return m.buoyancy(phi, volume) - zg*math.Sin(phi)
	}
	for deg := 30.0; deg < 180; deg++ {
		if lever(deg) > 0 {
			continue
		}
		lo, hi := deg-1, deg
		for range 12 {
			mid := (lo + hi) / 2
			if lever(mid) > 0 {
				lo = mid
			} else {
				hi = mid
			}
		}
		return math.Round(hi*10) / 10
	}
	return 180
}

// model is what the lever is made from: the hull's sections, each the
// starboard half from the keel round to the top on the centreline, and its
// appendages as small volumes; and where the sailor is.
type model struct {
	step     float64
	sections []section
	elements [][4]float64 // x, y, z, volume
	sailorY  float64
	wheel    bool
}

type section struct {
	z    float64
	poly [][2]float64 // the whole section, counter-clockwise
}

// readModel reads the sections from a glTF binary's hull node.
func readModel(glb []byte) (*model, error) {
	if len(glb) < 20 || binary.LittleEndian.Uint32(glb[0:4]) != 0x46546c67 {
		return nil, errors.New("not a glTF binary")
	}
	n := binary.LittleEndian.Uint32(glb[12:16])
	var g struct {
		Nodes []struct {
			Name        string          `json:"name"`
			Translation []float64       `json:"translation"`
			Extras      json.RawMessage `json:"extras"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(glb[20:20+n], &g); err != nil {
		return nil, err
	}
	m := &model{}
	found := false
	for _, node := range g.Nodes {
		switch node.Name {
		case "sailor":
			if len(node.Translation) == 3 {
				m.sailorY = node.Translation[1]
			}
		case "wheel":
			m.wheel = true
		case "hull":
			var e struct {
				Lever *struct {
					Step     float64              `json:"step"`
					Sections [][2]json.RawMessage `json:"sections"`
					Elements [][4]float64         `json:"elements"`
				} `json:"lever"`
			}
			if err := json.Unmarshal(node.Extras, &e); err != nil || e.Lever == nil {
				return nil, errors.New("its hull has no lever data")
			}
			m.step = e.Lever.Step
			m.elements = e.Lever.Elements
			for _, s := range e.Lever.Sections {
				var z float64
				var half []float64
				if err := json.Unmarshal(s[0], &z); err != nil {
					return nil, err
				}
				if err := json.Unmarshal(s[1], &half); err != nil {
					return nil, err
				}
				m.sections = append(m.sections, section{z: z, poly: whole(half)})
			}
			found = true
		}
	}
	if !found {
		return nil, errors.New("no hull node")
	}
	return m, nil
}

// whole makes a section's closed outline from its starboard half, which
// runs from the keel on the centreline round to the top on it: the half,
// then its mirror back down.
func whole(half []float64) [][2]float64 {
	var p [][2]float64
	for i := 0; i+1 < len(half); i += 2 {
		p = append(p, [2]float64{half[i], half[i+1]})
	}
	for i := len(p) - 2; i > 0; i-- {
		p = append(p, [2]float64{-p[i][0], p[i][1]})
	}
	return p
}

// immersed returns the volume below the water at heel phi (radians, to
// starboard) and height h (in the heeled frame), and the across-moment of
// that volume in the heeled frame.
func (m *model) immersed(phi, h float64) (volume, moment float64) {
	sin, cos := math.Sincos(phi)
	rot := func(x, y float64) (float64, float64) { return x*cos + y*sin, -x*sin + y*cos }
	var pts [][2]float64
	for _, s := range m.sections {
		pts = pts[:0]
		for _, p := range s.poly {
			x, y := rot(p[0], p[1])
			pts = append(pts, [2]float64{x, y})
		}
		a, cx := clippedArea(pts, h)
		volume += a * m.step
		moment += a * m.step * cx
	}
	for _, e := range m.elements {
		x, y := rot(e[0], e[1])
		if y < h {
			volume += e[3]
			moment += e[3] * x
		}
	}
	return volume, moment
}

// waterline is the height, in the frame heeled by phi, at which the model
// displaces volume.
func (m *model) waterline(phi, volume float64) float64 {
	lo, hi := -10.0, 10.0
	for range 80 {
		mid := (lo + hi) / 2
		if v, _ := m.immersed(phi, mid); v < volume {
			lo = mid
		} else {
			hi = mid
		}
	}
	return (lo + hi) / 2
}

// buoyancy is the centre of buoyancy's place across the heeled frame,
// floating at heel phi with volume immersed: positive, to starboard.
func (m *model) buoyancy(phi, volume float64) float64 {
	v, mo := m.immersed(phi, m.waterline(phi, volume))
	return mo / v
}

// clippedArea is the area of a counter-clockwise polygon below y = h, and
// its centroid's x.
func clippedArea(poly [][2]float64, h float64) (area, cx float64) {
	var clip [][2]float64
	for i := range poly {
		a := poly[i]
		b := poly[(i+1)%len(poly)]
		ain, bin := a[1] < h, b[1] < h
		if ain {
			clip = append(clip, a)
		}
		if ain != bin {
			f := (h - a[1]) / (b[1] - a[1])
			clip = append(clip, [2]float64{a[0] + f*(b[0]-a[0]), h})
		}
	}
	var sx float64
	for i := range clip {
		a := clip[i]
		b := clip[(i+1)%len(clip)]
		c := a[0]*b[1] - b[0]*a[1]
		area += c
		sx += (a[0] + b[0]) * c
	}
	if math.Abs(area) < 1e-12 {
		return 0, 0
	}
	return area / 2, sx / (3 * area)
}

// immersedPort is the volume of the model's port side (x < 0 upright)
// below the water at heel phi and height h: a boat of two hulls' windward
// hull, heeled to starboard.
func (m *model) immersedPort(phi, h float64) float64 {
	sin, cos := math.Sincos(phi)
	rot := func(x, y float64) (float64, float64) { return x*cos + y*sin, -x*sin + y*cos }
	var volume float64
	var pts [][2]float64
	for _, s := range m.sections {
		pts = pts[:0]
		for _, p := range clipX(s.poly) {
			x, y := rot(p[0], p[1])
			pts = append(pts, [2]float64{x, y})
		}
		a, _ := clippedArea(pts, h)
		volume += a * m.step
	}
	for _, e := range m.elements {
		if _, y := rot(e[0], e[1]); e[0] < 0 && y < h {
			volume += e[3]
		}
	}
	return volume
}

// clipX is the part of a counter-clockwise polygon with x < 0.
func clipX(poly [][2]float64) [][2]float64 {
	var out [][2]float64
	for i := range poly {
		a := poly[i]
		b := poly[(i+1)%len(poly)]
		ain, bin := a[0] < 0, b[0] < 0
		if ain {
			out = append(out, a)
		}
		if ain != bin {
			f := (0 - a[0]) / (b[0] - a[0])
			out = append(out, [2]float64{0, a[1] + f*(b[1]-a[1])})
		}
	}
	return out
}

// annexG is ISO 12217-2:2013's Annex G for a catamaran: the wind at which
// her standard sails must be reefed, from her greatest righting moment and
// her sails' and hull's heeling arms.
type annexG struct {
	mass, bcb, bwl, lwl, vcg float64 // the boat alone, kg; the hulls' centres of buoyancy apart, both waterline beams, the waterline, m; the centre of gravity above the canoe bodies' bottom, m
	phi, lmt                 float64 // G.4's heel of the greatest lever, degrees; G.3's greatest righting moment, N·m
	centre                   float64 // the underwater profile's centre's height, m
	hullArea, hullHeight     float64 // the hull's and rig's profile above the water, m², and its centre's height above the centre, m
	mainArea, mainHeight     float64
	jibArea, jibHeight       float64
	wind                     float64 // G.2, knots of apparent wind
}

// The main's centre's height above its foot and a headsail's above its tack,
// shares of their luffs: a fully battened main's two fifths, a triangle's
// third.
const (
	mainCentre = 0.4
	jibCentre  = 1.0 / 3
	// mastBreadth is the mast's breadth, m, in the rig's profile.
	mastBreadth = 0.22
)

// annexGOf works Annex G (G.2 to G.4) from the model upright and the
// catalog: BCB is twice the starboard side's centre of buoyancy out; BWL
// both hulls' greatest breadth at the waterline; VCG the boat alone's
// centre of gravity above the canoe bodies' bottom; the underwater
// profile's centre and the hull's profile above the water from the
// sections' heights, the mast from the roof to its head, and the sails at
// their centres.
func annexGOf(m *model, ph *physics.Params, zg float64) *annexG {
	g := &annexG{mass: ph.Displacement - ph.SailorMass, lwl: ph.WaterlineLength}
	volume := g.mass / waterDensity
	h := m.waterline(0, volume)
	var starboard, starboardMoment, profileBelow, momentBelow, profileAbove, momentAbove, top float64
	for _, s := range m.sections {
		lo, hi := math.Inf(1), math.Inf(-1)
		for _, p := range s.poly {
			lo, hi = min(lo, p[1]), max(hi, p[1])
		}
		// The waterline's breadth of one hull: its greatest across at h.
		g.bwl = max(g.bwl, 2*breadthAtWater(s.poly, h))
		a, cx := clippedArea(clipXPositive(s.poly), h)
		starboard += a * m.step
		starboardMoment += a * m.step * cx
		if lo < h {
			profileBelow += (h - lo) * m.step
			momentBelow += (h - lo) * m.step * (lo + h) / 2
		}
		if hi > h {
			profileAbove += (hi - h) * m.step
			momentAbove += (hi - h) * m.step * (hi + h) / 2
		}
		top = max(top, hi)
	}
	g.bcb = 2 * starboardMoment / starboard
	g.vcg = zg + ph.HullDraught
	g.centre = momentBelow / profileBelow
	mastFoot := top
	mastHead := ph.BoomHeight + ph.Luff
	mast := mastBreadth * (mastHead - mastFoot)
	g.hullArea = profileAbove + mast
	g.hullHeight = (momentAbove+mast*(mastFoot+mastHead)/2)/g.hullArea - g.centre
	g.mainArea, g.mainHeight = ph.SailArea, ph.BoomHeight+mainCentre*ph.Luff-g.centre
	g.jibArea, g.jibHeight = ph.HeadsailArea, ph.HeadsailTackHeight+jibCentre*ph.HeadsailLuff-g.centre
	phi := math.Atan(g.mass / (254 * g.lwl * g.bwl * g.bcb))
	g.phi = phi * 180 / math.Pi
	g.lmt = 9.4 * g.mass * (0.5*g.bcb*math.Cos(phi) - g.vcg*math.Sin(phi))
	arms := 0.8*g.hullArea*g.hullHeight + g.mainArea*g.mainHeight + g.jibArea*g.jibHeight
	g.wind = 1.85 * math.Sqrt(g.lmt/arms)
	return g
}

// clipXPositive is the part of a counter-clockwise polygon with x > 0.
func clipXPositive(poly [][2]float64) [][2]float64 {
	flipped := make([][2]float64, len(poly))
	for i, p := range poly {
		flipped[len(poly)-1-i] = [2]float64{-p[0], p[1]}
	}
	out := clipX(flipped)
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	for i := range out {
		out[i][0] = -out[i][0]
	}
	return out
}

// breadthAtWater is a section's greatest breadth of one piece at height h:
// the longest run inside the polygon along y = h on its starboard side.
func breadthAtWater(poly [][2]float64, h float64) float64 {
	var xs []float64
	for i := range poly {
		a := poly[i]
		b := poly[(i+1)%len(poly)]
		if (a[1] < h) != (b[1] < h) {
			f := (h - a[1]) / (b[1] - a[1])
			if x := a[0] + f*(b[0]-a[0]); x > 0 {
				xs = append(xs, x)
			}
		}
	}
	sort.Float64s(xs)
	var most float64
	for i := 0; i+1 < len(xs); i += 2 {
		most = max(most, xs[i+1]-xs[i])
	}
	return most
}
