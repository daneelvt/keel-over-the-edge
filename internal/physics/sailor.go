// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The sailor does what a dinghy sailor does without thinking: hikes to keep
// the boat flat, flattens the sail as the wind rises, moves across in tacks
// and gybes, and, after a capsize, swims to the daggerboard and rights the
// boat. The player steers and trims the sheet. The sailor is the same for
// every player.

// hike moves the sailor toward the position y* that balances the roll moment
// of everything else, with a little feedback on heel and roll rate:
// y* = −K/(W cos φ) − k_φ φ − k_p p. A sailor who only moved against the
// heel would set the boat rolling; one who balances the moments settles at
// once. The sailor moves at no more than HikeSpeed and with a lag, and
// reaches HikeReach out to windward (the side away from the boom) but only
// LeeReach to leeward. Measured on a Laser, hiking sailors hold their centre
// of mass about 0.8 m out (Schütz and others 2011); Day (2017) bounds it at
// 0.95 × 0.55 × the sailor's height.
func (b *Prepared) hike(s *State, others, cosHeel, dt float64) {
	// Climbing back in, the sailor uses their weight on the gunwale the same
	// way, to stop the boat rolling on over.
	if s.SailorMode != Sailing && s.SailorMode != Climbing {
		return
	}
	target := ((-others / (b.sailorWeight * max2(cosHeel, 0.2))) - float64(b.heelGain*s.Heel)) - float64(b.rollRateGain*s.RollRate)
	lo, hi := -b.leeReach, b.leeReach
	if s.Boom > 0 {
		lo = -b.hikeReach
	} else if s.Boom < 0 {
		hi = b.hikeReach
	}
	target = clamp(target, lo, hi)
	rate := clamp(float64((target-s.Sailor)*b.invHikeLag), -b.hikeSpeed, b.hikeSpeed)
	s.Sailor += float64(rate * dt)
}

// sailorMoment returns the roll moment of the sailor's weight beyond what the
// righting lever already counts, which is the sailor seated on the
// centreline. In the water the sailor weighs nothing on the boat; on the
// daggerboard, their weight rights it.
func (b *Prepared) sailorMoment(s *State, sinHeel, cosHeel float64) float64 {
	switch s.SailorMode {
	case Sailing, Climbing:
		return float64(float64(b.sailorWeight*s.Sailor) * cosHeel)
	case InWater:
		return float64(-float64(b.sailorWeight*b.seatHeight) * sinHeel)
	}
	return float64(-float64(b.sailorWeight*(b.boardReach+b.seatHeight)) * sinHeel)
}

// sailorDamping returns the roll damping of a sailor in the water holding on
// to the boat.
func (b *Prepared) sailorDamping(s *State) float64 {
	if s.SailorMode == Sailing {
		return 0
	}
	return b.sailorDrag
}

// sailorModes moves the sailor through a capsize. Past the fall-out heel, to
// either side, the sailor falls in; swims to the daggerboard; stands on it
// until the boat comes up; and climbs back in.
func (b *Prepared) sailorModes(s *State, dt float64) {
	heel := math.Abs(s.Heel)
	switch s.SailorMode {
	case Sailing, Climbing:
		if heel > b.fallOutHeel {
			s.SailorMode, s.SailorTimer, s.Sailor = InWater, b.swimTime, 0
			return
		}
		if s.SailorMode == Climbing {
			s.SailorTimer -= dt
			if !(s.SailorTimer > 0) {
				s.SailorMode, s.SailorTimer = Sailing, 0
			}
		}
	case InWater:
		s.SailorTimer -= dt
		if !(s.SailorTimer > 0) {
			s.SailorTimer = 0
			s.SailorMode = OnBoard
			if heel < b.climbInHeel {
				s.SailorMode, s.SailorTimer = Climbing, b.climbTime
			}
		}
	default:
		if heel < b.climbInHeel {
			s.SailorMode, s.SailorTimer = Climbing, b.climbTime
		}
	}
}

func max2(a, b float64) float64 {
	if b > a {
		return b
	}
	return a
}
