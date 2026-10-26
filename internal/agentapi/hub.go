// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The wake hub. Each frame the simulation publishes is handed to the
// world's Recorder on the ticking goroutine, which copies what happened to
// machine sailors' boats (joins from the queue, boats leaving, going over
// the falls, charting, the world's end) into a channel and never blocks;
// and pokes the hub. The hub, on its own goroutine, puts those events in
// each helm's ring, and every third frame, ten times a second, looks at
// each machine sailor's boat as the frame has it: its wind for the readout,
// its sailor's capsizes and the ground under it, its autopilot's turns,
// and for a call that waits whatever it waits for. A sailor on the phone
// is told of these as quickly: the phone's notices, its overlays and the
// lookouts' sighting run at these rates or slower.

// checkEvery is how many frames apart the hub looks at the boats: ten
// times a second.
const checkEvery = 3

// sightEvery is how many frames apart a waiting call's lookout looks for
// something new in sight, as the simulation's lookouts do.
const sightEvery = 15

// recordRoom is how many recorded events wait for the hub at most; more
// are dropped, and counted.
const recordRoom = 4096

// record is what a frame told of a machine sailor.
type record struct {
	tick    int64
	kind    evKind
	account bus.Account
	conn    uint64
	boat    uint64
	slot    int32
	// subject is a charting's subject, by its index in the sight table;
	// x and y where its boat was, and owner who sailed it.
	subject int32
	x, y    float64
	owner   bus.Account
	result  bus.Result
}

// Recorder is handed a world's frames as they are published: a
// sim.Recorder.
type Recorder struct {
	hub *hub
	sea *Sea
}

// Record copies what f tells of machine sailors for the hub, and pokes it.
// It never blocks.
func (r *Recorder) Record(f *bus.Frame) {
	h := r.hub
	put := func(rec record) {
		select {
		case h.records <- recordFor{sea: r.sea, record: rec}:
		default:
			h.droppedMu.Lock()
			h.dropped++
			h.droppedMu.Unlock()
		}
	}
	for i := range f.Events {
		e := &f.Events[i]
		switch {
		case e.Op == bus.Join && e.Machine && e.Reply.Result == bus.Admitted:
			put(record{tick: f.Tick, kind: evAdmitted, account: e.Account, conn: e.Conn, boat: e.Reply.Boat, slot: e.Reply.Slot})
		case e.Op == bus.Leave && (e.Reply.Result == bus.Left || e.Reply.Result == bus.Expired):
			put(record{tick: f.Tick, kind: evLeft, account: e.Account, boat: e.Reply.Boat, result: e.Reply.Result})
		}
	}
	for i := range f.Edges {
		e := &f.Edges[i]
		if e.Slot < 0 || int(e.Slot) >= len(f.Machine) || !f.Machine[e.Slot] || e.Placed {
			continue
		}
		switch e.Kind {
		case bus.EdgeOver:
			put(record{tick: f.Tick, kind: evOver, account: e.Owner, boat: e.Boat, x: e.X, y: e.Y})
		case bus.EdgeTaken:
			put(record{tick: f.Tick, kind: evTaken, account: e.Owner, boat: e.Boat, x: e.X, y: e.Y})
		}
	}
	for i := range f.Charted {
		c := &f.Charted[i]
		if c.With >= 0 {
			continue
		}
		put(record{tick: f.Tick, kind: evCharted, subject: c.Subject, owner: c.Owner, boat: c.Boat, x: c.X, y: c.Y})
	}
	if f.Ended {
		put(record{tick: f.Tick, kind: evWorldEnded})
	}
	select {
	case h.poke <- struct{}{}:
	default:
	}
}

// recordFor is a record and the world it came from.
type recordFor struct {
	sea *Sea
	record
}

// hub is the wake hub.
type hub struct {
	core    *Core
	records chan recordFor
	poke    chan struct{}

	droppedMu sync.Mutex
	dropped   uint64

	// What the hub keeps of the boats of the world it looks at: each
	// slot's boat and its sailor's mode and grounding at the last look,
	// for capsizes and groundings; the newest bump told.
	sea     *Sea
	lastAt  int64
	sightAt int64
	boats   []uint64
	modes   []uint8
	ground  []bool
	bumped  int64
}

func newHub(c *Core) *hub {
	return &hub{core: c, records: make(chan recordFor, recordRoom), poke: make(chan struct{}, 1)}
}

// recorder is the Recorder of world s.
func (h *hub) recorder(s *Sea) *Recorder { return &Recorder{hub: h, sea: s} }

// run looks at each frame it is poked for until ctx ends.
func (h *hub) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.poke:
		}
		h.drain()
		s := h.core.sea.Load()
		if s == nil {
			continue
		}
		f := s.Bus.Frames.Acquire()
		if s != h.sea || f.Tick < h.lastAt {
			h.reset(s, f)
		}
		if f.Tick-h.lastAt >= checkEvery {
			h.lastAt = f.Tick
			h.look(s, f)
		}
		f.Release()
	}
}

// reset starts looking at the boats of world s afresh.
func (h *hub) reset(s *Sea, f *bus.Frame) {
	n := f.Capacity()
	h.sea, h.lastAt, h.sightAt, h.bumped = s, f.Tick-checkEvery, f.Tick, f.Tick
	h.boats, h.modes, h.ground = make([]uint64, n), make([]uint8, n), make([]bool, n)
}

// helmByAccount is an account's helm, or nil.
func (h *hub) helmByAccount(a bus.Account) *helm {
	c := h.core
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.helms[store.AccountID(a)]
}

// drain hands the events recorded to their helms.
func (h *hub) drain() {
	for {
		select {
		case r := <-h.records:
			h.dispatch(r)
		default:
			return
		}
	}
}

// dispatch tells a recorded event to the helms it concerns.
func (h *hub) dispatch(r recordFor) {
	switch r.kind {
	case evWorldEnded:
		h.core.each(func(hm *helm) {
			hm.mu.Lock()
			mine := hm.sea == r.sea && (hm.boat != 0 || hm.queued)
			if mine {
				hm.left = leftFalls
			}
			hm.mu.Unlock()
			if mine {
				hm.event(event{Tick: r.tick, Kind: evWorldEnded, Words: "the falls took the world: the next world opens in a moment"})
			}
		})
		return
	case evCharted:
		h.charted(r)
		return
	}
	hm := h.helmByAccount(r.account)
	if hm == nil {
		return
	}
	hm.mu.Lock()
	if hm.sea != r.sea {
		hm.mu.Unlock()
		return
	}
	var e event
	switch r.kind {
	case evAdmitted:
		if r.conn != hm.conn {
			hm.mu.Unlock()
			return
		}
		hm.slot, hm.boat, hm.queued = r.slot, r.boat, false
		hm.ordered = false
		e = event{Tick: r.tick, Kind: evAdmitted, Words: "admitted from the queue: your boat is in the water"}
	case evLeft:
		if r.boat != hm.boat {
			hm.mu.Unlock()
			return
		}
		why := "your boat left the water"
		if r.result == bus.Expired {
			why = "your boat left the water at the end of its grace"
			if hm.left == "" {
				hm.left = leftGrace
				if hm.away {
					hm.left = leftSilent
				}
			}
		}
		hm.boat = 0
		e = event{Tick: r.tick, Kind: evLeft, Words: why}
	case evOver:
		e = event{Tick: r.tick, Kind: evOver, Words: "over the falls: your boat starts again at the start"}
	case evTaken:
		e = event{Tick: r.tick, Kind: evTaken, Words: "the falls took the world, and your boat with it"}
	default:
		hm.mu.Unlock()
		return
	}
	hm.mu.Unlock()
	hm.event(e)
}

// discoveryReach is how near a great discovery is told: within sight of
// it, as the phone's notice of one is.
const discoveryReach = 2000.0

// charted tells a charting to its sailor's helm, and a great discovery to
// the helms whose boats are near it.
func (h *hub) charted(r recordFor) {
	s := r.sea
	if s.Chart == nil {
		return
	}
	w := s.Chart.World()
	if r.subject < 0 || int(r.subject) >= len(w.Subjects) {
		return
	}
	sub := &w.Subjects[r.subject]
	if hm := h.helmByAccount(r.owner); hm != nil && r.boat != 0 {
		hm.event(event{Tick: r.tick, Kind: evCharted, Words: "you charted " + sub.Title})
	}
	if !sub.News {
		return
	}
	f := s.Bus.Frames.Acquire()
	defer f.Release()
	h.core.each(func(hm *helm) {
		hm.mu.Lock()
		boat, slot, mine := hm.boat, hm.slot, hm.sea == s
		hm.mu.Unlock()
		if !mine || boat == 0 || bus.Account(hm.account) == r.owner || !f.Occupied[slot] || f.Boat[slot] != boat {
			return
		}
		st := &f.State[slot]
		if dx, dy := st.X-sub.X, st.Y-sub.Y; dx*dx+dy*dy <= discoveryReach*discoveryReach {
			hm.event(event{Tick: r.tick, Kind: evDiscovery, Words: sub.Title + " charted near you"})
		}
	})
}

// look looks at every machine sailor's boat in f, and at every boat for
// capsizes, ten times a second.
func (h *hub) look(s *Sea, f *bus.Frame) {
	m := h.core.cfg.Metrics
	for _, sl := range f.Live {
		st := &f.State[sl]
		mode := uint8(st.SailorMode)
		aground := st.GroundTimer > 0
		if h.boats[sl] == f.Boat[sl] {
			if mode != physics.Sailing && h.modes[sl] == physics.Sailing && m != nil {
				who := "human"
				if f.Machine[sl] {
					who = "machine"
				}
				m.AgentCapsizes.WithLabelValues(who).Inc()
			}
		} else {
			h.modes[sl], h.ground[sl] = mode, aground
		}
		if f.Machine[sl] {
			h.boatEvents(f, sl, mode, aground)
		}
		h.boats[sl], h.modes[sl], h.ground[sl] = f.Boat[sl], mode, aground
	}
	h.bumps(f)
	sight := f.Tick-h.sightAt >= sightEvery
	if sight {
		h.sightAt = f.Tick
	}
	h.core.each(func(hm *helm) { hm.look(s, f, sight) })
}

// boatEvents are a machine boat's capsizes and groundings since the last
// look.
func (h *hub) boatEvents(f *bus.Frame, sl int32, mode uint8, aground bool) {
	if h.boats[sl] != f.Boat[sl] {
		return
	}
	hm := h.helmByAccount(f.Owner[sl])
	if hm == nil {
		return
	}
	switch {
	case mode != physics.Sailing && h.modes[sl] == physics.Sailing:
		hm.event(event{Tick: f.Tick, Kind: evCapsized, Words: "capsized: your sailor is in the water, righting the boat"})
	case mode == physics.Sailing && h.modes[sl] != physics.Sailing:
		hm.event(event{Tick: f.Tick, Kind: evRighted, Words: "righted: sailing again"})
	}
	switch {
	case aground && !h.ground[sl]:
		hm.event(event{Tick: f.Tick, Kind: evAground, Words: "aground"})
	case !aground && h.ground[sl]:
		hm.event(event{Tick: f.Tick, Kind: evAfloat, Words: "afloat again"})
	}
}

// bumps tells each bump of a machine sailor's boat since the last look, in
// the words the phone's notice gives.
func (h *hub) bumps(f *bus.Frame) {
	newest := h.bumped
	for i := range f.Bumps {
		b := &f.Bumps[i]
		if b.Tick <= h.bumped {
			continue
		}
		newest = max(newest, b.Tick)
		for side, a := range [2]bus.Account{b.OwnerA, b.OwnerB} {
			sl := b.A
			if side == 1 {
				sl = b.B
			}
			if !f.Occupied[sl] || !f.Machine[sl] {
				continue
			}
			if hm := h.helmByAccount(a); hm != nil {
				hm.event(event{Tick: b.Tick, Kind: evBump, Words: bumpWords(b, side)})
			}
		}
	}
	h.bumped = newest
}
