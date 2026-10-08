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

// The own-boat snapshot, as shared/protocol/snapshot.txt lays it out.
const (
	// SnapshotSize is a snapshot's length, its kind byte included.
	SnapshotSize = 156
	// SnapshotLayout is the layout this package writes: the boat's state
	// as float64.
	SnapshotLayout = 1
	// NoMargin is the margin of a snapshot when no input arrived since the
	// previous one.
	NoMargin = math.MinInt16
)

// Snapshot is the player's own boat as the server last stepped it.
type Snapshot struct {
	Tick int64
	// Seq, Helm and Sheet are the control word in force.
	Seq         uint32
	Helm, Sheet uint16
	// Margin is the lowest arrival margin since the previous snapshot, in
	// ticks, or NoMargin.
	Margin int16
	Wind   bus.Wind
	State  physics.State
}

// PutSnapshot writes a snapshot, its kind byte first, into b, which must
// hold SnapshotSize bytes. It allocates nothing.
func PutSnapshot(b []byte, tick int64, word bus.Word, margin int16, wind bus.Wind, s *physics.State) {
	_ = b[SnapshotSize-1]
	le := binary.LittleEndian
	b[0] = KindSnapshot
	b[1] = SnapshotLayout
	le.PutUint64(b[2:], uint64(tick))
	le.PutUint32(b[10:], word.Seq())
	le.PutUint16(b[14:], uint16(margin))
	le.PutUint16(b[16:], word.HelmIndex())
	le.PutUint16(b[18:], word.SheetIndex())
	le.PutUint64(b[20:], math.Float64bits(wind.Speed))
	le.PutUint64(b[28:], math.Float64bits(wind.From))
	for i, v := range sim.StateFields(s) {
		le.PutUint64(b[36+8*i:], math.Float64bits(*v))
	}
}

// Put writes s as PutSnapshot does.
func (s *Snapshot) Put(b []byte) {
	PutSnapshot(b, s.Tick, bus.Pack(s.Seq, s.Helm, s.Sheet, 0), s.Margin, s.Wind, &s.State)
}

// ReadSnapshot reads a snapshot, its kind byte first.
func ReadSnapshot(b []byte, s *Snapshot) error {
	switch {
	case len(b) == 0:
		return ErrEmpty
	case b[0] != KindSnapshot:
		return ErrKind
	case len(b) < 2:
		return errors.New("protocol: a snapshot cut short")
	case b[1] != SnapshotLayout:
		return fmt.Errorf("protocol: a snapshot of layout %d", b[1])
	case len(b) != SnapshotSize:
		return fmt.Errorf("protocol: a snapshot of %d bytes, not %d", len(b), SnapshotSize)
	}
	le := binary.LittleEndian
	s.Tick = int64(le.Uint64(b[2:]))
	s.Seq = le.Uint32(b[10:])
	s.Margin = int16(le.Uint16(b[14:]))
	s.Helm = le.Uint16(b[16:])
	s.Sheet = le.Uint16(b[18:])
	if s.Helm > bus.Steps || s.Sheet > bus.Steps {
		return fmt.Errorf("protocol: a snapshot's controls %d and %d", s.Helm, s.Sheet)
	}
	s.Wind.Speed = math.Float64frombits(le.Uint64(b[20:]))
	s.Wind.From = math.Float64frombits(le.Uint64(b[28:]))
	for i, v := range sim.StateFields(&s.State) {
		*v = math.Float64frombits(le.Uint64(b[36+8*i:]))
	}
	return nil
}
