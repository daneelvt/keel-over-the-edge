// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/certs"
	"github.com/daneelvt/keel-over-the-edge/internal/race"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// TestCertificateWords: a task done and a certificate earned are told in
// observe's events with the certificate's and the task's names, its way
// and count, and the boats it opens; the log lists the next certificate's
// tasks, ticked, a course task with the trials that count; a trial on
// race's list says what it counts toward; a race in a boat the sailor may
// not sail is refused with the certificate named.
func TestCertificateWords(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	first := &cat.Certificates[0]
	got := certifiedWords(cat, &bus.Certified{Certificate: 0, Task: 0, Done: 1, Of: 3, Way: bus.CertHand})
	if want := "Toward " + first.Name + ": " + first.Tasks[0].Name + " ✓ by hand · 1 of 3"; got != want {
		t.Errorf("a task done: %q, want %q", got, want)
	}
	got = certifiedWords(cat, &bus.Certified{Certificate: 0, Task: 0, Done: 1, Of: 3, Way: bus.CertPilot, Runs: 1, RunsOf: 2})
	if want := "Toward " + first.Name + ": " + first.Tasks[0].Name + ", the autopilot way · 1 of 2 runs"; got != want {
		t.Errorf("a run nearer a venture: %q, want %q", got, want)
	}
	got = certifiedWords(cat, &bus.Certified{Certificate: 0, Task: 2, Done: 3, Of: 3, Earned: true, ByHand: true})
	if !strings.Contains(got, "You earned "+first.Name+", by hand: the ") || !strings.Contains(got, "yours to take") {
		t.Errorf("a certificate earned: %q", got)
	}
	st := certs.Standing{Held: -1, Next: 0, Name: first.Name, Needs: 3, Done: 1, Tasks: []certs.Task{
		{ID: "a", Name: first.Tasks[0].Name, Course: true, Courses: []string{store.CourseShort}, Runs: 1, Of: 2},
		{ID: "b", Name: first.Tasks[1].Name, Done: true, Way: store.WayLog},
	}}
	trials := []race.Summary{{Code: "abcdefghij", Name: "the Harbourmaster's Short Course", Course: store.CourseShort, Standing: true},
		{Code: "bcdefghijk", Name: "the Harbourmaster's Triangle", Course: store.CourseTriangle, Standing: true}}
	got = certificateWords(cat, &st, trials)
	for _, want := range []string{"Certificates: none yet.", "Toward " + first.Name + ", 1 of the 3 tasks it needs", "(1 so far)",
		"race enter abcdefghij (the Harbourmaster's Short Course)", "✓ " + first.Tasks[1].Name, "handbook certificates says how"} {
		if !strings.Contains(got, want) {
			t.Errorf("the log's certificates lack %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "bcdefghijk") {
		t.Errorf("a trial that counts toward nothing offered: %s", got)
	}
	trials[0].Toward = first.Name
	if got := summaryWords(&trials[0], time.Now()); !strings.Contains(got, "counts toward "+first.Name) ||
		!strings.HasPrefix(got, "the Harbourmaster's Short Course") {
		t.Errorf("a standing trial on the list: %q", got)
	}
	if got := raceRefusalWords(&race.Refusal{Reason: race.RefuseCertificate, Needs: first.Name}, time.Now()); !strings.Contains(got, "needs "+first.Name) {
		t.Errorf("a race refused for a certificate: %q", got)
	}
}

// TestCertificatesHeldAndProgress: the log names every certificate held,
// each with when, in which world and whether by hand, and each task of
// the next not yet done with how far it has come; after the last, that
// it is.
func TestCertificatesHeldAndProgress(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 11, 14, 9, 0, 0, 0, time.UTC)
	st := certs.Standing{Held: 1, HeldName: cat.Certificates[1].Name, Next: 2, Name: cat.Certificates[2].Name, Needs: 4, Done: 1,
		Earned: []certs.Earned{{Place: 0, At: at, World: 12, ByHand: true}, {Place: 1, At: at.AddDate(0, 0, 6), World: 13}},
		Tasks: []certs.Task{
			{Name: "Sail 8 NM alone", Measure: "distance", Have: 1.46, At: 8},
			{Name: "Ride out a gale", Measure: "gales", At: 1},
			{Name: "Come within 100 m of the edge, and back", Measure: "lip", At: 100, Closest: 640.3, Survived: true},
			{Name: "See ten places", Measure: "places-seen", Have: 2, At: 10},
			{Name: "Every weather", Measure: "every-weather", Have: 2, At: 4, Met: store.LogMetGale | store.LogMetNight},
			{Name: "Sail 3 NM alone", Measure: "distance", Have: 3.2, At: 3, Done: true, Way: store.WayLog},
		}}
	got := certificateWords(cat, &st, nil)
	for _, want := range []string{
		"Certificates: you hold " + cat.Certificates[0].Name + " (14 November 2026, world 12, by hand) and " +
			cat.Certificates[1].Name + " (20 November 2026, world 13).",
		"\n - Sail 8 NM alone: 1.4 of 8 NM\n", "\n - Ride out a gale\n",
		"\n - Come within 100 m of the edge, and back: closest so far 640 m\n", "\n - See ten places: 2 of 10\n",
		"\n - Every weather: gale ✓ · storm · fog · night ✓\n", "\n ✓ Sail 3 NM alone",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the log's certificates lack %q:\n%s", want, got)
		}
	}
	last := len(cat.Certificates) - 1
	master := certs.Standing{Held: last, HeldName: cat.Certificates[last].Name, Next: -1,
		Earned: []certs.Earned{{Place: last, At: at, World: 12}}}
	if got := certificateWords(cat, &master, nil); !strings.HasSuffix(got, cat.Certificates[last].Name+" is the last.") {
		t.Errorf("a Master's certificates: %q", got)
	}
	// Never the mark itself while a task is not done; none at the lip
	// before an approach is survived.
	if got := howFar(&certs.Task{Measure: "distance", Have: 2.99, At: 3}); got != "2.9 of 3 NM" {
		t.Errorf("2.99 of 3 miles: %q", got)
	}
	if got := howFar(&certs.Task{Measure: "lip", At: 500}); got != "" {
		t.Errorf("the lip, never approached: %q", got)
	}
}

// howToGolden holds how every task of the catalog's is done, a line
// each: the certificate, the task and its line. The page's own lines are
// held to the same file (client/src/ui/certtasks.test.ts), so a person
// and a machine sailor read the same.
const howToGolden = "testdata/certificates_howto.golden.txt"

// TestHowTo: no task of the catalog's is left without a line saying how
// it is done, every measure and every kind of course has words of its
// own, and the lines are the golden file's.
func TestHowTo(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	measures, courses := map[catalog.Measure]bool{}, map[catalog.CertificateCourse]bool{}
	for i := range cat.Certificates {
		ct := &cat.Certificates[i]
		for j := range ct.Tasks {
			task := &ct.Tasks[j]
			line := howTo(task)
			if line == "" || !strings.HasSuffix(line, ".") || strings.Contains(line, "  ") || strings.Contains(line, "%!") {
				t.Errorf("%s, %s: how it is done reads %q", ct.Name, task.Name, line)
			}
			if task.Measure != nil {
				measures[*task.Measure] = true
			}
			for _, c := range task.Courses {
				courses[c] = true
			}
			b.WriteString(ct.Name + "\t" + task.Name + "\t" + line + "\n")
		}
	}
	// Every measure there is, whether a task uses it yet or not.
	lines := map[string]catalog.Measure{}
	for _, m := range []catalog.Measure{catalog.MeasureDistance, catalog.MeasureEveryWeather, catalog.MeasureFalls, catalog.MeasureGales,
		catalog.MeasureLifeKinds, catalog.MeasureLip, catalog.MeasureNights, catalog.MeasurePlacesCharted, catalog.MeasurePlacesSeen,
		catalog.MeasureStormsOrFogs, catalog.MeasureWorlds} {
		at := 2.0
		line := howTo(&catalog.CertificateTask{Measure: &m, At: &at})
		if other, ok := lines[line]; line == "" || ok {
			t.Errorf("the measure %s reads %q, as %q does", m, line, other)
		}
		lines[line] = m
		delete(measures, m)
	}
	for m := range measures {
		t.Errorf("the catalog's measure %s is not among those walked", m)
	}
	for _, c := range []catalog.CertificateCourse{catalog.CertificateCourseShort, catalog.CertificateCourseLong, catalog.CertificateCourseTriangle,
		catalog.CertificateCourseLongTriangle, catalog.CertificateCourseIsland} {
		if courseNames[c] == "" {
			t.Errorf("the course %s has no name", c)
		}
		delete(courses, c)
	}
	for c := range courses {
		t.Errorf("the catalog's course %s is not among those walked", c)
	}
	if *update {
		if err := os.WriteFile(howToGolden, []byte(b.String()), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(howToGolden)
	if err != nil {
		t.Fatal(err)
	}
	if b.String() != string(want) {
		t.Errorf("how the tasks are done differs from %s (-update rewrites it; the page's lines are held to it too):\n%s", howToGolden, b.String())
	}
}

// TestHandbookLadder: the handbook's page of certificates lists the whole
// ladder from the catalog of the world sailed: each certificate with how
// many of its tasks it needs and the boats it opens, and every task with
// how it is done; and stays a page.
func TestHandbookLadder(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	c := NewCore(CoreConfig{})
	c.sea.Store(&Sea{Catalog: cat})
	page, r := c.handbookPage("certificates", "Iron Mary", "Ann", "")
	if r != nil {
		t.Fatal(r)
	}
	for i := range cat.Certificates {
		ct := &cat.Certificates[i]
		head := fmt.Sprintf("\n%s, any %d of %d; opens the ", ct.Name, ct.Needs, len(ct.Tasks))
		if !strings.Contains(page, head) {
			t.Errorf("the page lacks %q", head)
		}
		for j := range ct.Tasks {
			if line := "\n- " + ct.Tasks[j].Name + ": " + howTo(&ct.Tasks[j]); !strings.Contains(page, line) {
				t.Errorf("the page lacks %q", line)
			}
		}
	}
	if strings.Contains(page, "{{") || strings.Contains(page, " are:") || strings.Contains(page, " is:") {
		t.Errorf("the page: %s", page)
	}
	// About 1,745 by this estimate (5,229 bytes) with the five
	// certificates' twenty-nine tasks: the handbook's longest page, read
	// when an agent asks what a certificate needs.
	if n := estimateTokens(page); n > 1900 {
		t.Errorf("the page with its ladder is about %d tokens", n)
	}
}
