// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Sailing together. A skipper shares a link; whoever opens it, signed in,
// knocks on the game connection with the link's token. The skipper is
// shown a card and answers it; let aboard, the knocker comes aboard the
// boat as its crew (bus.Board), their own boat leaving the water, and is
// encoded as a spectator of the boat is, its eye the boat's. One person
// aboard holds the boat's controls; the edge takes inputs from that
// person's connection alone, by the steering gate and the slot's
// generation, which moves on at each change of hands (sim's crew.go), so
// a former holder's words are never applied however late they come.
//
// What is the skipper's never passes: answering knocks, the link, putting
// anyone ashore, closing the boat to knocks. Knocks, offers of the
// controls, a boat closed to knocks and who was put ashore are kept here,
// in memory: they are lost harmlessly at a restart. Who is aboard and who
// holds the controls are the world's (bus.Frame's Crew and Holder).

// Knocks' numbers.
const (
	// KnockLapse is how long a knock waits for its skipper's answer.
	KnockLapse = 2 * time.Minute
	// KnocksWaiting is the most knocks that wait on one boat.
	KnocksWaiting = 5
	// KnocksAnHour is the most knocks one account makes in an hour.
	KnocksAnHour = 10
	// NotNowFor is how long a knocker may not knock on a boat again after
	// its skipper said not now.
	NotNowFor = 10 * time.Minute
	// HandLapse is how long an offer of the controls stands.
	HandLapse = 15 * time.Second
	// DeckLookup is how long the store may take to find a link or a
	// sailor for a knock.
	DeckLookup = 2 * time.Second
	// DefaultCrewLimit is how many may be aboard boats not their own at
	// once, across the world, when the configuration says nothing.
	DefaultCrewLimit = 1000
)

// LinkFound is a link's skipper as the store has it: what a knock needs.
type LinkFound struct {
	Skipper bus.Account
	Name    string
	Made    time.Time
	Expires time.Time
	Ended   bool
}

// Knocker is the knocking sailor as the store has them.
type Knocker struct {
	Name  string
	Look  uint32
	Born  int32 // year × 100 + month; 0 for not answered
	Rules bool  // the Rules of the sea accepted
}

// knock is a knock waiting for its skipper's answer.
type knock struct {
	id      uint64
	boat    uint64
	skipper bus.Account
	by      *conn
	name    string
	look    uint32
	timer   *time.Timer
	// What the knocker is told it is for.
	skipperName string
	kind        uint16
	boatName    string
}

// offer is the controls offered to someone aboard, until its lapse.
type offer struct {
	to    bus.Account
	from  string
	timer *time.Timer
}

// deck is what the edge keeps of a boat's company, by the boat.
type deck struct {
	skipper bus.Account
	closed  bool
	knocks  []*knock
	offer   *offer
	// put are those the skipper put ashore this voyage: they knock on the
	// boat in vain until it leaves the water.
	put map[bus.Account]bool
}

// decks are every boat's that has one, with the knocks and the knockers.
type decks struct {
	mu       sync.Mutex
	next     uint64
	by       map[uint64]*deck  // by boat
	knocks   map[uint64]*knock // by ID
	knocking map[*conn]*knock  // each knocker's waiting knock
	hour     map[bus.Account][]time.Time
	notNow   map[notNowKey]time.Time
	names    map[bus.Account]string // sailors' names, as players see them, for those aboard and their skippers
	put      map[uint64]bool        // boats whose decks' put-ashore marks are kept
	lastTidy time.Time
}

type notNowKey struct {
	knocker bus.Account
	boat    uint64
}

func (d *decks) init() {
	d.by = map[uint64]*deck{}
	d.knocks = map[uint64]*knock{}
	d.knocking = map[*conn]*knock{}
	d.hour = map[bus.Account][]time.Time{}
	d.notNow = map[notNowKey]time.Time{}
	d.names = map[bus.Account]string{}
}

// deckOf is boat's deck, made if it has none, for skipper. d.mu must be
// held.
func (d *decks) deckOf(boat uint64, skipper bus.Account) *deck {
	k := d.by[boat]
	if k == nil {
		k = &deck{skipper: skipper}
		d.by[boat] = k
	}
	return k
}

// name is a sailor's name as the edge knows it, "" if it does not.
func (d *decks) name(a bus.Account) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.names[a]
}

// knowName keeps a sailor's name.
func (d *decks) knowName(a bus.Account, name string) {
	if name == "" {
		return
	}
	d.mu.Lock()
	d.names[a] = name
	d.mu.Unlock()
}

// tidy forgets the decks of boats no longer in the water, and the
// knockers' counts and marks that have run out: at most once a minute.
func (e *Edge) tidyDecks(now time.Time) {
	d := &e.decks
	if now.Sub(d.lastTidy) < time.Minute {
		return
	}
	d.lastTidy = now
	f := e.cfg.Bus.Frames.Acquire()
	defer f.Release()
	live := map[uint64]bool{}
	for _, s := range f.Live {
		live[f.Boat[s]] = true
	}
	for boat, k := range d.by {
		if !live[boat] && len(k.knocks) == 0 && k.offer == nil {
			delete(d.by, boat)
		}
	}
	for a, ts := range d.hour {
		if len(ts) == 0 || now.Sub(ts[len(ts)-1]) > time.Hour {
			delete(d.hour, a)
		}
	}
	for key, until := range d.notNow {
		if now.After(until) {
			delete(d.notNow, key)
		}
	}
	aboard := map[bus.Account]bool{}
	for i := range f.Crew {
		aboard[f.Crew[i].Account] = true
		aboard[f.Owner[f.Crew[i].Slot]] = true
	}
	for a := range d.names {
		if !aboard[a] {
			delete(d.names, a)
		}
	}
}

// deckCommand does what a Command asks of a boat's company, if it asks
// anything.
func (c *conn) deckCommand(cmd *pb.Command) {
	now := time.Now()
	switch {
	case cmd.GetKnock() != nil:
		c.knockCommand(cmd.GetKnock().GetToken(), now)
	case cmd.GetAnswer() != nil:
		c.answerCommand(cmd.GetAnswer().GetKnock(), cmd.GetAnswer().GetLet(), now)
	case cmd.GetHand() != nil:
		c.handCommand(cmd.GetHand().GetTo())
	case cmd.GetTake() != nil:
		c.takeCommand()
	case cmd.GetGiveBack() != nil:
		c.giveBackCommand()
	case cmd.GetAshore() != nil:
		c.ashoreCommand(cmd.GetAshore().GetWho())
	case cmd.GetCloseKnocks() != nil:
		c.closeKnocks(cmd.GetCloseKnocks().GetClosed())
	}
}

// knocked tells a knocker how their knock stands.
func (c *conn) knocked(state pb.KnockState, skipper string, kind uint16, boat string) {
	c.e.m.knock(state)
	c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Knocking{Knocking: &pb.Knocking{
		State: state, Skipper: skipper, Kind: uint32(kind), Boat: boat,
	}}}, outKnocking)
}

// card shows a skipper a knock, or that it no longer waits.
func (c *conn) card(k *knock, gone bool) {
	c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Knock{Knock: &pb.KnockCard{
		Id: k.id, Sailor: k.name, Look: k.look, Gone: gone,
	}}}, outKnock)
}

// knockCommand is a knock by a link's token: looked up, every rule asked,
// and, if nothing refuses it, shown to the boat's skipper.
func (c *conn) knockCommand(token string, now time.Time) {
	e := c.e
	if e.cfg.Link == nil || e.cfg.Knocker == nil {
		c.knocked(pb.KnockState_KNOCK_STATE_ENDED, "", 0, "")
		return
	}
	d := &e.decks
	d.mu.Lock()
	ts := d.hour[c.account]
	for len(ts) > 0 && now.Sub(ts[0]) > time.Hour {
		ts = ts[1:]
	}
	if len(ts) >= KnocksAnHour {
		d.hour[c.account] = ts
		d.mu.Unlock()
		c.knocked(pb.KnockState_KNOCK_STATE_OFTEN, "", 0, "")
		return
	}
	d.hour[c.account] = append(ts, now)
	d.mu.Unlock()

	hash, err := aboard.TokenHash(token)
	if err != nil {
		c.knocked(pb.KnockState_KNOCK_STATE_ENDED, "", 0, "")
		return
	}
	ctx, cancel := context.WithTimeout(e.ctx, DeckLookup)
	defer cancel()
	l, err := e.cfg.Link(ctx, hash)
	switch {
	case errors.Is(err, store.ErrNotFound):
		c.knocked(pb.KnockState_KNOCK_STATE_ENDED, "", 0, "")
		return
	case err != nil:
		e.cfg.Log.Warn("looking up a link to come aboard", "request_id", c.reqID, "conn", c.id, "err", err)
		c.knocked(pb.KnockState_KNOCK_STATE_TRY_AGAIN, "", 0, "")
		return
	}
	sw := e.cfg.Switches
	if sw != nil && (!sw.Links() || !aboard.Live(l.Made, l.Expires, l.Ended, sw.Lifetime(), now)) || sw == nil && l.Ended {
		c.knocked(pb.KnockState_KNOCK_STATE_ENDED, l.Name, 0, "")
		return
	}
	if l.Skipper == c.account {
		c.knocked(pb.KnockState_KNOCK_STATE_OWN, l.Name, 0, "")
		return
	}
	who, err := e.cfg.Knocker(ctx, c.account)
	if err != nil {
		c.knocked(pb.KnockState_KNOCK_STATE_TRY_AGAIN, l.Name, 0, "")
		return
	}
	if !mayBoard(who, now) {
		c.knocked(pb.KnockState_KNOCK_STATE_FIRST, l.Name, 0, "")
		return
	}
	d.knowName(l.Skipper, l.Name)
	d.knowName(c.account, who.Name)

	f := e.cfg.Bus.Frames.Acquire()
	s := findBoat(f, l.Skipper)
	var boat uint64
	var kind uint16
	var boatName string
	state := e.boardable(f, s, c.account)
	if s >= 0 {
		boat, kind, boatName = f.Boat[s], f.Kind[s], f.BoatName[s]
		if lo, hi := f.CrewOf(s); state == pb.KnockState_KNOCK_STATE_UNSPECIFIED {
			for _, a := range f.Crew[lo:hi] {
				if a.Account == c.account {
					// Aboard already.
					state = pb.KnockState_KNOCK_STATE_LET
				}
			}
		}
	}
	f.Release()
	if state != pb.KnockState_KNOCK_STATE_UNSPECIFIED {
		c.knocked(state, l.Name, kind, boatName)
		return
	}

	d.mu.Lock()
	e.tidyDecks(now)
	k := d.deckOf(boat, l.Skipper)
	switch {
	case k.closed || k.put[c.account]:
		state = pb.KnockState_KNOCK_STATE_CLOSED
	case now.Before(d.notNow[notNowKey{c.account, boat}]):
		state = pb.KnockState_KNOCK_STATE_OFTEN
	case len(k.knocks) >= KnocksWaiting:
		state = pb.KnockState_KNOCK_STATE_BUSY
	}
	if state != pb.KnockState_KNOCK_STATE_UNSPECIFIED {
		d.mu.Unlock()
		c.knocked(state, l.Name, kind, boatName)
		return
	}
	// One knock at a time: a knock on another boat withdraws the last.
	old := d.knocking[c]
	if old != nil {
		e.dropKnock(old)
	}
	d.next++
	kn := &knock{id: d.next, boat: boat, skipper: l.Skipper, by: c, name: who.Name, look: who.Look, skipperName: l.Name, kind: kind, boatName: boatName}
	k.knocks = append(k.knocks, kn)
	d.knocks[kn.id] = kn
	d.knocking[c] = kn
	kn.timer = time.AfterFunc(KnockLapse, func() { e.lapse(kn) })
	d.mu.Unlock()
	if old != nil {
		if sk := e.registry.get(old.skipper); sk != nil {
			sk.card(old, true)
		}
	}
	c.knocked(pb.KnockState_KNOCK_STATE_WAITING, l.Name, kind, boatName)
	if sk := e.registry.get(l.Skipper); sk != nil && sk.joined.Load() && sk.boat == boat {
		sk.card(kn, false)
	}
}

// mayBoard reports whether a sailor may knock: the age question answered,
// 13 or over, and the Rules of the sea accepted.
func mayBoard(k Knocker, now time.Time) bool {
	b, ok := aboard.BornOf(k.Born)
	if !ok || !k.Rules {
		return false
	}
	band := aboard.BandOf(b, now)
	return band == aboard.Teen || band == aboard.Adult
}

// boardable is why the boat in slot s of f takes nobody aboard, for the
// knocker, or unspecified while it may: in the water, its skipper's own
// sailing (no machine sailor's boat takes anyone), boarding on for
// everyone, room aboard, the crews across the world under their limit,
// and nothing between the two.
func (e *Edge) boardable(f *bus.Frame, s int32, knocker bus.Account) pb.KnockState {
	switch {
	case s < 0:
		return pb.KnockState_KNOCK_STATE_NOT_AT_SEA
	case f.Machine[s]:
		return pb.KnockState_KNOCK_STATE_CLOSED
	case e.cfg.Switches != nil && !e.cfg.Switches.Boarding():
		return pb.KnockState_KNOCK_STATE_CLOSED
	case e.refuses(f.Owner[s], knocker):
		return pb.KnockState_KNOCK_STATE_CLOSED
	}
	lo, hi := f.CrewOf(s)
	if hi-lo+1 >= e.capacityOf(f.Kind[s]) {
		return pb.KnockState_KNOCK_STATE_FULL
	}
	if len(f.Crew) >= e.crewLimit() {
		return pb.KnockState_KNOCK_STATE_CROWDED
	}
	return pb.KnockState_KNOCK_STATE_UNSPECIFIED
}

// refuses reports whether a skipper and a knocker keep each other off
// their boats.
func (e *Edge) refuses(skipper, knocker bus.Account) bool {
	return e.cfg.Refuser != nil && e.cfg.Refuser.Refuses(skipper, knocker)
}

func (e *Edge) capacityOf(kind uint16) int {
	if int(kind) < len(e.cfg.Capacities) {
		return min(e.cfg.Capacities[kind], bus.MaxCrew+1)
	}
	return 1
}

func (e *Edge) crewLimit() int {
	if e.cfg.CrewLimit > 0 {
		return e.cfg.CrewLimit
	}
	return DefaultCrewLimit
}

// dropKnock forgets a knock: it no longer waits. d.mu must be held.
func (e *Edge) dropKnock(kn *knock) {
	d := &e.decks
	kn.timer.Stop()
	delete(d.knocks, kn.id)
	if d.knocking[kn.by] == kn {
		delete(d.knocking, kn.by)
	}
	if k := d.by[kn.boat]; k != nil {
		for i, x := range k.knocks {
			if x == kn {
				k.knocks = append(k.knocks[:i], k.knocks[i+1:]...)
				break
			}
		}
	}
}

// lapse ends a knock its skipper did not answer in time.
func (e *Edge) lapse(kn *knock) {
	d := &e.decks
	d.mu.Lock()
	if d.knocks[kn.id] != kn {
		d.mu.Unlock()
		return
	}
	e.dropKnock(kn)
	d.mu.Unlock()
	if sk := e.registry.get(kn.skipper); sk != nil {
		sk.card(kn, true)
	}
	if !kn.by.gone.Load() {
		kn.by.knocked(pb.KnockState_KNOCK_STATE_LAPSED, kn.skipperName, kn.kind, kn.boatName)
	}
}

// knockerGone withdraws the knock of a connection that has ended.
func (e *Edge) knockerGone(c *conn) {
	d := &e.decks
	d.mu.Lock()
	kn := d.knocking[c]
	if kn != nil {
		e.dropKnock(kn)
	}
	d.mu.Unlock()
	if kn != nil {
		if sk := e.registry.get(kn.skipper); sk != nil {
			sk.card(kn, true)
		}
	}
}

// resendKnocks shows a skipper, welcomed to their boat, the knocks
// waiting on it.
func (c *conn) resendKnocks() {
	d := &c.e.decks
	d.mu.Lock()
	var waiting []*knock
	if k := d.by[c.boat]; k != nil && k.skipper == c.account {
		waiting = append(waiting, k.knocks...)
	}
	d.mu.Unlock()
	for _, kn := range waiting {
		c.card(kn, false)
	}
}

// answerCommand is a skipper's answer to a knock on their boat.
func (c *conn) answerCommand(id uint64, let bool, now time.Time) {
	e := c.e
	d := &e.decks
	d.mu.Lock()
	kn := d.knocks[id]
	if kn == nil || kn.skipper != c.account || !c.joined.Load() || c.boat != kn.boat {
		d.mu.Unlock()
		return
	}
	e.dropKnock(kn)
	if !let {
		d.notNow[notNowKey{kn.by.account, kn.boat}] = now.Add(NotNowFor)
	}
	d.mu.Unlock()
	c.card(kn, true)
	by := kn.by
	if by.gone.Load() || e.registry.get(by.account) != by {
		return
	}
	if !let {
		by.knocked(pb.KnockState_KNOCK_STATE_NOT_NOW, kn.skipperName, kn.kind, kn.boatName)
		return
	}
	f := e.cfg.Bus.Frames.Acquire()
	s := findBoat(f, c.account)
	state := e.boardable(f, s, by.account)
	f.Release()
	if state != pb.KnockState_KNOCK_STATE_UNSPECIFIED {
		by.knocked(state, kn.skipperName, kn.kind, kn.boatName)
		return
	}
	by.board(kn)
}

// board brings the connection aboard the knock's boat, let aboard by its
// skipper: the simulation takes its own boat out of the water and puts it
// aboard, and its encoder welcomes it there.
func (c *conn) board(kn *knock) {
	e := c.e
	reply := make(chan bus.Reply, 1)
	c.boarded.Store(true)
	b := c.joinBoat
	err := e.cfg.Bus.Commands.Players().TrySend(bus.Command{Op: bus.Board, Boat: kn.boat, Account: c.account, Conn: c.id, Priority: c.priority,
		Look: c.look, Name: kn.name, BoatKind: b.Kind, BoatLook: b.Look, BoatName: b.Name, Reply: reply})
	if err != nil {
		c.knocked(pb.KnockState_KNOCK_STATE_TRY_AGAIN, kn.skipperName, kn.kind, kn.boatName)
		return
	}
	timer := time.NewTimer(e.lim.Join)
	defer timer.Stop()
	var r bus.Reply
	select {
	case r = <-reply:
	case <-timer.C:
		c.knocked(pb.KnockState_KNOCK_STATE_TRY_AGAIN, kn.skipperName, kn.kind, kn.boatName)
		return
	case <-c.closed:
		return
	}
	switch r.Result {
	case bus.Crewed:
		e.m.deck[deckArrived].Inc()
		c.knocked(pb.KnockState_KNOCK_STATE_LET, kn.skipperName, kn.kind, kn.boatName)
		e.decks.knowName(kn.skipper, kn.skipperName)
		c.ask(ask{kind: askAboard, r: r, name: kn.skipperName})
	case bus.NoRoom:
		c.knocked(pb.KnockState_KNOCK_STATE_FULL, kn.skipperName, kn.kind, kn.boatName)
	default:
		c.knocked(pb.KnockState_KNOCK_STATE_NOT_AT_SEA, kn.skipperName, kn.kind, kn.boatName)
	}
}

// closeKnocks closes the connection's own boat to knocks, or opens it.
func (c *conn) closeKnocks(closed bool) {
	if !c.joined.Load() {
		return
	}
	d := &c.e.decks
	d.mu.Lock()
	d.deckOf(c.boat, c.account).closed = closed
	d.mu.Unlock()
}

// The boat a connection is aboard or sails, and who holds its controls,
// as the latest frame has them.
type hands struct {
	slot    int32
	boat    uint64
	skipper bus.Account
	holder  bus.Account // the zero account for the skipper
	mine    bool        // the connection's own boat
}

// handsOf is the boat c sails or is aboard in f; ok is false for none.
func (c *conn) handsOf(f *bus.Frame) (h hands, ok bool) {
	switch {
	case c.joined.Load():
		s := c.slot
		if !f.Occupied[s] || f.Boat[s] != c.boat {
			return h, false
		}
		return hands{slot: s, boat: f.Boat[s], skipper: f.Owner[s], holder: f.Holder[s], mine: true}, true
	case c.crew.Load():
		if i := f.Aboard(c.account); i >= 0 {
			a := &f.Crew[i]
			return hands{slot: a.Slot, boat: a.Boat, skipper: f.Owner[a.Slot], holder: f.Holder[a.Slot]}, true
		}
	}
	return h, false
}

// holds reports whether h's holder is the connection's account.
func (h hands) holds(a bus.Account) bool {
	return h.mine && h.holder == (bus.Account{}) || !h.mine && h.holder == a
}

// personAt is the account in seat of the boat in slot s of f, and its
// name: the skipper's seat is 0.
func (e *Edge) personAt(f *bus.Frame, s int32, seat uint32) (bus.Account, string, bool) {
	if seat == 0 {
		return f.Owner[s], e.decks.name(f.Owner[s]), true
	}
	lo, hi := f.CrewOf(s)
	for _, a := range f.Crew[lo:hi] {
		if uint32(a.Seat) == seat {
			return a.Account, a.Name, true
		}
	}
	return bus.Account{}, "", false
}

// handCommand offers the boat's controls to the person in seat to, from
// whoever holds them.
func (c *conn) handCommand(to uint32) {
	e := c.e
	f := e.cfg.Bus.Frames.Acquire()
	h, ok := c.handsOf(f)
	var target bus.Account
	var from string
	if ok && h.holds(c.account) {
		var found bool
		target, _, found = e.personAt(f, h.slot, to)
		ok = found && target != c.account
		if lo, hi := f.CrewOf(h.slot); ok {
			from = e.decks.name(c.account)
			for _, a := range f.Crew[lo:hi] {
				if a.Account == c.account {
					from = a.Name
				}
			}
		}
	} else {
		ok = false
	}
	f.Release()
	if !ok {
		return
	}
	d := &e.decks
	d.mu.Lock()
	k := d.deckOf(h.boat, h.skipper)
	old := k.offer
	if old != nil {
		old.timer.Stop()
	}
	o := &offer{to: target, from: from}
	k.offer = o
	o.timer = time.AfterFunc(HandLapse, func() {
		d.mu.Lock()
		still := k.offer == o
		if still {
			k.offer = nil
		}
		d.mu.Unlock()
		if still {
			if t := e.registry.get(o.to); t != nil {
				t.handed(o, true)
			}
		}
	})
	d.mu.Unlock()
	if old != nil && old.to != target {
		if t := e.registry.get(old.to); t != nil {
			t.handed(old, true)
		}
	}
	if t := e.registry.get(target); t != nil {
		t.handed(o, false)
	}
	e.m.deck[deckOffered].Inc()
}

// handed tells a connection the controls are offered to it, or that the
// offer stands no longer.
func (c *conn) handed(o *offer, gone bool) {
	c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Handed{Handed: &pb.Handed{
		From: o.from, Seconds: uint32(HandLapse / time.Second), Gone: gone,
	}}}, outHanded)
}

// takeCommand takes the controls offered to the connection; from the
// boat's skipper, takes them back at once, offered or not.
func (c *conn) takeCommand() {
	e := c.e
	f := e.cfg.Bus.Frames.Acquire()
	h, ok := c.handsOf(f)
	f.Release()
	if !ok {
		return
	}
	d := &e.decks
	d.mu.Lock()
	k := d.by[h.boat]
	var o *offer
	if k != nil && k.offer != nil && (k.offer.to == c.account || h.mine) {
		o = k.offer
		k.offer = nil
		o.timer.Stop()
	}
	d.mu.Unlock()
	switch {
	case h.mine:
		if o != nil && o.to != c.account {
			if t := e.registry.get(o.to); t != nil {
				t.handed(o, true)
			}
		}
		if h.holder != (bus.Account{}) {
			e.m.deck[deckTakenBack].Inc()
			e.setHolder(h.boat, bus.Account{})
		}
	case o != nil:
		e.m.deck[deckTaken].Inc()
		e.setHolder(h.boat, c.account)
	}
}

// giveBackCommand gives the controls back to the skipper, from whoever
// holds them.
func (c *conn) giveBackCommand() {
	e := c.e
	f := e.cfg.Bus.Frames.Acquire()
	h, ok := c.handsOf(f)
	f.Release()
	if ok && !h.mine && h.holder == c.account {
		e.m.deck[deckGivenBack].Inc()
		e.setHolder(h.boat, bus.Account{})
	}
}

// setHolder asks the simulation to hand boat's controls to account, the
// zero account for its skipper. The connections learn of it from the
// frame that has it: the generation of the slot moves on, so nothing the
// former holder wrote applies from that tick.
func (e *Edge) setHolder(boat uint64, account bus.Account) {
	e.disconnect(bus.Command{Op: bus.SetHolder, Boat: boat, Account: account})
}

// ashoreCommand goes ashore from the boat the connection is aboard; from
// the skipper, puts the person in seat who ashore, for the rest of the
// boat's voyage.
func (c *conn) ashoreCommand(who uint32) {
	e := c.e
	f := e.cfg.Bus.Frames.Acquire()
	h, ok := c.handsOf(f)
	var target bus.Account
	if ok && h.mine && who != 0 {
		target, _, ok = e.personAt(f, h.slot, who)
		ok = ok && target != c.account
	}
	f.Release()
	switch {
	case !ok:
	case !h.mine && who == 0:
		e.disconnect(bus.Command{Op: bus.Ashore, Account: c.account, Boat: h.boat, Why: bus.AshoreChose})
	case h.mine && who != 0:
		d := &e.decks
		d.mu.Lock()
		k := d.deckOf(h.boat, c.account)
		if k.put == nil {
			k.put = map[bus.Account]bool{}
		}
		k.put[target] = true
		d.mu.Unlock()
		e.disconnect(bus.Command{Op: bus.Ashore, Account: target, Boat: h.boat, Why: bus.AshorePut})
	}
}

// LinkCan says whether viewer may knock on skipper's boat now, as the
// game connection would answer a knock: "ok", or "not-at-sea", "full" or
// "closed" ("closed" too for a block, never saying so), and the boat's
// kind and name. The link and its lifetime are the caller's to check.
func (e *Edge) LinkCan(skipper, viewer store.AccountID) (can string, kind uint16, boat string) {
	f := e.cfg.Bus.Frames.Acquire()
	s := findBoat(f, bus.Account(skipper))
	state := e.boardable(f, s, bus.Account(viewer))
	var b uint64
	if s >= 0 {
		kind, boat, b = f.Kind[s], f.BoatName[s], f.Boat[s]
	}
	f.Release()
	if state == pb.KnockState_KNOCK_STATE_UNSPECIFIED {
		d := &e.decks
		d.mu.Lock()
		if k := d.by[b]; k != nil && (k.closed || k.put[bus.Account(viewer)]) {
			state = pb.KnockState_KNOCK_STATE_CLOSED
		}
		d.mu.Unlock()
	}
	switch state {
	case pb.KnockState_KNOCK_STATE_UNSPECIFIED:
		return "ok", kind, boat
	case pb.KnockState_KNOCK_STATE_NOT_AT_SEA:
		return "not-at-sea", kind, boat
	case pb.KnockState_KNOCK_STATE_FULL, pb.KnockState_KNOCK_STATE_CROWDED:
		return "full", kind, boat
	}
	return "closed", kind, boat
}
