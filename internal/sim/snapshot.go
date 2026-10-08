// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// A snapshot is a frame's whole state as bytes: what an input log starts
// each segment from, and what a checkpoint stores. Integers are varints
// (encoding/binary), floats and control words their little-endian bits:
//
//	version                 uvarint, snapshotVersion
//	tick                    varint
//	wind speed, from        2 × 8 bytes
//	next boat ID            uvarint
//	capacity                uvarint
//	generations             uvarint n, then n × (slot, generation) uvarints, slots ascending, none zero
//	boats                   uvarint n, then n × the boat below, slots ascending
//
// and each boat is its slot and ID as uvarints, its owner's 16 bytes, its
// connection as a uvarint, the tick its grace ends as a varint, its kind as a
// uvarint, its control word in 8 bytes, and its state's fields in 8 bytes
// each.
const snapshotVersion = 2

// AppendSnapshot appends f's snapshot to dst.
func AppendSnapshot(dst []byte, f *bus.Frame) []byte {
	dst = binary.AppendUvarint(dst, snapshotVersion)
	dst = binary.AppendVarint(dst, f.Tick)
	dst = appendF64(dst, f.Wind.Speed)
	dst = appendF64(dst, f.Wind.From)
	dst = binary.AppendUvarint(dst, f.NextBoat)
	dst = binary.AppendUvarint(dst, uint64(f.Capacity()))
	n := 0
	for _, g := range f.Gen {
		if g != 0 {
			n++
		}
	}
	dst = binary.AppendUvarint(dst, uint64(n))
	for s, g := range f.Gen {
		if g != 0 {
			dst = binary.AppendUvarint(dst, uint64(s))
			dst = binary.AppendUvarint(dst, uint64(g))
		}
	}
	dst = binary.AppendUvarint(dst, uint64(len(f.Live)))
	for _, s := range f.Live {
		dst = binary.AppendUvarint(dst, uint64(s))
		dst = binary.AppendUvarint(dst, f.Boat[s])
		dst = append(dst, f.Owner[s][:]...)
		dst = binary.AppendUvarint(dst, f.Conn[s])
		dst = binary.AppendVarint(dst, f.Grace[s])
		dst = binary.AppendUvarint(dst, uint64(f.Kind[s]))
		dst = binary.LittleEndian.AppendUint64(dst, uint64(f.Control[s]))
		for _, v := range StateFields(&f.State[s]) {
			dst = appendF64(dst, *v)
		}
	}
	return dst
}

func appendF64(dst []byte, v float64) []byte {
	return binary.LittleEndian.AppendUint64(dst, math.Float64bits(v))
}

// ReadSnapshot sets f, a frame of the snapshot's capacity, to the snapshot's
// state. f's tick inputs are left empty.
func ReadSnapshot(data []byte, f *bus.Frame) error {
	r := reader{b: data}
	if v := r.uvarint(); r.err == nil && v != snapshotVersion {
		return fmt.Errorf("sim: snapshot version %d, not %d", v, snapshotVersion)
	}
	tick := r.varint()
	speed, from := r.f64(), r.f64()
	nextBoat := r.uvarint()
	capacity := r.uvarint()
	if r.err != nil {
		return r.err
	}
	if capacity != uint64(f.Capacity()) {
		return fmt.Errorf("sim: a snapshot of %d slots, a frame of %d", capacity, f.Capacity())
	}
	f.Tick, f.Skipped = tick, 0
	f.Wind = bus.Wind{Speed: speed, From: from}
	f.NextBoat = nextBoat
	f.Live = f.Live[:0]
	clear(f.Occupied)
	clear(f.Gen)
	f.Changed = f.Changed[:0]
	clear(f.Events)
	f.Events = f.Events[:0]

	n := r.count(capacity)
	last := int64(-1)
	for range n {
		s, g := r.uvarint(), r.uvarint()
		if r.err != nil {
			return r.err
		}
		if int64(s) <= last || s >= capacity || g == 0 || g > bus.GenMask {
			return fmt.Errorf("sim: snapshot: generation %d of slot %d", g, s)
		}
		f.Gen[s] = uint16(g)
		last = int64(s)
	}
	n = r.count(capacity)
	last = -1
	for range n {
		s := r.uvarint()
		boat := r.uvarint()
		var owner bus.Account
		r.bytes(owner[:])
		conn, grace, kind := r.uvarint(), r.varint(), r.uvarint()
		word := bus.Word(r.u64())
		if r.err != nil {
			return r.err
		}
		if int64(s) <= last || s >= capacity || kind > math.MaxUint16 || boat >= nextBoat || grace < 0 {
			return fmt.Errorf("sim: snapshot: boat %d in slot %d", boat, s)
		}
		last = int64(s)
		f.Live = append(f.Live, int32(s))
		f.Occupied[s] = true
		f.Boat[s], f.Owner[s], f.Kind[s], f.Control[s] = boat, owner, uint16(kind), word
		f.Conn[s], f.Grace[s] = conn, grace
		for _, v := range StateFields(&f.State[s]) {
			*v = r.f64()
		}
	}
	if r.err != nil {
		return r.err
	}
	if len(r.b) > 0 {
		return errors.New("sim: snapshot: data after the last boat")
	}
	return nil
}

var errShort = errors.New("sim: snapshot: cut short")

// reader reads a snapshot, keeping the first error.
type reader struct {
	b   []byte
	err error
}

func (r *reader) uvarint() uint64 {
	if r.err != nil {
		return 0
	}
	v, n := binary.Uvarint(r.b)
	if n <= 0 {
		r.err = errShort
		return 0
	}
	r.b = r.b[n:]
	return v
}

func (r *reader) varint() int64 {
	if r.err != nil {
		return 0
	}
	v, n := binary.Varint(r.b)
	if n <= 0 {
		r.err = errShort
		return 0
	}
	r.b = r.b[n:]
	return v
}

func (r *reader) u64() uint64 {
	if r.err != nil {
		return 0
	}
	if len(r.b) < 8 {
		r.err = errShort
		return 0
	}
	v := binary.LittleEndian.Uint64(r.b)
	r.b = r.b[8:]
	return v
}

func (r *reader) f64() float64 { return math.Float64frombits(r.u64()) }

// bytes fills b from the snapshot.
func (r *reader) bytes(b []byte) {
	if r.err != nil {
		return
	}
	if len(r.b) < len(b) {
		r.err = errShort
		return
	}
	copy(b, r.b)
	r.b = r.b[len(b):]
}

// count reads a count of at most limit.
func (r *reader) count(limit uint64) uint64 {
	n := r.uvarint()
	if r.err == nil && n > limit {
		r.err = fmt.Errorf("sim: snapshot: %d entries, more than its %d slots", n, limit)
	}
	if r.err != nil {
		return 0
	}
	return n
}
