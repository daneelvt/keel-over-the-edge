// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
	"fmt"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Reachable waits until the database at url accepts a connection, trying
// again while the connection is refused or cannot be made yet, or the
// database is still starting, until ctx ends. A new pod's first
// connections can be refused for a moment while the cluster's network
// policy controller lets its address in, as they are while the database
// starts; waiting is cheaper than exiting and being restarted after a
// back-off. Any other failure (TLS, a password, pg_hba.conf) is returned
// at once: trying again cannot help.
func Reachable(ctx context.Context, url string) error {
	cc, err := pgx.ParseConfig(url)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrConfig, err)
	}
	wait := 100 * time.Millisecond
	for {
		actx, cancel := context.WithTimeout(ctx, 5*time.Second)
		conn, err := pgx.ConnectConfig(actx, cc)
		cancel()
		if err == nil {
			return conn.Close(ctx)
		}
		if !notYet(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("the database did not answer: %w", err)
		case <-time.After(wait):
		}
		wait = min(2*wait, 2*time.Second)
	}
}

// notYet is whether a failed connection may succeed when tried again: it
// was refused, could not reach the host, timed out, or the server is
// starting up (SQLSTATE 57P03).
func notYet(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "57P03"
	}
	return errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.EHOSTUNREACH) ||
		errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, context.DeadlineExceeded) || pgconn.Timeout(err)
}
