// SPDX-License-Identifier: AGPL-3.0-only

// Package scripted sails boats with no player: sailors that join through the
// bus as a player's connection does, then steer and trim at random, each on
// its own schedule. Tests and benchmarks use them, and a developer's server
// runs them to have a loaded tick to look at.
package scripted

import (
	"container/heap"
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// The defaults: how often a sailor moves the helm or the sheet, and how far.
const (
	MinInterval = 200 * time.Millisecond
	MaxInterval = 3 * time.Second
	helmStep    = 128 // most the helm moves at once, in steps of the control's range
	sheetStep   = 96
)

// Account is scripted sailor i's account: ffffffff-ffff-7fff-bfff- and i in
// the last 48 bits. Players' accounts are UUIDs of version 7, whose first 48
// bits are the time they were made: these would be made in the year 10889.
func Account(i int) bus.Account {
	a := bus.Account{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0xff, 0xbf, 0xff}
	for k := range 6 {
		a[15-k] = byte(uint64(i) >> (8 * k))
	}
	return a
}

// Config sets up scripted sailors.
type Config struct {
	N        int
	Bus      *bus.Bus
	Seed     uint64
	Log      *slog.Logger
	Min, Max time.Duration // between moves; MinInterval and MaxInterval if zero
}

type sailor struct {
	slot        int32
	gen         uint16
	helm, sheet int
	next        time.Time
	rng         *rand.Rand
}

// Run joins cfg.N sailors and sails them until ctx ends. It returns once
// every sailor has joined or been refused and ctx has ended; it never
// leaves their boats, and they have no connection to lose.
func Run(ctx context.Context, cfg Config) error {
	if cfg.Min == 0 {
		cfg.Min = MinInterval
	}
	if cfg.Max == 0 {
		cfg.Max = MaxInterval
	}
	sailors, err := join(ctx, cfg)
	if err != nil {
		return err
	}
	cfg.Log.Info("scripted sailors sailing", "sailors", len(sailors))
	if len(sailors) == 0 {
		<-ctx.Done()
		return nil
	}
	now := time.Now()
	q := make(queue, len(sailors))
	for i := range sailors {
		s := &sailors[i]
		s.next = now.Add(time.Duration(s.rng.Int64N(int64(cfg.Max))))
		q[i] = s
	}
	heap.Init(&q)
	timer := time.NewTimer(time.Until(q[0].next))
	defer timer.Stop()
	controls := cfg.Bus.Controls
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
		}
		now := time.Now()
		// Each word is stamped for the next tick, so it is applied then.
		f := cfg.Bus.Frames.Acquire()
		seq := uint32(f.Tick + 1)
		f.Release()
		for !q[0].next.After(now) {
			s := q[0]
			s.move()
			controls.Store(s.slot, bus.Pack(seq, uint16(s.helm), uint16(s.sheet), s.gen))
			s.next = s.next.Add(cfg.Min + time.Duration(s.rng.Int64N(int64(cfg.Max-cfg.Min))))
			heap.Fix(&q, 0)
		}
		timer.Reset(time.Until(q[0].next))
	}
}

// move takes a step of the sailor's random walk.
func (s *sailor) move() {
	s.helm = clamp(s.helm+s.rng.IntN(2*helmStep+1)-helmStep, 0, bus.Steps)
	s.sheet = clamp(s.sheet+s.rng.IntN(2*sheetStep+1)-sheetStep, 0, bus.Steps)
}

func clamp(v, lo, hi int) int { return max(lo, min(hi, v)) }

// join asks for a boat for each sailor and waits for the answers. A full
// queue is tried again a tick later; a world at its limit leaves the rest
// ashore: a sailor put in the world's queue leaves it, since it has no
// connection to be given a boat through.
func join(ctx context.Context, cfg Config) ([]sailor, error) {
	sender := cfg.Bus.Commands.Players()
	replies := make([]chan bus.Reply, cfg.N)
	for i := range replies {
		replies[i] = make(chan bus.Reply, 1)
		for {
			err := sender.TrySend(bus.Command{Op: bus.Join, Account: Account(i), Reply: replies[i]})
			if err == nil {
				break
			}
			if !errors.Is(err, bus.ErrBusy) {
				return nil, err
			}
			select {
			case <-ctx.Done():
				return nil, nil
			case <-time.After(time.Second / 30):
			}
		}
	}
	sailors := make([]sailor, 0, cfg.N)
	for i, reply := range replies {
		var r bus.Reply
		select {
		case <-ctx.Done():
			return nil, nil
		case r = <-reply:
		}
		if r.Result != bus.Joined && r.Result != bus.Rejoined {
			if r.Result == bus.Queued {
				// Its place in the queue is given up: a full command
				// queue is tried again a tick later.
				for sender.TrySend(bus.Command{Op: bus.Disconnect, Account: Account(i)}) != nil {
					select {
					case <-ctx.Done():
						return nil, nil
					case <-time.After(time.Second / 30):
					}
				}
			}
			cfg.Log.Warn("a scripted sailor found no boat", "sailor", i, "result", r.Result.String())
			continue
		}
		sailors = append(sailors, sailor{
			slot: r.Slot, gen: r.Gen, helm: bus.Steps / 2, sheet: bus.Steps / 2,
			rng: rand.New(rand.NewPCG(cfg.Seed, uint64(i))),
		})
	}
	return sailors, nil
}

// queue orders sailors by when they next move.
type queue []*sailor

func (q queue) Len() int           { return len(q) }
func (q queue) Less(i, j int) bool { return q[i].next.Before(q[j].next) }
func (q queue) Swap(i, j int)      { q[i], q[j] = q[j], q[i] }
func (q *queue) Push(x any)        { *q = append(*q, x.(*sailor)) }
func (q *queue) Pop() any {
	old := *q
	s := old[len(old)-1]
	*q = old[:len(old)-1]
	return s
}
