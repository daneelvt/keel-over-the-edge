// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// Conditions are the weather where an encounter is drawn: the mean wind
// 10 m up, m/s, and the rain, mm an hour, at a point at the tick the
// schedule is asked for.
type Conditions interface {
	Weather(x, y float64) (wind, rain float64)
}

// Config makes a world's schedule: its numbers and kinds, its habitat,
// the world's seed, and the sky and the world's epoch, µs of UTC since
// 1970, that say where the sun is (nil for a sun always up).
type Config struct {
	Params  *Params
	Kinds   []Kind
	Habitat *Habitat
	Seed    uint64
	Sky     *sky.Prepared
	Epoch   int64
}

// Schedule is a world's life schedule.
type Schedule struct {
	p       *Params
	kinds   []Kind
	hab     *Habitat
	seed    uint32
	sky     *sky.Prepared
	epoch   float64
	n       int32   // cells a side
	origin  float64 // the cells' south-west corner, m from the centre either way
	cells   []bool  // whether each cell meets the disk
	family  [Families][]int
	base    []float64 // each kind's chance at a weight of 1, a cell and a slot
	most    []uint32  // each kind's most threshold
	mostWhn []float64 // each kind's most weight by the sun
	lullFor [Families]int64
}

// lifeSalt keeps the life seed apart from the world's other draws.
const lifeSalt = 0x51ed270b

// NewSchedule makes a world's schedule.
func NewSchedule(c *Config) *Schedule {
	p := c.Params
	s := &Schedule{p: p, kinds: c.Kinds, hab: c.Habitat, sky: c.Sky, epoch: float64(c.Epoch)}
	s.seed = hash32(uint32(c.Seed) ^ hash32(uint32(c.Seed>>32)^lifeSalt))
	disk := c.Habitat.disk
	s.n = toInt32(math.Ceil(float64(2*disk) / p.Cell))
	s.origin = -float64(float64(s.n)*p.Cell) / 2
	s.cells = make([]bool, int(s.n)*int(s.n))
	for j := range s.n {
		for i := range s.n {
			// The cell's nearest point to the centre.
			x0, y0 := s.corner(i, j)
			nx := math.Max(x0, math.Min(0, x0+p.Cell))
			ny := math.Max(y0, math.Min(0, y0+p.Cell))
			s.cells[j*s.n+i] = float64(nx*nx)+float64(ny*ny) < float64(disk*disk)
		}
	}
	km2 := float64(p.Cell*p.Cell) / 1e6
	hours := float64(p.SlotTicks) / (physics.StepsPerSecond * 3600)
	s.base = make([]float64, len(c.Kinds))
	s.most = make([]uint32, len(c.Kinds))
	s.mostWhn = make([]float64, len(c.Kinds))
	for i := range c.Kinds {
		k := &c.Kinds[i]
		s.family[k.Family] = append(s.family[k.Family], i)
		s.base[i] = float64(float64(k.Rate*km2) * hours)
		hab, when := k.mostWeight()
		s.mostWhn[i] = when
		s.most[i] = threshold(float64(float64(s.base[i]*hab) * when))
	}
	s.lullFor = p.Lulls
	return s
}

// corner is cell (i, j)'s south-west corner, m.
func (s *Schedule) corner(i, j int32) (x, y float64) {
	return s.origin + float64(float64(i)*s.p.Cell), s.origin + float64(float64(j)*s.p.Cell)
}

// Kinds are the schedule's kinds.
func (s *Schedule) Kinds() []Kind { return s.kinds }

// Params are its numbers.
func (s *Schedule) Params() *Params { return s.p }

// Habitat is its world's habitat.
func (s *Schedule) Habitat() *Habitat { return s.hab }

// SlotOf is the slot a tick is in.
func (s *Schedule) SlotOf(tick int64) int64 {
	q := tick / s.p.SlotTicks
	if tick%s.p.SlotTicks < 0 {
		q--
	}
	return q
}

// Sun is the sun's height at a tick at (x, y), rad: always up without a
// sky.
func (s *Schedule) Sun(tick int64, x, y float64) float64 {
	if s.sky == nil {
		return math.Pi / 2
	}
	t := sky.Time(s.sky, s.epoch, float64(tick*1_000_000/physics.StepsPerSecond))
	return sky.SunAltitude(s.sky, t, x, y)
}

// Dark says whether the sky at (x, y) at a tick is dark enough for
// glowing water of the kind to show: the sun below the horizon, and the
// moon's light (its lit share times the sine of its height, nothing while
// it is down) under the kind's limit. Without a sky the sun is always up.
func (s *Schedule) Dark(k *Kind, tick int64, x, y float64) bool {
	if s.sky == nil {
		return false
	}
	var sk sky.Sky
	sky.At(s.sky, sky.Time(s.sky, s.epoch, float64(tick*1_000_000/physics.StepsPerSecond)), x, y, &sk)
	if !(sk.Sun.Altitude < 0) {
		return false
	}
	moon := 0.0
	if sk.Moon.Altitude > 0 {
		moon = float64(sk.Lit * physics.Sin(sk.Moon.Altitude))
	}
	return moon < k.GlowMoon
}

// When is a kind's weight by the sun's height a.
func (s *Schedule) When(k *Kind, a float64) float64 {
	switch {
	case a > s.p.DuskHigh:
		return k.Day
	case a >= s.p.DuskLow:
		return k.Dusk
	}
	return k.Night
}

// Dusk says whether the sun's height a is dusk's or dawn's.
func (s *Schedule) Dusk(a float64) bool { return a >= s.p.DuskLow && a <= s.p.DuskHigh }

// candidate is a kind's draw in a cell and slot that may begin there.
type candidate struct {
	ok    bool
	tick  int64
	x, y  float64
	draws draws
}

// key is the draws of a kind in a cell and slot.
func (s *Schedule) key(cell int32, slot int64, kind int) draws {
	k := hash32(s.seed ^ uint32(slot))
	k = hash32(k ^ uint32(slot>>32))
	k = hash32(k ^ uint32(cell))
	return draws(hash32(k ^ uint32(kind)))
}

// The draws' numbers.
const (
	drawWhether = iota
	drawWhen
	drawEast
	drawNorth
	drawHeading
	drawCount
	drawSeed
	drawSpeed
	drawStay
	drawConditions
)

// candidate draws kind in cell and slot: whether it may begin there, by
// its rate and the habitat at its point, and when and where.
func (s *Schedule) candidate(cell int32, slot int64, kind int) candidate {
	d := s.key(cell, slot, kind)
	whether := d.n(drawWhether)
	if whether >= s.most[kind] || !s.cells[cell] {
		return candidate{}
	}
	x0, y0 := s.corner(cell%s.n, cell/s.n)
	x := x0 + float64(unit(d.n(drawEast))*s.p.Cell)
	y := y0 + float64(unit(d.n(drawNorth))*s.p.Cell)
	k := &s.kinds[kind]
	w := s.hab.Weight(k, x, y)
	if !(w > 0) || whether >= threshold(float64(float64(s.base[kind]*w)*s.mostWhn[kind])) {
		return candidate{}
	}
	tick := slot*s.p.SlotTicks + int64(toInt32(float64(unit(d.n(drawWhen))*float64(s.p.SlotTicks))))
	return candidate{ok: true, tick: tick, x: x, y: y, draws: d}
}

// lulled says whether a candidate of kind in cell at tick is dropped: a
// candidate of its family began in its cell or the eight about it within
// its family's lull before it, or at the same tick in a cell or of a kind
// before it.
func (s *Schedule) lulled(cell int32, kind int, tick int64) bool {
	fam := s.kinds[kind].Family
	lull := s.lullFor[fam]
	if lull <= 0 {
		return false
	}
	ci, cj := cell%s.n, cell/s.n
	for sl := s.SlotOf(tick - lull); sl <= s.SlotOf(tick); sl++ {
		for dj := int32(-1); dj <= 1; dj++ {
			for di := int32(-1); di <= 1; di++ {
				i, j := ci+di, cj+dj
				if i < 0 || j < 0 || i >= s.n || j >= s.n {
					continue
				}
				c := j*s.n + i
				for _, k := range s.family[fam] {
					if c == cell && k == kind && sl == s.SlotOf(tick) {
						continue
					}
					o := s.candidate(c, sl, k)
					if !o.ok || o.tick < tick-lull || o.tick > tick {
						continue
					}
					if o.tick < tick || c < cell || c == cell && k < kind {
						return true
					}
				}
			}
		}
	}
	return false
}

// conditions is a kind's weight by the conditions at (x, y) at tick: the
// sun's, nothing outside the wind it is met in, its share in rain, and the
// sea's for life in the water.
func (s *Schedule) conditions(k *Kind, c Conditions, tick int64, x, y float64) float64 {
	w := s.When(k, s.Sun(tick, x, y))
	if !(w > 0) {
		return 0
	}
	if c == nil {
		return w
	}
	wind, rain := c.Weather(x, y)
	if wind < k.WindLow || wind > k.WindHigh {
		return 0
	}
	if rain >= s.p.Rainy {
		w = float64(w * k.Rain)
	}
	if k.BySea && len(s.p.Sea) > 0 {
		w = float64(w * s.p.Sea[min(weather.ForceOf(wind), len(s.p.Sea)-1)])
	}
	return w
}

// Slot appends to out the encounters that begin in a slot of world time,
// in the conditions c at its start: in cell order, then kind order. It is
// a pure function of the schedule, the slot and c.
func (s *Schedule) Slot(slot int64, c Conditions, out []bus.LifeEncounter) []bus.LifeEncounter {
	for cell := range int32(len(s.cells)) {
		if !s.cells[cell] {
			continue
		}
		for kind := range s.kinds {
			cd := s.candidate(cell, slot, kind)
			if !cd.ok || s.lulled(cell, kind, cd.tick) {
				continue
			}
			k := &s.kinds[kind]
			w := s.conditions(k, c, cd.tick, cd.x, cd.y)
			if cd.draws.n(drawConditions) >= threshold(w/s.mostWhn[kind]) {
				continue
			}
			out = append(out, s.encounter(k, cd, slot, cell))
			if len(k.Brings) > 0 {
				parent := out[len(out)-1]
				out = s.Bring(&parent, out)
			}
		}
	}
	return out
}

// An encounter's id says where it came from, and no two alive share one:
//
//   - a slot's own: slot<<20 | cell<<8 | kind, the slot below 2^36 (two
//     million years of 30 s slots), so bits 56 to 63 are clear;
//   - one raised by hand: 1<<63 | n, n counting those raised, below 2^32;
//   - one that comes with another (Bring): the other's id | (j+1)<<56, j
//     its number among the other's brings, below maxBrings, so bits 56
//     to 61, clear in the other's, hold j+1 and bit 62 stays clear;
//   - fish flushed from a ground (flushID): 1<<62 | slot<<24 |
//     boat slot<<8 | ground, the flushes' slot of FlushEvery ticks in
//     bits 24 to 61 (17,000 years of 2 s slots), the boat's slot in bits
//     8 to 23 and the ground's number among those alive in bits 0 to 7.
const (
	raisedBit  = 1 << 63
	flushBit   = 1 << 62
	bringShift = 56
)

// bringSalt keeps the draws of the groups that come with another apart
// from the other's own.
const bringSalt = 0x6b1d5c3e

// Bring appends to out the groups that come with parent, in the order of
// its kind's brings: each whose share passes a draw of parent's seed and
// its number, its kind's, over parent's patch from parent's start to its
// end, its count drawn in the bring's range and its heading and speed as
// its kind's. It is a pure function of parent.
func (s *Schedule) Bring(parent *bus.LifeEncounter, out []bus.LifeEncounter) []bus.LifeEncounter {
	k := &s.kinds[parent.Kind]
	for j := range k.Brings {
		b := &k.Brings[j]
		d := draws(hash32(parent.Seed ^ hash32(bringSalt+uint32(j))))
		if !(b.Share >= 1) && d.n(drawWhether) >= threshold(b.Share) {
			continue
		}
		c := &s.kinds[b.Kind]
		e := bus.LifeEncounter{
			ID:    parent.ID | uint64(j+1)<<bringShift,
			Kind:  uint16(b.Kind),
			Start: parent.Start,
			End:   parent.End,
			Seed:  d.n(drawSeed),
			Slot:  -1,
			Over:  parent.ID,
		}
		span := uint32(max(b.CountHigh-b.CountLow, 0)) + 1
		e.Count = uint16(b.CountLow + int32(d.n(drawCount)%span))
		place(&e, parent.East, parent.North, float64(unit(d.n(drawHeading))*(2*math.Pi)), lerp(c.SpeedLow, c.SpeedHigh, unit(d.n(drawSpeed))))
		out = append(out, e)
	}
	return out
}

// encounter is a candidate kept, as its record.
func (s *Schedule) encounter(k *Kind, cd candidate, slot int64, cell int32) bus.LifeEncounter {
	d := cd.draws
	e := bus.LifeEncounter{
		ID:    uint64(slot)<<20 | uint64(cell)<<8 | uint64(k.Index),
		Kind:  uint16(k.Index),
		Start: cd.tick,
		Seed:  d.n(drawSeed),
		Slot:  -1,
	}
	heading := float64(unit(d.n(drawHeading)) * (2 * math.Pi))
	if k.Homeward && s.Dusk(s.Sun(cd.tick, cd.x, cd.y)) {
		if h, ok := s.hab.Home(cd.x, cd.y); ok {
			heading = h
		}
	}
	speed := lerp(k.SpeedLow, k.SpeedHigh, unit(d.n(drawSpeed)))
	span := uint32(max(k.GroupHigh-k.GroupLow, 0)) + 1
	e.Count = uint16(k.GroupLow + int32(d.n(drawCount)%span))
	place(&e, cd.x, cd.y, heading, speed)
	e.End = e.Start + lifeTicks(k.FreeLife(e.Speed, Stay(k, e.Seed)))
	return e
}

// place sets a record's centre, heading and speed, as the wire carries
// them: whole centimetres, and float32s.
func place(e *bus.LifeEncounter, x, y, heading, speed float64) {
	e.East = math.Floor(float64(x*100)+0.5) / 100
	e.North = math.Floor(float64(y*100)+0.5) / 100
	e.Heading = float64(float32(turn(heading)))
	e.Speed = float64(float32(speed))
}

// Stay is how long a group of the kind of its own seed stays over its
// patch or with a boat, s.
func Stay(k *Kind, seed uint32) float64 {
	return lerp(k.StayLow, k.StayHigh, unit(hash32(seed^hash32(drawStay))))
}

// FreeLife is how long a group of the kind at speed v, staying stay s,
// is met with no boat, s: through from its range to its range, or in,
// staying and out.
func (k *Kind) FreeLife(v, stay float64) float64 {
	if k.Path == PathDrift {
		return stay
	}
	a := k.Arrive(v)
	if k.Lingers() {
		return float64(2*a) + stay
	}
	return 2 * a
}

// lifeTicks is a life of s seconds in whole ticks, rounded up.
func lifeTicks(s float64) int64 {
	return int64(toInt32(math.Ceil(float64(s * physics.StepsPerSecond))))
}

// threshold is a chance as a draw's threshold: a draw below it happens.
func threshold(c float64) uint32 {
	switch {
	case !(c > 0):
		return 0
	case c >= 1:
		return math.MaxUint32
	}
	// In steps of two: a draw's bottom bit says nothing.
	return uint32(toInt32(float64(c*(1<<31)))) << 1
}

// lerp is a share u of the way from lo to hi.
func lerp(lo, hi, u float64) float64 { return lo + float64((hi-lo)*u) }

// hash32 mixes a word (Wellons' lowbias32).
func hash32(x uint32) uint32 {
	x ^= x >> 16
	x *= 0x7feb352d
	x ^= x >> 15
	x *= 0x846ca68b
	x ^= x >> 16
	return x
}

// draws are a key's numbers.
type draws uint32

// n is the key's i-th number.
func (d draws) n(i uint32) uint32 { return hash32(uint32(d) ^ hash32(i)) }

// unit is a number in [0, 1) from a draw's top 24 bits, exactly.
func unit(h uint32) float64 { return float64(float64(h>>8) * (1.0 / (1 << 24))) }

// Own is a group's own number i in [0, 1), from its seed: the page's
// ownOf draws the same.
func Own(seed, i uint32) float64 { return unit(hash32(seed ^ hash32(i))) }
