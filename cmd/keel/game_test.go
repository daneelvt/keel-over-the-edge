// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/replay"
)

// gameServer is keel serve with a guest's session, and the guest's cookie.
func gameServer(t *testing.T, vars map[string]string) (*server, string) {
	t.Helper()
	sessions := edgetest.NewSessions()
	token, _ := sessions.Add("Ann", "human")
	db := &memDB{epoch: bubbleEpoch, sessions: sessions}
	s := startServer(t, vars, newMemNet(), serveOptions{openDB: db.open})
	time.Sleep(time.Second)
	return s, token
}

// connect opens the game connection through the play listener and waits
// for the Welcome; the connection is then read on a goroutine of its own.
func connect(t *testing.T, s *server, token string) (*websocket.Conn, *edgetest.Inbox) {
	t.Helper()
	h := http.Header{}
	h.Set("Cookie", auth.CookieName+"="+token)
	ws, _, err := websocket.Dial(t.Context(), "ws://127.0.0.1:8080/ws", &websocket.DialOptions{HTTPClient: s.client, HTTPHeader: h})
	if err != nil {
		t.Fatal(err)
	}
	if err := edgetest.Send(t.Context(), ws, edgetest.Hello()); err != nil {
		t.Fatal(err)
	}
	in := edgetest.Read(ws)
	for r := range in.C {
		if r.Message.GetWelcome() != nil {
			return ws, in
		}
	}
	t.Fatalf("no welcome: %v", in.Err())
	return nil, nil
}

// TestStopClosesGameConnections: as keel serve stops, a connected client
// is closed with 1012 while the world still ticks, so its boat's grace is
// in the input log.
func TestStopClosesGameConnections(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		replays := t.TempDir()
		s, token := gameServer(t, map[string]string{"KEEL_REPLAY_DIR": replays})
		_, in := connect(t, s, token)
		time.Sleep(time.Second)
		s.stop(t)
		for range in.C {
		}
		if code := websocket.CloseStatus(in.Err()); code != websocket.StatusServiceRestart {
			t.Fatalf("closed with %d (%v)", code, in.Err())
		}
		names, _ := filepath.Glob(filepath.Join(replays, "*.log"))
		data, err := os.ReadFile(names[0])
		if err != nil {
			t.Fatal(err)
		}
		f, err := replay.Read(data)
		if err != nil {
			t.Fatal(err)
		}
		var disconnected bool
		for _, seg := range f.Segments {
			for _, r := range seg.Records {
				for _, e := range r.Events {
					disconnected = disconnected || e.Op == bus.Disconnect && e.Reply.Result == bus.Done
				}
			}
		}
		if !disconnected {
			t.Fatal("the loop stopped before the connection's Disconnect was applied")
		}
	})
}

// TestStopWithDeadPeer: a client that has stopped answering holds the stop
// no longer than the library's timeouts.
func TestStopWithDeadPeer(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s, token := gameServer(t, map[string]string{})
		h := http.Header{}
		h.Set("Cookie", auth.CookieName+"="+token)
		ws, _, err := websocket.Dial(t.Context(), "ws://127.0.0.1:8080/ws", &websocket.DialOptions{HTTPClient: s.client, HTTPHeader: h})
		if err != nil {
			t.Fatal(err)
		}
		defer ws.CloseNow()
		edgetest.Send(t.Context(), ws, edgetest.Hello())
		// It never reads again: the in-memory pipe holds nothing, so the
		// server's writes wait.
		time.Sleep(time.Second)
		start := time.Now()
		s.stop(t)
		if d := time.Since(start); d > gameShutdownTimeout {
			t.Fatalf("stopping took %v", d)
		}
	})
}

// TestWindRoute: POST /debug/wind is on the internal listener only with
// KEEL_DEV_COMMANDS=1, and the next snapshot carries the new wind.
func TestWindRoute(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s, _ := gameServer(t, map[string]string{})
		res, err := s.client.Post(internalURL+"/debug/wind?knots=12&from=90", "", nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("without KEEL_DEV_COMMANDS: %d", res.StatusCode)
		}
		s.stop(t)
	})
	synctest.Test(t, func(t *testing.T) {
		s, token := gameServer(t, map[string]string{"KEEL_DEV_COMMANDS": "1"})
		_, in := connect(t, s, token)
		for _, base := range []string{playURL, agentsURL} {
			res, err := s.client.Post(base+"/debug/wind?knots=12&from=90", "", nil)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			if res.StatusCode == http.StatusNoContent {
				t.Fatalf("%s serves the wind route", base)
			}
		}
		res, err := s.client.Post(internalURL+"/debug/wind?knots=x", "", nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("a bad wind: %d", res.StatusCode)
		}
		res, err = s.client.Post(internalURL+"/debug/wind?knots=12&from=90", "", nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNoContent {
			t.Fatalf("the wind route answered %d", res.StatusCode)
		}
		var sn *protocol.Snapshot
		for r := range in.C {
			if r.Snapshot != nil && r.Snapshot.Wind.Speed == 12*1852.0/3600 {
				sn = r.Snapshot
				break
			}
		}
		if sn == nil || sn.Wind.From != 90*3.141592653589793/180 {
			t.Fatalf("snapshot %+v", sn)
		}
		s.stop(t)
	})
}
