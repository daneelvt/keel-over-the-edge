// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"
)

// heapOf is the live heap that fill leaves behind it, in bytes.
func heapOf(fill func() *Rings) (int64, *Rings) {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	r := fill()
	runtime.GC()
	runtime.ReadMemStats(&after)
	runtime.KeepAlive(r)
	return int64(after.HeapAlloc) - int64(before.HeapAlloc), r
}

// shape is a run of lines alike, from senders in rooms; none for either
// is one for each line.
type shape struct {
	what           string
	text           string
	nameLen        int
	senders, rooms int
	// fair: the count is held to at most a quarter over the heap.
	fair bool
}

var longest = strings.Repeat("🌊", MaxTextRunes)

// TestOverheads holds the counts to being a fair upper bound of the heap
// the rings hold: never under it, whatever the lines and however full the
// maps, and at most a quarter over for the typical line and the longest.
func TestOverheads(t *testing.T) {
	if raceEnabled {
		t.Skip("the race detector changes the heap")
	}
	for _, s := range []shape{
		{"typical", typical, 12, 1000, 200, true},
		{"longest", longest, MaxNameBytes, 1000, 200, true},
		{"longest, short names", longest, 4, 1000, 200, true},
		{"769 bytes", strings.Repeat("🌊", 190) + "123456789", 1, 1000, 200, false},
		{"one character", "k", 4, 1000, 200, false},
		{"empty", "", 0, 1000, 200, false},
		{"a room and a sender each", typical, 12, 0, 0, false},
		{"the longest, a room and a sender each", longest, MaxNameBytes, 0, 0, false},
		{"a sender each", typical, 12, 0, 200, false},
	} {
		for _, n := range []int{10_000, 14_000, 20_000, 28_000, 40_000, 56_000} {
			senders, rooms := s.senders, s.rooms
			if senders == 0 {
				senders = n
			}
			if rooms == 0 {
				rooms = n
			}
			names := make([]string, senders)
			for i := range names {
				names[i] = fmt.Sprintf("%0*d", s.nameLen, i)[:s.nameLen]
			}
			c := newClock()
			heap, r := heapOf(func() *Rings {
				r := NewRings(Limits{RoomLines: n, SenderLines: n, SenderBytes: 1 << 30, Bytes: 1 << 30}, c.now)
				for i := range n {
					r.Add(Line{Room: Boat(uint64(i % rooms)), From: account(i % senders), Name: names[i%senders], Text: s.text})
				}
				return r
			})
			count := r.Stats().Bytes
			ratio := float64(count) / float64(heap)
			t.Logf("%s, %d lines: %.0f bytes a line on the heap, counted %.0f: %.2f", s.what, n, float64(heap)/float64(n), float64(count)/float64(n), ratio)
			if ratio < 1 || s.fair && ratio > 1.25 {
				t.Errorf("%s, %d lines: counted %d bytes, %.2f of the heap's %d", s.what, n, count, ratio, heap)
			}
		}
	}
}

// TestHeap measures the rings full: at the load expected, a thousand
// people aboard two hundred boats each saying two lines a minute for half
// an hour; and at the worst, the buffer full. Run with -v for the numbers.
func TestHeap(t *testing.T) {
	if raceEnabled {
		t.Skip("the race detector changes the heap")
	}
	names := make([]string, 50_000)
	for i := range names {
		names[i] = fmt.Sprintf("sailor %d", i)
	}
	report := func(what string, heap int64, r *Rings) {
		s := r.Stats()
		t.Logf("%s: %d lines, counted %.1f MiB, heap %.1f MiB (%.0f bytes a line)",
			what, s.Lines, float64(s.Bytes)/(1<<20), float64(heap)/(1<<20), float64(heap)/float64(s.Lines))
		if int64(s.Bytes) < heap {
			t.Errorf("%s: counted %d bytes, under the heap's %d", what, s.Bytes, heap)
		}
	}

	c := newClock()
	heap, r := heapOf(func() *Rings {
		r := NewRings(DefaultLimits(), c.now)
		for range 60 {
			for p := range 1000 {
				r.Add(Line{Room: Boat(uint64(p % 200)), From: account(p), Name: names[p], Text: typical})
			}
			c.add(30 * time.Second)
		}
		return r
	})
	report("expected: 1,000 aboard 200 boats, two 120-byte lines a minute each, half an hour", heap, r)

	// Full: everyone saying a line every Every, until the buffer drops.
	full := func(text string, people, boats int) {
		c := newClock()
		heap, r := heapOf(func() *Rings {
			r := NewRings(DefaultLimits(), c.now)
			for i := 0; i < 10_000_000 && r.Stats().Dropped[DropBuffer] == 0; i++ {
				p := i % people
				if p == 0 {
					c.add(Every)
				}
				r.Add(Line{Room: Boat(uint64(p % boats)), From: account(p), Name: names[p], Text: text})
			}
			return r
		})
		if s := r.Stats(); s.Dropped[DropBuffer] == 0 || s.Dropped[DropExpired] != 0 {
			t.Fatalf("the buffer not filled: %+v", s)
		}
		report(fmt.Sprintf("full: %d-byte lines from %d people aboard %d boats", len(text), people, boats), heap, r)
	}
	full(typical, 5_000, 2_000)
	full(longest, 5_000, 1_000)
	full(typical, 50_000, 10_000)
	full(longest, 50_000, 10_000)
}
