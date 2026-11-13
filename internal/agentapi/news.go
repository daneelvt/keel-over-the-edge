// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/logbook"
	"github.com/daneelvt/keel-over-the-edge/internal/news"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// News is the world's news as a machine sailor reads it: news.Service.
type News interface {
	ParseDay(text string) (time.Time, error)
	Edition(ctx context.Context, reader store.AccountID, day time.Time) (news.Edition, error)
}

var _ News = (*news.Service)(nil)

// newsArgs are news's.
type newsArgs struct {
	Day string `json:"day,omitempty"`
	Log bool   `json:"log,omitempty"`
}

// newsWords answer news: the day's edition as the machine sailor reads
// it, every sailor's name marked as player-written and as a human's or a
// machine's; or, with log, its own log.
func newsWords(ctx context.Context, s *Sea, account store.AccountID, a *newsArgs) (string, *refusal) {
	if a.Log {
		return logWords(ctx, s, account)
	}
	if s.News == nil {
		return "No news sheet is printed in this world.", nil
	}
	day, err := s.News.ParseDay(a.Day)
	if err != nil {
		return "", refuse(refusedArgs, "day is a date, 2006-01-02, of this world's editions.")
	}
	e, err := s.News.Edition(ctx, account, day)
	if errors.Is(err, news.ErrNoEdition) {
		return "", refuse(refusedArgs, "No edition of that day in this world: ask for one of its days, or none for today's.")
	}
	if err != nil {
		return "", refuse(refusedBusy, wordsBusy)
	}
	return editionWords(&e), nil
}

// zoneWords are a zone as words: "New York".
func zoneWords(zone string) string {
	if i := strings.LastIndexByte(zone, '/'); i >= 0 {
		zone = zone[i+1:]
	}
	return strings.ReplaceAll(zone, "_", " ")
}

// dateWords are a day's date as words: "Thursday 12 November".
func dateWords(day string) string {
	d, err := time.Parse(time.DateOnly, day)
	if err != nil {
		return day
	}
	return d.Format("Monday 2 January")
}

// storyWords are a story's words, its names filled in.
func storyWords(st *news.Story) string {
	text := st.Text
	for i, n := range st.Names {
		slot := "{" + strconv.Itoa(i) + "}"
		at := strings.Index(text, slot)
		if at < 0 {
			continue
		}
		w := nameWords(&n)
		if at == 0 || strings.HasSuffix(text[:at], ". ") {
			w = capitalWords(w)
		}
		text = text[:at] + w + text[at+len(slot):]
	}
	out := st.Head + ". " + text
	if st.X != nil && st.Y != nil {
		out += " At " + chart.Format(*st.X, *st.Y) + "."
	}
	return out
}

// capitalWords is w with its first letter a capital.
func capitalWords(w string) string {
	if w != "" && w[0] >= 'a' && w[0] <= 'z' {
		return string(w[0]-'a'+'A') + w[1:]
	}
	return w
}

// nameWords are a name in a story as words: a sailor's marked as a
// player's, and as a human's or a machine's.
func nameWords(n *news.Name) string {
	switch n.Kind {
	case news.NameHuman:
		return playerText(n.Name) + " (human)"
	case news.NameMachine:
		return playerText(n.Name) + " (machine)"
	case news.NameBoat:
		if n.Name != "" {
			return "the " + playerText(n.Name)
		}
		if n.Type != "" {
			return article(n.Type)
		}
		return "a boat"
	case news.NameSailor:
		return "a sailor"
	}
	return chart.FormerSailor
}

// editionWords are an edition as words.
func editionWords(e *news.Edition) string {
	var b strings.Builder
	fmt.Fprintf(&b, "The Shipping Intelligence, No. %d · %s (the day by %s's clock)", e.Number, dateWords(e.Day), zoneWords(e.Zone))
	if !e.Set {
		b.WriteString(" · today's, filling as the day goes")
	}
	b.WriteString("\n")
	b.WriteString(strings.ReplaceAll(e.FiguresText, " ⚙", ""))
	b.WriteString("\n")
	for i := range e.Lead {
		b.WriteString(storyWords(&e.Lead[i]) + "\n")
	}
	if len(e.Stories) == 0 {
		b.WriteString("No stories yet.\n")
	}
	for i := range e.Stories {
		fmt.Fprintf(&b, "%d. %s\n", i+1, storyWords(&e.Stories[i]))
	}
	if len(e.Shipmates) > 0 {
		b.WriteString("From your shipmates:\n")
		for i := range e.Shipmates {
			b.WriteString("- " + storyWords(&e.Shipmates[i]) + "\n")
		}
	}
	for _, n := range e.Notices {
		fmt.Fprintf(&b, "Notices to Mariners: %s. The falls take this world at %s.\n", n.Head,
			time.UnixMilli(n.EndsAt).UTC().Format("Monday 15:04 UTC"))
	}
	var earlier []string
	for _, d := range e.Days {
		if d.Day != e.Day && len(earlier) < 7 {
			earlier = append(earlier, fmt.Sprintf("%s (No. %d)", d.Day, d.Number))
		}
	}
	if len(earlier) > 0 {
		b.WriteString("Other editions: " + strings.Join(earlier, ", ") + ": call news with day.")
	}
	return strings.TrimRight(b.String(), "\n")
}

// logWords answer news with log: the machine sailor's own log, its
// figures, this world's days, the collection's counts by group and the
// latest entries.
func logWords(ctx context.Context, s *Sea, account store.AccountID) (string, *refusal) {
	if s.Log == nil {
		return "No log is kept in this world.", nil
	}
	l, err := s.Log(ctx, account)
	if errors.Is(err, logbook.ErrNotFound) {
		return "Your log is empty: it begins with your first voyage.", nil
	}
	if err != nil {
		return "", refuse(refusedBusy, wordsBusy)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "The log of %s:\n", playerText(l.Name)+" (machine)")
	r := &l.Record
	parts := []string{
		fmt.Sprintf("sailed %s NM", news.Miles(r.DistanceM)),
		fmt.Sprintf("%d voyages", r.Voyages+r.Aboard),
		fmt.Sprintf("%d worlds", r.Worlds),
		fmt.Sprintf("%d places charted", r.Charted),
		fmt.Sprintf("%d over the falls", r.Falls),
	}
	if r.ClosestM != nil {
		parts = append(parts, fmt.Sprintf("closest to the falls %s m", strconv.FormatFloat(math.Round(*r.ClosestM*10)/10, 'f', -1, 64)))
	}
	if r.Gales > 0 {
		parts = append(parts, fmt.Sprintf("%d gales ridden out", r.Gales))
	}
	parts = append(parts, fmt.Sprintf("%d bumps (%d at fault)", r.Bumps, r.BumpsAt))
	b.WriteString(capitalWords(strings.Join(parts, " · ")) + ".\n")
	if w := l.World; w != nil && len(w.Days) > 0 {
		fmt.Fprintf(&b, "World %d, its days:\n", w.Number)
		for _, d := range w.Days {
			line := fmt.Sprintf(" %s · %s NM · %d voyages", dateWords(d.Date), news.Miles(d.RunM), len(d.Voyages))
			var notes []string
			for _, e := range d.Entries {
				if n := entryWords(&e); n != "" && len(notes) < 6 {
					notes = append(notes, n)
				}
			}
			if len(notes) > 0 {
				line += " · " + strings.Join(notes, "; ")
			}
			b.WriteString(line + "\n")
		}
	} else {
		b.WriteString("Nothing yet this world.\n")
	}
	var groups []string
	for _, g := range l.Groups {
		groups = append(groups, fmt.Sprintf("%s %d of %d", g.ID, g.Found, len(g.Kinds)))
	}
	if len(groups) > 0 {
		b.WriteString("The collection: " + strings.Join(groups, " · ") + ".")
	}
	return strings.TrimRight(b.String(), "\n"), nil
}

// entryWords are an entry of the log as words, "" for one not told.
func entryWords(e *logbook.Entry) string {
	switch e.Kind {
	case store.LogCharted:
		return "charted " + e.Title
	case store.LogSighted:
		return "sighted " + e.Title + " aboard another's boat"
	case store.LogMet:
		return "met " + strings.ToLower(e.Title)
	case store.LogFound:
		return "first " + strings.ReplaceAll(e.Find, "-", " ") + " for the collection"
	case store.LogBump:
		return "a bump"
	}
	return ""
}
