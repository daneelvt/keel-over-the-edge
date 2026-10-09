// SPDX-License-Identifier: AGPL-3.0-only

// Package client is the game's client in Go: what the page and its net
// worker do, done the same way, for tests, traces and the load bot. It
// speaks the game connection's protocol, keeps the world clock, predicts
// its own boat with the physics as the page does, decodes the other boats'
// views as the net worker does, and records what it did. Lag models a slow,
// lossy network under TCP, as a connection's wrapper or a proxy.
package client

import (
	"context"
	"fmt"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// Hello is the Hello this build's client sends.
func Hello() *pb.ClientMessage {
	return &pb.ClientMessage{Body: &pb.ClientMessage_Hello{Hello: &pb.Hello{
		Protocol: protocol.Version, Catalog: catalog.Version, PhysicsLayout: physics.LayoutVersion, Build: "go",
	}}}
}

// Send writes a client's message.
func Send(ctx context.Context, ws *websocket.Conn, m *pb.ClientMessage) error {
	b, err := protocol.AppendClient(nil, m)
	if err != nil {
		return err
	}
	return ws.Write(ctx, websocket.MessageBinary, b)
}

// Received is a server's message: one of Message and Snapshot, the
// snapshot's header alone.
type Received struct {
	Message  *pb.ServerMessage
	Snapshot *protocol.Snapshot
	Bytes    []byte
}

// Receive reads the server's next message.
func Receive(ctx context.Context, ws *websocket.Conn) (Received, error) {
	typ, b, err := ws.Read(ctx)
	if err != nil {
		return Received{}, err
	}
	if typ != websocket.MessageBinary {
		return Received{}, fmt.Errorf("client: a %v message", typ)
	}
	r := Received{Bytes: b}
	if len(b) > 0 && b[0] == protocol.KindSnapshot {
		r.Snapshot = &protocol.Snapshot{}
		return r, protocol.ReadSnapshot(b, r.Snapshot)
	}
	r.Message = &pb.ServerMessage{}
	return r, protocol.DecodeServer(b, r.Message)
}

// Inbox reads a connection's messages on a goroutine of its own, since a
// read whose context ends closes the connection. Messages arrive on C; once
// the connection has ended C is closed and Err says why.
type Inbox struct {
	C   <-chan Received
	err error
}

// Read starts reading ws.
func Read(ws *websocket.Conn) *Inbox {
	c := make(chan Received, 1024)
	in := &Inbox{C: c}
	go func() {
		defer close(c)
		for {
			r, err := Receive(context.Background(), ws)
			if err != nil {
				in.err = err
				return
			}
			c <- r
		}
	}()
	return in
}

// Err is why the connection ended, once C is closed.
func (in *Inbox) Err() error { return in.err }
