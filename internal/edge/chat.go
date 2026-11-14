// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/chat"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Chat aboard, on the game connection. A connection says a line (Say)
// through the hub, which checks it and hands it to everyone aboard whom
// chat's rule lets it reach, through each door's Out: this edge's sends it
// to their connections (Chat), and, for a line said with only machine
// sailors aboard, to the connections watching the boat, who read it and
// say nothing: what machine sailors say is public. The sender
// is sent its line back, said or refused. Nothing of a line's text is
// ever logged or counted here.
//
// Mute, block and report name someone aboard by their seat, or by a line
// of theirs the connection was sent and the hub still holds; the account
// behind it never reaches the client. A mute or a block is kept by
// Config.Tie, a report by Config.Report.

// ChatLookup is how long the store may take to find what chat needs of an
// account as it connects, or to keep a mute, a block or a report.
const ChatLookup = 2 * time.Second

// heardLines is how many of the lines a connection was sent it may name in
// a mute, a block or a report: as many as the page keeps, and more.
const heardLines = 64

// ReportIn is a report from the game connection: the reporter, the
// account reported, the boat it was about, and the line it was made from
// (0 for one made from a name aboard). Thread is a report about the
// messages between the two, as shipmates, rather than a boat's chat.
type ReportIn struct {
	Reporter bus.Account
	Reported bus.Account
	Boat     uint64
	Line     uint64
	Reason   string
	Note     string
	Thread   bool
}

// Report reasons on the wire, as the store names them.
var reportReasons = map[pb.ReportReason]string{
	pb.ReportReason_REPORT_REASON_CHILD:    store.ReasonChild,
	pb.ReportReason_REPORT_REASON_SEXUAL:   store.ReasonSexual,
	pb.ReportReason_REPORT_REASON_BULLYING: store.ReasonBullying,
	pb.ReportReason_REPORT_REASON_HATE:     store.ReasonHate,
	pb.ReportReason_REPORT_REASON_THREATS:  store.ReasonThreats,
	pb.ReportReason_REPORT_REASON_SCAM:     store.ReasonScam,
	pb.ReportReason_REPORT_REASON_CHEATING: store.ReasonCheating,
	pb.ReportReason_REPORT_REASON_OTHER:    store.ReasonOther,
}

// connChat is a connection's side of chat.
type connChat struct {
	// in: the connection joined the hub as its account's speaker.
	in bool
	// country is where the connection comes from, from the edge's header.
	country string

	mu sync.Mutex
	// heard are the lines the connection was sent, newest last.
	heard []uint64
	// told is the state it was last told, and whether it was.
	told  pb.ChatState
	tolds bool
}

// boatWatchers are the connections watching each boat: they read the
// chat aboard it while everyone aboard is a machine sailor.
type boatWatchers struct {
	mu sync.Mutex
	by map[uint64]map[*conn]bool
}

func (m *boatWatchers) set(c *conn, boat uint64, on bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.by == nil {
		m.by = map[uint64]map[*conn]bool{}
	}
	if on {
		if m.by[boat] == nil {
			m.by[boat] = map[*conn]bool{}
		}
		m.by[boat][c] = true
		return
	}
	delete(m.by[boat], c)
	if len(m.by[boat]) == 0 {
		delete(m.by, boat)
	}
}

// of appends the connections watching boat to out.
func (m *boatWatchers) of(boat uint64, out []*conn) []*conn {
	m.mu.Lock()
	defer m.mu.Unlock()
	for c := range m.by[boat] {
		out = append(out, c)
	}
	return out
}

// joinChat makes the connection its account's speaker in the hub, with
// what the store has of the account.
func (c *conn) joinChat() {
	e := c.e
	if e.cfg.Talker == nil {
		return
	}
	ctx, cancel := context.WithTimeout(e.ctx, ChatLookup)
	defer cancel()
	s, name, err := e.cfg.Talker(ctx, c.account)
	if err != nil {
		e.cfg.Log.Warn("looking up a sailor for chat", "request_id", c.reqID, "conn", c.id, "err", err)
		return
	}
	// The age band, which says whose racing boats it may watch.
	c.band.Store(uint32(s.Band))
	if e.cfg.Chat == nil {
		return
	}
	s.Country = c.chat.country
	e.cfg.Chat.Join(s, name)
	c.chat.in = true
}

// leaveChat is the connection's end in the hub.
func (c *conn) leaveChat() {
	if c.chat.in {
		c.e.cfg.Chat.Leave(c.account)
	}
}

// chatState tells the connection how chat stands for it, if that has
// changed since it was last told, or always with force. To a spectator,
// the owner's switch for spectators' reading off reads as chat off.
func (c *conn) chatState(force bool) bool {
	h := c.e.cfg.Chat
	if h == nil {
		return true
	}
	why, until := h.State(c.account)
	st := pb.ChatState{Status: pb.ChatStatus_CHAT_STATUS_ON}
	switch why {
	case aboard.ChatOff:
		st.Status = pb.ChatStatus_CHAT_STATUS_OFF
	case aboard.OwnOff:
		st.Status = pb.ChatStatus_CHAT_STATUS_OWN_OFF
	case aboard.Silenced:
		st.Status = pb.ChatStatus_CHAT_STATUS_RESTING
		if !until.IsZero() {
			st.UntilUs = until.UnixMicro()
		}
	case aboard.NoRules:
		st.Rules = true
	}
	if sw := h.Rules.Switches; c.spectating.Load() && sw != nil && !sw.SpectatorChat() {
		// A spectator reads no chat at all while the owner has
		// spectators' reading off: their page puts the strip away.
		st = pb.ChatState{Status: pb.ChatStatus_CHAT_STATUS_OFF}
	}
	c.chat.mu.Lock()
	same := c.chat.tolds && c.chat.told.Status == st.Status && c.chat.told.UntilUs == st.UntilUs && c.chat.told.Rules == st.Rules
	if same && !force {
		c.chat.mu.Unlock()
		return true
	}
	c.chat.told.Status, c.chat.told.UntilUs, c.chat.told.Rules, c.chat.tolds = st.Status, st.UntilUs, st.Rules, true
	c.chat.mu.Unlock()
	return c.send(&pb.ServerMessage{Body: &pb.ServerMessage_ChatState{ChatState: &st}}, outChat)
}

// line sends the connection a line said aboard, or with thread a message
// between shipmates (the other's account), and keeps its number to be
// named.
func (c *conn) line(l chat.Line, seat uint32, thread string) {
	c.heardOf(l.ID)
	c.send(lineMessage(l, seat, thread), outChat)
}

// lineBytes sends the connection a line already encoded, the same for
// every spectator of a boat, and keeps its number to be named.
func (c *conn) lineBytes(id uint64, b []byte) {
	c.heardOf(id)
	c.sendEncoded(b, outChat)
}

func (c *conn) heardOf(id uint64) {
	c.chat.mu.Lock()
	if len(c.chat.heard) == heardLines {
		c.chat.heard = append(c.chat.heard[:0], c.chat.heard[1:]...)
	}
	c.chat.heard = append(c.chat.heard, id)
	c.chat.mu.Unlock()
}

// lineMessage is a line as the connection is sent it.
func lineMessage(l chat.Line, seat uint32, thread string) *pb.ServerMessage {
	return &pb.ServerMessage{Body: &pb.ServerMessage_Chat{Chat: &pb.Chat{
		Id: l.ID, Seat: seat, Name: l.Name, Machine: l.Machine, AtUs: l.At.UnixMicro(), Text: l.Text, Thread: thread,
	}}}
}

// heard reports whether the connection was sent line id.
func (c *conn) heardLine(id uint64) bool {
	c.chat.mu.Lock()
	defer c.chat.mu.Unlock()
	for _, h := range c.chat.heard {
		if h == id {
			return true
		}
	}
	return false
}

// onBoat reports whether the connection sails or is aboard boat.
func (c *conn) onBoat(boat uint64) bool {
	if !c.joined.Load() && !c.crew.Load() {
		return false
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return c.boat == boat
}

// chatOut is the edge's door for the hub.
type chatOut struct{ e *Edge }

// Deliver sends a line to the connections of the accounts given that sail
// or are aboard its boat, and a public line to the connections watching
// the boat whom the rule lets it reach: the line was said with only
// machine sailors aboard. With a person aboard, nobody who is not aboard
// reads a word.
func (o chatOut) Deliver(l chat.Line, seat uint32, boat uint64, to []bus.Account) {
	e := o.e
	for _, a := range to {
		if c := e.registry.get(a); c != nil && c.onBoat(boat) {
			c.line(l, seat, "")
		}
	}
	if !l.Public || !l.Machine {
		return
	}
	watchers := e.watchers.of(boat, nil)
	if len(watchers) == 0 {
		return
	}
	from := bus.Account(l.From)
	var b []byte
	for _, c := range watchers {
		if e.registry.get(c.account) != c || !e.cfg.Chat.Reaches(from, c.account, aboard.Together{Watches: true}) {
			continue
		}
		if b == nil {
			var err error
			if b, err = protocol.AppendServer(nil, lineMessage(l, seat, "")); err != nil {
				return
			}
		}
		c.lineBytes(l.ID, b)
	}
}

// DeliverPair sends a message between shipmates to the receiver's
// connection, wherever it is in the game, while the two are shipmates
// still: a message in flight as they stop being shipmates is not
// delivered.
func (o chatOut) DeliverPair(l chat.Line, to bus.Account) {
	e := o.e
	c := e.registry.get(to)
	if c == nil || !e.cfg.Chat.Shipmates(bus.Account(l.From), to) {
		return
	}
	c.line(l, 0, store.AccountID(l.From).String())
}

// Changed tells the connections of the accounts given, or every one, how
// chat stands for them now.
func (o chatOut) Changed(accounts []bus.Account) {
	e := o.e
	if accounts != nil {
		for _, a := range accounts {
			if c := e.registry.get(a); c != nil {
				c.chatState(false)
			}
		}
		return
	}
	e.registry.mu.Lock()
	all := make([]*conn, 0, len(e.registry.by))
	for _, c := range e.registry.by {
		all = append(all, c)
	}
	e.registry.mu.Unlock()
	for _, c := range all {
		c.chatState(false)
	}
}

// chatCommand does what a Command asks of chat, if it asks anything.
func (c *conn) chatCommand(cmd *pb.Command) {
	switch {
	case cmd.GetSay() != nil && cmd.GetSay().GetTo() != "":
		c.sayToCommand(cmd.GetSay().GetTo(), cmd.GetSay().GetText(), cmd.GetSay().GetId())
	case cmd.GetSay() != nil:
		c.sayCommand(cmd.GetSay().GetText(), cmd.GetSay().GetId())
	case cmd.GetMute() != nil:
		c.tieCommand(cmd.GetMute().GetWho(), false, cmd.GetMute().GetOn())
	case cmd.GetBlock() != nil:
		c.tieCommand(cmd.GetBlock().GetWho(), true, cmd.GetBlock().GetOn())
	case cmd.GetReport() != nil:
		r := cmd.GetReport()
		c.reportCommand(r.GetWho(), r.GetReason(), r.GetNote())
	}
}

// refusals on the wire.
var chatRefusals = [...]pb.ChatRefusal{
	chat.NotRefused:     pb.ChatRefusal_CHAT_REFUSAL_UNSPECIFIED,
	chat.RefusedContact: pb.ChatRefusal_CHAT_REFUSAL_CONTACT,
	chat.RefusedLong:    pb.ChatRefusal_CHAT_REFUSAL_LONG,
	chat.RefusedFast:    pb.ChatRefusal_CHAT_REFUSAL_FAST,
	chat.RefusedSilent:  pb.ChatRefusal_CHAT_REFUSAL_SILENT,
	chat.RefusedNobody:  pb.ChatRefusal_CHAT_REFUSAL_NOBODY,
	chat.RefusedAway:    pb.ChatRefusal_CHAT_REFUSAL_AWAY,
	chat.RefusedResting: pb.ChatRefusal_CHAT_REFUSAL_RESTING,
}

// sayCommand says a line, and sends it back to its sender as said, or
// why not. A line refused for a word comes back as said.
func (c *conn) sayCommand(text string, id uint32) {
	h := c.e.cfg.Chat
	m := &pb.Chat{You: true, Echo: id, Refused: pb.ChatRefusal_CHAT_REFUSAL_SILENT}
	// A spectator says nothing, whatever its client sends.
	if h != nil && c.chat.in && !c.spectating.Load() {
		s := h.Say(c.account, text)
		m.Refused = chatRefusals[s.Refused]
		m.Seat = s.Seat
		if s.Refused == chat.NotRefused {
			m.Id, m.Name, m.Machine, m.AtUs, m.Text = s.Line.ID, s.Line.Name, s.Line.Machine, s.Line.At.UnixMicro(), s.Line.Text
			if s.Words {
				// Said to its sender alone: it has no number to name.
				m.Id = 0
			}
		}
		if s.Refused == chat.RefusedSilent || !s.Rest.IsZero() {
			defer c.chatState(false)
		}
	}
	c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Chat{Chat: m}}, outChat)
}

// sayToCommand says a message to a shipmate, named by their account's ID,
// and sends it back to its sender as said, or why not: a shipmate not in
// the game, or no longer one, reads as away.
func (c *conn) sayToCommand(to, text string, id uint32) {
	h := c.e.cfg.Chat
	m := &pb.Chat{You: true, Echo: id, Thread: to, Refused: pb.ChatRefusal_CHAT_REFUSAL_SILENT}
	who, ok := store.ParseID(to)
	switch {
	case h == nil || !c.chat.in:
	case !ok:
		m.Refused = pb.ChatRefusal_CHAT_REFUSAL_AWAY
	default:
		s := h.SayTo(c.account, bus.Account(who), text)
		m.Refused = chatRefusals[s.Refused]
		if s.Refused == chat.NotRefused {
			m.Id, m.Name, m.Machine, m.AtUs, m.Text = s.Line.ID, s.Line.Name, s.Line.Machine, s.Line.At.UnixMicro(), s.Line.Text
			if s.Words {
				m.Id = 0
			}
		}
		if s.Refused == chat.RefusedSilent || !s.Rest.IsZero() {
			defer c.chatState(false)
		}
	}
	c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Chat{Chat: m}}, outChat)
}

// whoOf is the account a Who names for the connection, its name and the
// boat it was named on; ok false for nobody it may name.
func (c *conn) whoOf(w *pb.Who) (a bus.Account, name string, boat uint64, line uint64, ok bool) {
	e := c.e
	switch {
	case w == nil:
	case w.GetLine() != 0:
		if e.cfg.Chat == nil || !c.heardLine(w.GetLine()) {
			return a, "", 0, 0, false
		}
		l, found := e.cfg.Chat.Rings.Line(w.GetLine())
		if !found {
			return a, "", 0, 0, false
		}
		b, _ := l.Room.Boat()
		return bus.Account(l.From), l.Name, b, l.ID, true
	default:
		f := e.cfg.Bus.Frames.Acquire()
		defer f.Release()
		h, aboard := c.handsOf(f)
		if !aboard {
			return a, "", 0, 0, false
		}
		var found bool
		a, name, found = e.personAt(f, h.slot, w.GetSeat())
		return a, name, h.boat, 0, found
	}
	return a, "", 0, 0, false
}

// tieCommand mutes or blocks someone aboard, or no longer. A skipper's
// block puts the person ashore.
func (c *conn) tieCommand(w *pb.Who, block, on bool) {
	e := c.e
	if e.cfg.Tie == nil {
		return
	}
	a, name, boat, _, ok := c.whoOf(w)
	if !ok || a == c.account {
		return
	}
	ctx, cancel := context.WithTimeout(e.ctx, ChatLookup)
	defer cancel()
	err := e.cfg.Tie(ctx, c.account, a, block, on)
	full := errors.Is(err, store.ErrTooManyTies)
	if err != nil && !full {
		e.cfg.Log.Warn("keeping a mute or a block", "request_id", c.reqID, "conn", c.id, "err", err)
		return
	}
	c.recrew.Store(true)
	ties := e.cfg.Chat.Rules.Ties
	m := &pb.Tied{Name: name, Full: full}
	if ties != nil {
		m.Muted, m.Blocked = ties.Mutes(c.account, a), ties.Blocked(c.account, a)
	}
	c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Tied{Tied: m}}, outChat)
	if !block || !on || full {
		return
	}
	c.putAshoreBlocked(a, boat)
}

// PutAshoreBlocked puts other ashore from the boat skipper sails, if they
// are aboard it: a skipper's block, made outside the game connection.
func (e *Edge) PutAshoreBlocked(skipper, other bus.Account) {
	if c := e.registry.get(skipper); c != nil {
		c.putAshoreBlocked(other, 0)
	}
}

// putAshoreBlocked puts a, whom the connection's account has blocked,
// ashore from the connection's own boat, if they are aboard it: on boat
// (the boat they were named on), or any for 0.
func (c *conn) putAshoreBlocked(a bus.Account, boat uint64) {
	e := c.e
	f := e.cfg.Bus.Frames.Acquire()
	h, aboard := c.handsOf(f)
	in := false
	if aboard && h.mine && (boat == 0 || h.boat == boat) {
		lo, hi := f.CrewOf(h.slot)
		for _, x := range f.Crew[lo:hi] {
			in = in || x.Account == a
		}
	}
	f.Release()
	if in {
		d := &e.decks
		d.mu.Lock()
		k := d.deckOf(h.boat, c.account)
		if k.put == nil {
			k.put = map[bus.Account]bool{}
		}
		k.put[a] = true
		d.mu.Unlock()
		e.disconnect(bus.Command{Op: bus.Ashore, Account: a, Boat: h.boat, Why: bus.AshorePut})
	}
}

// reportCommand reports someone aboard, or someone whose line the
// connection was sent.
func (c *conn) reportCommand(w *pb.Who, reason pb.ReportReason, note string) {
	e := c.e
	ok := false
	defer func() {
		c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Reported{Reported: &pb.Reported{Ok: ok}}}, outChat)
	}()
	why, known := reportReasons[reason]
	if e.cfg.Report == nil || !known {
		return
	}
	a, _, boat, line, found := c.whoOf(w)
	if !found || a == c.account {
		return
	}
	ctx, cancel := context.WithTimeout(e.ctx, ChatLookup)
	defer cancel()
	// A line with no boat is a message between shipmates.
	thread := line != 0 && boat == 0
	err := e.cfg.Report(ctx, ReportIn{Reporter: c.account, Reported: a, Boat: boat, Line: line, Reason: why, Note: note, Thread: thread})
	if err != nil {
		e.cfg.Log.Warn("keeping a report", "request_id", c.reqID, "conn", c.id, "err", err)
		return
	}
	ok = true
}
