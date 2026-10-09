// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// encoder runs on one goroutine, woken by the simulation as it publishes
// each frame. For each frame it first stores in their boats' slots the
// connections' words held for the next tick, then, on even ticks, writes
// every connection's snapshot into the connection's mailbox: 15 a second.
// It holds the frame only while it works, and for connections already
// sailing it allocates nothing.
type encoder struct {
	e      *Edge
	wakeCh chan struct{}

	mu       sync.Mutex
	pending  []*conn // joined, not yet welcomed
	npending atomic.Int32

	active []*conn // the encoder's own
	last   int64   // the tick last encoded
}

func (enc *encoder) init(e *Edge) {
	enc.e = e
	enc.wakeCh = make(chan struct{}, 1)
	enc.last = math.MinInt64
}

// wake asks for the latest frame to be encoded, without waiting.
func (enc *encoder) wake() {
	select {
	case enc.wakeCh <- struct{}{}:
	default:
	}
}

// add hands over a connection whose Join has been answered: it is welcomed
// with the first frame that holds its boat.
func (enc *encoder) add(c *conn) {
	enc.mu.Lock()
	enc.pending = append(enc.pending, c)
	enc.npending.Add(1)
	enc.mu.Unlock()
}

func (enc *encoder) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-enc.wakeCh:
		}
		enc.frame()
	}
}

// frame encodes the latest frame, if it has not been.
func (enc *encoder) frame() {
	f := enc.e.cfg.Bus.Frames.Acquire()
	defer f.Release()
	if f.Tick == enc.last {
		return
	}
	enc.last = f.Tick
	if enc.npending.Load() > 0 {
		enc.adopt(f)
	}
	// The words for the next tick first: it runs in a thirtieth of a
	// second.
	next := f.Tick + 1
	for i := 0; i < len(enc.active); {
		c := enc.active[i]
		if c.gone.Load() {
			last := len(enc.active) - 1
			enc.active[i], enc.active[last] = enc.active[last], nil
			enc.active = enc.active[:last]
			continue
		}
		if c.waiting.Load() > 0 {
			c.release(next)
		}
		i++
	}
	if f.Tick%2 != 0 {
		return
	}
	start := time.Now()
	for _, c := range enc.active {
		c.encode(f)
	}
	enc.e.m.encode.Observe(time.Since(start).Seconds())
}

// adopt welcomes the connections whose boat f holds.
func (enc *encoder) adopt(f *bus.Frame) {
	enc.mu.Lock()
	defer enc.mu.Unlock()
	keep := enc.pending[:0]
	for _, c := range enc.pending {
		switch {
		case c.gone.Load():
		case c.joinTick > f.Tick:
			keep = append(keep, c)
		case c.welcome(f):
			enc.active = append(enc.active, c)
		}
	}
	clear(enc.pending[len(keep):])
	enc.pending = keep
	enc.npending.Store(int32(len(keep)))
}

// welcome queues the Welcome, from the first frame that holds the boat.
func (c *conn) welcome(f *bus.Frame) bool {
	e := c.e
	s := c.slot
	if !f.Occupied[s] || f.Boat[s] != c.boat {
		c.close(websocket.StatusInternalError, "the boat has gone")
		return false
	}
	wt, _ := e.cfg.Clock.WorldTime()
	ok := c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Welcome{Welcome: &pb.Welcome{
		World: e.cfg.World, Tick: f.Tick, WorldTimeUs: wt.Microseconds(),
		Boat: c.boat, Kind: uint32(f.Kind[s]), Rejoined: c.rejoined,
	}}}, outWelcome)
	c.ready.Store(ok)
	return ok
}

// encode writes the boat's snapshot of f into the mailbox.
func (c *conn) encode(f *bus.Frame) {
	s := c.slot
	if !f.Occupied[s] || f.Boat[s] != c.boat {
		c.gone.Store(true)
		c.close(websocket.StatusInternalError, "the boat has gone")
		return
	}
	protocol.PutSnapshot(c.box.fill(), f.Tick, f.Control[s], c.margin.take(), f.Wind, &f.State[s])
	if c.box.post() {
		c.e.m.replaced.Inc()
	}
}
