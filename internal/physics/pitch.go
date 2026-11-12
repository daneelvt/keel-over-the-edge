// SPDX-License-Identifier: AGPL-3.0-only

package physics

// Pitch from the rig, on a boat whose rig pitches her (Params.RigPitch): a
// beach catamaran, with little volume in her bows. Her sails drive her
// from high above her centre of gravity and her hulls' resistance holds
// her back from below it, so the two pitch her bow down, against her
// waterplane's spring to the water's surface (float). Her sailor steps aft
// as a beach cat's crew does in a breeze, to hold the bows up. Pressed
// past where the lee bow's deck meets the water, the bows bury: they have
// no more volume to give, so the spring weakens, and the buried bows drag
// her to a stop. Past the pitchpole angle the sailor is thrown off over
// the bow. Every other boat's pitch is the waves' alone.

// buried returns how far the lee bow is pressed past where its deck meets
// the water, rad: the trim off the water's surface, bow down, past
// bowBury, which the lee hull reaches sooner as it takes the whole weight
// with the windward hull clear, flying of the way.
func (b *Prepared) buried(s *State, v *wave, flying float64) float64 {
	down := v.ahead - s.Pitch
	return max2(down-(b.bowBury-float64(flying*b.flyingSink)), 0)
}

// rigMoment returns the moment of the sails' drive about the centre of
// gravity, from their centre of effort above it, and of the hull's
// resistance, from below it: positive bow down, N·m.
func (b *Prepared) rigMoment(sail *sailResult, kite *kiteResult, g *rig, resistance float64) float64 {
	m := float64(-sail.drive*g.effortZ) + float64(resistance*b.hullZ)
	if b.kite {
		m -= float64(kite.drive * float64(0.5*(b.kiteFootZ+b.kiteHeadZ)))
	}
	return m
}

// stepAft moves the sailor toward the place aft of their own whose weight
// balances the rig's moment bow down, from their place to aftReach aft
// of it, as the hike moves them across: at no more than the hike's speed
// and with its lag. Out of the boat they are nowhere aft.
func (b *Prepared) stepAft(s *State, moment, dt float64) {
	if s.SailorMode != Sailing && s.SailorMode != Climbing {
		s.SailorAft = 0
		return
	}
	target := clamp(moment/b.sailorWeight, 0, b.aftReach)
	rate := clamp(float64((target-s.SailorAft)*b.invHikeLag), -b.hikeSpeed, b.hikeSpeed)
	s.SailorAft += float64(rate * dt)
}

// pitchSpring returns the waterplane's spring toward the water's surface
// at trim, the pitch off it, positive bow up: ρ g I_L × trim, its slope
// falling to buryRestoring of itself past where the bows bury.
func (b *Prepared) pitchSpring(trim, flying float64) float64 {
	bury := b.bowBury - float64(flying*b.flyingSink)
	if !(trim < -bury) {
		return float64(b.pitchStiffness * trim)
	}
	return float64(b.pitchStiffness * (float64(b.buryRestoring*(trim+bury)) - bury))
}

// pitchpoled reports whether the boat is pitched past the pitchpole angle,
// bow down off the water's surface.
func (b *Prepared) pitchpoled(s *State, v *wave) bool {
	return b.rigPitch && v.ahead-s.Pitch > b.pitchpoleAngle
}
