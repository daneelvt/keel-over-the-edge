// SPDX-License-Identifier: AGPL-3.0-only

package committee

import (
	"encoding/binary"
	"errors"
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A boat's track in a race: where it was every TrackEvery ticks from its
// race's warning signal (or a trial's placing) until it finished or left
// the race, small enough to keep every race of a world. The coding:
//
//	version   uvarint, TrackVersion
//	first     varint, the tick of the first sample
//	every     uvarint, the ticks between samples
//	samples   one after another, each its change from the one before
//	          (the first's from zero): east and north in decimetres, the
//	          heading in 256ths of a turn (the change taken the short way,
//	          −128 to 127), the speed ahead in tenths of a metre a second,
//	          each a zigzag varint
//
// A boat sailing 4 m/s moves 80 dm in two seconds: a sample is about six
// bytes.

// TrackVersion is the tracks' coding's version.
const TrackVersion = 1

// Sample is a track's sample: the tick, where the boat was, m east and
// north, its heading, rad clockwise from north, and its speed ahead, m/s.
type Sample struct {
	Tick                int64
	East, North         float64
	Heading, SpeedAhead float64
}

// sample adds the boat's state st at tick to racer rc's track.
func sample(rc *bus.Racer, st *physics.State, tick int64) {
	x := toInt32(round(float64(st.X * 10)))
	y := toInt32(round(float64(st.Y * 10)))
	h := toInt32(round(float64(wrapTurn(st.Heading)*(256/(2*math.Pi))))) & 0xff
	v := toInt32(round(float64(max(st.Surge, 0) * 10)))
	t := rc.Track
	if len(t) == 0 {
		t = binary.AppendUvarint(t, TrackVersion)
		t = binary.AppendVarint(t, tick)
		t = binary.AppendUvarint(t, TrackEvery)
		rc.SX, rc.SY, rc.SH, rc.SV = 0, 0, 0, 0
	}
	dh := int8(uint8(h - rc.SH))
	t = binary.AppendVarint(t, int64(x-rc.SX))
	t = binary.AppendVarint(t, int64(y-rc.SY))
	t = binary.AppendVarint(t, int64(dh))
	t = binary.AppendVarint(t, int64(v-rc.SV))
	rc.Track = t
	rc.SX, rc.SY, rc.SH, rc.SV, rc.Sampled = x, y, h, v, tick
}

// wrapTurn is an angle in [0, 2π).
func wrapTurn(a float64) float64 {
	a = wrap(a)
	if a < 0 {
		a += 2 * math.Pi
	}
	return a
}

// ErrTrack is a track that cannot be read.
var ErrTrack = errors.New("committee: a track that cannot be read")

// Samples reads a coded track.
func Samples(track []byte) ([]Sample, error) {
	if len(track) == 0 {
		return nil, nil
	}
	b := track
	next := func() (int64, bool) {
		v, n := binary.Varint(b)
		if n <= 0 {
			return 0, false
		}
		b = b[n:]
		return v, true
	}
	version, n := binary.Uvarint(b)
	if n <= 0 || version != TrackVersion {
		return nil, ErrTrack
	}
	b = b[n:]
	tick, ok := next()
	if !ok {
		return nil, ErrTrack
	}
	every, n := binary.Uvarint(b)
	if n <= 0 || every == 0 {
		return nil, ErrTrack
	}
	b = b[n:]
	var out []Sample
	var x, y, h, v int64
	for len(b) > 0 {
		var d [4]int64
		for i := range d {
			if d[i], ok = next(); !ok {
				return nil, ErrTrack
			}
		}
		x, y, h, v = x+d[0], y+d[1], (h+d[2])&0xff, v+d[3]
		out = append(out, Sample{Tick: tick, East: float64(x) / 10, North: float64(y) / 10,
			Heading: float64(h) * (2 * math.Pi / 256), SpeedAhead: float64(v) / 10})
		tick += int64(every)
	}
	return out, nil
}
