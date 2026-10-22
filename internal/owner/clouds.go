// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"math"
	"net/http"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The clouds and the rain on the world page, as the frame now makes them:
// each system's heaped cloud, the three sheets' cover and the rain over the
// disk on grids, and the fair-weather cumulus; and at a point asked about,
// its rain, its sheets and the heaped cloud over it. The coming front is
// the frame's, so the cirrus ahead of a front shows before its spell is in
// play, as every phone shows it.

// The grids' spacings, in the sheets' lattice: the sheets every other
// point of it, where their cover is the lattice's own; the rain at every
// point, fine enough for a front's band and a storm's spiral bands.
const (
	sheetEvery = 2
	rainEvery  = 1
)

// sheetsBeyond is how far beyond the lip the sheets' grid reaches, m:
// sheet cloud there is seen from the disk, and a coming front's cirrus,
// which runs 3 nautical miles ahead of its line, is there before its spell
// is in play.
const sheetsBeyond = 6000

// cumulusMost is the most fair-weather cumulus clouds.json gives.
const cumulusMost = 400

// formWords are the heaped clouds' forms, by physics' numbers.
var formWords = map[float64]string{
	physics.FormCumulus:      "cumulus",
	physics.FormCumulonimbus: "cumulonimbus",
	physics.FormStorm:        "storm",
}

// rainWordNames are rain's words, by RainWord's numbers.
var rainWordNames = [...]string{"none", "light", "moderate", "heavy", "violent"}

// cloudsPage is clouds.json.
type cloudsPage struct {
	Tick    int64         `json:"tick"`
	Lip     float64       `json:"lip"`    // m
	Layers  [3]float64    `json:"layers"` // the sheets' heights: cirrus, middle and low, m
	Words   [3]float64    `json:"words"`  // rain is light under the first, moderate under the second, heavy under the third and violent above, mm an hour
	Clouds  []cloudJSON   `json:"clouds"`
	Sheets  cloudGrid     `json:"sheets"` // three values a point: the cirrus's, the middle sheet's and the low cloud's cover, 0 to 1, to sheetsBeyond beyond the lip
	Rain    cloudGrid     `json:"rain"`   // a value a point: mm an hour
	Cumulus []cumulusJSON `json:"cumulus"`
}

// cloudJSON is a heaped cloud: a squall's, a shower's or a storm's.
type cloudJSON struct {
	Form      string  `json:"form"` // cumulus, cumulonimbus or storm
	Slot      int     `json:"slot"` // its system's
	East      float64 `json:"east"`
	North     float64 `json:"north"`
	Heading   float64 `json:"heading"` // degrees, the way it moves
	Size      float64 `json:"size"`    // its system's radius, m
	Cloud     float64 `json:"cloud"`   // its cloud strength, 0 to 1
	Base      float64 `json:"base"`    // m
	Top       float64 `json:"top"`     // m
	Behind    float64 `json:"behind"`  // how far its top reaches behind its centre and ahead of it, m
	Ahead     float64 `json:"ahead"`
	Deck      float64 `json:"deck"`    // its deck's reach, m
	DeckTop   float64 `json:"deckTop"` // m
	Rain      float64 `json:"rain"`    // at its core, mm an hour
	RainReach float64 `json:"rainReach"`
}

// cloudGrid is a grid over the disk: side points a side, step metres
// apart, row by row from the north-west point, at west and north; 0
// beyond its reach, a step beyond the lip, or for the sheets sheetsBeyond.
type cloudGrid struct {
	West   float64   `json:"west"`
	North  float64   `json:"north"`
	Step   float64   `json:"step"`
	Side   int       `json:"side"`
	Values []float64 `json:"values"`
}

// cumulusJSON is a fair-weather cumulus.
type cumulusJSON struct {
	East   float64 `json:"east"`
	North  float64 `json:"north"`
	Radius float64 `json:"radius"` // m, at its whole
	Top    float64 `json:"top"`    // m, at its whole
	Grow   float64 `json:"grow"`   // how much of itself it is now, 0 to 1
}

// skyPoint is the sky at a point: its rain, its sheets and the heaped
// cloud over it, if one is.
type skyPoint struct {
	Rain     float64   `json:"rain"` // mm an hour
	RainWord string    `json:"rainWord"`
	Sheets   skySheets `json:"sheets"`
	Cloud    *skyCloud `json:"cloud"` // null for none
}

// skySheets are the three sheets' cover, 0 to 1.
type skySheets struct {
	Cirrus float64 `json:"cirrus"`
	Middle float64 `json:"middle"`
	Low    float64 `json:"low"`
}

type skyCloud struct {
	Form string  `json:"form"`
	Slot int     `json:"slot"`
	Top  float64 `json:"top"` // m
}

// frameWeather is the world's weather at the frame now: its spells in play,
// its keyframes and the coming front. ok is false without frames.
func (o *Owner) frameWeather() (t *physics.WeatherTick, tick int64, ok bool) {
	if o.cfg.Frames == nil || o.cfg.Weather == nil {
		return nil, 0, false
	}
	w := &physics.Weather{Prepared: o.cfg.Weather}
	f := o.cfg.Frames.Acquire()
	tick = f.Tick
	w.Set(f.SpellsInPlay())
	w.SetKeys(f.Keys[:2])
	w.SetComing(&f.Coming)
	f.Release()
	t = new(physics.WeatherTick)
	physics.WeatherAt(w, t, float64(tick))
	return t, tick, true
}

// clouds serves clouds.json, of the frame now.
func (o *Owner) clouds(w http.ResponseWriter, r *http.Request) {
	t, tick, ok := o.frameWeather()
	if !ok {
		http.Error(w, "no weather", http.StatusNotFound)
		return
	}
	p := o.cfg.Weather
	lip := p.Edge()
	page := cloudsPage{
		Tick: tick, Lip: round2(lip), Words: rainWords(p),
		Layers:  [3]float64{p.LayerHeight(physics.LayerCirrus), p.LayerHeight(physics.LayerMiddle), p.LayerHeight(physics.LayerLow)},
		Clouds:  []cloudJSON{},
		Cumulus: []cumulusJSON{},
	}
	var heaped [physics.MaxClouds]physics.Cloud
	for _, c := range heaped[:physics.HeapedClouds(t, heaped[:])] {
		page.Clouds = append(page.Clouds, cloudJSON{
			Form: formWords[c.Form], Slot: int(c.Slot), East: round2(c.East), North: round2(c.North),
			Heading: round2(degrees(c.Heading)), Size: round2(c.Size), Cloud: round3(c.Cloud),
			Base: round2(c.Base), Top: round2(c.Top), Behind: round2(c.Behind), Ahead: round2(c.Ahead),
			Deck: round2(c.Deck), DeckTop: round2(c.DeckTop), Rain: round1(c.Rain), RainReach: round2(c.RainReach),
		})
	}
	page.Sheets = gridOver(lip+sheetsBeyond, sheetEvery*p.SheetLattice(), physics.Layers, func(x, y float64, out []float64) {
		s := physics.SheetAt(t, x, y)
		out[0], out[1], out[2] = round3(s.Cirrus), round3(s.Middle), round3(s.Low)
	})
	page.Rain = gridOver(lip+rainEvery*p.SheetLattice(), rainEvery*p.SheetLattice(), 1, func(x, y float64, out []float64) {
		out[0] = round1(physics.RainAt(t, x, y))
	})
	cu := make([]physics.Cumulus, cumulusMost)
	for _, c := range cu[:physics.CumulusAt(t, 0, 0, lip, 0, nil, cu)] {
		page.Cumulus = append(page.Cumulus, cumulusJSON{
			East: round2(c.East), North: round2(c.North), Radius: round2(c.Radius), Top: round2(c.Top), Grow: round3(c.Grow),
		})
	}
	writeJSON(w, &page)
}

// gridOver is a grid over the circle of radius reach, step metres apart,
// each point within it given its values by value, per values a point.
func gridOver(reach, step float64, per int, value func(x, y float64, out []float64)) cloudGrid {
	n := int(math.Ceil(reach / step))
	half := float64(n) * step
	g := cloudGrid{West: -half, North: half, Step: step, Side: 2*n + 1}
	g.Values = make([]float64, g.Side*g.Side*per)
	for j := range g.Side {
		y := half - float64(j)*step
		for i := range g.Side {
			x := -half + float64(i)*step
			if math.Hypot(x, y) > reach {
				continue
			}
			k := (j*g.Side + i) * per
			value(x, y, g.Values[k:k+per])
		}
	}
	return g
}

// rainWords are the rates rain's words change at, mm an hour, as RainWord
// tells them: each the least rate of the word above, found by halving.
func rainWords(p *physics.WeatherPrepared) [3]float64 {
	var out [3]float64
	for k := range out {
		lo, hi := 0.0, 1000.0
		for range 50 {
			mid := (lo + hi) / 2
			if p.RainWord(mid) > int32(k+1) {
				hi = mid
			} else {
				lo = mid
			}
		}
		out[k] = round2(hi)
	}
	return out
}

// skyAt is the sky at (x, y) now, or nil without frames.
func (o *Owner) skyAt(x, y float64) *skyPoint {
	t, _, ok := o.frameWeather()
	if !ok {
		return nil
	}
	p := o.cfg.Weather
	rain := physics.RainAt(t, x, y)
	s := physics.SheetAt(t, x, y)
	out := &skyPoint{
		Rain: round1(rain), RainWord: rainWordNames[min(max(p.RainWord(rain), 0), int32(len(rainWordNames)-1))],
		Sheets: skySheets{Cirrus: round3(s.Cirrus), Middle: round3(s.Middle), Low: round3(s.Low)},
	}
	var heaped [physics.MaxClouds]physics.Cloud
	for _, c := range heaped[:physics.HeapedClouds(t, heaped[:])] {
		if !overhead(&c, x, y) || (out.Cloud != nil && out.Cloud.Top >= round2(c.Top)) {
			continue
		}
		out.Cloud = &skyCloud{Form: formWords[c.Form], Slot: int(c.Slot), Top: round2(c.Top)}
	}
	return out
}

// overhead reports whether a heaped cloud is over (x, y): within the
// circle its top reaches, from behind its centre to ahead of it along the
// way it moves, or within its deck.
func overhead(c *physics.Cloud, x, y float64) bool {
	dx, dy := x-c.East, y-c.North
	if math.Hypot(dx, dy) < c.Deck {
		return true
	}
	mid := (c.Ahead - c.Behind) / 2
	sin, cos := math.Sincos(c.Heading)
	return math.Hypot(dx-mid*sin, dy-mid*cos) < (c.Ahead+c.Behind)/2
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }
func round3(v float64) float64 { return math.Round(v*1000) / 1000 }
