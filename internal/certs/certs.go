// SPDX-License-Identifier: AGPL-3.0-only

// Package certs is the game's certificates: Deckhand, Helm, Skipper,
// Captain and Master in the catalog's order, each opening bigger boats to
// the sailor who holds it or a later one, and earned on the water, the
// way a bundle is filled: any few of its tasks, in any order, never lost.
//
// Every task counts only what the sailor sailed alone, as skipper of its
// own boat with nobody else aboard, since its last certificate was
// earned, and only toward the next. A course task is a time trial's run
// on one of its courses, to a medal of the boat's own par: by hand when
// the autopilot was off throughout, or else toward its longer venture.
// The rest are the log's: distance, nights, gales, the lip, places, life.
//
// Nothing of a sailor's progress is stored: it is counted from the races'
// and the log's rows each time, by the Judge, inside the transactions
// that write those rows (store.Examiner), which earns the certificate
// there when enough tasks are done. What opens a boat to a sailor is one
// question, Needs.
package certs

import (
	"context"
	"fmt"
	"math/bits"
	"slices"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Ladder is the catalog's certificates, in order.
type Ladder struct {
	certs []catalog.Certificate
	// byID is each certificate's place, by id; opener the place of the
	// certificate that opens each boat, by the boat's id.
	byID   map[string]int
	opener map[string]int
	// scores are the news's story's score for each certificate earned.
	scores []int
}

// New is the catalog's ladder of certificates.
func New(cat *catalog.Catalog) *Ladder {
	l := &Ladder{certs: cat.Certificates, byID: map[string]int{}, opener: map[string]int{}}
	for i := range l.certs {
		c := &l.certs[i]
		l.byID[string(c.ID)] = i
		for _, b := range c.Opens {
			l.opener[string(b)] = i
		}
		l.scores = append(l.scores, cat.CertificateScore(i))
	}
	return l
}

// Len is how many certificates there are.
func (l *Ladder) Len() int { return len(l.certs) }

// Certificate is the certificate at place i.
func (l *Ladder) Certificate(i int) *catalog.Certificate { return &l.certs[i] }

// Name is the name of the certificate at place i, "" for none.
func (l *Ladder) Name(i int) string {
	if i < 0 || i >= len(l.certs) {
		return ""
	}
	return l.certs[i].Name
}

// Score is the score of the news's story of the certificate at place i
// earned.
func (l *Ladder) Score(i int) int {
	if i < 0 || i >= len(l.scores) {
		return 0
	}
	return l.scores[i]
}

// Place is the place of the certificate of an id, −1 for none.
func (l *Ladder) Place(id string) int {
	if i, ok := l.byID[id]; ok {
		return i
	}
	return -1
}

// Opener is the place of the certificate that opens a boat, by the boat's
// id: −1 for a boat open to every sailor.
func (l *Ladder) Opener(boat string) int {
	if i, ok := l.opener[boat]; ok {
		return i
	}
	return -1
}

// highest is the place of the highest certificate of ids, −1 for none.
func (l *Ladder) highest(ids []string) int {
	top := -1
	for _, id := range ids {
		top = max(top, l.Place(id))
	}
	return top
}

// Needs is the name of the certificate a sailor needs to take a boat, by
// the boat's id, "" if it may sail her: a boat no certificate opens, one
// opened by the certificate the sailor holds or one before it, a kind it
// keeps, or every boat opened to it by the owner. A nil ladder opens
// every boat.
func (l *Ladder) Needs(r *store.SailRights, boat string) string {
	if l == nil || r.EveryBoat {
		return ""
	}
	i := l.Opener(boat)
	if i < 0 || l.highest(r.Held) >= i || slices.Contains(r.Kept, boat) {
		return ""
	}
	return l.certs[i].Name
}

// The medals of a run, as its record keeps them, ranked: any finish
// counts as the least.
var medalRank = map[string]int{"": 0, "bronze": 1, "silver": 2, "gold": 3, "harbourmaster": 4}

// wayRank is the rank a way asks of a run's medal.
func wayRank(m catalog.Medal) int {
	if m == catalog.MedalFinish {
		return 0
	}
	return medalRank[string(m)]
}

// Task is where a sailor stands on one task of its next certificate.
type Task struct {
	// ID and Name are the catalog's; Course is whether it is a course
	// task, Courses its courses (store.CourseShort …).
	ID      string
	Name    string
	Course  bool
	Courses []string
	// Done is whether it is done, and Way how: store.WayHand,
	// store.WayPilot or store.WayLog.
	Done bool
	Way  string
	// Runs and Of are a course task's venture's runs that count so far,
	// of those it asks.
	Runs, Of int
	// Measure is a log task's measure, "" for a course task; Have how far
	// the log has come on it and At the mark it asks, in the measure's
	// own unit: nautical miles for distance, a count for the rest (the
	// weather met of four, for every weather). The lip's are apart:
	// Closest is the closest approach survived so far, m, if Survived,
	// and At the distance to come within.
	Measure  string
	Have, At float64
	Closest  float64
	Survived bool
	// Met is the weather met of what every weather asks, the log's
	// LogMet… flags.
	Met int
}

// Earned is a certificate a sailor holds: its place in the catalog's
// list, when and in which world it was earned, whether by hand, and the
// tasks that counted, each by its place among the certificate's tasks,
// with its way. A task the catalog no longer has is left out.
type Earned struct {
	Place  int
	At     time.Time
	World  int
	ByHand bool
	Tasks  []EarnedTask
}

// EarnedTask is a task that counted toward a certificate held: its place
// among the certificate's tasks, and its way.
type EarnedTask struct {
	Task int
	Way  string
}

// Standing is where a sailor stands on the ladder.
type Standing struct {
	// Held is the place of the highest certificate held, −1 for none;
	// ByHand whether it was earned by hand; Since when it was earned.
	Held     int
	HeldName string
	ByHand   bool
	Since    time.Time
	// Earned are the certificates held, in the catalog's order.
	Earned []Earned
	// Next is the place of the next certificate, −1 after the last, and
	// Name its name; Needs how many of its tasks it needs, and Done how
	// many are.
	Next  int
	Name  string
	Needs int
	Done  int
	Tasks []Task
}

// Of is a sailor's standing on the ladder, read now: none, without an
// exam to read it by.
func (l *Ladder) Of(ctx context.Context, x *store.Exam, account store.AccountID) (Standing, error) {
	if x == nil || l == nil || len(l.certs) == 0 {
		return Standing{Held: -1, Next: -1}, nil
	}
	held, err := x.Held(ctx, account)
	if err != nil {
		return Standing{}, err
	}
	st := Standing{Held: -1, Next: 0}
	for _, c := range held {
		if i := l.Place(c.ID); i > st.Held {
			st.Held, st.ByHand = i, c.ByHand
		}
		if c.Earned.After(st.Since) {
			st.Since = c.Earned
		}
		if e, ok := l.earned(&c); ok {
			st.Earned = append(st.Earned, e)
		}
	}
	slices.SortStableFunc(st.Earned, func(a, b Earned) int { return a.Place - b.Place })
	st.HeldName = l.Name(st.Held)
	st.Next = st.Held + 1
	if st.Next >= len(l.certs) {
		st.Next = -1
		return st, nil
	}
	st.Name = l.certs[st.Next].Name
	runs, err := x.Runs(ctx, account, st.Since)
	if err != nil {
		return Standing{}, err
	}
	solo, err := x.Solo(ctx, account, st.Since)
	if err != nil {
		return Standing{}, err
	}
	c := &l.certs[st.Next]
	st.Needs = c.Needs
	for i := range c.Tasks {
		t := taskOf(&c.Tasks[i], runs, &solo)
		if t.Done {
			st.Done++
		}
		st.Tasks = append(st.Tasks, t)
	}
	return st, nil
}

// earned is a certificate held as the ladder knows it: false for one the
// catalog no longer has.
func (l *Ladder) earned(c *store.Certificate) (Earned, bool) {
	i := l.Place(c.ID)
	if i < 0 {
		return Earned{}, false
	}
	e := Earned{Place: i, At: c.Earned, World: c.World, ByHand: c.ByHand}
	for _, k := range c.Tasks {
		if j := slices.IndexFunc(l.certs[i].Tasks, func(t catalog.CertificateTask) bool { return string(t.ID) == k.Task }); j >= 0 {
			e.Tasks = append(e.Tasks, EarnedTask{Task: j, Way: k.Way})
		}
	}
	slices.SortStableFunc(e.Tasks, func(a, b EarnedTask) int { return a.Task - b.Task })
	return e, true
}

// taskOf is where a sailor stands on a task, from its runs and its log
// sailed alone since its last certificate.
func taskOf(t *catalog.CertificateTask, runs []store.TrialRun, solo *store.SoloLog) Task {
	out := Task{ID: string(t.ID), Name: t.Name, Course: len(t.Courses) > 0}
	for _, c := range t.Courses {
		out.Courses = append(out.Courses, string(c))
	}
	if out.Course {
		if t.Hand != nil && met(t.Hand, out.Courses, runs, true) {
			out.Done, out.Way = true, store.WayHand
		}
		if t.Venture != nil {
			out.Runs, out.Of = count(t.Venture, out.Courses, runs, false), runsOf(t.Venture)
			if !out.Done && met(t.Venture, out.Courses, runs, false) {
				out.Done, out.Way = true, store.WayPilot
			}
		}
		return out
	}
	if t.Measure == nil || t.At == nil {
		return out
	}
	out.Measure, out.At = string(*t.Measure), *t.At
	out.Have = have(*t.Measure, solo)
	switch *t.Measure {
	case catalog.MeasureLip:
		out.Closest, out.Survived = solo.Least, solo.Survived
	case catalog.MeasureEveryWeather:
		out.Met = solo.Weather & everyWeather
		out.At = float64(bits.OnesCount(uint(everyWeather)))
	}
	if reached(*t.Measure, *t.At, solo) {
		out.Done, out.Way = true, store.WayLog
	}
	return out
}

// have is how far a sailor's log sailed alone has come on a measure, in
// the measure's own unit: nautical miles for distance, a count for the
// rest; for every weather, how many of the four are met; nothing for the
// lip, whose closest approach is no count.
func have(m catalog.Measure, s *store.SoloLog) float64 {
	switch m {
	case catalog.MeasureDistance:
		return s.Distance / 1852
	case catalog.MeasurePlacesSeen:
		return float64(s.Places)
	case catalog.MeasurePlacesCharted:
		return float64(s.Charted)
	case catalog.MeasureLifeKinds:
		return float64(s.LifeKinds)
	case catalog.MeasureNights:
		return float64(s.Nights)
	case catalog.MeasureGales:
		return float64(s.Gales)
	case catalog.MeasureStormsOrFogs:
		return float64(s.StormsOrFogs)
	case catalog.MeasureWorlds:
		return float64(s.Worlds)
	case catalog.MeasureFalls:
		return float64(s.Falls)
	case catalog.MeasureEveryWeather:
		return float64(bits.OnesCount(uint(s.Weather & everyWeather)))
	}
	return 0
}

// runsOf is how many runs a way asks.
func runsOf(w *catalog.CertificateWay) int {
	if w.Runs != nil {
		return max(*w.Runs, 1)
	}
	return 1
}

// counts reports whether a run counts toward a way on courses: on one of
// them, to its medal, and by hand if the way asks it.
func counts(w *catalog.CertificateWay, courses []string, r *store.TrialRun, byHand bool) bool {
	return slices.Contains(courses, r.Course) && medalRank[r.Medal] >= wayRank(w.Medal) && (!byHand || !r.Piloted)
}

// count is how many of runs count toward a way on courses: each on a
// course of a different name if it asks them apart.
func count(w *catalog.CertificateWay, courses []string, runs []store.TrialRun, byHand bool) int {
	n := 0
	var names []string
	for i := range runs {
		r := &runs[i]
		if !counts(w, courses, r, byHand) {
			continue
		}
		if w.Apart != nil && *w.Apart {
			if slices.Contains(names, r.CourseName) {
				continue
			}
			names = append(names, r.CourseName)
		}
		n++
	}
	return n
}

// met reports whether runs meet a way on courses: one on each course if
// it asks so, or as many runs as it asks.
func met(w *catalog.CertificateWay, courses []string, runs []store.TrialRun, byHand bool) bool {
	if w.Each != nil && *w.Each {
		for _, c := range courses {
			if count(w, []string{c}, runs, byHand) == 0 {
				return false
			}
		}
		return true
	}
	return count(w, courses, runs, byHand) >= runsOf(w)
}

// everyWeather is the weather every-weather asks met: a gale, a storm, a
// landfall in fog and a night at sea.
const everyWeather = store.LogMetGale | store.LogMetStorm | store.LogMetFog | store.LogMetNight

// reached reports whether a sailor's log sailed alone reaches a measure's
// mark.
func reached(m catalog.Measure, at float64, s *store.SoloLog) bool {
	switch m {
	case catalog.MeasureDistance:
		return s.Distance/1852 >= at
	case catalog.MeasurePlacesSeen:
		return float64(s.Places) >= at
	case catalog.MeasurePlacesCharted:
		return float64(s.Charted) >= at
	case catalog.MeasureLifeKinds:
		return float64(s.LifeKinds) >= at
	case catalog.MeasureNights:
		return float64(s.Nights) >= at
	case catalog.MeasureGales:
		return float64(s.Gales) >= at
	case catalog.MeasureStormsOrFogs:
		return float64(s.StormsOrFogs) >= at
	case catalog.MeasureLip:
		return s.Survived && s.Least <= at
	case catalog.MeasureWorlds:
		return float64(s.Worlds) >= at
	case catalog.MeasureFalls:
		return float64(s.Falls) >= at
	case catalog.MeasureEveryWeather:
		return s.Weather&everyWeather == everyWeather
	}
	return false
}

// Judge is the ladder as the store's transactions judge it: a
// store.Examiner.
type Judge struct{ L *Ladder }

var _ store.Examiner = Judge{}

// Standing is where a sailor stands toward its next certificate, as the
// store keeps it between reading and judging.
func (j Judge) Standing(ctx context.Context, x *store.Exam, account store.AccountID) (store.Standing, error) {
	st, err := j.L.Of(ctx, x, account)
	if err != nil {
		return store.Standing{}, err
	}
	return storeStanding(j.L, &st), nil
}

func storeStanding(l *Ladder, st *Standing) store.Standing {
	out := store.Standing{Done: map[string]string{}, Runs: map[string]int{}}
	if st.Next < 0 {
		return out
	}
	out.Next = string(l.certs[st.Next].ID)
	for _, t := range st.Tasks {
		if t.Done {
			out.Done[t.ID] = t.Way
		}
		if t.Course {
			out.Runs[t.ID] = t.Runs
		}
	}
	return out
}

// Judge judges a sailor once its rows are written: each task of its next
// certificate done since before is told, and each course task not yet
// done whose venture has more runs than before; once enough are done the
// certificate is earned, by hand if every course task it counted was,
// at the time of the rows (or its last earning's, if later), in world.
func (j Judge) Judge(ctx context.Context, x *store.Exam, account store.AccountID, world int, at time.Time,
	before store.Standing) ([]store.Certified, error) {
	l := j.L
	st, err := l.Of(ctx, x, account)
	if err != nil || st.Next < 0 || string(l.certs[st.Next].ID) != before.Next {
		return nil, err
	}
	var out []store.Certified
	for i, t := range st.Tasks {
		switch {
		case t.Done && before.Done[t.ID] == "":
			out = append(out, store.Certified{Account: account, Certificate: st.Next, Task: i, Done: min(st.Done, st.Needs), Of: st.Needs,
				Way: t.Way})
		case !t.Done && t.Course && t.Of > 1 && t.Runs > before.Runs[t.ID]:
			// A run nearer the venture: told, the task still to do.
			out = append(out, store.Certified{Account: account, Certificate: st.Next, Task: i, Done: min(st.Done, st.Needs), Of: st.Needs,
				Way: store.WayPilot, Runs: t.Runs, RunsOf: t.Of})
		}
	}
	if st.Done < st.Needs {
		return out, nil
	}
	c := store.Certificate{ID: before.Next, Earned: at, World: max(world, 1)}
	if c.Earned.Before(st.Since) {
		c.Earned = st.Since
	}
	courses, hands := 0, 0
	for _, t := range st.Tasks {
		if !t.Done {
			continue
		}
		c.Tasks = append(c.Tasks, store.CertTask{Task: t.ID, Way: t.Way})
		if t.Course {
			courses++
			if t.Way == store.WayHand {
				hands++
			}
		}
	}
	c.ByHand = courses > 0 && hands == courses
	cert := &l.certs[st.Next]
	opens := make([]string, len(cert.Opens))
	for i, b := range cert.Opens {
		opens[i] = string(b)
	}
	ok, err := x.Earn(ctx, account, &c, cert.Name, opens, l.Score(st.Next))
	if err != nil || !ok {
		return out, err
	}
	if len(out) == 0 || out[len(out)-1].RunsOf > 0 {
		out = append(out, store.Certified{Account: account, Certificate: st.Next, Task: -1, Done: st.Needs, Of: st.Needs})
	}
	// The last told is the earning.
	out[len(out)-1].Earned, out[len(out)-1].ByHand = true, c.ByHand
	return out, nil
}

// Toward is the name of the next certificate a sailor's run alone on a
// course (store.CourseShort …) would count toward: one with a course task
// not yet done that the course is one of; "" for none.
func (st *Standing) Toward(course string) string {
	if st.Next < 0 {
		return ""
	}
	for _, t := range st.Tasks {
		if t.Course && !t.Done && slices.Contains(t.Courses, course) {
			return st.Name
		}
	}
	return ""
}

// Command is the command that tells a sailor, through the world, what a
// judging of its certificates told.
func Command(c *store.Certified) bus.Command {
	way := bus.CertLog
	switch c.Way {
	case store.WayHand:
		way = bus.CertHand
	case store.WayPilot:
		way = bus.CertPilot
	}
	return bus.Command{Op: bus.Certify, Account: bus.Account(c.Account), Certified: bus.Certified{
		Certificate: int16(c.Certificate), Task: int16(c.Task), Done: uint8(min(max(c.Done, 0), 255)), Of: uint8(min(max(c.Of, 0), 255)),
		Way: way, Runs: uint8(min(max(c.Runs, 0), 255)), RunsOf: uint8(min(max(c.RunsOf, 0), 255)), Earned: c.Earned, ByHand: c.ByHand}}
}

// Line is a standing in a line, as the owner's card shows it: the
// certificate held, by hand if it was, and the next one's count ("Helm ·
// by hand · Skipper 2 of 4"; "none yet · Deckhand 0 of 3"; "Master").
func (st *Standing) Line() string {
	var parts []string
	if st.Held < 0 {
		parts = append(parts, "none yet")
	} else {
		parts = append(parts, st.HeldName)
		if st.ByHand {
			parts = append(parts, "by hand")
		}
	}
	if st.Next >= 0 {
		parts = append(parts, fmt.Sprintf("%s %d of %d", st.Name, min(st.Done, st.Needs), st.Needs))
	}
	return strings.Join(parts, " · ")
}
