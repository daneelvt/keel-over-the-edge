// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The words of the weather a place's box, its outlook, a harbourmaster's
// board and a gale warning give, in the Met Office's grammar: the
// shipping forecast's order of wind, weather and visibility, "Southwest 5
// to 7, occasionally gale 8 … Showers. Moderate or good"; its wind on an
// eight-point compass, a change within ±45° or a force being within the
// forecast's own precision (Galvin, Met Office, 2018); its times at the
// sky's pace, imminent within half an hour of the issue, soon within an
// hour, later beyond, the real six and twelve hours; the glossary's words
// for the barometer's tendency and a system's motion. They are made from
// the fields sampled at points and times, so the page writes the same from
// its module (client/src/chart/words.ts), held to testdata/words.json.

// What is near a point, within its size: bits of PlaceSample.Near.
const (
	NearShower = 1
	NearSquall = 2
	NearStorm  = 4
	NearFog    = 8
)

// The skies a box gives, mildest first.
var skies = []string{"fair", "showers", "fog patches", "rain", "squally showers", "squalls with heavy rain"}

// The sky's words, as indices into skies.
const (
	skyFair = iota
	skyShowers
	skyFog
	skyRain
	skySqually
	skySqualls
)

// knotMS is a knot, m/s.
const knotMS = 1852.0 / 3600

// forceFrom is the wind, in knots, each Beaufort force begins at (Met
// Office, Beaufort wind force scale), as the instruments read it.
var forceFrom = [...]int{0, 1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64}

// Words are what the words are made with: the catalog's thresholds.
type Words struct {
	// Visibility is very poor, poor and moderate under these, m.
	Visibility [3]float64 `json:"visibility"`
	// Violent is the rain heavier than which is violent, mm an hour.
	Violent float64 `json:"violent"`
	// Turn and Forces are a change in the outlook: a turn of the wind of
	// this many degrees or more, or a change of this many forces or more.
	Turn   float64 `json:"turn"`
	Forces int     `json:"forces"`
	// Imminent and Soon are the times' words, minutes after the issue.
	Imminent float64 `json:"imminent"`
	Soon     float64 `json:"soon"`
}

// WordsOf is the catalog's words.
func WordsOf(c *catalog.Catalog) Words {
	w := Words{Violent: c.Weather.Clouds.RainWords[2]}
	copy(w.Visibility[:], c.Weather.Visibility.Words)
	o := &c.Weather.Forecast.Outlook
	w.Turn, w.Forces, w.Imminent, w.Soon = o.Turn, o.Forces, o.Imminent, o.Soon
	return w
}

// PlaceSample is the weather at a point about a place, at a time: the mean
// wind, m/s, and the direction it comes from, rad; its typical strongest
// gust, m/s; the rain, mm an hour; the visibility, m; and what is near, a
// sum of the Near bits.
type PlaceSample struct {
	Mean       float64 `json:"mean"`
	From       float64 `json:"from"`
	Gust       float64 `json:"gust"`
	Rain       float64 `json:"rain"`
	Visibility float64 `json:"visibility"`
	Near       int     `json:"near"`
}

// PlaceWeather is a place's weather at a time: its points', the first its
// centre; the pressure at its centre then, 5 and 15 minutes before, hPa;
// and whether a storm's centre is within its size of the place.
type PlaceWeather struct {
	Points   []PlaceSample `json:"points"`
	Pressure float64       `json:"pressure"`
	Before   float64       `json:"before"`
	Quarter  float64       `json:"quarter"`
	Cyclonic bool          `json:"cyclonic"`
}

// Box is a place's box: its lines of wind, gusts, sky, visibility and
// barometer.
type Box struct {
	Wind       string `json:"wind"`
	Gusts      string `json:"gusts"`
	Sky        string `json:"sky"`
	Visibility string `json:"visibility"`
	Barometer  string `json:"barometer"`
}

// BoxOf is a place's box from its weather.
func BoxOf(w *PlaceWeather, words *Words) Box {
	if len(w.Points) == 0 {
		return Box{}
	}
	lo, hi := w.speeds()
	from := w.meanFrom()
	wind := fmt.Sprintf("%s %d kn", Point16(from), lo)
	if hi != lo {
		wind = fmt.Sprintf("%s %d–%d kn", Point16(from), lo, hi)
	}
	flo, fhi := ForceOf(float64(lo)*knotMS), ForceOf(float64(hi)*knotMS)
	if flo == fhi {
		wind += fmt.Sprintf(" · F%d", flo)
	} else {
		wind += fmt.Sprintf(" · F%d–%d", flo, fhi)
	}
	var gusts []float64
	for _, p := range w.Points {
		gusts = append(gusts, p.Gust)
	}
	b := Box{
		Wind:       wind,
		Gusts:      fmt.Sprintf("%d kn", wholeKnots(quantile(gusts, 0.8))),
		Sky:        capital(skies[w.sky(words)]),
		Visibility: capital(w.visibility(words)),
		Barometer:  BarometerWords(w.Pressure, w.Before, w.Quarter),
	}
	return b
}

// speeds is the mean wind's 25th and 80th percentiles over the points, in
// whole knots: the middle of the spread, not its extremes.
func (w *PlaceWeather) speeds() (lo, hi int) {
	var s []float64
	for _, p := range w.Points {
		s = append(s, p.Mean)
	}
	return wholeKnots(quantile(s, 0.25)), wholeKnots(quantile(s, 0.8))
}

// meanFrom is the direction the mean wind comes from over the points, the
// mean of their winds as vectors, rad.
func (w *PlaceWeather) meanFrom() float64 {
	var e, n float64
	for _, p := range w.Points {
		s, c := physics.SinCos(p.From)
		e += float64(p.Mean * s)
		n += float64(p.Mean * c)
	}
	if e == 0 && n == 0 {
		return w.Points[0].From
	}
	return physics.Atan2(e, n)
}

// sky is the worst of the points' skies, an index into skies.
func (w *PlaceWeather) sky(words *Words) int {
	worst := skyFair
	for _, p := range w.Points {
		worst = max(worst, skyAt(&p, words))
	}
	return worst
}

// skyAt is a point's sky: a shower near, fog very poor in a bank, rain not
// a shower's, a squall near, and its core's violent rain.
func skyAt(p *PlaceSample, words *Words) int {
	s := skyFair
	if p.Near&NearShower != 0 {
		s = skyShowers
	}
	if p.Near&NearFog != 0 && p.Visibility < words.Visibility[0] {
		s = max(s, skyFog)
	}
	if p.Rain >= 0.1 && p.Near&(NearShower|NearSquall) == 0 {
		s = max(s, skyRain)
	}
	if p.Near&NearSquall != 0 {
		s = max(s, skySqually)
		if p.Rain > words.Violent {
			s = skySqualls
		}
	}
	return s
}

// visibilityWords are the visibility's words, worst first, as
// VisibilityWord numbers them from good.
var visibilityWords = [...]string{"good", "moderate", "poor", "very poor"}

// VisibilityWord is the visibility's word for a range of m: 0 good, 1
// moderate, 2 poor, 3 very poor.
func VisibilityWord(v float64, words *Words) int {
	for i, under := range words.Visibility {
		if v < under {
			return 3 - i
		}
	}
	return 0
}

// visibility is the points' median's word, with the worst's in places
// where it differs: "moderate, poor in places".
func (w *PlaceWeather) visibility(words *Words) string {
	var v []float64
	worst := 0
	for _, p := range w.Points {
		v = append(v, p.Visibility)
		worst = max(worst, VisibilityWord(p.Visibility, words))
	}
	m := VisibilityWord(quantile(v, 0.5), words)
	if worst > m {
		return visibilityWords[m] + ", " + visibilityWords[worst] + " in places"
	}
	return visibilityWords[m]
}

// BarometerWords is the barometer's reading and its tendency, from the
// readings now, 5 and 15 minutes before: "1009 hPa, falling quickly".
func BarometerWords(now, before, quarter float64) string {
	words, turned := physics.Tendency(now, before, quarter)
	return fmt.Sprintf("%d hPa, %s", int(math.Floor(now+0.5)), TendencyWords(words, turned))
}

// tendencyAdverbs are the tendency's words, by its magnitude.
var tendencyAdverbs = [...]string{"", "slowly", "", "quickly", "very rapidly"}

// TendencyWords are the barometer's words for a tendency (Met Office,
// Marine forecasts glossary): "steady", "rising slowly", "falling very
// rapidly", "now rising" after a fall.
func TendencyWords(words int32, turned bool) string {
	if words == 0 {
		return "steady"
	}
	way := "rising"
	if words < 0 {
		way, words = "falling", -words
	}
	if turned {
		if way == "rising" {
			return "now falling"
		}
		return "now rising"
	}
	if a := tendencyAdverbs[min(words, 4)]; a != "" {
		return way + " " + a
	}
	return way
}

// ForceOf is the Beaufort force of a mean wind in m/s, by its whole knots
// as the scale's table has them.
func ForceOf(speed float64) int {
	k := wholeKnots(speed)
	f := 0
	for i, from := range forceFrom {
		if k >= from {
			f = i
		}
	}
	return f
}

// wholeKnots is a speed in m/s in whole knots, rounded half up.
func wholeKnots(speed float64) int { return int(math.Floor(max(speed, 0)/knotMS + 0.5)) }

// quantile is a's q-quantile, nearest rank from below: the value with the
// share q of the others below it.
func quantile(a []float64, q float64) float64 {
	if len(a) == 0 {
		return 0
	}
	s := slices.Clone(a)
	slices.Sort(s)
	i := int(math.Floor(float64(q*float64(len(s)-1)) + 0.5))
	return s[min(max(i, 0), len(s)-1)]
}

// capital is s with its first letter a capital.
func capital(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// The compass's points: the sixteen the instruments write, and the eight
// of the shipping forecast in its words.
var (
	points16 = [...]string{"N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"}
	points8  = [...]string{"north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"}
	// Where something lies from a place, as the warnings write it.
	where8 = [...]string{"north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"}
	// The winds' adjectives.
	winds8 = [...]string{"northerly", "northeasterly", "easterly", "southeasterly", "southerly", "southwesterly", "westerly", "northwesterly"}
)

// degreesOf is a direction in rad as degrees from 0 to 360.
func degreesOf(rad float64) float64 {
	d := math.Mod(rad*180/math.Pi, 360)
	if d < 0 {
		d += 360
	}
	return d
}

// Point16 is the nearest of the sixteen points to a direction in rad, as
// the instruments write it: "WSW".
func Point16(rad float64) string {
	d := math.Floor(degreesOf(rad) + 0.5) // whole degrees, as the instruments read them
	return points16[int(math.Floor((math.Mod(d, 360)+11.25)/22.5))%16]
}

// point8 is the nearest of the eight points to a direction in rad.
func point8(rad float64) int { return int(math.Floor((degreesOf(rad)+22.5)/45)) % 8 }

// forceWord is a force as the shipping forecast says it: "5", "gale 8",
// "severe gale 9", "storm 10", "violent storm 11", "hurricane force 12".
func forceWord(f int) string {
	switch {
	case f >= 12:
		return "hurricane force 12"
	case f == 11:
		return "violent storm 11"
	case f == 10:
		return "storm 10"
	case f == 9:
		return "severe gale 9"
	case f == 8:
		return "gale 8"
	}
	return fmt.Sprint(f)
}

// forcesWords are a range of forces: "4", "4 or 5" for neighbours, "4 to
// 6" wider, "6 to gale 8".
func forcesWords(lo, hi int) string {
	switch {
	case lo == hi:
		return forceWord(lo)
	case hi == lo+1:
		return forceWord(lo) + " or " + forceWord(hi)
	}
	return forceWord(lo) + " to " + forceWord(hi)
}

// whenWords is a time, minutes after the issue, in the scaled words.
func (w *Words) whenWords(at float64) string {
	switch {
	case at <= w.Imminent:
		return "imminent"
	case at <= w.Soon:
		return "soon"
	}
	return "later"
}

// OutlookSample is a place's weather at a time, minutes after the issue.
type OutlookSample struct {
	At float64 `json:"at"`
	PlaceWeather
}

// Outlook is a place's outlook from its samples: its wind, then up to two
// changes, each with its time, its weather and its visibility; and, if the
// falls take the world within the horizon, "then the falls". "Southwest 3
// to 5, veering northwest 6 imminent. Squally showers, then fair. Good,
// occasionally poor."
func Outlook(samples []OutlookSample, falls bool, words *Words) string {
	if len(samples) == 0 {
		return ""
	}
	type state struct {
		dir    int // of the eight points
		from   float64
		lo, hi int // forces
	}
	stateOf := func(s *OutlookSample) state {
		lo, hi := s.speeds()
		from := s.meanFrom()
		return state{dir: point8(from), from: from, lo: ForceOf(float64(lo) * knotMS), hi: ForceOf(float64(hi) * knotMS)}
	}
	first := stateOf(&samples[0])
	wind := capital(points8[first.dir]) + " " + forcesWords(first.lo, first.hi)
	last := first
	changes := 0
	cyclonic := samples[0].Cyclonic
	for i := 1; i < len(samples) && changes < 2; i++ {
		s := &samples[i]
		st := stateOf(s)
		turn := math.Remainder(st.from-last.from, 2*math.Pi) * 180 / math.Pi
		var change string
		switch {
		case s.Cyclonic && !cyclonic:
			change = "becoming cyclonic " + forcesWords(st.lo, st.hi)
		case math.Abs(turn) >= words.Turn:
			way := "veering"
			if turn < 0 {
				way = "backing"
			}
			change = way + " " + points8[st.dir] + " " + forcesWords(st.lo, st.hi)
		case st.hi-last.hi >= words.Forces:
			change = "increasing " + forcesWords(st.lo, st.hi)
		case last.hi-st.hi >= words.Forces:
			change = "decreasing " + forcesWords(st.lo, st.hi)
		default:
			continue
		}
		cyclonic = cyclonic || s.Cyclonic
		wind += ", " + change + " " + words.whenWords(s.At)
		last = st
		changes++
	}
	// The weather: each sample's sky, the same in a row said once.
	var seen []string
	for i := range samples {
		sk := skies[samples[i].sky(words)]
		if len(seen) == 0 || seen[len(seen)-1] != sk {
			seen = append(seen, sk)
		}
	}
	weather := capital(strings.Join(seen, ", then "))
	if falls {
		weather += ", then the falls"
	}
	// The visibility: most samples' word, occasionally a worse one for
	// fewer than half.
	count := [4]int{}
	for i := range samples {
		var v []float64
		for _, p := range samples[i].Points {
			v = append(v, p.Visibility)
		}
		count[VisibilityWord(quantile(v, 0.5), words)]++
	}
	usual := 0
	for i := range count {
		if count[i] > count[usual] {
			usual = i
		}
	}
	vis := capital(visibilityWords[usual])
	for i := len(count) - 1; i > usual; i-- {
		if count[i] > 0 {
			vis += ", occasionally " + visibilityWords[i]
			break
		}
	}
	return wind + ". " + weather + ". " + vis + "."
}

// Warning is a gale warning: the direction the gale first blows from,
// rad; its force, 8 to 12; when its first step is, minutes after the
// issue; and where, the compass point of its strongest from the nearest
// charted place, and the place's name.
type Warning struct {
	From       float64 `json:"from"`
	Force      int     `json:"force"`
	First      float64 `json:"first"`
	East       float64 `json:"east"`
	North      float64 `json:"north"`
	Place      string  `json:"place"`
	PlaceEast  float64 `json:"placeEast"`
	PlaceNorth float64 `json:"placeNorth"`
}

// expected is a time, minutes after the issue, as a gale warning words
// it: "imminent", "expected soon", "expected later".
func (w *Words) expected(at float64) string {
	if t := w.whenWords(at); t != "imminent" {
		return "expected " + t
	}
	return "imminent"
}

// WarningParts are a warning's wind ("southwesterly gale 8"), its time
// ("expected soon", "imminent") and where ("south-west of Gannet Holm").
func WarningParts(w *Warning, words *Words) (wind, when, where string) {
	wind = winds8[point8(w.From)] + " " + forceWord(max(w.Force, 8))
	when = words.expected(w.First)
	if w.Place == "" {
		where = "in the " + where8[point8(physics.Atan2(w.East, w.North))] + " outer waters"
		return wind, when, where
	}
	where = where8[point8(physics.Atan2(w.East-w.PlaceEast, w.North-w.PlaceNorth))] + " of " + w.Place
	return wind, when, where
}

// WarningText is a warning in a sentence, as the news and a box head it:
// "Southwesterly gale 8 expected soon, south-west of Gannet Holm".
func WarningText(w *Warning, words *Words) string {
	wind, when, where := WarningParts(w, words)
	return capital(wind) + " " + when + ", " + where
}

// SituationSystem is a low in the general situation: at the issue, or
// forming, born At minutes after it; its pressure at its centre, hPa;
// where it is, m east and north; the direction it moves toward, rad, and
// how fast, m/s.
type SituationSystem struct {
	Forming  bool    `json:"forming"`
	At       float64 `json:"at"`
	Pressure float64 `json:"pressure"`
	East     float64 `json:"east"`
	North    float64 `json:"north"`
	Heading  float64 `json:"heading"`
	Speed    float64 `json:"speed"`
}

// SituationFront is a front: the direction it comes from, rad, and when
// its line reaches the port, minutes after the issue; −1 if it does not
// within the horizon.
type SituationFront struct {
	From float64 `json:"from"`
	At   float64 `json:"at"`
}

// Situation is what the general situation tells: the port's name, the
// zones' reaches (m), the lows and fronts, and squalls from the windward
// rim from a direction, rad, if the regime makes them.
type Situation struct {
	Port    string            `json:"port"`
	Centre  float64           `json:"centre"`
	Middle  float64           `json:"middle"`
	Lows    []SituationSystem `json:"lows"`
	Fronts  []SituationFront  `json:"fronts"`
	Squalls bool              `json:"squalls"`
	From    float64           `json:"from"`
}

// area is where a point lies: "near Port Royal", "in the south-west middle
// waters", "in the north outer waters".
func (s *Situation) area(east, north float64) string {
	r := math.Sqrt(float64(east*east) + float64(north*north))
	if r <= s.Centre {
		return "near " + s.Port
	}
	zone := "outer"
	if r <= s.Middle {
		zone = "middle"
	}
	return "in the " + where8[point8(physics.Atan2(east, north))] + " " + zone + " waters"
}

// movingWords are how a system moves (Met Office, Marine forecasts
// glossary): "slowly" under 15 knots, "steadily" to 25, "rather quickly"
// to 35, "quickly" to 45, "very quickly" beyond.
func movingWords(heading, speed float64) string {
	k := speed / knotMS
	var how string
	switch {
	case k < 1:
		return "almost stationary"
	case k < 15:
		how = "slowly"
	case k < 25:
		how = "steadily"
	case k < 35:
		how = "rather quickly"
	case k < 45:
		how = "quickly"
	default:
		how = "very quickly"
	}
	return "moving " + points8[point8(heading)] + " " + how
}

// GeneralSituation is the situation's lines, as the inshore waters
// forecast gives its general situation: "Low 996 in the south-west outer
// waters, moving east slowly"; "New low expected soon in the north outer
// waters"; "Front coming from the west, expected at Port Royal soon";
// "Squalls from the west".
func GeneralSituation(s *Situation, words *Words) []string {
	var out []string
	for _, l := range s.Lows {
		if l.Forming {
			out = append(out, fmt.Sprintf("New low %s %s", words.expected(l.At), s.area(l.East, l.North)))
			continue
		}
		out = append(out, fmt.Sprintf("Low %d %s, %s", int(math.Floor(l.Pressure+0.5)), s.area(l.East, l.North), movingWords(l.Heading, l.Speed)))
	}
	for _, f := range s.Fronts {
		line := "Front coming from the " + points8[point8(f.From)]
		if f.At >= 0 {
			line += ", " + words.expected(f.At) + " at " + s.Port
		}
		out = append(out, line)
	}
	if s.Squalls {
		out = append(out, "Squalls from the "+points8[point8(s.From)])
	}
	if len(out) == 0 {
		out = append(out, "No systems expected")
	}
	return out
}
