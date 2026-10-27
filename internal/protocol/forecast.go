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
	m := &pb.Forecast{
		Issue: int64(h.Issue), Steps: uint32(h.Steps), Step: uint32(h.Step), Gale: gale,
		Until: int64(h.Until), Every: uint32(h.Every), Origin: int64(h.Origin),
	}
	for i := range int(h.NSpells) {
		m.Spells = append(m.Spells, spellPB(&f.Spells[i]))
		m.Shifts = append(m.Shifts, uint32(h.Shifts[i]))
	}
	for i := range int(h.NSystems) {
		r := &f.Systems[i]
		m.Systems = append(m.Systems, &pb.ForecastSystem{
			Slot: uint32(h.Slots[i]), Kind: uint32(r.Kind), Seed: uint32(r.Seed), Size: uint32(r.Size), Peak: uint32(r.Peak),
			Depth: int32(r.Depth), Born: int64(r.Born), Mature: int64(r.Mature), Decays: int64(r.Decays), Gone: int64(r.Gone),
			Track: uint32(r.Track), East: int32(r.East), North: int32(r.North), Heading: uint32(r.Heading), Speed: uint32(r.Speed),
			Radius: uint32(r.Radius), Angle: uint32(r.Angle), Sense: int32(r.Sense), Inward: uint32(r.Inward), Length: uint32(r.Length),
			Wobble: uint32(r.Wobble), WobblePeriod: []uint32{uint32(r.WobblePeriod[0]), uint32(r.WobblePeriod[1])},
			WobblePhase: []uint32{uint32(r.WobblePhase[0]), uint32(r.WobblePhase[1])},
			Throb:       uint32(r.Throb), ThrobPeriod: uint32(r.ThrobPeriod), ThrobPhase: uint32(r.ThrobPhase),
		})
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
// spells and systems a forecast holds, each system in a slot of a
// keyframe's, its numbers in their ranges.
func ForecastOf(m *pb.Forecast, f *physics.Forecast) error {
	*f = physics.Forecast{}
	steps := int(m.GetSteps())
	if steps < 1 || steps > physics.MaxForecastSteps || !inTicks(m.GetIssue()) || !inTicks(m.GetUntil()) || !inTicks(m.GetOrigin()) {
		return fmt.Errorf("protocol: a forecast of %d steps issued at %d", steps, m.GetIssue())
	}
	if len(m.GetSpells()) > physics.MaxForecastSpells || len(m.GetShifts()) != len(m.GetSpells()) || len(m.GetSystems()) > physics.MaxForecastSystems {
		return fmt.Errorf("protocol: a forecast of %d spells, %d shifts and %d systems", len(m.GetSpells()), len(m.GetShifts()), len(m.GetSystems()))
	}
	h := &f.Head
	h.Issue, h.Steps, h.Step = float64(m.GetIssue()), float64(steps), float64(m.GetStep())
	h.Until, h.Every, h.Origin = float64(m.GetUntil()), float64(m.GetEvery()), float64(m.GetOrigin())
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
		if s.GetSlot() >= physics.MaxSystems || len(s.GetWobblePeriod()) != 2 || len(s.GetWobblePhase()) != 2 ||
			!inTicks(s.GetBorn()) || !inTicks(s.GetMature()) || !inTicks(s.GetDecays()) || !inTicks(s.GetGone()) {
			return fmt.Errorf("protocol: the forecast's system %d is not a record", i)
		}
		h.Slots[i] = float64(s.GetSlot())
		f.Systems[i] = physics.SystemRecord{
			Kind: float64(s.GetKind()), Seed: float64(s.GetSeed()),
			Born: float64(s.GetBorn()), Mature: float64(s.GetMature()), Decays: float64(s.GetDecays()), Gone: float64(s.GetGone()),
			Track: float64(s.GetTrack()), East: float64(s.GetEast()), North: float64(s.GetNorth()), Heading: float64(s.GetHeading()),
			Speed: float64(s.GetSpeed()), Radius: float64(s.GetRadius()), Angle: float64(s.GetAngle()), Sense: float64(s.GetSense()),
			Inward: float64(s.GetInward()), Size: float64(s.GetSize()), Peak: float64(s.GetPeak()), Depth: float64(s.GetDepth()),
			Length: float64(s.GetLength()), Wobble: float64(s.GetWobble()),
			WobblePeriod: [2]float64{float64(s.GetWobblePeriod()[0]), float64(s.GetWobblePeriod()[1])},
			WobblePhase:  [2]float64{float64(s.GetWobblePhase()[0]), float64(s.GetWobblePhase()[1])},
			Throb:        float64(s.GetThrob()), ThrobPeriod: float64(s.GetThrobPeriod()), ThrobPhase: float64(s.GetThrobPhase()),
		}
	}
	h.NSystems = float64(len(m.GetSystems()))
	return nil
}

// inTicks reports whether a tick is one a float64 holds exactly.
func inTicks(t int64) bool { return t >= -maxTick && t <= maxTick }

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
