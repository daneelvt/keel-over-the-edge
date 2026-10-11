// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"math"
	"runtime"
	"slices"
	"strings"
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The polar in waves: the boat sailed at each true wind angle in the sea its
// wind raises over open water, beside the same boat in flat water. In waves
// the speed swings as the boat climbs and surfs, so each point is its mean
// with its 10th and 90th percentiles. Nothing here is checked: no published
// polar of this boat in known waves exists to check against.

const (
	seaSettle  = 30.0  // s sailed before measuring
	seaMeasure = 120.0 // s measured: some forty of the longest waves
	// seaTick is the tick the sea is sailed from, late in a world's life.
	seaTick = 740_000_000
)

// openSea is the sea a wind of knots at sail height, from the north, raises
// over open water: one area, the same everywhere.
type openSea struct {
	sea  physics.Sea
	win  physics.SeaWindow
	time physics.SeaTick
}

func newOpenSea(w *physics.Waves, windKnots float64) *openSea {
	o := &openSea{win: physics.SeaWindow{
		Size:   1,
		Inputs: make([]physics.SeaInput, 1),
		Amp:    make([]float64, physics.SeaComponents),
		Hs:     make([]float64, 1),
		Peak:   make([]float64, 1),
	}}
	physics.SeaArea(w, &o.win, 0, w.OpenSea(wind10(windKnots), 0))
	o.win.Seal()
	o.sea = physics.Sea{Waves: w, Window: &o.win, Tick: &o.time}
	return o
}

// wavePoint is the boat's sailing at one true wind angle in waves.
type wavePoint struct {
	TWA, Sheet     float64
	Mean, P10, P90 float64 // knots
	VMG            float64 // knots
	Heel           float64 // degrees, the greatest to either side
	Heave, Pitch   float64 // m and degrees, the greatest either way
	OK             bool
}

// sailInWaves sails at twa with the sheet fixed, in a sea of its own.
func sailInWaves(b *physics.Prepared, w *physics.Waves, windKnots, twa, sheet float64) wavePoint {
	sea := newOpenSea(w, windKnots)
	h := helmsman{target: twa * deg}
	bt := newBoat(b, wind10(windKnots), h.target, sheet)
	n := int((seaSettle + seaMeasure) * physics.StepsPerSecond)
	start := int(seaSettle * physics.StepsPerSecond)
	p := wavePoint{TWA: twa, Sheet: sheet}
	speeds := make([]float64, 0, n-start)
	y0 := 0.0
	for i := range n {
		bt.c.Helm = h.helm(&bt.s)
		physics.SeaAtTick(w, &sea.time, seaTick+int64(i))
		bt.sea = &sea.sea
		bt.step()
		if i == start {
			y0 = bt.s.Y
		}
		if i >= start {
			speeds = append(speeds, math.Hypot(bt.s.Surge, bt.s.Sway))
			p.Heel = max(p.Heel, math.Abs(bt.s.Heel)/deg)
			p.Heave = max(p.Heave, math.Abs(bt.s.Heave))
			p.Pitch = max(p.Pitch, math.Abs(bt.s.Pitch)/deg)
		}
	}
	slices.Sort(speeds)
	sum := 0.0
	for _, v := range speeds {
		sum += v
	}
	p.Mean = sum / float64(len(speeds)) / knot
	p.P10 = speeds[len(speeds)/10] / knot
	p.P90 = speeds[len(speeds)*9/10] / knot
	p.VMG = (bt.s.Y - y0) / seaMeasure / knot
	p.OK = !bt.capsized
	return p
}

// bestInWaves finds the sheet that sails fastest at a true wind angle in
// waves, among those that keep the boat upright.
func bestInWaves(b *physics.Prepared, w *physics.Waves, windKnots, twa float64) wavePoint {
	top := wavePoint{TWA: twa}
	for sheet := 0.0; sheet <= 1.0001; sheet += 0.05 {
		if p := sailInWaves(b, w, windKnots, twa, sheet); p.OK && (!top.OK || p.Mean > top.Mean) {
			top = p
		}
	}
	return top
}

func runSea(b *physics.Prepared, w *physics.Waves, windKnots float64) error {
	if !(windKnots > 0) {
		return fmt.Errorf("-sea wants a wind in knots, not %g", windKnots)
	}
	flat := make([]point, len(chartAngles))
	waves := make([]wavePoint, len(chartAngles))
	jobs := make(chan int)
	var wg sync.WaitGroup
	for range runtime.NumCPU() {
		wg.Go(func() {
			for j := range jobs {
				flat[j] = best(b, windKnots, chartAngles[j])
				waves[j] = bestInWaves(b, w, windKnots, chartAngles[j])
			}
		})
	}
	for j := range chartAngles {
		jobs <- j
	}
	close(jobs)
	wg.Wait()

	sea := newOpenSea(w, windKnots)
	var s strings.Builder
	fmt.Fprintf(&s, "\n%g knots of wind at sail height (%.1f knots 10 m up) and the sea it raises: Hs %.2f m, peak period %.1f s, %d waves\n",
		windKnots, wind10(windKnots)/knot, sea.win.Hs[0], 2*math.Pi/sea.win.Peak[0], sea.win.Count)
	fmt.Fprintln(&s, "        flat water          in waves")
	fmt.Fprintln(&s, "  TWA  speed    VMG    mean    10%    90%    VMG  heel heave pitch sheet")
	var upFlat, upWaves, downFlat, downWaves float64
	for j, f := range flat {
		v := waves[j]
		fmt.Fprintf(&s, "  %3.0f", f.TWA)
		if f.OK {
			fmt.Fprintf(&s, " %6.2f %6.2f", f.Speed, f.VMG)
			upFlat, downFlat = max(upFlat, f.VMG), max(downFlat, -f.VMG)
		} else {
			fmt.Fprint(&s, "      capsizes")
		}
		if v.OK {
			fmt.Fprintf(&s, " %7.2f %6.2f %6.2f %6.2f %5.0f %5.2f %5.1f %5.2f\n", v.Mean, v.P10, v.P90, v.VMG, v.Heel, v.Heave, v.Pitch, v.Sheet)
			upWaves, downWaves = max(upWaves, v.VMG), max(downWaves, -v.VMG)
		} else {
			fmt.Fprintln(&s, "   capsizes at every sheet")
		}
	}
	fmt.Fprintf(&s, "  best VMG upwind %.2f knots in flat water, %.2f in waves; downwind %.2f and %.2f\n", upFlat, upWaves, downFlat, downWaves)
	fmt.Print(s.String())
	return nil
}
