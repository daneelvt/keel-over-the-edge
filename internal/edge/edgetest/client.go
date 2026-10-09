// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"context"
	"fmt"
	"net"
	"net/http"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
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

// Connect dials, says Hello and waits for the Welcome.
func (s *Server) Connect(ctx context.Context, o DialOptions) (*websocket.Conn, *pb.Welcome, error) {
	ws, _, err := s.Dial(ctx, o)
	if err != nil {
		return nil, nil, err
	}
	if err := client.Send(ctx, ws, client.Hello()); err != nil {
		ws.CloseNow()
		return nil, nil, err
	}
	for {
		r, err := client.Receive(ctx, ws)
		if err != nil {
			ws.CloseNow()
			return nil, nil, fmt.Errorf("%w: %w", ErrNoWelcome, err)
		}
		if w := r.Message.GetWelcome(); w != nil {
			return ws, w, nil
		}
	}
}

// NewSailor makes a client sailor that connects to the server as o says
// and steers with controls.
func (s *Server) NewSailor(o DialOptions, controls client.Controls) *client.Sailor {
	return client.NewSailor(func(ctx context.Context) (*websocket.Conn, error) {
		ws, _, err := s.Dial(ctx, o)
		return ws, err
	}, &s.Kinds[0], controls)
}
