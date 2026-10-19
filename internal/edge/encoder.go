// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"math"
	"math/bits"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// An encoder runs on a goroutine of its own, one of several, each with its
// own connections, and each woken by the simulation as it publishes each
// frame. For each frame it first stores in their boats' slots its
// connections' words held for the next tick, then welcomes the connections
// the queue has given boats, then, on even ticks, writes each of its
// connections' snapshots into the connection's mailbox: 15 a second. It
// holds the frame only while it works, and for connections already
// sailing it allocates nothing.
type encoder struct {
	e      *Edge
	wakeCh chan struct{}
	load   atomic.Int32 // connections handed to it and not yet let go

	mu       sync.Mutex
	pending  []*conn // joined or queued, not yet taken on
	npending atomic.Int32

	active []*conn           // sailing
	queued map[uint64]*conn  // waiting for a boat, by connection ID
	last   int64             // the tick last encoded
	swept  int64             // the tick the queue was last read for positions
	aoi    aoi               // scratch for finding views
	empty  connView          // the base of a full snapshot
	counts [entryOps]float64 // entries written this round, by op
}

func (enc *encoder) init(e *Edge, capacity int) {
	enc.e = e
	enc.wakeCh = make(chan struct{}, 1)
	enc.last = math.MinInt64
	enc.swept = math.MinInt64
	enc.queued = map[uint64]*conn{}
	enc.aoi.init(capacity)
}

// wake asks for the latest frame to be encoded, without waiting.
func (enc *encoder) wake() {
	select {
	case enc.wakeCh <- struct{}{}:
	default:
	}
}

// add hands over a connection whose Join has been answered: it is welcomed
// with the first frame that holds its boat, or, if it waits for one, told
// its place.
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
	start := time.Now()
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
			enc.load.Add(-1)
			continue
		}
		if c.waiting.Load() > 0 {
			c.release(next)
		}
		// What has been charted since: a closed connection goes next frame.
		_ = c.chart(enc.e.cfg.Chart)
		i++
	}
	if len(enc.queued) > 0 {
		enc.admit(f)
	}
	if f.Tick%2 != 0 {
		return
	}
	for _, c := range enc.active {
		enc.encode(c, f)
	}
	m := &enc.e.m
	for op, n := range enc.counts {
		if n > 0 {
			m.entries[op].Add(n)
			enc.counts[op] = 0
		}
	}
	m.encode.Observe(time.Since(start).Seconds())
}

// adopt takes on the connections handed over: those whose boat f holds
// are welcomed, those waiting for one told their place.
func (enc *encoder) adopt(f *bus.Frame) {
	enc.mu.Lock()
	defer enc.mu.Unlock()
	keep := enc.pending[:0]
	for _, c := range enc.pending {
		switch {
		case c.gone.Load():
			enc.load.Add(-1)
		case c.joinTick > f.Tick:
			keep = append(keep, c)
		case c.queued.Load():
			enc.queued[c.id] = c
			enc.e.m.queuedConns.Inc()
			c.place(c.position, max(int32(len(f.Queue)), c.position))
		case c.welcome(f):
			enc.active = append(enc.active, c)
		default:
			enc.load.Add(-1)
		}
	}
	clear(enc.pending[len(keep):])
	enc.pending = keep
	enc.npending.Store(int32(len(keep)))
}

// admit welcomes the waiting connections the queue has given boats: those
// f's events name, and, once a second, any whose admission came in a frame
// this encoder did not see, found by their boat; and once a second tells
// each waiting connection its place, if it has changed.
func (enc *encoder) admit(f *bus.Frame) {
	for i := range f.Events {
		ev := &f.Events[i]
		if ev.Reply.Result != bus.Admitted {
			continue
		}
		if c := enc.queued[ev.Conn]; c != nil && c.account == ev.Account {
			enc.welcomeQueued(c, f, ev.Reply.Slot)
		}
	}
	if f.Tick-enc.swept < sweepTicks {
		return
	}
	enc.swept = f.Tick
	waiting := int32(len(f.Queue))
	for i := range f.Queue {
		q := &f.Queue[i]
		if c := enc.queued[q.Conn]; c != nil && c.account == q.Account {
			c.seen = f.Tick
			c.place(int32(i+1), waiting)
		}
	}
	for id, c := range enc.queued {
		switch {
		case c.gone.Load():
			delete(enc.queued, id)
			enc.e.m.queuedConns.Dec()
			enc.load.Add(-1)
		case c.seen == f.Tick || c.joinTick > f.Tick:
		default:
			// Out of the queue, and not in an admission this encoder saw.
			slot := int32(-1)
			for _, s := range f.Live {
				if f.Owner[s] == c.account && f.Conn[s] == c.id {
					slot = s
				}
			}
			enc.welcomeQueued(c, f, slot)
		}
	}
}

// sweepTicks is how often waiting connections are told their place: once
// a second.
const sweepTicks = 30

// welcomeQueued welcomes a waiting connection to its boat in slot, of f; a
// slot of −1, no boat, closes it.
func (enc *encoder) welcomeQueued(c *conn, f *bus.Frame, slot int32) {
	delete(enc.queued, c.id)
	enc.e.m.queuedConns.Dec()
	if slot < 0 {
		c.close(websocket.StatusInternalError, "no boat")
		enc.load.Add(-1)
		return
	}
	c.slot, c.gen, c.boat, c.joinTick = slot, f.Gen[slot], f.Boat[slot], f.Tick
	c.joined.Store(true)
	c.queued.Store(false)
	if c.welcome(f) {
		enc.active = append(enc.active, c)
		return
	}
	enc.load.Add(-1)
}

// place tells a waiting connection its place in the queue, and how many
// wait, if either has changed since it was last told.
func (c *conn) place(position, waiting int32) {
	if position == c.toldPosition && waiting == c.toldWaiting {
		return
	}
	c.toldPosition, c.toldWaiting = position, waiting
	c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Queued{Queued: &pb.Queued{
		Position: uint32(position), Waiting: uint32(waiting),
	}}}, outQueued)
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
	// Under rmu, so that a Tools for a change of the flag after this one
	// read it comes after it.
	c.rmu.Lock()
	ok := c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Welcome{Welcome: &pb.Welcome{
		World: e.cfg.World, Tick: f.Tick, WorldTimeUs: wt.Microseconds(),
		Boat: c.boat, Kind: uint32(f.Kind[s]), Rejoined: c.rejoined,
		EpochUs: e.cfg.Epoch.UnixMicro(), Land: e.cfg.Land, Circulation: e.cfg.Circulation,
		Tools: c.tools.Load(), Light: e.cfg.MainLight, EndsUs: e.endsUs.Load(), ClosingUs: e.closingUs.Load(), Zone: e.cfg.Zone,
	}}}, outWelcome)
	c.welcomed = ok
	if ok && e.cfg.Chart != nil {
		entries := e.cfg.Chart.Entries()
		ok = c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Chart{Chart: &pb.Chart{Entries: entries}}}, outChart)
		c.charted = len(entries)
	}
	c.rmu.Unlock()
	c.ready.Store(ok)
	c.bumped = f.Tick
	// The land about the boat, at once after the Welcome: the client draws
	// what is near before it shows the sea.
	return ok && c.chunks(e.cfg.Chunks, f.State[s].X, f.State[s].Y)
}

// encode writes c's snapshot of f into its mailbox: the own boat, then the
// other boats in view, as changes from the view of the newest snapshot the
// connection's writer has taken, or in full if it has taken none, or the
// client asked for one. The view, the sea's window and the land's chunks
// are about the connection's eye: its boat, or its free camera while it
// roams.
func (enc *encoder) encode(c *conn, f *bus.Frame) {
	s := c.slot
	if !f.Occupied[s] || f.Boat[s] != c.boat {
		c.gone.Store(true)
		c.close(websocket.StatusInternalError, "the boat has gone")
		return
	}
	x, y, chunks := f.State[s].X, f.State[s].Y, c.e.cfg.Chunks
	if p := c.eye.Load(); p != nil {
		x, y = p.x, p.y
		if c.e.cfg.RoamChunks != nil {
			chunks = c.e.cfg.RoamChunks
		}
	}
	if c.resync.Swap(false) {
		c.box.restart()
	}
	base := c.box.base()
	if base != nil && (!base.valid || f.Tick-base.tick > math.MaxUint16 || f.Tick <= base.tick) {
		base = nil
	}
	b, next := c.box.fill()
	enter, sample := enc.aoi.find(f, s, x, y, base, next, c.id)
	next.tick, next.valid = f.Tick, true
	var flags uint8
	if farSampled(c.id, f.Tick) {
		flags = protocol.FarSampled
	}
	baseView, dist := &enc.empty.view, uint16(0)
	if base != nil {
		baseView, dist = &base.view, uint16(f.Tick-base.tick)
	}
	// The weather, the sea, the land's chunks and the bumps first: they are
	// queued, and what is queued goes out before the snapshot.
	if !c.weather(f) || !c.seaAreas(f, x, y) || !c.chunks(chunks, x, y) || !c.bumps(f, next) {
		return
	}
	b = b[:protocol.MaxHeaderSize]
	b = b[:protocol.PutHeader(b, f.Tick, dist, flags, f.Control[s], f.Pilot[s], c.margin.take(), f.Voyage[s].Over, f.Stay[s], &f.State[s])]
	b, n := protocol.AppendEntries(b, baseView, &next.view, enter, sample)
	protocol.SetEntries(b, n)

	m := &enc.e.m
	enters := bits.OnesCount64(enter)
	leaves := bits.OnesCount64(baseView.Used &^ next.view.Used)
	enc.counts[entryEnter] += float64(enters)
	enc.counts[entryLeave] += float64(leaves)
	enc.counts[entryUpdate] += float64(n - enters - leaves)
	far := 0
	for u := next.view.Used; u != 0; u &= u - 1 {
		if next.view.Boats[bits.TrailingZeros64(u)].Far() {
			far++
		}
	}
	m.viewNear.Observe(float64(next.view.Len() - far))
	m.viewFar.Observe(float64(far))
	m.snapshotBytes.Observe(float64(len(b)))
	if c.box.post(len(b)) {
		m.replaced.Inc()
	}
}

// bumps sends c the bumps of f after the last it was sent: with the
// verdict if its boat is one of the two, without if it sees either in its
// near band, by v, the view it is about to be sent.
func (c *conn) bumps(f *bus.Frame, v *connView) bool {
	newest := c.bumped
	for i := range f.Bumps {
		b := &f.Bumps[i]
		if b.Tick <= c.bumped {
			continue
		}
		newest = max(newest, b.Tick)
		who := uint8(physics.Neither)
		switch {
		case b.A == c.slot && b.BoatA == c.boat:
			who = physics.First
		case b.B == c.slot && b.BoatB == c.boat:
			who = physics.Second
		case !nearIn(v, b):
			continue
		}
		if !c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Bump{Bump: protocol.Bump(b, who)}}, outBump) {
			return false
		}
	}
	c.bumped = newest
	return true
}

// nearIn says whether either boat of b is in v's near band.
func nearIn(v *connView, b *bus.Bump) bool {
	for m := v.view.Used; m != 0; m &= m - 1 {
		vs := bits.TrailingZeros64(m)
		if v.view.Boats[vs].Far() {
			continue
		}
		if s, boat := v.slot[vs], v.boat[vs]; s == b.A && boat == b.BoatA || s == b.B && boat == b.BoatB {
			return true
		}
	}
	return false
}
