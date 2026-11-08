// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/review"
	"github.com/daneelvt/keel-over-the-edge/internal/shipmates"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Shipmates in keel: every pair loaded as keel starts into the memory
// every message and knock reads; each world's tally of who sails
// together; and the service the play routes reach, across worlds.

// shipmateStore is the store's side of shipmates.
type shipmateStore interface {
	shipmates.Store
	shipmates.Recorder
	AllShipmates(ctx context.Context) ([]store.Tie, error)
	DeleteSailedAndOffers(ctx context.Context, now time.Time) (int64, error)
}

// loadShipmates reads every pair of shipmates into the ties' memory.
func (p *process) loadShipmates(ctx context.Context) error {
	pairs, err := p.chatDB().AllShipmates(ctx)
	if err != nil {
		return err
	}
	for _, t := range pairs {
		p.ties.SetShipmates(t.Account, t.Other, true)
	}
	return nil
}

// newShipmates is shipmates over the world sailed now.
func (p *process) newShipmates() *shipmates.Service {
	return shipmates.New(shipmates.Config{
		Store: p.chatDB(), Ties: p.ties, Switches: p.switches,
		World: func() shipmates.World {
			if h := p.current.Load(); h != nil {
				return h.game
			}
			return nil
		},
		Hub: p.hub,
		Tally: func() *shipmates.Tally {
			if h := p.current.Load(); h != nil {
				return h.tally
			}
			return nil
		},
		Tie:     p.tie,
		Report:  func(ctx context.Context, in review.In) error { return p.reports.Report(ctx, in) },
		Look:    p.lookCode,
		Log:     p.log,
		Metrics: p.metrics,
	})
}

// sailedRoute is the developer's POST /debug/sailed: everyone aboard
// together now counts as having sailed together five minutes, so a trial
// need not wait them.
func sailedRoute(h *worldHalf) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		n := h.tally.Hurry(r.Context())
		fmt.Fprintf(w, "%d pairs sailed together\n", n)
	})
}

// unship ends two accounts' being shipmates, after a block between them.
func (p *process) unship(ctx context.Context, a, b bus.Account) {
	if p.shipmates == nil {
		return
	}
	if err := p.shipmates.Unship(ctx, store.AccountID(a), store.AccountID(b)); err != nil {
		p.log.Warn("ending shipmates after a block", "err", err)
	}
}
