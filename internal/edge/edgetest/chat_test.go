// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"bytes"
	"context"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/chat"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/review"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// lockedBuffer is a log's buffer written by many goroutines.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// reportStore is the reports' store in memory: it keeps what a report
// copied, and finds names.
type reportStore struct {
	mu    sync.Mutex
	names map[store.AccountID]string
	made  []store.NewReport
	after [][]store.ReportLine
}

func (r *reportStore) Talker(_ context.Context, id store.AccountID) (store.Talker, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return store.Talker{Kind: store.Human, Human: id, Name: r.names[id]}, nil
}

func (r *reportStore) MakeReport(_ context.Context, n store.NewReport) (store.Made, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.made = append(r.made, n)
	return store.Made{ID: store.ReportID{byte(len(r.made))}, At: time.Now()}, nil
}

func (r *reportStore) AddReportLines(_ context.Context, _ store.ReportID, lines []store.ReportLine) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.after = append(r.after, lines)
	return nil
}

func (r *reportStore) Report(context.Context, store.ReportID) (store.Report, error) {
	return store.Report{}, store.ErrNotFound
}
func (r *reportStore) ReportQueue(context.Context, int) ([]store.QueueItem, error) { return nil, nil }
func (r *reportStore) ReportCounts(context.Context) (int64, int64, time.Time, error) {
	return 0, 0, time.Time{}, nil
}
func (r *reportStore) ActOnReport(context.Context, store.ReportAct) error { return nil }
func (r *reportStore) MakeNotice(context.Context, store.Notice) (store.ReportID, error) {
	return store.ReportID{}, nil
}

// chatWorld is a server with chat aboard: its sailors' chat as speakers
// says, each an adult who has accepted the Rules unless speakers says
// otherwise; the edge's log kept; mutes and blocks in memory; reports
// copied into reports.
type chatWorld struct {
	srv      *Server
	switches *aboard.Switches
	ties     *aboard.Ties
	log      *lockedBuffer
	reports  *reportStore
	tied     []string // what Tie was asked, in words with no line's text
	mu       sync.Mutex
	speakers map[bus.Account]aboard.Speaker
}

func newChatWorld(t *testing.T) *chatWorld {
	t.Helper()
	cw := &chatWorld{
		switches: aboard.NewSwitches(aboard.DefaultLifetime), ties: aboard.NewTies(nil, nil), log: &lockedBuffer{},
		reports: &reportStore{names: map[store.AccountID]string{}}, speakers: map[bus.Account]aboard.Speaker{},
	}
	var reviews *review.Service
	cw.srv = NewServer(t, Config{
		BoatOf: keelboats(t), Refuser: cw.ties, Switches: cw.switches,
		Log: slog.New(slog.NewTextHandler(cw.log, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Chat: func(f *bus.Frames) *chat.Hub {
			return chat.NewHub(f, aboard.Rules{Switches: cw.switches, Ties: cw.ties}, time.Now)
		},
		Talker: func(_ context.Context, a bus.Account) (aboard.Speaker, string, error) {
			cw.mu.Lock()
			defer cw.mu.Unlock()
			s, ok := cw.speakers[a]
			if !ok {
				s = aboard.Speaker{Band: aboard.Adult, Rules: true}
			}
			s.Account, s.Human = a, a
			return s, cw.reports.names[store.AccountID(a)], nil
		},
		Tie: func(_ context.Context, account, other bus.Account, block, on bool) error {
			if block {
				cw.ties.SetBlock(account, other, on)
			} else {
				cw.ties.SetMute(account, other, on)
			}
			cw.mu.Lock()
			cw.tied = append(cw.tied, cw.reports.names[store.AccountID(other)])
			cw.mu.Unlock()
			return nil
		},
		Report: func(ctx context.Context, r edge.ReportIn) error { return reviews.Report(ctx, review.In(r)) },
	})
	cw.srv.Chat.Metrics = cw.srv.Metrics
	reviews = review.New(review.Config{Store: cw.reports, Hub: func() *chat.Hub { return cw.srv.Chat }, Metrics: cw.srv.Metrics})
	return cw
}

// sailor makes a sailor of the world, with the speaker given.
func (cw *chatWorld) sailor(name string, s aboard.Speaker) (string, store.AccountID) {
	token, id := cw.srv.Sailor(name)
	cw.mu.Lock()
	cw.reports.names[id] = name
	if s != (aboard.Speaker{}) {
		cw.speakers[bus.Account(id)] = s
	}
	cw.mu.Unlock()
	return token, id
}

// aboardOf lets v, the sailor named name, aboard the boat of skipper by a
// link.
func (v *viewer) aboardOf(skipper *viewer, link, name string) {
	v.t.Helper()
	if got := v.knock(link); got != pb.KnockState_KNOCK_STATE_WAITING {
		v.t.Fatalf("the knock: %v", got)
	}
	var card *pb.KnockCard
	if !skipper.read(5*time.Second, func() bool {
		for _, k := range skipper.cards {
			if k.GetSailor() == name {
				card = k
			}
		}
		return card != nil
	}) {
		v.t.Fatalf("no card for %s", name)
	}
	skipper.command(&pb.Command{Body: &pb.Command_Answer{Answer: &pb.Answer{Knock: card.GetId(), Let: true}}})
	if w := v.welcomed(); w.GetAboard() == nil {
		v.t.Fatalf("not welcomed aboard: %v", w)
	}
}

// say says a line and reads until it comes back, said or refused.
func (v *viewer) say(text string, id uint32) *pb.Chat {
	v.t.Helper()
	v.command(&pb.Command{Body: &pb.Command_Say{Say: &pb.Say{Text: text, Id: id}}})
	var echo *pb.Chat
	if !v.read(5*time.Second, func() bool {
		for _, l := range v.lines {
			if l.GetYou() && l.GetEcho() == id {
				echo = l
				return true
			}
		}
		return false
	}) {
		v.t.Fatalf("no echo of line %d", id)
	}
	return echo
}

// heard reads, for a while, until a line with the text given comes from
// someone else; false if none does.
func (v *viewer) heard(text string, within time.Duration) bool {
	v.t.Helper()
	return v.read(within, func() bool {
		for _, l := range v.lines {
			if !l.GetYou() && l.GetText() == text {
				return true
			}
		}
		return false
	})
}

// TestChatAboard: Ann sails with Bob and Cat aboard and Dan on his own
// boat. A line reaches those aboard whose chat is on, and nobody else; a
// line with a link is refused and its sender told; a line with a listed
// word comes back to its sender as said and reaches nobody; a teen reads
// nothing until opting in; the owner's switch stops every line at once and
// on again they flow; a mute hides a sender's lines; a report copies the
// lines before it and takes the next ten minutes. No line's text reaches
// the log or a metric.
func TestChatAboard(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cw := newChatWorld(t)
		srv := cw.srv
		annToken, ann := cw.sailor("Ann Bonny", aboard.Speaker{})
		bobToken, _ := cw.sailor("Bob Read", aboard.Speaker{})
		catToken, cat := cw.sailor("Cat Teach", aboard.Speaker{Band: aboard.Teen, Rules: true})
		danToken, _ := cw.sailor("Dan Kidd", aboard.Speaker{})
		a := dial(t, srv, annToken, client.Hello())
		a.welcomed()
		b := dial(t, srv, bobToken, client.Hello())
		b.welcomed()
		c := dial(t, srv, catToken, client.Hello())
		c.welcomed()
		d := dial(t, srv, danToken, client.Hello())
		d.welcomed()
		for _, v := range []*viewer{a, b, c, d} {
			v.keepAlive()
		}
		link := srv.Link(ann, "Ann Bonny")

		// Alone, a line reaches nobody.
		if l := a.say("anyone there", 1); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_NOBODY {
			t.Fatalf("alone: %v", l)
		}
		b.aboardOf(a, link, "Bob Read")
		c.aboardOf(a, link, "Cat Teach")
		if !b.read(5*time.Second, func() bool { return b.chatState != nil }) || b.chatState.GetStatus() != pb.ChatStatus_CHAT_STATUS_ON {
			t.Fatalf("Bob's chat: %v", b.chatState)
		}
		if !c.read(5*time.Second, func() bool { return c.chatState != nil }) || c.chatState.GetStatus() != pb.ChatStatus_CHAT_STATUS_OWN_OFF {
			t.Fatalf("Cat's chat, a teen's not turned on: %v", c.chatState)
		}

		// Said: Bob hears it; Cat, a teen not opted in, and Dan, not
		// aboard, do not.
		said := "kittiwake fair winds"
		if l := a.say(said, 2); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_UNSPECIFIED || l.GetId() == 0 || l.GetName() != "Ann Bonny" {
			t.Fatalf("Ann's line: %v", l)
		}
		if !b.heard(said, 5*time.Second) {
			t.Fatal("Bob did not hear Ann")
		}
		if c.heard(said, 2*time.Second) || d.heard(said, time.Second) {
			t.Fatal("a line reached a teen not opted in, or someone not aboard")
		}
		if l := c.say("can I talk", 3); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_SILENT {
			t.Fatalf("Cat's line before opting in: %v", l)
		}

		// A link is refused, and its sender told; a word reaches nobody,
		// and its sender sees it as said.
		if l := b.say("find me at kittiwake.com", 4); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_CONTACT {
			t.Fatalf("a link: %v", l)
		}
		if l := b.say("well shit", 5); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_UNSPECIFIED || l.GetId() != 0 || l.GetText() != "well shit" || l.GetName() != "Bob Read" {
			t.Fatalf("a word, to its sender: %v", l)
		}
		if a.heard("find me at kittiwake.com", time.Second) || a.heard("well shit", time.Second) {
			t.Fatal("a refused line arrived")
		}

		// Cat opts in: she hears Ann from then on.
		srv.Chat.Update(bus.Account(cat), func(s *aboard.Speaker) { s.ChatSet, s.Chat = true, true })
		if !c.read(5*time.Second, func() bool { return c.chatState.GetStatus() == pb.ChatStatus_CHAT_STATUS_ON }) {
			t.Fatalf("Cat's chat after opting in: %v", c.chatState)
		}
		a.say("guillemot ahoy", 6)
		if !c.heard("guillemot ahoy", 5*time.Second) {
			t.Fatal("Cat did not hear Ann after opting in")
		}

		// The owner's switch: off, every line stops, and everyone is told;
		// on again, they flow.
		cw.switches.SetChat(false)
		srv.Chat.Changed(nil)
		if !b.read(5*time.Second, func() bool { return b.chatState.GetStatus() == pb.ChatStatus_CHAT_STATUS_OFF }) {
			t.Fatalf("Bob's chat with chat off: %v", b.chatState)
		}
		if l := a.say("is anyone listening", 7); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_SILENT {
			t.Fatalf("a line with chat off: %v", l)
		}
		cw.switches.SetChat(true)
		srv.Chat.Changed(nil)
		a.say("shearwater on the bow", 8)
		if !b.heard("shearwater on the bow", 5*time.Second) {
			t.Fatal("chat on again, the line did not arrive")
		}

		// Bob mutes Ann, by her seat: her lines reach him no more.
		b.command(&pb.Command{Body: &pb.Command_Mute{Mute: &pb.Mute{Who: &pb.Who{Who: &pb.Who_Seat{Seat: 0}}, On: true}}})
		if !b.read(5*time.Second, func() bool { return b.tied != nil }) || !b.tied.GetMuted() || b.tied.GetName() != "Ann Bonny" {
			t.Fatalf("the mute: %v", b.tied)
		}
		a.say("petrel to port", 9)
		if b.heard("petrel to port", 2*time.Second) {
			t.Fatal("a muted sender's line arrived")
		}
		if !c.heard("petrel to port", 5*time.Second) {
			t.Fatal("Cat did not hear Ann")
		}

		// Cat reports Ann from her line: the report holds the lines
		// before it, the line marked, and the next ten minutes.
		var reported *pb.Chat
		for _, l := range c.lines {
			if l.GetText() == "petrel to port" {
				reported = l
			}
		}
		c.command(&pb.Command{Body: &pb.Command_Report{Report: &pb.Report{
			Who: &pb.Who{Who: &pb.Who_Line{Line: reported.GetId()}}, Reason: pb.ReportReason_REPORT_REASON_BULLYING, Note: "unkind",
		}}})
		if !c.read(5*time.Second, func() bool { return c.reported != nil }) || !c.reported.GetOk() {
			t.Fatalf("the report: %v", c.reported)
		}
		cw.reports.mu.Lock()
		if len(cw.reports.made) != 1 {
			t.Fatalf("%d reports made", len(cw.reports.made))
		}
		r := cw.reports.made[0]
		cw.reports.mu.Unlock()
		var texts []string
		marked := ""
		for _, l := range r.Lines {
			texts = append(texts, l.Text)
			if l.Reported {
				marked = l.Text
			}
		}
		if r.ReportedName != "Ann Bonny" || r.ReporterName != "Cat Teach" || r.Reason != store.ReasonBullying || marked != "petrel to port" ||
			!strings.Contains(strings.Join(texts, "|"), "kittiwake fair winds|guillemot ahoy|shearwater on the bow|petrel to port") ||
			len(r.People) != 3 || r.People[2].Band != "13-17" {
			t.Fatalf("the report: %+v, lines %q", r, texts)
		}
		for _, x := range texts {
			if x == "well shit" || x == "find me at kittiwake.com" || x == "is anyone listening" {
				t.Fatalf("a line nobody heard was copied: %q", x)
			}
		}
		a.say("the next one", 10)
		time.Sleep(review.Follow + time.Second)
		cw.reports.mu.Lock()
		after := cw.reports.after
		cw.reports.mu.Unlock()
		if len(after) != 1 || len(after[0]) != 1 || after[0][0].Text != "the next one" {
			t.Fatalf("the ten minutes after: %+v", after)
		}

		// Nothing of a line's text is in the log or the metrics.
		rec := httptest.NewRecorder()
		srv.Metrics.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
		logged, metrics := cw.log.String(), rec.Body.String()
		for _, text := range []string{"kittiwake", "guillemot", "shearwater", "petrel", "shit", "anyone there", "next one", "unkind"} {
			if strings.Contains(logged, text) || strings.Contains(metrics, text) || strings.Contains(strings.Join(cw.tied, " "), text) {
				t.Errorf("%q reached the log or the metrics", text)
			}
		}
		if !strings.Contains(metrics, "keel_chat_lines_total") {
			t.Error("the metrics count no lines")
		}
		for _, v := range []*viewer{a, b, c, d} {
			v.drain()
		}
	})
}

// TestBlockAboard: a skipper's block puts the person ashore, and keeps
// them off the boat; their lines reach each other no more.
func TestBlockAboard(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cw := newChatWorld(t)
		srv := cw.srv
		annToken, ann := cw.sailor("Ann Bonny", aboard.Speaker{})
		bobToken, _ := cw.sailor("Bob Read", aboard.Speaker{})
		a := dial(t, srv, annToken, client.Hello())
		a.welcomed()
		b := dial(t, srv, bobToken, client.Hello())
		b.welcomed()
		a.keepAlive()
		b.keepAlive()
		link := srv.Link(ann, "Ann Bonny")
		b.aboardOf(a, link, "Bob Read")
		if !a.read(5*time.Second, func() bool { return a.crew != nil && len(a.crew.GetPeople()) == 2 }) {
			t.Fatal("Ann was not told Bob is aboard")
		}
		b.ashore = nil
		a.command(&pb.Command{Body: &pb.Command_Block{Block: &pb.Block{Who: &pb.Who{Who: &pb.Who_Seat{Seat: 1}}, On: true}}})
		if !a.read(5*time.Second, func() bool { return a.tied != nil }) || !a.tied.GetBlocked() {
			t.Fatalf("the block: %v", a.tied)
		}
		w := b.welcomed()
		if b.ashore.GetWhy() != pb.AshoreWhy_ASHORE_WHY_PUT || w.GetAboard() != nil {
			t.Fatalf("Bob was not put ashore: %v, %v", b.ashore, w)
		}
		if got := b.knock(link); got != pb.KnockState_KNOCK_STATE_CLOSED {
			t.Fatalf("a blocked knock: %v", got)
		}
		a.drain()
		b.drain()
	})
}
