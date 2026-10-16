// SPDX-License-Identifier: AGPL-3.0-only

package protocol

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

// The snapshot, as shared/protocol/snapshot.txt lays it out: a header with
// the player's own boat, its autopilot's block while it has one, its ground
// block while it is aground, its over block while it falls over the lip,
// then the entries of the other boats' view.
const (
	// HeaderSize is the header's length, its kind byte included: where
	// the entries begin, unless the autopilot's or the ground block
	// follows it.
	HeaderSize = 176
	// PilotSize is the autopilot's block's length, GroundSize the ground
	// block's and OverSize the over block's.
	PilotSize  = 32
	GroundSize = 8
	OverSize   = 8
	// MaxHeaderSize is the header's length with every block.
	MaxHeaderSize = HeaderSize + PilotSize + GroundSize + OverSize
	// SnapshotLayout is the layout this package writes: the own boat's
	// state as float64, its autopilot's block if it has one, its ground
	// block if it is aground, its over block if it is falling over the
	// lip, then the view's entries.
	SnapshotLayout = 8
	// MaxEntries is the most entries a snapshot may hold.
	MaxEntries = 128
	// MaxSnapshotSize is the longest snapshot this package writes: an
	// entry for every view slot, each of the longest kind.
	MaxSnapshotSize = MaxHeaderSize + ViewSlots*maxEntrySize
	// NoMargin is the margin of a snapshot when no input arrived since the
	// previous one.
	NoMargin = math.MinInt16
)

// Header flags.
const (
	// FarSampled: the far band's boats are sampled by this snapshot.
	FarSampled = 1 << 0
	// PilotHeld: the autopilot's block follows the header. It does while
	// the pilot word in force or what the autopilot remembers is not zero,
	// so a boat that never uses it pays nothing.
	PilotHeld = 1 << 1
	// GroundHeld: the ground block follows the header and the autopilot's
	// block, if that is there. It does while the boat's time aground is
	// not zero, so a boat afloat pays nothing.
	GroundHeld = 1 << 2
	// OverHeld: the over block follows the header and the blocks before
	// it: the tick the boat went over the lip, while it falls.
	OverHeld = 1 << 3
)

const (
	offLayout  = 1
	offTick    = 2
	offBase    = 10
	offFlags   = 12
	offSeq     = 13
	offMargin  = 17
	offHelm    = 19
	offSheet   = 21
	offState   = 23
	offEntries = offState + 8*sim.BoatSize

	// The autopilot's block.
	offPilotMode   = HeaderSize
	offPilotWay    = HeaderSize + 1
	offPilotOrder  = HeaderSize + 2
	offPilotTarget = HeaderSize + 4
	offPilotState  = HeaderSize + 8
)

// Snapshot is a snapshot's header: the player's own boat as the server last
// stepped it, and what the entries after it need.
type Snapshot struct {
	Tick int64
	// Base is how many ticks before Tick the snapshot the entries change
	// is; 0 for none.
	Base uint16
	// Flags are the header's flags: FarSampled.
	Flags uint8
	// Seq, Helm and Sheet are the control word in force; Mode, Way, Order
	// and Target the pilot word.
	Seq              uint32
	Helm, Sheet      uint16
	Mode, Way, Order uint8
	Target           uint16
	// Margin is the lowest arrival margin since the previous snapshot, in
	// ticks, or NoMargin.
	Margin int16
	// Over is the tick the boat went over the lip while it is falling, or
	// 0 while it is afloat.
	Over  int64
	State physics.State
	// Entries is how many entries follow the header, and Header the
	// header's length, where they begin.
	Entries int
	Header  int
}

// groundHeld reports whether a snapshot of the boat in state s carries the
// ground block: whether its time aground is not zero (-0 counts).
func groundHeld(s *physics.State) bool { return math.Float64bits(s.GroundTimer) != 0 }

// pilotHeld reports whether a snapshot of the boat in state s, with the
// pilot word p in force, carries the autopilot's block: whether any of
// them is not zero.
func pilotHeld(p bus.PilotWord, s *physics.State) bool {
	return p.Mode() != 0 || p.Way() != 0 || p.Order() != 0 || p.Target() != 0 ||
		math.Float64bits(s.PilotTrim)|math.Float64bits(s.PilotWay)|math.Float64bits(s.PilotOrder) != 0
}

// PutHeader writes a snapshot's header, its kind byte first, into b, which
// must hold its length, HeaderSize bytes and each block's, with no entries,
// and returns that length: where the entries begin. over is the tick the
// boat went over the lip, 0 while it is afloat. It allocates nothing.
func PutHeader(b []byte, tick int64, base uint16, flags uint8, word bus.Word, pilot bus.PilotWord, margin int16, over int64, s *physics.State) int {
	held, aground, falling := pilotHeld(pilot, s), groundHeld(s), over != 0
	n := headerLength(held, aground, falling)
	_ = b[n-1]
	flags &^= PilotHeld | GroundHeld | OverHeld
	if held {
		flags |= PilotHeld
	}
	if aground {
		flags |= GroundHeld
	}
	if falling {
		flags |= OverHeld
	}
	le := binary.LittleEndian
	b[0] = KindSnapshot
	b[offLayout] = SnapshotLayout
	le.PutUint64(b[offTick:], uint64(tick))
	le.PutUint16(b[offBase:], base)
	b[offFlags] = flags
	le.PutUint32(b[offSeq:], word.Seq())
	le.PutUint16(b[offMargin:], uint16(margin))
	le.PutUint16(b[offHelm:], word.HelmIndex())
	le.PutUint16(b[offSheet:], word.SheetIndex())
	fields := sim.StateFields(s)
	for i, v := range fields[:sim.BoatSize] {
		le.PutUint64(b[offState+8*i:], math.Float64bits(*v))
	}
	b[offEntries] = 0
	at := HeaderSize
	if held {
		clear(b[HeaderSize : HeaderSize+PilotSize])
		b[offPilotMode], b[offPilotWay], b[offPilotOrder] = pilot.Mode(), pilot.Way(), pilot.Order()
		le.PutUint16(b[offPilotTarget:], pilot.Target())
		for i, v := range fields[sim.BoatSize : sim.BoatSize+sim.PilotSize] {
			le.PutUint64(b[offPilotState+8*i:], math.Float64bits(*v))
		}
		at += PilotSize
	}
	if aground {
		le.PutUint64(b[at:], math.Float64bits(s.GroundTimer))
		at += GroundSize
	}
	if falling {
		le.PutUint64(b[at:], uint64(over))
		at += OverSize
	}
	return at
}

// headerLength is the header's length with the blocks that follow it.
func headerLength(pilot, ground, over bool) int {
	n := HeaderSize
	if pilot {
		n += PilotSize
	}
	if ground {
		n += GroundSize
	}
	if over {
		n += OverSize
	}
	return n
}

// SetEntries writes the count of entries into a snapshot's header.
func SetEntries(b []byte, n int) { b[offEntries] = byte(n) }

// Put writes s's header as PutHeader does, with s.Entries as its count, and
// sets s.Header to its length.
func (s *Snapshot) Put(b []byte) {
	s.Header = PutHeader(b, s.Tick, s.Base, s.Flags, bus.Pack(s.Seq, s.Helm, s.Sheet, 0), s.pilot(), s.Margin, s.Over, &s.State)
	SetEntries(b, s.Entries)
}

// Len is the length of s's header: where its entries begin.
func (s *Snapshot) Len() int {
	return headerLength(pilotHeld(s.pilot(), &s.State), groundHeld(&s.State), s.Over != 0)
}

func (s *Snapshot) pilot() bus.PilotWord {
	return bus.PackPilot(s.Seq, s.Mode, s.Way, s.Order, s.Target, 0)
}

// ReadSnapshot reads a snapshot's header, its kind byte first, and its
// autopilot's and ground blocks if it has them. Its entries are
// b[s.Header:], read with View.Apply.
func ReadSnapshot(b []byte, s *Snapshot) error {
	switch {
	case len(b) == 0:
		return ErrEmpty
	case b[0] != KindSnapshot:
		return ErrKind
	case len(b) < 2:
		return errors.New("protocol: a snapshot cut short")
	case b[offLayout] != SnapshotLayout:
		return fmt.Errorf("protocol: a snapshot of layout %d", b[offLayout])
	case len(b) < HeaderSize:
		return fmt.Errorf("protocol: a snapshot of %d bytes, shorter than its header", len(b))
	}
	le := binary.LittleEndian
	s.Tick = int64(le.Uint64(b[offTick:]))
	s.Base = le.Uint16(b[offBase:])
	s.Flags = b[offFlags]
	s.Seq = le.Uint32(b[offSeq:])
	s.Margin = int16(le.Uint16(b[offMargin:]))
	s.Helm = le.Uint16(b[offHelm:])
	s.Sheet = le.Uint16(b[offSheet:])
	s.Entries = int(b[offEntries])
	switch {
	case s.Helm > bus.Steps || s.Sheet > bus.Steps:
		return fmt.Errorf("protocol: a snapshot's controls %d and %d", s.Helm, s.Sheet)
	case s.Flags&^(FarSampled|PilotHeld|GroundHeld|OverHeld) != 0:
		return fmt.Errorf("protocol: a snapshot's flags %#02x", s.Flags)
	case s.Entries > MaxEntries:
		return fmt.Errorf("protocol: a snapshot of %d entries", s.Entries)
	}
	fields := sim.StateFields(&s.State)
	for i, v := range fields[:sim.BoatSize] {
		*v = math.Float64frombits(le.Uint64(b[offState+8*i:]))
	}
	s.Mode, s.Way, s.Order, s.Target = 0, 0, 0, 0
	for _, v := range fields[sim.BoatSize:] {
		*v = 0
	}
	held, aground, falling := s.Flags&PilotHeld != 0, s.Flags&GroundHeld != 0, s.Flags&OverHeld != 0
	s.Header = headerLength(held, aground, falling)
	if len(b) < s.Header {
		return fmt.Errorf("protocol: a snapshot of %d bytes, shorter than its header and blocks", len(b))
	}
	at := HeaderSize
	if held {
		s.Mode, s.Way, s.Order = b[offPilotMode], b[offPilotWay], b[offPilotOrder]
		s.Target = le.Uint16(b[offPilotTarget:])
		if s.Mode > bus.PilotHeading || s.Way > bus.WayGybe || s.Order > 3 || b[offPilotTarget-1] != 0 || le.Uint16(b[offPilotTarget+2:]) != 0 {
			return fmt.Errorf("protocol: a snapshot's autopilot of mode %d, way %d, order %d", s.Mode, s.Way, s.Order)
		}
		for i, v := range fields[sim.BoatSize : sim.BoatSize+sim.PilotSize] {
			*v = math.Float64frombits(le.Uint64(b[offPilotState+8*i:]))
		}
		at += PilotSize
	}
	s.Over = 0
	if aground {
		s.State.GroundTimer = math.Float64frombits(le.Uint64(b[at:]))
		at += GroundSize
	}
	if falling {
		s.Over = int64(le.Uint64(b[at:]))
		if s.Over <= 0 || s.Over > s.Tick {
			return fmt.Errorf("protocol: a snapshot of tick %d over the lip at tick %d", s.Tick, s.Over)
		}
	}
	return nil
}
