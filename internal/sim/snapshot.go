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
//	version                 uvarint, SnapshotVersion
//	tick                    varint
//	developer's weathers    uvarint n, then n × the weather below, ascending by the tick each takes effect from
//	next boat ID            uvarint
//	capacity                uvarint
//	admission held          uvarint, 1 if held, else 0
//	generations             uvarint n, then n × (slot, generation) uvarints, slots ascending, none zero
//	boats                   uvarint n, then n × the boat below, slots ascending
//	queue                   uvarint n, then n × the connection waiting below, the head first
//	pairs                   uvarint n, then n × the pair below, by their slots, ascending
//
// A developer's weather is the tick it takes effect from as a varint, then
// its mode, regime, wind speed and direction as uvarints. The spells in
// play and the sea follow from the tick and these, and are not stored.
//
// Each boat is its slot and ID as uvarints, its owner's 16 bytes, its
// connection as a uvarint, the tick its grace ends as a varint, its kind as a
// uvarint, its control word and its pilot word in 8 bytes each, its state's
// fields in 8 bytes each, then its course's, the same; each connection
// waiting is its account's 16
// bytes, the connection as a uvarint, the tick it was queued at and the tick
// its place is given up at (0 while connected) as varints. Each pair is its
// two slots and two boats, its keep-clear boat, Article and whose action as
// uvarints, and the tick its keep-clear boat changed and the tick it last
// touched as varints. The boats' winds and wakes follow from their states,
// and the bumps are events: neither is stored.
//
// A checkpoint stores this snapshot, so a world is restored only by a build
// that reads its version.
const SnapshotVersion = 9

// AppendSnapshot appends f's snapshot to dst.
func AppendSnapshot(dst []byte, f *bus.Frame) []byte {
	dst = binary.AppendUvarint(dst, SnapshotVersion)
	dst = binary.AppendVarint(dst, f.Tick)
	dst = binary.AppendUvarint(dst, uint64(len(f.Weathers)))
	for _, w := range f.Weathers {
		dst = binary.AppendVarint(dst, w.From)
		dst = binary.AppendUvarint(dst, uint64(w.Mode))
		dst = binary.AppendUvarint(dst, uint64(w.Regime))
		dst = binary.AppendUvarint(dst, uint64(w.Speed))
		dst = binary.AppendUvarint(dst, uint64(w.Dir))
	}
	dst = binary.AppendUvarint(dst, f.NextBoat)
	dst = binary.AppendUvarint(dst, uint64(f.Capacity()))
	held := uint64(0)
	if f.Held {
		held = 1
	}
	dst = binary.AppendUvarint(dst, held)
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
		dst = binary.LittleEndian.AppendUint64(dst, uint64(f.Pilot[s]))
		for _, v := range StateFields(&f.State[s]) {
			dst = appendF64(dst, *v)
		}
		for _, v := range CourseFields(&f.Course[s]) {
			dst = appendF64(dst, *v)
		}
	}
	dst = binary.AppendUvarint(dst, uint64(len(f.Queue)))
	for _, q := range f.Queue {
		dst = append(dst, q.Account[:]...)
		dst = binary.AppendUvarint(dst, q.Conn)
		dst = binary.AppendVarint(dst, q.Since)
		dst = binary.AppendVarint(dst, q.Grace)
	}
	dst = binary.AppendUvarint(dst, uint64(len(f.Pairs)))
	for _, p := range f.Pairs {
		dst = binary.AppendUvarint(dst, uint64(p.A))
		dst = binary.AppendUvarint(dst, uint64(p.B))
		dst = binary.AppendUvarint(dst, p.BoatA)
		dst = binary.AppendUvarint(dst, p.BoatB)
		dst = binary.AppendUvarint(dst, uint64(p.Keeper))
		dst = binary.AppendUvarint(dst, uint64(p.Article))
		dst = binary.AppendUvarint(dst, uint64(p.By))
		dst = binary.AppendVarint(dst, p.Since)
		dst = binary.AppendVarint(dst, p.Touched)
	}
	return dst
}

func appendF64(dst []byte, v float64) []byte {
	return binary.LittleEndian.AppendUint64(dst, math.Float64bits(v))
}

// ReadSnapshot sets f, a frame of the snapshot's capacity, to the snapshot's
// state. f's tick inputs are left empty, and its spells in play and its sea
// are the world's to set.
func ReadSnapshot(data []byte, f *bus.Frame) error {
	r := reader{b: data}
	if v := r.uvarint(); r.err == nil && v != SnapshotVersion {
		return fmt.Errorf("sim: snapshot version %d, not %d", v, SnapshotVersion)
	}
	tick := r.varint()
	f.Weathers = f.Weathers[:0]
	n := r.count(bus.WeatherHistory)
	for range n {
		w := bus.Weather{From: r.varint()}
		mode, regime, speed, dir := r.uvarint(), r.uvarint(), r.uvarint(), r.uvarint()
		if r.err != nil {
			return r.err
		}
		if mode > math.MaxUint8 || !bus.WeatherMode(mode).Valid() || regime > math.MaxUint16 || speed > math.MaxUint32 || dir > math.MaxUint32 ||
			len(f.Weathers) > 0 && w.From <= f.Weathers[len(f.Weathers)-1].From {
			return fmt.Errorf("sim: snapshot: a developer's weather of mode %d from tick %d", mode, w.From)
		}
		w.Mode, w.Regime, w.Speed, w.Dir = bus.WeatherMode(mode), uint16(regime), uint32(speed), uint32(dir)
		f.Weathers = append(f.Weathers, w)
	}
	clear(f.Sea.Now)
	clear(f.Sea.Next)
	nextBoat := r.uvarint()
	capacity := r.uvarint()
	held := r.uvarint()
	if r.err != nil {
		return r.err
	}
	if capacity != uint64(f.Capacity()) {
		return fmt.Errorf("sim: a snapshot of %d slots, a frame of %d", capacity, f.Capacity())
	}
	if held > 1 {
		return fmt.Errorf("sim: snapshot: admission held is %d", held)
	}
	f.Tick, f.Skipped = tick, 0
	f.NextBoat = nextBoat
	f.Held = held == 1
	f.Live = f.Live[:0]
	clear(f.Occupied)
	clear(f.Gen)
	f.Changed = f.Changed[:0]
	clear(f.Events)
	f.Events = f.Events[:0]

	n = r.count(capacity)
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
		pilot := bus.PilotWord(r.u64())
		if r.err != nil {
			return r.err
		}
		if int64(s) <= last || s >= capacity || kind > math.MaxUint16 || boat >= nextBoat || grace < 0 {
			return fmt.Errorf("sim: snapshot: boat %d in slot %d", boat, s)
		}
		last = int64(s)
		f.Live = append(f.Live, int32(s))
		f.Occupied[s] = true
		f.Boat[s], f.Owner[s], f.Kind[s], f.Control[s], f.Pilot[s] = boat, owner, uint16(kind), word, pilot
		f.Conn[s], f.Grace[s] = conn, grace
		for _, v := range StateFields(&f.State[s]) {
			*v = r.f64()
		}
		for _, v := range CourseFields(&f.Course[s]) {
			*v = r.f64()
		}
	}
	f.Queue = f.Queue[:0]
	n = r.count(bus.QueueLimit)
	for range n {
		var q bus.Waiting
		r.bytes(q.Account[:])
		q.Conn, q.Since, q.Grace = r.uvarint(), r.varint(), r.varint()
		if r.err == nil && (q.Grace < 0 || q.Conn != 0 && q.Grace != 0) {
			return fmt.Errorf("sim: snapshot: a place in the queue with connection %d and grace %d", q.Conn, q.Grace)
		}
		f.Queue = append(f.Queue, q)
	}
	f.Pairs = f.Pairs[:0]
	f.Bumps = f.Bumps[:0]
	n = r.count(capacity * capacity)
	for range n {
		a, b, boatA, boatB := r.uvarint(), r.uvarint(), r.uvarint(), r.uvarint()
		keeper, article, by := r.uvarint(), r.uvarint(), r.uvarint()
		since, touched := r.varint(), r.varint()
		if r.err != nil {
			return r.err
		}
		ok := a < b && b < capacity && f.Occupied[a] && f.Occupied[b] && f.Boat[a] == boatA && f.Boat[b] == boatB &&
			keeper <= 2 && by <= 2 && article <= math.MaxUint8
		if k := len(f.Pairs); ok && k > 0 {
			last := f.Pairs[k-1]
			ok = uint64(last.A) < a || uint64(last.A) == a && uint64(last.B) < b
		}
		if !ok {
			return fmt.Errorf("sim: snapshot: a pair of slots %d and %d", a, b)
		}
		f.Pairs = append(f.Pairs, bus.Pair{A: int32(a), B: int32(b), BoatA: boatA, BoatB: boatB,
			Keeper: uint8(keeper), Article: uint8(article), By: uint8(by), Since: since, Touched: touched})
	}
	if r.err != nil {
		return r.err
	}
	if len(r.b) > 0 {
		return errors.New("sim: snapshot: data after the pairs")
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
		r.err = fmt.Errorf("sim: snapshot: %d entries, more than its room for %d", n, limit)
	}
	if r.err != nil {
		return 0
	}
	return n
}
