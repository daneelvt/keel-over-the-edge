// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
)

// loadSwitches reads the owner's switches for sailing together from the
// database, as keel starts, into the one set in memory every knock and
// link reads; the owner's page changes both.
func loadSwitches(ctx context.Context, db interface {
	SailSettings(ctx context.Context) (lifetime time.Duration, links, boarding bool, err error)
}) (*aboard.Switches, error) {
	life, links, boarding, err := db.SailSettings(ctx)
	if err != nil {
		return nil, err
	}
	s := aboard.NewSwitches(life)
	s.SetLinks(links)
	s.SetBoarding(boarding)
	return s, nil
}
