// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"context"
	"fmt"
	"net"
	"net/http"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

type netConn = net.Conn

// DialOptions are a dial's: the session's cookie, an Origin header, and a
// wrapper for the network connection (a lag model).
type DialOptions struct {
	Cookie string
	Origin string
	Wrap   func(net.Conn) net.Conn
}

// Dial opens the game connection. resp is the handshake's response, also
// when it failed.
func (s *Server) Dial(ctx context.Context, o DialOptions) (*websocket.Conn, *http.Response, error) {
	h := http.Header{}
	if o.Cookie != "" {
		h.Set("Cookie", auth.CookieName+"="+o.Cookie)
	}
	if o.Origin != "" {
		h.Set("Origin", o.Origin)
	}
	return websocket.Dial(ctx, s.URL(), &websocket.DialOptions{HTTPClient: s.Client(o.Wrap), HTTPHeader: h})
}

// Hello is the Hello this build's client sends.
func Hello() *pb.ClientMessage {
	return &pb.ClientMessage{Body: &pb.ClientMessage_Hello{Hello: &pb.Hello{
		Protocol: protocol.Version, Catalog: catalog.Version, PhysicsLayout: physics.LayoutVersion, Build: "edgetest",
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

// Received is a server's message: one of Message and Snapshot.
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
		return Received{}, fmt.Errorf("edgetest: a %v message", typ)
	}
	r := Received{Bytes: b}
	if len(b) > 0 && b[0] == protocol.KindSnapshot {
		r.Snapshot = &protocol.Snapshot{}
		return r, protocol.ReadSnapshot(b, r.Snapshot)
	}
	r.Message = &pb.ServerMessage{}
	return r, protocol.DecodeServer(b, r.Message)
}

// Connect dials, says Hello and waits for the Welcome.
func (s *Server) Connect(ctx context.Context, o DialOptions) (*websocket.Conn, *pb.Welcome, error) {
	ws, _, err := s.Dial(ctx, o)
	if err != nil {
		return nil, nil, err
	}
	if err := Send(ctx, ws, Hello()); err != nil {
		ws.CloseNow()
		return nil, nil, err
	}
	for {
		r, err := Receive(ctx, ws)
		if err != nil {
			ws.CloseNow()
			return nil, nil, fmt.Errorf("%w: %w", ErrNoWelcome, err)
		}
		if w := r.Message.GetWelcome(); w != nil {
			return ws, w, nil
		}
	}
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
