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
// stability is held to theirs. Then the sailor is put aboard on the
// centreline, standing at the `sailor` node if the boat is steered by a
// wheel, else seated there, and the lever the physics reads (the whole
// boat's, every rightingLeverStep from 0° to 180°) and the whole boat's
// centre of gravity are printed. It runs from the repository root.
package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
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
	// Vanishing is its angle of vanishing stability, degrees, held within
	// Tolerance degrees.
	Vanishing float64 `json:"vanishing"`
	Tolerance float64 `json:"tolerance"`
	Source    string  `json:"source"`
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
	atOne                  float64 // the boat alone's righting moment at 1°, kg·m
	tableAtOne             float64 // as the physics reads it from the whole boat's table, kg·m
	upright                float64 // the boat alone's waterline upright, below the drawn one, m: how high she floats
	forVanishing           float64 // the boat alone's moment at 1° were her centre of gravity set for the reference's vanishing angle, kg·m
}

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
	report(boat, st, m, r, ph.RightingLeverStep)
	if !check {
		return nil
	}
	var problems []string
	if math.Abs(r.upright) > uprightTolerance {
		problems = append(problems, fmt.Sprintf("the boat alone floats %.3f m off her drawn waterline, more than %g m", -r.upright, uprightTolerance))
	}
	if math.Abs(r.vanishing-st.Vanishing) > st.Tolerance {
		problems = append(problems, fmt.Sprintf("the angle of vanishing stability is %.1f°, not within %g° of %g°", r.vanishing, st.Tolerance, st.Vanishing))
	}
	if math.Abs(ph.CentreOfGravity-r.whole) > leverTolerance {
		problems = append(problems, fmt.Sprintf("the catalog's centre of gravity is %g m, the model's %.3f m", ph.CentreOfGravity, r.whole))
	}
	for i, v := range r.wholeLever {
		if i < len(ph.RightingLever) && math.Abs(ph.RightingLever[i]-v) > leverTolerance {
			problems = append(problems, fmt.Sprintf("the catalog's lever at %g° is %g m, the model's %.3f m", float64(i)*ph.RightingLeverStep, ph.RightingLever[i], v))
		}
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
	fmt.Printf("  the boat alone: centre of gravity %.3f m, %.1f kg·m at 1° (%s's %g), vanishing at %.1f° (%g° ±%g)\n",
		r.alone, r.atOne, "the reference", st.MomentAt1, r.vanishing, st.Vanishing, st.Tolerance)
	fmt.Printf("  set for the reference's vanishing angle instead, she would give %.1f kg·m at 1°\n", r.forVanishing)
	fmt.Printf("  the whole boat, her sailor aboard: centre of gravity %.3f m; the table's 1° gives %.1f kg·m\n", r.whole, r.tableAtOne)
	fmt.Println("  heel   alone   whole")
	for i := range r.wholeLever {
		fmt.Printf("  %4.0f° %7.3f %7.3f\n", float64(i)*step, r.aloneLever[i], r.wholeLever[i])
	}
	vals := make([]string, len(r.wholeLever))
	for i, v := range r.wholeLever {
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
	n := int(math.Round(180/step)) + 1
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
	if n > 1 {
		r.tableAtOne = displacement * r.wholeLever[1] / step
	}
	r.vanishing = vanishing(m, aloneVolume, r.alone)
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
