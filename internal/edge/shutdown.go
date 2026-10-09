// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// Bell tells every game connection the server is about to restart, in
// about in, and refuses new connections from now on; the connections stay
// open, their boats sailing, until Shutdown.
func (e *Edge) Bell(in time.Duration) {
	msg := &pb.ServerMessage{Body: &pb.ServerMessage_Restart{Restart: &pb.Restart{InMs: uint32(in.Milliseconds())}}}
	for _, c := range e.closeDoor() {
		c.send(msg, outRestart)
	}
}

// closeDoor refuses new connections, and returns those open.
func (e *Edge) closeDoor() []*conn {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.closing = true
	open := make([]*conn, 0, len(e.conns))
	for c := range e.conns {
		open = append(open, c)
	}
	return open
}

// Shutdown closes every game connection with 1012 (Service Restart) and
// refuses new ones, then waits for them to finish. http.Server's Shutdown
// leaves hijacked connections alone, so the server stops its listeners,
// then calls this. Live clients answer the close at once; a connection
// still open when ctx ends, whose peer is not answering, is dropped
// without its handshake, as its client's own check of the connection would
// drop it soon anyway. It returns ctx's error if any had to be dropped.
func (e *Edge) Shutdown(ctx context.Context) error {
	open := e.closeDoor()
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
	case <-ctx.Done():
		err = ctx.Err()
		for _, c := range open {
			c.force()
		}
		<-done
	}
	// What waits on the simulation for a connection that has gone (a late
	// Join's answer, a Disconnect the queue had no room for) stops now.
	e.cancel()
	e.helpers.Wait()
	return err
}
