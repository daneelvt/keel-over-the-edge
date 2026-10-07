// SPDX-License-Identifier: AGPL-3.0-only

// Command testsea writes the developer test sea: for each of four sea
// states, 64 waves drawn from a JONSWAP spectrum, for the client to move its
// tiles with until the physics package's own boat band arrives.
//
//	go run ./tools/testsea          write client/src/ocean/testsea/*.json
//	go run ./tools/testsea -check   fail if the files differ from what it would write
//
// It runs from the repository root. The draws are seeded, and every number
// is written to nine significant figures, so the files are the same on every
// machine.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strconv"
)

const outDir = "client/src/ocean/testsea"

const (
	gravity    = 9.81 // m/s², as the physics package has it
	knot       = 1852.0 / 3600
	nauticalMi = 1852.0
	components = 64
	// The boat band holds waves longer than this, in metres: the ones the
	// 4 m tiles can carry.
	shortest = 8.0
	// The waves spread about the wind as cos²ˢ of half the angle off it.
	spread = 5
	// The wind blows from this bearing, clockwise from north, in degrees.
	windFrom = 240.0
	gamma    = 3.3 // JONSWAP's peak enhancement
)

// SeaState is a wind blowing over a fetch of open water.
type SeaState struct {
	Name      string
	WindKnots float64
	FetchNM   float64
	Seed      uint64
}

// The waves rendering's four sea states.
var states = []SeaState{
	{"calm", 6, 1.5, 1},
	{"breeze", 12, 4, 2},
	{"fresh", 20, 6.5, 3},
	{"gale", 34, 9, 4},
}

// Component is one wave: the direction it travels toward (a unit vector,
// east and north), its wavenumber in rad/m, amplitude in m, and phase at the
// disk's centre at world time 0.
type Component struct {
	East  num `json:"east"`
	North num `json:"north"`
	K     num `json:"k"`
	A     num `json:"a"`
	Phase num `json:"phase"`
}

// File is one sea state's fixture.
type File struct {
	Name      string  `json:"name"`
	WindKnots float64 `json:"windKnots"`
	FetchNM   float64 `json:"fetchNM"`
	WindFrom  float64 `json:"windFrom"`
	// The significant wave height of the whole spectrum, and of the band
	// drawn (its waves longer than 8 m), in m; the peak period in s.
	HsFull     num         `json:"hsFull"`
	HsBand     num         `json:"hsBand"`
	PeakPeriod num         `json:"peakPeriod"`
	Components []Component `json:"components"`
}

// num is written to nine significant figures.
type num float64

func (n num) MarshalJSON() ([]byte, error) {
	return []byte(strconv.FormatFloat(float64(n), 'g', 9, 64)), nil
}

func main() {
	check := flag.Bool("check", false, "fail if the files differ from what would be written")
	flag.Parse()
	var stale []string
	for _, s := range states {
		data, err := encode(Build(s))
		if err != nil {
			fail(err)
		}
		path := filepath.Join(outDir, s.Name+".json")
		old, err := os.ReadFile(path)
		if err == nil && bytes.Equal(old, data) {
			continue
		}
		if *check {
			stale = append(stale, path)
			continue
		}
		if err := os.MkdirAll(outDir, 0o755); err != nil {
			fail(err)
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			fail(err)
		}
		fmt.Println("wrote", path)
	}
	if len(stale) > 0 {
		fail(fmt.Errorf("out of date, run go run ./tools/testsea: %v", stale))
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "testsea:", err)
	os.Exit(1)
}

func encode(f File) ([]byte, error) {
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

// Spectrum is a JONSWAP spectrum for a wind and fetch (Hasselmann and
// others, 1973), with the fetch-limited α and peak frequency of the
// JONSWAP fits.
type Spectrum struct {
	Alpha, PeakOmega float64
}

// NewSpectrum is the spectrum of a wind of u m/s over a fetch of f m.
func NewSpectrum(u, f float64) Spectrum {
	x := gravity * f / (u * u)
	return Spectrum{
		Alpha:     0.076 * math.Pow(x, -0.22),
		PeakOmega: 22 * math.Cbrt(gravity*gravity/(u*f)),
	}
}

// S is the spectral density at angular frequency w, in m²·s.
func (s Spectrum) S(w float64) float64 {
	if w <= 0 {
		return 0
	}
	sigma := 0.07
	if w > s.PeakOmega {
		sigma = 0.09
	}
	d := (w - s.PeakOmega) / (sigma * s.PeakOmega)
	r := math.Exp(-d * d / 2)
	return s.Alpha * gravity * gravity * math.Pow(w, -5) *
		math.Exp(-1.25*math.Pow(s.PeakOmega/w, 4)) * math.Pow(gamma, r)
}

// M0 is the spectrum's integral from w0 to w1, in m².
func (s Spectrum) M0(w0, w1 float64) float64 {
	const n = 4000
	sum := 0.0
	d := (w1 - w0) / n
	for i := range n {
		sum += s.S(w0+(float64(i)+0.5)*d) * d
	}
	return sum
}

// Band is the range of angular frequencies drawn: from half the peak's
// (where the spectrum has almost nothing left) to that of the shortest wave
// the band holds.
func (s Spectrum) Band() (w0, w1 float64) {
	w1 = math.Sqrt(gravity * 2 * math.Pi / shortest)
	w0 = max(0.5*s.PeakOmega, 0.45)
	if w0 > 0.8*w1 {
		w0 = 0.5 * w1
	}
	return w0, w1
}

// Build draws a sea state's 64 components: frequencies spaced evenly in
// their logarithm with a random offset within each slot, each with the
// amplitude that carries its slot's energy, √(2 S(ω) Δω); directions drawn
// from the spread about the wind; phases uniform.
func Build(st SeaState) File {
	u := st.WindKnots * knot
	sp := NewSpectrum(u, st.FetchNM*nauticalMi)
	w0, w1 := sp.Band()
	rng := rand.New(rand.NewPCG(st.Seed, 0x6b65656c))
	toward := (windFrom + 180) * math.Pi / 180
	comps := make([]Component, components)
	for i := range comps {
		x := (float64(i) + rng.Float64()) / components
		w := w0 * math.Pow(w1/w0, x)
		dw := w * math.Log(w1/w0) / components
		th := toward + drawSpread(rng)
		comps[i] = Component{
			East:  num(math.Sin(th)),
			North: num(math.Cos(th)),
			K:     num(w * w / gravity),
			A:     num(math.Sqrt(2 * sp.S(w) * dw)),
			Phase: num(rng.Float64() * 2 * math.Pi),
		}
	}
	slices.SortStableFunc(comps, func(a, b Component) int {
		switch {
		case a.A > b.A:
			return -1
		case a.A < b.A:
			return 1
		}
		return 0
	})
	return File{
		Name:       st.Name,
		WindKnots:  st.WindKnots,
		FetchNM:    st.FetchNM,
		WindFrom:   windFrom,
		HsFull:     num(4 * math.Sqrt(sp.M0(0.05, 40))),
		HsBand:     num(4 * math.Sqrt(sp.M0(w0, w1))),
		PeakPeriod: num(2 * math.Pi / sp.PeakOmega),
		Components: comps,
	}
}

// drawSpread draws an angle off the wind from cos²ˢ(θ/2), by rejection.
func drawSpread(rng *rand.Rand) float64 {
	for {
		d := (rng.Float64()*2 - 1) * math.Pi
		if rng.Float64() < math.Pow(math.Cos(d/2), 2*spread) {
			return d
		}
	}
}
