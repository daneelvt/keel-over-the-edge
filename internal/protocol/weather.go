// SPDX-License-Identifier: AGPL-3.0-only

package protocol

import (
	"fmt"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// WeatherSystems is the message of the spells in play. Every field of a
// Spell is a whole number, which the message carries exactly.
func WeatherSystems(spells []physics.Spell) *pb.WeatherSystems {
	m := &pb.WeatherSystems{Spells: make([]*pb.Spell, len(spells))}
	for i := range spells {
		s := &spells[i]
		m.Spells[i] = &pb.Spell{
			Begin: int64(s.Begin), Change: uint32(s.Change),
			Start: int64(s.Start), Length: uint64(s.Length),
			Regime: uint32(s.Regime), Steady: s.Steady != 0,
			Speed: uint32(s.Speed), From: uint32(s.From), Drift: int32(s.Drift), Gust: uint32(s.Gust),
			Shift:  []uint32{uint32(s.Shift[0]), uint32(s.Shift[1])},
			Period: []uint32{uint32(s.Period[0]), uint32(s.Period[1])},
			Phase:  []uint32{uint32(s.Phase[0]), uint32(s.Phase[1])},
			Across: uint32(s.Across), Axis: uint32(s.Axis), AxisPeriod: uint32(s.AxisPeriod),
			Seed: uint32(s.Seed),
		}
	}
	return m
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
		if len(p.GetShift()) != 2 || len(p.GetPeriod()) != 2 || len(p.GetPhase()) != 2 {
			return 0, fmt.Errorf("protocol: spell %d has not two shifts", i)
		}
		if p.GetBegin() < -maxTick || p.GetBegin() > maxTick || p.GetStart() < -maxTick || p.GetStart() > maxTick || p.GetLength() > maxTick {
			return 0, fmt.Errorf("protocol: spell %d's ticks are out of range", i)
		}
		if i > 0 && p.GetBegin() < m.GetSpells()[i-1].GetBegin() {
			return 0, fmt.Errorf("protocol: spell %d begins before the one before it", i)
		}
		steady := 0.0
		if p.GetSteady() {
			steady = 1
		}
		dst[i] = physics.Spell{
			Begin: float64(p.GetBegin()), Change: float64(p.GetChange()),
			Start: float64(p.GetStart()), Length: float64(p.GetLength()),
			Regime: float64(p.GetRegime()), Steady: steady,
			Speed: float64(p.GetSpeed()), From: float64(p.GetFrom()), Drift: float64(p.GetDrift()), Gust: float64(p.GetGust()),
			Shift:  [2]float64{float64(p.GetShift()[0]), float64(p.GetShift()[1])},
			Period: [2]float64{float64(p.GetPeriod()[0]), float64(p.GetPeriod()[1])},
			Phase:  [2]float64{float64(p.GetPhase()[0]), float64(p.GetPhase()[1])},
			Across: float64(p.GetAcross()), Axis: float64(p.GetAxis()), AxisPeriod: float64(p.GetAxisPeriod()),
			Seed: float64(p.GetSeed()),
		}
	}
	return int32(len(m.GetSpells())), nil
}
