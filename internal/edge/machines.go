// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"errors"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Machine sailors and sailing together. No machine sailor's boat takes a
// person aboard but its owner, who comes aboard without knocking: the
// boat is theirs. The owner comes aboard from watching it (ComeAboard),
// and is crew there as anyone let aboard is; chat's rule lets their lines
// and their machine sailor's reach each other.

// comeAboardCommand brings the connection's account aboard the boat of
// the machine sailor of its own that it watches, as crew. It is told how
// it stands as a knocker is.
func (c *conn) comeAboardCommand() {
	e := c.e
	name := c.watched.Load()
	if !c.spectating.Load() || name == nil || e.cfg.Watch == nil || e.cfg.Knocker == nil {
		c.knocked(pb.KnockState_KNOCK_STATE_CLOSED, "", 0, "")
		return
	}
	ctx, cancel := context.WithTimeout(e.ctx, DeckLookup)
	defer cancel()
	t, err := e.cfg.Watch(ctx, moderation.Key(*name))
	switch {
	case errors.Is(err, store.ErrNotFound):
		c.knocked(pb.KnockState_KNOCK_STATE_NOT_AT_SEA, *name, 0, "")
		return
	case err != nil:
		c.knocked(pb.KnockState_KNOCK_STATE_TRY_AGAIN, *name, 0, "")
		return
	case !t.Mine(store.AccountID(c.account)):
		// Nobody but its owner comes aboard a machine sailor's boat.
		c.knocked(pb.KnockState_KNOCK_STATE_CLOSED, t.Name, 0, "")
		return
	}
	who, err := e.cfg.Knocker(ctx, c.account)
	if err != nil {
		c.knocked(pb.KnockState_KNOCK_STATE_TRY_AGAIN, t.Name, 0, "")
		return
	}
	if !mayBoard(who, time.Now()) {
		c.knocked(pb.KnockState_KNOCK_STATE_FIRST, t.Name, 0, "")
		return
	}
	f := e.cfg.Bus.Frames.Acquire()
	s := findBoat(f, bus.Account(t.ID))
	var kn knock
	state := pb.KnockState_KNOCK_STATE_UNSPECIFIED
	if s < 0 {
		// Not in the water, or aboard another's boat: its owner comes
		// aboard only its own.
		state = pb.KnockState_KNOCK_STATE_NOT_AT_SEA
	} else {
		kn = knock{boat: f.Boat[s], skipper: f.Owner[s], by: c, name: who.Name, look: who.Look, skipperName: t.Name,
			kind: f.Kind[s], boatName: f.BoatName[s]}
		state = e.roomAboard(f, s)
	}
	f.Release()
	if state != pb.KnockState_KNOCK_STATE_UNSPECIFIED {
		c.knocked(state, t.Name, kn.kind, kn.boatName)
		return
	}
	e.decks.knowName(kn.skipper, t.Name)
	e.decks.knowName(c.account, who.Name)
	c.board(&kn)
}

// roomAboard is why the boat in slot s of f takes nobody more aboard, or
// unspecified while it may: boarding on for everyone, room aboard, and the
// crews across the world under their limit.
func (e *Edge) roomAboard(f *bus.Frame, s int32) pb.KnockState {
	if e.cfg.Switches != nil && !e.cfg.Switches.Boarding() {
		return pb.KnockState_KNOCK_STATE_CLOSED
	}
	lo, hi := f.CrewOf(s)
	if hi-lo+1 >= e.capacityOf(f.Kind[s]) {
		return pb.KnockState_KNOCK_STATE_FULL
	}
	if len(f.Crew) >= e.crewLimit() {
		return pb.KnockState_KNOCK_STATE_CROWDED
	}
	return pb.KnockState_KNOCK_STATE_UNSPECIFIED
}
