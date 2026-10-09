// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
)

// connView is the view a snapshot leaves its client with, as the wire
// carries it, and, for each of its view slots, which boat of the world it
// is: the frame's slot and the boat's ID, which the wire does not carry.
type connView struct {
	tick  int64
	view  protocol.View
	slot  [protocol.ViewSlots]int32
	boat  [protocol.ViewSlots]uint64
	valid bool // a snapshot was encoded into the buffer
}

// mailbox holds a connection's newest snapshot: three buffers, one being
// sent, one waiting, one being filled, swapped and never copied, each with
// the view its snapshot leaves the client with. A snapshot posted before
// the waiting one was taken replaces it.
//
// The game connection is TCP, and one writer writes a connection's
// messages in turn, so a snapshot the writer has taken reaches the client
// before any taken after it, or the connection ends (RFC 9293). The
// snapshot being filled is therefore written against the newest one taken:
// the client will hold it, as one of the last few it decoded, whenever the
// new one arrives. The one waiting may yet be replaced and never sent, so
// it is never a base. (Over a transport that may lose a snapshot, the base
// would have to be one the client has acknowledged: Quake 3's and
// Fiedler's method, a round trip staler.)
type mailbox struct {
	mu                        sync.Mutex
	bufs                      [3][protocol.MaxSnapshotSize]byte
	lens                      [3]int
	views                     [3]connView
	sending, waiting, filling int
	full                      bool
	// taken: a snapshot has been taken since the connection began or
	// asked to start again: the one sending is a base.
	taken  bool
	signal chan struct{}
}

func (m *mailbox) init() {
	m.sending, m.waiting, m.filling = 0, 1, 2
	m.signal = make(chan struct{}, 1)
}

// base is the view of the newest snapshot taken, or nil before the first.
// Only the encoder calls it: the buffer it names is not written until the
// encoder's own next post, so the view stays whole while the encoder reads
// it.
func (m *mailbox) base() *connView {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.taken {
		return nil
	}
	return &m.views[m.sending]
}

// fill is the buffer for the encoder to fill, and its view.
func (m *mailbox) fill() ([]byte, *connView) {
	return m.bufs[m.filling][:0], &m.views[m.filling]
}

// post makes the filled buffer, of n bytes, the waiting one, and wakes
// the writer. It reports whether a snapshot not yet sent was replaced.
func (m *mailbox) post(n int) (replaced bool) {
	m.mu.Lock()
	replaced = m.full
	m.lens[m.filling] = n
	m.waiting, m.filling = m.filling, m.waiting
	m.full = true
	m.mu.Unlock()
	select {
	case m.signal <- struct{}{}:
	default:
	}
	return replaced
}

// take returns the waiting snapshot for the writer to send and its tick,
// or nil.
func (m *mailbox) take() ([]byte, int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.full {
		return nil, 0
	}
	m.sending, m.waiting = m.waiting, m.sending
	m.full = false
	m.taken = true
	return m.bufs[m.sending][:m.lens[m.sending]], m.views[m.sending].tick
}

// restart forgets every base, so the next snapshot is written in full: the
// client asked for it.
func (m *mailbox) restart() {
	m.mu.Lock()
	m.taken = false
	m.mu.Unlock()
}
