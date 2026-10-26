// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"encoding/hex"
	"fmt"
	"math"
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
	Ahead *int   `json:"ahead,omitempty"`
}

// forecastWords answer forecast: the latest issue as the phone reads it,
// its gale warnings in force and its systems, or one charted place's box
// and outlook.
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
	ahead := 0
	if a.Ahead != nil {
		ahead = *a.Ahead
		if ahead != 0 && ahead != 30 && ahead != 60 && ahead != 90 {
			return "", refuse(refusedArgs, "ahead is 0, 30, 60 or 90: minutes after the issue.")
		}
	}
	var b strings.Builder
	b.WriteString("Forecast " + issueWords(s, x0) + "\n")
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
	step := fc.Head.Step
	k := 0
	if step > 0 {
		k = int(math.Round(float64(ahead) * 60 * physics.StepsPerSecond / step))
	}
	k = min(k, max(int(fc.Head.Steps)-1, 0))
	n := 0
	for i := range int(fc.Head.NSystems) {
		sy := &fc.Systems[i]
		if sy.Strength[k] <= 0 {
			continue
		}
		if n == 0 {
			if ahead > 0 {
				fmt.Fprintf(&b, "Systems %d minutes after the issue:\n", ahead)
			} else {
				b.WriteString("Systems:\n")
			}
		}
		n++
		b.WriteString(" " + systemWords(s, p, fc, sy, k, x, y, atSea) + "\n")
	}
	if n == 0 {
		b.WriteString("Systems: none forecast\n")
	}
	b.WriteString("The forecast is every sailor's: the truth ahead may differ.")
	return b.String(), nil
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

// systemWords are a system on the forecast at step k: what it is, where,
// how far off and which way it moves, and the cone it may be within.
func systemWords(s *Sea, p *physics.WeatherPrepared, fc *physics.Forecast, sy *physics.ForecastSystem, k int, x, y float64, atSea bool) string {
	kind := "a weather system"
	if i := int(sy.Kind); i >= 0 && i < len(s.SystemKinds) {
		kind = s.SystemKinds[i]
	}
	east, north := sy.East[k], sy.North[k]
	line := kind
	if sy.Forming > 0 {
		line = "forming: " + kind
	}
	line += " · " + chart.Format(east, north)
	if atSea {
		dx, dy := east-x, north-y
		line += " · " + chart.BearingText(physics.Atan2(dx, dy)) + " " + chart.DistanceText(math.Sqrt(dx*dx+dy*dy)) + " from you"
	}
	speed := sy.Speed[k] * physics.SeaSpeedStep
	if knots(speed) >= 1 {
		heading := sy.Heading[k] * 2 * math.Pi / physics.TurnSteps
		line += fmt.Sprintf(" · moving %s at %d kn", point16(heading), knots0(speed))
	} else {
		line += " · almost stationary"
	}
	if cone := physics.ForecastCone(p, fc, sy, int32(k)); cone > 0 {
		line += " · within " + chart.DistanceText(cone) + " of that"
	}
	return line
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
