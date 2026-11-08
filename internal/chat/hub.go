// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
)

// The hub: where a line is said and who hears it. Every door a line comes
// in by (the game connection, a machine sailor's agent) says it here, and
// every door that can hand a line to someone registers an Out, so that a
// person's line reaches a machine sailor aboard and a machine sailor's a
// person. For each line the hub finds the boat its sender is aboard in the
// latest frame, asks the filter and the limits, keeps it in the rings, and
// hands it to everyone aboard whom chat's rule lets it reach.

// Refusal is why a line was not said.
type Refusal uint8

// The refusals. A line refused for a word is none of these: it is said to
// its sender alone.
const (
	NotRefused Refusal = iota
	// RefusedContact: a link or a contact detail.
	RefusedContact
	// RefusedLong: longer than MaxTextRunes, or nothing.
	RefusedLong
	// RefusedFast: past the sender's budget.
	RefusedFast
	// RefusedSilent: the sender may say nothing now.
	RefusedSilent
	// RefusedNobody: the sender is aboard no boat with anyone else.
	RefusedNobody
	refusals
)

var refusalNames = [refusals]string{"said", "contact", "long", "fast", "silent", "nobody"}

// Name is the refusal's name for a metric label: "said" for none.
func (r Refusal) Name() string {
	if r < refusals {
		return refusalNames[r]
	}
	return ""
}

// Said is what came of a line: the line as kept (ID 0 when it was not),
// the sender's seat, and why it was refused. Words, when the filter found
// a listed word: the line comes back to its sender as said, and reached
// nobody. Rest is non-zero when this refusal began the sender's rest.
type Said struct {
	Line    Line
	Seat    uint32
	Refused Refusal
	Words   bool
	Rest    time.Time
	// Heard is how many it was handed to.
	Heard int
}

// Out is a door that hands lines to the people it serves.
type Out interface {
	// Deliver hands l, said from seat aboard boat, to those of the
	// accounts given that this door serves; each was let it by chat's rule.
	Deliver(l Line, seat uint32, boat uint64, to []bus.Account)
	// Changed says how chat may stand differently for the accounts given,
	// or for everyone when nil: the owner's switches, a player's own.
	Changed(accounts []bus.Account)
}

// Hub is chat's meeting place. Safe for concurrent use.
type Hub struct {
	Rings   *Rings
	Limiter *Limiter
	Rules   aboard.Rules
	frames  *bus.Frames
	now     func() time.Time
	// Metrics, if not nil, count lines by what came of them (never their
	// text), the memory, and how long a line took.
	Metrics *obs.Metrics
	dropped [DropReasons]uint64

	mu       sync.RWMutex
	speakers map[bus.Account]*present
	outs     []Out

	// counts are lines by what came of them (refusals, then words), and
	// deliveries; read for the metrics.
	counts     [refusals + 1]atomic.Uint64
	deliveries atomic.Uint64
}

// present is a speaker in the game, through n doors.
type present struct {
	s    aboard.Speaker
	name string
	n    int
}

// NewHub is a hub over the frames, with rings and limits of their
// defaults and chat's rule given, on the clock now.
func NewHub(frames *bus.Frames, rules aboard.Rules, now func() time.Time) *Hub {
	return &Hub{
		Rings: NewRings(DefaultLimits(), now), Limiter: NewLimiter(now), Rules: rules,
		frames: frames, now: now, speakers: map[bus.Account]*present{},
	}
}

// AddOut registers a door.
func (h *Hub) AddOut(o Out) {
	h.mu.Lock()
	h.outs = append(h.outs, o)
	h.mu.Unlock()
}

// Join says a speaker is in the game through one more door, with what the
// rule needs of them and their name as players see it; the latest join's
// are kept.
func (h *Hub) Join(s aboard.Speaker, name string) {
	a := bus.Account(s.Account)
	h.mu.Lock()
	p := h.speakers[a]
	if p == nil {
		p = &present{}
		h.speakers[a] = p
	}
	p.s, p.name, p.n = s, name, p.n+1
	h.mu.Unlock()
}

// Leave says a speaker left through one door; gone through every one,
// they are forgotten.
func (h *Hub) Leave(a bus.Account) {
	h.mu.Lock()
	if p := h.speakers[a]; p != nil {
		if p.n--; p.n <= 0 {
			delete(h.speakers, a)
		}
	}
	h.mu.Unlock()
}

// Update changes a speaker in the game, and every account whose human it
// is (a player's machine sailors), then tells the doors. False if neither
// is in the game.
func (h *Hub) Update(human bus.Account, fn func(*aboard.Speaker)) bool {
	var changed []bus.Account
	h.mu.Lock()
	for a, p := range h.speakers {
		if a == human || p.s.Human == human {
			fn(&p.s)
			changed = append(changed, a)
		}
	}
	h.mu.Unlock()
	if len(changed) > 0 {
		h.Changed(changed)
	}
	return len(changed) > 0
}

// Changed tells every door how chat may stand differently for the
// accounts given, or for everyone when nil.
func (h *Hub) Changed(accounts []bus.Account) {
	h.mu.RLock()
	outs := append([]Out(nil), h.outs...)
	h.mu.RUnlock()
	for _, o := range outs {
		o.Changed(accounts)
	}
}

// Speaker is a speaker in the game as the rule reads them now, resting by
// their refusals included.
func (h *Hub) Speaker(a bus.Account) (aboard.Speaker, bool) {
	h.mu.RLock()
	p := h.speakers[a]
	var s aboard.Speaker
	if p != nil {
		s = p.s
	}
	h.mu.RUnlock()
	if p == nil {
		return s, false
	}
	if _, ok := h.Limiter.Resting(s.Account); ok {
		s.Resting = true
	}
	return s, true
}

// State is how chat stands for a speaker now: why they may say nothing,
// or aboard.Speaks, and until when it rests (zero for until the owner
// looks, or not resting).
func (h *Hub) State(a bus.Account) (aboard.Silence, time.Time) {
	s, ok := h.Speaker(a)
	if !ok {
		return aboard.OwnOff, time.Time{}
	}
	why := h.Rules.MaySay(s, h.now())
	var until time.Time
	if why == aboard.Silenced && !s.Rested {
		until = s.MutedUntil
		if u, ok := h.Limiter.Resting(s.Account); ok && u.After(until) {
			until = u
		}
		if !h.now().Before(until) {
			until = time.Time{}
		}
	}
	return why, until
}

// Person is someone aboard a boat: their account, seat and kind.
type Person struct {
	Account bus.Account
	Seat    uint32
	Machine bool
}

// Company is who is aboard a boat in the latest frame: everyone, the
// skipper first; ok false if the boat is not in the water.
func (h *Hub) Company(boat uint64) (people []Person, ok bool) {
	f := h.frames.Acquire()
	defer f.Release()
	s := slotOf(f, boat)
	if s < 0 {
		return nil, false
	}
	return company(f, s), true
}

func slotOf(f *bus.Frame, boat uint64) int32 {
	for _, s := range f.Live {
		if f.Boat[s] == boat {
			return s
		}
	}
	return -1
}

func company(f *bus.Frame, s int32) []Person {
	lo, hi := f.CrewOf(s)
	people := make([]Person, 0, hi-lo+1)
	people = append(people, Person{Account: f.Owner[s], Machine: f.Machine[s]})
	for _, a := range f.Crew[lo:hi] {
		people = append(people, Person{Account: a.Account, Seat: uint32(a.Seat), Machine: a.Machine})
	}
	return people
}

// Where is the boat a speaker sails or is aboard in the latest frame, and
// their seat; ok false for none.
func (h *Hub) Where(a bus.Account) (boat uint64, seat uint32, ok bool) {
	f := h.frames.Acquire()
	defer f.Release()
	s, seat := whereIn(f, a)
	if s < 0 {
		return 0, 0, false
	}
	return f.Boat[s], seat, true
}

func whereIn(f *bus.Frame, a bus.Account) (int32, uint32) {
	if i := f.Aboard(a); i >= 0 {
		return f.Crew[i].Slot, uint32(f.Crew[i].Seat)
	}
	for _, s := range f.Live {
		if f.Owner[s] == a {
			return s, 0
		}
	}
	return -1, 0
}

// boatHuman is the human of a boat's skipper: the skipper, or a machine
// skipper's owner, as far as the hub knows it.
func (h *Hub) boatHuman(skipper Person) [16]byte {
	if !skipper.Machine {
		return skipper.Account
	}
	if s, ok := h.Speaker(skipper.Account); ok {
		return s.Human
	}
	return [16]byte{}
}

// Together is how those aboard stand to a line said among them, for the
// rule: aboard, with the skipper's human.
func (h *Hub) Together(people []Person) aboard.Together {
	if len(people) == 0 {
		return aboard.Together{}
	}
	return aboard.Together{Aboard: true, BoatHuman: h.boatHuman(people[0])}
}

// Reaches reports whether a line from from reaches to, standing as t.
func (h *Hub) Reaches(from bus.Account, to bus.Account, t aboard.Together) bool {
	fs, ok := h.Speaker(from)
	if !ok {
		return false
	}
	ts, ok := h.Speaker(to)
	if !ok {
		return false
	}
	return h.Rules.Delivered(fs, ts, t, h.now())
}

// Say says a line from an account, as the door that took it: checked,
// limited, kept and handed to everyone aboard it may reach.
func (h *Hub) Say(from bus.Account, text string) Said {
	start := time.Now()
	s := h.say(from, text)
	if m := h.Metrics; m != nil {
		m.ChatSay.Observe(time.Since(start).Seconds())
		name := s.Refused.Name()
		if s.Words {
			name = CountNames[refusals]
		}
		m.ChatLines.WithLabelValues(name).Inc()
		m.ChatDeliveries.Add(float64(s.Heard))
	}
	return s
}

func (h *Hub) say(from bus.Account, text string) Said {
	now := h.now()
	s, ok := h.Speaker(from)
	if !ok || h.Rules.MaySay(s, now) != aboard.Speaks {
		return h.count(Said{Refused: RefusedSilent})
	}
	f := h.frames.Acquire()
	slot, seat := whereIn(f, from)
	var people []Person
	var boat uint64
	var name string
	if slot >= 0 {
		people, boat = company(f, slot), f.Boat[slot]
		if seat > 0 {
			if i := f.Aboard(from); i >= 0 {
				name = f.Crew[i].Name
			}
		}
	}
	f.Release()
	if len(people) < 2 {
		return h.count(Said{Refused: RefusedNobody, Seat: seat})
	}
	if !h.Limiter.Allow(s.Account) {
		return h.count(Said{Refused: RefusedFast, Seat: seat})
	}
	clean, why := moderation.CheckChat(text)
	switch why {
	case moderation.ChatEmpty, moderation.ChatLong:
		return h.count(Said{Refused: RefusedLong, Seat: seat})
	case moderation.ChatContact:
		return h.count(Said{Refused: RefusedContact, Seat: seat, Rest: h.refused(s)})
	case moderation.ChatWords:
		out := Said{Seat: seat, Words: true, Rest: h.refused(s)}
		out.Line = Line{Room: Boat(boat), From: s.Account, Machine: s.Machine, At: now, Text: clean}
		h.counts[refusals].Add(1)
		return out
	}
	if name == "" {
		name = h.Name(from)
	}
	l := h.Rings.Add(Line{Room: Boat(boat), From: s.Account, Name: name, Machine: s.Machine, Text: clean})
	t := h.Together(people)
	var to []bus.Account
	for _, p := range people {
		if p.Account != from && h.Reaches(from, p.Account, t) {
			to = append(to, p.Account)
		}
	}
	out := Said{Line: l, Seat: seat, Heard: len(to)}
	h.mu.RLock()
	outs := append([]Out(nil), h.outs...)
	h.mu.RUnlock()
	for _, o := range outs {
		o.Deliver(l, seat, boat, to)
	}
	h.deliveries.Add(uint64(len(to)))
	return h.count(out)
}

// refused counts a refusal by the filter, and is when it began the
// sender's rest; the doors are told then.
func (h *Hub) refused(s aboard.Speaker) time.Time {
	until := h.Limiter.Refused(s.Account)
	if !until.IsZero() {
		h.Changed([]bus.Account{bus.Account(s.Account)})
	}
	return until
}

func (h *Hub) count(s Said) Said {
	h.counts[s.Refused].Add(1)
	return s
}

// Name is a speaker's name, as their door joined them, "" for one not in
// the game.
func (h *Hub) Name(a bus.Account) string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if p := h.speakers[a]; p != nil {
		return p.name
	}
	return ""
}

// Counts are the lines said by what came of them, by Refusal and then the
// lines refused for a word (said to their sender alone), and how many
// times a line was handed to someone.
func (h *Hub) Counts() (lines [refusals + 1]uint64, deliveries uint64) {
	for i := range h.counts {
		lines[i] = h.counts[i].Load()
	}
	return lines, h.deliveries.Load()
}

// Run tidies the memory and the limits once a minute, and counts what
// they hold and dropped, until ctx ends.
func (h *Hub) Run(ctx context.Context) {
	if m := h.Metrics; m != nil {
		for _, n := range CountNames {
			m.ChatLines.WithLabelValues(n)
		}
		for d := range Drop(DropReasons) {
			m.ChatDropped.WithLabelValues(d.Name())
		}
	}
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		h.tidy()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (h *Hub) tidy() {
	h.Rings.Tidy()
	h.Limiter.Tidy()
	m := h.Metrics
	if m == nil {
		return
	}
	st := h.Rings.Stats()
	m.ChatRingLines.Set(float64(st.Lines))
	m.ChatRingBytes.Set(float64(st.Bytes))
	for d := range Drop(DropReasons) {
		if n := st.Dropped[d]; n > h.dropped[d] {
			m.ChatDropped.WithLabelValues(d.Name()).Add(float64(n - h.dropped[d]))
			h.dropped[d] = n
		}
	}
}

// CountNames are the names of Counts' lines, for a metric label.
var CountNames = [refusals + 1]string{"said", "contact", "long", "fast", "silent", "nobody", "words"}
