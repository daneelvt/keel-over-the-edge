// SPDX-License-Identifier: AGPL-3.0-only

package status

import (
	"encoding/json"
	"math"
	"strconv"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// The weather as the chart shows it now, the whole disk's: its fields on
// a grid, sampled with the physics the chart's module runs (the client's
// chart/weather.ts, sampleGrid), its systems as the chart draws them
// (systemsOfKeys, systemWinds) and its fronts (frontsAt). A change to how
// the chart samples its scene changes this too.

// Weather is the weather now.
type Weather struct {
	// N is the grid's points a side. Its points are the centres of n × n
	// cells over the square about the disk, from −Lip to Lip each way,
	// rows from the north, east along a row.
	N int `json:"n"`
	// Mean is the mean wind, m/s to a half; From the way it blows from,
	// whole degrees clockwise from north; Gust its typical strongest gust,
	// m/s to a half; Rain the rain, mm an hour to a tenth: every point.
	Mean Field `json:"mean"`
	From Field `json:"from"`
	Gust Field `json:"gust"`
	Rain Field `json:"rain"`
	// Fog is the visibility the fog banks leave in clear air 2 m up, km
	// to a tenth, FogClear for anything clearer (the chart draws only
	// poorer); Pressure the pressure, hPa to a tenth; both null beyond the
	// lip.
	Fog      Field `json:"fog"`
	Pressure Field `json:"pressure"`
	// Systems are the systems alive, Fronts the fronts crossing the disk.
	Systems []System `json:"systems"`
	Fronts  []Front  `json:"fronts"`
}

// System is a weather system as the chart draws it: its symbol (the
// catalog's) and its name; where it is, m; the way it moves, rad clockwise
// from north, and how fast, m/s; its radius, a line's half its depth, m;
// its strength, 0 to about 1; a line's length across its motion and a
// low's ring of strongest wind's radius, m, left out for others; the
// strongest mean wind it blows and its typical strongest gust, m/s; and
// where it will be half an hour on, left out if it is gone by then.
type System struct {
	// slot, kind and seed say which system it is, to find it half an
	// hour on.
	slot, kind int
	seed       uint32
	Draw       string  `json:"draw"`
	Name       string  `json:"name"`
	East       float64 `json:"east"`
	North      float64 `json:"north"`
	Heading    float64 `json:"heading"`
	Speed      float64 `json:"speed"`
	Size       float64 `json:"size"`
	Strength   float64 `json:"strength"`
	Length     float64 `json:"length,omitempty"`
	Ring       float64 `json:"ring,omitempty"`
	Wind       float64 `json:"wind"`
	Gust       float64 `json:"gust"`
	Ahead      *Where  `json:"ahead,omitempty"`
}

// Where is a place, m east and north.
type Where struct {
	East  float64 `json:"east"`
	North float64 `json:"north"`
}

// Front is a front's line crossing the disk: the way it moves toward, as
// its sine and cosine (east and north); its line's distance from the
// centre that way, m; whether it is warm, its rain ahead of its line; and
// how fast it moves, m/s.
type Front struct {
	Sin   float64 `json:"sin"`
	Cos   float64 `json:"cos"`
	Line  float64 `json:"line"`
	Warm  bool    `json:"warm"`
	Speed float64 `json:"speed"`
}

// Field is a grid's values, written with Places decimals, NaN as null.
type Field struct {
	V      []float64
	Places int
	// Step, if not 0, rounds each value to it first.
	Step float64
}

// MarshalJSON writes the values as a JSON array.
func (f Field) MarshalJSON() ([]byte, error) {
	out := make([]byte, 0, 6*len(f.V)+2)
	out = append(out, '[')
	for i, v := range f.V {
		if i > 0 {
			out = append(out, ',')
		}
		switch {
		case math.IsNaN(v) || math.IsInf(v, 0):
			out = append(out, "null"...)
			continue
		case f.Step > 0:
			v = math.Round(v/f.Step) * f.Step
		}
		s := strconv.FormatFloat(v, 'f', f.Places, 64)
		if f.Places > 0 {
			// 7.0 as 7, and -0 as 0.
			for s[len(s)-1] == '0' {
				s = s[:len(s)-1]
			}
			s = trimDot(s)
		}
		if s == "-0" {
			s = "0"
		}
		out = append(out, s...)
	}
	return append(out, ']'), nil
}

// UnmarshalJSON reads the values back, null as NaN.
func (f *Field) UnmarshalJSON(b []byte) error {
	var vs []*float64
	if err := json.Unmarshal(b, &vs); err != nil {
		return err
	}
	f.V = make([]float64, len(vs))
	for i, v := range vs {
		f.V[i] = math.NaN()
		if v != nil {
			f.V[i] = *v
		}
	}
	return nil
}

func trimDot(s string) string {
	if s[len(s)-1] == '.' {
		return s[:len(s)-1]
	}
	return s
}

// FogClear is the visibility the map's fog is capped at, km: clearer than
// any the chart draws or names.
const FogClear = 5

// ahead is how far on a system's place ahead is told, ticks: half an hour.
const ahead = 30 * 60 * physics.StepsPerSecond

// sampleWeather is the weather at the frame's tick.
func sampleWeather(tl *weather.Timeline, cat *catalog.Catalog, fc *frameCopy) *Weather {
	p := tl.Prepared()
	w := &physics.Weather{Prepared: p}
	w.Set(fc.spells)
	w.SetComing(&fc.coming)
	w.SetKeys(fc.keys[:2])
	t := new(physics.WeatherTick)
	physics.WeatherAt(w, t, float64(fc.tick))

	n := GridSide
	lip := cat.World.Disk.Radius
	contrast := cat.Weather.Visibility.Contrast
	out := &Weather{N: n,
		Mean: Field{V: make([]float64, n*n), Places: 1, Step: 0.5}, From: Field{V: make([]float64, n*n)},
		Gust: Field{V: make([]float64, n*n), Places: 1, Step: 0.5}, Rain: Field{V: make([]float64, n*n), Places: 1},
		Fog: Field{V: make([]float64, n*n), Places: 1}, Pressure: Field{V: make([]float64, n*n), Places: 1},
		Systems: []System{}, Fronts: []Front{}}
	for j := range n {
		for i := range n {
			k := j*n + i
			x := ((float64(i)+0.5)/float64(n) - 0.5) * 2 * lip
			y := (0.5 - (float64(j)+0.5)/float64(n)) * 2 * lip
			mean, from, gust, _ := physics.TypicalAt(t, x, y)
			out.Mean.V[k], out.Gust.V[k] = mean, gust
			out.From.V[k] = math.Mod(math.Mod(from*180/math.Pi, 360)+360, 360)
			if math.Round(out.From.V[k]) == 360 {
				out.From.V[k] = 0
			}
			out.Rain.V[k] = physics.RainAt(t, x, y)
			if x*x+y*y > lip*lip {
				out.Fog.V[k], out.Pressure.V[k] = math.NaN(), math.NaN()
				continue
			}
			a := physics.AirAt(t, x, y, 2)
			out.Fog.V[k] = math.Min(contrast/math.Max(a.Clear+a.Fog, 1e-9)/1000, FogClear)
			out.Pressure.V[k] = physics.PressureAt(t, x, y)
		}
	}

	kinds := cat.Weather.Systems
	systems := systemsOfKeys(fc.keys[:2], float64(fc.tick), kinds)
	var later [bus.KeyFrames]physics.Keyframe
	tl.Keyframes(fc.tick+ahead, fc.systems, &later)
	then := systemsOfKeys(later[:2], float64(fc.tick+ahead), kinds)
	for i := range systems {
		s := &systems[i]
		s.Wind, s.Gust = systemWind(t, s)
		for _, o := range then {
			if o.slot == s.slot && o.seed == s.seed {
				s.Ahead = &Where{East: math.Round(o.East), North: math.Round(o.North)}
				break
			}
		}
		round(s)
	}
	out.Systems = append(out.Systems, systems...)
	reach := p.FrontReach()
	for _, s := range fc.spells {
		if s.Front == 0 || !(s.Change > 0) || float64(fc.tick) < s.Begin || float64(fc.tick) > s.Begin+s.Change {
			continue
		}
		a := s.Toward / physics.TurnSteps * 2 * math.Pi
		speed := 2 * reach / s.Change
		out.Fronts = append(out.Fronts, Front{
			Sin: round4(math.Sin(a)), Cos: round4(math.Cos(a)), Line: math.Round(speed*(float64(fc.tick)-s.Begin) - reach),
			Warm: s.Warm != 0, Speed: math.Round(speed*physics.StepsPerSecond*100) / 100,
		})
	}
	return out
}

func round4(v float64) float64 { return math.Round(v*1e4) / 1e4 }

// round rounds a system's values to what the map needs.
func round(s *System) {
	s.East, s.North = math.Round(s.East), math.Round(s.North)
	s.Heading, s.Strength = math.Round(s.Heading*1000)/1000, math.Round(s.Strength*100)/100
	s.Speed, s.Wind, s.Gust = math.Round(s.Speed*100)/100, math.Round(s.Wind*10)/10, math.Round(s.Gust*10)/10
	s.Size, s.Length, s.Ring = math.Round(s.Size), math.Round(s.Length), math.Round(s.Ring)
}

// placeOf is a keyframe's system as a place, its strength times weight.
func placeOf(s *physics.System, weight float64) System {
	return System{
		East: s.East / 4, North: s.North / 4,
		Heading: s.Heading / physics.TurnSteps * 2 * math.Pi, Speed: s.Speed * physics.SeaSpeedStep,
		Size: s.Size, Length: s.Length, Strength: s.Strength / 4096 * weight,
	}
}

// between is u of the way from a to b, the heading the shorter way round.
func between(a, b System, u float64) System {
	turn := math.Atan2(math.Sin(b.Heading-a.Heading), math.Cos(b.Heading-a.Heading))
	return System{
		East: a.East + u*(b.East-a.East), North: a.North + u*(b.North-a.North),
		Heading: a.Heading + u*turn, Speed: a.Speed + u*(b.Speed-a.Speed),
		Size: a.Size + u*(b.Size-a.Size), Length: a.Length + u*(b.Length-a.Length),
		Strength: a.Strength + u*(b.Strength-a.Strength),
	}
}

// sceneOf is the system of a slot as the chart draws it at a place.
func sceneOf(s *physics.System, slot int, at System, kinds []catalog.SystemKind) System {
	at.slot, at.kind, at.seed = slot, int(s.Kind), uint32(s.Seed)
	at.Draw = "calm"
	line, ring := false, 0.0
	if at.kind < len(kinds) {
		k := &kinds[at.kind]
		at.Draw, at.Name = string(k.Symbol), k.Name
		line = k.Shape == "line"
		if k.Shape == "low" {
			ring = k.Width
		}
	}
	if !line {
		at.Length = 0
	}
	at.Ring = ring * at.Size
	return at
}

// systemsOfKeys are the systems of the two keyframes about a tick,
// interpolated as the module does: the same system in both moves between
// its two places; one in only one fades in or out with the tick.
func systemsOfKeys(keys []physics.Keyframe, tick float64, kinds []catalog.SystemKind) []System {
	a, b := &keys[0], &keys[1]
	u := 0.0
	if b.Tick != a.Tick {
		u = math.Min(math.Max((tick-a.Tick)/(b.Tick-a.Tick), 0), 1)
	}
	var out []System
	for slot := range physics.MaxSystems {
		sa, sb := &a.Systems[slot], &b.Systems[slot]
		ona, onb := sa.On != 0, sb.On != 0
		switch {
		case ona && onb && sa.Kind == sb.Kind && sa.Seed == sb.Seed:
			out = append(out, sceneOf(sa, slot, between(placeOf(sa, 1), placeOf(sb, 1), u), kinds))
			continue
		}
		if ona && u < 1 {
			out = append(out, sceneOf(sa, slot, placeOf(sa, 1-u), kinds))
		}
		if onb && u > 0 {
			out = append(out, sceneOf(sb, slot, placeOf(sb, u), kinds))
		}
	}
	kept := out[:0]
	for _, s := range out {
		if s.Strength > 0.01 {
			kept = append(kept, s)
		}
	}
	return kept
}

// systemWind is the strongest mean wind and typical gust a system blows
// at the points the chart looks at: round a low's ring; along a line's
// leading edge and halfway to it; a cell's centre and its gust front
// ahead of it, and round it.
func systemWind(t *physics.WeatherTick, s *System) (wind, gust float64) {
	ux, uy := math.Sin(s.Heading), math.Cos(s.Heading)
	var pts [][2]float64
	switch {
	case s.Ring > 0:
		for i := range 8 {
			a := float64(i) * math.Pi / 4
			pts = append(pts, [2]float64{s.East + s.Ring*math.Sin(a), s.North + s.Ring*math.Cos(a)})
		}
	case s.Length > 0:
		for _, along := range []float64{-1.0 / 3, 0, 1.0 / 3} {
			for _, ah := range []float64{0.5, 1} {
				l, d := along*s.Length, ah*s.Size
				pts = append(pts, [2]float64{s.East + ux*d + uy*l, s.North + uy*d - ux*l})
			}
		}
	default:
		pts = append(pts, [2]float64{s.East, s.North})
		for _, d := range []float64{0.5, 1} {
			pts = append(pts, [2]float64{s.East + ux*d*s.Size, s.North + uy*d*s.Size})
		}
		for i := range 4 {
			a := s.Heading + math.Pi/4 + float64(i)*math.Pi/2
			pts = append(pts, [2]float64{s.East + 0.7*s.Size*math.Sin(a), s.North + 0.7*s.Size*math.Cos(a)})
		}
	}
	for _, p := range pts {
		m, _, g, _ := physics.TypicalAt(t, p[0], p[1])
		wind, gust = math.Max(wind, m), math.Max(gust, g)
	}
	return wind, math.Max(gust, wind)
}
