// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/config"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

const migrateUsage = `usage: keel migrate [-status]

Applies the migrations the database has not had, in order, and exits. Two
runs at once take turns. keel serve refuses a database without every
migration it was built with.

  -status   list the migrations and whether each is applied, and change nothing

Configured from the environment:
  KEEL_DATABASE_URL    the database, a postgres:// URL (required)
`

func migrate(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("migrate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { io.WriteString(stderr, migrateUsage) }
	status := fs.Bool("status", false, "list the migrations")
	if err := fs.Parse(args); err != nil {
		return errUsage
	}
	if fs.NArg() > 0 {
		fs.Usage()
		return errUsage
	}
	url := getenv("KEEL_DATABASE_URL")
	if err := config.CheckDatabaseURL(url); err != nil {
		return fmt.Errorf("KEEL_DATABASE_URL: %w", err)
	}
	if *status {
		st, err := store.Status(ctx, url)
		if err != nil {
			return err
		}
		for _, m := range st {
			state := "pending"
			if m.Applied {
				state = "applied " + m.AppliedAt.UTC().Format(time.RFC3339)
			}
			fmt.Fprintf(stdout, "%-32s %s\n", m.Name, state)
		}
		return nil
	}
	applied, err := store.Migrate(ctx, url, 0)
	for _, a := range applied {
		fmt.Fprintf(stdout, "applied %s (%s)\n", a.Name, a.Duration.Round(time.Millisecond))
	}
	if err != nil {
		return err
	}
	if len(applied) == 0 {
		fmt.Fprintln(stdout, "nothing to apply: the database has every migration")
	}
	return nil
}
