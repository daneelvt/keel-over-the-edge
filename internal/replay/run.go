// SPDX-License-Identifier: AGPL-3.0-only

package replay

import (
	"bytes"
	"errors"
	"fmt"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

// Options set up a replay.
type Options struct {
	Kinds   []physics.Prepared // the world's kinds of boat
	Workers int                // goroutines stepping boats; the result never depends on it
	// At, if not nil, is called with the world's frame after each tick
	// replayed, and after each snapshot loaded.
	At func(*bus.Frame)
}

// Result is what a replay found.
type Result struct {
	From, To  int64 // the first tick's world and the last tick replayed
	Digests   int   // digests compared
	Snapshots int   // snapshots compared, after the first
	Diverged  *Divergence
}

// Ticks is the number of ticks replayed.
func (r *Result) Ticks() int64 { return r.To - r.From }

// A Divergence is the first point at which the replay differed from the log.
type Divergence struct {
	Tick int64
	What string
}

func (d *Divergence) Error() string { return fmt.Sprintf("tick %d: %s", d.Tick, d.What) }

// Run replays a log from its first segment's snapshot, through sim's own
// Tick with the inputs the log recorded, comparing every digest, every
// later segment's snapshot and every command's result with the log's. It
// stops at the first difference. A broken segment is replayed up to its
// break, and the replay resumes from the next segment's snapshot.
func Run(f *File, opt Options) (Result, error) {
	var res Result
	if len(f.Segments) == 0 {
		return res, errors.New("replay: the log has no segment")
	}
	w, err := sim.New(sim.Config{Capacity: f.Header.Capacity, Kinds: opt.Kinds, Workers: opt.Workers})
	if err != nil {
		return res, err
	}
	defer w.Close()
	r := &runner{w: w, at: opt.At, res: &res}
	res.From = f.Segments[0].Tick
	res.To = res.From
	broken := true // load the first snapshot
	for i := range f.Segments {
		seg := &f.Segments[i]
		if broken {
			if err := w.Load(seg.Snapshot); err != nil {
				return res, fmt.Errorf("replay: segment at tick %d: %w", seg.Tick, err)
			}
			if w.Now() != seg.Tick {
				return res, fmt.Errorf("replay: the snapshot of tick %d is of tick %d", seg.Tick, w.Now())
			}
			r.observe()
		} else {
			if err := r.advance(seg.Tick); err != nil {
				return res, err
			}
			res.Snapshots++
			if !bytes.Equal(sim.AppendSnapshot(nil, w.Latest()), seg.Snapshot) {
				res.Diverged = &Divergence{Tick: seg.Tick, What: "the world differs from the log's snapshot"}
				return res, nil
			}
		}
		for j := range seg.Records {
			rec := &seg.Records[j]
			if seg.BrokenAt >= 0 && rec.Tick >= seg.BrokenAt {
				break
			}
			if err := r.record(rec); err != nil {
				return res, err
			}
			if res.Diverged != nil {
				return res, nil
			}
		}
		broken = seg.BrokenAt >= 0
	}
	return res, nil
}

type runner struct {
	w   *sim.World
	at  func(*bus.Frame)
	res *Result
}

func (r *runner) observe() {
	r.res.To = r.w.Now()
	if r.at != nil {
		r.at(r.w.Latest())
	}
}

// advance runs ticks with no inputs until the world is at tick.
func (r *runner) advance(tick int64) error {
	if r.w.Now() > tick {
		return fmt.Errorf("replay: the log goes back from tick %d to %d", r.w.Now(), tick)
	}
	empty := &sim.Input{}
	for r.w.Now() < tick {
		r.w.TickWith(empty)
		r.observe()
	}
	return nil
}

func (r *runner) record(rec *Record) error {
	switch rec.Kind {
	case kindTick:
		if err := r.advance(rec.Tick - 1 - rec.Skipped); err != nil {
			return err
		}
		r.w.Skip(rec.Skipped)
		r.w.TickWith(&sim.Input{Changed: rec.Changed, Commands: rec.Commands()})
		r.observe()
		f := r.w.Latest()
		if f.Tick != rec.Tick {
			return fmt.Errorf("replay: a tick record for tick %d replayed as tick %d", rec.Tick, f.Tick)
		}
		if len(f.Changed) != len(rec.Changed) || len(f.Events) != len(rec.Events) {
			r.res.Diverged = &Divergence{Tick: rec.Tick, What: fmt.Sprintf("%d control words and %d commands applied, the log has %d and %d",
				len(f.Changed), len(f.Events), len(rec.Changed), len(rec.Events))}
			return nil
		}
		for i := range rec.Events {
			if got, want := f.Events[i].Reply, rec.Events[i].Reply; got != want {
				r.res.Diverged = &Divergence{Tick: rec.Tick, What: fmt.Sprintf("%s gave %+v, the log has %+v", rec.Events[i].Op, got, want)}
				return nil
			}
		}
	case kindDigest:
		if err := r.advance(rec.Tick); err != nil {
			return err
		}
		r.res.Digests++
		if got := sim.Digest(r.w.Latest()); got != rec.Digest {
			r.res.Diverged = &Divergence{Tick: rec.Tick, What: fmt.Sprintf("digest %016x, the log has %016x", got, rec.Digest)}
		}
	}
	return nil
}
