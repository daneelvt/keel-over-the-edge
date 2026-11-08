// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// Shipmates, on the game connection. Two shipmates message each other
// wherever each is in the game (Say with to, through the hub's pair path),
// and one knocks on the boat the other skippers without a link (Knock
// with shipmate). Who is a shipmate is the hub's ties, in memory; the
// shipmates' list, its offers and its ending are the play routes', which
// ask the edge where a shipmate is (Presence), who sits in a seat aboard
// (PersonAt), and tell a connection its list has changed (Shipmates).

// Presence is where an account is in the game, as its shipmates may see
// it: in the game (sailing, aboard, watching or waiting), at sea (sailing
// or aboard), and skippering a boat at sea, which a shipmate may knock on.
type Presence struct {
	In, Sea, Skipper bool
}

// Presence is where the account is in the game now.
func (e *Edge) Presence(a bus.Account) Presence {
	c := e.registry.get(a)
	if c == nil || c.gone.Load() {
		return Presence{}
	}
	p := Presence{In: true, Sea: c.joined.Load() || c.crew.Load()}
	if c.joined.Load() {
		f := e.cfg.Bus.Frames.Acquire()
		p.Skipper = findBoat(f, a) >= 0
		f.Release()
	}
	return p
}

// PersonAt is the person in seat aboard the boat the account sails or is
// aboard, and whether they are a machine sailor; ok false for nobody
// there, or the account aboard nothing.
func (e *Edge) PersonAt(account bus.Account, seat uint32) (a bus.Account, machine, ok bool) {
	c := e.registry.get(account)
	if c == nil {
		return a, false, false
	}
	f := e.cfg.Bus.Frames.Acquire()
	defer f.Release()
	h, aboard := c.handsOf(f)
	if !aboard {
		return a, false, false
	}
	a, _, ok = e.personAt(f, h.slot, seat)
	return a, machineAt(f, h.slot, seat), ok
}

// Shipmates tells the account's connection, if it has one, that its
// shipmates have changed, never what or why, and tells it again who is
// aboard with it, for the shipmates' mark.
func (e *Edge) Shipmates(a bus.Account) {
	c := e.registry.get(a)
	if c == nil {
		return
	}
	c.recrew.Store(true)
	c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Shipmates{Shipmates: &pb.Shipmates{}}}, outChat)
}
