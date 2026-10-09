// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"time"

	"github.com/coder/websocket"
)

// Shutdown closes every game connection with 1012 (Service Restart) and
// refuses new ones, then waits for them to finish. http.Server's Shutdown
// leaves hijacked connections alone, so the server stops its listeners,
// then calls this, before the simulation stops. Live clients answer the
// close at once; a dead one holds its close for the library's timeouts, up
// to 10 s. It returns early, with ctx's error, if ctx ends first.
func (e *Edge) Shutdown(ctx context.Context) error {
	e.mu.Lock()
	e.closing = true
	open := make([]*conn, 0, len(e.conns))
	for c := range e.conns {
		open = append(open, c)
	}
	e.mu.Unlock()
	for _, c := range open {
		c.close(websocket.StatusServiceRestart, "the server is restarting")
	}
	done := make(chan struct{})
	go func() {
		e.running.Wait()
		close(done)
	}()
	var err error
	select {
	case <-done:
		// Each connection's Disconnect is queued; the tick after next has
		// surely applied it, so its boat's grace is in the input log.
		applied := e.latest.Load() + 2
		for len(open) > 0 && e.latest.Load() < applied && ctx.Err() == nil {
			select {
			case <-ctx.Done():
			case <-time.After(10 * time.Millisecond):
			}
		}
	case <-ctx.Done():
		err = ctx.Err()
	}
	// What waits on the simulation for a connection that has gone (a late
	// Join's answer, a Disconnect the queue had no room for) stops now.
	e.cancel()
	e.helpers.Wait()
	return err
}
