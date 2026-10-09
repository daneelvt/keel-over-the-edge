// SPDX-License-Identifier: AGPL-3.0-only

package client

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
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
	tick        int64
	helm, sheet uint16
	state       physics.State
}

// Predictor steps the player's boat ahead of the server with the same
// physics, keeping what it stepped; each snapshot is compared with the
// prediction of its tick, and when they differ the boat is put back to the
// server's state and stepped again to the present with the controls kept
// (client-side prediction and server reconciliation). It is
// client/src/predict/predictor.ts's twin.
type Predictor struct {
	kind    *physics.Prepared
	Started bool
	Tick    int64 // the tick State is after
	State   physics.State
	Wind    bus.Wind
	ring    [Ring]ringEntry
	out     physics.Out
}

// NewPredictor predicts a boat of kind.
func NewPredictor(kind *physics.Prepared) *Predictor { return &Predictor{kind: kind} }

// Reset puts the boat at a snapshot's state, forgetting what was predicted.
func (p *Predictor) Reset(sn *protocol.Snapshot) {
	p.Started, p.Tick, p.State, p.Wind = true, sn.Tick, sn.State, sn.Wind
	for i := range p.ring {
		p.ring[i].tick = math.MinInt64
	}
}

func (p *Predictor) step(helm, sheet uint16) {
	w := bus.Pack(0, helm, sheet, 0)
	c := physics.Control{Helm: w.Helm(), Sheet: w.Sheet()}
	e := physics.Env{WindSpeed: p.Wind.Speed, WindFrom: p.Wind.From}
	physics.Step(&p.State, &c, &e, p.kind, &p.out)
}

// Step steps the next tick with these controls, at the controls'
// resolution.
func (p *Predictor) Step(helm, sheet uint16) {
	p.step(helm, sheet)
	p.Tick++
	p.ring[p.Tick%Ring] = ringEntry{tick: p.Tick, helm: helm, sheet: sheet, state: p.State}
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
func (p *Predictor) Snapshot(sn *protocol.Snapshot) Outcome {
	if p.Started && sn.Tick <= p.Tick-Ring {
		return Outcome{Stale: true}
	}
	e := &p.ring[sn.Tick%Ring]
	if !p.Started || sn.Tick > p.Tick || e.tick != sn.Tick {
		p.Reset(sn)
		return Outcome{Reset: true}
	}
	p.Wind = sn.Wind
	if sameBits(&e.state, &sn.State) {
		return Outcome{}
	}
	before := p.State
	p.State = sn.State
	e.state = sn.State
	for t := sn.Tick + 1; t <= p.Tick; t++ {
		r := &p.ring[t%Ring]
		p.step(r.helm, r.sheet)
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
