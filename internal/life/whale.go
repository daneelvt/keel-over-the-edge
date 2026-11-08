// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A whale is seen by its blows. Each whale of a group keeps a round of its
// own, drawn from the group's seed and its number in it, the same on the
// server, which says what a machine sailor sees and hears, and on every
// phone, which draws it (client/src/life/whale.ts, held to
// testdata/whales.json): down for one of its kind's dives, then up at the
// surface for a bout of its kind's breaths, a blow at each, its kind's
// blowEvery apart, and down again, raising its flukes on its kind's share
// of its dives. In a share of its bouts it breaches between two blows, or
// slaps the water with its tail. A humpback blows every half minute or so
// and dives for minutes; a sperm whale that drifts is met for its one long
// bout at the surface, about 9 min blowing about five times a minute,
// before it flukes up and is gone for about 45 min (Watwood and others
// 2006).

// The events of a whale's round.
const (
	WhaleBlow   = iota // it blows: the head clear, the spout up
	WhaleBreach        // it falls back from a breach: the boom and the splash
	WhaleSlap          // its tail hits the water
	WhaleFluke         // it dives, its flukes raised (on its kind's share of dives)
)

// The parts of a whale's round, s.
const (
	// WhaleUp is how long before its first blow a whale's head comes up
	// from its dive, and WhaleDive how long its dive from the surface
	// takes, flukes raised or not.
	WhaleUp   = 6.0
	WhaleDive = 8.0
	// WhaleBreachTime is a breach from its start to its fall back: up from
	// under, two thirds out of the water, and over on its side; WhaleFall
	// is when it hits the water again. A slap is a WhaleSlapTime turn of
	// the tail up and down, hitting at its middle.
	WhaleBreachTime = 7.0
	WhaleFall       = 4.4
	WhaleSlapTime   = 4.0
	// whaleLeave is how long before a drifting whale's end its dive ends.
	whaleLeave = 6.0
)

// Bout is where a whale is in its round: its bout's start, s into the
// group's life, its blows and their gap, s; whether it breaches or slaps
// and when, s into its life (−1 for neither); and whether the dive that
// ends the bout raises its flukes.
type Bout struct {
	Start  float64
	Blows  int32
	Every  float64
	Breach float64
	Slap   float64
	Fluke  bool
}

// Surface is how long a bout is at the surface, from its first blow to
// the dive after its last: its blows, one gap each.
func (b *Bout) Surface() float64 { return float64(float64(b.Blows) * b.Every) }

// The own numbers of a whale's round.
const (
	ownRound  = 60
	boutSalt  = 9000
	boutBlows = 1
	boutEvery = 2
	boutDive  = 3
	boutFluke = 4
	boutBurst = 5
	boutWhere = 6
	boutWhich = 7
)

// whaleSeed is whale i's own seed in a group of seed: the page's swimSeed.
func whaleSeed(seed uint32, i int) uint32 { return hash32(seed ^ hash32(uint32(2000+i))) }

// pairAt is a pair's value a share u of the way along it, or for none.
func pairAt(p []float64, u, or float64) float64 {
	switch len(p) {
	case 0:
		return or
	case 1:
		return p[0]
	}
	return lerp(p[0], p[1], u)
}

// intPairAt is an int pair's value a share u along it, rounded, or for none.
func intPairAt(p []int, u float64, or int32) int32 {
	switch len(p) {
	case 0:
		return or
	case 1:
		return int32(p[0])
	}
	return toInt32(math.Floor(lerp(float64(p[0]), float64(p[1]), u) + 0.5))
}

// bout is whale s's k-th bout of a round drawn from its numbers: its
// blows, their gap, and whether and where in it it breaches or slaps,
// starting at start.
func bout(k *Kind, s uint32, n int32, start float64) (b Bout, dive float64) {
	sw := k.Swim
	ks := hash32(s ^ hash32(uint32(boutSalt+n)))
	b = Bout{Start: start, Breach: -1, Slap: -1}
	b.Blows = max(intPairAt(sw.Breaths, Own(ks, boutBlows), 1), 1)
	b.Every = pairAt(sw.BlowEvery, Own(ks, boutEvery), 30)
	dive = pairAt(sw.Dive, Own(ks, boutDive), 300)
	b.Fluke = Own(ks, boutFluke) < shareOf(sw.Fluke)
	whaleBursts(sw.Breach, sw.Slap, ks, &b)
	return b, dive
}

// whaleBursts places a bout's breach or slap between two of its blows, at
// its kind's shares, a breach first: each in the middle of a gap of its
// own, if there is a gap long enough.
func whaleBursts(breach, slap *float64, ks uint32, b *Bout) {
	if b.Blows < 2 || b.Every < WhaleBreachTime+2 {
		return
	}
	gaps := b.Blows - 1
	at := func(j int32, long float64) float64 {
		return b.Start + float64(float64(j)*b.Every) + float64(b.Every/2) - long/2
	}
	j := min(toInt32(float64(Own(ks, boutWhere)*float64(gaps))), gaps-1)
	burst, br := Own(ks, boutBurst), shareOf(breach)
	switch {
	case burst < br:
		b.Breach = at(j, WhaleBreachTime)
	case burst < br+shareOf(slap):
		b.Slap = at(j, WhaleSlapTime)
	}
}

// shareOf is a share the catalog may leave out: none for none.
func shareOf(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

// Round is whale i's bout of a group of the kind at u s into a life of
// life s, the bout at the surface that u is in or that comes next after
// its dive, and false for none (past the group's life). A whale that
// drifts has its one bout, from its first blow WhaleUp s in to the dive
// that ends its life; a whale that passes keeps rounds of dives and
// bouts, begun at a time of its own.
func Round(k *Kind, e *bus.LifeEncounter, i int, u, life float64) (Bout, bool) {
	if k.Swim == nil {
		return Bout{}, false
	}
	s := whaleSeed(e.Seed, i)
	if k.Path == PathDrift {
		every := pairAt(k.Swim.BlowEvery, Own(s, boutEvery), 30)
		span := life - WhaleUp - WhaleDive - whaleLeave
		b := Bout{Start: WhaleUp, Every: every, Breach: -1, Slap: -1, Fluke: shareOf(k.Swim.Fluke) > 0}
		b.Blows = max(toInt32(math.Floor(span/every)), 1)
		return b, u < life
	}
	// The round runs from a start of its own before the life began, so
	// the whales of a group are not in step.
	first, d0 := bout(k, s, 0, 0)
	start := -float64(Own(s, ownRound) * (d0 + first.Surface() + WhaleDive))
	for n := int32(0); start < life && n < 10000; n++ {
		b, dive := bout(k, s, n, 0)
		b.Start = start + dive + WhaleUp
		if b.Breach >= 0 {
			b.Breach += b.Start
		}
		if b.Slap >= 0 {
			b.Slap += b.Start
		}
		if u < b.Start+b.Surface()+WhaleDive {
			return b, b.Start-WhaleUp < life
		}
		start = b.Start + b.Surface() + WhaleDive
	}
	return Bout{}, false
}

// WhaleEvents calls add with each event of whale i of a group of the kind
// whose time, s into the group's life, is in [from, to): its blows, a
// breach's fall, a slap's hit and a dive with its flukes raised.
func WhaleEvents(k *Kind, e *bus.LifeEncounter, i int, from, to float64, add func(event int, at float64)) {
	life := float64(e.End-e.Start) / physics.StepsPerSecond
	from, to = max(from, 0), min(to, life)
	u := from
	for u < to {
		b, ok := Round(k, e, i, u, life)
		if !ok {
			return
		}
		for j := range b.Blows {
			if at := b.Start + float64(float64(j)*b.Every); at >= from && at < to {
				add(WhaleBlow, at)
			}
		}
		if at := b.Breach + WhaleFall; b.Breach >= 0 && at >= from && at < to {
			add(WhaleBreach, at)
		}
		if at := b.Slap + WhaleSlapTime/2; b.Slap >= 0 && at >= from && at < to {
			add(WhaleSlap, at)
		}
		if at := b.Start + b.Surface(); b.Fluke && at >= from && at < to {
			add(WhaleFluke, at)
		}
		next := b.Start + b.Surface() + WhaleDive
		if !(next > u) {
			return
		}
		u = next
	}
}
