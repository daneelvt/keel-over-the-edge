// SPDX-License-Identifier: AGPL-3.0-only

package protocol

import (
	"fmt"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// WeatherSystems is the message of the spells in play, or with keep that
// the spells the client holds still are, and of keyframes. Every field of a
// Spell and a System is a whole number, which the message carries exactly.
func WeatherSystems(spells []physics.Spell, keep bool, keys ...*physics.Keyframe) *pb.WeatherSystems {
	m := &pb.WeatherSystems{KeepSpells: keep}
	if !keep {
		m.Spells = make([]*pb.Spell, len(spells))
	}
	for i := range m.Spells {
		m.Spells[i] = spellPB(&spells[i])
	}
	for _, k := range keys {
		m.Keyframes = append(m.Keyframes, keyframePB(k))
	}
	return m
}

// spellPB is a spell as the wire carries it.
func spellPB(s *physics.Spell) *pb.Spell {
	return &pb.Spell{
		Begin: int64(s.Begin), Change: uint32(s.Change),
		Start: int64(s.Start), Length: uint64(s.Length),
		Regime: uint32(s.Regime), Steady: s.Steady != 0,
		Speed: uint32(s.Speed), From: uint32(s.From), Drift: int32(s.Drift), Gust: uint32(s.Gust),
		Shift:  []uint32{uint32(s.Shift[0]), uint32(s.Shift[1])},
		Period: []uint32{uint32(s.Period[0]), uint32(s.Period[1])},
		Phase:  []uint32{uint32(s.Phase[0]), uint32(s.Phase[1])},
		Across: uint32(s.Across), Axis: uint32(s.Axis), AxisPeriod: uint32(s.AxisPeriod),
		Seed: uint32(s.Seed), Pressure: uint32(s.Pressure),
		Front: s.Front != 0, Toward: uint32(s.Toward), Trough: uint32(s.Trough), Still: s.Still != 0,
	}
}

// keyframePB is a keyframe as the wire carries it: its systems, by their
// slots.
func keyframePB(k *physics.Keyframe) *pb.Keyframe {
	pk := &pb.Keyframe{Tick: int64(k.Tick)}
	for slot := range k.Systems {
		s := &k.Systems[slot]
		if s.On == 0 {
			continue
		}
		pk.Systems = append(pk.Systems, &pb.SystemKey{
			Slot: uint32(slot), Kind: uint32(s.Kind), Seed: uint32(s.Seed), Stage: uint32(s.Stage),
			East: int32(s.East), North: int32(s.North), Heading: uint32(s.Heading), Speed: uint32(s.Speed),
			Strength: uint32(s.Strength), Size: uint32(s.Size), Peak: uint32(s.Peak), Depth: int32(s.Depth),
		})
	}
	return pk
}

// KeyframesOf reads a WeatherSystems's keyframes into dst and returns how
// many there are: at most physics.KeySets, ascending by their ticks, each
// system in a slot of its own.
func KeyframesOf(m *pb.WeatherSystems, dst []physics.Keyframe) (int, error) {
	ks := m.GetKeyframes()
	if len(ks) > len(dst) {
		return 0, fmt.Errorf("protocol: %d keyframes, more than %d", len(ks), len(dst))
	}
	for i, k := range ks {
		if i > 0 && k.GetTick() <= ks[i-1].GetTick() {
			return 0, fmt.Errorf("protocol: keyframe %d's tick is out of order", i)
		}
		if err := keyframeOf(k, &dst[i]); err != nil {
			return 0, fmt.Errorf("protocol: keyframe %d: %w", i, err)
		}
	}
	return len(ks), nil
}

// keyframeOf reads a keyframe off the wire into dst.
func keyframeOf(k *pb.Keyframe, dst *physics.Keyframe) error {
	if k.GetTick() < -maxTick || k.GetTick() > maxTick {
		return fmt.Errorf("its tick is out of range")
	}
	*dst = physics.Keyframe{Tick: float64(k.GetTick())}
	for _, s := range k.GetSystems() {
		slot := s.GetSlot()
		if slot >= physics.MaxSystems || dst.Systems[slot].On != 0 {
			return fmt.Errorf("a system in slot %d", slot)
		}
		dst.Systems[slot] = physics.System{
			On: 1, Kind: float64(s.GetKind()), Seed: float64(s.GetSeed()), Stage: float64(s.GetStage()),
			East: float64(s.GetEast()), North: float64(s.GetNorth()), Heading: float64(s.GetHeading()), Speed: float64(s.GetSpeed()),
			Strength: float64(s.GetStrength()), Size: float64(s.GetSize()), Peak: float64(s.GetPeak()), Depth: float64(s.GetDepth()),
		}
	}
	return nil
}

// maxTick is the furthest tick a spell may name: every whole number up to
// it is exact as a float64.
const maxTick = 1 << 53

// SpellsOf reads a WeatherSystems into dst and returns how many spells it
// holds: at most physics.WeatherSpells, ascending by the tick each begins
// at, each with its two shifts, and its numbers in the ranges a float64
// holds exactly.
func SpellsOf(m *pb.WeatherSystems, dst *[physics.WeatherSpells]physics.Spell) (int32, error) {
	if len(m.GetSpells()) > physics.WeatherSpells {
		return 0, fmt.Errorf("protocol: %d spells of weather, more than %d", len(m.GetSpells()), physics.WeatherSpells)
	}
	for i, p := range m.GetSpells() {
		if i > 0 && p.GetBegin() < m.GetSpells()[i-1].GetBegin() {
			return 0, fmt.Errorf("protocol: spell %d begins before the one before it", i)
		}
		if err := spellOf(p, &dst[i]); err != nil {
			return 0, fmt.Errorf("protocol: spell %d %w", i, err)
		}
	}
	return int32(len(m.GetSpells())), nil
}

// spellOf reads a spell off the wire into dst.
func spellOf(p *pb.Spell, dst *physics.Spell) error {
	if len(p.GetShift()) != 2 || len(p.GetPeriod()) != 2 || len(p.GetPhase()) != 2 {
		return fmt.Errorf("has not two shifts")
	}
	if p.GetBegin() < -maxTick || p.GetBegin() > maxTick || p.GetStart() < -maxTick || p.GetStart() > maxTick || p.GetLength() > maxTick {
		return fmt.Errorf("has ticks out of range")
	}
	*dst = physics.Spell{
		Begin: float64(p.GetBegin()), Change: float64(p.GetChange()),
		Start: float64(p.GetStart()), Length: float64(p.GetLength()),
		Regime: float64(p.GetRegime()), Steady: bit(p.GetSteady()),
		Speed: float64(p.GetSpeed()), From: float64(p.GetFrom()), Drift: float64(p.GetDrift()), Gust: float64(p.GetGust()),
		Shift:  [2]float64{float64(p.GetShift()[0]), float64(p.GetShift()[1])},
		Period: [2]float64{float64(p.GetPeriod()[0]), float64(p.GetPeriod()[1])},
		Phase:  [2]float64{float64(p.GetPhase()[0]), float64(p.GetPhase()[1])},
		Across: float64(p.GetAcross()), Axis: float64(p.GetAxis()), AxisPeriod: float64(p.GetAxisPeriod()),
		Seed: float64(p.GetSeed()), Pressure: float64(p.GetPressure()),
		Front: bit(p.GetFront()), Toward: float64(p.GetToward()), Trough: float64(p.GetTrough()), Still: bit(p.GetStill()),
	}
	return nil
}

// bit is 1 for true, 0 for false.
func bit(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// SetComing sets a WeatherSystems's coming front, or none.
func SetComing(m *pb.WeatherSystems, c *physics.ComingFront) {
	m.Coming = nil
	if c.On != 0 {
		m.Coming = &pb.ComingFront{Begin: int64(c.Begin), Change: uint32(c.Change), Toward: uint32(c.Toward)}
	}
}

// ComingOf reads a WeatherSystems's coming front: none if it carries none.
func ComingOf(m *pb.WeatherSystems) (physics.ComingFront, error) {
	c := m.GetComing()
	if c == nil {
		return physics.ComingFront{}, nil
	}
	if c.GetBegin() < -maxTick || c.GetBegin() > maxTick || c.GetToward() >= physics.TurnSteps {
		return physics.ComingFront{}, fmt.Errorf("protocol: the coming front's numbers are out of range")
	}
	return physics.ComingFront{On: 1, Begin: float64(c.GetBegin()), Change: float64(c.GetChange()), Toward: float64(c.GetToward())}, nil
}
