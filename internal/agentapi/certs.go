// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"fmt"
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
// stands, on going to sea as a line, and in race's list as what a trial
// counts toward. The tools are the same; only their words grow.

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

// certificateWords are where a sailor stands, for its log: the
// certificate held, and the next one's tasks, ticked, each course task
// with the codes of the Harbourmaster's trials in its boat that count.
func certificateWords(st *certs.Standing, trials []race.Summary) string {
	var b strings.Builder
	if st.Held >= 0 {
		b.WriteString("Certificates: you hold " + st.HeldName)
		if st.ByHand {
			b.WriteString(", by hand")
		}
		b.WriteString(".")
	} else {
		b.WriteString("Certificates: none yet.")
	}
	if st.Next < 0 {
		b.WriteString(" It is the last.")
		return b.String()
	}
	fmt.Fprintf(&b, " Toward %s, %d of the %d tasks it needs, any of these %d, sailed alone:", st.Name, min(st.Done, st.Needs),
		st.Needs, len(st.Tasks))
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
		}
		b.WriteString(line)
	}
	return b.String()
}
