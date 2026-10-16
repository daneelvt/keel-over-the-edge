// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// Restored is what Restore put back.
type Restored struct {
	// From is the tick of the snapshot restored, and Gap how many ticks the
	// world skipped to reach the present.
	From, Gap int64
	Boats     int // boats restored, every one in its grace
	Waiting   int // places in the queue kept
	// Ashore is how many boats lay on land, as when land was switched on or
	// a world's checkpoint came from open sea: each starts again at the
	// start, since a boat inside an island finds no water to be pushed off
	// into.
	Ashore int
}

// Restore replaces the world with a snapshot taken by an earlier process,
// before the first tick, as the world at tick now: world time resumes at
// the present, and the boats where they were. Nobody is connected to a new
// process, so every boat's and every waiting place's connection becomes
// none: a boat still sailed when the snapshot was taken begins its grace
// now, as does a place in the queue, and a grace already running keeps its
// end, so a sailor's own absence before the restart is not lengthened. A
// Join from the same account within the grace finds its boat, or its
// place. Admission is no longer held: whatever held it was the earlier
// process's. The weather and the sea are what the developer's weathers
// make them at the present. A boat that lies on land starts again at the
// world's start.
func (w *World) Restore(snapshot []byte, now int64) (Restored, error) {
	var r Restored
	err := w.load(snapshot, func(f *bus.Frame) {
		r = Restored{From: f.Tick, Gap: now - f.Tick, Boats: len(f.Live), Waiting: len(f.Queue)}
		f.Tick = now
		f.Held = false
		for _, s := range f.Live {
			f.Conn[s] = 0
			if f.Grace[s] == 0 {
				f.Grace[s] = now + w.grace
			}
		}
		if w.ground != nil {
			for _, s := range f.Live {
				if e, _ := w.ground.At(f.State[s].X, f.State[s].Y); e > 0 {
					f.State[s] = w.spawn(f, s)
					r.Ashore++
				}
			}
		}
		for i := range f.Queue {
			q := &f.Queue[i]
			q.Conn = 0
			if q.Grace == 0 {
				q.Grace = now + w.grace
			}
		}
	})
	return r, err
}
