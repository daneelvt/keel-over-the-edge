// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math/bits"

// A boat in waves. The hull does not feel the sea at a point: it feels the
// surface averaged over its waterplane, and the slope of the plane that fits
// that surface best, along the hull and across it. This is Grim's effective
// wave (Grim 1961), which the stability criteria in waves are built on with
// the Froude–Krylov approximation. For one wave of amplitude a over a
// waterplane of length L and beam B the average and the fitted slopes have
// closed forms: with u = k_x L/2 and v = k_y B/2, k_x along the hull and k_y
// across it,
//
//	height        a S(u) S(v) sin ψ
//	slope ahead   a k_x G(u) S(v) cos ψ
//	slope across  a k_y S(u) G(v) cos ψ
//
// with S and G as averages (fmath.go) has them. A wave much longer than the
// hull passes unchanged; one as long as the hull averages to nothing, so a
// long hull rides over the chop that tosses a short one.
//
// From the effective wave come every force of the waves on the boat, each
// the long-wave limit of the real one (Faltinsen, Sea Loads on Ships and
// Offshore Structures, 1990):
//
//   - Heave and pitch: the hull floats on its waterplane as a mass on a
//     spring, ρ g A_wp toward the surface's height and ρ g I_L toward its
//     slope, with added mass and damping.
//   - Roll: the hull rights itself toward the surface, not toward the
//     horizon, so the righting lever is read at the heel off the surface.
//   - Surge and sway: the water under a slope accelerates down it at g times
//     the slope, and carries the boat and its added mass with it. This
//     Froude–Krylov force is what makes a boat surf. Its moment along the
//     hull turns a boat broadside on a wave's face, as far as the kind
//     takes it (waveLoads).
//   - The water itself moves, forward on the crests and back in the troughs:
//     the hull's resistance and the foils feel the flow through the water,
//     not over the ground.

// wave is the effective wave under a hull, in the heading frame, read once
// at the start of a step and carried across its substeps by its rates.
type wave struct {
	height, heightRate float64 // m, m/s
	ahead, aheadRate   float64 // the slope rising toward the bow, and per second
	across, acrossRate float64 // the slope rising toward starboard
	twist              float64 // the sway force's moment along the hull, per unit of that force, m
	waterX, waterY     float64 // the water's velocity at the surface, ahead and to starboard, m/s
	foilX, foilY       float64 // and at the foils' depth
	// The current, east and north, m/s, which the hull and foils feel with
	// the waves' motion; current is whether there is any.
	current                   bool
	currentEast, currentNorth float64
}

// read sets v to the effective wave under a hull at the boat's position and
// heading, whose sine and cosine are sinH and cosH, over a waterplane of
// half-length halfLength and half-beam halfBeam. decay is how much of each
// wave's motion reaches the foils; with none the water's motion there is
// left out. It leaves the twist per unit of the lever L²/12.
//
// The rates are those the hull meets: it moves through the waves, so each
// wave's phase passes it at k·V − ω, not at −ω.
func (v *wave) read(sea *Sea, s *State, sinH, cosH, halfLength, halfBeam float64, decay *[SeaComponents]float64) {
	w, win, t := sea.Waves, sea.Window, sea.Tick
	sw, se, nw, ne, wx, wy := win.corners(s.X, s.Y)
	// The waves of the four areas, ascending.
	for k := range int32(SeaWords) {
		for word := win.word(k, sw, se, nw, ne); word != 0; word &= word - 1 {
			i := k*64 + int32(bits.TrailingZeros64(word))
			a := blend(win.Amp, sw+i, se+i, nw+i, ne+i, wx, wy)
			if !(a > 0) {
				continue
			}
			ke, kn := w.kEast[i], w.kNorth[i]
			psi := (w.Phase[i] + (float64(ke*s.X) + float64(kn*s.Y))) - t.Phase[i]
			kx := float64(ke*sinH) + float64(kn*cosH)
			ky := float64(ke*cosH) - float64(kn*sinH)
			sin, cos := SinCos(psi)
			su, gu := averages(float64(kx * halfLength))
			sv, gv := averages(float64(ky * halfBeam))
			as, ac := float64(a*sin), float64(a*cos)
			rate := (float64(kx*s.Surge) + float64(ky*s.Sway)) - w.Omega[i]

			mean := float64(su * sv)
			v.height += float64(mean * as)
			v.heightRate += float64(float64(mean*rate) * ac)
			along := float64(float64(kx*gu) * sv)
			v.ahead += float64(along * ac)
			v.aheadRate -= float64(float64(along*rate) * as)
			athwart := float64(float64(ky*su) * gv)
			v.across += float64(athwart * ac)
			v.acrossRate -= float64(float64(athwart*rate) * as)
			v.twist += float64(float64(along*ky) * as)

			// The water at a crest moves the way the wave travels, at a ω: along
			// the hull that is a ω k_x / k, and ω / k is the wave's speed.
			orbit := float64(float64(w.speed[i]*mean) * as)
			ox, oy := float64(orbit*kx), float64(orbit*ky)
			v.waterX += ox
			v.waterY += oy
			if decay != nil {
				v.foilX += float64(ox * decay[i])
				v.foilY += float64(oy * decay[i])
			}
		}
	}
}

// scale scales the wave by f: its height, slopes and their rates, the
// twist and the water's motion, as waves f times as high would have them.
func (v *wave) scale(f float64) {
	v.height, v.heightRate = float64(v.height*f), float64(v.heightRate*f)
	v.ahead, v.aheadRate = float64(v.ahead*f), float64(v.aheadRate*f)
	v.across, v.acrossRate = float64(v.across*f), float64(v.acrossRate*f)
	v.twist = float64(v.twist * f)
	v.waterX, v.waterY = float64(v.waterX*f), float64(v.waterY*f)
	v.foilX, v.foilY = float64(v.foilX*f), float64(v.foilY*f)
}

// capDepth scales the wave under a boat at (x, y) by the land's lee there
// (lee.go) and then by the depth's cap (sea.go), if the ground g caps what
// the lee leaves.
func (v *wave) capDepth(sea *Sea, g *Ground, x, y float64) {
	lee := LeeAt(sea, x, y)
	if lee != 1 {
		v.scale(lee)
	}
	if g == nil {
		return
	}
	if f := depthFactor(sea.Waves, g, x, y, float64(sea.hsAt(x, y)*lee)); f < 1 {
		v.scale(f)
	}
}

// advance carries the wave forward by dt seconds.
func (v *wave) advance(dt float64) {
	v.height += float64(v.heightRate * dt)
	v.ahead += float64(v.aheadRate * dt)
	v.across += float64(v.acrossRate * dt)
}

// waveLoads adds the push of the surface's slope on the hull and its added
// mass, down the slope, and the kind's share of its moment along the hull.
//
// The moment is that of the push spread evenly along the waterline: it yaws
// the hull as the water of an oblique wave shears, a few degrees each way in
// a chop. Nothing here opposes it but the foils, which give little under a
// knot or two, when the moment is several times the rudder's. A slow boat
// with its sail on the edge of luffing is shaken off its last drive, stops,
// and with no flow over the rudder cannot be steered away again. A kind sets
// its share (Params.WaveYaw) with that in mind.
func (b *Prepared) waveLoads(v *wave, l *loads) {
	l.X -= float64(b.waveSurge * v.ahead)
	l.Y -= float64(b.waveSway * v.across)
	l.N += float64(b.waveYaw * v.twist)
}

// float integrates the heave and the pitch over dt: the hull on its
// waterplane, sprung toward the effective surface and damped by how fast it
// moves against it.
func (b *Prepared) float(s *State, v *wave, dt float64) {
	lift := float64(b.heaveStiffness*(s.Heave-v.height)) + float64(b.heaveDamping*(s.HeaveRate-v.heightRate))
	s.HeaveRate -= float64(float64(lift*b.invHeaveMass) * dt)
	s.Heave += float64(s.HeaveRate * dt)
	trim := float64(b.pitchStiffness*(s.Pitch-v.ahead)) + float64(b.pitchDamping*(s.PitchRate-v.aheadRate))
	s.PitchRate -= float64(float64(trim*b.invPitchInertia) * dt)
	s.Pitch += float64(s.PitchRate * dt)
}

// EffectiveWave is the sea under a hull, for drawing a boat a client does
// not step.
type EffectiveWave struct {
	Height float64 // the surface averaged over the waterplane, m
	Ahead  float64 // its slope, rising toward the bow
	Across float64 // and rising toward starboard
}

// WaveUnder returns the effective wave under a hull at (x, y) heading
// heading, at rest, whose waterplane is length long and beam wide, in the
// land's lee and capped by the depth of the ground g there, or nil for the
// open sea.
func WaveUnder(sea *Sea, g *Ground, length, beam, x, y, heading float64) EffectiveWave {
	var v wave
	s := State{X: x, Y: y}
	sinH, cosH := SinCos(heading)
	v.read(sea, &s, sinH, cosH, float64(0.5*length), float64(0.5*beam), nil)
	v.capDepth(sea, g, x, y)
	return EffectiveWave{Height: v.height, Ahead: v.ahead, Across: v.across}
}
