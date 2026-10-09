// SPDX-License-Identifier: AGPL-3.0-only

package protocol

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"math/bits"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The other boats a player sees, as shared/protocol/snapshot.txt lays them
// out: a view of up to ViewSlots boats, each quantised to what can be seen,
// sent as entries that change the view of a base snapshot (Fiedler,
// Snapshot Compression, 2015: changed objects only, their changed fields
// only, against a baseline the receiver holds).

// ViewSlots is the most boats a view holds.
const ViewSlots = 64

// A Boat's flags.
const (
	FarBand   = 1 << 0 // the boat is in the far band, sampled less often
	modeShift = 1      // the sailor's mode, in bits 1–2
	flagsUsed = FarBand | 3<<modeShift
)

// The steps of a Boat's fields.
const (
	// AngleStep is the heading's, the heel's, the boom's and the
	// rudder's, in radians: 0.0055°, too fine for a boat drawn between
	// two samples to move in steps. (At π/128, a heel or a boom swinging
	// at 10° a second changed every other sample, and was drawn stopping
	// and starting.)
	AngleStep = 2 * math.Pi / 65536
	// PositionStep and SailorStep are the position's and the sailor
	// offset's, in metres.
	PositionStep = 0.01
	SailorStep   = 0.01
	// PositionLimit is the furthest a position goes from the centre, in
	// steps: a signed 24-bit integer, ±83.9 km.
	PositionLimit = 1<<23 - 1
)

// Boat is a boat in a view, as the wire carries it.
type Boat struct {
	Kind    uint16
	Flags   uint8 // FarBand, and the sailor's mode
	X, Y    int32 // cm, east and north
	Heading uint16
	Heel    int16
	Boom    int16
	Rudder  int16
	Sailor  int8 // cm
	Sail    uint8
}

// Far says whether the boat is in the far band.
func (q *Boat) Far() bool { return q.Flags&FarBand != 0 }

// Mode is the sailor's mode: physics.Sailing, InWater, OnBoard or Climbing.
func (q *Boat) Mode() uint8 { return q.Flags >> modeShift & 3 }

// Quantise sets q to a boat of kind in state st, whose last step's sail
// byte was sail, in the far band or not.
func Quantise(st *physics.State, kind uint16, sail uint8, far bool, q *Boat) {
	q.Kind = kind
	q.Flags = uint8(clampInt(int64(st.SailorMode), 0, 3)) << modeShift
	if far {
		q.Flags |= FarBand
	}
	q.X = int32(steps(st.X/PositionStep, -PositionLimit-1, PositionLimit))
	q.Y = int32(steps(st.Y/PositionStep, -PositionLimit-1, PositionLimit))
	q.Heading = uint16(angleSteps(st.Heading))
	q.Heel = int16(angleSteps(st.Heel))
	q.Boom = int16(angleSteps(st.Boom))
	q.Rudder = int16(angleSteps(st.Rudder))
	q.Sailor = int8(steps(st.Sailor/SailorStep, math.MinInt8, math.MaxInt8))
	q.Sail = sail
}

// steps rounds v to the nearest whole step within lo … hi; NaN is 0.
func steps(v float64, lo, hi int64) int64 {
	if v != v {
		return 0
	}
	return int64(math.Max(float64(lo), math.Min(float64(hi), math.Round(v))))
}

// angleSteps is angle a, wrapped into [−π, π), in whole AngleSteps,
// which the caller's conversion to 16 bits wraps: π, half a turn of
// steps, is −π.
func angleSteps(a float64) int32 {
	if a != a || math.IsInf(a, 0) {
		return 0
	}
	return int32(math.Round(math.Remainder(a, 2*math.Pi) / AngleStep))
}

func clampInt(v, lo, hi int64) int64 { return max(lo, min(hi, v)) }

// View is the boats a player sees after a snapshot: Used has bit i set
// when view slot i holds a boat.
type View struct {
	Used  uint64
	Boats [ViewSlots]Boat
}

// Has says whether slot holds a boat.
func (v *View) Has(slot int) bool { return v.Used&(1<<slot) != 0 }

// Len is the number of boats in the view.
func (v *View) Len() int { return bits.OnesCount64(v.Used) }

// Put puts boat q in slot.
func (v *View) Put(slot int, q *Boat) {
	v.Used |= 1 << slot
	v.Boats[slot] = *q
}

// Remove empties slot.
func (v *View) Remove(slot int) {
	v.Used &^= 1 << slot
	v.Boats[slot] = Boat{}
}

// The entries' ops, in an entry's first byte's top two bits.
const (
	OpUpdate = 0
	OpEnter  = 1
	OpLeave  = 2
)

// An update's change mask: which fields follow.
const (
	ChangePosition = 1 << iota
	ChangeHeading
	ChangeHeel
	ChangeBoom
	ChangeRudder
	ChangeSailor
	ChangeSail
	ChangeFlags
)

// maxEntrySize is the longest entry this package writes: an update of
// every field, its position changes 4 bytes each; or an enter of a kind of
// 3 bytes.
const maxEntrySize = 21

// Entry is one entry of a snapshot.
type Entry struct {
	Slot uint8
	Op   uint8
	// Mask is an update's change mask; DX and DY its position's change, in
	// steps.
	Mask   uint8
	DX, DY int64
	// Boat is an enter's boat, or an update's fields that the mask sets.
	Boat Boat
}

// Changes are what a snapshot's entries did to a view, as masks of view
// slots.
type Changes struct {
	Entered, Updated, Left uint64
}

// Diff is the change mask from base to q.
func Diff(base, q *Boat) uint8 {
	var m uint8
	if q.X != base.X || q.Y != base.Y {
		m |= ChangePosition
	}
	if q.Heading != base.Heading {
		m |= ChangeHeading
	}
	if q.Heel != base.Heel {
		m |= ChangeHeel
	}
	if q.Boom != base.Boom {
		m |= ChangeBoom
	}
	if q.Rudder != base.Rudder {
		m |= ChangeRudder
	}
	if q.Sailor != base.Sailor {
		m |= ChangeSailor
	}
	if q.Sail != base.Sail {
		m |= ChangeSail
	}
	if q.Flags != base.Flags {
		m |= ChangeFlags
	}
	return m
}

// AppendEntries appends the entries that take a view from base to next,
// and returns how many it appended: an enter for each slot in enter, which
// replaces any boat base has there; a leave for each slot base holds and
// next does not; and, for each other slot both hold that sample names, an
// update of what changed, if anything did. A slot neither entered nor
// sampled must hold the same in both. It allocates nothing when b has room
// for MaxSnapshotSize.
func AppendEntries(b []byte, base, next *View, enter, sample uint64) ([]byte, int) {
	n := 0
	for slot := range ViewSlots {
		bit := uint64(1) << slot
		switch {
		case next.Used&bit != 0 && enter&bit != 0:
			b = AppendEntry(b, &Entry{Slot: uint8(slot), Op: OpEnter, Boat: next.Boats[slot]})
		case next.Used&bit != 0 && base.Used&bit != 0 && sample&bit != 0:
			q, p := &next.Boats[slot], &base.Boats[slot]
			m := Diff(p, q)
			if m == 0 {
				continue
			}
			b = AppendEntry(b, &Entry{Slot: uint8(slot), Op: OpUpdate, Mask: m,
				DX: int64(q.X) - int64(p.X), DY: int64(q.Y) - int64(p.Y), Boat: *q})
		case base.Used&bit != 0 && next.Used&bit == 0:
			b = AppendEntry(b, &Entry{Slot: uint8(slot), Op: OpLeave})
		default:
			continue
		}
		n++
	}
	return b, n
}

// AppendEntry appends one entry.
func AppendEntry(b []byte, e *Entry) []byte {
	b = append(b, e.Op<<6|e.Slot&63)
	q := &e.Boat
	switch e.Op {
	case OpEnter:
		b = binary.AppendUvarint(b, uint64(q.Kind))
		b = append(b, q.Flags)
		b = appendInt24(b, q.X)
		b = appendInt24(b, q.Y)
		for _, v := range [...]uint16{q.Heading, uint16(q.Heel), uint16(q.Boom), uint16(q.Rudder)} {
			b = binary.LittleEndian.AppendUint16(b, v)
		}
		b = append(b, byte(q.Sailor), q.Sail)
	case OpUpdate:
		m := e.Mask
		b = append(b, m)
		if m&ChangePosition != 0 {
			b = binary.AppendVarint(b, e.DX)
			b = binary.AppendVarint(b, e.DY)
		}
		for i, v := range [...]uint16{q.Heading, uint16(q.Heel), uint16(q.Boom), uint16(q.Rudder)} {
			if m&(ChangeHeading<<i) != 0 {
				b = binary.LittleEndian.AppendUint16(b, v)
			}
		}
		for i, v := range [...]uint8{uint8(q.Sailor), q.Sail, q.Flags} {
			if m&(ChangeSailor<<i) != 0 {
				b = append(b, v)
			}
		}
	}
	return b
}

func appendInt24(b []byte, v int32) []byte { return append(b, byte(v), byte(v>>8), byte(v>>16)) }

// Errors reading entries.
var (
	ErrEntryShort = errors.New("protocol: an entry cut short")
	errVarint     = errors.New("protocol: a varint written longer than it need be, or too long")
)

// ReadEntry reads the entry at the start of b, and returns the rest. An
// update's Boat holds only the fields its mask sets.
func ReadEntry(b []byte, e *Entry) ([]byte, error) {
	if len(b) == 0 {
		return b, ErrEntryShort
	}
	*e = Entry{Slot: b[0] & 63, Op: b[0] >> 6}
	b = b[1:]
	q := &e.Boat
	switch e.Op {
	case OpLeave:
		return b, nil
	case OpEnter:
		kind, n, err := uvarint(b)
		if err != nil {
			return b, err
		}
		if kind > math.MaxUint16 {
			return b, fmt.Errorf("protocol: a boat of kind %d", kind)
		}
		b = b[n:]
		if len(b) < enterFields {
			return b, ErrEntryShort
		}
		q.Kind = uint16(kind)
		q.Flags = b[0]
		q.X, q.Y = int24(b[1:]), int24(b[4:])
		q.Heading = binary.LittleEndian.Uint16(b[7:])
		q.Heel = int16(binary.LittleEndian.Uint16(b[9:]))
		q.Boom = int16(binary.LittleEndian.Uint16(b[11:]))
		q.Rudder = int16(binary.LittleEndian.Uint16(b[13:]))
		q.Sailor, q.Sail = int8(b[15]), b[16]
		b = b[enterFields:]
	case OpUpdate:
		if len(b) == 0 {
			return b, ErrEntryShort
		}
		m := b[0]
		b = b[1:]
		if m == 0 {
			return b, errors.New("protocol: an update of nothing")
		}
		e.Mask = m
		if m&ChangePosition != 0 {
			for _, d := range [...]*int64{&e.DX, &e.DY} {
				u, n, err := uvarint(b)
				if err != nil {
					return b, err
				}
				*d = int64(u>>1) ^ -int64(u&1)
				b = b[n:]
			}
		}
		for i := range 4 {
			if m&(ChangeHeading<<i) == 0 {
				continue
			}
			if len(b) < 2 {
				return b, ErrEntryShort
			}
			switch v := binary.LittleEndian.Uint16(b); i {
			case 0:
				q.Heading = v
			case 1:
				q.Heel = int16(v)
			case 2:
				q.Boom = int16(v)
			case 3:
				q.Rudder = int16(v)
			}
			b = b[2:]
		}
		for i := range 3 {
			if m&(ChangeSailor<<i) == 0 {
				continue
			}
			if len(b) == 0 {
				return b, ErrEntryShort
			}
			switch v := b[0]; i {
			case 0:
				q.Sailor = int8(v)
			case 1:
				q.Sail = v
			case 2:
				q.Flags = v
			}
			b = b[1:]
		}
	default:
		return b, fmt.Errorf("protocol: an entry of op %d", e.Op)
	}
	if q.Flags&^flagsUsed != 0 {
		return b, fmt.Errorf("protocol: a boat's flags %#02x", q.Flags)
	}
	return b, nil
}

// enterFields is the length of an enter's fields after its kind.
const enterFields = 17

// uvarint reads a uvarint written in as few bytes as it needs, as
// binary.AppendUvarint writes it, and returns it and its length.
func uvarint(b []byte) (uint64, int, error) {
	v, n := binary.Uvarint(b)
	switch {
	case n == 0:
		return 0, 0, ErrEntryShort
	case n < 0 || n > 1 && b[n-1] == 0:
		return 0, 0, errVarint
	}
	return v, n, nil
}

// int24 reads a little-endian signed 24-bit integer.
func int24(b []byte) int32 { return int32(uint32(b[0])<<8|uint32(b[1])<<16|uint32(b[2])<<24) >> 8 }

// Apply applies an entry to the view, and notes what it did in ch.
func (v *View) Apply(e *Entry, ch *Changes) error {
	slot := int(e.Slot)
	bit := uint64(1) << slot
	switch e.Op {
	case OpEnter:
		v.Put(slot, &e.Boat)
		ch.Entered |= bit
		ch.Updated &^= bit
		ch.Left &^= bit
		return nil
	case OpLeave:
		if !v.Has(slot) {
			return fmt.Errorf("protocol: a leave of empty view slot %d", slot)
		}
		v.Remove(slot)
		ch.Left |= bit
		ch.Entered &^= bit
		ch.Updated &^= bit
		return nil
	}
	if !v.Has(slot) {
		return fmt.Errorf("protocol: an update of empty view slot %d", slot)
	}
	q, m := &v.Boats[slot], e.Mask
	if m&ChangePosition != 0 {
		x, y := int64(q.X)+e.DX, int64(q.Y)+e.DY
		if x < -PositionLimit-1 || x > PositionLimit || y < -PositionLimit-1 || y > PositionLimit {
			return fmt.Errorf("protocol: view slot %d moved beyond 24 bits", slot)
		}
		q.X, q.Y = int32(x), int32(y)
	}
	u := &e.Boat
	if m&ChangeHeading != 0 {
		q.Heading = u.Heading
	}
	if m&ChangeHeel != 0 {
		q.Heel = u.Heel
	}
	if m&ChangeBoom != 0 {
		q.Boom = u.Boom
	}
	if m&ChangeRudder != 0 {
		q.Rudder = u.Rudder
	}
	if m&ChangeSailor != 0 {
		q.Sailor = u.Sailor
	}
	if m&ChangeSail != 0 {
		q.Sail = u.Sail
	}
	if m&ChangeFlags != 0 {
		q.Flags = u.Flags
	}
	if ch.Entered&bit == 0 {
		ch.Updated |= bit
	}
	return nil
}

// ApplyEntries applies a snapshot's n entries, the bytes after its
// header, to v, which holds the view of the snapshot's base (empty for
// none), and notes what they did in ch. An error leaves v part changed.
func (v *View) ApplyEntries(b []byte, n int, ch *Changes) error {
	*ch = Changes{}
	var e Entry
	for range n {
		var err error
		if b, err = ReadEntry(b, &e); err != nil {
			return err
		}
		if err := v.Apply(&e, ch); err != nil {
			return err
		}
	}
	if len(b) > 0 {
		return fmt.Errorf("protocol: %d bytes after a snapshot's last entry", len(b))
	}
	return nil
}

// Sampled are the view slots a snapshot samples, given the view after it
// and what its entries did: the boats in the near band, those with an
// entry, and, when the header's flags say so, those in the far band.
func (v *View) Sampled(flags uint8, ch *Changes) uint64 {
	if flags&FarSampled != 0 {
		return v.Used
	}
	s := (ch.Entered | ch.Updated) & v.Used
	for m := v.Used &^ s; m != 0; m &= m - 1 {
		if slot := bits.TrailingZeros64(m); !v.Boats[slot].Far() {
			s |= 1 << slot
		}
	}
	return s
}
