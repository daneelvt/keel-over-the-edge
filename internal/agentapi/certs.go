// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/certs"
	"github.com/daneelvt/keel-over-the-edge/internal/race"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Certificates as a machine sailor is told them: in observe's events as a
// task is done and a certificate earned, in news with log as where it
// stands, on going to sea as a line, in race's list as what a trial
// counts toward, and in the handbook as the whole ladder, written from
// the catalog: each certificate's boats and tasks, and how each task is
// done, in the lines a person reads in the log. The tools are the same;
// only their words grow.

// wayWords are how a task counted, in words; "" for the log's.
func wayWords(way uint8) string {
	switch way {
	case bus.CertHand:
		return "by hand"
	case bus.CertPilot:
		return "the autopilot way"
	}
	return ""
}

// certifiedWords are an event of a sailor's certificates: "Toward Helm:
// The Triangle, bronze ✓ by hand · 3 of 4"; a run nearer a venture,
// "Toward Helm: The Triangle, bronze, the autopilot way · 1 of 2 runs";
// and "You earned Helm, by hand: the beach cat is yours to take."
func certifiedWords(cat *catalog.Catalog, c *bus.Certified) string {
	if cat == nil || int(c.Certificate) < 0 || int(c.Certificate) >= len(cat.Certificates) {
		return "a certificate's task done"
	}
	ct := &cat.Certificates[c.Certificate]
	var parts []string
	t := int(c.Task)
	switch {
	case t >= 0 && t < len(ct.Tasks) && c.RunsOf > 0:
		parts = append(parts, fmt.Sprintf("Toward %s: %s, the autopilot way · %d of %d runs", ct.Name, ct.Tasks[t].Name, c.Runs, c.RunsOf))
	case t >= 0 && t < len(ct.Tasks):
		task := ct.Tasks[t].Name + " ✓"
		if w := wayWords(c.Way); w != "" {
			task += " " + w
		}
		parts = append(parts, fmt.Sprintf("Toward %s: %s · %d of %d", ct.Name, task, c.Done, c.Of))
	}
	if c.Earned {
		earned := "You earned " + ct.Name
		if c.ByHand {
			earned += ", by hand"
		}
		if boats := opensWords(cat, ct); boats != "" {
			earned += ": " + boats + " yours to take (boat take)"
		}
		parts = append(parts, earned)
	}
	return strings.Join(parts, ". ")
}

// opensWords are the boats a certificate opens: "the skiff and the
// keelboat are", "the beach cat is"; "" for none.
func opensWords(cat *catalog.Catalog, ct *catalog.Certificate) string {
	var names []string
	for _, id := range ct.Opens {
		for i := range cat.Boats {
			if cat.Boats[i].ID == id {
				names = append(names, "the "+strings.ToLower(cat.Boats[i].Name))
			}
		}
	}
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0] + " is"
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1] + " are"
}

// standingOf is where a machine sailor stands toward its next certificate;
// false without the certificates.
func standingOf(ctx context.Context, s *Sea, account store.AccountID) (certs.Standing, bool) {
	if s.Certificates == nil {
		return certs.Standing{}, false
	}
	st, err := s.Certificates(ctx, account)
	if err != nil || st.Held < 0 && st.Next < 0 {
		return certs.Standing{}, false
	}
	return st, true
}

// towardLine is the line going to sea tells of a sailor's next
// certificate: "Toward Helm: 2 of the 4 tasks it needs (news with log
// lists them)."; "" for none.
func towardLine(ctx context.Context, s *Sea, account store.AccountID) string {
	st, ok := standingOf(ctx, s, account)
	if !ok || st.Next < 0 {
		return ""
	}
	return fmt.Sprintf("Toward %s: %d of the %d tasks it needs (news with log lists them).", st.Name, min(st.Done, st.Needs), st.Needs)
}

// smallCounts are small counts in words.
var smallCounts = [...]string{"no", "one", "two", "three", "four", "five", "six"}

func countWord(n int) string {
	if n >= 0 && n < len(smallCounts) {
		return smallCounts[n]
	}
	return fmt.Sprint(n)
}

// timesWords are how often, in words: "twice", "three times".
func timesWords(n int) string {
	switch n {
	case 1:
		return "once"
	case 2:
		return "twice"
	}
	return countWord(n) + " times"
}

// courseNames are the kinds of course, as a line names them.
var courseNames = map[catalog.CertificateCourse]string{
	catalog.CertificateCourseReach:        "the Reach",
	catalog.CertificateCourseShort:        "the Short Course",
	catalog.CertificateCourseLong:         "the Long Course",
	catalog.CertificateCourseTriangle:     "the Triangle",
	catalog.CertificateCourseLongTriangle: "the Long Triangle",
	catalog.CertificateCourseIsland:       "an island course",
}

// buoyCourses are the kinds of buoy course with a beat in them: a task
// open to all of them is open to "any buoy course but the Reach", and
// with the reach too to "any buoy course". Either names them, so nobody
// has to guess which they are.
var buoyCourses = []catalog.CertificateCourse{catalog.CertificateCourseShort, catalog.CertificateCourseLong,
	catalog.CertificateCourseTriangle, catalog.CertificateCourseLongTriangle}

// taskCourses are a task's courses in words: "the Triangle", "the
// Triangle and the Long Course", "any buoy course but the Reach (the
// Short Course, the Long Course, the Triangle or the Long Triangle)".
func taskCourses(courses []catalog.CertificateCourse, each bool) string {
	names := make([]string, len(courses))
	for i, c := range courses {
		if names[i] = courseNames[c]; names[i] == "" {
			names[i] = "a " + string(c) + " course"
		}
	}
	list := ""
	switch len(names) {
	case 0:
		return "a course"
	case 1:
		return names[0]
	default:
		join := " or "
		if each {
			join = " and "
		}
		list = strings.Join(names[:len(names)-1], ", ") + join + names[len(names)-1]
	}
	beats := !slices.ContainsFunc(buoyCourses, func(b catalog.CertificateCourse) bool { return !slices.Contains(courses, b) })
	reach := slices.Contains(courses, catalog.CertificateCourseReach)
	switch {
	case beats && reach && len(courses) == len(buoyCourses)+1:
		return "any buoy course (" + list + ")"
	case beats && len(courses) == len(buoyCourses):
		return "any buoy course but the Reach (" + list + ")"
	}
	return list
}

// reachHow is how the reach is sailed, for a task that is sailed on it
// alone.
const reachHow = "Sail across the wind to the mark, go round it, and sail back. No tacking up the wind."

// medalWords are what a run must come to: "finish", "bronze or better".
func medalWords(m catalog.Medal) string {
	if m == catalog.MedalFinish {
		return "finish"
	}
	return string(m) + " or better"
}

// courseHowTo is a course's task in a line: where, alone, and its two
// ways.
func courseHowTo(t *catalog.CertificateTask) string {
	each := t.Hand != nil && t.Hand.Each != nil && *t.Hand.Each && len(t.Courses) > 1
	out := []string{"A time trial on " + taskCourses(t.Courses, each) + ", sailed alone."}
	if len(t.Courses) == 1 && t.Courses[0] == catalog.CertificateCourseReach {
		out = append(out, reachHow)
	}
	if t.Hand != nil {
		on := ""
		if each {
			on = " on each"
			if len(t.Courses) == 2 {
				on = " on both"
			}
		}
		if t.Hand.Medal == catalog.MedalFinish {
			out = append(out, "By hand: just finish"+on+".")
		} else {
			out = append(out, "By hand: "+medalWords(t.Hand.Medal)+on+".")
		}
	}
	if v := t.Venture; v != nil {
		n := 1
		if v.Runs != nil {
			n = max(*v.Runs, 1)
		}
		what := medalWords(v.Medal)
		switch {
		case v.Apart != nil && *v.Apart && n > 1:
			out = append(out, "With the autopilot: "+what+" on "+countWord(n)+" different courses.")
		default:
			sep, all := ", ", ""
			if v.Medal == catalog.MedalFinish {
				sep = " "
			}
			if each {
				all = " in all"
			}
			out = append(out, "With the autopilot: "+what+sep+timesWords(n)+all+".")
		}
	}
	return strings.Join(out, " ")
}

// howTo is how a task is done, in a plain line, by its measure or its
// courses and with its own numbers: the line a person reads under the
// task in the log (the page's certtasks.ts; one file of both's lines
// holds them the same). "" for a measure it has no words for. Each says
// what the judge counts, no more: a night is half an hour under way after
// dark, a gale counts once it is ridden out, a place seen is one charted
// or the charted place nearest where a voyage ended or life was met.
func howTo(t *catalog.CertificateTask) string {
	if len(t.Courses) > 0 {
		return courseHowTo(t)
	}
	if t.Measure == nil {
		return ""
	}
	n := 1
	if t.At != nil {
		n = int(*t.At)
	}
	switch *t.Measure {
	case catalog.MeasureDistance:
		return "Your miles sailed alone are added each time a voyage ends."
	case catalog.MeasurePlacesSeen:
		return "Chart a place, or end a voyage or meet a creature near one. Each place counts once."
	case catalog.MeasurePlacesCharted:
		if n == 1 {
			return "Be the first to sight a place nobody has charted yet."
		}
		return "Be the first to sight " + countWord(n) + " places nobody has charted yet."
	case catalog.MeasureLifeKinds:
		if n == 1 {
			return "Seabirds, dolphins, turtles, whales: any creature you meet while sailing alone counts."
		}
		return "Seabirds, dolphins, turtles, whales: meet " + countWord(n) + " different kinds while sailing alone."
	case catalog.MeasureNights:
		if n == 1 {
			return "Sail for half an hour after dark, in one voyage."
		}
		return "Sail for half an hour after dark, on " + countWord(n) + " voyages."
	case catalog.MeasureGales:
		return "Find a gale on the weather chart and sail in it for ten minutes. It counts once the wind eases, or you make port. A capsize doesn’t undo it."
	case catalog.MeasureStormsOrFogs:
		return "Sail in a storm until the wind eases or you make port, or sail into a port in fog."
	case catalog.MeasureLip:
		return "Sail to within " + thousands(n) + " m of the world’s edge and come back without going over."
	case catalog.MeasureFalls:
		return "Sail right off the edge of the world. Yes, really."
	case catalog.MeasureWorlds:
		return "Sail in " + countWord(n) + " different worlds. A new world begins every week."
	case catalog.MeasureEveryWeather:
		return "Sail in a gale and in a storm, sail into a port in fog, and sail half an hour after dark."
	}
	return ""
}

// thousands is a count with its thousands apart: "1,200".
func thousands(n int) string {
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// everyWeatherWords are the four kinds of weather every weather asks, by
// the log's flags, each in a word.
var everyWeatherWords = [...]struct {
	bit  int
	word string
}{{store.LogMetGale, "gale"}, {store.LogMetStorm, "storm"}, {store.LogMetFog, "fog"}, {store.LogMetNight, "night"}}

// howFar is how far a task not yet done has come: "1.4 of 3 NM", "2 of
// 3", "closest so far 640 m", "gale ✓ · storm · fog · night ✓"; "" for
// one done, a course's (its runs are said apart), or one not begun that
// asks one thing.
func howFar(t *certs.Task) string {
	if t.Done || t.Course {
		return ""
	}
	switch catalog.Measure(t.Measure) {
	case catalog.MeasureDistance:
		// Rounded down: never the mark itself while the task is not done.
		return trimFloat(math.Floor(t.Have*10+1e-6)/10) + " of " + trimFloat(t.At) + " NM"
	case catalog.MeasureLip:
		if !t.Survived {
			return ""
		}
		return "closest so far " + thousands(int(math.Round(t.Closest))) + " m"
	case catalog.MeasureEveryWeather:
		words := make([]string, len(everyWeatherWords))
		for i, w := range everyWeatherWords {
			words[i] = w.word
			if t.Met&w.bit != 0 {
				words[i] += " ✓"
			}
		}
		return strings.Join(words, " · ")
	}
	if t.At > 1 {
		return fmt.Sprintf("%d of %d", int(t.Have), int(t.At))
	}
	return ""
}

// ladderWords are the whole ladder for the handbook, written from the
// catalog: each certificate with how many of its tasks it needs and the
// boats it opens, and each task with how it is done. "" without a
// catalog.
func ladderWords(cat *catalog.Catalog) string {
	if cat == nil || len(cat.Certificates) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("The ladder, each task with how it is done:")
	for i := range cat.Certificates {
		ct := &cat.Certificates[i]
		fmt.Fprintf(&b, "\n\n%s, any %d of %d", ct.Name, ct.Needs, len(ct.Tasks))
		if boats := opensWords(cat, ct); boats != "" {
			b.WriteString("; opens " + strings.TrimSuffix(strings.TrimSuffix(boats, " are"), " is"))
		}
		b.WriteString(":")
		for j := range ct.Tasks {
			t := &ct.Tasks[j]
			b.WriteString("\n- " + t.Name)
			if how := howTo(t); how != "" {
				b.WriteString(": " + how)
			}
		}
	}
	return b.String()
}

// heldWords are the certificates a sailor holds, each with when, in which
// world and whether by hand: "Deckhand (14 November 2026, world 12, by
// hand) and Helm (20 November 2026, world 13)".
func heldWords(cat *catalog.Catalog, earned []certs.Earned) string {
	if cat == nil {
		return ""
	}
	names := make([]string, 0, len(earned))
	for _, e := range earned {
		if e.Place < 0 || e.Place >= len(cat.Certificates) {
			continue
		}
		parts := []string{e.At.UTC().Format("2 January 2006")}
		if e.World > 0 {
			parts = append(parts, fmt.Sprintf("world %d", e.World))
		}
		if e.ByHand {
			parts = append(parts, "by hand")
		}
		names = append(names, cat.Certificates[e.Place].Name+" ("+strings.Join(parts, ", ")+")")
	}
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0]
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
}

// certificateWords are where a sailor stands, for its log: the
// certificates held, each with when, in which world and whether by hand,
// and the next one's tasks, ticked, each one not yet done with how far it
// has come and each course task with the codes of the Harbourmaster's
// trials in its boat that count.
func certificateWords(cat *catalog.Catalog, st *certs.Standing, trials []race.Summary) string {
	var b strings.Builder
	switch held := heldWords(cat, st.Earned); {
	case held != "":
		b.WriteString("Certificates: you hold " + held + ".")
	case st.Held >= 0:
		b.WriteString("Certificates: you hold " + st.HeldName)
		if st.ByHand {
			b.WriteString(", by hand")
		}
		b.WriteString(".")
	default:
		b.WriteString("Certificates: none yet.")
	}
	if st.Next < 0 {
		b.WriteString(" " + st.HeldName + " is the last.")
		return b.String()
	}
	fmt.Fprintf(&b, " Toward %s, %d of the %d tasks it needs, any of these %d, sailed alone (handbook certificates says how each is done):",
		st.Name, min(st.Done, st.Needs), st.Needs, len(st.Tasks))
	for _, t := range st.Tasks {
		mark := "-"
		if t.Done {
			mark = "✓"
		}
		line := fmt.Sprintf("\n %s %s", mark, t.Name)
		switch {
		case t.Done && t.Way == store.WayHand:
			line += " (by hand)"
		case t.Done && t.Way == store.WayPilot:
			line += " (the autopilot way)"
		case t.Course:
			line += fmt.Sprintf(": a time trial by hand, or %d runs with the autopilot (%d so far)", t.Of, t.Runs)
			var codes []string
			for _, tr := range trials {
				if slices.Contains(t.Courses, tr.Course) && len(codes) < 3 {
					codes = append(codes, tr.Code+" ("+tr.Name+")")
				}
			}
			if len(codes) > 0 {
				line += "; race enter " + strings.Join(codes, ", or ")
			}
		default:
			if far := howFar(&t); far != "" {
				line += ": " + far
			}
		}
		b.WriteString(line)
	}
	return b.String()
}
