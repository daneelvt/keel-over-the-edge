// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"math"
	"net/http"
	"strconv"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The sea on the world page: every sea area's waves as the frame now
// raises them, its swell and how much the current raises its waves; and at
// a point asked about, its partitions, the current's factor along its wind
// sea and the share the land's lee leaves.

// seaPage is sea.json.
type seaPage struct {
	Tick  int64     `json:"tick"`
	Side  int       `json:"side"`  // areas a side
	Size  float64   `json:"size"`  // an area's side, m
	Areas []seaArea `json:"areas"` // row by row from the south-west
	Point *seaPoint `json:"point,omitempty"`
}

type seaArea struct {
	Hs        float64 `json:"hs"`        // the band's significant height, m
	WindHs    float64 `json:"windHs"`    // the wind sea's, m
	SwellHs   float64 `json:"swellHs"`   // the swell's, m
	Period    float64 `json:"period"`    // the swell's peak period, s
	From      float64 `json:"from"`      // the direction the swell comes from, degrees
	Raised    float64 `json:"raised"`    // the band's Hs over its Hs in still water
	WindFrom  float64 `json:"windFrom"`  // the wave wind's direction, degrees
	WindKnots float64 `json:"windKnots"` // and speed
}

type seaPoint struct {
	East        float64 `json:"east"`
	North       float64 `json:"north"`
	WindHs      float64 `json:"windHs"`     // m
	WindPeriod  float64 `json:"windPeriod"` // s
	SwellHs     float64 `json:"swellHs"`    // m
	SwellPeriod float64 `json:"swellPeriod"`
	SwellFrom   float64 `json:"swellFrom"` // degrees
	Current     float64 `json:"current"`   // how much the current raises the wind sea's peak wave along its way
	Lee         float64 `json:"lee"`       // the share of the waves the land's lee leaves
	Hs          float64 `json:"hs"`        // the waves' significant height there, in the lee, m
}

// sea serves sea.json, of the frame now, with the point at east and north
// if both are given.
func (o *Owner) sea(w http.ResponseWriter, r *http.Request) {
	if o.cfg.Frames == nil || o.cfg.Waves == nil {
		http.Error(w, "no sea", http.StatusNotFound)
		return
	}
	f := o.cfg.Frames.Acquire()
	tick := f.Tick
	inputs := append([]physics.SeaInput(nil), f.Sea.Now...)
	f.Release()
	n := int32(physics.SeaAreas)
	if len(inputs) != int(n*n) {
		http.Error(w, "no sea", http.StatusNotFound)
		return
	}
	win := physics.SeaWindow{
		Size: n, Inputs: make([]physics.SeaInput, n*n), Amp: make([]float64, n*n*physics.SeaComponents),
		Hs: make([]float64, n*n), Peak: make([]float64, n*n), Parts: make([]physics.SeaParts, n*n),
		Bits: make([]uint64, n*n*physics.SeaWords),
	}
	for i, in := range inputs {
		physics.SeaArea(o.cfg.Waves, &win, int32(i), in)
	}
	win.Seal()
	page := seaPage{Tick: tick, Side: int(n), Size: physics.SeaAreaSize, Areas: make([]seaArea, n*n)}
	for i := range inputs {
		in, p := &inputs[i], &win.Parts[i]
		sw := in.Swell()
		a := seaArea{
			Hs: round2(win.Hs[i]), WindHs: round2(p.WindHs), SwellHs: round2(p.SwellHs),
			Raised:    1,
			WindFrom:  round2(float64(in.From) * 360 / physics.SeaFromSteps),
			WindKnots: round2(float64(in.Speed) * physics.SeaSpeedStep / knot),
		}
		if sw.Height > 0 {
			a.Period, a.From = round2(sw.Period), round2(sw.From*180/math.Pi)
		}
		if p.StillHs > 0 {
			a.Raised = round2(win.Hs[i] / p.StillHs)
		}
		page.Areas[i] = a
	}
	q := r.URL.Query()
	if q.Has("east") || q.Has("north") {
		x, err1 := strconv.ParseFloat(q.Get("east"), 64)
		y, err2 := strconv.ParseFloat(q.Get("north"), 64)
		if err1 != nil || err2 != nil || math.IsNaN(x) || math.IsNaN(y) || math.Abs(x) > 20000 || math.Abs(y) > 20000 {
			http.Error(w, "east and north, m within 20 km of the centre", http.StatusBadRequest)
			return
		}
		page.Point = o.seaPoint(&win, x, y)
	}
	writeJSON(w, &page)
}

// seaPoint is the sea at (x, y) in win, the world's whole window.
func (o *Owner) seaPoint(win *physics.SeaWindow, x, y float64) *seaPoint {
	last := win.Size - 1
	c := min(max(physics.SeaAreaOf(x), 0), last)
	r := min(max(physics.SeaAreaOf(y), 0), last)
	i := r*win.Size + c
	in, p := &win.Inputs[i], &win.Parts[i]
	out := &seaPoint{East: round2(x), North: round2(y), WindHs: round2(p.WindHs), SwellHs: round2(p.SwellHs), Current: 1, Lee: 1}
	if p.WindPeak > 0 {
		out.WindPeriod = round2(2 * math.Pi / p.WindPeak)
		// The wind sea travels toward where its wind blows.
		to := float64(in.From)*2*math.Pi/physics.SeaFromSteps + math.Pi
		out.Current = round2(o.cfg.Waves.CurrentFactor(float64(in.CurrentEast)*physics.SeaCurrentStep,
			float64(in.CurrentNorth)*physics.SeaCurrentStep, p.WindPeak, to))
	}
	if sw := in.Swell(); sw.Height > 0 {
		out.SwellPeriod, out.SwellFrom = round2(sw.Period), round2(sw.From*180/math.Pi)
	}
	var t physics.SeaTick
	sea := physics.Sea{Waves: o.cfg.Waves, Window: win, Tick: &t, Lee: o.cfg.Shelter}
	out.Lee = round2(physics.LeeAt(&sea, x, y))
	out.Hs = round2(physics.SeaSample(&sea, nil, x, y).Hs)
	return out
}
