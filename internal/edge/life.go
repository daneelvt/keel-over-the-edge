// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"math"
	"math/bits"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// The sea's life goes to a connection as its lights do, by reach: an
// encounter is sent once the connection's eye is within its kind's reach
// of it (of its centre, or of the boat it is with), again when it changes
// or the boat it is with is seen otherwise, and dropped once the eye is
// further than its reach by a margin. One that ends is let go with no
// word: the phone ends it at its end. The boat it is with goes as this
// connection sees boats: its own, one in a view slot, or one it does not
// see.

// LifeReach is how far each kind of the sea's life is sent, m, by its
// index in the catalog's kinds, and how far beyond that it is dropped.
type LifeReach struct {
	Reach []float64
	Drop  float64
}

// The boat an encounter is with, as a connection is told it.
const (
	lifeFree   = 0   // with none
	lifeOwn    = 1   // with the connection's own boat, or the one it watches
	lifeSlot   = 2   // plus the view slot of a boat it sees
	lifeUnseen = 255 // with a boat it does not see
)

// connLife is what a connection has been sent of the sea's life.
type connLife struct {
	sent []lifeSent
}

// lifeSent is an encounter sent: its revision, and the boat it is with as
// the connection was told it.
type lifeSent struct {
	id   uint64
	rev  uint32
	with uint32
}

// lifeRoom is how many encounters a connection keeps room for at first.
const lifeRoom = 32

// life sends the connection, whose eye at (x, y) is that of the boat in
// slot s, the encounters within reach it has not been sent or that have
// changed, and drops those it is further from than reach and the margin.
// It reports whether the connection is still good. Finding nothing new
// allocates nothing.
func (c *conn) life(f *bus.Frame, v *connView, s int32, x, y float64) bool {
	r := c.e.cfg.Life
	if r == nil {
		return true
	}
	st := &c.lifeSent
	if st.sent == nil {
		st.sent = make([]lifeSent, 0, lifeRoom)
	}
	// Those ended are let go.
	n := 0
	for _, sent := range st.sent {
		for i := range f.Life {
			if f.Life[i].ID == sent.id {
				st.sent[n] = sent
				n++
				break
			}
		}
	}
	st.sent = st.sent[:n]
	var m *pb.Life
	for i := range f.Life {
		e := &f.Life[i]
		if int(e.Kind) >= len(r.Reach) {
			continue
		}
		reach := r.Reach[e.Kind]
		px, py := e.East, e.North
		if e.Boat != 0 && e.Slot >= 0 && int(e.Slot) < len(f.State) {
			px, py = f.State[e.Slot].X, f.State[e.Slot].Y
		}
		dx, dy := px-x, py-y
		d := math.Sqrt(dx*dx + dy*dy)
		k := -1
		for j := range st.sent {
			if st.sent[j].id == e.ID {
				k = j
				break
			}
		}
		switch {
		case k < 0 && d <= reach:
			with := lifeWith(f, v, s, e)
			st.sent = append(st.sent, lifeSent{id: e.ID, rev: e.Rev, with: with})
			m = lifeAdd(m, e, with)
		case k >= 0 && d > reach+r.Drop:
			if m == nil {
				m = &pb.Life{}
			}
			m.Drop = append(m.Drop, e.ID)
			last := len(st.sent) - 1
			st.sent[k] = st.sent[last]
			st.sent = st.sent[:last]
		case k >= 0:
			with := st.sent[k].with
			if e.Boat != 0 || with != lifeFree {
				with = lifeWith(f, v, s, e)
			}
			if st.sent[k].rev != e.Rev || st.sent[k].with != with {
				st.sent[k].rev, st.sent[k].with = e.Rev, with
				m = lifeAdd(m, e, with)
			}
		}
	}
	if m == nil {
		return true
	}
	return c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Life{Life: m}}, outLife)
}

// lifeWith is the boat an encounter is with as the connection whose eye
// is slot s's, and whose view is v, sees it.
func lifeWith(f *bus.Frame, v *connView, s int32, e *bus.LifeEncounter) uint32 {
	if e.Boat == 0 {
		return lifeFree
	}
	if f.Boat[s] == e.Boat {
		return lifeOwn
	}
	for u := v.view.Used; u != 0; u &= u - 1 {
		i := bits.TrailingZeros64(u)
		if v.boat[i] == e.Boat {
			return lifeSlot + uint32(i)
		}
	}
	return lifeUnseen
}

// lifeAdd adds an encounter to m, made if nil, as the wire carries it.
func lifeAdd(m *pb.Life, e *bus.LifeEncounter, with uint32) *pb.Life {
	if m == nil {
		m = &pb.Life{}
	}
	m.Encounters = append(m.Encounters, &pb.LifeEncounter{
		Id: e.ID, Rev: e.Rev, Kind: uint32(e.Kind), Start: e.Start, End: e.End,
		East: int32(math.Round(e.East * 100)), North: int32(math.Round(e.North * 100)),
		Heading: float32(e.Heading), Speed: float32(e.Speed), Count: uint32(e.Count), Seed: e.Seed, With: with,
	})
	return m
}
