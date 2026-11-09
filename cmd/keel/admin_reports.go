// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/owner"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The reports as keel admin writes them: the queue a row a report, a
// child's safety marked first, and a report whole. What players wrote,
// lines and notes, is quoted, so that nothing in it reaches the terminal
// as anything but text.

// reasonWords are the reports' reasons as the owner reads them.
var reasonWords = map[string]string{
	store.ReasonChild: "a child may be at risk", store.ReasonSexual: "sexual content", store.ReasonBullying: "bullying or harassment",
	store.ReasonHate: "hate", store.ReasonThreats: "threats or self-harm", store.ReasonScam: "a scam or spam",
	store.ReasonCheating: "cheating", store.ReasonOther: "something else", store.ReasonYoung: "said they are under 13",
}

// reasonOf is a reason in words, or as keel gave it.
func reasonOf(r string) string {
	if w, ok := reasonWords[r]; ok {
		return w
	}
	return r
}

// sourceWords are where a report came from.
var sourceWords = map[string]string{
	store.ReportByPlayer: "a player's report", store.ReportByNotice: "a notice from outside the game", store.ReportByGame: "the game",
}

// isoStamp is an answer's RFC 3339 time to the minute in UTC, or what
// keel gave when it is none.
func isoStamp(s string) string {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return s
	}
	return t.UTC().Format("2006-01-02 15:04 UTC")
}

// waited is how long since an answer's time: "12m", "3h 5m", "2d 4h".
func waited(s string, now time.Time) string {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return "?"
	}
	d := max(0, now.Sub(t))
	switch {
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d/time.Minute))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh %dm", int(d/time.Hour), int(d%time.Hour/time.Minute))
	}
	return fmt.Sprintf("%dd %dh", int(d/(24*time.Hour)), int(d%(24*time.Hour)/time.Hour))
}

// sailor is a name, quoted, and marked when it is a machine sailor's.
func sailor(name string, machine bool) string {
	if name == "" {
		return "nobody named"
	}
	if machine {
		return fmt.Sprintf("%q (machine sailor)", name)
	}
	return fmt.Sprintf("%q", name)
}

// writeQueue writes the reports open, in keel's order.
func writeQueue(w io.Writer, rows []owner.QueueRow, now time.Time) {
	if len(rows) == 0 {
		fmt.Fprintln(w, "No report is open.")
		return
	}
	fmt.Fprintf(w, "%s open.\n", count(len(rows), "report"))
	for _, r := range rows {
		mark := ""
		if r.Urgent {
			mark = "CHILD SAFETY  "
		}
		who := sailor(r.Reported, r.Machine)
		if r.Reporter != "" {
			who = sailor(r.Reporter, false) + " reported " + who
		} else {
			who = "about " + who
		}
		fmt.Fprintf(w, "%s%s  %s, waiting %s  %s, %s: %s\n", mark, r.ID, isoStamp(r.Made), waited(r.Made, now), r.Reason,
			reasonOf(r.Reason), who)
		var more []string
		if r.Place != "" {
			more = append(more, fmt.Sprintf("%q", r.Place))
		}
		more = append(more, fmt.Sprintf("%s open on them", count(int(r.Reports), "report")), count(int(r.Lines), "line")+" held")
		if r.Answered {
			more = append(more, "AN ANSWER FROM THE PLAYER WAITING")
		}
		fmt.Fprintf(w, "    %s; %s\n", sourceWords[r.Source], strings.Join(more, "; "))
	}
}

// writeReport writes a report whole, its lines in time order.
func writeReport(w io.Writer, r *owner.ReportJSON) {
	p := func(format string, args ...any) { fmt.Fprintf(w, format+"\n", args...) }
	urgent := ""
	if r.Reason == store.ReasonChild {
		urgent = "CHILD SAFETY: "
	}
	p("%sreport %s, %s (%s), %s, made %s", urgent, r.ID, r.Reason, reasonOf(r.Reason), sourceWords[r.Source], isoStamp(r.Made))
	if r.Reporter != "" {
		p("  reported by %s", sailor(r.Reporter, false))
	}
	reported := sailor(r.Reported, r.Machine)
	if r.Account != "" {
		reported += ", " + r.Account
	}
	if r.Owner != "" {
		reported += "; its human " + r.Owner
	}
	p("  reported: %s", reported)
	if r.Place != "" {
		p("  where: %q", r.Place)
	}
	if len(r.People) > 0 {
		var aboard []string
		for _, x := range r.People {
			marks := []string{x.Band}
			if x.Machine {
				marks = append(marks, "machine sailor")
			}
			if x.Skipper {
				marks = append(marks, "skipper")
			}
			aboard = append(aboard, fmt.Sprintf("%q (%s)", x.Name, strings.Join(marks, ", ")))
		}
		p("  aboard: %s", strings.Join(aboard, ", "))
	}
	if r.Note != "" {
		p("  the note: %q", r.Note)
	}
	if r.Taking != "" {
		p("  still taking the next 10 minutes, until %s", isoStamp(r.Taking))
	}
	if n := r.Notice; n != nil {
		p("  the notice: from %q, reached at %q", n.Who, n.Contact)
		if n.Sailor != "" {
			p("    the sailor named: %q", n.Sailor)
		}
		if n.Happened != "" {
			p("    where and when: %q", n.Happened)
		}
		p("    what: %q", n.What)
	}
	if r.Closed != "" {
		p("  closed %s: %s", isoStamp(r.Closed), r.Outcome)
	} else {
		p("  open")
	}
	if r.Held != "" {
		p("  held until %s", isoStamp(r.Held))
	}
	if r.Referred != "" {
		p("  referred to %q", r.Referred)
	}
	if len(r.Lines) == 0 {
		p("  no lines held")
	} else {
		p("  %s held (remove one with -line N -at TIME):", count(len(r.Lines), "line"))
		for _, l := range r.Lines {
			mark := ""
			if l.Reported {
				mark = "  <- REPORTED"
			}
			p("    -line %d -at %s  %s: %q%s", l.Line, l.At, sailor(l.Name, l.Machine), l.Text, mark)
		}
	}
	for _, n := range r.Notes {
		by := "the owner"
		if n.By == "player" {
			by = "the player"
		}
		p("  %s, %s: %q", isoStamp(n.At), by, n.Text)
	}
}
