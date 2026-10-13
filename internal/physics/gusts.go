// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The gust field: patches of stronger and lighter wind carried downwind.
// Sailors find the water about half gust and half lull, gusts and lulls
// passing a point about once a minute, a gust's patch 100–200 m across the
// wind in a breeze, longer along it, and lasting two to four minutes on the
// water (Bethwaite, "Higher Performance Sailing", 2008, chapter 4).
//
// The field is gradient noise (Perlin, "Improving Noise", 2002) in three
// dimensions, along the wind, across it and in time, summed over three
// octaves whose cells halve in size and in life and whose weights halve.
// Each spell has its own field, seeded by the spell, in a frame that turns
// with the spell's direction and drifts downwind with the spell's wind as
// one body, so its position is a closed form of the tick.
//
// Every corner of the lattice is hashed by integer arithmetic, which wraps
// the same way in Go, in WebAssembly and on every GPU (WGSL, "modulo
// 2^bitwidth"; GLSL ES 3.00, 4.1.3), so the client draws on the water the
// field the boats feel.

// GustOctaves is how many octaves the field sums.
const GustOctaves = 3

// gustWeights are the octaves' weights.
var gustWeights = [GustOctaves]float64{1, 0.5, 0.25}

// The octaves' sum is divided by gustScale, its 99th percentile in
// magnitude, and clamped to ±1. gustMeanH is the mean of h(n), n above 0
// and n/2 below, over the field, so that a gust factor of
// 1 + (G − 1)(h(n) − gustMeanH) keeps the mean wind. Both are measured over
// the field by TestGustField.
const (
	gustScale = 0.7569
	gustMeanH = 0.0821
)

// The lattice's primes: a corner (i, j, k) is hashed as i, j and k times
// these, their bits mixed by exclusive or with the octave's seed.
const (
	gustPrimeI = 0x8da6b343
	gustPrimeJ = 0xd8163841
	gustPrimeK = 0xcb1ab31f
)

// gustCells are the field's octaves' cells, as reciprocals: along and
// across the wind in 1/m, and in time in 1/s.
type gustCells struct {
	invAlong, invAcross, invLife [GustOctaves]float64
}

func (g *gustCells) prepare(p *WeatherParams) {
	along, across, life := p.GustAlong, p.GustAcross, p.GustLife
	for k := range GustOctaves {
		g.invAlong[k] = 1 / along
		g.invAcross[k] = 1 / across
		g.invLife[k] = 1 / life
		along, across, life = float64(0.5*along), float64(0.5*across), float64(0.5*life)
	}
}

// field is the spell's gust field at (x, y), from −1 in the deepest lull
// to 1 in the strongest gust.
func (st *spellTick) field(g *gustCells, x, y float64) float64 {
	// The air moves toward the direction it comes from less half a turn:
	// along the unit vector −(sin θ, cos θ).
	along := -(float64(x*st.sinD) + float64(y*st.cosD)) - st.travel
	across := float64(x*st.cosD) - float64(y*st.sinD)
	sum := 0.0
	for k := range GustOctaves {
		n := noise3(float64(along*g.invAlong[k]), float64(across*g.invAcross[k]), st.time[k], st.s.seeds[k])
		sum += float64(gustWeights[k] * n)
	}
	return clamp(float64(sum*(1/gustScale)), -1, 1)
}

// GustCell is an octave's lattice cell of a point and the point's place in
// it, split so that a GPU, whose floats are 32 bits, can carry on from it:
// the whole cell exactly, the fraction small.
type GustCell struct {
	Cell int32
	Frac float64
}

// GustCellOf splits a coordinate in cells into its cell and fraction, as the
// field does.
func GustCellOf(u float64) GustCell {
	f := math.Floor(u)
	return GustCell{Cell: toInt32(f), Frac: u - f}
}

// noise3 is gradient noise at (u, v, w), in cells, with the gradients of
// Perlin's improved noise, his quintic fade, and corners hashed with seed.
func noise3(u, v, w float64, seed uint32) float64 {
	cu, cv, cw := GustCellOf(u), GustCellOf(v), GustCellOf(w)
	return noiseCell(uint32(cu.Cell), uint32(cv.Cell), uint32(cw.Cell), cu.Frac, cv.Frac, cw.Frac, seed)
}

// noiseCell is the noise in the cell (i, j, k), at the fraction (x, y, z)
// of the way across it.
func noiseCell(i, j, k uint32, x, y, z float64, seed uint32) float64 {
	hi0, hi1 := i*gustPrimeI, (i+1)*gustPrimeI
	hj0, hj1 := j*gustPrimeJ, (j+1)*gustPrimeJ
	hk0, hk1 := k*gustPrimeK^seed, (k+1)*gustPrimeK^seed
	x1, y1, z1 := x-1, y-1, z-1
	n000 := grad(hash32(hi0^hj0^hk0), x, y, z)
	n100 := grad(hash32(hi1^hj0^hk0), x1, y, z)
	n010 := grad(hash32(hi0^hj1^hk0), x, y1, z)
	n110 := grad(hash32(hi1^hj1^hk0), x1, y1, z)
	n001 := grad(hash32(hi0^hj0^hk1), x, y, z1)
	n101 := grad(hash32(hi1^hj0^hk1), x1, y, z1)
	n011 := grad(hash32(hi0^hj1^hk1), x, y1, z1)
	n111 := grad(hash32(hi1^hj1^hk1), x1, y1, z1)
	fx, fy, fz := fade(x), fade(y), fade(z)
	a := lerp(fy, lerp(fx, n000, n100), lerp(fx, n010, n110))
	b := lerp(fy, lerp(fx, n001, n101), lerp(fx, n011, n111))
	return lerp(fz, a, b)
}

// gradients are the twelve gradients of Perlin's improved noise, toward the
// middles of a cube's edges, as its sixteen choices: four of them twice.
var gradients = [16][3]float64{
	{1, 1, 0}, {-1, 1, 0}, {1, -1, 0}, {-1, -1, 0},
	{1, 0, 1}, {-1, 0, 1}, {1, 0, -1}, {-1, 0, -1},
	{0, 1, 1}, {0, -1, 1}, {0, 1, -1}, {0, -1, -1},
	{1, 1, 0}, {0, -1, 1}, {-1, 1, 0}, {0, -1, -1},
}

// grad is the dot product of (x, y, z) with the gradient the hash's low
// four bits choose. It is a sum of three products by −1, 0 or 1, with no
// branch on the hash, which no predictor could guess.
func grad(h uint32, x, y, z float64) float64 {
	g := &gradients[h&15]
	return float64(g[0]*x) + float64(g[1]*y) + float64(g[2]*z)
}

// fade is Perlin's quintic, 6t⁵ − 15t⁴ + 10t³: its first and second
// derivatives are 0 at both ends, so the field is smooth across cells.
func fade(t float64) float64 {
	a := float64(t*6) - 15
	b := float64(t*a) + 10
	return float64(float64(float64(t*t)*t) * b)
}

func lerp(t, a, b float64) float64 { return a + float64(t*(b-a)) }

// GustFrameAt fills f with the gust field's frame at the tick t was set to.
func GustFrameAt(t *WeatherTick, f *GustFrame) {
	*f = GustFrame{}
	field2 := 0.0
	for i := range t.n {
		if !t.at[i].s.steady {
			field2 += float64(t.weight[i] * t.weight[i])
		}
	}
	n := 0
	for i := range t.n {
		st := &t.at[i]
		e := st.s.excess
		if i == 0 {
			f.Excess = e
		} else {
			f.Excess += float64(t.weight[i] * (e - f.Excess))
		}
		if st.s.steady {
			continue
		}
		f.Share[n] = t.weight[i] / math.Sqrt(field2)
		f.Sin[n], f.Cos[n] = st.sinD, st.cosD
		f.Travel[n] = st.travel
		f.Seconds[n] = float64((t.Tick - st.s.start) * Dt)
		for k := range GustOctaves {
			f.Seed[n*GustOctaves+k] = float64(st.s.seeds[k])
		}
		n++
	}
	f.Spells = float64(n)
}
