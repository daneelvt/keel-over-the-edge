// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/lookout"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// The lookout report: what the boat's sailor sees and hears, in a
// sailor's words, in one fixed order of labelled lines, each left out when
// it has nothing to say. The clock comes first, with why the report was
// woken; then the boat, the wind, the autopilot, the sea, the weather,
// where the boat is, the gust coming, what is in sight, what is heard, and
// what happened since the last report. A brief report, the default, has
// the vital lines and what changed; a full one everything. The boat's
// line carries the water under it when that is shoal, sternway and a
// rudder with no steerage; the Shoal line tells where the shallows are, in
// the brief report while they are near. Format is
// presentation, never information: JSON gives the same facts, rounded the
// same.

// The details of a report.
const (
	detailBrief = "brief"
	detailFull  = "full"
)

// mostContacts is how many boats a report lists; the rest are summed.
const mostContacts = 12

// report is a lookout report's facts.
type report struct {
	Clock string `json:"clock"`
	Seq   int64  `json:"seq"`
	Woke  string `json:"woke,omitempty"`
	// Cut is how long the last wait ran, s, before the app cut its call;
	// Watched how many watch the boat.
	Cut     int           `json:"lastWaitCutAfter,omitempty"`
	Watched int           `json:"watchedBy,omitempty"`
	Notices []string      `json:"notices,omitempty"`
	Boat    *boatFacts    `json:"boat,omitempty"`
	Wind    *windFacts    `json:"wind,omitempty"`
	Shoal   *shoalFacts   `json:"shoal,omitempty"`
	Sky     *skyFacts     `json:"sky,omitempty"`
	Pilot   *pilotFacts   `json:"pilot,omitempty"`
	Sea     *seaFacts     `json:"sea,omitempty"`
	Weather *weatherFacts `json:"weather,omitempty"`
	Where   *whereFacts   `json:"where,omitempty"`
	Gust    []string      `json:"gust,omitempty"`
	InSight []string      `json:"inSight,omitempty"`
	More    string        `json:"more,omitempty"`
	Hear    []string      `json:"hear,omitempty"`
	Since   *sinceFacts   `json:"since,omitempty"`
	brief   bool
}

type boatFacts struct {
	Kind    string  `json:"kind"`
	State   string  `json:"state"`
	Heading int     `json:"heading"`
	Speed   float64 `json:"speedKnots"`
	// Astern says the boat makes sternway, NoSteerage that the water
	// passes its rudder too slowly to steer by; Depth is the water under
	// it while that is shoal, m.
	Astern     bool     `json:"astern,omitempty"`
	NoSteerage bool     `json:"noSteerage,omitempty"`
	Depth      *float64 `json:"depthM,omitempty"`
	Heel       int      `json:"heel"`
	HeelTo     string   `json:"heelTo,omitempty"`
	Tack       string   `json:"tack"`
}

type windFacts struct {
	From     int    `json:"from"`
	Point    string `json:"point"`
	Knots    int    `json:"knots"`
	Force    int    `json:"force"`
	OffBow   int    `json:"offTheBow"`
	Side     string `json:"side"`
	Apparent int    `json:"apparentKnots"`
	AppAngle int    `json:"apparentAngle"`
	// Lee is the point land lies to when the boat is in its lee, "".
	Lee string `json:"leeOfLandTo,omitempty"`
}

type pilotFacts struct {
	Holds  string `json:"holds"`
	Boom   int    `json:"boom"`
	Sheet  int    `json:"sheet"`
	Rudder int    `json:"rudder"`
	RudTo  string `json:"rudderTo,omitempty"`
	Sail   string `json:"sail"`
}

type seaFacts struct {
	Waves   float64 `json:"waves"`
	From    int     `json:"wavesFrom"`
	Swell   float64 `json:"swell,omitempty"`
	Period  int     `json:"swellPeriod,omitempty"`
	SwFrom  int     `json:"swellFrom,omitempty"`
	Current string  `json:"current"`
}

type weatherFacts struct {
	Barometer  string `json:"barometer"`
	Visibility string `json:"visibility"`
	Rain       string `json:"rain,omitempty"`
}

type whereFacts struct {
	Position string `json:"position"`
	// From is the start's harbour, its bearing from the boat and its
	// distance, as the chart's list gives them.
	From        string  `json:"from,omitempty"`
	FromBearing int     `json:"fromBearing,omitempty"`
	FromNM      float64 `json:"fromNM,omitempty"`
	Edge        float64 `json:"edgeNM"`
	Ends        string  `json:"fallsIn,omitempty"`
}

type sinceFacts struct {
	From   int64    `json:"from"`
	Events []string `json:"events"`
	Lost   int64    `json:"lostBefore,omitempty"`
}

// reportFor builds the report of the helm's boat in slot sl of f, with
// the events after since. With the helm's turn and mu held.
func (h *helm) reportFor(s *Sea, f *bus.Frame, sl int32, detail string, since int64) *report {
	st := &f.State[sl]
	in := &f.Instruments[sl]
	r := &report{brief: detail != detailFull}
	r.Clock = clockOf(s, f, st.X, st.Y)

	// The boat.
	b := &boatFacts{Kind: s.boat(f.Kind[sl]).Name, State: stateOf(f, sl), Heading: degrees(st.Heading),
		Speed: math.Floor(knots(float64(in.SpeedOverGround))*10+0.5) / 10, Heel: degrees(math.Abs(st.Heel))}
	if b.Heel > 0 {
		b.HeelTo = side(st.Heel)
	}
	b.Tack = ownTack(f, sl)
	if d := float64(in.Depth); d < shoalUnder {
		d = math.Floor(max(d, 0)*10+0.5) / 10
		b.Depth = &d
	}
	if st.SailorMode == physics.Sailing && !f.Voyage[sl].Falling() {
		ap := &s.boat(f.Kind[sl]).Physics.Autopilot
		ahead := waterAhead(st, &f.Wind[sl])
		b.Astern = ahead < -ap.Astern
		b.NoSteerage = math.Abs(ahead) < ap.Steerage
	}
	r.Boat = b

	// The wind, as the readout reads it: the wind the boat feels over 3 s,
	// its force from the mean wind.
	var wp physics.WindPoint
	physics.WindPointAt(s.weatherAt(f), st.X, st.Y, &wp, s.Shelter)
	from, speed := h.readout.From, h.readout.Speed
	if speed == 0 {
		from, speed = float64(in.WindFrom), float64(in.WindSpeed)
	}
	shown := lookout.WindOf(speed, from, wp.MeanSpeed)
	off := wrap(from - st.Heading)
	r.Wind = &windFacts{From: shown.Degrees, Point: shown.Point, Knots: shown.Knots, Force: shown.Force,
		OffBow: degrees(math.Abs(off)), Side: side(off), Apparent: knots0(float64(in.ApparentSpeed)),
		AppAngle: degrees(math.Abs(float64(in.ApparentAngle))), Lee: leeOf(s, st.X, st.Y, wp.MeanFrom)}

	// The shoal water about the boat: in the brief report while it is
	// near, or the boat is on it or aground.
	if sh := shoalAbout(s.Ground, st.X, st.Y); sh != nil && (!r.brief || sh.nearest <= shoalBrief || st.GroundTimer > 0) {
		r.Shoal = sh
	}

	// The autopilot or the hand on the tiller, and the sail.
	r.Pilot = pilotOf(f, sl)

	// The sky: in the brief report when its words change.
	if k := skyOf(s, f, st.X, st.Y); k != nil {
		if !r.brief || k.key != h.skyTold {
			r.Sky = k
		}
		h.skyTold = k.key
	}
	if s.Watchers != nil {
		r.Watched = s.Watchers(bus.Account(h.account))
	}

	// What happened since.
	evs, lost := h.ring.after(since)
	if len(evs) > 0 || lost > 0 {
		sf := &sinceFacts{From: since, Lost: lost}
		for _, e := range evs {
			sf.Events = append(sf.Events, e.Words)
		}
		r.Since = sf
	}
	r.Seq = max(h.ring.last(), since)

	// What is in sight.
	r.InSight, r.More = h.sightLines(s, f, sl, r.brief)

	// The boat's own sounds first: in the brief report when the loudest
	// changes.
	own := boatHeard(s, f, sl)
	loudest, _, _ := strings.Cut(own, ", ")
	if !r.brief || loudest != h.heardTold {
		r.Hear = []string{own}
	}
	h.heardTold = loudest
	if !r.brief {
		r.Sea = seaOf(s, f, st.X, st.Y)
		r.Weather = weatherOf(s, f, st.X, st.Y)
		r.Where = whereOf(s, f, st.X, st.Y)
		r.Where.from(s, st.X, st.Y)
		r.Hear = append(r.Hear, h.hearLines(s, f, sl)...)
	}
	r.Gust = h.gustLines(s, f, sl)
	return r
}

// clockOf is the report's clock: day or night at the boat, and the sky's
// hour at the centre of the disk, as the harbour's bells strike it.
func clockOf(s *Sea, f *bus.Frame, x, y float64) string {
	if s.Sky == nil {
		return "tick " + fmt.Sprint(f.Tick)
	}
	t := sky.Time(s.Sky, float64(s.Epoch.UnixMicro()), float64(int64(float64(f.Tick)*1e6/physics.StepsPerSecond)))
	day := s.Sky.Day()
	frac := math.Mod(math.Mod(t, day)+day, day) / day
	hour := math.Mod(frac*24+12, 24)
	h, m := int(hour), int(math.Mod(hour*60, 60))
	when := "night"
	if sky.SunAltitude(s.Sky, t, x, y) > 0 {
		when = "day"
	}
	return fmt.Sprintf("%s %02d:%02d", when, h, m)
}

// stateOf is what the boat is doing: sailing, in the water, aground,
// falling.
func stateOf(f *bus.Frame, sl int32) string {
	st := &f.State[sl]
	switch {
	case f.Voyage[sl].Falling():
		return "over the falls"
	case st.SailorMode == physics.InWater:
		return "capsized, your sailor in the water"
	case st.SailorMode == physics.OnBoard:
		return "capsized, your sailor righting her"
	case st.SailorMode == physics.Climbing:
		return "righted, your sailor climbing back in"
	case st.GroundTimer > 0:
		return "aground"
	}
	return "sailing"
}

// tackOf is a boat's tack, as the readout says it.
func tackOf(c *physics.Course) string {
	switch {
	case c.Tacking > 0:
		return "tacking"
	case c.Tack < 0:
		return "port tack"
	case c.Tack > 0:
		return "starboard tack"
	}
	return "head to wind"
}

// ownTack is the side the wind is over the boat in slot sl, as its sailor
// says it: the tack its Articles keep, or head to wind within headToWind
// of the mean wind. A turn under way is the autopilot's line's to tell.
func ownTack(f *bus.Frame, sl int32) string {
	if math.Abs(wrap(f.Wind[sl].MeanFrom-f.State[sl].Heading)) < headToWind {
		return "head to wind"
	}
	if f.Course[sl].Tack < 0 {
		return "port tack"
	}
	return "starboard tack"
}

// headToWind is how near the wind the Boat line says head to wind, rad.
const headToWind = 15 * math.Pi / 180

// pilotOf is what holds the boat's course, and its sail.
func pilotOf(f *bus.Frame, sl int32) *pilotFacts {
	st := &f.State[sl]
	pw := f.Pilot[sl]
	p := &pilotFacts{Boom: degrees(math.Abs(st.Boom)), Sheet: degrees(st.SheetLimit), Rudder: degrees(math.Abs(st.Rudder)), Sail: sailOf(f, sl)}
	if p.Rudder > 0 {
		p.RudTo = side(st.Rudder)
	}
	target := float64(pw.Target()) * 2 * math.Pi / physics.TurnSteps
	switch pw.Mode() {
	case bus.PilotWind:
		a := wrap(target)
		p.Holds = fmt.Sprintf("wind %d° %s", degrees(math.Abs(a)), side(a))
	case bus.PilotHeading:
		p.Holds = fmt.Sprintf("heading %s", three(degrees(target)))
	default:
		p.Holds = "hand"
	}
	switch uint8(st.PilotWay) {
	case physics.WayTack:
		p.Holds = "tacking to " + p.Holds
	case physics.WayGybe:
		p.Holds = "gybing to " + p.Holds
	}
	if s := stalled(st); s != "" && pw.Mode() != bus.PilotOff {
		p.Holds = s
	}
	return p
}

// sailOf is how the sail of the boat in slot sl draws. A machine boat's is
// its state as the phone's sheet shows it, held a moment so a gust's
// flutter is not told, with what to do: drawing; luffing: trim in;
// stalled: ease; or aback. Another's is its flow as the last step left
// it, from the sail byte, the foot's and the head's when they differ.
func sailOf(f *bus.Frame, sl int32) string {
	if f.Machine[sl] {
		return sailWords[f.Instruments[sl].Sail]
	}
	words := [...]string{physics.FlowLuffing: "luffing", physics.FlowAttached: "drawing", physics.FlowStalled: "stalled", physics.FlowAback: "aback"}
	b := f.Sail[sl]
	foot, head := (b>>4)&3, (b>>6)&3
	if foot == head {
		return words[foot]
	}
	return words[foot] + ", " + words[head] + " at the head"
}

// sailWords are a held sail state's words, by bus.Instruments.Sail.
var sailWords = [...]string{bus.SailDrawing: "drawing", bus.SailLuffing: "luffing: trim in", bus.SailStalled: "stalled: ease", bus.SailAback: "aback"}

// seaOf is the sea at the boat: its sea area's waves, swell and current.
func seaOf(s *Sea, f *bus.Frame, x, y float64) *seaFacts {
	col := min(max(physics.SeaAreaOf(x), 0), physics.SeaAreas-1)
	row := min(max(physics.SeaAreaOf(y), 0), physics.SeaAreas-1)
	if len(f.Sea.Now) == 0 {
		return nil
	}
	in := f.Sea.Now[row*physics.SeaAreas+col]
	out := &seaFacts{From: degrees(float64(in.From) * 2 * math.Pi / physics.SeaFromSteps)}
	if s.Waves != nil {
		win := physics.SeaWindow{Size: 1, Inputs: make([]physics.SeaInput, 1), Amp: make([]float64, physics.SeaComponents),
			Hs: make([]float64, 1), Peak: make([]float64, 1)}
		physics.SeaArea(s.Waves, &win, 0, in)
		out.Waves = math.Floor(win.Hs[0]*10+0.5) / 10
	}
	if in.SwellHeight > 0 {
		out.Swell = math.Floor(float64(in.SwellHeight)*physics.SeaSwellHeightStep*10+0.5) / 10
		out.Period = int(math.Floor(float64(in.SwellPeriod)*physics.SeaSwellPeriodStep + 0.5))
		out.SwFrom = degrees(float64(in.SwellFrom) * 2 * math.Pi / physics.SeaFromSteps)
	}
	ce, cn := float64(in.CurrentEast)*physics.SeaCurrentStep, float64(in.CurrentNorth)*physics.SeaCurrentStep
	c := math.Sqrt(ce*ce + cn*cn)
	switch {
	case knots(c) < 0.15:
		out.Current = "slack"
	default:
		out.Current = fmt.Sprintf("%.1f kn setting %s", knots(c), three(degrees(physics.Atan2(ce, cn))))
	}
	return out
}

// weatherOf is the weather at the boat: the barometer and its tendency
// over a quarter of an hour, as the phone's dial reads it; the
// visibility's word; and the rain. The clouds are the Sky line's.
func weatherOf(s *Sea, f *bus.Frame, x, y float64) *weatherFacts {
	wt := s.weatherAt(f)
	now := physics.PressureAt(wt, x, y)
	before := physics.PressureAt(s.weatherBefore(f, 5), x, y)
	quarter := physics.PressureAt(s.weatherBefore(f, 15), x, y)
	out := &weatherFacts{Barometer: weather.BarometerWords(now, before, quarter)}
	vis := physics.VisibilityAt(wt, x, y)
	out.Visibility = "visibility " + [...]string{"good", "moderate", "poor", "very poor"}[weather.VisibilityWord(vis, &s.Words)]
	if rain := physics.RainAt(wt, x, y); rain > 0.05 {
		out.Rain = rainWords(rain, s.RainWords)
	}
	return out
}

// rainWords is the rain at the boat in the forecast's words.
func rainWords(mm float64, words [3]float64) string {
	switch {
	case words[0] > 0 && mm < words[0]:
		return "light rain"
	case words[1] > 0 && mm < words[1]:
		return "moderate rain"
	case words[2] > 0 && mm < words[2]:
		return "heavy rain"
	}
	return "violent rain"
}

// whereOf is where the boat is: its position as the chart prints it, how
// far from the lip of the falls, and when the falls take the world.
func whereOf(s *Sea, f *bus.Frame, x, y float64) *whereFacts {
	out := &whereFacts{Position: chart.Format(x, y)}
	if p := s.Timeline.Prepared(); p != nil {
		out.Edge = math.Floor(physics.EdgeDistance(p, x, y)/nm*10+0.5) / 10
	}
	if end := s.ends(); !end.IsZero() {
		out.Ends = countdown(time.Until(end))
	}
	return out
}

// from adds the start's harbour to where the boat at (x, y) is, as the
// chart's list gives it, while it is charted.
func (w *whereFacts) from(s *Sea, x, y float64) {
	if s.Start == "" {
		return
	}
	e, ok := placeNamed(charted(s), s.Start)
	if !ok {
		return
	}
	dx, dy := e.sub.X-x, e.sub.Y-y
	d := math.Sqrt(dx*dx + dy*dy)
	w.From, w.FromBearing = titleOf(e.sub), degrees(physics.Atan2(dx, dy))
	w.FromNM = math.Floor(d/nm*10+0.5) / 10
}

// The water under a boat the Boat line tells, m: under this it is shoal.
const shoalUnder = 5.0

// waterAhead is the water's speed along the hull of a boat in state st,
// m/s, negative going astern: its speed ahead less the current's.
func waterAhead(st *physics.State, e *physics.Env) float64 {
	sin, cos := physics.SinCos(st.Heading)
	return st.Surge - (e.CurrentEast*sin + e.CurrentNorth*cos)
}

// The lee the Wind line tells: the wind at the boat under leeFactor of
// the wind beyond the land, with land within leeReach upwind.
const (
	leeFactor = 0.8
	leeReach  = 800.0 // m
	leeStep   = 16.0  // m
)

// leeOf is the point land lies to when (x, y) is in its lee of the wind
// from from, as flat water shows it: "NE"; "" when it is not.
func leeOf(s *Sea, x, y, from float64) string {
	if s.Shelter == nil || s.Ground == nil {
		return ""
	}
	if factor, _ := s.Shelter.At(x, y, from); !(factor < leeFactor) {
		return ""
	}
	sin, cos := physics.SinCos(from)
	for r := leeStep; r <= leeReach; r += leeStep {
		if e, _ := s.Ground.At(x+sin*r, y+cos*r); e > 0 {
			return point16(from)
		}
	}
	return ""
}

// sightLines are what the boat's lookout sees: the boats nearest first,
// the first mostContacts of them and the rest summed; then the land, the
// places and the lights, charted ones by name. A brief report gives of
// these only those new since the last report or within landNear, and
// counts the rest. With mu held.
func (h *helm) sightLines(s *Sea, f *bus.Frame, sl int32, brief bool) (lines []string, more string) {
	st := &f.State[sl]
	now := time.Now()
	seen := h.inSight(s, f, sl)
	marks := s.marks(f, sl, seen)
	inView := map[uint64]bool{}
	for i, c := range seen {
		boat := f.Boat[c.slot]
		inView[boat] = true
		n, ok := h.contacts[boat]
		if !ok {
			h.next++
			n = h.next
			h.contacts[boat] = n
		}
		if i >= mostContacts {
			continue
		}
		o := &f.State[c.slot]
		bear := physics.Atan2(o.X-st.X, o.Y-st.Y)
		kind := "human"
		if f.Machine[c.slot] {
			kind = "machine"
		}
		line := fmt.Sprintf("B%d %s · %s %s · %s, heading %s, %s", n, kind, three(bearing5(bear)), rangeWords(c.d),
			tackOf(&f.Course[c.slot]), three(bearing5(o.Heading)), speedWords(o))
		if t := h.drift(boat, bear, c.d, now); t != "" {
			line += " · " + t
		}
		if v := marks[c.slot]; v != "" {
			line += " · " + v
		}
		lines = append(lines, line)
	}
	// Numbers are kept while a boat is in view, and given up after.
	for boat := range h.contacts {
		if !inView[boat] && !h.inViewKept(f, sl, boat) {
			delete(h.contacts, boat)
			delete(h.tracks, boat)
		}
	}
	if len(seen) > mostContacts {
		more = fmt.Sprintf("and %d more boats", len(seen)-mostContacts)
		lines = append(lines, more)
	}
	land := s.landLines(f, sl)
	was := h.landSeen
	h.landSeen = map[int32]bool{}
	left := 0
	for _, l := range land {
		h.landSeen[l.subject] = true
		// The place the agent's wait watched is always told: it is what
		// the boat steers for.
		goal := h.hasGoal && l.subject == h.goal
		if brief && was[l.subject] && l.d > landNear && !goal {
			left++
			continue
		}
		lines = append(lines, l.text)
	}
	if left > 0 {
		lines = append(lines, fmt.Sprintf("and %d more in sight (full)", left))
	}
	return lines, more
}

// landNear is how near land, a place or a light in sight must be for a
// brief report to tell it again, m.
const landNear = nm / 2

// landLine is a line of land, a place or a light in sight, and its range,
// m.
type landLine struct {
	subject int32
	d       float64
	text    string
}

// inViewKept reports whether a boat is still within the view's keep, by
// its ID.
func (h *helm) inViewKept(f *bus.Frame, sl int32, boat uint64) bool {
	st := &f.State[sl]
	for _, o := range f.Live {
		if f.Boat[o] == boat {
			dx, dy := f.State[o].X-st.X, f.State[o].Y-st.Y
			return dx*dx+dy*dy <= 750*750
		}
	}
	return false
}

// speedWords is another boat's speed as seen: "stopped", "~5 kn".
func speedWords(o *physics.State) string {
	v := math.Sqrt(o.Surge*o.Surge + o.Sway*o.Sway)
	if knots(v) < 0.5 {
		return "stopped"
	}
	return fmt.Sprintf("~%d kn", knots0(v))
}

// sighting is a boat's bearing and range at a report.
type sighting struct {
	at   time.Time
	b, r float64
}

// drift is a boat's bearing and range since the last report within a
// minute: "bearing steady, closing", "drifting left, opening". A steady
// bearing while closing is a collision course (COLREG Rule 7). With mu
// held.
func (h *helm) drift(boat uint64, b, r float64, now time.Time) string {
	if h.tracks == nil {
		h.tracks = map[uint64]sighting{}
	}
	last, ok := h.tracks[boat]
	h.tracks[boat] = sighting{at: now, b: b, r: r}
	if !ok || now.Sub(last.at) > time.Minute || now.Sub(last.at) < time.Second {
		return ""
	}
	d := wrap(b - last.b)
	way := "bearing steady"
	switch {
	case d > steadyDrift:
		way = "drifting right"
	case d < -steadyDrift:
		way = "drifting left"
	}
	switch {
	case r < last.r-2:
		return way + ", closing"
	case r > last.r+2:
		return way + ", opening"
	}
	return way + ", range steady"
}

// landLines are the land, the places and the lights in sight, nearest
// first: charted ones by name, with their bearing and distance as the
// chart's list gives them and their credit; the rest by their look, by
// eye.
func (s *Sea) landLines(f *bus.Frame, sl int32) []landLine {
	seen := s.seenSubjects(f, sl)
	if len(seen) == 0 || s.Chart == nil {
		return nil
	}
	st := &f.State[sl]
	w := s.Chart.World()
	c := s.Chart.Load()
	// Surf breaks on the shores in a sea of surfFrom or more.
	surf := false
	if sea := seaOf(s, f, st.X, st.Y); sea != nil {
		surf = sea.Waves >= surfFrom
	}
	// The lights lit, by their lighthouse's subject: one unlit is seen by
	// its tower.
	lit := map[int32]bool{}
	if t := s.Sight.Table; t != nil {
		on, _ := s.lights(f)
		for i := range t.Lights() {
			_, _, sub := t.LightAt(i)
			lit[sub] = on[i]
		}
	}
	charted := map[int32]int{}
	for i, sub := range c.Subjects {
		charted[sub] = i
	}
	slices.SortFunc(seen, func(a, b sight.Seen) int {
		switch {
		case a.D2 < b.D2:
			return -1
		case a.D2 > b.D2:
			return 1
		}
		return int(a.Subject - b.Subject)
	})
	var out []landLine
	for _, x := range seen {
		if int(x.Subject) >= len(w.Subjects) {
			continue
		}
		sub := &w.Subjects[x.Subject]
		dx, dy := sub.X-st.X, sub.Y-st.Y
		d := math.Sqrt(dx*dx + dy*dy)
		bear := physics.Atan2(dx, dy)
		if i, ok := charted[x.Subject]; ok {
			line := fmt.Sprintf("%s · %s %s", sub.Name, three(degrees(bear)), chartDistance(d))
			if sub.Name == "" {
				line = fmt.Sprintf("%s · %s %s", sub.Title, three(degrees(bear)), chartDistance(d))
			}
			if l := s.lightOf(sub); l != "" {
				line += " · light " + l
			}
			if u := s.unchartedLand(sub); u != "" {
				line += " · " + u
			}
			out = append(out, landLine{x.Subject, d, line + " · " + creditWords(&c.Rows[i])})
			continue
		}
		out = append(out, landLine{x.Subject, d, s.lookOf(sub, surf && nearestOf(sub, st.X, st.Y) <= surfSeen, lit[x.Subject]) + " · " + three(bearing5(bear)) + " " + rangeWords(d)})
	}
	return out
}

// lightOf is a lighthouse's light as charts write it, "" for none.
func (s *Sea) lightOf(sub *chart.Subject) string {
	if sub.Light < 0 || s.Chart == nil {
		return ""
	}
	ls := s.Chart.World().Lights
	if sub.Light >= len(ls) {
		return ""
	}
	return ls[sub.Light].Notation
}

// The surf an uncharted island's line tells: the sea breaking on its
// shore, in a sea of surfFrom m or more, within surfSeen m of the boat,
// where the phone draws the shallows and their surf.
const (
	surfFrom = 0.5
	surfSeen = 400.0
)

// nearestOf is how far (x, y) is from a subject's bounds, m.
func nearestOf(sub *chart.Subject, x, y float64) float64 {
	dx := max(sub.Bounds[0]-x, 0, x-sub.Bounds[2])
	dy := max(sub.Bounds[1]-y, 0, y-sub.Bounds[3])
	return math.Sqrt(dx*dx + dy*dy)
}

// The island heights the look tells, m: under lowIsland it is low.
const lowIsland = 10.0

// lookOf is an uncharted subject as a lookout sees it: an island by its
// height, its trees and shore, its cliffs and the surf on it when surf,
// and its size; a lighthouse by its light while lit, else its tower; a
// place or a feature by its kind.
func (s *Sea) lookOf(sub *chart.Subject, surf, lit bool) string {
	switch sub.Kind {
	case sight.Island:
		across := max(sub.Bounds[2]-sub.Bounds[0], sub.Bounds[3]-sub.Bounds[1])
		look := []string{"low island"}
		if sub.Highest >= lowIsland {
			look[0] = fmt.Sprintf("island rising %d m", 5*int(math.Round(sub.Highest/5)))
		}
		if b := s.Bundle; b != nil {
			for i := range b.Islands {
				is := &b.Islands[i]
				if is.Number != sub.Number {
					continue
				}
				look = append(look, s.landWords(is.Biome)...)
				if is.Cliffs > 0.25 {
					look = append(look, "cliffs")
				}
			}
		}
		if surf {
			look = append(look, "surf")
		}
		return fmt.Sprintf("land (uncharted) · %s · %s across", strings.Join(look, ", "), rangeWords(across))
	case sight.Place:
		if l := s.lightOf(sub); l != "" && lit {
			return "a light " + l + " (uncharted)"
		} else if l != "" {
			return "a lighthouse tower (uncharted)"
		}
		if sub.Sort >= 0 && sub.Sort < len(s.PlaceKinds) {
			return article(s.PlaceKinds[sub.Sort]) + " (uncharted)"
		}
		return "a place (uncharted)"
	}
	if sub.Sort >= 0 && sub.Sort < len(s.FeatureKinds) {
		return article(s.FeatureKinds[sub.Sort]) + " (uncharted)"
	}
	return "something on the water (uncharted)"
}

// article is a noun with its article: "a lighthouse", "an anchorage".
func article(n string) string {
	if n == "" {
		return n
	}
	if strings.ContainsRune("aeiouAEIOU", rune(n[0])) {
		return "an " + strings.ToLower(n)
	}
	return "a " + strings.ToLower(n)
}

// chartDistance is a distance as the chart's list writes it: metres
// under a tenth of a mile, else miles to one decimal.
func chartDistance(m float64) string {
	if m < nm/10 {
		return fmt.Sprintf("%d m", int(math.Floor(m+0.5)))
	}
	return fmt.Sprintf("%.1f NM", m/nm)
}

// creditWords is who charted a place, as the chart credits it, the
// sailor's name marked as player-written: "charted by «Mira» (human),
// Tuesday".
func creditWords(r *store.Charting) string {
	if !r.Credited {
		return "known"
	}
	who := chart.Credit(r)
	day := r.At.UTC().Format("Monday")
	if r.Sailor == "" {
		return "charted by " + who + ", " + day
	}
	kind := "human"
	if r.AccountKind == string(store.AI) {
		kind = "machine"
	}
	return "charted by " + playerText(who) + " (" + kind + "), " + day
}

// text writes the report in its lines.
func (r *report) text() string {
	var b strings.Builder
	b.WriteString(r.Clock)
	fmt.Fprintf(&b, " · seq %d", r.Seq)
	if r.Woke != "" {
		b.WriteString(" · " + r.Woke)
	}
	if r.Watched > 0 {
		fmt.Fprintf(&b, " · watched by %d", r.Watched)
	}
	if r.Cut > 0 {
		fmt.Fprintf(&b, " · last wait cut after %d s; nothing lost", r.Cut)
	}
	b.WriteByte('\n')
	for _, n := range r.Notices {
		b.WriteString(n + "\n")
	}
	if bt := r.Boat; bt != nil {
		heel := fmt.Sprintf("heel %d°", bt.Heel)
		if bt.HeelTo != "" {
			heel += " to " + bt.HeelTo
		}
		speed := fmt.Sprintf("%.1f kn", bt.Speed)
		if bt.Astern {
			speed = "astern " + speed
		}
		if bt.NoSteerage {
			speed += " · no steerage"
		}
		if bt.Depth != nil {
			speed += fmt.Sprintf(" · %.1f m under you", *bt.Depth)
		}
		if r.brief {
			fmt.Fprintf(&b, "Boat: %s · heading %s · %s · %s · %s", bt.State, three(bt.Heading), speed, heel, bt.Tack)
		} else {
			fmt.Fprintf(&b, "Boat: %s · %s · heading %s · %s · %s · %s\n", bt.Kind, bt.State, three(bt.Heading), speed, heel, bt.Tack)
		}
	}
	if p := r.Pilot; p != nil {
		rud := ""
		if p.Holds == "hand" || !r.brief {
			rud = fmt.Sprintf(" · rudder %d°", p.Rudder)
			if p.RudTo != "" {
				rud += " to " + p.RudTo
			}
		}
		line := fmt.Sprintf("Pilot: %s · boom %d° (sheet out to %d°)%s · sail %s", p.Holds, p.Boom, p.Sheet, rud, p.Sail)
		if r.brief {
			b.WriteString(" · " + line + "\n")
		} else {
			b.WriteString(line + "\n")
		}
	}
	if w := r.Wind; w != nil {
		fmt.Fprintf(&b, "Wind: %s %s %d kn F%d · %d° off the bow, %s side · apparent %d kn %d°",
			three(w.From), w.Point, w.Knots, w.Force, w.OffBow, w.Side, w.Apparent, w.AppAngle)
		if w.Lee != "" {
			b.WriteString(" · in the lee of land to the " + w.Lee)
		}
		b.WriteByte('\n')
	}
	if s := r.Shoal; s != nil {
		b.WriteString("Shoal: " + s.text() + "\n")
	}
	if k := r.Sky; k != nil {
		b.WriteString("Sky: " + k.text() + "\n")
	}
	if s := r.Sea; s != nil {
		fmt.Fprintf(&b, "Sea: waves %.1f m from %s", s.Waves, three(s.From))
		if s.Swell > 0 {
			fmt.Fprintf(&b, " · swell %.1f m, %d s, from %s", s.Swell, s.Period, three(s.SwFrom))
		}
		b.WriteString(" · current " + s.Current + "\n")
	}
	if w := r.Weather; w != nil {
		parts := []string{w.Barometer, w.Visibility}
		if w.Rain != "" {
			parts = append(parts, w.Rain)
		}
		b.WriteString("Weather: " + strings.Join(parts, " · ") + "\n")
	}
	if w := r.Where; w != nil {
		fmt.Fprintf(&b, "Where: %s", w.Position)
		if w.From != "" {
			fmt.Fprintf(&b, " · %s %s %.1f NM", w.From, three(w.FromBearing), w.FromNM)
		}
		fmt.Fprintf(&b, " · edge %.1f NM", w.Edge)
		if w.Ends != "" {
			b.WriteString(" · the falls take this world in " + w.Ends)
		}
		b.WriteByte('\n')
	}
	for _, g := range r.Gust {
		b.WriteString("Gust: " + g + "\n")
	}
	if len(r.InSight) > 0 {
		b.WriteString("In sight:\n")
		for _, l := range r.InSight {
			b.WriteString(" " + l + "\n")
		}
	} else if !r.brief {
		b.WriteString("In sight: nothing\n")
	}
	if len(r.Hear) > 0 {
		b.WriteString("Hear: " + strings.Join(r.Hear, " · ") + "\n")
	}
	if s := r.Since; s != nil {
		if s.From > 0 {
			fmt.Fprintf(&b, "Since %d: ", s.From)
		} else {
			b.WriteString("Since: ")
		}
		if s.Lost > 0 {
			fmt.Fprintf(&b, "(events before tick %d were not kept) ", s.Lost)
		}
		b.WriteString(strings.Join(s.Events, " · ") + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// json writes the report's facts as compact JSON.
func (r *report) json() string {
	b, _ := json.Marshal(r)
	return string(b)
}

// landWords are an island's trees and shore as a lookout sees them, from
// its biome's surfaces and their plants: "wooded", "scrub" or "bare" by
// the canopy of its high ground; "palms" where palms grow on it;
// "beaches" or "mangroves" on its shore.
func (s *Sea) landWords(biome string) []string {
	cat := s.Catalog
	if cat == nil {
		return nil
	}
	var bm *catalog.Biome
	for i := range cat.World.Biomes {
		if string(cat.World.Biomes[i].ID) == biome {
			bm = &cat.World.Biomes[i]
		}
	}
	if bm == nil {
		return nil
	}
	surface := func(id catalog.ID) *catalog.Surface {
		for i := range cat.World.Surfaces {
			if cat.World.Surfaces[i].ID == id {
				return &cat.World.Surfaces[i]
			}
		}
		return nil
	}
	palm := func(sf *catalog.Surface) bool {
		for _, c := range sf.Cover {
			for _, k := range cat.World.Flora.Kinds {
				if k.ID == c.Plant && k.Form == catalog.FormPalm {
					return true
				}
			}
		}
		return false
	}
	var out []string
	high, low := surface(bm.Surfaces.High), surface(bm.Surfaces.Low)
	switch {
	case high == nil:
	case high.Canopy >= woodedFrom:
		out = append(out, "wooded")
	case high.Canopy > 0:
		out = append(out, "scrub")
	default:
		out = append(out, "bare")
	}
	if high != nil && palm(high) || low != nil && palm(low) {
		out = append(out, "palms")
	}
	if bm.Mangroves {
		out = append(out, "mangroves")
	}
	if bm.Beach > 0 {
		out = append(out, "beaches")
	}
	return out
}

// woodedFrom is the canopy, m, from which high ground is wooded.
const woodedFrom = 8.0
