// SPDX-License-Identifier: AGPL-3.0-only

package committee

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// The races in a snapshot, after the world's pairs. Integers are varints
// (encoding/binary), floats their little-endian bits in 8 bytes:
//
//	next race's key   uvarint
//	races             uvarint n, then n × the race below, by key
//	racers            uvarint n, then n × the boat below, by race, then number
//
// A race is its key as a uvarint, its ID's 16 bytes, its run as a varint,
// a uvarint of flags (1: a trial, 2: a long course, 4: with prizes), its
// boat's kind as a uvarint, the ticks of its warning and start as varints,
// its phase as a uvarint, the ticks its first boat came home, its window
// closes and it ended as varints, then its course: a uvarint of flags (1:
// an island course, 2: a triangle), its number as a varint, its laps as a
// uvarint, its wind's speed and direction, its place and reach, the start
// line's ends and the finish line's as floats; its marks, a uvarint n
// then each one's place as floats and its number and side as varints;
// its checks, a uvarint n then each one's flags (1: a line) as a uvarint,
// its six coordinates as floats, its wanted crossings and its mark as
// varints and its place along the way and the way's point there as
// floats; its way, a uvarint n then each point as floats; and its length
// and expected time as floats.
//
// A boat is its race's key as a uvarint, its skipper's 16 bytes, its
// number as a varint, a uvarint of flags (1: a machine sailor's, 2: with
// its crew, 4: over early), its slot as a varint, its boat as a uvarint,
// its state as a uvarint, its next check and its crossings of it as
// varints, the ticks it crossed the start line and came home and the
// ticks added as varints, its way to go and the least of it as floats,
// the ticks of that least and of its asking as varints, its place at the
// first mark and its place as varints, its medal, awards and cheers as
// uvarints, its track as a uvarint length and its bytes, and the tick of
// its last sample and that sample as varints.

// The flags of a race, a course, a check and a boat in a snapshot.
const (
	raceTrial  = 1
	raceLong   = 2
	racePrizes = 4

	courseIsland   = 1
	courseTriangle = 2

	checkLine = 1

	racerMachine = 1
	racerCrew    = 2
	racerOver    = 4
)

// The most a snapshot's races hold.
const (
	mostRaces  = 4096
	mostRacers = 1 << 16
	mostMarks  = 16
	mostWay    = 1 << 14
	mostTrack  = 1 << 24
)

// AppendSnapshot appends f's races to dst.
func AppendSnapshot(dst []byte, f *bus.Frame) []byte {
	dst = binary.AppendUvarint(dst, uint64(f.NextRace))
	dst = binary.AppendUvarint(dst, uint64(len(f.Races)))
	for i := range f.Races {
		dst = appendRace(dst, &f.Races[i])
	}
	dst = binary.AppendUvarint(dst, uint64(len(f.Racers)))
	for i := range f.Racers {
		dst = appendRacer(dst, &f.Racers[i])
	}
	return dst
}

func appendRace(dst []byte, r *bus.Race) []byte {
	dst = binary.AppendUvarint(dst, uint64(r.Key))
	dst = append(dst, r.ID[:]...)
	dst = binary.AppendVarint(dst, int64(r.Run))
	var flags uint64
	if r.Trial {
		flags |= raceTrial
	}
	if r.Long {
		flags |= raceLong
	}
	if r.Prizes {
		flags |= racePrizes
	}
	dst = binary.AppendUvarint(dst, flags)
	dst = binary.AppendUvarint(dst, uint64(r.Kind))
	dst = binary.AppendVarint(dst, r.Warning)
	dst = binary.AppendVarint(dst, r.Start)
	dst = binary.AppendUvarint(dst, uint64(r.Phase))
	dst = binary.AppendVarint(dst, r.Home)
	dst = binary.AppendVarint(dst, r.Closes)
	dst = binary.AppendVarint(dst, r.Ended)
	return appendCourse(dst, r.Course)
}

func appendCourse(dst []byte, c *bus.RaceCourse) []byte {
	var flags uint64
	if c.Island {
		flags |= courseIsland
	}
	if c.Triangle {
		flags |= courseTriangle
	}
	dst = binary.AppendUvarint(dst, flags)
	dst = binary.AppendVarint(dst, int64(c.Number))
	dst = binary.AppendUvarint(dst, uint64(c.Laps))
	for _, v := range [...]float64{c.Wind, c.From, c.X, c.Y, c.Reach, c.Committee[0], c.Committee[1], c.Pin[0], c.Pin[1],
		c.FinishA[0], c.FinishA[1], c.FinishB[0], c.FinishB[1]} {
		dst = appendF64(dst, v)
	}
	dst = binary.AppendUvarint(dst, uint64(len(c.Marks)))
	for _, m := range c.Marks {
		dst = appendF64(appendF64(dst, m.X), m.Y)
		dst = binary.AppendVarint(dst, int64(m.Number))
		dst = binary.AppendVarint(dst, int64(m.Side))
	}
	dst = binary.AppendUvarint(dst, uint64(len(c.Checks)))
	for i := range c.Checks {
		ch := &c.Checks[i]
		var cf uint64
		if ch.Line {
			cf |= checkLine
		}
		dst = binary.AppendUvarint(dst, cf)
		for _, v := range [...]float64{ch.X, ch.Y, ch.S, ch.C, ch.X2, ch.Y2} {
			dst = appendF64(dst, v)
		}
		dst = binary.AppendVarint(dst, int64(ch.Want))
		dst = binary.AppendVarint(dst, int64(ch.Mark))
		dst = appendF64(appendF64(appendF64(dst, ch.Along), ch.AtX), ch.AtY)
	}
	dst = binary.AppendUvarint(dst, uint64(len(c.Way)))
	for _, p := range c.Way {
		dst = appendF64(appendF64(dst, p[0]), p[1])
	}
	return appendF64(appendF64(dst, c.Length), c.Expected)
}

func appendRacer(dst []byte, rc *bus.Racer) []byte {
	dst = binary.AppendUvarint(dst, uint64(rc.Race))
	dst = append(dst, rc.Account[:]...)
	dst = binary.AppendVarint(dst, int64(rc.Number))
	var flags uint64
	if rc.Machine {
		flags |= racerMachine
	}
	if rc.Crew {
		flags |= racerCrew
	}
	if rc.Over {
		flags |= racerOver
	}
	dst = binary.AppendUvarint(dst, flags)
	dst = binary.AppendVarint(dst, int64(rc.Slot))
	dst = binary.AppendUvarint(dst, rc.Boat)
	dst = binary.AppendUvarint(dst, uint64(rc.State))
	dst = binary.AppendVarint(dst, int64(rc.Next))
	dst = binary.AppendVarint(dst, int64(rc.Net))
	dst = binary.AppendVarint(dst, rc.Crossed)
	dst = binary.AppendVarint(dst, rc.Home)
	dst = binary.AppendVarint(dst, rc.Added)
	dst = appendF64(appendF64(dst, rc.ToGo), rc.Least)
	dst = binary.AppendVarint(dst, rc.LeastAt)
	dst = binary.AppendVarint(dst, rc.Asked)
	dst = binary.AppendVarint(dst, int64(rc.First))
	dst = binary.AppendVarint(dst, int64(rc.Place))
	dst = binary.AppendUvarint(dst, uint64(rc.Medal))
	dst = binary.AppendUvarint(dst, uint64(rc.Awards))
	dst = binary.AppendUvarint(dst, uint64(rc.Cheers))
	dst = binary.AppendUvarint(dst, uint64(len(rc.Track)))
	dst = append(dst, rc.Track...)
	dst = binary.AppendVarint(dst, rc.Sampled)
	for _, v := range [...]int32{rc.SX, rc.SY, rc.SH, rc.SV} {
		dst = binary.AppendVarint(dst, int64(v))
	}
	return dst
}

func appendF64(dst []byte, v float64) []byte {
	return binary.LittleEndian.AppendUint64(dst, math.Float64bits(v))
}

var errShort = errors.New("committee: snapshot: cut short")

// ReadSnapshot reads the races a snapshot holds at the head of b into f,
// a frame of capacity slots, and returns what follows them.
func ReadSnapshot(b []byte, f *bus.Frame) ([]byte, error) {
	r := reader{b: b}
	next := r.uvarint()
	if r.err == nil && next > math.MaxUint32 {
		r.err = fmt.Errorf("committee: snapshot: the next race's key %d", next)
	}
	f.NextRace = uint32(next)
	f.Races = f.Races[:0]
	f.Racers = f.Racers[:0]
	f.RaceEvents = f.RaceEvents[:0]
	n := r.count(mostRaces)
	for range n {
		var race bus.Race
		r.race(&race)
		if r.err != nil {
			return nil, r.err
		}
		if k := len(f.Races); k > 0 && f.Races[k-1].Key >= race.Key || race.Key == 0 || race.Key >= f.NextRace {
			return nil, fmt.Errorf("committee: snapshot: a race of key %d", race.Key)
		}
		f.Races = append(f.Races, race)
	}
	n = r.count(mostRacers)
	for range n {
		var rc bus.Racer
		r.racer(&rc)
		if r.err != nil {
			return nil, r.err
		}
		ok := slices.ContainsFunc(f.Races, func(x bus.Race) bool { return x.Key == rc.Race }) &&
			rc.State >= bus.RacerDNS && rc.State <= bus.RacerPlacedAtEnd &&
			(rc.State == bus.RacerDNS || rc.Slot >= 0 && int(rc.Slot) < f.Capacity())
		if k := len(f.Racers); ok && k > 0 {
			last := &f.Racers[k-1]
			ok = last.Race < rc.Race || last.Race == rc.Race && last.Number < rc.Number
		}
		if !ok {
			return nil, fmt.Errorf("committee: snapshot: boat %d of race %d", rc.Number, rc.Race)
		}
		f.Racers = append(f.Racers, rc)
	}
	return r.b, r.err
}

func (r *reader) race(race *bus.Race) {
	race.Key = uint32(r.limited(math.MaxUint32))
	r.bytes(race.ID[:])
	race.Run = int32(r.varint())
	flags := r.uvarint()
	race.Trial, race.Long, race.Prizes = flags&raceTrial != 0, flags&raceLong != 0, flags&racePrizes != 0
	race.Kind = uint16(r.limited(math.MaxUint16))
	race.Warning, race.Start = r.varint(), r.varint()
	phase := r.uvarint()
	race.Home, race.Closes, race.Ended = r.varint(), r.varint(), r.varint()
	if r.err == nil && (flags&^(raceTrial|raceLong|racePrizes) != 0 || phase < uint64(bus.RaceWarning) || phase > uint64(bus.RaceEnded)) {
		r.err = fmt.Errorf("committee: snapshot: a race in phase %d with flags %d", phase, flags)
	}
	race.Phase = uint8(phase)
	race.Course = r.course()
}

func (r *reader) course() *bus.RaceCourse {
	c := &bus.RaceCourse{}
	flags := r.uvarint()
	c.Island, c.Triangle = flags&courseIsland != 0, flags&courseTriangle != 0
	c.Number = int32(r.varint())
	c.Laps = int32(r.limited(math.MaxInt32))
	for _, v := range [...]*float64{&c.Wind, &c.From, &c.X, &c.Y, &c.Reach, &c.Committee[0], &c.Committee[1], &c.Pin[0], &c.Pin[1],
		&c.FinishA[0], &c.FinishA[1], &c.FinishB[0], &c.FinishB[1]} {
		*v = r.f64()
	}
	n := r.count(mostMarks)
	for range n {
		m := bus.RaceMark{X: r.f64(), Y: r.f64()}
		m.Number, m.Side = int16(r.varint()), int8(r.varint())
		c.Marks = append(c.Marks, m)
	}
	n = r.count(bus.RaceSlots)
	for range n {
		var ch bus.RaceCheck
		ch.Line = r.uvarint()&checkLine != 0
		for _, v := range [...]*float64{&ch.X, &ch.Y, &ch.S, &ch.C, &ch.X2, &ch.Y2} {
			*v = r.f64()
		}
		ch.Want, ch.Mark = int8(r.varint()), int16(r.varint())
		ch.Along, ch.AtX, ch.AtY = r.f64(), r.f64(), r.f64()
		c.Checks = append(c.Checks, ch)
	}
	n = r.count(mostWay)
	for range n {
		c.Way = append(c.Way, [2]float64{r.f64(), r.f64()})
	}
	c.Length, c.Expected = r.f64(), r.f64()
	if r.err == nil && (flags&^(courseIsland|courseTriangle) != 0 || len(c.Checks) < 2 || len(c.Way) < 2) {
		r.err = fmt.Errorf("committee: snapshot: a course of %d checks and flags %d", len(c.Checks), flags)
	}
	return c
}

func (r *reader) racer(rc *bus.Racer) {
	rc.Race = uint32(r.limited(math.MaxUint32))
	r.bytes(rc.Account[:])
	rc.Number = int16(r.varint())
	flags := r.uvarint()
	rc.Machine, rc.Crew, rc.Over = flags&racerMachine != 0, flags&racerCrew != 0, flags&racerOver != 0
	rc.Slot = int32(r.varint())
	rc.Boat = r.uvarint()
	rc.State = uint8(r.limited(math.MaxUint8))
	rc.Next, rc.Net = int16(r.varint()), int8(r.varint())
	rc.Crossed, rc.Home, rc.Added = r.varint(), r.varint(), r.varint()
	rc.ToGo, rc.Least = r.f64(), r.f64()
	rc.LeastAt, rc.Asked = r.varint(), r.varint()
	rc.First, rc.Place = int16(r.varint()), int16(r.varint())
	rc.Medal = uint8(r.limited(math.MaxUint8))
	rc.Awards = uint8(r.limited(math.MaxUint8))
	rc.Cheers = uint32(r.limited(math.MaxUint32))
	n := r.count(mostTrack)
	if n > 0 {
		rc.Track = make([]byte, n)
		r.bytes(rc.Track)
	}
	rc.Sampled = r.varint()
	for _, v := range [...]*int32{&rc.SX, &rc.SY, &rc.SH, &rc.SV} {
		*v = int32(r.varint())
	}
	if r.err == nil && flags&^(racerMachine|racerCrew|racerOver) != 0 {
		r.err = fmt.Errorf("committee: snapshot: a boat with flags %d", flags)
	}
}

// reader reads a snapshot's races, keeping the first error.
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

func (r *reader) f64() float64 {
	if r.err != nil {
		return 0
	}
	if len(r.b) < 8 {
		r.err = errShort
		return 0
	}
	v := binary.LittleEndian.Uint64(r.b)
	r.b = r.b[8:]
	return math.Float64frombits(v)
}

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

// limited reads a uvarint of at most most.
func (r *reader) limited(most uint64) uint64 {
	v := r.uvarint()
	if r.err == nil && v > most {
		r.err = fmt.Errorf("committee: snapshot: %d, more than %d", v, most)
	}
	return v
}

// count reads a count of at most most.
func (r *reader) count(most uint64) uint64 {
	n := r.limited(most)
	if r.err != nil {
		return 0
	}
	return n
}
