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
// the player's own boat, its autopilot's block while it has one, then the
// entries of the other boats' view.
const (
	// HeaderSize is the header's length, its kind byte included: where
	// the entries begin, unless the autopilot's block follows it.
	HeaderSize = 176
	// PilotSize is the autopilot's block's length.
	PilotSize = 32
	// MaxHeaderSize is the header's length with the autopilot's block.
	MaxHeaderSize = HeaderSize + PilotSize
	// SnapshotLayout is the layout this package writes: the own boat's
	// state as float64, its autopilot's block if it has one, then the
	// view's entries.
	SnapshotLayout = 6
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
	State  physics.State
	// Entries is how many entries follow the header, and Header the
	// header's length, where they begin.
	Entries int
	Header  int
}

// pilotHeld reports whether a snapshot of the boat in state s, with the
// pilot word p in force, carries the autopilot's block: whether any of
// them is not zero.
func pilotHeld(p bus.PilotWord, s *physics.State) bool {
	return p.Mode() != 0 || p.Way() != 0 || p.Order() != 0 || p.Target() != 0 ||
		math.Float64bits(s.PilotTrim)|math.Float64bits(s.PilotWay)|math.Float64bits(s.PilotOrder) != 0
}

// PutHeader writes a snapshot's header, its kind byte first, into b, which
// must hold its length, MaxHeaderSize bytes with the autopilot's block and
// HeaderSize without, with no entries, and returns that length: where the
// entries begin. It allocates nothing.
func PutHeader(b []byte, tick int64, base uint16, flags uint8, word bus.Word, pilot bus.PilotWord, margin int16, s *physics.State) int {
	held := pilotHeld(pilot, s)
	_ = b[HeaderSize-1]
	if held {
		_ = b[MaxHeaderSize-1]
	}
	flags &^= PilotHeld
	if held {
		flags |= PilotHeld
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
	if !held {
		return HeaderSize
	}
	clear(b[HeaderSize:MaxHeaderSize])
	b[offPilotMode], b[offPilotWay], b[offPilotOrder] = pilot.Mode(), pilot.Way(), pilot.Order()
	le.PutUint16(b[offPilotTarget:], pilot.Target())
	for i, v := range fields[sim.BoatSize:] {
		le.PutUint64(b[offPilotState+8*i:], math.Float64bits(*v))
	}
	return MaxHeaderSize
}

// SetEntries writes the count of entries into a snapshot's header.
func SetEntries(b []byte, n int) { b[offEntries] = byte(n) }

// Put writes s's header as PutHeader does, with s.Entries as its count, and
// sets s.Header to its length.
func (s *Snapshot) Put(b []byte) {
	s.Header = PutHeader(b, s.Tick, s.Base, s.Flags, bus.Pack(s.Seq, s.Helm, s.Sheet, 0), s.pilot(), s.Margin, &s.State)
	SetEntries(b, s.Entries)
}

// Len is the length of s's header: where its entries begin.
func (s *Snapshot) Len() int {
	if pilotHeld(s.pilot(), &s.State) {
		return MaxHeaderSize
	}
	return HeaderSize
}

func (s *Snapshot) pilot() bus.PilotWord {
	return bus.PackPilot(s.Seq, s.Mode, s.Way, s.Order, s.Target, 0)
}

// ReadSnapshot reads a snapshot's header, its kind byte first, and its
// autopilot's block if it has one. Its entries are b[s.Header:], read with
// View.Apply.
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
	case s.Flags&^(FarSampled|PilotHeld) != 0:
		return fmt.Errorf("protocol: a snapshot's flags %#02x", s.Flags)
	case s.Entries > MaxEntries:
		return fmt.Errorf("protocol: a snapshot of %d entries", s.Entries)
	}
	fields := sim.StateFields(&s.State)
	for i, v := range fields[:sim.BoatSize] {
		*v = math.Float64frombits(le.Uint64(b[offState+8*i:]))
	}
	s.Mode, s.Way, s.Order, s.Target, s.Header = 0, 0, 0, 0, HeaderSize
	for _, v := range fields[sim.BoatSize:] {
		*v = 0
	}
	if s.Flags&PilotHeld == 0 {
		return nil
	}
	if len(b) < MaxHeaderSize {
		return fmt.Errorf("protocol: a snapshot of %d bytes, shorter than its header and autopilot", len(b))
	}
	s.Mode, s.Way, s.Order = b[offPilotMode], b[offPilotWay], b[offPilotOrder]
	s.Target = le.Uint16(b[offPilotTarget:])
	if s.Mode > bus.PilotHeading || s.Way > bus.WayGybe || s.Order > 3 || b[offPilotTarget-1] != 0 || le.Uint16(b[offPilotTarget+2:]) != 0 {
		return fmt.Errorf("protocol: a snapshot's autopilot of mode %d, way %d, order %d", s.Mode, s.Way, s.Order)
	}
	for i, v := range fields[sim.BoatSize:] {
		*v = math.Float64frombits(le.Uint64(b[offPilotState+8*i:]))
	}
	s.Header = MaxHeaderSize
	return nil
}
