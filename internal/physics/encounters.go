// SPDX-License-Identifier: AGPL-3.0-only

package physics

// EncounterPrepared holds the encounters' constants as contacts, the
// shadow and the Articles use them, derived from EncounterParams by
// PrepareEncounters.
type EncounterPrepared struct {
	// Contact.
	restitution float64
	friction    float64
	passes      int32
	slop        float64
	push        float64
	cap         float64
	apart       int32

	// Shadow.
	deficit         float64
	near            float64
	invNear         float64
	invWidth2       float64 // 1/w²
	header          float64 // rad
	deflection      [2]float64
	deflectionAt    [2]float64 // rad
	invDeflectionAt float64
	reach           float64
	taper           float64
	invTaper        float64 // 1 / (reach − taper)
	sources         int32

	// Articles.
	room       float64 // ticks
	turn       float64 // rad
	courseRate float64 // the share of the heading's difference from the course a tick closes
	pairs      float64 // hull lengths
	headToWind float64 // rad
}

// CourseSettled is the most ticks Course.Settled counts.
const CourseSettled = 1 << 16

// MaxSources is the most wakes a boat feels at once, whatever the catalog
// says.
const MaxSources = 8

// ClientWakes is how many wakes a client may offer its module's step.
const ClientWakes = 16

// shadowAcross is the widest a wake is felt, as c²/(w² s^(2/3)): the loss
// there is e^(−9) of the axis's.
const (
	shadowAcross     = 9
	shadowAcrossFade = 6 // the loss fades to nothing from here
)

// PrepareEncounters derives the encounters' constants from their params.
func PrepareEncounters(p *EncounterParams, e *EncounterPrepared) {
	e.restitution = p.Restitution
	e.friction = p.Friction
	e.passes = toInt32(p.Passes)
	e.slop = p.Slop
	e.push = p.Push
	e.cap = p.Cap
	e.apart = toInt32(p.Apart)

	e.deficit = p.Deficit
	e.near = p.Near
	e.invNear = 1 / p.Near
	e.invWidth2 = 1 / float64(p.Width*p.Width)
	e.header = float64(p.Header * degree)
	e.deflection = [2]float64{float64(p.Deflection[0] * degree), float64(p.Deflection[1] * degree)}
	e.deflectionAt = [2]float64{float64(p.DeflectionAt[0] * degree), float64(p.DeflectionAt[1] * degree)}
	e.invDeflectionAt = 1 / (e.deflectionAt[1] - e.deflectionAt[0])
	e.reach = p.Reach
	e.taper = p.Taper
	e.invTaper = 1 / (p.Reach - p.Taper)
	e.sources = min(max(toInt32(p.Sources), 0), MaxSources)

	e.room = float64(p.Room * StepsPerSecond)
	e.turn = float64(p.Turn * degree)
	e.courseRate = Dt / p.Course
	e.pairs = p.Pairs
	e.headToWind = float64(p.HeadToWind * degree)
}

// Apart is how many ticks two boats must be apart before touching again is
// a new bump.
func (e *EncounterPrepared) Apart() int64 { return int64(e.apart) }

// Reach is the furthest a boat of kind b casts a wake, m: its rig's full
// height times the shadow's reach, with the sail's centre of effort's
// offset from the boat's centre.
func (e *EncounterPrepared) Reach(b *Prepared) float64 {
	return float64(e.reach*b.mastHeight) + b.outline.radius
}
