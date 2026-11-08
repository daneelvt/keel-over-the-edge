// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

// clock is a fake clock, safe for concurrent use.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *clock { return &clock{t: time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)} }

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func account(i int) [16]byte {
	var a [16]byte
	a[0], a[1], a[2] = byte(i>>16), byte(i>>8), byte(i)
	a[15] = 0xa5
	return a
}

func say(r *Rings, room Room, from int, text string) Line {
	return r.Add(Line{Room: room, From: account(from), Name: fmt.Sprintf("sailor %d", from), Text: text})
}

// check holds r to its invariants: the three lists, the index, the counts
// and the limits agree, and nothing empty is remembered.
func check(t *testing.T, r *Rings) {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	n, b := 0, 0
	var prev *node
	for x := r.all.head; x != nil; x = x.link[byTime].next {
		if x.link[byTime].prev != prev {
			t.Fatalf("line %d: a broken link", x.id)
		}
		if prev != nil && (x.at < prev.at || x.id <= prev.id) {
			t.Fatalf("line %d out of order", x.id)
		}
		if r.byID[x.id] != x {
			t.Fatalf("line %d not in the index", x.id)
		}
		if int(x.cost) != Cost(x.text, x.name) {
			t.Fatalf("line %d costs %d", x.id, x.cost)
		}
		prev = x
		n++
		b += int(x.cost)
	}
	if n != r.all.n || b != r.all.bytes || n != len(r.byID) {
		t.Fatalf("%d lines and %d bytes, counted %d and %d, indexed %d", n, b, r.all.n, r.all.bytes, len(r.byID))
	}
	if total := b + len(r.rooms)*RoomOverhead + len(r.senders)*SenderOverhead; total != r.bytes || total > r.limits.Bytes {
		t.Fatalf("%d bytes held, counted %d, limit %d", total, r.bytes, r.limits.Bytes)
	}
	rn := 0
	for key, rm := range r.rooms {
		if rm.n == 0 || rm.key != key {
			t.Fatalf("room %v: %d lines", key, rm.n)
		}
		if rm.n > r.limits.RoomLines {
			t.Fatalf("room %v: %d lines", key, rm.n)
		}
		k := 0
		for x := rm.head; x != nil; x = x.link[byRoom].next {
			if x.room != rm {
				t.Fatalf("line %d in the wrong room", x.id)
			}
			k++
		}
		if k != rm.n {
			t.Fatalf("room %v: %d lines, counted %d", key, k, rm.n)
		}
		rn += k
	}
	sn := 0
	for id, s := range r.senders {
		if s.n == 0 || s.id != id {
			t.Fatalf("sender %x: %d lines", id, s.n)
		}
		if s.n > r.limits.SenderLines || s.bytes > r.limits.SenderBytes {
			t.Fatalf("sender %x: %d lines, %d bytes", id, s.n, s.bytes)
		}
		k, kb := 0, 0
		for x := s.head; x != nil; x = x.link[bySender].next {
			if x.sender != s {
				t.Fatalf("line %d with the wrong sender", x.id)
			}
			k++
			kb += int(x.cost)
		}
		if k != s.n || kb != s.bytes {
			t.Fatalf("sender %x: %d lines and %d bytes, counted %d and %d", id, k, kb, s.n, s.bytes)
		}
		sn += k
	}
	if rn != n || sn != n {
		t.Fatalf("%d lines, %d in rooms, %d by senders", n, rn, sn)
	}
}

func TestRooms(t *testing.T) {
	a, b := account(1), account(2)
	if Pair(a, b) != Pair(b, a) {
		t.Fatal("a pair differs by its order")
	}
	if x, y, ok := Pair(b, a).Pair(); !ok || x != a || y != b {
		t.Fatalf("Pair: %x %x %v", x, y, ok)
	}
	if _, ok := Pair(a, b).Boat(); ok {
		t.Fatal("a pair is a boat's")
	}
	if id, ok := Boat(7).Boat(); !ok || id != 7 {
		t.Fatalf("Boat: %d %v", id, ok)
	}
	if _, _, ok := Boat(7).Pair(); ok {
		t.Fatal("a boat's is a pair")
	}
	if Boat(0) == (Room{}) || Pair([16]byte{}, [16]byte{}) == (Room{}) || Boat(0) == Pair([16]byte{}, [16]byte{}) {
		t.Fatal("rooms of different kinds are equal")
	}
	m := map[Room]int{Boat(1): 1, Pair(a, b): 2}
	if m[Boat(1)] != 1 || m[Pair(b, a)] != 2 {
		t.Fatal("rooms as keys")
	}
}

func TestDropNames(t *testing.T) {
	seen := map[string]bool{}
	for d := range DropReasons {
		n := d.Name()
		if n == "" || n == "unknown" || seen[n] {
			t.Fatalf("drop %d: %q", d, n)
		}
		seen[n] = true
	}
}

func TestAdd(t *testing.T) {
	c := newClock()
	r := NewRings(DefaultLimits(), c.now)
	l := r.Add(Line{Room: Boat(3), From: account(1), Name: "Ann", Machine: true, Text: "ahoy"})
	if l.ID == 0 || !l.At.Equal(c.now()) || l.Text != "ahoy" || l.Name != "Ann" || !l.Machine || l.Room != Boat(3) || l.From != account(1) {
		t.Fatalf("added %+v", l)
	}
	got, ok := r.Line(l.ID)
	if !ok || got != l {
		t.Fatalf("Line: %+v %v, added %+v", got, ok, l)
	}
	c.add(time.Second)
	m := say(r, Boat(3), 2, "hello")
	if m.ID <= l.ID {
		t.Fatalf("IDs %d then %d", l.ID, m.ID)
	}
	if ls := r.Lines(Boat(3), time.Time{}); len(ls) != 2 || ls[0] != l || ls[1] != m {
		t.Fatalf("Lines: %+v", ls)
	}
	if ls := r.Lines(Boat(3), m.At); len(ls) != 1 || ls[0] != m {
		t.Fatalf("Lines since the second: %+v", ls)
	}
	if ls := r.Lines(Boat(3), m.At.Add(time.Nanosecond)); len(ls) != 0 {
		t.Fatalf("Lines since after the second: %+v", ls)
	}
	if ls := r.Lines(Boat(4), time.Time{}); ls != nil {
		t.Fatalf("Lines of an empty room: %+v", ls)
	}
	if s := r.Stats(); s.Lines != 2 || s.Bytes != Cost("ahoy", "Ann")+Cost("hello", "sailor 2")+RoomOverhead+2*SenderOverhead {
		t.Fatalf("Stats: %+v", s)
	}
	check(t, r)
}

func TestTimesInOrder(t *testing.T) {
	c := newClock()
	r := NewRings(DefaultLimits(), c.now)
	a := say(r, Boat(1), 1, "one")
	c.add(-time.Minute)
	b := say(r, Boat(1), 1, "two")
	if b.At.Before(a.At) {
		t.Fatalf("the clock went back and so did a line: %v then %v", a.At, b.At)
	}
	c.add(2 * time.Minute)
	early := r.Add(Line{Room: Boat(1), From: account(1), At: a.At.Add(-time.Hour), Text: "three"})
	given := r.Add(Line{Room: Boat(1), From: account(1), At: c.now().Add(-time.Second), Text: "four"})
	late := r.Add(Line{Room: Boat(1), From: account(1), At: c.now().Add(time.Hour), Text: "five"})
	if !early.At.Equal(b.At) || !given.At.Equal(c.now().Add(-time.Second)) || !late.At.Equal(c.now()) {
		t.Fatalf("given times kept as %v, %v and %v", early.At, given.At, late.At)
	}
	check(t, r)
}

func TestCut(t *testing.T) {
	c := newClock()
	r := NewRings(DefaultLimits(), c.now)
	for _, tc := range []struct {
		text  string
		runes int
	}{
		{strings.Repeat("a", 300), MaxTextRunes},
		{strings.Repeat("é", 300), MaxTextRunes},
		{strings.Repeat("🌊", 300), MaxTextRunes},
		{strings.Repeat("a", 199) + "🌊🌊", MaxTextRunes},
		{"\xff\xfe" + strings.Repeat("a", 250), MaxTextRunes},
	} {
		l := r.Add(Line{Room: Boat(1), From: account(1), Name: strings.Repeat("ñ", 50), Text: tc.text})
		if n := utf8.RuneCountInString(l.Text); n != tc.runes || len(l.Text) > MaxTextBytes || !strings.HasPrefix(tc.text, l.Text) {
			t.Fatalf("%q cut to %d characters, %d bytes", tc.text[:8], n, len(l.Text))
		}
		if len(l.Name) != MaxNameBytes || !utf8.ValidString(l.Name) {
			t.Fatalf("a name cut to %q", l.Name)
		}
	}
	short := r.Add(Line{Room: Boat(1), From: account(1), Name: "Bo", Text: "hi"})
	if short.Text != "hi" || short.Name != "Bo" {
		t.Fatalf("a short line cut: %+v", short)
	}
	check(t, r)
}

func TestExpires(t *testing.T) {
	c := newClock()
	r := NewRings(DefaultLimits(), c.now)
	first := say(r, Boat(1), 1, "first")
	c.add(10 * time.Minute)
	second := say(r, Boat(2), 2, "second")
	c.add(20*time.Minute - time.Nanosecond)
	if _, ok := r.Line(first.ID); !ok {
		t.Fatal("a line gone before half an hour")
	}
	if ls := r.Lines(Boat(1), time.Time{}); len(ls) != 1 {
		t.Fatalf("Lines before half an hour: %+v", ls)
	}
	c.add(time.Nanosecond)
	if _, ok := r.Line(first.ID); ok {
		t.Fatal("a line kept half an hour")
	}
	if ls := r.Lines(Boat(1), time.Time{}); ls != nil {
		t.Fatalf("Lines after half an hour: %+v", ls)
	}
	if r.Remove(first.ID) {
		t.Fatal("an expired line removed")
	}
	if _, ok := r.Line(second.ID); !ok {
		t.Fatal("the second line gone with the first")
	}
	c.add(10 * time.Minute)
	r.Tidy()
	s := r.Stats()
	if s.Lines != 0 || s.Bytes != 0 || s.Dropped[DropExpired] != 2 {
		t.Fatalf("Stats: %+v", s)
	}
	if len(r.rooms) != 0 || len(r.senders) != 0 || len(r.byID) != 0 {
		t.Fatalf("remembered %d rooms, %d senders, %d lines", len(r.rooms), len(r.senders), len(r.byID))
	}

	// Add expires too.
	say(r, Boat(1), 1, "again")
	c.add(30 * time.Minute)
	say(r, Boat(2), 2, "and again")
	if s := r.Stats(); s.Lines != 1 || s.Dropped[DropExpired] != 3 {
		t.Fatalf("Stats after Add: %+v", s)
	}
	check(t, r)
}

func TestTidyGivesMapsBack(t *testing.T) {
	c := newClock()
	r := NewRings(DefaultLimits(), c.now)
	for i := range 5000 {
		say(r, Boat(uint64(i)), i, "hello")
	}
	c.add(31 * time.Minute)
	say(r, Boat(1), 1, "still here")
	r.Tidy()
	if r.most.lines != 1 || r.most.rooms != 1 || r.most.senders != 1 {
		t.Fatalf("the maps not made anew: %+v", r.most)
	}
	if ls := r.Lines(Boat(1), time.Time{}); len(ls) != 1 || ls[0].Text != "still here" {
		t.Fatalf("Lines: %+v", ls)
	}
	say(r, Boat(2), 2, "and more")
	check(t, r)
}

func TestRoomKeepsItsNewest(t *testing.T) {
	c := newClock()
	r := NewRings(DefaultLimits(), c.now)
	other := say(r, Boat(2), 9, "elsewhere")
	var lines []Line
	for i := range 201 {
		lines = append(lines, say(r, Boat(1), i%3, fmt.Sprint("line ", i)))
		c.add(time.Second)
	}
	if _, ok := r.Line(lines[0].ID); ok {
		t.Fatal("the room's 201st line kept its oldest")
	}
	ls := r.Lines(Boat(1), time.Time{})
	if len(ls) != 200 || ls[0] != lines[1] || ls[199] != lines[200] {
		t.Fatalf("%d lines, from %q to %q", len(ls), ls[0].Text, ls[len(ls)-1].Text)
	}
	if _, ok := r.Line(other.ID); !ok {
		t.Fatal("another room's line dropped")
	}
	if s := r.Stats(); s.Dropped[DropRoom] != 1 || s.Dropped[DropSender] != 0 || s.Dropped[DropBuffer] != 0 {
		t.Fatalf("Stats: %+v", s)
	}
	check(t, r)
}

func TestSenderLosesTheirOwnOldest(t *testing.T) {
	c := newClock()
	r := NewRings(DefaultLimits(), c.now)
	// By lines: one sender across five rooms, among others.
	var theirs, others []Line
	for i := range 210 {
		theirs = append(theirs, say(r, Boat(uint64(i%5)), 1, fmt.Sprint("mine ", i)))
		others = append(others, say(r, Boat(uint64(i%5)), 2+i%4, fmt.Sprint("ours ", i)))
		c.add(time.Second)
	}
	for i, l := range theirs {
		if _, ok := r.Line(l.ID); ok != (i >= 10) {
			t.Fatalf("their line %d kept: %v", i, ok)
		}
	}
	for i, l := range others {
		if _, ok := r.Line(l.ID); !ok {
			t.Fatalf("another's line %d dropped", i)
		}
	}
	if s := r.Stats(); s.Dropped[DropSender] != 10 || s.Dropped[DropRoom] != 0 {
		t.Fatalf("Stats: %+v", s)
	}
	check(t, r)

	// By bytes: the longest lines, across rooms.
	long := strings.Repeat("🌊", MaxTextRunes)
	cost := Cost(long, "sailor 7")
	fit := DefaultLimits().SenderBytes / cost
	theirs = theirs[:0]
	for i := range fit + 5 {
		theirs = append(theirs, say(r, Boat(uint64(10+i%7)), 7, long))
		say(r, Boat(uint64(10+i%7)), 8, long)
		c.add(time.Second)
	}
	for i, l := range theirs {
		if _, ok := r.Line(l.ID); ok != (i >= 5) {
			t.Fatalf("their long line %d of %d kept: %v", i, fit+5, ok)
		}
	}
	r.mu.Lock()
	held := r.senders[account(7)].bytes
	r.mu.Unlock()
	if held > DefaultLimits().SenderBytes || held != fit*cost {
		t.Fatalf("the sender holds %d bytes, %d lines' worth", held, held/cost)
	}
	for _, l := range others {
		if _, ok := r.Line(l.ID); !ok {
			t.Fatal("another's line dropped")
		}
	}
	if s := r.Stats(); s.Dropped[DropSender] != 10+5+5 {
		t.Fatalf("Stats: %+v", s)
	}
	check(t, r)
}

// heldRun reports whether the lines held are exactly those of IDs from
// the oldest held to the newest: so every line dropped was older than
// every line kept.
func heldRun(r *Rings) (oldest, newest uint64, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.all.head == nil {
		return 0, 0, true
	}
	oldest, newest = r.all.head.id, r.all.tail.id
	return oldest, newest, int(newest-oldest+1) == r.all.n
}

func TestBufferDropsTheOldest(t *testing.T) {
	c := newClock()
	cost := Cost("line     0", "sailor 0")
	limit := 50*cost + 13*RoomOverhead + 10*SenderOverhead + cost/2
	r := NewRings(Limits{Bytes: limit}, c.now)
	for i := range 1000 {
		say(r, Boat(uint64(i%13)), i%10, fmt.Sprintf("line %5d", i))
		if s := r.Stats(); s.Bytes > limit || s.Lines > 50 {
			t.Fatalf("after line %d: %+v", i, s)
		}
		if _, _, ok := heldRun(r); !ok {
			t.Fatalf("after line %d, a newer line dropped before an older", i)
		}
		c.add(time.Second)
	}
	if s := r.Stats(); s.Lines != 50 || s.Dropped[DropBuffer] != 950 {
		t.Fatalf("Stats: %+v", s)
	}
	check(t, r)
}

// TestFlood fills the rings at the default limits, at the fastest anyone
// may say a line, with the longest lines, from many senders in many
// rooms: they never pass Bytes, and the oldest go first.
func TestFlood(t *testing.T) {
	c := newClock()
	l := DefaultLimits()
	r := NewRings(l, c.now)
	senders, rooms, rounds := 2000, 400, 300 // ten minutes of a line every 2 s
	if testing.Short() {
		rounds = 60
	}
	text := strings.Repeat("🌊", MaxTextRunes)
	names := make([]string, senders)
	for i := range names {
		names[i] = fmt.Sprintf("%-80d", i)
	}
	cost := Cost(text, names[0])
	fit := (l.Bytes - rooms*RoomOverhead - senders*SenderOverhead) / cost
	full := false
	for round := range rounds {
		for i := range senders {
			r.Add(Line{Room: Boat(uint64((i + round) % rooms)), From: account(i), Name: names[i], Text: text})
			s := r.Stats()
			if s.Bytes > l.Bytes {
				t.Fatalf("round %d: %d bytes, past %d", round, s.Bytes, l.Bytes)
			}
			if s.Bytes > l.Bytes-cost {
				full = true
			}
		}
		if _, _, ok := heldRun(r); !ok {
			t.Fatalf("round %d: a newer line dropped before an older", round)
		}
		c.add(Every)
	}
	s := r.Stats()
	if !full || s.Lines != fit {
		t.Fatalf("%d lines held, %d fit", s.Lines, fit)
	}
	if s.Dropped[DropRoom] != 0 || s.Dropped[DropSender] != 0 || s.Dropped[DropExpired] != 0 {
		t.Fatalf("Stats: %+v", s)
	}
	t.Logf("%d lines held, %d bytes; dropped %d", s.Lines, s.Bytes, s.Dropped[DropBuffer])
	check(t, r)
}

func TestRemove(t *testing.T) {
	c := newClock()
	r := NewRings(DefaultLimits(), c.now)
	a := say(r, Boat(1), 1, "keep")
	b := say(r, Boat(1), 2, "remove me")
	d := say(r, Boat(1), 1, "keep too")
	if !r.Remove(b.ID) {
		t.Fatal("not removed")
	}
	if r.Remove(b.ID) {
		t.Fatal("removed twice")
	}
	if _, ok := r.Line(b.ID); ok {
		t.Fatal("a removed line found")
	}
	if ls := r.Lines(Boat(1), time.Time{}); len(ls) != 2 || ls[0] != a || ls[1] != d {
		t.Fatalf("Lines: %+v", ls)
	}
	if s := r.Stats(); s.Lines != 2 || s.Dropped[DropRemoved] != 1 {
		t.Fatalf("Stats: %+v", s)
	}
	if len(r.senders) != 1 {
		t.Fatalf("%d senders remembered", len(r.senders))
	}
	r.Remove(a.ID)
	r.Remove(d.ID)
	if len(r.rooms) != 0 || len(r.senders) != 0 {
		t.Fatalf("remembered %d rooms, %d senders", len(r.rooms), len(r.senders))
	}
	if r.Remove(12345) {
		t.Fatal("an unknown line removed")
	}
	check(t, r)
}

func TestFollow(t *testing.T) {
	c := newClock()
	r := NewRings(DefaultLimits(), c.now)
	before := say(r, Boat(1), 1, "before")
	var got []Line
	stop := r.Follow(Boat(1), c.now().Add(10*time.Minute), func(l Line) {
		got = append(got, l)
		// The lock is not held: the rings may be asked.
		if ls := r.Lines(l.Room, l.At); len(ls) == 0 {
			t.Error("a followed line not in the room")
		}
	})
	a := say(r, Boat(1), 2, "one")
	say(r, Boat(2), 2, "elsewhere")
	say(r, Pair(account(1), account(2)), 2, "a pair's")
	c.add(10*time.Minute - time.Nanosecond)
	b := say(r, Boat(1), 1, "two")
	c.add(time.Nanosecond)
	say(r, Boat(1), 1, "too late")
	if len(got) != 2 || got[0] != a || got[1] != b || got[0].ID == before.ID {
		t.Fatalf("followed %+v", got)
	}
	if len(r.follows) != 0 {
		t.Fatalf("%d rooms' follows remembered", len(r.follows))
	}
	stop() // after its end, harmless

	got = got[:0]
	stop = r.Follow(Boat(1), c.now().Add(time.Hour), func(l Line) { got = append(got, l) })
	other := r.Follow(Boat(1), c.now().Add(time.Hour), func(Line) {})
	say(r, Boat(1), 1, "three")
	stop()
	stop()
	say(r, Boat(1), 1, "four")
	if len(got) != 1 || got[0].Text != "three" {
		t.Fatalf("followed %+v", got)
	}
	other()
	if len(r.follows) != 0 {
		t.Fatalf("%d rooms' follows remembered", len(r.follows))
	}

	// One that ends unheard is forgotten by Tidy.
	r.Follow(Boat(5), c.now().Add(time.Minute), func(Line) { t.Error("called") })
	r.Follow(Boat(6), c.now().Add(-time.Minute), func(Line) { t.Error("called") })
	if len(r.follows) != 1 {
		t.Fatalf("%d rooms' follows remembered", len(r.follows))
	}
	c.add(time.Minute)
	r.Tidy()
	if len(r.follows) != 0 {
		t.Fatalf("%d rooms' follows remembered after Tidy", len(r.follows))
	}
	say(r, Boat(5), 1, "nobody hears")

	// fn may Add, Remove and follow again.
	n := 0
	var stopSelf func()
	stopSelf = r.Follow(Boat(7), c.now().Add(time.Hour), func(l Line) {
		n++
		r.Remove(l.ID)
		stopSelf()
		say(r, Boat(7), 1, "said from fn")
	})
	say(r, Boat(7), 1, "start")
	if n != 1 {
		t.Fatalf("fn called %d times", n)
	}
	if ls := r.Lines(Boat(7), time.Time{}); len(ls) != 1 || ls[0].Text != "said from fn" {
		t.Fatalf("Lines: %+v", ls)
	}
	check(t, r)
}

func TestConcurrent(t *testing.T) {
	c := newClock()
	r := NewRings(Limits{RoomLines: 20, SenderLines: 30, Bytes: 200 * (LineOverhead + 40)}, c.now)
	var followed atomic.Int64
	stop := r.Follow(Boat(0), c.now().Add(time.Hour), func(l Line) {
		followed.Add(1)
		r.Lines(l.Room, time.Time{})
		r.Stats()
	})
	defer stop()
	var wg sync.WaitGroup
	var said [8]atomic.Int64
	for g := range 8 {
		wg.Go(func() {
			for i := range 2000 {
				l := say(r, Boat(uint64(i%5)), g*10+i%7, fmt.Sprint(g, " ", i))
				if l.Room == Boat(0) {
					said[g].Add(1)
				}
				switch i % 10 {
				case 1:
					r.Lines(Boat(uint64(i%5)), time.Time{})
				case 2:
					r.Remove(l.ID - 3)
				case 3:
					r.Line(l.ID - 1)
				case 4:
					r.Tidy()
				case 5:
					c.add(time.Second)
				}
			}
		})
	}
	wg.Wait()
	var total int64
	for i := range said {
		total += said[i].Load()
	}
	if followed.Load() != total {
		t.Fatalf("followed %d of %d lines", followed.Load(), total)
	}
	check(t, r)
}

func TestLimitsDefault(t *testing.T) {
	r := NewRings(Limits{RoomLines: 3}, newClock().now)
	d := DefaultLimits()
	d.RoomLines = 3
	if r.limits != d {
		t.Fatalf("limits %+v", r.limits)
	}
}

// A line of the typical length, 120 bytes.
var typical = strings.Repeat("Ready about! ", 10)[:120]

func BenchmarkAdd(b *testing.B) {
	c := newClock()
	r := NewRings(DefaultLimits(), c.now)
	const rooms, senders = 1000, 5000
	names := make([]string, senders)
	for i := range names {
		names[i] = fmt.Sprint("sailor ", i)
	}
	b.ReportAllocs()
	i := 0
	for b.Loop() {
		r.Add(Line{Room: Boat(uint64(i % rooms)), From: account(i % senders), Name: names[i%senders], Text: typical})
		i++
		if i%100 == 0 {
			c.add(time.Second)
		}
	}
}
