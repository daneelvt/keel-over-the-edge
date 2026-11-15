// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
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
	got = certificateWords(&st, trials)
	for _, want := range []string{"Certificates: none yet.", "Toward " + first.Name + ", 1 of the 3 tasks it needs", "(1 so far)",
		"race enter abcdefghij (the Harbourmaster's Short Course)", "✓ " + first.Tasks[1].Name} {
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
