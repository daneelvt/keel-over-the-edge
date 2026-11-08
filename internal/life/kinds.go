// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The families, whose lulls their kinds keep.
const (
	FamilyBirds = iota
	FamilyWater
	FamilyBig
	FamilyNight
	Families
)

// The habitats a point is in: one each, the first that holds of its
// harbour, its reef, the outer water, the shelf and the deep.
const (
	Harbour = iota
	Reef
	Outer
	Shelf
	Deep
	Habitats
	// Land is a point on land: nothing starts there.
	Land = Habitats
)

// The paths a group with no boat follows.
const (
	PathPass  = iota // through, from its range on one side to its range on the other
	PathSoar         // in, circling over its centre for its stay, and out
	PathSkim         // through, low, in arcs over the swell
	PathWork         // in, wheeling and plunging over a patch of water for its stay, and out
	PathStay         // in, about its patch for its stay, and out
	PathDrift        // from its centre as it begins, drifting along its heading for its stay
)

// NoPath is a kind's Over when it keeps its own path over another's patch.
const NoPath = -1

// What a kind does with a boat it meets.
const (
	BindsNone   = iota
	BindsFollow // keeps astern of it
	BindsRide   // rides its bow
	BindsFlush  // a ground of fish flushed by every boat sailing through it
)

// Bring is a group that comes with another: its kind, by its index, the
// share of the other's groups it comes with, and how many in it.
type Bring struct {
	Kind      int
	Share     float64
	CountLow  int32
	CountHigh int32
}

// maxBrings is the most groups that come with another's: each one's id
// is the other's with its number in the top bits (bringShift).
const maxBrings = 63

// Kind is a kind of the sea's life as the schedule and the paths read it.
type Kind struct {
	Index  int
	Name   string
	Plural string
	Form   catalog.LifeForm
	Family int
	Path   int
	// Over is how it moves over the patch of a group it comes with, a
	// path, or NoPath to keep its own.
	Over int
	// Binds is what it does with a boat it meets; Follows that it follows
	// one, astern.
	Binds    int
	Follows  bool
	Homeward bool
	Line     bool
	Dives    float64 // each bird a minute
	// Habitat is its weight in each habitat; NearColony its weight's
	// factor near a colony, 1 for none.
	Habitat    [Habitats]float64
	NearColony float64
	// When is its weight by day, at dusk and dawn, and at night.
	Day, Dusk, Night float64
	// Wind is the least and the most it is met in, m/s; Rain its share in
	// rain; BySea whether it is seen less as the sea rises.
	WindLow, WindHigh float64
	Rain              float64
	BySea             bool
	// Rate is its encounters a km² an hour at a weight of 1.
	Rate                  float64
	GroupLow, GroupHigh   int32
	StayLow, StayHigh     float64 // s
	SpeedLow, SpeedHigh   float64 // m/s
	HeightLow, HeightHigh float64 // m
	// Range is how far out it comes from and goes to, m; Reach how far it
	// is drawn, m.
	Range, Reach float64
	// Patch is how far its patch reaches from its middle, the least and
	// the most, m: a ground of fish, a boil of bait.
	PatchLow, PatchHigh float64
	// Brings are the groups that come with each of its own.
	Brings []Bring
	// Collective is what a group of it is called, "" for none.
	Collective string
	// Look is a bird's look, nil for any other form; Swim a swimmer's.
	Look *catalog.BirdLook
	Swim *catalog.SwimLook
}

// Rides says whether a group of the kind rides a boat's bow.
func (k *Kind) Rides() bool { return k.Binds == BindsRide }

// Flushes says whether the kind is a ground of fish flushed by boats.
func (k *Kind) Flushes() bool { return k.Binds == BindsFlush }

// Params are the schedule's numbers.
type Params struct {
	Cell       float64 // m
	SlotTicks  int64
	Lulls      [Families]int64 // ticks
	Quiet      int64           // ticks
	Drop       float64         // m
	DuskLow    float64         // rad
	DuskHigh   float64         // rad
	Rainy      float64         // mm/h
	HarbourIn  float64         // m
	ReefIn     float64         // m
	ShelfIn    float64         // m deep
	OuterFrom  float64         // m from the centre
	ColonyIn   float64         // m
	Field      float64         // m
	Sea        []float64       // by Beaufort force
	BindWithin float64         // m
	BindSpeed  float64         // m/s
	BindSteady int64           // ticks
	// BindTurn is how far a boat's heading may wander and its course still
	// count as steady, rad.
	BindTurn float64
	// RideWithin is how far a group that rides bows comes from to a boat,
	// m, in BindWithin's place.
	RideWithin float64
	// A group riding a bow leaves it once the boat is slower than
	// RideSlower, m/s, or has turned more than RideTurn, rad, from its
	// heading as the ride began.
	RideSlower, RideTurn float64
	// A boat in a ground flushes its fish every FlushEvery ticks at
	// FlushChance, FlushLead ticks after, FlushAhead m ahead of its bow
	// and up to FlushBeside m either side of its course.
	FlushEvery                                 int64
	FlushChance                                float64
	FlushLead                                  int64
	FlushAheadLow, FlushAheadHigh, FlushBeside float64
}

// Prepare reads the catalog's life.
func Prepare(cat *catalog.Catalog) (*Params, []Kind) {
	l := &cat.Life
	ticks := func(s float64) int64 { return int64(toInt32(math.Floor(float64(s*physics.StepsPerSecond) + 0.5))) }
	p := &Params{
		Cell: l.Cell, SlotTicks: int64(l.Slot) * physics.StepsPerSecond,
		Lulls: [Families]int64{ticks(l.Lulls.Birds), ticks(l.Lulls.Water), ticks(l.Lulls.Big), ticks(l.Lulls.Night)},
		Quiet: ticks(l.Quiet), Drop: l.Drop,
		DuskLow: l.Dusk[0] * math.Pi / 180, DuskHigh: l.Dusk[1] * math.Pi / 180,
		Rainy:     l.Rainy,
		HarbourIn: l.Habitat.Harbour, ReefIn: l.Habitat.Reef, ShelfIn: l.Habitat.Shelf, OuterFrom: l.Habitat.Outer,
		ColonyIn: l.Habitat.Colony, Field: l.Habitat.Field, Sea: l.Sea,
		BindWithin: l.Bind.Within, BindSpeed: l.Bind.Speed, BindSteady: ticks(l.Bind.Steady), BindTurn: l.Bind.Turn * math.Pi / 180,
		RideWithin: l.Ride.Within, RideSlower: l.Ride.Slower, RideTurn: l.Ride.Turn * math.Pi / 180,
		FlushEvery: max(ticks(l.Flush.Every), 1), FlushChance: l.Flush.Chance, FlushLead: ticks(l.Flush.Lead),
		FlushAheadLow: pairOr(l.Flush.Ahead, 0, 0), FlushAheadHigh: pairOr(l.Flush.Ahead, 1, 0), FlushBeside: l.Flush.Beside,
	}
	index := make(map[string]int, len(l.Kinds))
	for i := range l.Kinds {
		index[l.Kinds[i].ID] = i
	}
	kinds := make([]Kind, len(l.Kinds))
	for i := range l.Kinds {
		c := &l.Kinds[i]
		k := &kinds[i]
		*k = Kind{
			Index: i, Name: c.Name, Plural: c.Plural, Form: c.Form,
			Habitat:    [Habitats]float64{c.Habitats.Harbour, c.Habitats.Reef, c.Habitats.Outer, c.Habitats.Shelf, c.Habitats.Deep},
			NearColony: 1,
			Day:        c.When.Day, Dusk: c.When.Dusk, Night: c.When.Night,
			WindLow: c.Wind[0], WindHigh: c.Wind[1], Rain: c.Rain, BySea: c.BySea, Rate: c.Rate,
			GroupLow: int32(c.Group[0]), GroupHigh: int32(c.Group[1]),
			StayLow: c.Stay[0], StayHigh: c.Stay[1], SpeedLow: c.Speed[0], SpeedHigh: c.Speed[1],
			HeightLow: c.Height[0], HeightHigh: c.Height[1], Range: c.Range, Reach: c.Reach, Look: c.Look,
			Swim: c.Swim, Over: NoPath, PatchLow: pairOr(c.Patch, 0, 0), PatchHigh: pairOr(c.Patch, 1, 0),
		}
		if c.Collective != nil {
			k.Collective = *c.Collective
		}
		for _, b := range c.Brings {
			if j, ok := index[b.Kind]; ok && len(k.Brings) < maxBrings {
				k.Brings = append(k.Brings, Bring{Kind: j, Share: b.Share,
					CountLow: int32(pairOrInt(b.Count, 0)), CountHigh: int32(pairOrInt(b.Count, 1))})
			}
		}
		switch c.Family {
		case catalog.LifeFamilyWater:
			k.Family = FamilyWater
		case catalog.LifeFamilyBig:
			k.Family = FamilyBig
		case catalog.LifeFamilyNight:
			k.Family = FamilyNight
		}
		switch c.Path {
		case catalog.LifePathSoar:
			k.Path = PathSoar
		case catalog.LifePathSkim:
			k.Path = PathSkim
		case catalog.LifePathWork:
			k.Path = PathWork
		case catalog.LifePathStay:
			k.Path = PathStay
		case catalog.LifePathDrift:
			k.Path = PathDrift
		}
		if c.Over != nil {
			switch *c.Over {
			case catalog.LifeOverWork:
				k.Over = PathWork
			case catalog.LifeOverStay:
				k.Over = PathStay
			}
		}
		if c.Binds != nil {
			switch *c.Binds {
			case catalog.LifeBindsFollow:
				k.Binds = BindsFollow
			case catalog.LifeBindsRide:
				k.Binds = BindsRide
			case catalog.LifeBindsFlush:
				k.Binds = BindsFlush
			}
		}
		k.Follows = k.Binds == BindsFollow
		k.Homeward = c.Homeward != nil && *c.Homeward
		k.Line = c.Line != nil && *c.Line
		if c.Dives != nil {
			k.Dives = *c.Dives
		}
		if c.NearColony != nil {
			k.NearColony = *c.NearColony
		}
	}
	return p, kinds
}

// Lingers says whether a group of the kind stays over its patch: it
// soars, works or stays.
func (k *Kind) Lingers() bool { return lingers(k.Path) }

// lingers says whether a path stays over its patch.
func lingers(path int) bool { return path == PathSoar || path == PathWork || path == PathStay }

// PathOf is the path a group of the kind follows: over the patch of a
// group it comes with, its kind's Over if it has one, else its own.
func (k *Kind) PathOf(e *bus.LifeEncounter) int {
	if e.Over != 0 && k.Over != NoPath {
		return k.Over
	}
	return k.Path
}

// pairOrInt is an int pair's i-th value, 0 where it has none.
func pairOrInt(p []int, i int) int {
	if i < len(p) {
		return p[i]
	}
	return 0
}

// ownPatch is which of a group's own numbers draws how far its patch
// reaches.
const ownPatch = 30

// Patch is how far the patch of a group of the kind of its own seed
// reaches from its middle, m: a ground of fish, a boil of bait.
func Patch(k *Kind, seed uint32) float64 { return lerp(k.PatchLow, k.PatchHigh, Own(seed, ownPatch)) }

// Linked is how far a fish of the kind flushed from its ground glides, its
// glides linked, m: its look's linked glides, else its longest glide.
func (k *Kind) Linked() float64 {
	switch {
	case k.Swim == nil:
		return 0
	case k.Swim.Linked != nil:
		return *k.Swim.Linked
	case len(k.Swim.Glide) > 1:
		return k.Swim.Glide[1]
	}
	return 0
}

// Arrive is how long a group of the kind takes to come in from its range,
// or to go out to it, at speed v, s.
func (k *Kind) Arrive(v float64) float64 { return k.Range / math.Max(v, 0.1) }

// mostWeight is the most the kind weighs anywhere, by any sun: the
// candidates' chance is drawn against it.
func (k *Kind) mostWeight() (habitat, when float64) {
	for _, w := range k.Habitat {
		habitat = math.Max(habitat, w)
	}
	return float64(habitat * math.Max(k.NearColony, 1)), math.Max(k.Day, math.Max(k.Dusk, k.Night))
}
