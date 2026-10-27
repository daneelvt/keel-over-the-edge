// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"cmp"
	"context"
	"encoding/hex"
	"fmt"
	"math"
	"slices"
	"strings"
	"unicode"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// The tools that read the world rather than the boat: the chart, the
// forecast and the news, as every sailor's phone has them; the boat's
// fleet; and those whose features are still to come. None takes the boat
// to sea: an agent new to the game reads the chart or the handbook before
// it sails, and should not take a place at sea to do it.

// chartArgs are chart's.
type chartArgs struct {
	Group string `json:"group,omitempty"`
	Limit int    `json:"limit,omitempty"`
	Place string `json:"place,omitempty"`
}

// chartEntry is a charted subject: its index in the world, its row, and
// where it is.
type chartEntry struct {
	subject int32
	row     *store.Charting
	sub     *chart.Subject
}

// charted are the world's charted subjects.
func charted(s *Sea) []chartEntry {
	if s.Chart == nil {
		return nil
	}
	c := s.Chart.Load()
	w := s.Chart.World()
	out := make([]chartEntry, 0, len(c.Subjects))
	for i, sub := range c.Subjects {
		if int(sub) < len(w.Subjects) {
			out = append(out, chartEntry{subject: sub, row: &c.Rows[i], sub: &w.Subjects[sub]})
		}
	}
	return out
}

// titleOf is how the chart's list names a subject.
func titleOf(sub *chart.Subject) string {
	if sub.Name != "" {
		return sub.Name
	}
	return sub.Title
}

// chartList answers chart: the chart's list, nearest the boat first, by
// group, or one place by name. from is where the boat is; ok false for a
// boat not at sea, whose list has no bearings and is nearest the start.
func chartList(s *Sea, a *chartArgs, x, y float64, atSea bool) (string, *refusal) {
	entries := charted(s)
	if a.Place != "" {
		return chartPlace(s, entries, a.Place, x, y, atSea)
	}
	limit := 10
	if a.Limit > 0 {
		limit = min(a.Limit, 30)
	}
	want := map[string]uint8{"islands": sight.Island, "places": sight.Place, "features": sight.Feature}
	kind, filtered := want[a.Group]
	if a.Group != "" && a.Group != "all" && !filtered {
		return "", refuse(refusedArgs, "group is all, islands, places or features.")
	}
	list := make([]chart.ListEntry, len(entries))
	for i, e := range entries {
		list[i] = chart.ListEntry{Kind: e.sub.Kind, Title: titleOf(e.sub), East: e.sub.X, North: e.sub.Y}
	}
	var b strings.Builder
	if atSea {
		b.WriteString("The chart, nearest you first:\n")
	} else {
		b.WriteString("The chart, nearest the start first (you are not at sea, so no bearings):\n")
	}
	shown := 0
	for _, g := range chart.List(list, x, y) {
		if len(g.Lines) == 0 {
			continue
		}
		if filtered && entries[g.Lines[0].Entry].sub.Kind != kind {
			continue
		}
		n := min(len(g.Lines), limit)
		fmt.Fprintf(&b, "%s (%d charted):\n", g.Title, len(g.Lines))
		for _, l := range g.Lines[:n] {
			e := entries[l.Entry]
			where := l.Where
			if !atSea {
				where = chart.Format(e.sub.X, e.sub.Y)
			}
			fmt.Fprintf(&b, " %s · %s · %s\n", titleOf(e.sub), where, creditWords(e.row))
			shown++
		}
		if n < len(g.Lines) {
			fmt.Fprintf(&b, " and %d more: ask with group and a larger limit\n", len(g.Lines)-n)
		}
	}
	if shown == 0 {
		b.WriteString(" nothing charted yet: what your lookout sights is charted, and named, for everyone.\n")
	}
	b.WriteString("Race locations: none: races come with a later update. Pencil notes: not yet.")
	return b.String(), nil
}

// chartPlace answers chart for one place by name: a name not charted is
// told the nearest charted names it may mean, never an uncharted one.
func chartPlace(s *Sea, entries []chartEntry, name string, x, y float64, atSea bool) (string, *refusal) {
	e, ok := placeNamed(entries, name)
	if !ok {
		words := fmt.Sprintf("No charted place called %q.", name)
		if near := nearestNames(entries, name, x, y, atSea); near != "" {
			words += " Did you mean " + near + "?"
		}
		return "", refuse(refusedPlace, words+" Uncharted places have no names yet.")
	}
	var b strings.Builder
	b.WriteString(titleOf(e.sub))
	if e.sub.Title != "" && e.sub.Title != e.sub.Name {
		b.WriteString(" (" + e.sub.Title + ")")
	}
	b.WriteString(" · " + chart.Format(e.sub.X, e.sub.Y))
	if atSea {
		dx, dy := e.sub.X-x, e.sub.Y-y
		b.WriteString(" · " + chart.BearingText(physics.Atan2(dx, dy)) + " " + chart.DistanceText(math.Sqrt(dx*dx+dy*dy)) + " from you")
	}
	if l := s.lightOf(e.sub); l != "" {
		b.WriteString(" · light " + l)
	}
	b.WriteString(" · " + creditWords(e.row))
	return b.String(), nil
}

// fold is a name as names are matched: letters and digits, lower case.
func fold(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToLower(r)
		}
		return -1
	}, s)
}

// placeNamed is the charted place of a name, by its own name or its title.
func placeNamed(entries []chartEntry, name string) (chartEntry, bool) {
	want := fold(name)
	for _, e := range entries {
		if fold(e.sub.Name) == want && e.sub.Name != "" || fold(e.sub.Title) == want {
			return e, true
		}
	}
	return chartEntry{}, false
}

// nearestNames are up to two charted names nearest in spelling to name,
// with where they are from the boat.
func nearestNames(entries []chartEntry, name string, x, y float64, atSea bool) string {
	want := fold(name)
	type cand struct {
		d int
		e chartEntry
	}
	var best []cand
	for _, e := range entries {
		d := editDistance(want, fold(titleOf(e.sub)))
		if d > max(3, len(want)/3) {
			continue
		}
		best = append(best, cand{d, e})
	}
	if len(best) == 0 {
		return ""
	}
	for i := 1; i < len(best); i++ {
		for j := i; j > 0 && best[j].d < best[j-1].d; j-- {
			best[j], best[j-1] = best[j-1], best[j]
		}
	}
	var out []string
	for _, c := range best[:min(2, len(best))] {
		n := titleOf(c.e.sub)
		if atSea {
			dx, dy := c.e.sub.X-x, c.e.sub.Y-y
			n += " (" + chart.BearingText(physics.Atan2(dx, dy)) + " " + chart.DistanceText(math.Sqrt(dx*dx+dy*dy)) + ")"
		}
		out = append(out, n)
	}
	return strings.Join(out, " or ")
}

// editDistance is Levenshtein's distance between a and b.
func editDistance(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur := make([]int, len(rb)+1)
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev = cur
	}
	return prev[len(rb)]
}

// forecastArgs are forecast's.
type forecastArgs struct {
	Place string `json:"place,omitempty"`
}

// forecastAhead are the minutes from now the forecast tells where each
// system will be.
var forecastAhead = [...]int64{30, 60, 90}

// forecastWords answer forecast: the latest issue as the phone's chart
// shows it, the truth for the next 90 minutes: its gale warning in force,
// every system alive now or born within the horizon, where it is now and
// will be, and the fronts and when they reach the boat; or one charted
// place's box and outlook.
func forecastWords(s *Sea, f *bus.Frame, a *forecastArgs, x, y float64, atSea bool) (string, *refusal) {
	if s.Forecast == nil {
		return "No forecast is issued in this world.", nil
	}
	x0 := s.Forecast.Latest()
	if x0 == nil {
		return "The first forecast is not issued yet: ask again in a minute.", nil
	}
	tl := s.Timeline
	p := tl.Prepared()
	if a.Place != "" {
		e, ok := placeNamed(charted(s), a.Place)
		if !ok {
			words := fmt.Sprintf("No charted place called %q.", a.Place)
			if near := nearestNames(charted(s), a.Place, x, y, atSea); near != "" {
				words += " Did you mean " + near + "?"
			}
			return "", refuse(refusedPlace, words+" Only charted places have boxes on the chart.")
		}
		if s.Place == nil {
			return "No local weather is given in this world.", nil
		}
		var bounds *[4]float64
		if e.sub.Kind == sight.Island {
			bounds = &e.sub.Bounds
		}
		points := weather.PlacePoints(e.sub.X, e.sub.Y, bounds)
		box, outlook := s.Place.At(f.Tick, f.Weathers, f.Systems, &points, x0)
		return fmt.Sprintf("%s · %s\nWind: %s · %s\nSky: %s · visibility %s\nBarometer: %s\nOutlook: %s",
			titleOf(e.sub), issueWords(s, x0), box.Wind, box.Gusts, box.Sky, box.Visibility, box.Barometer, outlook), nil
	}
	var b strings.Builder
	b.WriteString("Forecast " + issueWords(s, x0) + ": the truth for the next 90 minutes, where every system and front will be. Gusts and the wind's shifts are not forecast.")
	if atSea {
		b.WriteString(" Bearings and distances are from you.")
	}
	b.WriteByte('\n')
	if g := x0.Gale; g != nil {
		w := weather.Warning{From: g.From, Force: int(g.Force), East: g.East, North: g.North,
			First: float64(int64(g.First)*p.ForecastStep()) / (60 * physics.StepsPerSecond)}
		if name, ex, ey, ok := s.placeOf(x0.Place); ok {
			w.Place, w.PlaceEast, w.PlaceNorth = name, ex, ey
		}
		b.WriteString("Gale warning: " + weather.WarningText(&w, &s.Words) + "\n")
	} else {
		b.WriteString("Gale warnings: none in force\n")
	}
	fc := &x0.Forecast
	minute := int64(60 * physics.StepsPerSecond)
	now := f.Tick
	until := now + p.ForecastHorizon()
	// The forecast's systems at each minute ahead it tells.
	var ahead [len(forecastAhead)]physics.Keyframe
	for i, m := range forecastAhead {
		physics.ForecastKeyframe(fc, float64(now+m*minute), &ahead[i])
	}
	weatherNow := s.weatherAt(f)
	var alive, later []forecastSystem
	origin := fc.Head.Origin
	for i := range int(fc.Head.NSystems) {
		r := &fc.Systems[i]
		slot := int(fc.Head.Slots[i])
		born, gone := int64(r.Born+origin), int64(r.Gone+origin)
		if gone <= now || born > until || slot < 0 || slot >= physics.MaxSystems {
			continue
		}
		w := forecastSystem{s: s, r: r, slot: slot, born: born, now: now, x: x, y: y, atSea: atSea}
		if born <= now {
			w.k = physics.SystemAt(r, float64(now)-origin)
			alive = append(alive, w)
		} else {
			w.k = physics.SystemAt(r, r.Born)
			later = append(later, w)
		}
	}
	// Each list by kind, the strongest first; those now nearest first, those
	// to come soonest first.
	list := func(head string, ws []forecastSystem, t *physics.WeatherTick) {
		slices.SortStableFunc(ws, func(a, c forecastSystem) int {
			if d := cmp.Compare(a.rank(), c.rank()); d != 0 {
				return d
			}
			if d := cmp.Compare(a.born, c.born); a.born > now && d != 0 {
				return d
			}
			return cmp.Compare(a.distance(), c.distance())
		})
		fmt.Fprintf(&b, "%s (%d):\n", head, len(ws))
		for _, w := range ws {
			b.WriteString(" " + w.words(t, &ahead) + "\n")
		}
	}
	if len(alive) == 0 {
		b.WriteString("Systems now: none\n")
	} else {
		list("Systems now, the strongest kinds first", alive, weatherNow)
	}
	if len(later) > 0 {
		list("Born in the next 90 minutes", later, nil)
	}
	fronts := frontsWords(s, fc, now, x, y, atSea)
	if len(fronts) == 0 {
		b.WriteString("Fronts: none crossing or coming")
	} else {
		b.WriteString("Fronts:\n " + strings.Join(fronts, "\n "))
	}
	return b.String(), nil
}

// forecastSystem is a system of the forecast as the forecast tool tells
// it: its record, its slot, the tick it is born at, and itself now or at
// its birth if later; the tick now; and where the boat is.
type forecastSystem struct {
	s         *Sea
	r         *physics.SystemRecord
	slot      int
	born, now int64
	k         physics.System
	x, y      float64
	atSea     bool
}

// rank is where a system's kind comes in the list: the week's storms, the
// lows, the lines, the cells, then those with no pressure of their own.
func (w *forecastSystem) rank() int {
	cfg := w.s.Timeline.Config()
	k := int(w.k.Kind)
	if k == cfg.Week.Storms {
		return 0
	}
	if k >= len(cfg.Kinds) {
		return 5
	}
	switch cfg.Kinds[k].Shape {
	case physics.ShapeLow:
		return 1
	case physics.ShapeLine:
		return 2
	case physics.ShapeDome:
		return 3
	}
	return 4
}

// distance is how far the system is from the boat, m.
func (w *forecastSystem) distance() float64 {
	return math.Hypot(w.k.East/4-w.x, w.k.North/4-w.y)
}

// words are a system's line: its kind's name, its wind and force now, of
// one alive with the weather now t, or when it is born, where it is, how
// it moves, and where it will be at each minute ahead the forecast tells:
// "Low · 36 kn, gusts 44 kn, F8 · 62°02′N 221°52′, 236° 2.6 NM · moving NW
// at 3 kn · 30 min: 267° 3.0 NM · 60 min: gone by then".
func (w *forecastSystem) words(t *physics.WeatherTick, ahead *[len(forecastAhead)]physics.Keyframe) string {
	s, k := w.s, &w.k
	kind := "A weather system"
	if i := int(k.Kind); i >= 0 && i < len(s.SystemKinds) {
		kind = s.SystemKinds[i]
	}
	line := kind
	if k.Length > 0 {
		line += ", " + chart.DistanceText(k.Length) + " long"
	}
	minute := int64(60 * physics.StepsPerSecond)
	east, north := k.East/4, k.North/4
	if w.born <= w.now {
		mean, gust := systemWind(s, k, t)
		line += fmt.Sprintf(" · %d kn, gusts %d kn, F%d · ", knots0(mean), knots0(gust), weather.ForceOf(mean))
	} else {
		line += fmt.Sprintf(" · born in %d min at ", (w.born-w.now+minute-1)/minute)
	}
	line += chart.Format(east, north)
	if w.atSea {
		line += ", " + w.from(east, north)
	}
	if speed := k.Speed * physics.SeaSpeedStep; knots(speed) >= 1 {
		line += fmt.Sprintf(" · moving %s at %d kn", point16(k.Heading*2*math.Pi/physics.TurnSteps), knots0(speed))
	} else {
		line += " · almost stationary"
	}
	for i, m := range forecastAhead {
		if w.now+m*minute < w.born {
			continue
		}
		a := &ahead[i].Systems[w.slot]
		if a.On == 0 || a.Seed != w.r.Seed {
			line += fmt.Sprintf(" · %d min: gone by then", m)
			break
		}
		where := chart.Format(a.East/4, a.North/4)
		if w.atSea {
			where = w.from(a.East/4, a.North/4)
		}
		line += fmt.Sprintf(" · %d min: %s", m, where)
	}
	return line
}

// from is a point's bearing and distance from the boat: "236° 2.6 NM".
func (w *forecastSystem) from(east, north float64) string {
	dx, dy := east-w.x, north-w.y
	return chart.BearingText(physics.Atan2(dx, dy)) + " " + chart.DistanceText(math.Sqrt(dx*dx+dy*dy))
}

// systemWind is a system's strongest mean wind and typical strongest gust
// on the water now, m/s, sought where it blows hardest, as the chart's
// label gives them: round a low's ring of strongest wind; along a line's
// leading edge and halfway to it; at a cell's centre, its gust front ahead
// of it, and round it.
func systemWind(s *Sea, k *physics.System, t *physics.WeatherTick) (mean, gust float64) {
	e, n := k.East/4, k.North/4
	ux, uy := physics.SinCos(k.Heading * 2 * math.Pi / physics.TurnSteps)
	var points [][2]float64
	ring := 0.0
	if kinds := s.Timeline.Config().Kinds; int(k.Kind) < len(kinds) && kinds[int(k.Kind)].Shape == physics.ShapeLow {
		ring = kinds[int(k.Kind)].Width * k.Size
	}
	switch {
	case ring > 0:
		for i := range 8 {
			sa, ca := physics.SinCos(float64(i) * math.Pi / 4)
			points = append(points, [2]float64{e + ring*sa, n + ring*ca})
		}
	case k.Length > 0:
		// Its length runs along (uy, −ux).
		for _, along := range []float64{-1.0 / 3, 0, 1.0 / 3} {
			for _, d := range []float64{0.5, 1} {
				l, ah := along*k.Length, d*k.Size
				points = append(points, [2]float64{e + ux*ah + uy*l, n + uy*ah - ux*l})
			}
		}
	default:
		points = append(points, [2]float64{e, n}, [2]float64{e + 0.5*ux*k.Size, n + 0.5*uy*k.Size}, [2]float64{e + ux*k.Size, n + uy*k.Size})
		for i := range 4 {
			sa, ca := physics.SinCos(k.Heading*2*math.Pi/physics.TurnSteps + math.Pi/4 + float64(i)*math.Pi/2)
			points = append(points, [2]float64{e + 0.7*k.Size*sa, n + 0.7*k.Size*ca})
		}
	}
	for _, pt := range points {
		m, _, g, _ := physics.TypicalAt(t, pt[0], pt[1])
		mean, gust = max(mean, m), max(gust, g)
	}
	return mean, max(gust, mean)
}

// frontsWords are the forecast's fronts crossing the disk now or coming
// within its reach, each as warm or cold, where it comes from and when its
// line reaches the boat, or the start for one not at sea.
func frontsWords(s *Sea, fc *physics.Forecast, now int64, x, y float64, atSea bool) []string {
	reach := s.Timeline.Prepared().FrontReach()
	whom := "you"
	if !atSea {
		whom = "the start"
		if s.Start != "" {
			whom = s.Start
		}
	}
	var out []string
	for i := range int(fc.Head.NSpells) {
		sp := &fc.Spells[i]
		if sp.Front == 0 || !(sp.Change > 0) || sp.Begin+sp.Change <= float64(now) {
			continue
		}
		toward := sp.Toward * 2 * math.Pi / physics.TurnSteps
		kind := "A cold front"
		if sp.Warm != 0 {
			kind = "A warm front"
		}
		line := kind + " from the " + point16(toward+math.Pi)
		// Its line crosses the reach at an even speed; it passes a point
		// when it is as far along the way it moves.
		ue, un := physics.SinCos(toward)
		at := sp.Begin + (x*ue+y*un+reach)*sp.Change/(2*reach)
		mins := int64(math.Round((at - float64(now)) / (60 * physics.StepsPerSecond)))
		switch {
		case float64(now) < sp.Begin:
			line += fmt.Sprintf(", coming onto the disk in %d min", int64(math.Ceil((sp.Begin-float64(now))/(60*physics.StepsPerSecond))))
		default:
			line += ", crossing the disk"
		}
		if mins > 0 {
			line += fmt.Sprintf(", reaching %s in %d min", whom, mins)
		} else {
			line += ", past " + whom
		}
		out = append(out, line)
	}
	return out
}

// issueWords are when an issue was made: "issued 3 minutes ago".
func issueWords(s *Sea, x *forecast.Issue) string {
	f := s.Bus.Frames.Acquire()
	now := f.Tick
	f.Release()
	mins := (now - x.Tick) / (60 * physics.StepsPerSecond)
	switch {
	case mins <= 0:
		return "issued just now"
	case mins == 1:
		return "issued a minute ago"
	}
	return fmt.Sprintf("issued %d minutes ago", mins)
}

// placeOf is the charted island or place a forecast names: its name and
// where it is.
func (s *Sea) placeOf(p forecast.Place) (string, float64, float64, bool) {
	if s.Chart == nil || p.Subject == pb.ChartSubject_CHART_SUBJECT_UNSPECIFIED {
		return "", 0, 0, false
	}
	kind := sight.Island
	if p.Subject == pb.ChartSubject_CHART_SUBJECT_PLACE {
		kind = sight.Place
	}
	w := s.Chart.World()
	i := w.Index(kind, int32(p.Number))
	if i < 0 {
		return "", 0, 0, false
	}
	sub := &w.Subjects[i]
	return titleOf(sub), sub.X, sub.Y, true
}

// newsArgs are news's.
type newsArgs struct {
	Before string `json:"before,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

// newsWords answer news: a page of the news sheet, newest first, each
// sailor's name marked as player-written and as a human's or a machine's.
func newsWords(ctx context.Context, s *Sea, a *newsArgs) (string, *refusal) {
	if s.News == nil {
		return "No news sheet is printed in this world.", nil
	}
	var before *[16]byte
	if a.Before != "" {
		var id [16]byte
		if b, err := hex.DecodeString(a.Before); err != nil || len(b) != 16 {
			return "", refuse(refusedArgs, "before is an item's id, as the last page gave it.")
		} else {
			copy(id[:], b)
		}
		before = &id
	}
	limit := 10
	if a.Limit > 0 {
		limit = min(a.Limit, 20)
	}
	items, err := s.News(ctx, before, limit)
	if err != nil {
		return "", refuse(refusedBusy, wordsBusy)
	}
	if len(items) == 0 {
		return "The news sheet has nothing yet.", nil
	}
	var b strings.Builder
	b.WriteString("The news, newest first:\n")
	for _, it := range items {
		col := s.Columns[it.Column]
		if col == "" {
			col = it.Column
		}
		by := ""
		switch {
		case it.Sailor != "":
			kind := "human"
			if it.AccountKind == string(store.AI) {
				kind = "machine"
			}
			by = " · by " + playerText(it.Sailor) + " (" + kind + ")"
		case it.Subject == store.SubjectWorld:
		case it.AccountKind != "":
			by = " · by " + chart.FormerSailor
		}
		fmt.Fprintf(&b, " %s · %s: %s, %s%s", it.At.UTC().Format("Monday 15:04 UTC"), col, it.Title, it.What, by)
		if len(it.Also) > 0 {
			var also []string
			for _, f := range it.Also {
				also = append(also, f.Title)
			}
			b.WriteString(" · also " + strings.Join(also, ", "))
		}
		b.WriteByte('\n')
	}
	if len(items) == limit {
		fmt.Fprintf(&b, "More: call news with before %s.", hex.EncodeToString(items[len(items)-1].ID[:]))
	}
	return strings.TrimRight(b.String(), "\n"), nil
}

// The tools still to come, each saying what it will do.
var notYet = map[string]string{
	toolSay:    "Not yet: chat comes with a later update. Then say speaks aboard, hails the boats close by, or speaks to your spectators.",
	toolRace:   "Not yet: races come with a later update. Then race lists the races, enters one, votes to start it, or retires.",
	toolPencil: "Not yet: pencil notes come with a later update. Then pencil writes a private note on your chart, or rubs one out.",
	toolBottle: "Not yet: messages in bottles come with a later update. Then bottle drops a message over the side for someone to find.",
}
