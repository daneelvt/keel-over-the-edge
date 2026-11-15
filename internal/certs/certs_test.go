// SPDX-License-Identifier: AGPL-3.0-only

package certs

import (
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

func ptr[T any](v T) *T { return &v }

// TestCourseTasks: a course task is done by hand with one run alone by
// hand to its medal; with the autopilot, by as many runs as its venture
// asks, each on a different course if it asks them apart; one asking for
// a run on each of its courses wants them all.
func TestCourseTasks(t *testing.T) {
	both := catalog.CertificateTask{ID: "both", Courses: []catalog.CertificateCourse{catalog.CertificateCourseTriangle, catalog.CertificateCourseLong},
		Hand:    &catalog.CertificateWay{Medal: catalog.MedalSilver, Each: ptr(true)},
		Venture: &catalog.CertificateWay{Medal: catalog.MedalSilver, Runs: ptr(4)}}
	island := catalog.CertificateTask{ID: "island", Courses: []catalog.CertificateCourse{catalog.CertificateCourseIsland},
		Hand:    &catalog.CertificateWay{Medal: catalog.MedalBronze},
		Venture: &catalog.CertificateWay{Medal: catalog.MedalBronze, Runs: ptr(2), Apart: ptr(true)}}
	run := func(course, name, medal string, piloted bool) store.TrialRun {
		return store.TrialRun{Course: course, CourseName: name, Medal: medal, Piloted: piloted}
	}
	for _, c := range []struct {
		name string
		task *catalog.CertificateTask
		runs []store.TrialRun
		way  string
	}{
		{"silver on the triangle alone", &both, []store.TrialRun{run(store.CourseTriangle, "t", "gold", false)}, ""},
		{"silver on both by hand", &both, []store.TrialRun{run(store.CourseTriangle, "t", "silver", false),
			run(store.CourseLong, "l", "harbourmaster", false)}, store.WayHand},
		{"one of both piloted", &both, []store.TrialRun{run(store.CourseTriangle, "t", "silver", true),
			run(store.CourseLong, "l", "silver", false)}, ""},
		{"silver four times on the autopilot", &both, []store.TrialRun{run(store.CourseTriangle, "t", "silver", true),
			run(store.CourseTriangle, "t", "silver", true), run(store.CourseLong, "l", "gold", true),
			run(store.CourseTriangle, "t", "silver", true)}, store.WayPilot},
		{"bronze by hand on an island", &island, []store.TrialRun{run(store.CourseIsland, "a", "bronze", false)}, store.WayHand},
		{"finished, no medal", &island, []store.TrialRun{run(store.CourseIsland, "a", "", false)}, ""},
		{"the same island twice on the autopilot", &island, []store.TrialRun{run(store.CourseIsland, "a", "bronze", true),
			run(store.CourseIsland, "a", "silver", true)}, ""},
		{"two islands on the autopilot", &island, []store.TrialRun{run(store.CourseIsland, "a", "bronze", true),
			run(store.CourseIsland, "b", "silver", true)}, store.WayPilot},
	} {
		got := taskOf(c.task, c.runs, &store.SoloLog{})
		if got.Done != (c.way != "") || got.Way != c.way {
			t.Errorf("%s: done %v by %q, want %q", c.name, got.Done, got.Way, c.way)
		}
	}
}

// TestLogTasks: each measure of the log reaches its mark, the lip's at
// most.
func TestLogTasks(t *testing.T) {
	solo := store.SoloLog{Distance: 3 * 1852, Places: 3, LifeKinds: 1, Least: 90, Survived: true,
		Weather: store.LogMetGale | store.LogMetStorm | store.LogMetNight}
	for _, c := range []struct {
		m    catalog.Measure
		at   float64
		want bool
	}{
		{catalog.MeasureDistance, 3, true}, {catalog.MeasureDistance, 3.1, false}, {catalog.MeasurePlacesSeen, 3, true},
		{catalog.MeasureLifeKinds, 2, false}, {catalog.MeasureLip, 100, true}, {catalog.MeasureLip, 20, false},
		{catalog.MeasureEveryWeather, 1, false}, {catalog.MeasureNights, 1, false},
	} {
		if got := reached(c.m, c.at, &solo); got != c.want {
			t.Errorf("%s at %v: %v", c.m, c.at, got)
		}
	}
	solo.Weather |= store.LogMetFog
	if !reached(catalog.MeasureEveryWeather, 1, &solo) {
		t.Error("every weather met")
	}
}

// TestNeedsAndLine: the catalog's ladder opens each boat by one
// certificate, the Jolly boat by none; a later certificate opens what an
// earlier one does; the owner's card reads a standing in a line.
func TestNeedsAndLine(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	l := New(cat)
	if l.Len() != 5 {
		t.Fatalf("%d certificates", l.Len())
	}
	for i := range cat.Boats {
		b := &cat.Boats[i]
		if (b.Fleet == catalog.FleetSailor) != (l.Opener(string(b.ID)) < 0) {
			t.Errorf("%s opened by %d", b.ID, l.Opener(string(b.ID)))
		}
	}
	last := string(cat.Certificates[4].ID)
	for i := range cat.Boats {
		if needs := l.Needs(&store.SailRights{Held: []string{last}}, string(cat.Boats[i].ID)); needs != "" {
			t.Errorf("a Master's %s needs %s", cat.Boats[i].ID, needs)
		}
	}
	st := Standing{Held: 1, HeldName: "Helm", ByHand: true, Next: 2, Name: "Skipper", Needs: 4, Done: 2}
	if got := st.Line(); got != "Helm · by hand · Skipper 2 of 4" {
		t.Errorf("line %q", got)
	}
	if got := (&Standing{Held: -1, Next: 0, Name: "Deckhand", Needs: 3}).Line(); got != "none yet · Deckhand 0 of 3" {
		t.Errorf("line %q", got)
	}
}
