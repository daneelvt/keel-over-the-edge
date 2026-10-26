// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/watch"
)

// TestSpectatorQueue: past the limit connections wait, first come first
// served; past the queue's bound one is refused; one exempt is let in at
// once, past the limit, and so is one that holds a place already; a place
// freed lets the head in.
func TestSpectatorQueue(t *testing.T) {
	var s spectators
	s.init(2)
	conns := make([]*conn, 2+SpectatorQueueLimit+1)
	for i := range conns {
		conns[i] = &conn{enc: &encoder{}}
	}
	for i, c := range conns[:2+SpectatorQueueLimit] {
		granted, position, full := s.take(c, watch.Target{}, false)
		switch {
		case full:
			t.Fatalf("connection %d refused", i)
		case i < 2 && !granted, i >= 2 && (granted || position != i-1):
			t.Fatalf("connection %d: granted %v at %d", i, granted, position)
		}
	}
	if _, _, full := s.take(conns[len(conns)-1], watch.Target{}, false); !full {
		t.Fatal("past the queue's bound, not refused")
	}
	if granted, _, _ := s.take(&conn{}, watch.Target{}, true); !granted || s.held != 3 {
		t.Fatalf("an exempt connection: %v, %d held", granted, s.held)
	}
	if granted, _, _ := s.take(conns[0], watch.Target{}, false); !granted {
		t.Fatal("a connection with a place, switching, made to wait")
	}
	// A place freed: the head is let in, and the next is the head.
	s.release(conns[0])
	s.release(conns[1])
	if !conns[2].seated || conns[3].seated || s.queue[0] != conns[3] {
		t.Fatalf("after two freed, with three held: the head %v, the next %v", conns[2].seated, conns[3].seated)
	}
}
