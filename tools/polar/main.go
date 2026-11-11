// SPDX-License-Identifier: AGPL-3.0-only

// Command polar sails each boat of the catalog at every true wind angle and
// strength, with the best sheet, and compares the result with measured data.
//
//	go run ./tools/polar               the polar: .dev/polar/<boat>.json, .svg, and a table
//	go run ./tools/polar -check        fail unless the polar is within the reference data's tolerances,
//	                                   the sail says drawing at its fastest sheet, and the handbook's
//	                                   trim tables and reefing advice are the polar's
//	go run ./tools/polar -handbook     write the handbook's trim tables and reefing advice
//	go run ./tools/polar -sail         the trimmed sails against ORC's mainsail and jib coefficients
//	go run ./tools/polar -manoeuvres   tacks and gybes, and where an accidental gybe comes
//	go run ./tools/polar -start        starts from rest by the sheet, beside the catalog's start sheet
//	go run ./tools/polar -sea 12       the polar in 12 knots and the sea it raises, beside flat water
//
// -boat sails one boat of the catalog, by its id, in any mode but
// -handbook, which writes every boat's.
//
// Each boat's winds are given at its reference data's height
// (internal/physics/testdata/reference.json). It steers with a
// heading-hold of its own and runs each point to steady state. It runs
// from the repository root.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

const referencePath = "internal/physics/testdata/reference.json"

func main() {
	check := flag.Bool("check", false, "compare with "+referencePath+" and fail outside its tolerances")
	sailFlag := flag.Bool("sail", false, "compare the trimmed sails with ORC's mainsail and jib coefficients")
	manoeuvres := flag.Bool("manoeuvres", false, "tack and gybe, and find where an accidental gybe comes")
	sea := flag.Float64("sea", 0, "the polar in this wind, in knots at the boat's reference height, in the sea it raises, beside flat water")
	edge := flag.Bool("edge", false, "the line of no return at the lip, in each regime's spells and in flat water")
	start := flag.Bool("start", false, "starts from rest, untouched, by the sheet: what a boat's start sheet is chosen by")
	handbook := flag.Bool("handbook", false, "write the machine sailors' handbook's trim tables and reefing advice into "+handbookPath)
	out := flag.String("out", ".dev/polar", "folder for the polar's JSON and SVG")
	only := flag.String("boat", "", "sail only the boat of this id, not every boat of the catalog")
	flag.Parse()

	cat, err := catalog.Load()
	if err != nil {
		fail(err)
	}
	refs, err := readReference()
	if err != nil {
		fail(err)
	}
	waves, prepared := cat.Prepare()
	kinds := make([]*kind, len(cat.Boats))
	for i := range cat.Boats {
		boat := &cat.Boats[i]
		params := catalog.PhysicsParams(boat)
		ref := refs.boat(string(boat.ID))
		if ref == nil {
			fail(fmt.Errorf("%s has no reference data for %s", referencePath, boat.ID))
		}
		if !(ref.Height > 0) {
			fail(fmt.Errorf("%s: %s's reference data has no height", referencePath, boat.ID))
		}
		kinds[i] = newKind(string(boat.ID), boat.Name, &prepared[i], &params, ref.Height, boat.StartSheet)
		kinds[i].reefWords = boat.Controls.Reef
		kindsByID[kinds[i].id] = kinds[i]
	}
	if *handbook {
		if err := runHandbook(kinds); err != nil {
			fail(err)
		}
		return
	}
	for i, k := range kinds {
		if *only != "" && k.id != *only {
			continue
		}
		switch {
		case *edge:
			err = runEdge(k.b, waves, cat)
		case *start:
			err = runStart(k)
		case *sea != 0:
			err = runSea(k, waves, *sea)
		case *check:
			err = runCheck(k, refs.boat(k.id))
		case *sailFlag:
			err = runSail(k)
		case *manoeuvres:
			err = runManoeuvres(k)
		default:
			err = runPolar(k, refs.boat(k.id), *out)
		}
		if err != nil {
			fail(fmt.Errorf("%s: %w", cat.Boats[i].Name, err))
		}
	}
}

// kindsByID are the catalog's boats as the tool sails them, by id: a
// reference's course is sailed against another boat's.
var kindsByID = map[string]*kind{}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "polar:", err)
	os.Exit(1)
}
