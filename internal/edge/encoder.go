// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"math"
	"math/bits"
	"slices"
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
// frame. For each frame it first does what its connections have asked of
// it (a boat welcomed, a watch begun or ended), stores in their boats'
// slots its connections' words held for the next tick, then welcomes the
// connections the queue has given boats, then, on even ticks, writes each
// of its sailing and watching connections' snapshots into the
// connection's mailbox: 15 a second. It holds the frame only while it
// works, and for connections already sailing or watching it allocates
// nothing.
type encoder struct {
	e      *Edge
	wakeCh chan struct{}
	load   atomic.Int32 // connections handed to it and not yet let go

	mu    sync.Mutex
	asks  []ask // asked of it, not yet done, in the order asked
	nasks atomic.Int32

	active []*conn           // sailing or watching
	queued map[uint64]*conn  // waiting for a boat, by connection ID
	last   int64             // the tick last encoded
	swept  int64             // the tick the queue was last read for positions
	told   int64             // the tick sailors were last told how many watch
	lamped int64             // the tick owners were last told of their agents
	aoi    aoi               // scratch for finding views
	empty  connView          // the base of a full snapshot
	counts [entryOps]float64 // entries written this round, by op
}

func (enc *encoder) init(e *Edge, capacity int) {
	enc.e = e
	enc.wakeCh = make(chan struct{}, 1)
	enc.last = math.MinInt64
	enc.swept = math.MinInt64
	enc.told = math.MinInt64
	enc.lamped = math.MinInt64
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

// ask hands over something a connection asks: done with the next frame,
// or, for a boat, with the first frame that holds it.
func (enc *encoder) ask(a ask) {
	enc.mu.Lock()
	enc.asks = append(enc.asks, a)
	enc.nasks.Add(1)
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
	if enc.nasks.Load() > 0 {
		enc.adopt(f)
	}
	// The words for the next tick first: it runs in a thirtieth of a
	// second.
	next := f.Tick + 1
	for i := 0; i < len(enc.active); {
		c := enc.active[i]
		if c.gone.Load() || !c.active {
			c.active = false
			last := len(enc.active) - 1
			enc.active[i], enc.active[last] = enc.active[last], nil
			enc.active = enc.active[:last]
			continue
		}
		if c.waiting.Load() > 0 {
			c.release(next)
		}
		// What has been charted since, and the forecast if it is issued
		// since: a closed connection goes next frame.
		_ = c.chart(enc.e.cfg.Chart) && c.forecast(enc.e.cfg.Forecast)
		i++
	}
	if len(enc.queued) > 0 {
		enc.admit(f)
	}
	if enc.told == math.MinInt64 || f.Tick-enc.told >= watchersEvery {
		enc.told = f.Tick
		for _, c := range enc.active {
			if c.active && !c.w.on {
				c.tellWatchers()
			}
		}
	}
	if enc.e.cfg.Agent != nil && (enc.lamped == math.MinInt64 || f.Tick-enc.lamped >= lampEvery) {
		enc.lamped = f.Tick
		now := time.Now()
		for _, c := range enc.active {
			if c.active && c.w.on && c.w.mine {
				c.tellLamp(now)
			}
		}
	}
	if f.Tick%2 != 0 {
		return
	}
	for _, c := range enc.active {
		if c.active {
			enc.encode(c, f)
		}
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

// adopt does what the connections asked, in the order they asked it: a
// connection whose boat f does not hold yet waits, with all it asked
// after.
func (enc *encoder) adopt(f *bus.Frame) {
	enc.mu.Lock()
	asks := enc.asks
	enc.asks = nil
	enc.nasks.Store(0)
	enc.mu.Unlock()
	var later []ask
	for _, a := range asks {
		if a.kind == askJoined && a.r.Tick > f.Tick || slices.ContainsFunc(later, func(l ask) bool { return l.c == a.c }) {
			later = append(later, a)
			continue
		}
		enc.do(a, f)
	}
	if len(later) > 0 {
		enc.mu.Lock()
		enc.asks = append(later, enc.asks...)
		enc.nasks.Store(int32(len(enc.asks)))
		enc.mu.Unlock()
	}
}

// do does what a connection asked, with frame f.
func (enc *encoder) do(a ask, f *bus.Frame) {
	c, e := a.c, enc.e
	if a.kind == askGone {
		enc.endWatch(c, pb.WatchEnd_WATCH_END_UNSPECIFIED, "")
		e.spect.release(c)
		enc.unqueue(c)
		c.active = false
		enc.load.Add(-1)
		return
	}
	if c.gone.Load() {
		// Its askGone follows.
		return
	}
	switch a.kind {
	case askJoined:
		if a.r.Result == bus.Queued {
			enc.queued[c.id] = c
			e.m.queuedConns.Inc()
			c.place(a.r.Position, max(humansWaiting(f), a.r.Position))
			return
		}
		enc.sail(c, f)
	case askWatch:
		enc.beginWatch(c, f, a.target)
	case askUnwatch:
		if c.w.on {
			enc.stopWatching(c, pb.WatchEnd_WATCH_END_UNSPECIFIED)
		}
		if a.why != pb.WatchEnd_WATCH_END_UNSPECIFIED {
			c.watchEnded(a.why, a.name)
		}
	}
}

// sail welcomes a connection to its own boat, its watch, if any, over.
func (enc *encoder) sail(c *conn, f *bus.Frame) {
	if c.w.on {
		enc.endWatch(c, pb.WatchEnd_WATCH_END_UNSPECIFIED, "")
		enc.e.spect.release(c)
	}
	if c.welcome(f) {
		enc.activate(c)
	} else {
		c.active = false
	}
}

// activate has the encoder write the connection's snapshots.
func (enc *encoder) activate(c *conn) {
	if !c.active {
		c.active = true
		enc.active = append(enc.active, c)
	}
}

// unqueue forgets a connection waiting for a boat.
func (enc *encoder) unqueue(c *conn) {
	if _, ok := enc.queued[c.id]; ok {
		delete(enc.queued, c.id)
		enc.e.m.queuedConns.Dec()
	}
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
	if enc.swept != math.MinInt64 && f.Tick-enc.swept < sweepTicks {
		return
	}
	enc.swept = f.Tick
	// A connection is a human's: told its place among humans waiting.
	position, waiting := int32(0), humansWaiting(f)
	for i := range f.Queue {
		q := &f.Queue[i]
		if q.Machine {
			continue
		}
		position++
		if c := enc.queued[q.Conn]; c != nil && c.account == q.Account {
			c.seen = f.Tick
			c.place(position, waiting)
		}
	}
	for _, c := range enc.queued {
		switch {
		case c.gone.Load():
			enc.unqueue(c)
		case c.seen == f.Tick:
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

// humansWaiting counts the humans in f's queue: machine sailors wait in a
// queue of their own.
func humansWaiting(f *bus.Frame) int32 {
	n := int32(0)
	for i := range f.Queue {
		if !f.Queue[i].Machine {
			n++
		}
	}
	return n
}

// sweepTicks is how often waiting connections are told their place: once
// a second.
const sweepTicks = 30

// welcomeQueued welcomes a waiting connection to its boat in slot, of f; a
// slot of −1, no boat, closes it. A watch it kept up while it waited ends
// as it sails.
func (enc *encoder) welcomeQueued(c *conn, f *bus.Frame, slot int32) {
	enc.unqueue(c)
	if slot < 0 {
		c.close(websocket.StatusInternalError, "no boat")
		return
	}
	c.wmu.Lock()
	c.slot, c.gen, c.boat, c.rejoined, c.joinTick = slot, f.Gen[slot], f.Boat[slot], false, f.Tick
	c.wmu.Unlock()
	c.joined.Store(true)
	c.queued.Store(false)
	enc.sail(c, f)
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

// welcome queues the Welcome to the connection's own boat, from the first
// frame that holds it: from then on its inputs steer the boat.
func (c *conn) welcome(f *bus.Frame) bool {
	e := c.e
	s := c.slot
	if !f.Occupied[s] || f.Boat[s] != c.boat {
		c.close(websocket.StatusInternalError, "the boat has gone")
		return false
	}
	e.voyages.sails(c.account, c.boat)
	c.wmu.Lock()
	c.steering = true
	c.wmu.Unlock()
	c.toldWatchers = 0
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
	ok = ok && c.firstChart()
	c.rmu.Unlock()
	c.ready.Store(ok)
	c.box.restart()
	c.bumped = f.Tick
	// The land about the boat, at once after the Welcome: the client draws
	// what is near before it shows the sea.
	return ok && c.chunks(e.cfg.Chunks, f.State[s].X, f.State[s].Y)
}

// encode writes c's snapshot of f into its mailbox: the own boat, or the
// boat it watches, then the other boats in view, as changes from the view
// of the newest snapshot the connection's writer has taken, or in full if
// it has taken none, or the client asked for one. The view, the sea's
// window and the land's chunks are about the connection's eye: its boat,
// the boat it watches, or its free camera while it roams. A watched boat
// gone, or no longer to be watched, ends the watch.
func (enc *encoder) encode(c *conn, f *bus.Frame) {
	s, boat := c.eyeSlot()
	if !f.Occupied[s] || f.Boat[s] != boat {
		if c.w.on {
			enc.stopWatching(c, pb.WatchEnd_WATCH_END_LEFT)
			return
		}
		c.gone.Store(true)
		c.close(websocket.StatusInternalError, "the boat has gone")
		return
	}
	if c.w.on {
		if why := enc.stillWatchable(c, f, s); why != pb.WatchEnd_WATCH_END_UNSPECIFIED {
			enc.stopWatching(c, why)
			return
		}
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
	if !c.weather(f) || !c.seaAreas(f, x, y) || !c.chunks(chunks, x, y) || !c.bumps(f, next, s, boat) {
		return
	}
	b = b[:protocol.MaxHeaderSize]
	b = b[:protocol.PutHeader(b, f.Tick, dist, flags, f.Control[s], f.Pilot[s], c.marginNow(), f.Voyage[s].Over, f.Stay[s], &f.State[s])]
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
// verdict if the boat in slot s, its own or the one it watches, is one of
// the two, without if it sees either in its near band, by v, the view it
// is about to be sent.
func (c *conn) bumps(f *bus.Frame, v *connView, s int32, boat uint64) bool {
	newest := c.bumped
	for i := range f.Bumps {
		b := &f.Bumps[i]
		if b.Tick <= c.bumped {
			continue
		}
		newest = max(newest, b.Tick)
		who := uint8(physics.Neither)
		switch {
		case b.A == s && b.BoatA == boat:
			who = physics.First
		case b.B == s && b.BoatB == boat:
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

// stopWatching ends c's watch, told why, and frees its place: it is idle,
// sent no snapshots.
func (enc *encoder) stopWatching(c *conn, why pb.WatchEnd) {
	if !c.w.on {
		return
	}
	name := c.w.target.Name
	enc.endWatch(c, why, name)
	enc.e.spect.release(c)
	if !c.joined.Load() {
		c.active = false
	}
}

// firstChart sends the world's chart whole after the connection's first
// Welcome; after a later one, for a watch begun or a boat sailed again,
// the client holds it already. rmu must be held.
func (c *conn) firstChart() bool {
	c.welcomes++
	c.welcomed = true
	if c.welcomes > 1 || c.e.cfg.Chart == nil {
		return true
	}
	entries := c.e.cfg.Chart.Entries()
	c.charted = len(entries)
	return c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Chart{Chart: &pb.Chart{Entries: entries}}}, outChart)
}
