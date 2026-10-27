// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/watch"
)

// The spectator limit. How many may watch at once is a total of its own,
// apart from the boat limit: a spectator holds no boat, so the limit and
// its queue are the edge's, in memory, never the world's state, and a
// restart loses the queue (phones come back in their reconnect order).
// A place is held from the moment a watch is let through until it ends or
// its connection closes; an idle connection holds none, and one that
// switches from one boat to another keeps its own. Past the limit a
// connection waits, first come first served, told its place once a second
// when it changes; past the queue's bound it is closed with 1013. Never
// waiting, and never refused for the limit: a priority account, an owner
// watching their own machine sailor, and a player waiting for a boat. They
// count in the total all the same.

// DefaultSpectatorLimit is how many may watch at once, to start: a
// spectator costs the edge what a sailor does.
const DefaultSpectatorLimit = 1000

// SpectatorQueueLimit is the most that may wait to watch.
const SpectatorQueueLimit = 4096

// spectators is the limit, its queue, and how many watch each sailor.
type spectators struct {
	mu    sync.Mutex
	limit int
	held  int     // places held
	queue []*conn // waiting for a place, the head first
	// watchers is how many watch each sailor's boat now.
	watchers map[bus.Account]int32
}

func (s *spectators) init(limit int) {
	if limit <= 0 {
		limit = DefaultSpectatorLimit
	}
	s.limit = limit
	s.watchers = map[bus.Account]int32{}
}

// take asks a place for c to watch t: given at once if c holds one
// already, if there is room, or if it is exempt; otherwise c waits, at
// position, or, the queue full, is refused.
func (s *spectators) take(c *conn, t watch.Target, exempt bool) (granted bool, position int, full bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case c.seated:
		return true, 0, false
	case c.wants != nil && !exempt:
		// Waiting already: still waiting, for another boat.
		c.wants = &t
		return false, slices.Index(s.queue, c) + 1, false
	case c.wants != nil:
		c.wants = nil
		if i := slices.Index(s.queue, c); i >= 0 {
			s.queue = slices.Delete(s.queue, i, i+1)
		}
		c.seated = true
		s.held++
		return true, 0, false
	case exempt || s.held < s.limit && len(s.queue) == 0:
		c.seated = true
		s.held++
		return true, 0, false
	case len(s.queue) >= SpectatorQueueLimit:
		return false, 0, true
	}
	c.wants = &t
	s.queue = append(s.queue, c)
	return false, len(s.queue), false
}

// release frees c's place, or takes it out of the queue, and lets in
// whom the room now made lets in.
func (s *spectators) release(c *conn) {
	s.mu.Lock()
	if c.seated {
		c.seated = false
		s.held--
	} else if c.wants != nil {
		c.wants = nil
		if i := slices.Index(s.queue, c); i >= 0 {
			s.queue = slices.Delete(s.queue, i, i+1)
		}
	}
	in := s.admitLocked()
	s.mu.Unlock()
	for _, a := range in {
		a.c.ask(ask{kind: askWatch, target: a.t})
	}
}

// admitted is a connection let in from the queue, and whom it watches.
type admitted struct {
	c *conn
	t watch.Target
}

// admitLocked takes connections off the queue's head while there is room.
func (s *spectators) admitLocked() []admitted {
	var in []admitted
	for len(s.queue) > 0 && s.held < s.limit {
		c := s.queue[0]
		s.queue = s.queue[1:]
		in = append(in, admitted{c, *c.wants})
		c.wants = nil
		c.seated = true
		s.held++
	}
	return in
}

// setLimit changes the limit, letting in whom more room lets in.
func (s *spectators) setLimit(limit int) {
	s.mu.Lock()
	s.limit = max(limit, 0)
	in := s.admitLocked()
	s.mu.Unlock()
	for _, a := range in {
		a.c.ask(ask{kind: askWatch, target: a.t})
	}
}

// watching counts a watch of a sailor's boat begun, or with −1 ended.
func (s *spectators) watching(a bus.Account, d int32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n := s.watchers[a] + d; n > 0 {
		s.watchers[a] = n
	} else {
		delete(s.watchers, a)
	}
}

// count is how many watch a sailor's boat.
func (s *spectators) count(a bus.Account) int32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.watchers[a]
}

// Spectators is the spectators now: how many watch, how many wait to, and
// the limit.
type Spectators struct {
	Watching int `json:"watching"`
	Waiting  int `json:"waiting"`
	Limit    int `json:"limit"`
}

// Spectators is how many watch and wait to, and the limit.
func (e *Edge) Spectators() Spectators {
	s := &e.spect
	s.mu.Lock()
	defer s.mu.Unlock()
	return Spectators{Watching: s.held, Waiting: len(s.queue), Limit: s.limit}
}

// SetSpectatorLimit changes how many may watch at once.
func (e *Edge) SetSpectatorLimit(n int) {
	e.spect.setLimit(n)
	e.m.spectatorLimit.Set(float64(max(n, 0)))
}

// Watchers is how many watch an account's boat now.
func (e *Edge) Watchers(a bus.Account) int { return int(e.spect.count(a)) }

// Watched is how many watch each boat watched now, by its sailor.
func (e *Edge) Watched() map[bus.Account]int {
	s := &e.spect
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[bus.Account]int, len(s.watchers))
	for a, n := range s.watchers {
		out[a] = int(n)
	}
	return out
}

// tellSpectators runs until ctx ends: once a second it tells each
// connection waiting to watch its place, if it has changed, and counts
// the spectators and how many watch each boat.
func (e *Edge) tellSpectators(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		s := &e.spect
		s.mu.Lock()
		waiting := int32(len(s.queue))
		for i, c := range s.queue {
			if p := int32(i + 1); p != c.toldSpect || waiting != c.toldSpectOf {
				c.toldSpect, c.toldSpectOf = p, waiting
				c.send(spectatorPlace(p, waiting), outQueued)
			}
		}
		e.m.spectators[spectWatching].Set(float64(s.held))
		e.m.spectators[spectWaiting].Set(float64(waiting))
		for _, n := range s.watchers {
			e.m.watchers.Observe(float64(n))
		}
		s.mu.Unlock()
	}
}

// spectatorPlace is a place in the spectators' queue.
func spectatorPlace(position, waiting int32) *pb.ServerMessage {
	return &pb.ServerMessage{Body: &pb.ServerMessage_Queued{Queued: &pb.Queued{
		Position: uint32(position), Waiting: uint32(waiting), Spectators: true,
	}}}
}

// closeQueueFull closes a connection the spectators' queue has no room
// for.
func (c *conn) closeQueueFull() {
	c.e.m.watch[watchFull].Inc()
	c.close(websocket.StatusTryAgainLater, "the spectators' queue is full")
}
