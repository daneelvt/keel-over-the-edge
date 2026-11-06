// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"fmt"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The sea a week raises: the wind sea of every other sea area within the
// rim, on open water, at every point of the wave wind's grid (or every so
// many), by the wave wind as the server makes it. Its significant height
// is tallied by the wave wind's Beaufort force, by the regime in effect and
// within the inner waters; and, beside it, the sea the fetch alone would
// raise, the catalog's stretch left out, for what the stretch leaves as it
// was.

// seaForces are where each Beaufort force begins, knots (Met Office).
var seaForces = [...]float64{0, 1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56}

const (
	seaHsStep  = 0.01 // m: the histograms' bins
	seaHsBins  = 600
	seaInnerNM = 1.5
	seaGale    = 8 // the force whose sea is held to seaGaleHs
	seaGaleHs  = 1.8
	seaStormHs = 1.3 // m: the least of a stormy spell's 95th percentile
	seaSame    = 0.02
)

// hsHistogram counts heights in bins of seaHsStep.
type hsHistogram struct {
	n    [seaHsBins]int64
	all  int64
	most float64
}

func (h *hsHistogram) add(hs float64) {
	i := min(int(hs/seaHsStep), seaHsBins-1)
	h.n[i]++
	h.all++
	h.most = max(h.most, hs)
}

func (h *hsHistogram) merge(o *hsHistogram) {
	for i := range h.n {
		h.n[i] += o.n[i]
	}
	h.all += o.all
	h.most = max(h.most, o.most)
}

// at is the p-th quantile, p a fraction, by the bins' middles.
func (h *hsHistogram) at(p float64) float64 {
	if h.all == 0 {
		return math.NaN()
	}
	want := max(int64(math.Ceil(p*float64(h.all))), 1)
	sum := int64(0)
	for i, c := range h.n {
		if sum += c; sum >= want {
			return (float64(i) + 0.5) * seaHsStep
		}
	}
	return h.most
}

// seaSide is one sea's tally: the catalog's, or the fetch's alone.
type seaSide struct {
	all, inner hsHistogram
	byRegime   []hsHistogram
}

func (s *seaSide) merge(o *seaSide) {
	s.all.merge(&o.all)
	s.inner.merge(&o.inner)
	if s.byRegime == nil {
		s.byRegime = make([]hsHistogram, len(o.byRegime))
	}
	for i := range o.byRegime {
		s.byRegime[i].merge(&o.byRegime[i])
	}
}

// seaTally is the tally of the weeks' seas.
type seaTally struct {
	weeks       int
	sea, plain  seaSide
	byForce     [len(seaForces)]hsHistogram
	sampleShare [len(seaForces)]int64
	// Each week's own median and 95th percentile, for how much weeks differ.
	medians, p95s []float64
}

func (s *seaTally) merge(o *seaTally) {
	s.weeks += o.weeks
	s.sea.merge(&o.sea)
	s.plain.merge(&o.plain)
	for i := range s.byForce {
		s.byForce[i].merge(&o.byForce[i])
	}
	s.medians = append(s.medians, o.medians...)
	s.p95s = append(s.p95s, o.p95s...)
}

func seaForceOf(knots float64) int {
	f := 0
	for i, from := range seaForces {
		if knots >= from {
			f = i
		}
	}
	return f
}

// openHs is the significant height of an open sea's wind sea by the wave
// wind's speed in the sea's steps, made as they are first asked for.
type openHs struct {
	waves *physics.Waves
	win   physics.SeaWindow
	hs    map[uint32]float64
}

func newOpenHs(waves *physics.Waves) *openHs {
	return &openHs{waves: waves, hs: map[uint32]float64{}, win: physics.SeaWindow{
		Size:   1,
		Inputs: make([]physics.SeaInput, 1),
		Amp:    make([]float64, physics.SeaComponents),
		Hs:     make([]float64, 1),
		Peak:   make([]float64, 1),
	}}
}

func (o *openHs) at(speed float64) float64 {
	in := o.waves.OpenSea(speed, 0)
	if hs, ok := o.hs[in.Speed]; ok {
		return hs
	}
	physics.SeaArea(o.waves, &o.win, 0, in)
	hs := o.win.Hs[0]
	o.hs[in.Speed] = hs
	return hs
}

// seaWaves are the catalog's waves, and the same with the fetch never
// stretched.
type seaWaves struct {
	waves, plain *physics.Waves
	regimes      int
}

func newSeaWaves(cat *catalog.Catalog) *seaWaves {
	waves, _ := cat.Prepare()
	p := catalog.SeaParams(cat)
	p.StretchFrom = 100
	plain := new(physics.Waves)
	physics.PrepareSea(&p, plain)
	return &seaWaves{waves: waves, plain: plain, regimes: len(cat.Weather.Regimes)}
}

// checkSea tallies one week's sea, at every every-th point of the wave
// wind's grid.
func checkSea(tl *Timeline, w *Week, sw *seaWaves, every int64, tally *seaTally) {
	p := tl.Prepared()
	rim := p.Edge() * 0.97
	type area struct {
		x, y  float64
		inner bool
	}
	var areas []area
	for c := int32(0); c < physics.SeaAreas; c += 2 {
		for r := int32(0); r < physics.SeaAreas; r += 2 {
			x, y := physics.SeaAreaCentre(c, r)
			if d := math.Hypot(x, y); d <= rim {
				areas = append(areas, area{x, y, d <= seaInnerNM*nauticalMile})
			}
		}
	}
	ring := int64(p.WaveSamples())
	samples := make([]physics.WaveSample, int64(len(areas))*ring)
	hs, plain := newOpenHs(sw.waves), newOpenHs(sw.plain)
	tally.sea.byRegime = make([]hsHistogram, sw.regimes)
	tally.plain.byRegime = make([]hsHistogram, sw.regimes)
	var week hsHistogram
	grid := p.WaveGrid()
	last := p.WaveGridOf(w.Until)
	// The grid points from the first whose average is whole: a sample's
	// grid point and the ones before it fill the ring.
	for k := max(last%every+1, 1); k <= last; k++ {
		_, at := weatherAt(tl, p.WaveSampleTick(k), nil)
		slot := k % ring
		for i := range areas {
			samples[int64(i)*ring+slot] = physics.WaveSampleAt(at, areas[i].x, areas[i].y)
		}
		if k < ring || k%every != 0 {
			continue
		}
		regime := int(tl.Effective(k*grid, nil).Regime)
		for i := range areas {
			speed := p.WaveAverage(samples[int64(i)*ring:int64(i+1)*ring], k).Speed
			h, h0 := hs.at(speed), plain.at(speed)
			week.add(h)
			tally.byForce[seaForceOf(speed/knot)].add(h)
			for _, s := range []struct {
				side *seaSide
				h    float64
			}{{&tally.sea, h}, {&tally.plain, h0}} {
				s.side.all.add(s.h)
				s.side.byRegime[regime].add(s.h)
				if areas[i].inner {
					s.side.inner.add(s.h)
				}
			}
		}
	}
	tally.weeks++
	tally.medians = append(tally.medians, week.at(0.5))
	tally.p95s = append(tally.p95s, week.at(0.95))
}

// failures is what the tally breaks of the sea's rules: where a gale
// blows its sea is seaGaleHs or more; a stormy spell's 95th percentile
// seaStormHs or more; and the trade wind's median and the inner waters'
// quartiles and 95th percentile within seaSame of the sea the fetch alone
// raises.
func (s *seaTally) failures(cat *catalog.Catalog) []string {
	var out []string
	if g := &s.byForce[seaGale]; g.all > 0 && g.at(0.05) < seaGaleHs {
		out = append(out, fmt.Sprintf("where force %d blows, the sea's 5th percentile is %.2f m, under %.1f m", seaGale, g.at(0.05), seaGaleHs))
	}
	same := func(what string, a, b float64) {
		if b > 0 && math.Abs(a/b-1) > seaSame {
			out = append(out, fmt.Sprintf("%s: %.2f m, %.2f m before the stretch", what, a, b))
		}
	}
	// The regimes by what they are, not their names: the stormy spells'
	// wind is the strongest, and the trade wind's spells the most of the
	// world's time.
	stormy, trade := 0, 0
	for i, r := range cat.Weather.Regimes {
		if r.Wind.Speed[1] > cat.Weather.Regimes[stormy].Wind.Speed[1] {
			stormy = i
		}
		if r.Share > cat.Weather.Regimes[trade].Share {
			trade = i
		}
	}
	if h := &s.sea.byRegime[stormy]; h.all > 0 && h.at(0.95) < seaStormHs {
		out = append(out, fmt.Sprintf("a stormy spell's 95th percentile is %.2f m, under %.1f m", h.at(0.95), seaStormHs))
	}
	if h := &s.sea.byRegime[trade]; h.all > 0 {
		same("the trade wind's median", h.at(0.5), s.plain.byRegime[trade].at(0.5))
	}
	if s.sea.inner.all > 0 {
		for _, q := range []float64{0.25, 0.5, 0.75, 0.95} {
			same(fmt.Sprintf("within %.1f NM, the %.0fth percentile", seaInnerNM, 100*q), s.sea.inner.at(q), s.plain.inner.at(q))
		}
	}
	return out
}

func (s *seaTally) markdown(cat *catalog.Catalog) string {
	var b strings.Builder
	fmt.Fprintf(&b, "\n### The wind sea over %d weeks, open water\n\n", s.weeks)
	b.WriteString("| Force | Share | p5, m | p50 | p95 | Most |\n|---|---|---|---|---|---|\n")
	for f := range s.byForce {
		h := &s.byForce[f]
		if h.all == 0 {
			continue
		}
		fmt.Fprintf(&b, "| %d | %.1f%% | %.2f | %.2f | %.2f | %.2f |\n", f, 100*float64(h.all)/float64(s.sea.all.all), h.at(0.05), h.at(0.5), h.at(0.95), h.most)
	}
	b.WriteString("\n| Where | p25, m | p50 | p75 | p95 | p99 | Before the stretch: p50 | p95 |\n|---|---|---|---|---|---|---|---|\n")
	row := func(name string, h, h0 *hsHistogram) {
		if h.all == 0 {
			return
		}
		fmt.Fprintf(&b, "| %s | %.2f | %.2f | %.2f | %.2f | %.2f | %.2f | %.2f |\n", name, h.at(0.25), h.at(0.5), h.at(0.75), h.at(0.95), h.at(0.99), h0.at(0.5), h0.at(0.95))
	}
	row("all", &s.sea.all, &s.plain.all)
	row(fmt.Sprintf("within %.1f NM", seaInnerNM), &s.sea.inner, &s.plain.inner)
	for i := range s.sea.byRegime {
		row(string(cat.Weather.Regimes[i].ID), &s.sea.byRegime[i], &s.plain.byRegime[i])
	}
	if len(s.medians) > 0 {
		fmt.Fprintf(&b, "\nEach week's p50 %.2f–%.2f m, p95 %.2f–%.2f m.\n", minOf(s.medians), maxOf(s.medians), minOf(s.p95s), maxOf(s.p95s))
	}
	return b.String()
}
