// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"context"
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
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/shipmates"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// sayTo says a message to a shipmate and reads until it comes back, said
// or refused.
func (v *viewer) sayTo(to store.AccountID, text string, id uint32) *pb.Chat {
	v.t.Helper()
	v.command(&pb.Command{Body: &pb.Command_Say{Say: &pb.Say{Text: text, Id: id, To: to.String()}}})
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
		v.t.Fatalf("no echo of message %d", id)
	}
	return echo
}

// heardFrom reads, for a while, until a message with the text given comes
// in the thread of the shipmate given; false if none does.
func (v *viewer) heardFrom(from store.AccountID, text string, within time.Duration) bool {
	v.t.Helper()
	return v.read(within, func() bool {
		for _, l := range v.lines {
			if !l.GetYou() && l.GetText() == text && l.GetThread() == from.String() {
				return true
			}
		}
		return false
	})
}

// TestShipmatesMessages: Ann and Bob are shipmates, each on a boat of
// their own; Dan is no shipmate of either. A message reaches the other
// wherever they are, marked with its thread; a message to someone not a
// shipmate, or to a shipmate not in the game, is refused as away and kept
// nowhere; appearing offline refuses messages but from a shipmate written
// to; the owner's switch for shipmates' messages, and chat's, stop them
// at once; ending it stops a message in flight; a report of a message
// holds the thread. No message's text reaches the log or a metric.
func TestShipmatesMessages(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cw := newChatWorld(t)
		srv := cw.srv
		annToken, ann := cw.sailor("Ann Bonny", aboard.Speaker{})
		bobToken, bob := cw.sailor("Bob Read", aboard.Speaker{})
		danToken, dan := cw.sailor("Dan Kidd", aboard.Speaker{})
		a := dial(t, srv, annToken, client.Hello())
		a.welcomed()
		b := dial(t, srv, bobToken, client.Hello())
		b.welcomed()
		d := dial(t, srv, danToken, client.Hello())
		d.welcomed()
		for _, v := range []*viewer{a, b, d} {
			v.keepAlive()
		}
		cw.ties.SetShipmates(ann, bob, true)

		// From one boat to another.
		if l := a.sayTo(bob, "fair winds from the west", 1); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_UNSPECIFIED ||
			l.GetId() == 0 || l.GetThread() != bob.String() || l.GetSeat() != 0 {
			t.Fatalf("Ann's message: %v", l)
		}
		if !b.heardFrom(ann, "fair winds from the west", 5*time.Second) {
			t.Fatal("Bob did not hear Ann")
		}
		if l := b.sayTo(ann, "and to you", 2); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_UNSPECIFIED {
			t.Fatalf("Bob's answer: %v", l)
		}
		if !a.heardFrom(bob, "and to you", 5*time.Second) {
			t.Fatal("Ann did not hear Bob")
		}
		if d.heard("fair winds from the west", time.Second) || d.heard("and to you", time.Second) {
			t.Fatal("a message between shipmates reached someone else")
		}

		// Dan is no shipmate: away, and nothing kept.
		if l := d.sayTo(ann, "hello stranger", 3); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_AWAY {
			t.Fatalf("a stranger's message: %v", l)
		}
		if a.heard("hello stranger", time.Second) {
			t.Fatal("a stranger's message arrived")
		}

		// A link in a message is refused, as aboard.
		if l := a.sayTo(bob, "see kittiwake.com", 4); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_CONTACT {
			t.Fatalf("a link to a shipmate: %v", l)
		}

		// Bob appears offline: Ann's messages are refused as away, unless
		// Bob wrote to her in the last half hour, as he did.
		srv.Chat.Update(bus.Account(bob), func(s *aboard.Speaker) { s.Offline = true })
		if l := a.sayTo(bob, "still there", 5); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_UNSPECIFIED {
			t.Fatalf("to a shipmate offline who wrote to her: %v", l)
		}
		time.Sleep(31 * time.Minute)
		if l := a.sayTo(bob, "gone quiet", 6); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_AWAY {
			t.Fatalf("to a shipmate offline: %v", l)
		}
		srv.Chat.Update(bus.Account(bob), func(s *aboard.Speaker) { s.Offline = false })

		// The owner's switches.
		cw.switches.SetShipmateMessages(false)
		if l := a.sayTo(bob, "messages off", 7); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_RESTING {
			t.Fatalf("with shipmates' messages off: %v", l)
		}
		cw.switches.SetShipmateMessages(true)
		cw.switches.SetChat(false)
		if l := a.sayTo(bob, "chat off", 8); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_SILENT {
			t.Fatalf("with chat off: %v", l)
		}
		cw.switches.SetChat(true)
		if l := a.sayTo(bob, "on again", 9); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_UNSPECIFIED || !b.heardFrom(ann, "on again", 5*time.Second) {
			t.Fatalf("on again: %v", l)
		}

		// Bob reports Ann from her message: the report holds the thread.
		var reported *pb.Chat
		for _, l := range b.lines {
			if l.GetText() == "on again" {
				reported = l
			}
		}
		b.command(&pb.Command{Body: &pb.Command_Report{Report: &pb.Report{
			Who: &pb.Who{Who: &pb.Who_Line{Line: reported.GetId()}}, Reason: pb.ReportReason_REPORT_REASON_BULLYING,
		}}})
		if !b.read(5*time.Second, func() bool { return b.reported != nil }) || !b.reported.GetOk() {
			t.Fatalf("the report: %v", b.reported)
		}
		cw.reports.mu.Lock()
		r := cw.reports.made[len(cw.reports.made)-1]
		cw.reports.mu.Unlock()
		var texts []string
		for _, l := range r.Lines {
			texts = append(texts, l.Text)
		}
		if r.ReportedName != "Ann Bonny" || !strings.Contains(r.Place, "shipmates") || len(r.People) != 2 ||
			strings.Join(texts, "|") != "on again" || !r.Lines[0].Reported {
			t.Fatalf("the report of a thread: %+v, lines %q", r, texts)
		}

		// Bob leaves the game: away, and nothing kept for later.
		b.ws.CloseNow()
		if !a.read(5*time.Second, func() bool {
			_, in := srv.Chat.Speaker(bus.Account(bob))
			return !in
		}) {
			t.Fatal("Bob is still in the game")
		}
		if l := a.sayTo(bob, "are you there", 10); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_AWAY {
			t.Fatalf("to a shipmate not in the game: %v", l)
		}
		for _, l := range srv.Chat.Rings.Lines(chat.Pair(ann, bob), time.Time{}) {
			if l.Text == "are you there" {
				t.Fatal("a message to a shipmate away was kept")
			}
		}
		b = dial(t, srv, bobToken, client.Hello())
		b.welcomed()
		b.keepAlive()
		if b.heard("are you there", 2*time.Second) {
			t.Fatal("a message to a shipmate away was kept for later")
		}

		// No longer shipmates: the next message is away, both ways.
		cw.ties.SetShipmates(ann, bob, false)
		if l := a.sayTo(bob, "after the end", 11); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_AWAY {
			t.Fatalf("after the end: %v", l)
		}
		if l := b.sayTo(ann, "after the end too", 12); l.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_AWAY {
			t.Fatalf("after the end, the other way: %v", l)
		}

		// Nothing of a message's text is in the log or the metrics.
		rec := httptest.NewRecorder()
		srv.Metrics.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
		logged, metrics := cw.log.String(), rec.Body.String()
		for _, text := range []string{"fair winds", "and to you", "stranger", "kittiwake", "still there", "gone quiet", "on again", "are you there", "after the end"} {
			if strings.Contains(logged, text) || strings.Contains(metrics, text) {
				t.Errorf("%q reached the log or the metrics", text)
			}
		}
		if !strings.Contains(metrics, `keel_chat_lines_total{result="away"}`) {
			t.Error("the metrics count no messages to a shipmate away")
		}
		_ = dan
		for _, v := range []*viewer{a, b, d} {
			v.drain()
		}
	})
}

// TestShipmateKnocks: Bob knocks on the boat of Ann, his shipmate, from
// his list, without a link; Ann's card marks him a shipmate and she
// answers it as any knock; aboard, Ann sees him marked a shipmate. Dan,
// no shipmate, knocking so is told Ann is not at sea; so is Bob while Ann
// appears offline.
func TestShipmateKnocks(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cw := newChatWorld(t)
		srv := cw.srv
		annToken, ann := cw.sailor("Ann Bonny", aboard.Speaker{})
		bobToken, bob := cw.sailor("Bob Read", aboard.Speaker{})
		danToken, _ := cw.sailor("Dan Kidd", aboard.Speaker{})
		a := dial(t, srv, annToken, client.Hello())
		a.welcomed()
		b := dial(t, srv, bobToken, client.Hello())
		b.welcomed()
		d := dial(t, srv, danToken, client.Hello())
		d.welcomed()
		for _, v := range []*viewer{a, b, d} {
			v.keepAlive()
		}
		cw.ties.SetShipmates(ann, bob, true)
		knockOn := func(v *viewer, id store.AccountID) pb.KnockState {
			v.knocking = nil
			v.command(&pb.Command{Body: &pb.Command_Knock{Knock: &pb.Knock{Shipmate: id.String()}}})
			if !v.read(5*time.Second, func() bool { return v.knocking != nil }) {
				t.Fatal("no Knocking")
			}
			return v.knocking.GetState()
		}
		if got := knockOn(d, ann); got != pb.KnockState_KNOCK_STATE_NOT_AT_SEA {
			t.Fatalf("a stranger's knock without a link: %v", got)
		}
		srv.Chat.Update(bus.Account(ann), func(s *aboard.Speaker) { s.Offline = true })
		if got := knockOn(b, ann); got != pb.KnockState_KNOCK_STATE_NOT_AT_SEA {
			t.Fatalf("a knock on a shipmate offline: %v", got)
		}
		srv.Chat.Update(bus.Account(ann), func(s *aboard.Speaker) { s.Offline = false })
		if got := knockOn(b, ann); got != pb.KnockState_KNOCK_STATE_WAITING {
			t.Fatalf("a shipmate's knock: %v", got)
		}
		card := a.card()
		if card.GetSailor() != "Bob Read" || !card.GetShipmate() {
			t.Fatalf("the card: %v", card)
		}
		a.command(&pb.Command{Body: &pb.Command_Answer{Answer: &pb.Answer{Knock: card.GetId(), Let: true}}})
		if w := b.welcomed(); w.GetAboard() == nil {
			t.Fatalf("not welcomed aboard: %v", w)
		}
		if !a.read(5*time.Second, func() bool { return a.crew != nil && len(a.crew.GetPeople()) == 2 }) {
			t.Fatal("Ann was not told Bob is aboard")
		}
		if p := a.crew.GetPeople()[1]; !p.GetShipmate() || a.crew.GetPeople()[0].GetShipmate() {
			t.Fatalf("the shipmate's mark: %v", a.crew)
		}
		// Ended, the mark goes as Ann's connection is told the list changed.
		cw.ties.SetShipmates(ann, bob, false)
		srv.Edge.Shipmates(bus.Account(ann))
		if !a.read(5*time.Second, func() bool { return a.shipmates > 0 && !a.crew.GetPeople()[1].GetShipmate() }) {
			t.Fatalf("the mark after the end: %v", a.crew)
		}
		for _, v := range []*viewer{a, b, d} {
			v.drain()
		}
	})
}

// sawRecorder keeps what the tally recorded.
type sawRecorder struct {
	mu   sync.Mutex
	seen []string
}

func (r *sawRecorder) SawTogether(_ context.Context, a, b store.AccountID, _ time.Time, _ uint64, sailed bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	w := "seen"
	if sailed {
		w = "sailed"
	}
	r.seen = append(r.seen, w)
	return nil
}

func (r *sawRecorder) got() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.seen...)
}

// TestTally: Bob aboard Ann's boat is seen at once, and counted as having
// sailed with her once five minutes have passed together.
func TestTally(t *testing.T) {
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
		rec := &sawRecorder{}
		tally := shipmates.NewTally(srv.World.Bus().Frames, rec, time.Now, nil, srv.Metrics)
		ctx := t.Context()
		tally.Sweep(ctx)
		if got := rec.got(); len(got) != 0 {
			t.Fatalf("recorded with nobody aboard together: %v", got)
		}
		link := srv.Link(ann, "Ann Bonny")
		b.aboardOf(a, link, "Bob Read")
		a.drain()
		tally.Sweep(ctx)
		if got := rec.got(); len(got) != 1 || got[0] != "seen" {
			t.Fatalf("aboard together: %v", got)
		}
		for range 19 {
			time.Sleep(shipmates.Every)
			tally.Sweep(ctx)
		}
		if got := rec.got(); len(got) != 1 {
			t.Fatalf("before five minutes: %v", got)
		}
		time.Sleep(shipmates.Every)
		tally.Sweep(ctx)
		if got := rec.got(); len(got) != 2 || got[1] != "sailed" {
			t.Fatalf("after five minutes: %v", got)
		}
		b.drain()
	})
}
