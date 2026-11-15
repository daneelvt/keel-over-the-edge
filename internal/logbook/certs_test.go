// SPDX-License-Identifier: AGPL-3.0-only

package logbook

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/certs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A log's head names the certificate its sailor holds to whoever may read
// it; the sailor alone, and its machine sailor's player, see where it
// stands toward the next, each course's task with the Harbourmaster's
// course that counts; after the last, the certificate alone.
func TestLogCertificates(t *testing.T) {
	svc, _, _ := testLogs(t)
	ctx := context.Background()
	standings := map[store.AccountID]certs.Standing{
		ann: {Held: 0, HeldName: "Deckhand", ByHand: true, Next: 1, Name: "Helm", Needs: 4, Done: 2, Tasks: []certs.Task{
			{Name: "The Triangle, bronze", Course: true, Courses: []string{store.CourseTriangle}, Runs: 1, Of: 2},
			{Name: "Sail 3 NM alone", Done: true, Way: store.WayLog},
			{Name: "The Long Course, bronze", Course: true, Courses: []string{store.CourseLong}, Done: true, Way: store.WayHand, Runs: 1, Of: 2},
		}},
		kit:  {Held: 4, HeldName: "Master", Next: -1},
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
	if tw == nil || tw.Name != "Helm" || tw.Needs != 4 || tw.Done != 2 || len(tw.Tasks) != 3 {
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
	// Another reads Ann's: the certificate, never the way toward the next.
	other, err := svc.ByName(ctx, kit, "Ann", 0)
	if err != nil {
		t.Fatal(err)
	}
	if other.Certificate == nil || other.Toward != nil {
		t.Errorf("Ann's log as Kit reads it: %+v, %+v", other.Certificate, other.Toward)
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
	// A machine sailor's player sees its way; none held, no certificate.
	m, err := svc.Machine(ctx, ann, mary, 0)
	if err != nil {
		t.Fatal(err)
	}
	if m.Certificate != nil || m.Toward == nil || m.Toward.Name != "Deckhand" {
		t.Errorf("Iron Mary's log: %+v, %+v", m.Certificate, m.Toward)
	}
}
