// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/chat"
)

// Chat aboard, for machine sailors. Each machine sailor whose helm is at
// sea in a world is a speaker in that world's hub, with what chat's rule
// needs of it: its human's age band, switch, Rules of the sea and the
// owner's mute, as the store's Talker gives them. Its agent says a line
// with say, through the hub, under the same filter and limits as a
// person's line; the hub hands every line that may reach a machine sailor
// to the core's door, which puts it in the helm's events as player text
// and wakes a wait on chat. Nothing of a line's text is logged or counted
// here: the events live in the helm's memory alone.

// Deck is the game's own side of sailing together, as a skipper's agent
// reaches it: the edge keeps who was put ashore from a boat, so that they
// knock on it in vain until it leaves the water.
type Deck interface {
	// PutAshore puts who ashore from boat, by its skipper, and reports
	// whether they were aboard.
	PutAshore(boat uint64, skipper, who bus.Account) bool
	// Hand offers boat's controls from from, who holds them, to to; Take
	// has account take them, offered it, or back at once as the skipper.
	Hand(boat uint64, from, to bus.Account) bool
	Take(boat uint64, account bus.Account) bool
}

// chatLookup is how long the store may take to find what chat needs of a
// machine sailor; speakAgain how long a helm waits to try again after the
// store failed.
const (
	chatLookup = 2 * time.Second
	speakAgain = time.Minute
)

// chatOut is the core's door in a world's hub.
type chatOut struct {
	core *Core
	sea  *Sea
}

// Deliver hands a line to the helms of the machine sailors given, each
// let it by chat's rule, as an event that wakes a wait on chat.
func (o chatOut) Deliver(l chat.Line, seat uint32, _ uint64, to []bus.Account) {
	tick := int64(-1)
	for _, a := range to {
		hm := o.core.hub.helmByAccount(a)
		if hm == nil {
			continue
		}
		if tick < 0 {
			f := o.sea.Bus.Frames.Acquire()
			tick = f.Tick
			f.Release()
		}
		hm.heard(o.sea, l, seat, tick)
	}
}

// DeliverPair: machine sailors are never shipmates.
func (chatOut) DeliverPair(chat.Line, bus.Account) {}

// Changed: an agent is told how chat stands when it next says a line.
func (chatOut) Changed([]bus.Account) {}

// heard puts a line said aboard in the helm's events, at tick or after
// the last report, so the next report tells it.
func (h *helm) heard(s *Sea, l chat.Line, seat uint32, tick int64) {
	h.mu.Lock()
	if h.sea != s {
		h.mu.Unlock()
		return
	}
	tick = max(tick, h.seq+1, h.ring.last())
	human := h.human
	h.mu.Unlock()
	h.event(event{Tick: tick, Kind: evChat, Words: lineWords(l, seat, human)})
}

// lineWords are a line said aboard, as the report tells it: the sender's
// name and the line both player text, and the game's own words for who
// the sender is.
func lineWords(l chat.Line, seat uint32, owner [16]byte) string {
	who := []string{"human"}
	if l.Machine {
		who[0] = "machine"
	}
	if !l.Machine && l.From == owner && owner != ([16]byte{}) {
		who = append(who, "your owner")
	}
	if seat == 0 {
		who = append(who, "skipper")
	}
	name := l.Name
	if name == "" {
		name = "a sailor"
	}
	return fmt.Sprintf("%s (%s) said aboard: %s", playerText(name), strings.Join(who, ", "), playerText(l.Text))
}

// speak makes the helm its machine sailor's speaker in world s's chat, if
// it is not one already: what the rule needs looked up in the store. It
// reports whether it is one. With the helm's turn held and mu not.
func (h *helm) speak(ctx context.Context, s *Sea) bool {
	if s == nil || s.Chat == nil || s.Talker == nil {
		return false
	}
	now := time.Now()
	h.mu.Lock()
	old, tried := h.spoke, h.spokeTried
	h.mu.Unlock()
	if old == s.Chat {
		return true
	}
	if !tried.IsZero() && now.Sub(tried) < speakAgain {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, chatLookup)
	defer cancel()
	sp, name, err := s.Talker(ctx, bus.Account(h.account))
	if err != nil {
		h.mu.Lock()
		h.spokeTried = now
		h.mu.Unlock()
		h.core.cfg.Log.Warn("looking up a machine sailor for chat", "account", h.account.String(), "err", err)
		return false
	}
	if old != nil {
		old.Leave(bus.Account(h.account))
	}
	s.Chat.Join(sp, name)
	h.mu.Lock()
	h.spoke, h.human, h.spokeTried = s.Chat, sp.Human, time.Time{}
	stopped := h.ended != nil
	h.mu.Unlock()
	if stopped {
		h.unspeak()
		return false
	}
	return true
}

// unspeak takes the helm's machine sailor out of the chat it speaks in.
func (h *helm) unspeak() {
	h.mu.Lock()
	hub := h.spoke
	h.spoke = nil
	h.mu.Unlock()
	if hub != nil {
		hub.Leave(bus.Account(h.account))
	}
}

// sayArgs are say's.
type sayArgs struct {
	Text string `json:"text"`
	To   string `json:"to,omitempty"`
}

// The words of say.
const (
	wordsSaid       = "Said aboard."
	wordsNobody     = "Nobody is aboard to hear you."
	wordsNoChat     = "Chat aboard is not open in this world."
	wordsSayHail    = "Not yet: hailing the boats close by comes with a later update. Use to aboard for those aboard your boat."
	wordsSaySpect   = "Not yet: speaking to your spectators comes with a later update. Use to aboard for those aboard your boat."
	wordsSayContact = "Not said: links and contact details can't be sent aboard."
	wordsSayLong    = "Not said: a line is 1 to 200 characters."
	wordsSayRest    = " Too many of your lines were refused: you may say nothing for 10 minutes."
)

// say answers say: a line said aboard the boat the machine sailor sails
// or is aboard, through the world's chat.
func (c *Core) say(ctx context.Context, h *helm, o *sayArgs) (string, any, *refusal) {
	switch o.To {
	case "", "aboard":
	case "hail":
		return wordsSayHail, nil, nil
	case "spectators":
		return wordsSaySpect, nil, nil
	default:
		return "", nil, refuse(refusedArgs, "to is aboard, hail or spectators.")
	}
	s := c.sea.Load()
	if s == nil {
		return "", nil, refuse(refusedNoWorld, wordsNoWorld)
	}
	if s.Chat == nil {
		return "", nil, refuse(refusedChat, wordsNoChat)
	}
	if !h.speak(ctx, s) {
		return "", nil, refuse(refusedBusy, wordsBusy)
	}
	said := s.Chat.Say(bus.Account(h.account), o.Text)
	rest := ""
	if !said.Rest.IsZero() {
		rest = wordsSayRest
	}
	switch said.Refused {
	case chat.NotRefused:
		// A line refused for a word answers as said: its sender is never
		// told which.
		return wordsSaid, nil, nil
	case chat.RefusedNobody:
		return "", nil, refuse(refusedChat, wordsNobody)
	case chat.RefusedContact:
		return "", nil, refuse(refusedChat, wordsSayContact+rest)
	case chat.RefusedLong:
		return "", nil, refuse(refusedChat, wordsSayLong)
	case chat.RefusedFast:
		return "", nil, refuse(refusedChat, fmt.Sprintf("Not said: too fast. A line every %d seconds, %d at once, %d a minute: wait a few seconds.",
			int(chat.Every/time.Second), chat.Burst, chat.PerMinute))
	}
	why, until := s.Chat.State(bus.Account(h.account))
	return "", nil, refuse(refusedChat, silenceWords(why, until))
}

// silenceWords are why a machine sailor may say nothing now.
func silenceWords(why aboard.Silence, until time.Time) string {
	switch why {
	case aboard.ChatOff:
		return "Not said: chat aboard is resting for everyone just now."
	case aboard.OwnOff:
		return "Not said: your owner's chat is off. They turn it on in the game, on their account page."
	case aboard.NoRules:
		return "Not said: your owner has not accepted the Rules of the sea yet. They accept them in the game first."
	case aboard.Silenced:
		if !until.IsZero() {
			return fmt.Sprintf("Not said: you may say nothing until %s UTC.", until.UTC().Format("15:04"))
		}
		return "Not said: you may say nothing for now."
	}
	return "Not said: chat aboard is not open to you just now."
}
