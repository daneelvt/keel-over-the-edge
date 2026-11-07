// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"math"

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
	PathPass = iota // through, from its range on one side to its range on the other
	PathSoar        // in, circling over its centre for its stay, and out
	PathSkim        // through, low, in arcs over the swell
	PathWork        // in, wheeling and plunging over a patch of water for its stay, and out
)

// Kind is a kind of the sea's life as the schedule and the paths read it.
type Kind struct {
	Index  int
	Name   string
	Plural string
	Form   catalog.LifeForm
	Family int
	Path   int
	// Follows: it follows a boat it meets.
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
	// Look is a bird's look, nil for any other form.
	Look *catalog.BirdLook
}

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
}

// Prepare reads the catalog's life.
func Prepare(cat *catalog.Catalog) (*Params, []Kind) {
	l := &cat.Life
	ticks := func(s float64) int64 { return int64(math.Floor(float64(s*physics.StepsPerSecond) + 0.5)) }
	p := &Params{
		Cell: l.Cell, SlotTicks: int64(l.Slot) * physics.StepsPerSecond,
		Lulls: [Families]int64{ticks(l.Lulls.Birds), ticks(l.Lulls.Water), ticks(l.Lulls.Big), ticks(l.Lulls.Night)},
		Quiet: ticks(l.Quiet), Drop: l.Drop,
		DuskLow: l.Dusk[0] * math.Pi / 180, DuskHigh: l.Dusk[1] * math.Pi / 180,
		Rainy:     l.Rainy,
		HarbourIn: l.Habitat.Harbour, ReefIn: l.Habitat.Reef, ShelfIn: l.Habitat.Shelf, OuterFrom: l.Habitat.Outer,
		ColonyIn: l.Habitat.Colony, Field: l.Habitat.Field, Sea: l.Sea,
		BindWithin: l.Bind.Within, BindSpeed: l.Bind.Speed, BindSteady: ticks(l.Bind.Steady), BindTurn: l.Bind.Turn * math.Pi / 180,
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
		}
		k.Follows = c.Binds != nil && *c.Binds == catalog.LifeBindsFollow
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
// soars or works.
func (k *Kind) Lingers() bool { return k.Path == PathSoar || k.Path == PathWork }

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
