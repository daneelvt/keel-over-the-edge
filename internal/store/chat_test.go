// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

func sailor(t *testing.T, s *store.Store, name string) store.AccountID {
	t.Helper()
	key := ""
	for _, r := range name {
		if r != ' ' {
			key += string(r | 0x20)
		}
	}
	id, err := s.CreateAccount(context.Background(), withBoat(storetest.NewAccount(name, key, sha256.Sum256([]byte(name)))))
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// TestTies: mutes and blocks are kept once, at most MaxTies, listed with
// names, ended, loaded whole; and go with either account.
func TestTies(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	ann, bob, cat := sailor(t, s, "Ann Bonny"), sailor(t, s, "Bob Read"), sailor(t, s, "Cat Teach")
	for range 2 {
		if err := s.Mute(ctx, ann, bob, true); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Block(ctx, ann, cat, true); err != nil {
		t.Fatal(err)
	}
	refused(t, exec(t, pool, "INSERT INTO mute (account_id, other_id) VALUES ($1, $1)", ann), "23514")
	rows, err := s.TiesOf(ctx, ann)
	if err != nil || len(rows) != 2 {
		t.Fatalf("ties: %v %v", rows, err)
	}
	mutes, blocks, err := s.Ties(ctx)
	if err != nil || len(mutes) != 1 || len(blocks) != 1 || mutes[0] != (store.Tie{Account: ann, Other: bob}) {
		t.Fatalf("ties loaded: %v %v %v", mutes, blocks, err)
	}
	if err := s.Mute(ctx, ann, bob, false); err != nil {
		t.Fatal(err)
	}
	// The limit: MaxTies mutes, then no more.
	must(t, pool, `INSERT INTO account (id, kind, owner_id) SELECT uuidv7(), 'ai', $2 FROM generate_series(1, $1)`, store.MaxTies, ann)
	must(t, pool, `INSERT INTO mute (account_id, other_id) SELECT $1, id FROM account WHERE kind = 'ai'`, cat)
	if err := s.Mute(ctx, cat, ann, true); !errors.Is(err, store.ErrTooManyTies) {
		t.Fatalf("a mute past the limit: %v", err)
	}
	if _, err := s.DeleteAccount(ctx, cat); err != nil {
		t.Fatal(err)
	}
	if _, blocks, _ := s.Ties(ctx); len(blocks) != 0 {
		t.Fatalf("a deleted account's block kept: %v", blocks)
	}
}

// TestReports: a report keeps its lines and those aboard; three reporters
// in a day rest the player, as one report that a child may be at risk
// does; the owner's warning sends a statement of reasons, whose one
// answer puts the report back in the queue; a line removed goes from
// every report; a purge too; a held report outlives the reported
// account's deletion and the sweep, one not held goes with it; and no
// line's text is anywhere in the database but in a report.
func TestReports(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	ann, bob, cat, dan := sailor(t, s, "Ann Bonny"), sailor(t, s, "Bob Read"), sailor(t, s, "Cat Teach"), sailor(t, s, "Dan Kidd")
	now := time.Now().UTC().Truncate(time.Microsecond)
	line := func(n uint64, from store.AccountID, name, text string, reported bool) store.ReportLine {
		return store.ReportLine{Line: n, At: now.Add(time.Duration(n) * time.Second), Sender: from, HasSender: true, Name: name, Text: text, Reported: reported}
	}
	report := func(by store.AccountID, byName, reason string, lines ...store.ReportLine) store.Made {
		t.Helper()
		m, err := s.MakeReport(ctx, store.NewReport{
			Source: store.ReportByPlayer, Reason: reason, Note: "a note", Reporter: by, HasReporter: true, ReporterName: byName,
			Reported: ann, HasReported: true, ReportedKind: store.Human, ReportedName: "Ann Bonny", Place: "aboard Ann Bonny’s boat",
			People:      []store.ReportPerson{{Name: "Ann Bonny", Band: "adult", Skipper: true}, {Name: byName, Band: "13-17"}},
			FollowUntil: now.Add(10 * time.Minute), Lines: lines,
		})
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	first := report(bob, "Bob Read", store.ReasonBullying, line(1, ann, "Ann Bonny", "zebrafish one", false), line(2, ann, "Ann Bonny", "zebrafish two", true))
	if first.Rested {
		t.Fatal("one report rested the player")
	}
	report(cat, "Cat Teach", store.ReasonHate, line(2, ann, "Ann Bonny", "zebrafish two", true))
	third := report(dan, "Dan Kidd", store.ReasonOther)
	if !third.Rested || third.Subject != ann {
		t.Fatalf("three reporters did not rest the player: %+v", third)
	}
	if tk, err := s.Talker(ctx, ann); err != nil || !tk.Rested {
		t.Fatalf("Ann's chat: %+v %v", tk, err)
	}
	if k, err := s.Knocker(ctx, ann); err != nil || !k.Rested {
		t.Fatalf("Ann's knocks are not rested: %+v %v", k, err)
	}

	r, err := s.Report(ctx, first.ID)
	if err != nil || len(r.Lines) != 2 || !r.Lines[1].Reported || r.Lines[0].Text != "zebrafish one" || len(r.People) != 2 || r.People[1].Band != "13-17" {
		t.Fatalf("the report: %+v %v", r, err)
	}
	if err := s.AddReportLines(ctx, first.ID, []store.ReportLine{line(3, bob, "Bob Read", "zebrafish three", false)}); err != nil {
		t.Fatal(err)
	}
	q, err := s.ReportQueue(ctx, 10)
	if err != nil || len(q) != 3 || q[0].Reports != 3 {
		t.Fatalf("the queue: %+v %v", q, err)
	}

	// A child may be at risk: ahead in the queue, and it rests at once.
	child, err := s.MakeReport(ctx, store.NewReport{Source: store.ReportByPlayer, Reason: store.ReasonChild, Reporter: ann, HasReporter: true,
		ReporterName: "Ann Bonny", Reported: bob, HasReported: true, ReportedKind: store.Human, ReportedName: "Bob Read"})
	if err != nil || !child.Rested {
		t.Fatalf("a child's report: %+v %v", child, err)
	}
	if q, _ := s.ReportQueue(ctx, 10); q[0].ID != child.ID || !q[0].Urgent {
		t.Fatalf("a child's report is not first: %+v", q)
	}
	if open, kids, oldest, err := s.ReportCounts(ctx); err != nil || open != 4 || kids != 1 || oldest.IsZero() {
		t.Fatalf("counts: %d %d %v %v", open, kids, oldest, err)
	}

	// Warned: every report on Ann closes, her rest lifts, she is told why;
	// she answers once, and the report is back.
	if err := s.ActOnReport(ctx, store.ReportAct{Report: first.ID, Action: store.ActionWarn, Account: ann, HasAcc: true, Name: "Ann Bonny",
		Kind: store.Human, Source: store.SourcePage, Close: true, All: true, Unrest: true,
		Tell: &store.Statement{Action: store.ActionWarn, Rule: "bullying or harassment", Seen: "unkind words"}}); err != nil {
		t.Fatal(err)
	}
	if q, _ := s.ReportQueue(ctx, 10); len(q) != 1 {
		t.Fatalf("Ann's reports did not close: %+v", q)
	}
	if tk, _ := s.Talker(ctx, ann); tk.Rested {
		t.Fatal("Ann's rest was not lifted")
	}
	st, err := s.Statements(ctx, ann)
	if err != nil || len(st) != 1 || st[0].Rule != "bullying or harassment" || !st[0].Read.IsZero() {
		t.Fatalf("statements: %+v %v", st, err)
	}
	if err := s.AnswerStatement(ctx, ann, st[0].ID, "I was joking"); err != nil {
		t.Fatal(err)
	}
	if err := s.AnswerStatement(ctx, ann, st[0].ID, "again"); !errors.Is(err, store.ErrAnsweredAlready) {
		t.Fatalf("a second answer: %v", err)
	}
	if r, _ := s.Report(ctx, first.ID); !r.Closed.IsZero() || len(r.Notes) != 1 || r.Notes[0].By != "player" {
		t.Fatalf("the answered report: %+v", r)
	}

	// A line removed goes from both reports that hold it.
	if err := s.ActOnReport(ctx, store.ReportAct{Report: first.ID, Action: store.ActionRemoveLine, Source: store.SourcePage,
		Line: 2, LineAt: now.Add(2 * time.Second)}); err != nil {
		t.Fatal(err)
	}
	if n := count(t, pool, "SELECT count(*) FROM report_line WHERE text = 'zebrafish two'"); n != 0 {
		t.Fatalf("a removed line is in %d reports", n)
	}
	// A purge takes every line of the report, from every copy.
	if err := s.ActOnReport(ctx, store.ReportAct{Report: first.ID, Action: store.ActionPurge, Source: store.SourcePage, Purge: true}); err != nil {
		t.Fatal(err)
	}
	if n := count(t, pool, "SELECT count(*) FROM report_line WHERE report_id = $1", first.ID); n != 0 {
		t.Fatalf("%d lines left after a purge", n)
	}

	// Held, a report outlives Bob's deletion and the sweep; not held, it
	// goes with him; a report he made keeps no name of him.
	held, err := s.MakeReport(ctx, store.NewReport{Source: store.ReportByPlayer, Reason: store.ReasonThreats, Reporter: cat, HasReporter: true,
		ReporterName: "Cat Teach", Reported: bob, HasReported: true, ReportedKind: store.Human, ReportedName: "Bob Read",
		Lines: []store.ReportLine{line(9, bob, "Bob Read", "zebrafish held", true)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ActOnReport(ctx, store.ReportAct{Report: held.ID, Action: store.ActionHold, Source: store.SourcePage, Hold: now.Add(store.HoldFor)}); err != nil {
		t.Fatal(err)
	}
	if err := s.ActOnReport(ctx, store.ReportAct{Report: held.ID, Action: store.ActionDismiss, Source: store.SourcePage, Close: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeleteAccount(ctx, bob); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Report(ctx, child.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a report not held outlived the reported account: %v", err)
	}
	r, err = s.Report(ctx, held.ID)
	if err != nil || len(r.Lines) != 1 || r.Lines[0].Name != "Bob Read" {
		t.Fatalf("the held report: %+v %v", r, err)
	}
	if r, _ := s.Report(ctx, first.ID); r.ReporterName != "a former sailor" || r.HasReporter {
		t.Fatalf("a deleted reporter's name kept: %+v", r)
	}
	must(t, pool, "UPDATE report SET closed_at = now() - interval '200 days'")
	n, err := s.DeleteReports(ctx, time.Now().Add(-store.ReportKeep))
	if err != nil || n == 0 {
		t.Fatalf("the sweep: %d %v", n, err)
	}
	if _, err := s.Report(ctx, held.ID); err != nil {
		t.Fatalf("the sweep took a held report: %v", err)
	}

	// No line's text is anywhere but in report_line.
	cols, err := pool.Query(ctx, `SELECT table_name, column_name FROM information_schema.columns
		WHERE table_schema = 'public' AND data_type IN ('text', 'jsonb', 'character varying', 'ARRAY')`)
	if err != nil {
		t.Fatal(err)
	}
	var where [][2]string
	for cols.Next() {
		var tbl, col string
		if err := cols.Scan(&tbl, &col); err != nil {
			t.Fatal(err)
		}
		where = append(where, [2]string{tbl, col})
	}
	cols.Close()
	for _, w := range where {
		if w[0] == "report_line" {
			continue
		}
		q := fmt.Sprintf(`SELECT count(*) FROM %q WHERE %q::text LIKE '%%zebrafish%%'`, w[0], w[1])
		if n := count(t, pool, q); n != 0 {
			t.Errorf("a line's text in %s.%s", w[0], w[1])
		}
	}
}

func count(t *testing.T, pool interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}, sql string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}
