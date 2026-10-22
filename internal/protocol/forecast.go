// SPDX-License-Identifier: AGPL-3.0-only

package protocol

import (
	"fmt"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// Forecast is a forecast as the wire carries it, with its gale warning,
// nil for none.
func Forecast(f *physics.Forecast, gale *pb.GaleWarning) *pb.Forecast {
	h := &f.Head
	m := &pb.Forecast{Issue: int64(h.Issue), Steps: uint32(h.Steps), Step: uint32(h.Step), Gale: gale}
	steps := int(h.Steps)
	for i := range int(h.NSpells) {
		m.Spells = append(m.Spells, spellPB(&f.Spells[i]))
		m.Shifts = append(m.Shifts, uint32(h.Shifts[i]))
	}
	for i := range int(h.NSystems) {
		s := &f.Systems[i]
		ps := &pb.ForecastSystem{
			Slot: uint32(s.Slot), Kind: uint32(s.Kind), Seed: uint32(s.Seed), Size: uint32(s.Size), Peak: uint32(s.Peak),
			Depth: int32(s.Depth), Forming: s.Forming != 0,
			Crosses: int64(s.Crosses), CrossEast: int32(s.CrossEast), CrossNorth: int32(s.CrossNorth),
			East: make([]int32, steps), North: make([]int32, steps), Heading: make([]uint32, steps),
			Speed: make([]uint32, steps), Strength: make([]uint32, steps),
		}
		for k := range steps {
			ps.East[k], ps.North[k] = int32(s.East[k]), int32(s.North[k])
			ps.Heading[k], ps.Speed[k], ps.Strength[k] = uint32(s.Heading[k]), uint32(s.Speed[k]), uint32(s.Strength[k])
		}
		m.Systems = append(m.Systems, ps)
	}
	return m
}

// ForecastPast is what has been, as the wire carries it: the issue of
// ninety minutes before, the truth's keyframes since and the spells in
// play over them.
func ForecastPast(issue *pb.Forecast, truth []physics.Keyframe, spells []physics.Spell) *pb.ForecastPast {
	m := &pb.ForecastPast{Issue: issue}
	for i := range truth {
		m.Truth = append(m.Truth, keyframePB(&truth[i]))
	}
	for i := range spells {
		m.Spells = append(m.Spells, spellPB(&spells[i]))
	}
	return m
}

// ForecastOf reads a forecast off the wire into f: at most the steps,
// spells and systems a forecast holds, each system's steps one for each
// step, its numbers in their ranges.
func ForecastOf(m *pb.Forecast, f *physics.Forecast) error {
	*f = physics.Forecast{}
	steps := int(m.GetSteps())
	if steps < 1 || steps > physics.MaxForecastSteps || m.GetIssue() < -maxTick || m.GetIssue() > maxTick {
		return fmt.Errorf("protocol: a forecast of %d steps issued at %d", steps, m.GetIssue())
	}
	if len(m.GetSpells()) > physics.MaxForecastSpells || len(m.GetShifts()) != len(m.GetSpells()) || len(m.GetSystems()) > physics.MaxForecastSystems {
		return fmt.Errorf("protocol: a forecast of %d spells, %d shifts and %d systems", len(m.GetSpells()), len(m.GetShifts()), len(m.GetSystems()))
	}
	h := &f.Head
	h.Issue, h.Steps, h.Step = float64(m.GetIssue()), float64(steps), float64(m.GetStep())
	for i, p := range m.GetSpells() {
		if i > 0 && p.GetBegin() < m.GetSpells()[i-1].GetBegin() {
			return fmt.Errorf("protocol: the forecast's spell %d begins before the one before it", i)
		}
		if err := spellOf(p, &f.Spells[i]); err != nil {
			return fmt.Errorf("protocol: the forecast's spell %d %w", i, err)
		}
		h.Shifts[i] = float64(m.GetShifts()[i])
	}
	h.NSpells = float64(len(m.GetSpells()))
	for i, s := range m.GetSystems() {
		if s.GetSlot() >= physics.MaxSystems || len(s.GetEast()) != steps || len(s.GetNorth()) != steps ||
			len(s.GetHeading()) != steps || len(s.GetSpeed()) != steps || len(s.GetStrength()) != steps ||
			s.GetCrosses() < -maxTick || s.GetCrosses() > maxTick {
			return fmt.Errorf("protocol: the forecast's system %d is not one of its steps", i)
		}
		o := &f.Systems[i]
		o.Slot, o.Kind, o.Seed, o.Size, o.Peak = float64(s.GetSlot()), float64(s.GetKind()), float64(s.GetSeed()), float64(s.GetSize()), float64(s.GetPeak())
		o.Depth, o.Forming = float64(s.GetDepth()), bit(s.GetForming())
		o.Crosses, o.CrossEast, o.CrossNorth = float64(s.GetCrosses()), float64(s.GetCrossEast()), float64(s.GetCrossNorth())
		for k := range steps {
			o.East[k], o.North[k] = float64(s.GetEast()[k]), float64(s.GetNorth()[k])
			o.Heading[k], o.Speed[k], o.Strength[k] = float64(s.GetHeading()[k]), float64(s.GetSpeed()[k]), float64(s.GetStrength()[k])
		}
	}
	h.NSystems = float64(len(m.GetSystems()))
	return nil
}

// PastOf reads what has been off the wire: the truth's keyframes and the
// spells in play over them.
func PastOf(m *pb.ForecastPast) (truth []physics.Keyframe, spells []physics.Spell, err error) {
	truth = make([]physics.Keyframe, len(m.GetTruth()))
	for i, k := range m.GetTruth() {
		if i > 0 && k.GetTick() <= m.GetTruth()[i-1].GetTick() {
			return nil, nil, fmt.Errorf("protocol: the past's keyframe %d is out of order", i)
		}
		if err := keyframeOf(k, &truth[i]); err != nil {
			return nil, nil, fmt.Errorf("protocol: the past's keyframe %d: %w", i, err)
		}
	}
	spells = make([]physics.Spell, len(m.GetSpells()))
	for i, p := range m.GetSpells() {
		if err := spellOf(p, &spells[i]); err != nil {
			return nil, nil, fmt.Errorf("protocol: the past's spell %d %w", i, err)
		}
	}
	return truth, spells, nil
}
