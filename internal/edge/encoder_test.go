// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"bytes"
	"log/slog"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

func TestMailbox(t *testing.T) {
	var m mailbox
	m.init()
	if m.take() != nil {
		t.Fatal("an empty mailbox gave a snapshot")
	}
	copy(m.fill(), "first")
	if m.post() {
		t.Fatal("the first post replaced one")
	}
	copy(m.fill(), "second")
	if !m.post() {
		t.Fatal("a post before the take did not replace the waiting snapshot")
	}
	if b := m.take(); !bytes.HasPrefix(b, []byte("second")) {
		t.Fatalf("took %q", b[:6])
	}
	if m.take() != nil {
		t.Fatal("a snapshot was taken twice")
	}
	// While one is being sent, two more are filled in turn: the one being
	// sent is never written.
	sending := m.take()
	_ = sending
	copy(m.fill(), "third")
	m.post()
	sending = m.take()
	copy(m.fill(), "fourth")
	m.post()
	if !bytes.HasPrefix(sending, []byte("third")) {
		t.Fatalf("the buffer being sent became %q", sending[:6])
	}
}

// TestEncoderAllocatesNothing: a frame encoded for a thousand connections,
// with words held for their tick, allocates nothing, and every frame the
// encoder acquires it releases.
func TestEncoderAllocatesNothing(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	p := catalog.PhysicsParams(&cat.Boats[0])
	var kind physics.Prepared
	physics.Prepare(&p, &kind)
	w, err := sim.New(sim.Config{Kinds: []physics.Prepared{kind}, Workers: 4, Tick: 1000})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	e := New(Config{Bus: w.Bus(), Metrics: obs.NewMetrics("test", "test"), Log: slog.New(slog.DiscardHandler)})
	const n = 1000
	for i := range n {
		var a bus.Account
		a[14], a[15] = byte(i>>8), byte(i)
		w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Join, Account: a, Conn: uint64(i + 1)})
	}
	w.Tick()
	f := w.Latest()
	if len(f.Live) != n {
		t.Fatalf("%d boats", len(f.Live))
	}
	conns := make([]*conn, n)
	for i, s := range f.Live {
		c := &conn{e: e, slot: s, gen: f.Gen[s], boat: f.Boat[s]}
		c.margin.init()
		c.box.init()
		conns[i] = c
		e.enc.active = append(e.enc.active, c)
	}
	tick := func() {
		next := w.Now() + 1
		for i, c := range conns {
			if i%3 == 0 {
				c.wmu.Lock()
				c.held[(c.first+c.nheld)%heldWords] = bus.Pack(uint32(next+2), uint16(i%1024), 512, c.gen)
				c.nheld++
				c.waiting.Store(int32(c.nheld))
				c.wmu.Unlock()
				c.margin.record(int16(i % 7))
			}
		}
		w.Tick()
		e.Record(w.Latest())
		e.enc.frame()
		// The writer's side: the snapshot taken, as if sent.
		for _, c := range conns {
			c.box.take()
		}
	}
	for range 10 {
		tick()
	}
	if a := testing.AllocsPerRun(100, tick); a != 0 {
		t.Fatalf("a frame allocates %v times", a)
	}
	var sn protocol.Snapshot
	if err := protocol.ReadSnapshot(conns[3].box.bufs[conns[3].box.sending][:], &sn); err != nil || sn.Tick%2 != 0 {
		t.Fatalf("snapshot %+v, %v", sn, err)
	}
	if got := w.Bus().Frames.Allocated(); got != 0 {
		t.Fatalf("%d frames made: one acquired was never released", got)
	}
	// Held words were applied at their tick.
	if l := w.Latest(); l.Control[conns[0].slot].Seq() > uint32(l.Tick) {
		t.Fatal("a word applied before its tick")
	}
}
