// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/certs"
	"github.com/daneelvt/keel-over-the-edge/internal/logbook"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// TestBoatsKeptMigration: migrated from the schema before certificates,
// every sailor keeps each kind it skippered and each it holds in its
// fleet; a kind it only crewed in, or one of its fleet's boats another
// sailor holds, it does not.
func TestBoatsKeptMigration(t *testing.T) {
	ctx := context.Background()
	u := storetest.Empty(t)
	if _, err := store.Migrate(ctx, u, 40); err != nil {
		t.Fatal(err)
	}
	pool := storetest.PoolOn(t, u)
	var ids [][16]byte
	for i, name := range []string{"Ann Bonny", "Mary Read"} {
		id := uuidOf(t, pool, "INSERT INTO account (kind, saved_at) VALUES ('human', now()) RETURNING id")
		must(t, pool, "INSERT INTO sailor (account_id, name, name_key, look) VALUES ($1, $2, $3, 'figure')", id, name,
			[]string{"annbonny", "maryread"}[i])
		ids = append(ids, id)
	}
	ann, mary := ids[0], ids[1]
	t0 := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	voyage := "INSERT INTO log_voyage (account_id, source, world, aboard, boat, boat_kind, began_at, ended_at, how) " +
		"VALUES ($1, $2, 1, $3, 1, $4, $5, $5, 'returned')"
	// Ann skippered the yacht, and crewed in Mary's catamaran.
	must(t, pool, voyage, ann, "v:1", false, "yacht", t0)
	must(t, pool, voyage, ann, "a:1", true, "catamaran", t0)
	// Mary holds her fleet's keelboat; Ann's skiff is held by no one.
	must(t, pool, "INSERT INTO boat (account_id, kind, number, sailor) VALUES ($1, 'keelboat', 901, $1)", mary)
	must(t, pool, "INSERT INTO boat (account_id, kind, number) VALUES ($1, 'skiff', 901)", ann)
	if _, err := store.Migrate(ctx, u, 0); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(ctx, u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, c := range []struct {
		who  [16]byte
		want []string
	}{{ann, []string{"yacht"}}, {mary, []string{"keelboat"}}} {
		r, err := s.SailRights(ctx, c.who)
		if err != nil || !slices.Equal(r.Kept, c.want) || r.EveryBoat || len(r.Held) != 0 {
			t.Errorf("rights %+v %v, want kept %v", r, err, c.want)
		}
	}
}

// judgeWorld is a store with a world, a lease taken and its writer, for
// judging certificates on the real database.
type judgeWorld struct {
	t     *testing.T
	s     *store.Store
	p     *store.Persister
	epoch int64
	world store.World
	ex    certs.Judge
	at    time.Time
	n     int
	told  []store.Certified
}

func newJudgeWorld(t *testing.T) *judgeWorld {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	world, err := s.ActiveOrFirstWorld(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	epoch := take(t, newLease(t, u, "keel-a dev", store.LeaseOptions{}))
	p, err := store.OpenPersister(ctx, u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	return &judgeWorld{t: t, s: s, p: p, epoch: epoch, world: world, ex: certs.Judge{L: certs.New(cat)},
		at: time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC)}
}

func (w *judgeWorld) sailor(name, key string) store.AccountID {
	w.t.Helper()
	id, err := w.s.CreateAccount(context.Background(), storetest.NewAccount(name, key, [32]byte{byte(len(name)), key[0]}))
	if err != nil {
		w.t.Fatal(err)
	}
	return id
}

// next is a minute on from the last row's time.
func (w *judgeWorld) next() time.Time {
	w.at = w.at.Add(time.Minute)
	w.n++
	return w.at
}

// run writes a time trial's run, as the clerk does: its course, medal,
// and whether piloted and alone.
func (w *judgeWorld) run(who store.AccountID, course, medal string, piloted, alone bool) []store.Certified {
	w.t.Helper()
	at := w.next()
	src := fmt.Sprintf("race:trial%d:%d", w.n, w.n)
	e := &store.RaceEnd{World: w.world.ID, Race: [16]byte{byte(w.n)}, Run: 1, Trial: true, At: at, Examiner: w.ex,
		Records: []store.RaceRecord{{Account: who, Source: src, World: w.world.Number, At: at, Code: "abcdefghij", RaceName: "a trial",
			Kind: "trial", CourseName: "Course " + course, Boat: "jolly-boat", Role: store.RoleSkipper, How: store.HowFinished, Medal: medal,
			Piloted: piloted, Alone: alone, Course: course}}}
	if err := w.s.EndRace(context.Background(), w.epoch, store.NewsRules{}, e); err != nil {
		w.t.Fatal(err)
	}
	return e.Certified
}

// log writes rows of the log, as the world's writer does.
func (w *judgeWorld) log(rows store.LogRows) []store.Certified {
	w.t.Helper()
	w.told = nil
	b := store.Batch{World: w.world.ID, Epoch: w.epoch, Log: rows, Examiner: w.ex, Told: func(c []store.Certified) { w.told = c },
		News: &store.NewsRules{Zone: "UTC", Column: "discoveries"}}
	if err := w.p.Write(context.Background(), b); err != nil {
		w.t.Fatal(err)
	}
	return w.told
}

// voyage is a voyage alone of m metres, or with a friend aboard.
func (w *judgeWorld) voyage(who store.AccountID, m float64, met int, friend store.AccountID) []store.Certified {
	at := w.next()
	v := store.LogVoyage{Account: who, Source: fmt.Sprintf("v:%d", w.n), World: w.world.Number, Boat: 1, BoatKind: "jolly-boat",
		Began: at.Add(-30 * time.Second), Ended: at, How: store.LogReturned, Run: m, Logged: true, Met: met}
	if friend != (store.AccountID{}) {
		v.Crew = []store.LogMate{{ID: friend, Seconds: 30}}
	}
	return w.log(store.LogRows{Voyages: []store.LogVoyage{v}})
}

// met is a creature met, alone or not.
func (w *judgeWorld) met(who store.AccountID, kind string, crewed bool) []store.Certified {
	at := w.next()
	return w.log(store.LogRows{Entries: []store.LogEntry{{Account: who, Source: fmt.Sprintf("m:%d", w.n), World: w.world.Number, At: at,
		Kind: store.LogMet, Title: kind, Group: "life", Find: kind, Crewed: crewed}}})
}

func (w *judgeWorld) standing(who store.AccountID) certs.Standing {
	w.t.Helper()
	st, err := w.ex.L.Of(context.Background(), w.s.Exam(), who)
	if err != nil {
		w.t.Fatal(err)
	}
	return st
}

// taskOf is a standing's task of an id.
func taskOf(t *testing.T, st certs.Standing, id string) certs.Task {
	t.Helper()
	for _, x := range st.Tasks {
		if x.ID == id {
			return x
		}
	}
	t.Fatalf("no task %s in %+v", id, st.Tasks)
	return certs.Task{}
}

// TestTheJudgeCountsRunsAlone: a run sailed alone ticks a course task and
// is told; a run with a friend aboard counts nothing; a run on the
// autopilot counts toward the task's venture, done the second time.
func TestTheJudgeCountsRunsAlone(t *testing.T) {
	w := newJudgeWorld(t)
	ann, tom := w.sailor("Ann Bonny", "annbonny"), w.sailor("Tom Bowline", "tornbowline")
	if told := w.run(tom, store.CourseShort, "", false, false); len(told) != 0 {
		t.Errorf("a run with a friend aboard told %+v", told)
	}
	if task := taskOf(t, w.standing(tom), "short-course"); task.Done {
		t.Errorf("a run with a friend aboard counted: %+v", task)
	}
	told := w.run(ann, store.CourseShort, "", false, true)
	if len(told) != 1 || told[0].Task != 0 || told[0].Way != store.WayHand || told[0].Done != 1 || told[0].Of != 3 || told[0].Earned {
		t.Errorf("a run alone by hand told %+v", told)
	}
	if told := w.run(ann, store.CourseShort, "", false, true); len(told) != 0 {
		t.Errorf("a task done twice told again: %+v", told)
	}
	// Tom on the autopilot: 1 of 2, told as a run nearer, then done the
	// autopilot way.
	if told := w.run(tom, store.CourseShort, "bronze", true, true); len(told) != 1 || told[0].Task != 0 || told[0].Way != store.WayPilot ||
		told[0].Runs != 1 || told[0].RunsOf != 2 || told[0].Done != 0 || told[0].Earned {
		t.Errorf("one run of a venture of two told %+v", told)
	}
	if task := taskOf(t, w.standing(tom), "short-course"); task.Done || task.Runs != 1 || task.Of != 2 {
		t.Errorf("after one piloted run: %+v", task)
	}
	told = w.run(tom, store.CourseShort, "", true, true)
	if len(told) != 1 || told[0].Way != store.WayPilot || told[0].RunsOf != 0 || told[0].Done != 1 {
		t.Errorf("the venture's second run told %+v", told)
	}
	// A run on another course counts toward nothing of Deckhand's.
	if told := w.run(ann, store.CourseTriangle, "gold", false, true); len(told) != 0 {
		t.Errorf("a triangle told %+v toward Deckhand", told)
	}
}

// TestThreeTasksEarnDeckhand: a course sailed by hand, a mile alone and a
// creature met earn Deckhand by hand, told with the last task, written
// once with its tasks and in the log; the counts start again for Helm,
// and what was sailed before counts toward it nothing. A creature met
// with a friend aboard, or a mile sailed with one, counts for nothing.
func TestThreeTasksEarnDeckhand(t *testing.T) {
	ctx := context.Background()
	w := newJudgeWorld(t)
	ann, tom := w.sailor("Ann Bonny", "annbonny"), w.sailor("Tom Bowline", "tornbowline")
	w.run(ann, store.CourseShort, "", false, true)
	if told := w.met(ann, "dolphin", true); len(told) != 0 {
		t.Errorf("a creature met crewed told %+v", told)
	}
	if told := w.voyage(ann, 2000, 0, tom); len(told) != 0 {
		t.Errorf("a mile sailed with a friend told %+v", told)
	}
	if told := w.voyage(ann, 2000, store.LogMetNight, store.AccountID{}); len(told) != 1 || told[0].Done != 2 {
		t.Errorf("a mile alone told %+v", told)
	}
	told := w.met(ann, "dolphin", false)
	if len(told) != 1 || !told[0].Earned || !told[0].ByHand || told[0].Certificate != 0 || told[0].Done != 3 {
		t.Fatalf("the third task told %+v", told)
	}
	held, err := w.s.Exam().Held(ctx, ann)
	if err != nil || len(held) != 1 || held[0].ID != "deckhand-cert" || !held[0].ByHand || len(held[0].Tasks) != 3 {
		t.Fatalf("held %+v %v", held, err)
	}
	entries, err := w.s.LogEntries(ctx, ann, w.world.Number)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range entries {
		if e.Kind == store.LogCertificate && e.Title == "Deckhand" && e.What == "by hand" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("%d log entries of the certificate: %+v", n, entries)
	}
	// And a story of the news, about Ann, scored as its certificate is.
	stories, err := w.s.DayStories(ctx, w.world.ID, w.at)
	if err != nil {
		t.Fatal(err)
	}
	n = 0
	for _, st := range stories {
		if st.Story == store.StoryCertificate {
			n++
			if st.Account != ann || st.Title != "Deckhand" || st.What != "by hand" || st.Subject != store.SubjectSailor ||
				len(st.Facts.Boats) != 2 || st.Score != w.ex.L.Score(0) {
				t.Errorf("the certificate's story: %+v", st)
			}
		}
	}
	if n != 1 {
		t.Errorf("%d stories of the certificate: %+v", n, stories)
	}
	st := w.standing(ann)
	if st.Held != 0 || st.Next != 1 || st.Done != 0 || st.Needs != 4 {
		t.Errorf("toward Helm: %+v", st)
	}
	// The night before the earning counts toward Helm nothing; one after
	// does.
	if task := taskOf(t, st, "a-night"); task.Done {
		t.Errorf("a night before Deckhand counted toward Helm")
	}
	if told := w.voyage(ann, 100, store.LogMetNight, store.AccountID{}); len(told) != 1 || told[0].Certificate != 1 {
		t.Errorf("a night after Deckhand told %+v", told)
	}
	r, err := w.s.SailRights(ctx, ann)
	if err != nil || !slices.Equal(r.Held, []string{"deckhand-cert"}) {
		t.Errorf("rights %+v %v", r, err)
	}
	if needs := w.ex.L.Needs(&r, "keelboat"); needs != "" {
		t.Errorf("a Deckhand's keelboat needs %q", needs)
	}
	if needs := w.ex.L.Needs(&r, "beach-cat"); needs != "Helm" {
		t.Errorf("a Deckhand's beach cat needs %q", needs)
	}
}

// TestTheLogReadsCertificates: a sailor's own log reads each certificate
// held, in order, with when and in which world it was earned, whether by
// hand and the tasks that counted; and each task of the next not yet done
// with how far a voyage since has brought it. Another reads which are
// held, when and how, never the tasks nor the way toward the next.
func TestTheLogReadsCertificates(t *testing.T) {
	ctx := context.Background()
	w := newJudgeWorld(t)
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	ann, tom := w.sailor("Ann Bonny", "annbonny"), w.sailor("Tom Bowline", "tornbowline")
	logs := logbook.NewService(logbook.ServiceConfig{Store: w.s, Catalog: cat, Key: moderation.Key, Zone: time.UTC,
		World: func() int { return w.world.Number },
		Standing: func(ctx context.Context, id store.AccountID) (certs.Standing, error) {
			return w.ex.L.Of(ctx, w.s.Exam(), id)
		}})
	// Nothing sailed: no certificates, and Deckhand's miles at nothing.
	own, err := logs.Own(ctx, ann, 0)
	if err != nil {
		t.Fatal(err)
	}
	if own.Certificates != nil || own.Toward == nil || own.Toward.Tasks[1].Have != 0 || own.Toward.Tasks[1].At != 1 {
		t.Fatalf("a new sailor's log: %+v, %+v", own.Certificates, own.Toward)
	}
	// Deckhand by hand: the course, a mile and a creature.
	w.run(ann, store.CourseShort, "", false, true)
	w.voyage(ann, 2000, 0, store.AccountID{})
	w.met(ann, "dolphin", false)
	deckhand := w.at
	// Toward Helm: 1.4 NM alone, and a second kind of the sea's life.
	w.voyage(ann, 1.4*1852+1, 0, store.AccountID{})
	w.met(ann, "gannet", false)
	w.met(ann, "dolphin", false)
	if own, err = logs.Own(ctx, ann, 0); err != nil {
		t.Fatal(err)
	}
	if c := own.Certificates; len(c) != 1 || c[0].Place != 0 || c[0].At != deckhand.UnixMilli() || c[0].World != w.world.Number || !c[0].ByHand ||
		!slices.Equal(c[0].Tasks, []logbook.EarnedTask{{Task: 0, Way: store.WayHand}, {Task: 1, Way: store.WayLog}, {Task: 3, Way: store.WayLog}}) {
		t.Errorf("Ann's Deckhand: %+v", c)
	}
	tw := own.Toward
	if tw == nil || tw.Name != "Helm" || tw.Done != 1 || len(tw.Tasks) != 6 {
		t.Fatalf("toward Helm: %+v", tw)
	}
	if k := tw.Tasks[2]; k.Done || k.Have != 1.4 || k.At != 3 {
		t.Errorf("three miles, 1.4 sailed since Deckhand: %+v", k)
	}
	if k := tw.Tasks[4]; k.Done || k.Closest != nil || k.At != 500 {
		t.Errorf("the lip, never approached: %+v", k)
	}
	if k := tw.Tasks[5]; !k.Done || k.Have != 0 {
		t.Errorf("two kinds of life, both met: %+v", k)
	}
	// Helm, the autopilot on for one of its courses: not by hand.
	w.run(ann, store.CourseTriangle, "bronze", false, true)
	w.run(ann, store.CourseLong, "silver", true, true)
	w.run(ann, store.CourseLong, "bronze", true, true)
	w.voyage(ann, 2*1852, store.LogMetNight, store.AccountID{})
	helm := w.at
	// And a voyage toward Skipper since.
	w.voyage(ann, 0.5*1852+1, 0, store.AccountID{})
	if own, err = logs.Own(ctx, ann, 0); err != nil {
		t.Fatal(err)
	}
	c := own.Certificates
	if len(c) != 2 || c[0].Place != 0 || c[0].At != deckhand.UnixMilli() || c[1].Place != 1 || c[1].At != helm.UnixMilli() || c[1].ByHand ||
		!slices.Equal(c[1].Tasks, []logbook.EarnedTask{{Task: 0, Way: store.WayHand}, {Task: 1, Way: store.WayPilot},
			{Task: 2, Way: store.WayLog}, {Task: 3, Way: store.WayLog}, {Task: 5, Way: store.WayLog}}) {
		t.Errorf("Ann's two certificates: %+v", c)
	}
	if own.Certificate == nil || own.Certificate.Name != "Helm" || own.Toward == nil || own.Toward.Name != "Skipper" {
		t.Fatalf("Ann, a Helm: %+v, %+v", own.Certificate, own.Toward)
	}
	if k := own.Toward.Tasks[2]; k.Have != 0.5 || k.At != 8 {
		t.Errorf("eight miles, half a mile sailed since Helm: %+v", k)
	}
	// Tom reads Ann's, which she lets sailors read.
	if err := logs.SetShown(ctx, ann, store.LogShownSailors); err != nil {
		t.Fatal(err)
	}
	theirs, err := logs.ByName(ctx, tom, "Ann Bonny", 0)
	if err != nil {
		t.Fatal(err)
	}
	if c := theirs.Certificates; len(c) != 2 || c[0].Tasks != nil || c[1].Tasks != nil || c[1].At != helm.UnixMilli() ||
		c[0].World != w.world.Number || !c[0].ByHand || theirs.Toward != nil {
		t.Errorf("Ann's log as Tom reads it: %+v, %+v", c, theirs.Toward)
	}
}

// TestByHandOnlyWhenEveryCourseWas: Deckhand earned with its course
// sailed on the autopilot, or with no course at all, is not by hand.
func TestByHandOnlyWhenEveryCourseWas(t *testing.T) {
	w := newJudgeWorld(t)
	ann, tom := w.sailor("Ann Bonny", "annbonny"), w.sailor("Tom Bowline", "tornbowline")
	w.run(ann, store.CourseShort, "", true, true)
	w.run(ann, store.CourseShort, "", true, true)
	w.voyage(ann, 2000, 0, store.AccountID{})
	if told := w.met(ann, "dolphin", false); len(told) != 1 || !told[0].Earned || told[0].ByHand {
		t.Errorf("Deckhand the autopilot way told %+v", told)
	}
	w.voyage(tom, 2000, 0, store.AccountID{})
	w.met(tom, "dolphin", false)
	told := w.log(store.LogRows{Voyages: []store.LogVoyage{{Account: tom, Source: "v:places", World: w.world.Number, Boat: 1,
		BoatKind: "jolly-boat", Began: w.next(), Ended: w.at, How: store.LogReturned, Place: "Keyhole Rock"}},
		Entries: []store.LogEntry{
			{Account: tom, Source: "c:1", World: w.world.Number, At: w.at, Kind: store.LogCharted, Title: "Gannet Holm", Place: "Gannet Holm"},
			{Account: tom, Source: "c:2", World: w.world.Number, At: w.at, Kind: store.LogCharted, Title: "Saltcliff"},
		}})
	if len(told) != 1 || !told[0].Earned || told[0].ByHand {
		t.Errorf("Deckhand from the log alone told %+v", told)
	}
}

// TestPrizesHoldCertificates: the prizes read for some sailors carry the
// certificates each holds, the first earned first, in whatever world is
// asked for, and alongside their races; a sailor with neither is left out.
func TestPrizesHoldCertificates(t *testing.T) {
	ctx := context.Background()
	s, _ := storetest.Store(t, store.Options{})
	var ids []store.AccountID
	for _, name := range []string{"Ann Bonny", "Tom Bowline"} {
		id, err := s.CreateAccount(ctx, storetest.NewAccount(name, name[:3], [32]byte{byte(len(name)), name[0]}))
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	ann, tom := ids[0], ids[1]
	at := time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC)
	for i, id := range []string{"helm-cert", "deckhand-cert"} {
		c := store.Certificate{ID: id, Earned: at.Add(time.Duration(i) * time.Hour), World: 3}
		if ok, err := s.Exam().Earn(ctx, ann, &c, id, nil, 0); err != nil || !ok {
			t.Fatalf("earning %s: %v, %v", id, ok, err)
		}
	}
	got, err := s.PrizesOf(ctx, 9, []store.AccountID{ann, tom}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if p, ok := got[ann]; !ok || !slices.Equal(p.Held, []string{"helm-cert", "deckhand-cert"}) || p.Sailed != 0 || len(p.Wins) != 0 {
		t.Errorf("Ann's prizes: %+v, %v", p, ok)
	}
	if p, ok := got[tom]; ok {
		t.Errorf("Tom, with nothing, read as %+v", p)
	}
}
