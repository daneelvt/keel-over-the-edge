// SPDX-License-Identifier: AGPL-3.0-only

// Package scripted sails boats with no player: sailors that join through the
// bus as a player's connection does, then sail on the autopilot at an angle
// to the wind drawn at random, trimming the sheet for the angle and the wind
// and tacking or gybing now and then, each on its own schedule. Tests and
// benchmarks use them, and a developer's server runs them to have a loaded
// tick to look at.
package scripted

import (
	"container/heap"
	"context"
	"errors"
	"log/slog"
	"math"
	"math/rand/v2"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The defaults: how often a sailor trims the sheet, and how often it tacks
// or gybes.
const (
	MinInterval = 200 * time.Millisecond
	MaxInterval = 3 * time.Second
	MinTurn     = time.Minute
	MaxTurn     = 5 * time.Minute
	// The angles to the wind a sailor holds, degrees.
	LeastAngle = 45
	MostAngle  = 160
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
	Min, Max time.Duration // between trims; MinInterval and MaxInterval if zero
	// Between tacks or gybes; MinTurn and MaxTurn if zero.
	MinTurn, MaxTurn time.Duration
}

type sailor struct {
	slot  int32
	gen   uint16
	angle float64 // degrees off the wind, positive on starboard
	// engaged: the autopilot is on, on the tack the boat was on when it
	// was switched on.
	engaged bool
	order   uint8 // the autopilot's order count
	way     uint8 // the latest order's way
	sheet   uint16
	next    time.Time // the next trim
	turn    time.Time // the next tack or gybe
	rng     *rand.Rand
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
	if cfg.MinTurn == 0 {
		cfg.MinTurn = MinTurn
	}
	if cfg.MaxTurn == 0 {
		cfg.MaxTurn = MaxTurn
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
		s.turn = now.Add(cfg.MinTurn + time.Duration(s.rng.Int64N(int64(cfg.MaxTurn-cfg.MinTurn))))
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
		// Each pair of words is stamped for the next tick, so it is applied
		// then.
		f := cfg.Bus.Frames.Acquire()
		seq := uint32(f.Tick + 1)
		for !q[0].due().After(now) {
			s := q[0]
			if !s.turn.After(now) {
				s.tackOrGybe()
				s.turn = s.turn.Add(cfg.MinTurn + time.Duration(s.rng.Int64N(int64(cfg.MaxTurn-cfg.MinTurn))))
			}
			if !s.next.After(now) {
				s.next = s.next.Add(cfg.Min + time.Duration(s.rng.Int64N(int64(cfg.Max-cfg.Min))))
			}
			if f.Occupied[s.slot] && f.Gen[s.slot] == s.gen {
				// The sheet is trimmed for where the boat points now.
				wind := &f.Wind[s.slot]
				now := math.Remainder(wind.MeanFrom-f.State[s.slot].Heading, 2*math.Pi) * 180 / math.Pi
				if !s.engaged {
					s.engaged = true
					s.angle = math.Copysign(s.angle, now)
				}
				s.sheet = SheetIndex(now, wind.WindSpeed)
			}
			controls.Store(s.slot, bus.Pack(seq, bus.Steps/2, s.sheet, s.gen),
				bus.PackPilot(seq, bus.PilotWind, s.way, s.order, Target(s.angle), s.gen))
			heap.Fix(&q, 0)
		}
		f.Release()
		timer.Reset(time.Until(q[0].due()))
	}
}

// due is when the sailor next does something.
func (s *sailor) due() time.Time {
	if s.turn.Before(s.next) {
		return s.turn
	}
	return s.next
}

// tackOrGybe orders the autopilot onto the same angle on the other tack:
// through the wind from forward of the beam, through dead downwind from
// abaft it.
func (s *sailor) tackOrGybe() {
	s.way = bus.WayTack
	if math.Abs(s.angle) > 90 {
		s.way = bus.WayGybe
	}
	s.order++
	s.angle = -s.angle
}

// Target is an angle off the wind, degrees, as the pilot word holds it.
func Target(angle float64) uint16 {
	return uint16(int64(math.Round(angle*physics.TurnSteps/360)) & (physics.TurnSteps - 1))
}

// The sheet a sailor sets at an angle off the wind, degrees, in light air,
// and how much more it eases at each in a breeze, by every 15° from 45°:
// where the boat's polar puts the sheet, and the fixed sheets that keep it
// upright on the autopilot in 19 to 23 knots.
var (
	lightSheet  = [9]float64{0.02, 0.05, 0.12, 0.23, 0.35, 0.50, 0.64, 0.75, 0.78}
	breezeSheet = [9]float64{0.13, 0.15, 0.16, 0.17, 0.12, 0.06, 0.02, 0, 0}
)

// SheetIndex is the sheet a sailor sets for angle degrees off a wind of
// speed m/s, as the control's index: eased more as the wind rises from 8 to
// 19 knots.
func SheetIndex(angle, speed float64) uint16 {
	a := min(max((math.Abs(angle)-LeastAngle)/15, 0), float64(len(lightSheet)-1))
	i := min(int(a), len(lightSheet)-2)
	f := a - float64(i)
	knots := speed * 3600 / 1852
	breeze := min(max((knots-8)/11, 0), 1)
	sheet := lightSheet[i] + f*(lightSheet[i+1]-lightSheet[i]) + breeze*(breezeSheet[i]+f*(breezeSheet[i+1]-breezeSheet[i]))
	return uint16(math.Round(min(max(sheet, 0), 1) * bus.Steps))
}

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
		rng := rand.New(rand.NewPCG(cfg.Seed, uint64(i)))
		angle := LeastAngle + rng.Float64()*(MostAngle-LeastAngle)
		sailors = append(sailors, sailor{slot: r.Slot, gen: r.Gen, angle: angle, sheet: bus.Steps / 2, rng: rng})
	}
	return sailors, nil
}

// queue orders sailors by when they next move.
type queue []*sailor

func (q queue) Len() int           { return len(q) }
func (q queue) Less(i, j int) bool { return q[i].due().Before(q[j].due()) }
func (q queue) Swap(i, j int)      { q[i], q[j] = q[j], q[i] }
func (q *queue) Push(x any)        { *q = append(*q, x.(*sailor)) }
func (q *queue) Pop() any {
	old := *q
	s := old[len(old)-1]
	*q = old[:len(old)-1]
	return s
}
