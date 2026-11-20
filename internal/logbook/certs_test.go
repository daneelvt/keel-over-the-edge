// SPDX-License-Identifier: AGPL-3.0-only

package logbook

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/certs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A log's head names the certificate its sailor holds to whoever may read
// it, and the log every one held, with when, in which world and whether
// by hand; the sailor alone, and its machine sailor's player, see the
// tasks that counted and where it stands toward the next, each course's
// task with the Harbourmaster's course that counts and each of the log's
// not yet done with how far it has come; after the last, the
// certificates alone.
func TestLogCertificates(t *testing.T) {
	svc, _, _ := testLogs(t)
	ctx := context.Background()
	earned := time.Date(2026, 11, 14, 9, 30, 0, 0, time.UTC)
	standings := map[store.AccountID]certs.Standing{
		ann: {Held: 0, HeldName: "Deckhand", ByHand: true, Next: 1, Name: "Helm", Needs: 4, Done: 2, Tasks: []certs.Task{
			{Name: "The Triangle, bronze", Course: true, Courses: []string{store.CourseTriangle}, Runs: 1, Of: 2},
			{Name: "Sail 3 NM alone", Done: true, Way: store.WayLog, Measure: "distance", Have: 3.2, At: 3},
			{Name: "The Long Course, bronze", Course: true, Courses: []string{store.CourseLong}, Done: true, Way: store.WayHand, Runs: 1, Of: 2},
			{Name: "Sail 8 NM alone", Measure: "distance", Have: 1.4567, At: 8},
			{Name: "See ten places", Measure: "places-seen", Have: 2, At: 10},
			{Name: "Come within 500 m of the edge, and back", Measure: "lip", At: 500, Closest: 640.4, Survived: true},
			{Name: "Come within 100 m of the edge, and back", Measure: "lip", At: 100},
			{Name: "Every weather", Measure: "every-weather", Have: 2, At: 4, Met: store.LogMetGale | store.LogMetNight},
		}, Earned: []certs.Earned{{Place: 0, At: earned, World: 12, ByHand: true,
			Tasks: []certs.EarnedTask{{Task: 0, Way: store.WayHand}, {Task: 1, Way: store.WayLog}, {Task: 3, Way: store.WayLog}}}}},
		kit: {Held: 4, HeldName: "Master", Next: -1, Earned: []certs.Earned{{Place: 0, At: earned, World: 9}, {Place: 1, At: earned, World: 10},
			{Place: 2, At: earned, World: 11}, {Place: 3, At: earned, World: 12}, {Place: 4, At: earned, World: 13, ByHand: true}}},
		mary: {Held: -1, Next: 0, Name: "Deckhand", Needs: 3},
	}
	svc.cfg.Standing = func(_ context.Context, id store.AccountID) (certs.Standing, error) {
		if st, ok := standings[id]; ok {
			return st, nil
		}
		return certs.Standing{Held: -1, Next: 0, Name: "Deckhand", Needs: 3}, nil
	}
	svc.cfg.Trials = func(context.Context, store.AccountID) (map[string]string, error) {
		return map[string]string{store.CourseTriangle: "tritritrit"}, nil
	}
	own, err := svc.Own(ctx, ann, 0)
	if err != nil {
		t.Fatal(err)
	}
	if c := own.Certificate; c == nil || c.Name != "Deckhand" || !c.ByHand || c.Last || c.Pendant != 1 {
		t.Errorf("Ann's certificate: %+v", c)
	}
	tw := own.Toward
	if tw == nil || tw.Name != "Helm" || tw.Needs != 4 || tw.Done != 2 || len(tw.Tasks) != 8 {
		t.Fatalf("Ann's way toward Helm: %+v", tw)
	}
	if k := tw.Tasks[0]; !k.Course || k.Done || k.Runs != 1 || k.Of != 2 || k.Code != "tritritrit" || k.Way != "" {
		t.Errorf("the triangle's task: %+v", k)
	}
	if k := tw.Tasks[1]; k.Course || !k.Done || k.Way != store.WayLog || k.Code != "" {
		t.Errorf("the miles' task: %+v", k)
	}
	if k := tw.Tasks[2]; !k.Done || k.Way != store.WayHand || k.Code != "" {
		t.Errorf("the long course's task, with none open: %+v", k)
	}
	// The log itself says nothing of how far a task has come, nor of the
	// certificates held before the highest: its page of certificates does.
	if k := tw.Tasks[3]; k.Have != 0 || k.At != 0 {
		t.Errorf("the log tells a task's progress: %+v", k)
	}
	page, err := svc.Certificates(ctx, ann, Who{})
	if err != nil {
		t.Fatal(err)
	}
	if c := page.Certificate; c == nil || c.Name != "Deckhand" || !c.ByHand || c.Pendant != 1 {
		t.Errorf("Ann's certificate on its page: %+v", c)
	}
	tw = page.Toward
	if tw == nil || tw.Name != "Helm" || tw.Needs != 4 || tw.Done != 2 || len(tw.Tasks) != 8 || tw.Tasks[0].Code != "tritritrit" {
		t.Fatalf("Ann's way toward Helm on its page: %+v", tw)
	}
	// A task done says no more of how far; one of the log not yet done
	// does: miles to a hundredth, rounded down; a count; the lip's
	// closest approach, none before one is survived; the weather met.
	if k := tw.Tasks[1]; k.Have != 0 || k.At != 0 {
		t.Errorf("the miles' task, done: %+v", k)
	}
	if k := tw.Tasks[3]; k.Have != 1.45 || k.At != 8 || k.Closest != nil || k.Met != nil {
		t.Errorf("eight miles, 1.4567 sailed: %+v", k)
	}
	if k := tw.Tasks[4]; k.Have != 2 || k.At != 10 {
		t.Errorf("ten places, two seen: %+v", k)
	}
	if k := tw.Tasks[5]; k.Closest == nil || *k.Closest != 640 || k.At != 500 || k.Have != 0 {
		t.Errorf("the lip, 640 m off: %+v", k)
	}
	if k := tw.Tasks[6]; k.Closest != nil || k.At != 100 {
		t.Errorf("the lip, never approached: %+v", k)
	}
	if k := tw.Tasks[7]; !slices.Equal(k.Met, []string{MetGale, MetNight}) || k.Have != 0 || k.At != 0 {
		t.Errorf("every weather: %+v", k)
	}
	// Her Deckhand: when, in which world, by hand, and the tasks that
	// counted.
	if c := page.Held; len(c) != 1 || c[0].Place != 0 || c[0].At != earned.UnixMilli() || c[0].World != 12 || !c[0].ByHand ||
		!slices.Equal(c[0].Tasks, []EarnedTask{{Task: 0, Way: store.WayHand}, {Task: 1, Way: store.WayLog}, {Task: 3, Way: store.WayLog}}) {
		t.Errorf("Ann's certificates: %+v", c)
	}
	// Another reads Ann's: the certificate, when, where and by hand; never
	// the tasks that counted, nor the way toward the next.
	other, err := svc.ByName(ctx, kit, "Ann", 0)
	if err != nil {
		t.Fatal(err)
	}
	if other.Certificate == nil || other.Toward != nil {
		t.Errorf("Ann's log as Kit reads it: %+v, %+v", other.Certificate, other.Toward)
	}
	theirs, err := svc.Certificates(ctx, kit, Who{Name: "Ann"})
	if err != nil {
		t.Fatal(err)
	}
	if c := theirs.Held; len(c) != 1 || c[0].At != earned.UnixMilli() || c[0].World != 12 || !c[0].ByHand || c[0].Tasks != nil ||
		theirs.Toward != nil || theirs.Certificate == nil {
		t.Errorf("Ann's certificates as Kit reads them: %+v", theirs)
	}
	if b, _ := json.Marshal(theirs); strings.Contains(string(b), "toward") || strings.Contains(string(b), "tasks") {
		t.Errorf("another's certificates tell the tasks: %s", b)
	}
	// A log the reader may not read keeps its certificates too.
	if _, err := svc.Certificates(ctx, ann, Who{Name: "Tom"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("the certificates of a log kept from the reader: %v", err)
	}
	b, err := json.Marshal(other)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw["toward"]; ok {
		t.Errorf("another's log tells the way toward the next: %s", b)
	}
	if c, _ := raw["certificate"].(map[string]any); c["pendant"] != 1.0 {
		t.Errorf("Ann's pendant as Kit reads it: %s", b)
	}
	// After the last, the certificate alone.
	kits, err := svc.Own(ctx, kit, 0)
	if err != nil {
		t.Fatal(err)
	}
	if kits.Certificate == nil || !kits.Certificate.Last || kits.Certificate.Pendant != 5 || kits.Toward != nil {
		t.Errorf("Kit, a Master: %+v, %+v", kits.Certificate, kits.Toward)
	}
	kitsPage, err := svc.Certificates(ctx, kit, Who{})
	if err != nil {
		t.Fatal(err)
	}
	if c := kitsPage.Held; len(c) != 5 || c[0].Place != 0 || c[4].Place != 4 || !c[4].ByHand || c[4].World != 13 || kitsPage.Toward != nil {
		t.Errorf("Kit's certificates: %+v", kitsPage)
	}
	// A machine sailor's player sees its way; none held, no certificate.
	m, err := svc.Machine(ctx, ann, mary, 0)
	if err != nil {
		t.Fatal(err)
	}
	if m.Certificate != nil || m.Toward == nil || m.Toward.Name != "Deckhand" {
		t.Errorf("Iron Mary's log: %+v, %+v", m.Certificate, m.Toward)
	}
	mp, err := svc.Certificates(ctx, ann, Who{Machine: mary})
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := json.Marshal(mp); mp.Toward == nil || len(mp.Held) != 0 || !strings.Contains(string(b), `"certificates":[]`) {
		t.Errorf("Iron Mary's certificates: %s", b)
	}
}
