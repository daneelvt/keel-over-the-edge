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
// the player's own boat, then the entries of the other boats' view.
const (
	// HeaderSize is the header's length, its kind byte included: where
	// the entries begin.
	HeaderSize = 160
	// SnapshotLayout is the layout this package writes: the own boat's
	// state as float64, then the view's entries.
	SnapshotLayout = 2
	// MaxEntries is the most entries a snapshot may hold.
	MaxEntries = 128
	// MaxSnapshotSize is the longest snapshot this package writes: an
	// entry for every view slot, each of the longest kind.
	MaxSnapshotSize = HeaderSize + ViewSlots*maxEntrySize
	// NoMargin is the margin of a snapshot when no input arrived since the
	// previous one.
	NoMargin = math.MinInt16
)

// Header flags.
const (
	// FarSampled: the far band's boats are sampled by this snapshot.
	FarSampled = 1 << 0
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
	offWind    = 23
	offState   = 39
	offEntries = 159
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
	// Seq, Helm and Sheet are the control word in force.
	Seq         uint32
	Helm, Sheet uint16
	// Margin is the lowest arrival margin since the previous snapshot, in
	// ticks, or NoMargin.
	Margin int16
	Wind   bus.Wind
	State  physics.State
	// Entries is how many entries follow the header.
	Entries int
}

// PutHeader writes a snapshot's header, its kind byte first, into b, which
// must hold HeaderSize bytes, with no entries. It allocates nothing.
func PutHeader(b []byte, tick int64, base uint16, flags uint8, word bus.Word, margin int16, wind bus.Wind, s *physics.State) {
	_ = b[HeaderSize-1]
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
	le.PutUint64(b[offWind:], math.Float64bits(wind.Speed))
	le.PutUint64(b[offWind+8:], math.Float64bits(wind.From))
	for i, v := range sim.StateFields(s) {
		le.PutUint64(b[offState+8*i:], math.Float64bits(*v))
	}
	b[offEntries] = 0
}

// SetEntries writes the count of entries into a snapshot's header.
func SetEntries(b []byte, n int) { b[offEntries] = byte(n) }

// Put writes s's header as PutHeader does, with s.Entries as its count.
func (s *Snapshot) Put(b []byte) {
	PutHeader(b, s.Tick, s.Base, s.Flags, bus.Pack(s.Seq, s.Helm, s.Sheet, 0), s.Margin, s.Wind, &s.State)
	SetEntries(b, s.Entries)
}

// ReadSnapshot reads a snapshot's header, its kind byte first. Its entries
// are b[HeaderSize:], read with View.Apply.
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
	case s.Flags&^FarSampled != 0:
		return fmt.Errorf("protocol: a snapshot's flags %#02x", s.Flags)
	case s.Entries > MaxEntries:
		return fmt.Errorf("protocol: a snapshot of %d entries", s.Entries)
	}
	s.Wind.Speed = math.Float64frombits(le.Uint64(b[offWind:]))
	s.Wind.From = math.Float64frombits(le.Uint64(b[offWind+8:]))
	for i, v := range sim.StateFields(&s.State) {
		*v = math.Float64frombits(le.Uint64(b[offState+8*i:]))
	}
	return nil
}
