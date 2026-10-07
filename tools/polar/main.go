// SPDX-License-Identifier: AGPL-3.0-only

// Command polar sails each boat of the catalog at every true wind angle and
// strength, with the best sheet, and compares the result with measured data.
//
//	go run ./tools/polar               the polar: .dev/polar/<boat>.json, .svg, and a table
//	go run ./tools/polar -check        fail unless the polar is within the reference data's tolerances
//	go run ./tools/polar -sail         the trimmed sail against ORC's mainsail coefficients
//	go run ./tools/polar -manoeuvres   tacks and gybes, and where an accidental gybe comes
//
// It steers with a heading-hold of its own and runs each point to steady
// state. It runs from the repository root.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

const referencePath = "internal/physics/testdata/reference.json"

func main() {
	check := flag.Bool("check", false, "compare with "+referencePath+" and fail outside its tolerances")
	sailFlag := flag.Bool("sail", false, "compare the trimmed sail with ORC's mainsail coefficients")
	manoeuvres := flag.Bool("manoeuvres", false, "tack and gybe, and find where an accidental gybe comes")
	out := flag.String("out", ".dev/polar", "folder for the polar's JSON and SVG")
	flag.Parse()

	cat, err := catalog.Load()
	if err != nil {
		fail(err)
	}
	for i := range cat.Boats {
		boat := &cat.Boats[i]
		params := catalog.PhysicsParams(boat)
		var b physics.Prepared
		physics.Prepare(&params, &b)
		switch {
		case *check:
			err = runCheck(&b, string(boat.ID))
		case *sailFlag:
			err = runSail(&b, &params)
		case *manoeuvres:
			err = runManoeuvres(&b)
		default:
			err = runPolar(&b, string(boat.ID), boat.Name, *out)
		}
		if err != nil {
			fail(fmt.Errorf("%s: %w", boat.Name, err))
		}
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "polar:", err)
	os.Exit(1)
}
