// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Where a group is, as a function of its record and world time alone, or
// of its record, world time and the pose of the boat it is with: the same
// on the server, which says what a machine sailor sees and hears, and on
// every phone, which draws each animal about it (client/src/life/flock.ts,
// held to testdata/flocks.json). A group comes in from its range and goes
// out to it, so nothing appears or vanishes near anyone: a group passing
// crosses its centre at the middle of its life; one that soars, works or
// stays comes in along its heading, stays over its centre and goes on;
// one that drifts goes along its heading from its centre as it began, at
// its speed; one with a boat comes in to a place astern of it, or to the
// boat itself for one riding its bow, keeps there, and goes on.

// Pose is a boat as a group with it moves about it: where it is, m east
// and north, and which way it heads, rad clockwise from north.
type Pose struct {
	X, Y, Heading float64
}

// Behind is how far astern of its boat a group that follows it keeps, m,
// by its own seed.
func Behind(seed uint32) float64 { return 15 + float64(20*Own(seed, 2)) }

// Height is how high a group of the kind of its own seed flies, m.
func Height(k *Kind, seed uint32) float64 { return lerp(k.HeightLow, k.HeightHigh, Own(seed, 3)) }

// FlockAt is where a group's middle is at tick t, m east, north and up,
// and whether it is alive then. A group with a boat moves about pose, and
// is nowhere without one.
func FlockAt(e *bus.LifeEncounter, k *Kind, t float64, pose *Pose) (x, y, z float64, ok bool) {
	if t < float64(e.Start) || t >= float64(e.End) {
		return 0, 0, 0, false
	}
	u := (t - float64(e.Start)) / physics.StepsPerSecond
	life := float64(e.End-e.Start) / physics.StepsPerSecond
	v := e.Speed
	a := min(k.Arrive(v), float64(life/2))
	sin, cos := physics.SinCos(e.Heading)
	z = Height(k, e.Seed)
	cx, cy := e.East, e.North
	path := k.PathOf(e)
	if e.Boat != 0 {
		if pose == nil {
			return 0, 0, 0, false
		}
		cx, cy = pose.X, pose.Y
		if !k.Rides() {
			bs, bc := physics.SinCos(pose.Heading)
			b := Behind(e.Seed)
			cx, cy = pose.X-float64(bs*b), pose.Y-float64(bc*b)
		}
	} else if path == PathDrift {
		s := float64(v * u)
		return cx + float64(sin*s), cy + float64(cos*s), z, true
	} else if !lingers(path) {
		// Through: at its centre halfway.
		s := float64(v * (u - float64(life/2)))
		return cx + float64(sin*s), cy + float64(cos*s), z, true
	}
	var s float64
	switch {
	case u < a:
		s = -float64(v * (a - u))
	case u > life-a:
		s = float64(v * (u - (life - a)))
	}
	return cx + float64(sin*s), cy + float64(cos*s), z, true
}
