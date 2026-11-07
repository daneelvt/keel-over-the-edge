// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// lookWait is the longest a change of look waits for the world's answer.
const lookWait = 5 * time.Second

// errLookBusy is a change of look the world did not answer in time.
var errLookBusy = errors.New("the world did not answer a change of look")

// changeLook changes the look of an account's boat in the world sailed, as
// the simulation finds it: in Port Royal's harbour, changed; at sea beyond
// it, kept; with no boat afloat, or between worlds, ashore.
func (p *process) changeLook(ctx context.Context, id store.AccountID, code uint32) (api.LookPlace, error) {
	h := p.current.Load()
	if h == nil {
		return api.Ashore, nil
	}
	reply := make(chan bus.Reply, 1)
	if err := h.bus.Commands.Players().TrySend(bus.Command{Op: bus.SetLook, Account: bus.Account(id), Look: code, Reply: reply}); err != nil {
		return api.Ashore, err
	}
	ctx, cancel := context.WithTimeout(ctx, lookWait)
	defer cancel()
	select {
	case r := <-reply:
		switch {
		case r.Result == bus.Away:
			return api.Away, nil
		case r.Result == bus.Done && r.Slot >= 0:
			return api.InHarbour, nil
		}
		return api.Ashore, nil
	case <-ctx.Done():
		return api.Ashore, errLookBusy
	}
}

// lookSeat is the play routes' hand on looks in the world sailed.
type lookSeat struct{ p *process }

func (s lookSeat) ChangeLook(ctx context.Context, id store.AccountID, code uint32) (api.LookPlace, error) {
	return s.p.changeLook(ctx, id, code)
}

// lookCode is an account's sailor's look as the world holds it.
func (p *process) lookCode(a store.Account) uint32 {
	return p.looks.Code(p.looks.Resolve(a.ID, a.Look))
}

// worldBus is the world sailed's bus, or nil between worlds.
func (p *process) worldBus() *bus.Bus {
	if h := p.current.Load(); h != nil {
		return h.bus
	}
	return nil
}

// boatOf is the boat of its fleet a sailor takes to sea as they connect.
func (p *process) boatOf(ctx context.Context, a store.Account) edge.Boat {
	j := p.fleet.ForJoin(ctx, a.ID)
	return edge.Boat{Kind: j.Kind, Look: j.Look, Name: j.Name}
}
