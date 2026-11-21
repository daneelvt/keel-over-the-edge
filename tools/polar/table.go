// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"fmt"
	"math"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"go.yaml.in/yaml/v3"
)

// The catalog's polar tables: every boat's steady speed in the game's wind,
// 10 m up, at every whole knot from 3 to 25 and every 5° off the wind from
// 30° to 180°, at its best sheet and its best reef; and its best angles up
// and down the wind. What a race needs of a boat's speed is read from them
// on the server, the same on every machine, and their place in the catalog
// makes a change of a boat's physics that moves her polar a change of the
// catalog's version. -table writes them; the tests sail a few points again
// and hold the table to them.
const tablePath = "shared/catalog/polars.yaml"

// The table's winds, knots 10 m up, and its angles, degrees off the true
// wind.
var (
	tableWinds  = angles(3, 25, 1)
	tableAngles = angles(30, 180, 5)
)

// tableReefFrom is the least wind, knots 10 m up, in which a point is
// sailed reefed as well as at full sail, the fastest of them kept: below
// it no boat goes faster reefed.
const tableReefFrom = 12

// tableKind is k as the table sails it: in the game's wind, 10 m up.
func tableKind(k *kind) *kind {
	t := *k
	t.height = 10
	return &t
}

// tablePoint is a kind's fastest point at a wind and an angle: its best
// sheet at full sail, or reefed in a breeze if that is faster.
func tablePoint(k *kind, wind, twa float64) point {
	top := best(k, wind, twa, 0)
	if wind < tableReefFrom {
		return top
	}
	for reef := 1.0; reef <= 2; reef++ {
		if p := best(k, wind, twa, reef); p.OK && (!top.OK || p.Speed > top.Speed) {
			top = p
		}
	}
	return top
}

// tablePolars are a kind's polars for the table, in parallel.
func tablePolars(k *kind, winds, angles []float64) []polar {
	t := tableKind(k)
	out := make([]polar, len(winds))
	for i, w := range winds {
		out[i] = polar{Wind: w, Points: make([]point, len(angles)), Track: k.square}
	}
	parallel(len(winds)*len(angles), func(n int) {
		i, j := n/len(angles), n%len(angles)
		out[i].Points[j] = tablePoint(t, winds[i], angles[j])
	})
	return out
}

// tableBoat is one boat's table as the catalog holds it.
type tableBoat struct {
	Boat  string      `yaml:"boat"`
	Speed [][]float64 `yaml:"speed"`
	Up    [][]float64 `yaml:"up"`
	Down  [][]float64 `yaml:"down"`
}

// tableFile is the catalog's file of polars.
type tableFile struct {
	Polars struct {
		Winds  []float64   `yaml:"winds"`
		Angles []float64   `yaml:"angles"`
		Boats  []tableBoat `yaml:"boats"`
	} `yaml:"polars"`
}

// hundredths is a speed as the table keeps it: knots to a hundredth.
func hundredths(v float64) float64 { return math.Round(v*100) / 100 }

// boatTable is a kind's table from its polars: each wind's speeds by
// angle, 0 where she cannot sail, and its best angle and VMG up and down.
func boatTable(id string, polars []polar) tableBoat {
	tb := tableBoat{Boat: id}
	for _, p := range polars {
		row := make([]float64, len(p.Points))
		for j, pt := range p.Points {
			if pt.OK {
				row[j] = hundredths(pt.Speed)
			}
		}
		tb.Speed = append(tb.Speed, row)
		up, upA, down, downA := vmg(p)
		tb.Up = append(tb.Up, []float64{upA, hundredths(up)})
		tb.Down = append(tb.Down, []float64{downA, hundredths(down)})
	}
	return tb
}

// runTable sails every boat for the table and writes it.
func runTable(kinds []*kind) error {
	var f tableFile
	f.Polars.Winds, f.Polars.Angles = tableWinds, tableAngles
	for _, k := range kinds {
		fmt.Printf("polar: sailing %s for the table\n", k.name)
		f.Polars.Boats = append(f.Polars.Boats, boatTable(k.id, tablePolars(k, tableWinds, tableAngles)))
	}
	data, err := writeTable(&f)
	if err != nil {
		return err
	}
	if err := os.WriteFile(tablePath, data, 0o644); err != nil {
		return err
	}
	fmt.Println("polar: wrote", tablePath, "; run go run ./tools/catalog")
	return nil
}

// tableHeader is what the file says of itself.
const tableHeader = `# SPDX-License-Identifier: AGPL-3.0-only
# The boats' polars, written by go run ./tools/polar -table: never edit by
# hand. Each boat sailed to a steady speed in flat water at its best sheet
# and reef (a breeze's points reefed too, the fastest kept), in the true
# wind of winds, knots 10 m up, at angles, degrees off the true wind. speed
# is her speed through the water, knots, a row for each wind, a column for
# each angle, 0 where she cannot sail; up and down her best angle off the
# wind and the speed she makes good toward or away from it there, for
# each wind (a ship's over the ground, her leeway counted).
`

// writeTable is the file's text: a row of numbers to a line.
func writeTable(f *tableFile) ([]byte, error) {
	var b strings.Builder
	b.WriteString(tableHeader)
	b.WriteString("polars:\n")
	fmt.Fprintf(&b, "  winds: %s\n", numbers(f.Polars.Winds))
	fmt.Fprintf(&b, "  angles: %s\n", numbers(f.Polars.Angles))
	b.WriteString("  boats:\n")
	for _, tb := range f.Polars.Boats {
		fmt.Fprintf(&b, "    - boat: %s\n", tb.Boat)
		for _, part := range []struct {
			name string
			rows [][]float64
		}{{"speed", tb.Speed}, {"up", tb.Up}, {"down", tb.Down}} {
			fmt.Fprintf(&b, "      %s:\n", part.name)
			for _, r := range part.rows {
				fmt.Fprintf(&b, "        - %s\n", numbers(r))
			}
		}
	}
	return []byte(b.String()), nil
}

// numbers are a flow list of numbers, each as short as it reads.
func numbers(v []float64) string {
	parts := make([]string, len(v))
	for i, x := range v {
		parts[i] = strconv.FormatFloat(x, 'f', -1, 64)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// readTable reads the catalog's polars.
func readTable(path string) (*tableFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f tableFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return nil, err
	}
	if len(f.Polars.Winds) == 0 || len(f.Polars.Angles) == 0 {
		return nil, errors.New("the table has no winds or no angles")
	}
	return &f, nil
}

// parallel runs do for 0 … n−1 on every core.
func parallel(n int, do func(i int)) {
	jobs := make(chan int)
	var wg sync.WaitGroup
	for range runtime.NumCPU() {
		wg.Go(func() {
			for i := range jobs {
				do(i)
			}
		})
	}
	for i := range n {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
}

// The points -check sails again for each boat, and how near the table's
// speed each must come, knots: the table's hundredth, and a little for
// another machine's last bits.
var (
	checkWinds  = []float64{8, 14, 20}
	checkAngles = []float64{90, 150}
)

const tableTolerance = 0.015

// checkTable sails a kind's points at the winds and angles given again and
// fails if any differs from the table's: a change to the physics that
// moves the boat's polar must write the table again.
func checkTable(k *kind, f *tableFile, winds, angles []float64) error {
	var tb *tableBoat
	for i := range f.Polars.Boats {
		if f.Polars.Boats[i].Boat == k.id {
			tb = &f.Polars.Boats[i]
		}
	}
	if tb == nil {
		return fmt.Errorf("%s has no polar in %s: go run ./tools/polar -table", k.id, tablePath)
	}
	if len(tb.Speed) != len(f.Polars.Winds) {
		return fmt.Errorf("%s's polar has %d winds, the table %d", k.id, len(tb.Speed), len(f.Polars.Winds))
	}
	t := tableKind(k)
	type job struct{ wind, angle float64 }
	var jobs []job
	for _, w := range winds {
		for _, a := range angles {
			jobs = append(jobs, job{w, a})
		}
	}
	got := make([]point, len(jobs))
	parallel(len(jobs), func(n int) { got[n] = tablePoint(t, jobs[n].wind, jobs[n].angle) })
	var off []string
	for n, jb := range jobs {
		i, j := indexOf(f.Polars.Winds, jb.wind), indexOf(f.Polars.Angles, jb.angle)
		if i < 0 || j < 0 || j >= len(tb.Speed[i]) {
			return fmt.Errorf("%g knots at %g° is not in %s", jb.wind, jb.angle, tablePath)
		}
		want, speed := tb.Speed[i][j], 0.0
		if got[n].OK {
			speed = got[n].Speed
		}
		if math.Abs(speed-want) > tableTolerance {
			off = append(off, fmt.Sprintf("%g knots at %g°: %.3f knots, the table %.2f", jb.wind, jb.angle, speed, want))
		}
	}
	if len(off) > 0 {
		return fmt.Errorf("the polar has moved from %s (go run ./tools/polar -table, then go run ./tools/catalog): %s",
			tablePath, strings.Join(off, "; "))
	}
	fmt.Printf("%s: the table's polar holds at %d points\n", k.name, len(jobs))
	return nil
}

// indexOf is v's index in a, or −1.
func indexOf(a []float64, v float64) int {
	for i, x := range a {
		if x == v {
			return i
		}
	}
	return -1
}
