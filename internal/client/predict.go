// SPDX-License-Identifier: AGPL-3.0-only

package client

import (
	"cmp"
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

// Ring is how many ticks of prediction the client keeps.
const Ring = 64

// The corrections drawn at once rather than eased away.
const (
	SnapDistance = 3.0                // metres
	SnapHeading  = 20 * math.Pi / 180 // radians
)

type ringEntry struct {
	tick  int64
	in    Input
	state physics.State
}

// Predictor steps the player's boat ahead of the server with the same
// physics, keeping what it stepped; each snapshot is compared with the
// prediction of its tick, and when they differ the boat is put back to the
// server's state and stepped again to the present with the controls kept
// (client-side prediction and server reconciliation). It is
// client/src/predict/predictor.ts's twin.
type Predictor struct {
	kind *physics.Prepared
	// Seas is the sea the boat is stepped in, from the server's SeaAreas;
	// Weather the spells of weather, from its WeatherSystems.
	Seas    *Seas
	Weather physics.Weather
	Started bool
	Tick    int64 // the tick State is after
	State   physics.State
	ring    [Ring]ringEntry
	out     physics.Out
	wind    physics.WeatherTick
	// Encounters, if not nil, have each step sail in the shadow of the
	// boats the snapshots show near, as Wakes approximates it.
	Encounters *physics.EncounterPrepared
	Wakes      Wakes
	// Shadowed counts the steps a wake reached the boat in.
	Shadowed int
	// Ground and Shelter are the land the boat is stepped on and the wind
	// sheltered by, as far as the client holds its chunks; nil is the open
	// sea, as is a chunk not held.
	Ground  *physics.Ground
	Shelter *physics.Shelter
	// Circulation is the world's way round the disk, from the Welcome,
	// for the current the boat is stepped in.
	Circulation float64
	// Over is the tick the boat went over the lip, 0 while it is afloat:
	// it is held where it went over, not stepped, until a snapshot puts
	// it back at the start.
	Over int64
	// Stays: the boat stays where it is while its owner's free camera
	// roams, held as the server holds it, not stepped, until a snapshot
	// lets it go.
	Stays bool
}

// NewPredictor predicts a boat of kind in the sea of waves, with which the
// kind was prepared, and in the wind computed with weather; with no waves,
// in flat water. Until the server sends its spells of weather, there is no
// wind.
func NewPredictor(kind *physics.Prepared, waves *physics.Waves, weather *physics.WeatherPrepared) *Predictor {
	return &Predictor{kind: kind, Seas: NewSeas(waves, weather), Weather: physics.Weather{Prepared: weather}}
}

// ReceiveWeather takes a WeatherSystems: its spells replace those held,
// unless it keeps them, and its keyframes join those held, each replacing
// any of its tick, the latest physics.KeySets kept.
func (p *Predictor) ReceiveWeather(m *pb.WeatherSystems) error {
	var keys [physics.KeySets]physics.Keyframe
	nk, err := protocol.KeyframesOf(m, keys[:])
	if err != nil {
		return err
	}
	if !m.GetKeepSpells() {
		var spells [physics.WeatherSpells]physics.Spell
		n, err := protocol.SpellsOf(m, &spells)
		if err != nil {
			return err
		}
		p.Weather.Set(spells[:n])
	}
	if nk > 0 {
		held := slices.Clone(p.Weather.Keys[:p.Weather.NKeys])
		for _, k := range keys[:nk] {
			held = slices.DeleteFunc(held, func(h physics.Keyframe) bool { return h.Tick == k.Tick })
			held = append(held, k)
		}
		slices.SortFunc(held, func(a, b physics.Keyframe) int { return cmp.Compare(a.Tick, b.Tick) })
		p.Weather.SetKeys(held[max(len(held)-physics.KeySets, 0):])
	}
	p.wind.Tick = math.NaN()
	return nil
}

// Reset puts the boat at a snapshot's state, forgetting what was predicted.
func (p *Predictor) Reset(sn *protocol.Snapshot) {
	p.Started, p.Tick, p.State, p.Over, p.Stays = true, sn.Tick, sn.State, sn.Over, sn.Stays
	for i := range p.ring {
		p.ring[i].tick = math.MinInt64
	}
}

// step steps the boat into tick, in the wind and the current at its place
// and the sea of that tick, as the server does; a boat over the lip is
// held, as is one that stays.
func (p *Predictor) step(tick int64, in Input) {
	if p.Over != 0 || p.Stays {
		return
	}
	w := bus.Pack(0, in.Helm, in.Sheet, 0)
	c := physics.Control{Helm: w.Helm(), Sheet: w.Sheet()}
	c.Pilot, c.Target, c.Order, c.Way = in.Pilot(0, 0).Control()
	if p.wind.Tick != float64(tick) {
		physics.WeatherAt(&p.Weather, &p.wind, float64(tick))
	}
	e := physics.WindAt(&p.wind, p.State.X, p.State.Y, p.Shelter)
	e.CurrentEast, e.CurrentNorth = physics.CurrentAt(p.Weather.Prepared, p.Circulation, p.State.X, p.State.Y, p.Ground)
	if p.Encounters != nil {
		if p.Wakes.Shadow(&e, p.State.X, p.State.Y, tick, &p.Weather, p.kind, p.Encounters) > 0 {
			p.Shadowed++
		}
	}
	physics.Step(&p.State, &c, &e, p.Seas.At(tick, p.Shelter), p.Ground, p.kind, &p.out)
	if physics.OverEdge(p.Weather.Prepared, p.State.X, p.State.Y) {
		p.Over = tick
	}
}

// Wind is the wind at the boat at the tick its state is after, in full.
func (p *Predictor) Wind() physics.WindPoint {
	var t physics.WeatherTick
	physics.WeatherAt(&p.Weather, &t, float64(p.Tick))
	var w physics.WindPoint
	physics.WindPointAt(&t, p.State.X, p.State.Y, &w, p.Shelter)
	return w
}

// Out is what the last step derived: the boat's instruments, and the
// helm its autopilot set.
func (p *Predictor) Out() *physics.Out { return &p.out }

// Step steps the next tick with these controls, at the controls'
// resolution.
func (p *Predictor) Step(in Input) {
	p.step(p.Tick+1, in)
	p.Tick++
	p.ring[p.Tick%Ring] = ringEntry{tick: p.Tick, in: in, state: p.State}
}

// Outcome is what a snapshot did to the prediction.
type Outcome struct {
	// Stale: the snapshot is older than the prediction kept, and changed
	// nothing; Reset: the prediction started again from it.
	Stale     bool
	Reset     bool
	Corrected bool
	// Distance and Heading are how far the boat at the present tick moved
	// in the replay: what is eased away, or drawn at once over the snap
	// thresholds.
	Distance, Heading float64
}

// Snapshot reconciles the prediction with the server's state at a
// snapshot's tick. A snapshot older than the ticks kept, held up on the
// way, is let go: putting the boat back to it would throw it back seconds,
// and the next snapshot reconciles. One newer than the prediction, or of a
// tick not yet predicted since the last reset, starts the prediction
// again from it.
//
// While the server's boat falls over the lip its snapshots say since when:
// the prediction is held where the server's boat went over, as it would
// have held it had it gone over on the same tick. A snapshot after the fall
// with no fall in it is the boat back at the start, and the prediction
// starts again from it. A boat that stays while its owner's free camera
// roams is held so too, and the first snapshot that lets it go starts the
// prediction again from it.
func (p *Predictor) Snapshot(sn *protocol.Snapshot) Outcome {
	if p.Started && sn.Tick <= p.Tick-Ring {
		return Outcome{Stale: true}
	}
	e := &p.ring[sn.Tick%Ring]
	if !p.Started || sn.Tick > p.Tick || e.tick != sn.Tick || p.Over != 0 && sn.Over == 0 && sn.Tick > p.Over || p.Stays && !sn.Stays {
		p.Reset(sn)
		return Outcome{Reset: true}
	}
	if sn.Over != 0 || sn.Stays {
		if p.Over == sn.Over && p.Stays == sn.Stays && sameBits(&p.State, &sn.State) {
			return Outcome{}
		}
		before := p.State
		p.Over, p.Stays, p.State = sn.Over, sn.Stays, sn.State
		for t := sn.Tick; t <= p.Tick; t++ {
			p.ring[t%Ring].state = sn.State
		}
		return Outcome{
			Corrected: true,
			Distance:  math.Hypot(before.X-p.State.X, before.Y-p.State.Y),
			Heading:   math.Abs(math.Remainder(before.Heading-p.State.Heading, 2*math.Pi)),
		}
	}
	if sameBits(&e.state, &sn.State) {
		return Outcome{}
	}
	before := p.State
	p.State = sn.State
	p.Over = 0
	e.state = sn.State
	for t := sn.Tick + 1; t <= p.Tick; t++ {
		r := &p.ring[t%Ring]
		p.step(t, r.in)
		r.state = p.State
	}
	return Outcome{
		Corrected: true,
		Distance:  math.Hypot(before.X-p.State.X, before.Y-p.State.Y),
		Heading:   math.Abs(math.Remainder(before.Heading-p.State.Heading, 2*math.Pi)),
	}
}

// Over says whether a correction is drawn at once.
func (o Outcome) Over() bool { return o.Distance > SnapDistance || o.Heading > SnapHeading }

func sameBits(a, b *physics.State) bool {
	pa, pb := sim.StateFields(a), sim.StateFields(b)
	for i := range pa {
		if math.Float64bits(*pa[i]) != math.Float64bits(*pb[i]) {
			return false
		}
	}
	return true
}
