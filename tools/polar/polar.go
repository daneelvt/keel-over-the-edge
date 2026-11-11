// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The winds of the chart, in knots at each kind's reference height, and its
// angles in degrees.
var (
	chartWinds  = []float64{6, 9, 12, 15, 20}
	chartAngles = angles(30, 180, 5)
)

func angles(from, to, step float64) []float64 {
	var a []float64
	for x := from; x <= to; x += step {
		a = append(a, x)
	}
	return a
}

func runPolar(k *kind, ref *reference, out string) error {
	polars := sailPolars(k, chartWinds, chartAngles)
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(polars, "", " ")
	if err != nil {
		return err
	}
	base := filepath.Join(out, k.id)
	if err := os.WriteFile(base+".json", append(data, '\n'), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(base+".svg", chart(k.name, polars, ref), 0o644); err != nil {
		return err
	}
	fmt.Printf("%s\n", k.name)
	fmt.Print(table(k, polars))
	fmt.Printf("wrote %s.json and %s.svg\n", base, base)
	return nil
}

// sailWords are the sail's words for its sheet, by Out.Sail.
var sailWords = [...]string{
	physics.SailDrawing: "drawing",
	physics.SailLuffing: "luffing",
	physics.SailStalled: "stalled",
	physics.SailAback:   "aback",
}

// table lists every point: speed, VMG, heel, rudder, leeway, boom (a ship's
// yards) and angle of attack, then the best VMGs.
func table(k *kind, polars []polar) string {
	var b strings.Builder
	for _, p := range polars {
		if k.height == 10 {
			fmt.Fprintf(&b, "\n%g knots of wind 10 m up\n", p.Wind)
		} else {
			fmt.Fprintf(&b, "\n%g knots of wind %s (%.1f knots 10 m up)\n", p.Wind, k.heightWords(), k.wind10(p.Wind)/knot)
		}
		if k.square {
			fmt.Fprintln(&b, "  TWA  speed    VMG  heel rudder leeway yards attack sailor  flat brace   AWA  sail")
		} else {
			fmt.Fprintln(&b, "  TWA  speed    VMG  heel rudder leeway  boom attack sailor  flat sheet   AWA  sail")
		}
		for _, pt := range p.Points {
			if !pt.OK {
				fmt.Fprintf(&b, "  %3.0f  %s\n", pt.TWA, pt.cannot())
				continue
			}
			fmt.Fprintf(&b, "  %3.0f %6.2f %6.2f %5.1f %6.1f %6.1f %5.1f %6.1f %6.2f %5.2f %5.2f %5.0f  %s\n",
				pt.TWA, pt.Speed, pt.VMG, pt.Heel, pt.Rudder, pt.Leeway, pt.Boom, pt.Attack, pt.Sailor, pt.Flat, pt.Sheet, pt.Apparent, sailWords[pt.Word])
		}
		up, upA, down, downA := vmg(p)
		fmt.Fprintf(&b, "  best VMG upwind %.2f knots at %g°, downwind %.2f knots at %g°\n", up, upA, down, downA)
	}
	return b.String()
}
