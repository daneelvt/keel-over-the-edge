// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// registry is each account's connection: one at a time. The control slot
// of a boat has one writer, so a connection that takes an account's boat
// over first stops the one before from writing it.
type registry struct {
	mu sync.Mutex
	by map[bus.Account]*conn
}

func (r *registry) init() { r.by = map[bus.Account]*conn{} }

// claim makes c its account's connection, and returns the one it replaces,
// if any.
func (r *registry) claim(c *conn) (old *conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	old = r.by[c.account]
	r.by[c.account] = c
	return old
}

// release forgets c, if it is still its account's connection.
func (r *registry) release(c *conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.by[c.account] == c {
		delete(r.by, c.account)
	}
}

// count is the number of accounts connected.
func (r *registry) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.by)
}
