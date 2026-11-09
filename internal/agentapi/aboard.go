// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Company aboard, as the report tells it: who else is aboard the boat the
// machine sailor sails or is aboard, each by their name as player text and
// the game's own words for who they are, and who holds the controls.

// aboardWords are the report's Aboard line for the boat in slot sl of f:
// "" for one with nobody but the machine sailor aboard. With mu held.
func (h *helm) aboardWords(s *Sea, f *bus.Frame, sl int32) string {
	me := bus.Account(h.account)
	lo, hi := f.CrewOf(sl)
	crew := f.Owner[sl] != me
	if lo == hi && !crew {
		return ""
	}
	holder := f.Holder[sl]
	who := func(a bus.Account, name string, machine bool, seat uint8) string {
		var marks []string
		if a == me {
			marks = append(marks, "you")
		} else if machine {
			marks = append(marks, "machine")
		} else {
			marks = append(marks, "human")
			if a == bus.Account(h.human) && h.human != ([16]byte{}) {
				marks = append(marks, "your owner")
			}
		}
		if seat == 0 {
			marks = append(marks, "skipper")
		} else {
			marks = append(marks, fmt.Sprintf("seat %d", seat))
		}
		if seat == 0 && holder == (bus.Account{}) || seat > 0 && holder == a {
			marks = append(marks, "holds the controls")
		}
		if a == me {
			return "you (" + strings.Join(marks[1:], ", ") + ")"
		}
		if name == "" {
			name = "a sailor"
		}
		return playerText(name) + " (" + strings.Join(marks, ", ") + ")"
	}
	skipperName := ""
	if crew && s.Chat != nil {
		skipperName = s.Chat.Name(f.Owner[sl])
	}
	people := []string{who(f.Owner[sl], skipperName, f.Machine[sl], 0)}
	for _, a := range f.Crew[lo:hi] {
		people = append(people, who(a.Account, a.Name, a.Machine, a.Seat))
	}
	line := strings.Join(people, " · ")
	if !crew {
		return line
	}
	if holder != me {
		line += " · you don't hold the controls: steer and trim wait until you are handed them (boat take)"
	}
	return line
}

// Sailing together, for machine sailors. A machine sailor may be crew
// aboard another machine sailor's boat, sent aboard by its owner and let
// aboard by the skipper machine sailor's owner (the edge's knocks), never
// by an agent. Aboard, its helm's slot and boat are the boat it is aboard;
// it steers and trims only while it holds the controls, as the frame's
// Holder says, and writes the slot with the frame's generation, which
// moves on at each change of hands. The controls pass between agents by
// boat's hand and take, through the edge, which keeps the offer; ashore
// takes a crew member ashore, its own boat in the water at the nearest
// port, and lets a skipper put someone ashore.

// errNotAtSea is a machine sailor sent aboard whose helm is not at sea.
var errNotAtSea = errors.New("agentapi: the machine sailor is not at sea")

// Board brings a machine sailor aboard boat through its helm, as its
// owner's knock was let aboard by the skipper machine sailor's owner: its
// own boat leaves the water in the same tick. errNotAtSea for one whose
// helm has no boat at sea now: the edge's Machines.
func (c *Core) Board(ctx context.Context, machine bus.Account, boat uint64) (bus.Reply, error) {
	c.mu.Lock()
	h := c.helms[store.AccountID(machine)]
	c.mu.Unlock()
	s := c.sea.Load()
	if h == nil || s == nil {
		return bus.Reply{}, errNotAtSea
	}
	h.mu.Lock()
	ok := h.sea == s && !h.away && h.boat != 0
	name, priority, look := h.name, h.priority, h.sailor
	h.mu.Unlock()
	if !ok {
		return bus.Reply{}, errNotAtSea
	}
	cmd := bus.Command{Op: bus.Board, Boat: boat, Account: machine, Conn: h.conn, Machine: true, Priority: priority, Name: name}
	if s.Looks != nil {
		cmd.Look = s.Looks.Code(machineLook(s.Looks, h.account, look))
	}
	// Its own boat, for when it goes ashore.
	f := s.Bus.Frames.Acquire()
	if sl := ownSlot(f, machine); sl >= 0 {
		cmd.BoatKind, cmd.BoatLook, cmd.BoatName = f.Kind[sl], f.BoatLook[sl], f.BoatName[sl]
	} else if i := f.Aboard(machine); i >= 0 {
		a := &f.Crew[i]
		cmd.BoatKind, cmd.BoatLook, cmd.BoatName = a.BoatKind, a.BoatLook, a.BoatName
	}
	f.Release()
	reply := make(chan bus.Reply, 1)
	cmd.Reply = reply
	if err := send(ctx, s, cmd); err != nil {
		return bus.Reply{}, err
	}
	t := time.NewTimer(joinWait)
	defer t.Stop()
	var r bus.Reply
	select {
	case r = <-reply:
	case <-t.C:
		return bus.Reply{}, errBusy
	case <-ctx.Done():
		return bus.Reply{}, ctx.Err()
	}
	if r.Result == bus.Crewed {
		h.mu.Lock()
		h.slot, h.gen, h.boat, h.queued, h.aboard, h.ordered = r.Slot, r.Gen, r.Boat, false, true, false
		h.mu.Unlock()
	}
	return r, nil
}

// ownSlot is the slot of an account's own boat in f, −1 for none.
func ownSlot(f *bus.Frame, a bus.Account) int32 {
	for _, s := range f.Live {
		if f.Owner[s] == a {
			return s
		}
	}
	return -1
}

// Handed tells a machine sailor's agent the controls are offered it by
// from, or that the offer stands no longer: the edge's Machines.
func (c *Core) Handed(machine bus.Account, from string, gone bool) {
	c.mu.Lock()
	h := c.helms[store.AccountID(machine)]
	c.mu.Unlock()
	if h == nil {
		return
	}
	if gone {
		h.event(event{Kind: evOfferGone, Words: "the offer of the controls has lapsed"})
		return
	}
	if from == "" {
		from = "a sailor"
	}
	h.event(event{Tick: h.nextTick(), Kind: evOffered,
		Words: fmt.Sprintf("%s offers you the controls: call boat with action take within %d seconds", playerText(from), int(handLapse/time.Second))})
}

// handLapse is how long an offer of the controls stands, as the edge
// holds it.
const handLapse = 15 * time.Second

// nextTick is the tick an event happening now is told at: the latest
// frame's, or after the last report, so the next report tells it.
func (h *helm) nextTick() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	tick := int64(0)
	if h.sea != nil {
		f := h.sea.Bus.Frames.Acquire()
		tick = f.Tick
		f.Release()
	}
	return max(tick, h.seq+1, h.ring.last())
}

// holdsIn reports whether the machine sailor holds the controls of the
// boat in slot sl of f: its own, unless handed on, or the boat it is
// aboard, handed them. With mu held.
func (h *helm) holdsIn(f *bus.Frame, sl int32) bool {
	if h.aboard {
		return f.Holder[sl] == bus.Account(h.account)
	}
	return f.Holder[sl] == (bus.Account{})
}

// controlsRefusal is why the machine sailor may not steer or trim the
// boat in slot sl of f, nil while it holds its controls. With mu held.
func (h *helm) controlsRefusal(s *Sea, f *bus.Frame, sl int32) *refusal {
	if h.holdsIn(f, sl) {
		return nil
	}
	return refuse(refusedControls, "You don't hold the controls: "+h.holderName(s, f, sl)+
		" does. Nothing was changed. Ask in say, or wait for them to be handed you: boat with action take then takes them.")
}

// holderName is who holds the controls of the boat in slot sl of f, as
// player text, "the skipper" or "a sailor aboard" when the name is not
// known.
func (h *helm) holderName(s *Sea, f *bus.Frame, sl int32) string {
	holder := f.Holder[sl]
	if holder == (bus.Account{}) {
		if s.Chat != nil {
			if n := s.Chat.Name(f.Owner[sl]); n != "" {
				return playerText(n) + ", the skipper,"
			}
		}
		return "the skipper"
	}
	lo, hi := f.CrewOf(sl)
	for _, a := range f.Crew[lo:hi] {
		if a.Account == holder && a.Name != "" {
			return playerText(a.Name)
		}
	}
	return "a sailor aboard"
}

// personNamed is the account aboard the boat in slot sl of f whose name is
// name, as names are matched; its name, and whether it is a machine
// sailor's.
func personNamed(s *Sea, f *bus.Frame, sl int32, name string) (bus.Account, string, bool) {
	want := fold(name)
	if want == "" {
		return bus.Account{}, "", false
	}
	lo, hi := f.CrewOf(sl)
	for _, a := range f.Crew[lo:hi] {
		if fold(a.Name) == want {
			return a.Account, a.Name, true
		}
	}
	if s.Chat != nil {
		if n := s.Chat.Name(f.Owner[sl]); n != "" && fold(n) == want {
			return f.Owner[sl], n, true
		}
	}
	return bus.Account{}, "", false
}

// crewNames are the names of those aboard the boat in slot sl of f but
// the machine sailor, for an answer that asks for one.
func (h *helm) crewNames(s *Sea, f *bus.Frame, sl int32) string {
	var names []string
	me := bus.Account(h.account)
	if f.Owner[sl] != me && s.Chat != nil {
		if n := s.Chat.Name(f.Owner[sl]); n != "" {
			names = append(names, playerText(n))
		}
	}
	lo, hi := f.CrewOf(sl)
	for _, a := range f.Crew[lo:hi] {
		if a.Account != me && a.Name != "" {
			names = append(names, playerText(a.Name))
		}
	}
	if len(names) == 0 {
		return "nobody else is aboard"
	}
	return "aboard: " + strings.Join(names, ", ")
}

// controls answers boat's hand, take and ashore: the controls passed to
// a sailor aboard by name, taken (handed them, or the skipper's at once),
// and going ashore, or the skipper putting a sailor aboard ashore.
func (c *Core) controls(ctx context.Context, h *helm, action, sailor string) (string, any, *refusal) {
	s := c.sea.Load()
	if s == nil {
		return "", nil, refuse(refusedNoWorld, wordsNoWorld)
	}
	f := s.Bus.Frames.Acquire()
	h.mu.Lock()
	found := h.sea == s && h.locate(f)
	sl, boat, aboard := h.slot, h.boat, h.aboard
	var r *refusal
	var who bus.Account
	var whoName string
	switch {
	case !found:
		r = refuse(refusedNotAtSea, wordsNotAtSea)
	case action == "hand" || action == "ashore" && sailor != "":
		var ok bool
		if who, whoName, ok = personNamed(s, f, sl, sailor); !ok || who == bus.Account(h.account) {
			r = refuse(refusedArgs, fmt.Sprintf("No sailor called %q is aboard: %s.", sailor, h.crewNames(s, f, sl)))
		} else if action == "hand" && !h.holdsIn(f, sl) {
			r = h.controlsRefusal(s, f, sl)
		}
	}
	owner := bus.Account(h.human)
	holds := found && h.holdsIn(f, sl)
	f.Release()
	h.mu.Unlock()
	if r != nil {
		return "", nil, r
	}
	if s.Deck == nil && action != "ashore" {
		return "", nil, refuse(refusedBusy, wordsBusy)
	}
	me := bus.Account(h.account)
	switch {
	case action == "hand":
		if !s.Deck.Hand(boat, me, who) {
			return "", nil, refuse(refusedBusy, wordsBusy)
		}
		return fmt.Sprintf("You offered the controls to %s for %d seconds: they hold them once they take them; until then you do.",
			playerText(whoName), int(handLapse/time.Second)), nil, nil
	case action == "take":
		if holds {
			return "You hold the controls already.", nil, nil
		}
		if !s.Deck.Take(boat, me) {
			return "", nil, refuse(refusedControls, "Nothing to take: the controls are not offered you. The one who holds them hands them with boat's hand.")
		}
		if aboard {
			return "You hold the controls: steer and trim sail the boat you are aboard.", nil, nil
		}
		return "You took the controls back: you steer and trim your boat again.", nil, nil
	case action == "ashore" && sailor == "":
		if !aboard {
			return "", nil, refuse(refusedArgs, "You are your boat's skipper: ashore takes sailor, someone aboard to put ashore. boat leave takes your boat out of the water.")
		}
		res, err := h.ashore(ctx, s, boat)
		if err != nil {
			return "", nil, refuse(refusedBusy, wordsBusy)
		}
		return ashoreWords(res), nil, nil
	}
	// The skipper puts someone ashore.
	if aboard {
		return "", nil, refuse(refusedArgs, "Only the skipper puts anyone ashore. ashore with no sailor takes you ashore.")
	}
	if who == owner && owner != (bus.Account{}) {
		return "", nil, refuse(refusedArgs, "Your owner goes ashore when they choose.")
	}
	if s.Deck == nil || !s.Deck.PutAshore(boat, me, who) {
		return "", nil, refuse(refusedBusy, wordsBusy)
	}
	return fmt.Sprintf("You put %s ashore: they may not come aboard again this voyage.", playerText(whoName)), nil, nil
}

// ashoreWords say how going ashore went.
func ashoreWords(r bus.Reply) string {
	switch r.Result {
	case bus.Joined:
		return "You went ashore: your own boat is in the water at the nearest port, and you hold its controls."
	case bus.Queued:
		return "You went ashore. " + queuedWords(r.Position)
	}
	return "You went ashore."
}

// inCompany reports whether the machine sailor is aboard another's boat,
// or has anyone aboard its own, in world s now.
func (h *helm) inCompany(s *Sea) bool {
	if s == nil {
		return false
	}
	f := s.Bus.Frames.Acquire()
	defer f.Release()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.sea != s || !h.locate(f) {
		return false
	}
	lo, hi := f.CrewOf(h.slot)
	return h.aboard || lo < hi
}

// crewRefusal is why a crew member may not do boat's action, the boat
// being another's: nil for one that may, or for a skipper.
func (h *helm) crewRefusal(action string) *refusal {
	h.mu.Lock()
	aboard := h.aboard
	h.mu.Unlock()
	if !aboard || action == "" || action == "list" || action == "sailor_look" {
		return nil
	}
	return refuse(refusedArgs, "You are aboard another's boat as crew: boat with action ashore takes you ashore, to your own boat at the nearest port, first.")
}

// deckEvents are what changed aboard the boat in slot sl of f since the
// hub last looked: the machine sailor come aboard it as crew, who else
// came aboard or went ashore, and who holds the controls. With mu held.
func (h *helm) deckEvents(s *Sea, f *bus.Frame, sl int32) []event {
	boat := f.Boat[sl]
	if h.deckOn == boat && h.deckSeen == f.Deck[sl] {
		return nil
	}
	me := bus.Account(h.account)
	now := map[bus.Account]string{}
	var arrived []string
	lo, hi := f.CrewOf(sl)
	for _, a := range f.Crew[lo:hi] {
		if a.Account == me {
			continue
		}
		now[a.Account] = a.Name
		if _, was := h.company[a.Account]; !was && h.deckOn == boat {
			arrived = append(arrived, playerText(nameOr(a.Name))+" came aboard")
		}
	}
	if f.Owner[sl] != me {
		now[f.Owner[sl]] = ""
	}
	var out []event
	if h.deckOn != boat {
		if h.aboard {
			seat := uint8(0)
			if i := f.Aboard(me); i >= 0 {
				seat = f.Crew[i].Seat
			}
			whose := "another's boat"
			if s.Chat != nil {
				if n := s.Chat.Name(f.Owner[sl]); n != "" {
					whose = playerText(n) + "'s boat"
				}
			}
			out = append(out, event{Tick: f.Tick, Kind: evAboard, Words: fmt.Sprintf(
				"you came aboard %s as crew, seat %d: your own boat has left the water; %s holds the controls", whose, seat, h.holderName(s, f, sl))})
		}
	} else {
		var gone []string
		for a, n := range h.company {
			if _, is := now[a]; !is {
				gone = append(gone, playerText(nameOr(n))+" went ashore")
			}
		}
		slices.Sort(arrived)
		slices.Sort(gone)
		for _, w := range append(arrived, gone...) {
			out = append(out, event{Tick: f.Tick, Kind: evDeck, Words: w})
		}
		if f.Holder[sl] != h.heldBy {
			words := h.holderName(s, f, sl) + " holds the controls now"
			if h.holdsIn(f, sl) {
				words = "you hold the controls now"
			}
			out = append(out, event{Tick: f.Tick, Kind: evDeck, Words: words})
		}
	}
	h.deckOn, h.deckSeen, h.company, h.heldBy = boat, f.Deck[sl], now, f.Holder[sl]
	return out
}

// nameOr is a name, or "a sailor" for none known.
func nameOr(n string) string {
	if n == "" {
		return "a sailor"
	}
	return n
}

// ashoreEventWords are what the report says of the machine sailor going
// ashore, for why, and what came of its own boat.
func ashoreEventWords(why uint8, result bus.Result) string {
	w := "you went ashore"
	switch why {
	case bus.AshorePut:
		w = "the skipper put you ashore"
	case bus.AshoreLeft:
		w = "the boat you were aboard left the water: you are ashore"
	case bus.AshoreGone:
		w = "you were taken ashore at the end of your grace"
	}
	switch result {
	case bus.Joined:
		return w + "; your own boat is in the water at the nearest port"
	case bus.Queued:
		return w + "; your own boat waits in the machine sailors' queue"
	}
	return w + "; your own boat is not in the water"
}
