// SPDX-License-Identifier: AGPL-3.0-only

// Package chat is the server's memory of what players say to each other,
// and the limits on saying it. A line is kept here and nowhere else: in
// memory, for half an hour, so that a player can report it, and then it is
// gone. A report copies what is here. Nothing in this package logs or
// prints a line, or puts its text into an error or a metric.
//
// The memory is bounded whatever players do: each room keeps its newest
// lines, each sender a share of the whole, and every room together a
// number of bytes, past which the oldest lines anywhere go first.
package chat

import (
	"bytes"
	"math"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// The longest line and name kept: a longer one is cut, at a character.
const (
	MaxTextRunes = 200
	MaxTextBytes = 4 * MaxTextRunes
	MaxNameBytes = 80
)

// What the memory counts, a fair upper bound of the heap it holds
// (TestOverheads measures it). A line is counted as its text, rounded up
// as Go's allocator rounds it, its sender's name, and LineOverhead: its
// node in the lists and its place in the index by ID. A room and a sender
// count RoomOverhead and SenderOverhead each while they have lines: their
// lists and their places in the maps.
const (
	LineOverhead   = 176
	RoomOverhead   = 192
	SenderOverhead = 96
)

// sizes are Go's allocator's size classes, up to a little past the
// longest text.
var sizes = [...]int{8, 16, 24, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 288, 320, 352, 384, 416, 448, 480, 512, 576, 640, 704, 768, 896, 1024}

// allocated is what a text of n bytes holds of the heap.
func allocated(n int) int {
	if n == 0 {
		return 0
	}
	if i, _ := slices.BinarySearch(sizes[:], n); i < len(sizes) {
		return sizes[i]
	}
	return n
}

// Cost is what a line of the text and the name given is counted as.
func Cost(text, name string) int { return allocated(len(text)) + len(name) + LineOverhead }

// Room is where a line is said: a boat's company, or a pair of shipmates.
// Rooms are comparable, and serve as map keys.
type Room struct {
	boat uint64
	a, b [16]byte
	kind roomKind
}

type roomKind uint8

const (
	noRoom roomKind = iota
	boatRoom
	pairRoom
)

// Boat is the company aboard a boat, by its boat ID.
func Boat(id uint64) Room { return Room{kind: boatRoom, boat: id} }

// Pair is two accounts' room: the same whichever order they are given in.
func Pair(a, b [16]byte) Room {
	if bytes.Compare(a[:], b[:]) > 0 {
		a, b = b, a
	}
	return Room{kind: pairRoom, a: a, b: b}
}

// Boat is the room's boat, if it is a boat's.
func (r Room) Boat() (uint64, bool) { return r.boat, r.kind == boatRoom }

// Pair is the room's two accounts, in Pair's order, if it is a pair's.
func (r Room) Pair() (a, b [16]byte, ok bool) { return r.a, r.b, r.kind == pairRoom }

// Line is one line said.
type Line struct {
	ID      uint64 // given by Add: unique for the process, increasing
	Room    Room
	From    [16]byte  // the sender's account
	Name    string    // the sender's name, as players see it
	Machine bool      // a machine sailor's
	At      time.Time // given by Add from the clock if zero
	Text    string
}

// Limits bound the memory whatever players do.
type Limits struct {
	// Keep is how long a line is kept: one older is gone.
	Keep time.Duration
	// RoomLines is how many of a room's newest lines are kept; past it,
	// the room's oldest go first.
	RoomLines int
	// SenderLines and SenderBytes bound one account's lines held across
	// every room at once: past either, that sender's oldest lines,
	// anywhere, go first, and nobody else's.
	SenderLines int
	SenderBytes int
	// Bytes bounds every room together: past it, the oldest lines
	// anywhere go first.
	Bytes int
}

// DefaultLimits are the game's: half an hour, 200 lines a room, 200 lines
// or 64 KiB a sender, 64 MiB in all.
func DefaultLimits() Limits {
	return Limits{
		Keep:        30 * time.Minute,
		RoomLines:   200,
		SenderLines: 200,
		SenderBytes: 64 << 10,
		Bytes:       64 << 20,
	}
}

// Drop is why a line left the memory.
type Drop uint8

// The reasons a line is dropped.
const (
	DropExpired Drop = iota // older than Keep
	DropRoom                // past its room's RoomLines
	DropSender              // past its sender's SenderLines or SenderBytes
	DropBuffer              // past Bytes
	DropRemoved             // taken out by Remove
	DropReasons
)

var dropNames = [DropReasons]string{"expired", "room", "sender", "buffer", "removed"}

// Name is the reason as a metric's label has it.
func (d Drop) Name() string {
	if d < DropReasons {
		return dropNames[d]
	}
	return "unknown"
}

// Stats are what the memory holds now, and what it has dropped so far.
type Stats struct {
	Lines, Bytes int
	Dropped      [DropReasons]uint64
}

// Each line is in three lists at once: every line's, in time order; its
// room's; and its sender's. So whichever limit drops it, it leaves all
// three at once.
const (
	byTime = iota
	byRoom
	bySender
	lists
)

type node struct {
	id     uint64
	at     int64 // Unix nanoseconds
	name   string
	text   string
	link   [lists]struct{ prev, next *node }
	room   *room
	sender *sender
	cost   int32
	// machine is a machine sailor's line.
	machine bool
}

type list struct {
	head, tail *node
	n, bytes   int
}

func (l *list) push(k int, n *node) {
	n.link[k].prev = l.tail
	n.link[k].next = nil
	if l.tail != nil {
		l.tail.link[k].next = n
	} else {
		l.head = n
	}
	l.tail = n
	l.n++
	l.bytes += int(n.cost)
}

func (l *list) remove(k int, n *node) {
	p, x := n.link[k].prev, n.link[k].next
	if p != nil {
		p.link[k].next = x
	} else {
		l.head = x
	}
	if x != nil {
		x.link[k].prev = p
	} else {
		l.tail = p
	}
	n.link[k].prev, n.link[k].next = nil, nil
	l.n--
	l.bytes -= int(n.cost)
}

type room struct {
	key Room
	list
}

type sender struct {
	id [16]byte
	// name is the sender's latest name, shared by their lines that have
	// it, so a name is kept once and not once a line.
	name string
	list
}

type follow struct {
	until int64
	fn    func(Line)
}

// Rings are every room's lines of the last Keep. They are safe for
// concurrent use.
type Rings struct {
	limits Limits
	now    func() time.Time

	mu      sync.Mutex
	next    uint64
	last    int64 // the latest line's time
	all     list
	bytes   int // every line's, room's and sender's count
	byID    map[uint64]*node
	rooms   map[Room]*room
	senders map[[16]byte]*sender
	follows map[Room][]*follow
	dropped [DropReasons]uint64
	// most are the most each map has held since it was made.
	most struct{ lines, rooms, senders int }
}

// NewRings are empty rings under l, on the clock now. A field of l that
// is zero or less takes DefaultLimits' value.
func NewRings(l Limits, now func() time.Time) *Rings {
	d := DefaultLimits()
	if l.Keep <= 0 {
		l.Keep = d.Keep
	}
	if l.RoomLines <= 0 {
		l.RoomLines = d.RoomLines
	}
	if l.SenderLines <= 0 {
		l.SenderLines = d.SenderLines
	}
	if l.SenderBytes <= 0 {
		l.SenderBytes = d.SenderBytes
	}
	if l.Bytes <= 0 {
		l.Bytes = d.Bytes
	}
	return &Rings{
		limits:  l,
		now:     now,
		next:    1,
		byID:    make(map[uint64]*node),
		rooms:   make(map[Room]*room),
		senders: make(map[[16]byte]*sender),
		follows: make(map[Room][]*follow),
	}
}

// Add keeps l, applying every limit, and returns it as kept: with its ID,
// its time, and its text and name cut to the longest kept. A zero At is
// the clock's now; a given one is kept no earlier than the last line's and
// no later than now, so lines stay in time order. Every Follow of the room
// is told of it, outside the lock, before Add returns. A line can be past
// a limit on its own (a sender's bytes under tiny limits): it is then
// dropped at once, and Line does not find it.
func (r *Rings) Add(l Line) Line {
	l.Text = cut(l.Text, MaxTextRunes, MaxTextBytes)
	l.Name = cut(l.Name, MaxNameBytes, MaxNameBytes)
	cost := Cost(l.Text, l.Name)
	// A copy of its own, so a line never holds on to a larger buffer its
	// text was cut from.
	l.Text = strings.Clone(l.Text)

	r.mu.Lock()
	now := r.clock()
	at := now
	if !l.At.IsZero() {
		at = min(max(nanos(l.At), r.last), now)
	}
	r.last = at
	l.ID = r.next
	r.next++
	l.At = time.Unix(0, at).UTC()

	s := r.senders[l.From]
	if s == nil {
		s = &sender{id: l.From}
		r.senders[l.From] = s
		r.bytes += SenderOverhead
	}
	if s.name != l.Name {
		s.name = strings.Clone(l.Name)
	}
	l.Name = s.name
	rm := r.rooms[l.Room]
	if rm == nil {
		rm = &room{key: l.Room}
		r.rooms[l.Room] = rm
		r.bytes += RoomOverhead
	}
	n := &node{id: l.ID, at: at, name: l.Name, text: l.Text, room: rm, sender: s, cost: int32(cost), machine: l.Machine}
	r.all.push(byTime, n)
	rm.push(byRoom, n)
	s.push(bySender, n)
	r.byID[n.id] = n
	r.bytes += cost
	r.most.lines = max(r.most.lines, len(r.byID))
	r.most.rooms = max(r.most.rooms, len(r.rooms))
	r.most.senders = max(r.most.senders, len(r.senders))

	r.expire(now)
	for rm.n > r.limits.RoomLines {
		r.drop(rm.head, DropRoom)
	}
	for s.n > r.limits.SenderLines || s.bytes > r.limits.SenderBytes {
		r.drop(s.head, DropSender)
	}
	for r.bytes > r.limits.Bytes {
		r.drop(r.all.head, DropBuffer)
	}

	var told []func(Line)
	if fs := r.follows[l.Room]; len(fs) > 0 {
		live := fs[:0]
		for _, f := range fs {
			if now < f.until {
				live = append(live, f)
				told = append(told, f.fn)
			}
		}
		clear(fs[len(live):])
		if len(live) == 0 {
			delete(r.follows, l.Room)
		} else {
			r.follows[l.Room] = live
		}
	}
	r.mu.Unlock()

	for _, fn := range told {
		fn(l)
	}
	return l
}

// Lines are copies of the room's lines at or after since and within Keep,
// oldest first.
func (r *Rings) Lines(room Room, since time.Time) []Line {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.expire(r.clock())
	rm := r.rooms[room]
	if rm == nil {
		return nil
	}
	s := nanos(since)
	first, k := rm.tail, 0
	for n := rm.tail; n != nil && n.at >= s; n = n.link[byRoom].prev {
		first, k = n, k+1
	}
	if k == 0 {
		return nil
	}
	out := make([]Line, 0, k)
	for n := first; n != nil; n = n.link[byRoom].next {
		out = append(out, n.line())
	}
	return out
}

// Line is a copy of the line with the ID given, if it is still kept.
func (r *Rings) Line(id uint64) (Line, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.expire(r.clock())
	n := r.byID[id]
	if n == nil {
		return Line{}, false
	}
	return n.line(), true
}

// Remove takes the line with the ID given out of the memory, and reports
// whether it was there.
func (r *Rings) Remove(id uint64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.expire(r.clock())
	n := r.byID[id]
	if n == nil {
		return false
	}
	r.drop(n, DropRemoved)
	return true
}

// Follow calls fn with every line Added to room from now until until,
// each a copy. fn is called outside the lock, by the goroutine that
// Added the line, before its Add returns: so fn may call the rings, and
// lines Added at once from several goroutines reach it at once, and not
// always in their IDs' order. stop ends the following early; once stop
// returns, fn is not called for a line Added after. Following ends by
// itself at until.
func (r *Rings) Follow(room Room, until time.Time, fn func(Line)) (stop func()) {
	f := &follow{until: nanos(until), fn: fn}
	r.mu.Lock()
	if r.clock() < f.until {
		r.follows[room] = append(r.follows[room], f)
	}
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		fs := r.follows[room]
		if i := slices.Index(fs, f); i >= 0 {
			fs = slices.Delete(fs, i, i+1)
		}
		if len(fs) == 0 {
			delete(r.follows, room)
		} else {
			r.follows[room] = fs
		}
	}
}

// Tidy drops the lines that have expired, forgets the follows that have
// ended, and gives back the memory of maps that held many more than they
// do. Callers run it about once a minute.
func (r *Rings) Tidy() {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.clock()
	r.expire(now)
	r.byID = shrunk(r.byID, &r.most.lines)
	r.rooms = shrunk(r.rooms, &r.most.rooms)
	r.senders = shrunk(r.senders, &r.most.senders)
	for room, fs := range r.follows {
		live := fs[:0]
		for _, f := range fs {
			if now < f.until {
				live = append(live, f)
			}
		}
		clear(fs[len(live):])
		if len(live) == 0 {
			delete(r.follows, room)
		} else {
			r.follows[room] = live
		}
	}
}

// Stats are the lines and bytes held now, and the lines dropped so far
// by why.
func (r *Rings) Stats() Stats {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Stats{Lines: r.all.n, Bytes: r.bytes, Dropped: r.dropped}
}

// clock is now, never before the latest line's time.
func (r *Rings) clock() int64 { return max(nanos(r.now()), r.last) }

// expire drops the lines older than Keep, oldest first.
func (r *Rings) expire(now int64) {
	edge := now - int64(r.limits.Keep)
	for r.all.head != nil && r.all.head.at <= edge {
		r.drop(r.all.head, DropExpired)
	}
}

func (r *Rings) drop(n *node, why Drop) {
	r.all.remove(byTime, n)
	n.room.remove(byRoom, n)
	if n.room.n == 0 {
		delete(r.rooms, n.room.key)
		r.bytes -= RoomOverhead
	}
	n.sender.remove(bySender, n)
	if n.sender.n == 0 {
		delete(r.senders, n.sender.id)
		r.bytes -= SenderOverhead
	}
	delete(r.byID, n.id)
	r.bytes -= int(n.cost)
	r.dropped[why]++
}

// shrunk is m made anew when it holds a quarter or less of the most it
// has held since it was made: Go's maps never give memory back, so this
// keeps a map's memory to what it holds, within a few times.
func shrunk[K comparable, V any](m map[K]V, most *int) map[K]V {
	if *most < 1024 || len(m) > *most/4 {
		return m
	}
	n := make(map[K]V, len(m))
	for k, v := range m {
		n[k] = v
	}
	*most = len(m)
	return n
}

func (n *node) line() Line {
	return Line{
		ID:      n.id,
		Room:    n.room.key,
		From:    n.sender.id,
		Name:    n.name,
		Machine: n.machine,
		At:      time.Unix(0, n.at).UTC(),
		Text:    n.text,
	}
}

var (
	minTime = time.Unix(0, math.MinInt64)
	maxTime = time.Unix(0, math.MaxInt64)
)

// nanos is t in Unix nanoseconds, held to what an int64 holds.
func nanos(t time.Time) int64 {
	switch {
	case t.Before(minTime):
		return math.MinInt64
	case t.After(maxTime):
		return math.MaxInt64
	}
	return t.UnixNano()
}

// cut is s to at most runes characters and bytes bytes, cut at a
// character.
func cut(s string, runes, bytes int) string {
	if len(s) <= runes && len(s) <= bytes {
		return s
	}
	n := 0
	for i := 0; i < len(s); n++ {
		if n == runes {
			return s[:i]
		}
		_, w := utf8.DecodeRuneInString(s[i:])
		if i+w > bytes {
			return s[:i]
		}
		i += w
	}
	return s
}
