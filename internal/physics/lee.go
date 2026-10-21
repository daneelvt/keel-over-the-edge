// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The waves' lee. Behind land the wind sea grows again from the shore: its
// fetch there is the open water upwind to the land, not the area's (the
// US Geological Survey's wind-fetch model applies the Coastal Engineering
// Manual's growth along each direction so), and fetch-limited growth makes
// its height go as the root of the fetch. Land of any height stops waves,
// a reef that barely shelters the wind as surely as a cliff. Swell is
// shadowed behind land, diffraction filling the shadow slowly: a narrow
// swell is a fifth of the open sea's half a mile behind an island half a
// mile across, and half of it a mile behind.
//
// So each cell of the shelter's tables holds, for each direction, the lee's
// fetch: the distance upwind of its centre to the first land, up to the
// sea's reach. In a cell whose fetch toward the wind is F_lee, of an area
// whose wind sea has the variance m₀ over the boat band, that sea is
//
//	f_w = √(min(1, m₀(F_lee) / m₀))
//
// of the area's, m₀(F_lee) the band's variance of the sea the same wind
// raises over F_lee (sea.go's table): over a few hundred metres the wind
// sea's waves are a second or so long, mostly shorter than the band's, so
// the boat band is all but flat in a lee. Over the outer half of the reach
// it gives way to the area's, so that the lee has no edge where the reach
// ends. The swell, whose fetch toward where it comes from is F_lee too, is
//
//	f_s = least + (1 − least) smoothstep(0, reach, F_lee)
//
// and the two together, weighed by their variances E,
//
//	f = √((f_w² E_w + f_s² E_s) / (E_w + E_s)).
//
// Each cell takes the sea of the area its centre is in; between cells'
// centres the factor is bilinear, and between directions linear, as the
// wind's shelter is, so that whoever draws the lee from the cells' factors
// draws the plane the boats ride. Where the four cells about a point hold
// no table, it is open water, 1, and nothing is scaled.

// LeeByte is a lee's fetch, m, as a table holds it: open water if it is
// beyond what a byte holds or not a number.
func LeeByte(fetch float64) uint8 {
	if !(fetch >= 0) {
		return ShelterLeeOpen
	}
	s := toInt32(math.Floor(float64(fetch*(1.0/ShelterLeeStep)) + 0.5))
	if s > shelterLeeMost {
		return ShelterLeeOpen
	}
	return uint8(255 - s)
}

// leeFetch is a table's lee byte as a fetch, m, and whether it is open
// water.
func leeFetch(b uint8) (float64, bool) {
	if b == ShelterLeeOpen {
		return 0, true
	}
	return float64(float64(255-int32(b)) * ShelterLeeStep), false
}

// LeeAt is the share of the waves the land leaves at (x, y) in sea: 1 with
// no shelter or none held about the point.
func LeeAt(sea *Sea, x, y float64) float64 {
	sh := sea.Lee
	if sh == nil {
		return 1
	}
	fa := float64(float64(float64(x/hexStep)+columnZero-(ShelterCell-1)/2.0) / ShelterCell)
	fb := float64(float64(float64((y-HexAcross/4)/HexAcross)+rowZero-(ShelterCell-1)/2.0) / ShelterCell)
	a0, b0 := math.Floor(fa), math.Floor(fb)
	ta, tb := fa-a0, fb-b0
	a, b := toInt32(a0), toInt32(b0)
	f00 := sea.cellLee(a, b)
	f10 := sea.cellLee(a+1, b)
	f01 := sea.cellLee(a, b+1)
	f11 := sea.cellLee(a+1, b+1)
	if f00 == 1 && f10 == 1 && f01 == 1 && f11 == 1 {
		return 1
	}
	return lerp(tb, lerp(ta, f00, f10), lerp(ta, f01, f11))
}

// CellLee is cell (a, b)'s factor for the sea of the area its centre is
// in, the share of the waves its lee leaves: what LeeAt is bilinear
// between, for drawing it. With no shelter it is 1.
func CellLee(sea *Sea, a, b int32) float64 {
	if sea.Lee == nil {
		return 1
	}
	return sea.cellLee(a, b)
}

// cellLee is cell (a, b)'s factor for the sea of the area its centre is
// in: 1 for a cell with no table, or one off the grid.
func (sea *Sea) cellLee(a, b int32) float64 {
	n, i, ok := ShelterCellOf(a, b)
	if !ok {
		return 1
	}
	ch := sea.Lee.Chunks[n]
	if ch == nil {
		return 1
	}
	v := ch.Values[i*ShelterDirections*ShelterStride : (i+1)*ShelterDirections*ShelterStride]
	x, y := ShelterCellCentre(a, b)
	return sea.Waves.leeOf(sea.Window, v, x, y)
}

// leeOf is the factor of a cell whose table is v and whose centre is (x,
// y), for the sea of the window's area there.
func (w *Waves) leeOf(win *SeaWindow, v []uint8, x, y float64) float64 {
	last := win.Size - 1
	c := min(max(SeaAreaOf(x)-win.Col, 0), last)
	r := min(max(SeaAreaOf(y)-win.Row, 0), last)
	j := r*win.Size + c
	in := &win.Inputs[j]
	ew, es, band := win.Hs[j], 0.0, 0.0
	if win.Parts != nil {
		ew, es, band = win.Parts[j].WindHs, win.Parts[j].SwellHs, win.Parts[j].WindBand
	}
	ew, es = float64(ew*ew), float64(es*es)
	if !(ew+es > 0) {
		return 1
	}
	fw, fs := 1.0, 1.0
	if ew > 0 && band > 0 {
		fw = w.leeAlong(v, float64(float64(in.From)*seaFromStep), float64(float64(in.Speed)*SeaSpeedStep), band, false)
	}
	if es > 0 {
		fs = w.leeAlong(v, float64(float64(in.SwellFrom)*seaFromStep), 0, 0, true)
	}
	if fw == 1 && fs == 1 {
		return 1
	}
	return math.Sqrt(float64(float64(float64(fw*fw)*ew)+float64(float64(fs*fs)*es)) / float64(ew+es))
}

// leeAlong is a cell's factor on the wind sea of a wind of u m/s whose
// band's variance is band, or on the swell, coming from from: linear
// between the two nearest directions its table holds.
func (w *Waves) leeAlong(v []uint8, from, u, band float64, swell bool) float64 {
	turns := float64(wrapAngle(from)*(ShelterDirections/(2*math.Pi))) + ShelterDirections
	k0 := math.Floor(turns)
	t := turns - k0
	k := toInt32(k0) % ShelterDirections
	f0 := w.leeFactor(v[k*ShelterStride+2], u, band, swell)
	f1 := w.leeFactor(v[((k+1)%ShelterDirections)*ShelterStride+2], u, band, swell)
	return lerp(t, f0, f1)
}

// leeFactor is f_w for a wind sea of a wind of u m/s whose band's variance
// is band, or f_s for the swell, by a lee byte.
func (w *Waves) leeFactor(b uint8, u, band float64, swell bool) float64 {
	f, open := leeFetch(b)
	if open {
		return 1
	}
	near := smooth(min2(f/w.leeReach, 1))
	if swell {
		return w.shadowLeast + float64((1-w.shadowLeast)*near)
	}
	fw := math.Sqrt(min2(w.leeVariance(u, f)/band, 1))
	// Toward the reach's end the lee gives way to the open sea's, with no
	// edge where the table's reach ends.
	fade := smooth(clamp(float64(2*min2(f/w.leeReach, 1))-1, 0, 1))
	return fw + float64((1-fw)*fade)
}

// LeeOf is the lee's fetch of a cell whose table is v for a wind from
// from, m, linear between the nearest directions, and whether it is all
// open water: for drawing and the developer's instruments.
func LeeOf(v []uint8, from float64) (float64, bool) {
	turns := float64(wrapAngle(from)*(ShelterDirections/(2*math.Pi))) + ShelterDirections
	k0 := math.Floor(turns)
	t := turns - k0
	k := toInt32(k0) % ShelterDirections
	f0, open0 := leeFetch(v[k*ShelterStride+2])
	f1, open1 := leeFetch(v[((k+1)%ShelterDirections)*ShelterStride+2])
	if open0 && open1 {
		return 0, true
	}
	if open0 {
		f0 = shelterLeeMost * ShelterLeeStep
	}
	if open1 {
		f1 = shelterLeeMost * ShelterLeeStep
	}
	return lerp(t, f0, f1), false
}
