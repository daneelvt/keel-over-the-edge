// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"slices"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// machineChatWorld is a chat world whose machine sailors are sent aboard
// through helms.
func machineChatWorld(t *testing.T) (*chatWorld, *helms) {
	t.Helper()
	h := newHelms()
	cw := newChatWorld(t, func(c *Config) { c.Machines = h })
	h.srv = cw.srv
	cw.reports.owners = map[store.AccountID]store.AccountID{}
	return cw, h
}

// machine puts a machine sailor of owner's in the water, its keelboat at
// st's place, and makes it a speaker of the hub.
func (cw *chatWorld) machine(t *testing.T, h *helms, name string, owner store.AccountID, i int) (store.AccountID, uint64) {
	t.Helper()
	id, boat := cw.srv.MachineKind(t, name, owner, keelboat(t), near(i))
	h.names[bus.Account(id)] = name
	cw.reports.mu.Lock()
	cw.reports.names[id], cw.reports.owners[id] = name, owner
	cw.reports.mu.Unlock()
	cw.srv.Chat.Join(aboard.Speaker{Account: bus.Account(id), Human: bus.Account(owner), Machine: true, Band: aboard.Adult, Rules: true}, name)
	return id, boat
}

// texts are the lines v was sent by others, in order.
func (v *viewer) texts() []string {
	var out []string
	for _, l := range v.lines {
		if !l.GetYou() && l.GetThread() == "" {
			out = append(out, l.GetText())
		}
	}
	return out
}

// lineOf is the line v was sent with the text given, nil for none.
func (v *viewer) lineOf(text string) *pb.Chat {
	for _, l := range v.lines {
		if !l.GetYou() && l.GetText() == text {
			return l
		}
	}
	return nil
}

// TestMachineSailorsChatInPublic: Ann's Iron Mary and Bob's Rover sail
// together, Ann and Bob watching their own and Carl, who owns none,
// watching Iron Mary. Carl reads both machine sailors' lines, marked as
// machine sailors'; his own line is refused whatever his client sends,
// and reaches nobody; Ann's block of Carl hides nothing; his mute of Rover
// hides Rover's lines; he reports one of Rover's lines, a report about
// Rover with Bob as its owner; and Ann's message to her
// shipmate Bob never reaches him. Rover put ashore and Ann aboard her own
// machine sailor's boat, with her Pearl, Carl reads nothing of it, Ann's
// lines or the machine sailors'; Ann ashore again, he reads the next line
// said, and none said while she was aboard.
func TestMachineSailorsChatInPublic(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cw, helms := machineChatWorld(t)
		srv, hub := cw.srv, cw.srv.Chat
		annToken, ann := cw.sailor("Ann Bonny", aboard.Speaker{})
		bobToken, bob := cw.sailor("Bob Read", aboard.Speaker{})
		carlToken, carl := cw.sailor("Carl Vane", aboard.Speaker{})
		mary, maryBoat := cw.machine(t, helms, "Iron Mary", ann, 0)
		rover, _ := cw.machine(t, helms, "Rover", bob, 2)
		pearl, _ := cw.machine(t, helms, "Pearl", ann, 4)

		a := dial(t, srv, annToken, client.HelloWatch("Iron Mary"))
		a.welcomed()
		a.keepAlive()
		b := dial(t, srv, bobToken, client.HelloWatch("Rover"))
		b.welcomed()
		b.keepAlive()
		c := dial(t, srv, carlToken, client.HelloWatch("Iron Mary"))
		c.welcomed()
		c.keepAlive()

		link := srv.MachineLink(mary, ann, "Iron Mary")
		if got := b.machineKnock(link, "Rover"); got != pb.KnockState_KNOCK_STATE_WAITING {
			t.Fatalf("Rover's knock: %v", b.knocking)
		}
		card := a.card()
		a.command(&pb.Command{Body: &pb.Command_Answer{Answer: &pb.Answer{Knock: card.GetId(), Let: true}}})
		if w := b.welcomed(); w.GetBoat() != maryBoat {
			t.Fatalf("Bob's watch aboard: %v", w)
		}
		if !c.read(5*time.Second, func() bool { return len(c.crew.GetPeople()) == 2 && c.chatState != nil }) {
			t.Fatalf("Carl was not told the crew and chat's state: %v %v", c.crew, c.chatState)
		}

		// Only machine sailors aboard: every spectator reads them.
		if s := hub.Say(bus.Account(mary), "Welcome aboard, Rover"); s.Refused != 0 || s.Heard != 1 {
			t.Fatalf("Iron Mary's line: %+v", s)
		}
		hub.Say(bus.Account(rover), "Rover here")
		for _, v := range []*viewer{a, b, c} {
			if !v.read(5*time.Second, func() bool { return len(v.texts()) == 2 }) {
				t.Fatalf("a spectator did not read the machine sailors: %v", v.texts())
			}
		}
		if l := c.lineOf("Rover here"); !l.GetMachine() || l.GetName() != "Rover" || l.GetId() == 0 {
			t.Fatalf("Rover's line, as Carl read it: %v", l)
		}

		// Carl says nothing, whatever his client sends.
		if echo := c.say("hello from the rail", 1); echo.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_SILENT || echo.GetId() != 0 {
			t.Fatalf("a spectator's line: %v", echo)
		}
		if a.heard("hello from the rail", 2*time.Second) || b.heard("hello from the rail", 0) {
			t.Fatal("a spectator's line reached someone")
		}

		// Ann blocks Carl: Iron Mary's lines are public all the same.
		cw.ties.SetBlock(bus.Account(ann), bus.Account(carl), true)
		hub.Say(bus.Account(mary), "Fair wind for all")
		if !c.heard("Fair wind for all", 5*time.Second) {
			t.Fatal("a block between the owner and a spectator hid a machine sailor's line")
		}
		cw.ties.SetBlock(bus.Account(ann), bus.Account(carl), false)

		// Carl mutes Rover, from its line.
		c.command(&pb.Command{Body: &pb.Command_Mute{Mute: &pb.Mute{Who: &pb.Who{Who: &pb.Who_Line{Line: c.lineOf("Rover here").GetId()}}, On: true}}})
		if !c.read(5*time.Second, func() bool { return c.tied != nil }) || !c.tied.GetMuted() || c.tied.GetName() != "Rover" {
			t.Fatalf("the mute: %v", c.tied)
		}
		time.Sleep(2 * time.Second)
		hub.Say(bus.Account(rover), "Muted me")
		if !a.heard("Muted me", 5*time.Second) {
			t.Fatal("Ann did not read Rover")
		}
		if c.heard("Muted me", time.Second) {
			t.Fatal("a muted machine sailor's line reached the spectator who muted it")
		}

		// Carl reports Rover's line: about Rover, its owner Bob's to answer.
		c.command(&pb.Command{Body: &pb.Command_Report{Report: &pb.Report{
			Who: &pb.Who{Who: &pb.Who_Line{Line: c.lineOf("Rover here").GetId()}}, Reason: pb.ReportReason_REPORT_REASON_BULLYING,
		}}})
		if !c.read(5*time.Second, func() bool { return c.reported != nil }) || !c.reported.GetOk() {
			t.Fatalf("the report: %v", c.reported)
		}
		cw.reports.mu.Lock()
		if len(cw.reports.made) != 1 {
			t.Fatalf("%d reports", len(cw.reports.made))
		}
		r := cw.reports.made[0]
		cw.reports.mu.Unlock()
		marked := ""
		for _, l := range r.Lines {
			if l.Reported {
				marked = l.Text
			}
		}
		if r.Reporter != carl || r.Reported != rover || !r.HasOwner || r.Owner != bob || marked != "Rover here" {
			t.Fatalf("the report: reporter %v, reported %v, owner %v %v, marked %q", r.Reporter, r.Reported, r.HasOwner, r.Owner, marked)
		}

		// A message between shipmates never reaches a spectator, though
		// its sender watches the same boat.
		cw.ties.SetShipmates(bus.Account(ann), bus.Account(bob), true)
		if echo := a.sayTo(bob, "between us two", 2); echo.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_UNSPECIFIED {
			t.Fatalf("Ann's message: %v", echo)
		}
		if !b.heardFrom(ann, "between us two", 5*time.Second) {
			t.Fatal("Bob did not get Ann's message")
		}
		if c.heard("between us two", time.Second) {
			t.Fatal("a spectator read a message between shipmates")
		}

		// Rover put ashore; Ann comes aboard, and her Pearl with her.
		a.command(&pb.Command{Body: &pb.Command_Ashore{Ashore: &pb.GoAshore{Who: 1}}})
		b.welcomed()
		time.Sleep(time.Second)
		if got := a.comeAboard(); got != pb.KnockState_KNOCK_STATE_LET {
			t.Fatalf("Ann coming aboard: %v", got)
		}
		a.welcomed()
		time.Sleep(time.Second)
		if got := a.machineKnock(link, "Pearl"); got != pb.KnockState_KNOCK_STATE_WAITING {
			t.Fatalf("Pearl's knock: %v", a.knocking)
		}
		card = a.card()
		a.command(&pb.Command{Body: &pb.Command_Answer{Answer: &pb.Answer{Knock: card.GetId(), Let: true}}})
		if !c.read(5*time.Second, func() bool { return len(c.crew.GetPeople()) == 3 }) {
			t.Fatalf("Carl's crew with Ann and Pearl aboard: %v", c.crew)
		}
		if p := c.crew.GetPeople(); slices.IndexFunc(p, func(p *pb.Person) bool { return !p.GetMachine() }) < 0 {
			t.Fatalf("Carl is not told a person is aboard: %v", p)
		}
		before := len(c.texts())
		if s := hub.Say(bus.Account(mary), "Ann is aboard now"); s.Refused != 0 || s.Heard != 2 {
			t.Fatalf("Iron Mary's line with Ann aboard: %+v", s)
		}
		hub.Say(bus.Account(pearl), "Pearl too")
		if !a.heard("Ann is aboard now", 5*time.Second) || !a.heard("Pearl too", 5*time.Second) {
			t.Fatal("Ann, aboard, did not read the machine sailors")
		}
		if echo := a.say("my own words", 3); echo.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_UNSPECIFIED {
			t.Fatalf("Ann's line aboard: %v", echo)
		}
		c.read(2*time.Second, nil)
		if got := c.texts(); len(got) != before {
			t.Fatalf("a spectator read the chat with a person aboard: %v", got[before:])
		}

		// Ann goes ashore: the machine sailors are public again, from the
		// next line.
		a.command(&pb.Command{Body: &pb.Command_Ashore{Ashore: &pb.GoAshore{}}})
		if !c.read(5*time.Second, func() bool { return len(c.crew.GetPeople()) == 2 }) {
			t.Fatalf("Carl's crew with Ann ashore: %v", c.crew)
		}
		hub.Say(bus.Account(mary), "Alone again")
		if !c.heard("Alone again", 5*time.Second) {
			t.Fatal("with Ann ashore, Carl did not read Iron Mary")
		}
		if got := c.texts(); len(got) != before+1 {
			t.Fatalf("what Carl read after Ann went ashore: %v", got[before:])
		}
	})
}

// TestSpectatorChatSwitch: the owner's switch for spectators' reading off,
// neither Carl nor Ann, watching her own machine sailor, reads the next
// line, and both are told chat is off for them, which puts their strip
// away; those aboard still hear it. On again, both read the next line and
// are told chat is on.
func TestSpectatorChatSwitch(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cw, helms := machineChatWorld(t)
		srv, hub := cw.srv, cw.srv.Chat
		annToken, ann := cw.sailor("Ann Bonny", aboard.Speaker{})
		carlToken, _ := cw.sailor("Carl Vane", aboard.Speaker{})
		mary, _ := cw.machine(t, helms, "Iron Mary", ann, 0)
		cw.machine(t, helms, "Pearl", ann, 2)
		a := dial(t, srv, annToken, client.HelloWatch("Iron Mary"))
		a.welcomed()
		a.keepAlive()
		c := dial(t, srv, carlToken, client.HelloWatch("Iron Mary"))
		c.welcomed()
		c.keepAlive()
		link := srv.MachineLink(mary, ann, "Iron Mary")
		if got := a.machineKnock(link, "Pearl"); got != pb.KnockState_KNOCK_STATE_WAITING {
			t.Fatalf("Pearl's knock: %v", a.knocking)
		}
		card := a.card()
		a.command(&pb.Command{Body: &pb.Command_Answer{Answer: &pb.Answer{Knock: card.GetId(), Let: true}}})
		for _, v := range []*viewer{a, c} {
			if !v.read(5*time.Second, func() bool {
				return len(v.crew.GetPeople()) == 2 && v.chatState.GetStatus() == pb.ChatStatus_CHAT_STATUS_ON
			}) {
				t.Fatalf("a spectator's crew and chat: %v %v", v.crew, v.chatState)
			}
		}

		cw.switches.SetSpectatorChat(false)
		hub.Changed(nil)
		for _, v := range []*viewer{a, c} {
			if !v.read(5*time.Second, func() bool { return v.chatState.GetStatus() == pb.ChatStatus_CHAT_STATUS_OFF }) {
				t.Fatalf("a spectator not told chat is off: %v", v.chatState)
			}
		}
		if s := hub.Say(bus.Account(mary), "Nobody watching reads this"); s.Refused != 0 || s.Heard != 1 {
			t.Fatalf("Iron Mary's line, spectators' reading off: %+v", s)
		}
		for _, v := range []*viewer{a, c} {
			if v.heard("Nobody watching reads this", 2*time.Second) {
				t.Fatal("a spectator read a line with spectators' reading off")
			}
		}

		cw.switches.SetSpectatorChat(true)
		hub.Changed(nil)
		time.Sleep(2 * time.Second)
		hub.Say(bus.Account(mary), "Read again")
		for _, v := range []*viewer{a, c} {
			if !v.heard("Read again", 5*time.Second) || v.chatState.GetStatus() != pb.ChatStatus_CHAT_STATUS_ON {
				t.Fatalf("spectators' reading on again: %v %v", v.texts(), v.chatState)
			}
			if got := v.texts(); len(got) != 1 {
				t.Fatalf("what a spectator read: %v", got)
			}
		}
	})
}

// TestNoSpectatorReadsPeople: Dan watches Ann sail with Bob aboard. He
// reads neither of them, and his own line is refused.
func TestNoSpectatorReadsPeople(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cw := newChatWorld(t)
		srv := cw.srv
		annToken, ann := cw.sailor("Ann Bonny", aboard.Speaker{})
		bobToken, _ := cw.sailor("Bob Read", aboard.Speaker{})
		danToken, _ := cw.sailor("Dan Hawk", aboard.Speaker{})
		a := dial(t, srv, annToken, client.Hello())
		a.welcomed()
		a.keepAlive()
		b := dial(t, srv, bobToken, client.Hello())
		b.welcomed()
		b.keepAlive()
		b.aboardOf(a, srv.Link(ann, "Ann Bonny"), "Bob Read")
		srv.Edge.SetVoyage(bus.Account(ann), true)
		d := dial(t, srv, danToken, client.HelloWatch("Ann Bonny"))
		d.welcomed()
		d.keepAlive()
		if !d.read(5*time.Second, func() bool { return len(d.crew.GetPeople()) == 2 }) {
			t.Fatalf("Dan was not shown the crew: %v", d.crew)
		}
		a.say("fair winds", 1)
		b.say("and to you", 2)
		if !b.heard("fair winds", 5*time.Second) || !a.heard("and to you", 5*time.Second) {
			t.Fatal("those aboard did not hear each other")
		}
		if echo := d.say("let me in", 3); echo.GetRefused() != pb.ChatRefusal_CHAT_REFUSAL_SILENT {
			t.Fatalf("a spectator's line: %v", echo)
		}
		d.read(2*time.Second, nil)
		if got := d.texts(); len(got) != 0 {
			t.Fatalf("a spectator read people's chat: %v", got)
		}
		if a.heard("let me in", time.Second) || b.heard("let me in", 0) {
			t.Fatal("a spectator's line reached those aboard")
		}
		if d.chatState != nil {
			t.Fatalf("a spectator of people was told chat's state: %v", d.chatState)
		}
	})
}
