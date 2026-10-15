// SPDX-License-Identifier: AGPL-3.0-only

package catalog

import "github.com/daneelvt/keel-over-the-edge/internal/physics"

// GroundParams returns the catalog's world values for a boat meeting the
// ground as the physics package's GroundParams: each surface's friction
// by its index, and the grounding group.
func GroundParams(c *Catalog) physics.GroundParams {
	var p physics.GroundParams
	for i, s := range c.World.Surfaces {
		if i < physics.GroundSurfaces {
			p.Friction[i] = s.Friction
		}
	}
	g := &c.World.Grounding
	p.StillSpeed = g.StillSpeed
	p.StillTime = g.StillTime
	p.PushDepth = g.PushDepth
	p.PushReach = g.PushReach
	p.Restitution = g.Restitution
	p.LandFriction = g.Friction
	return p
}

// ShelterParams returns the catalog's world values for the land's shelter
// as the physics package's ShelterParams.
func ShelterParams(c *Catalog) physics.ShelterParams {
	s := &c.World.Shelter
	var p physics.ShelterParams
	p.Reach = s.Reach
	p.Step = s.Step
	p.Near = s.Near
	p.Far = s.Far
	p.Least = s.Least
	p.Most = s.Most
	p.SpeedUp = s.SpeedUp
	p.Flank = s.Flank
	p.Turn = s.Turn
	copy(p.Offsets[:], s.Offsets)
	return p
}

// PrepareGround readies the catalog's grounding for the physics.
func (c *Catalog) PrepareGround() *physics.GroundPrepared {
	p := GroundParams(c)
	g := new(physics.GroundPrepared)
	physics.PrepareGround(&p, g)
	return g
}
