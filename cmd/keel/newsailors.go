// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"log/slog"
	"net/url"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/config"
	"github.com/daneelvt/keel-over-the-edge/internal/humancheck"
	"github.com/daneelvt/keel-over-the-edge/internal/jobs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// New sailors in keel: how many one address may make in a day, counted in
// the database by the address's keyed hash, and the human check, both
// guarding POST /account/begin; the owner's settings for them, loaded as
// keel starts; and the job that forgets the addresses a day on.

// newSailorStore is the store's side of new sailors.
type newSailorStore interface {
	api.NewSailorCount
	NewSailorSettings(ctx context.Context) (perAddress int, check bool, err error)
	SetNewSailorsPerAddress(ctx context.Context, n int, a store.Action) error
	SetHumanCheck(ctx context.Context, on bool, a store.Action) error
	DeleteNewSailors(ctx context.Context, before time.Time) (int64, error)
}

// loadNewSailors reads the owner's settings for new sailors into the
// switches, as keel starts.
func loadNewSailors(ctx context.Context, db newSailorStore, sw *aboard.Switches) error {
	n, check, err := db.NewSailorSettings(ctx)
	if err != nil {
		return err
	}
	sw.SetNewSailorsPerAddress(n)
	sw.SetHumanCheck(check)
	return nil
}

// newSailors are the play routes' limits on new sailors: the address key,
// KEEL_ADDRESS_KEY's or one made now, and the human check, if its keys are
// set. Neither key nor secret is ever logged.
func newSailors(cfg config.Config, db newSailorStore, log *slog.Logger) (*api.NewSailors, error) {
	ns := cfg.NewSailors
	key := ns.AddressKey
	if ns.AddressKeyMade {
		key = make([]byte, config.AddressKeyBytes)
		if _, err := rand.Read(key); err != nil {
			return nil, err
		}
		log.Warn("KEEL_ADDRESS_KEY is not set: a key is made for this start, so the new sailors from each address are counted from zero again")
	}
	out := &api.NewSailors{Count: db, Key: key}
	if !ns.HumanCheck() {
		log.Info("no human check on new sailors: KEEL_TURNSTILE_SITEKEY and KEEL_TURNSTILE_SECRET are not set")
		return out, nil
	}
	u, err := url.Parse(cfg.PlayOrigin)
	if err != nil {
		return nil, fmt.Errorf("the play origin: %w", err)
	}
	out.Check = humancheck.New(humancheck.Config{Secret: ns.TurnstileSecret, VerifyURL: ns.TurnstileVerifyURL, Hostname: u.Hostname(), Log: log})
	out.SiteKey, out.Script = ns.TurnstileSiteKey, ns.TurnstileScript
	log.Info("new sailors pass the human check", "sitekey", ns.TurnstileSiteKey, "verify", ns.TurnstileVerifyURL, "script", ns.TurnstileScript)
	return out, nil
}

// jobNewSailors is the job that forgets the addresses of sailors made a
// day ago.
const jobNewSailors = "new-sailors"

// newSailorsJob deletes, each hour, the rows of sailors made more than a
// day before: an address is kept no longer than it counts.
func (p *process) newSailorsJob() jobs.Job {
	return jobs.Job{
		Name: jobNewSailors,
		Due: func(now time.Time) (time.Time, bool) {
			return now.Truncate(time.Hour), true
		},
		Next:  func(now time.Time) time.Time { return now.Truncate(time.Hour).Add(time.Hour) },
		Retry: 10 * time.Minute,
		Run: func(ctx context.Context, due time.Time) (jobs.Result, error) {
			n, err := p.db.DeleteNewSailors(ctx, due.Add(-store.NewSailorWindow))
			if err != nil {
				return jobs.Result{}, err
			}
			return jobs.Result{Skipped: n == 0, Detail: fmt.Sprintf("%d addresses of new sailors a day old forgotten", n)}, nil
		},
	}
}
