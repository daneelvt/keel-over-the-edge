// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"math"
	"sort"
)

// The client's clock and how far it runs ahead, as client/src/net/clock.ts
// has them; the traces this package records check that the two agree.
// Times are microseconds, as float64s holding whole numbers, so both
// languages compute the same bits.
const (
	ClockSamples = 32      // the samples kept
	ClockBest    = 8       // the lowest round trips the offset is the median of
	SlewRate     = 0.01    // the most the offset moves: 1 ms per 100 ms
	SetBeyond    = 250_000 // an offset further than this is set at once
)

type sample struct{ rtt, offset float64 }

// Clock estimates world time from Pongs: each gives an offset, the
// server's world time plus half the round trip less the client's own
// time. The estimate is the median offset of the samples with the lowest
// round trips (Cristian's algorithm, kept robust to slow samples); the
// clock moves toward it slowly, so world time never jumps, unless it is
// far off.
type Clock struct {
	Have bool
	// Rough: the offset came from a Welcome alone, which cannot tell the
	// time it took to arrive; the first Pong sets the clock at once.
	Rough bool
	// Offset is the offset in force at At; Target the estimate it moves
	// toward.
	Offset, Target, At float64
	// RTT is the round trip's estimate: the median of the best samples.
	RTT     float64
	samples []sample // oldest first
}

// Applied is the offset in force at now.
func (c *Clock) Applied(now float64) float64 {
	d := c.Target - c.Offset
	if math.Abs(d) > SetBeyond {
		return c.Target
	}
	step := (now - c.At) * SlewRate
	switch {
	case d > step:
		return c.Offset + step
	case d < -step:
		return c.Offset - step
	}
	return c.Target
}

// WorldUs is world time at now, in microseconds since the epoch.
func (c *Clock) WorldUs(now float64) float64 { return now + c.Applied(now) }

// Welcome sets the clock from a Welcome's world time, if it has none yet.
func (c *Clock) Welcome(world, now float64) {
	if c.Have {
		return
	}
	c.Offset, c.Target, c.At, c.Have, c.Rough = world-now, world-now, now, true, true
}

// Sample adds a Pong: sent is the Ping's client time, world the server's.
func (c *Clock) Sample(sent, world, now float64) {
	rtt := now - sent
	c.samples = append(c.samples, sample{rtt: rtt, offset: world + rtt/2 - now})
	if len(c.samples) > ClockSamples {
		c.samples = c.samples[1:]
	}
	best := append([]sample(nil), c.samples...)
	sort.SliceStable(best, func(i, j int) bool { return best[i].rtt < best[j].rtt })
	best = best[:min(ClockBest, len(best))]
	offsets := make([]float64, len(best))
	rtts := make([]float64, len(best))
	for i, s := range best {
		offsets[i], rtts[i] = s.offset, s.rtt
	}
	target := median(offsets)
	if c.Have && !c.Rough {
		c.Offset = c.Applied(now)
	} else {
		c.Offset, c.Have, c.Rough = target, true, false
	}
	c.At, c.Target, c.RTT = now, target, median(rtts)
}

func median(v []float64) float64 {
	sort.Float64s(v)
	n := len(v)
	if n%2 == 1 {
		return v[n/2]
	}
	return (v[n/2-1] + v[n/2]) / 2
}

// How far ahead of the server the client steps its boat, in ticks.
const (
	AheadStart     = 2
	AheadMin       = 1
	AheadMax       = 30
	AheadGood      = 3         // a margin this or more is room to spare
	AheadSettle    = 5_000_000 // µs of spare margins before stepping one tick less ahead
	TicksPerSecond = 30
	// Behind is how far behind its target the boat may fall before it is
	// put back to the server's latest state.
	Behind = 30
	// MaxSteps is the most steps a frame takes: as many as Behind. Online a
	// boat that fell behind could never catch up, so a slow frame takes all
	// the steps due; a step costs microseconds.
	MaxSteps = Behind
)

// AheadHold is how long after a raise, beyond a round trip, further late
// margins are let be: they are of inputs sent before the raise took effect.
const AheadHold = 100_000

// Ahead is m, the margin the client runs ahead by, tuned from the arrival
// margins the server reports: a late input raises it at once, and five
// seconds of margins to spare lower it by one.
type Ahead struct {
	M    int
	good float64 // when margins began to be to spare, or −1
	hold float64 // until when late margins are let be
}

// NewAhead starts at AheadStart.
func NewAhead() Ahead { return Ahead{M: AheadStart, good: -1} }

// Margin takes a snapshot's margin, at now with the round trip rtt;
// protocol.NoMargin is not one. A late input raises m once a round trip:
// the margins of inputs sent before a raise took effect say nothing new.
func (a *Ahead) Margin(margin int, now, rtt float64) {
	switch {
	case margin == math.MinInt16:
	case margin < 0:
		if now >= a.hold {
			a.M = min(AheadMax, a.M-margin+1)
			a.hold = now + rtt + AheadHold
		}
		a.good = -1
	case margin < AheadGood:
		a.good = -1
	case a.good < 0:
		a.good = now
	case now-a.good >= AheadSettle:
		a.M = max(AheadMin, a.M-1)
		a.good = now
	}
}

// Target is the tick to have stepped to at world time worldUs: the tick
// due when an input sent now arrives, half a round trip on, and m more.
func Target(worldUs, rttUs float64, m int) int64 {
	return int64(math.Ceil((worldUs+rttUs/2)*TicksPerSecond/1e6)) + int64(m)
}
