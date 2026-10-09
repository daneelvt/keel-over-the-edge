// SPDX-License-Identifier: AGPL-3.0-only

// Package smoke holds the checks the development tools' smoke tests make of
// a running game, wherever it is served: a guest made and read back, the
// game connection, a second player seeing the first's boat, the physics
// module and keel's metrics.
package smoke

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// MetricNames are metrics keel always reports.
var MetricNames = []string{"keel_sim_ticks_total", "keel_sim_tick_duration_seconds_bucket", "keel_build_info", "keel_db_pool_max_connections", "keel_db_schema_version", "keel_edge_connections", "keel_edge_upgrades_total",
	"keel_sim_boat_limit", "keel_sim_queue_length", "keel_edge_encoders"}

// Metrics checks a /metrics page names every metric of MetricNames.
func Metrics(page string) error {
	for _, name := range MetricNames {
		if !strings.Contains(page, name) {
			return fmt.Errorf("smoke: /metrics has no %s", name)
		}
	}
	return nil
}

// Game opens the game connection over HTTPS with the
// guest's cookie, as the page's net worker does, says Hello, and expects a
// Welcome, a snapshot, and a Pong to its Ping; then a second guest's
// connection, whose snapshots must show the first guest's boat.
func Game(ctx context.Context, hc *http.Client, jar, jar2 http.CookieJar, base string) error {
	ws, err := dialGame(ctx, hc, jar, base)
	if err != nil {
		return err
	}
	defer ws.CloseNow()
	if err := client.Send(ctx, ws, client.Hello()); err != nil {
		return err
	}
	var welcome, snapshot, pong bool
	for !welcome || !snapshot || !pong {
		r, err := client.Receive(ctx, ws)
		if err != nil {
			return fmt.Errorf("smoke: the game connection (welcome %v, snapshot %v, pong %v): %w", welcome, snapshot, pong, err)
		}
		switch {
		case r.Message.GetWelcome() != nil:
			welcome = true
			ping := &pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTimeUs: 1}}}
			if err := client.Send(ctx, ws, ping); err != nil {
				return err
			}
		case r.Message.GetPong() != nil:
			pong = true
		case r.Snapshot != nil:
			snapshot = true
		}
	}
	// The first guest's connection reads on, so the server can write to it.
	client.Read(ws)
	if err := second(ctx, hc, jar2, base); err != nil {
		return err
	}
	return ws.Close(websocket.StatusNormalClosure, "")
}

// second connects a second guest and decodes its snapshots until one
// shows another boat: the first guest's, who joined just before, 20 m off
// on the start grid.
func second(ctx context.Context, hc *http.Client, jar http.CookieJar, base string) error {
	ws, err := dialGame(ctx, hc, jar, base)
	if err != nil {
		return err
	}
	defer ws.CloseNow()
	if err := client.Send(ctx, ws, client.Hello()); err != nil {
		return err
	}
	var views client.Views
	for n := 0; ; n++ {
		r, err := client.Receive(ctx, ws)
		if err != nil {
			return fmt.Errorf("smoke: the second player's connection, after %d messages: %w", n, err)
		}
		if r.Snapshot == nil {
			continue
		}
		v, _, err := views.Decode(r.Bytes, r.Snapshot)
		if err != nil {
			return fmt.Errorf("smoke: the second player's snapshot: %w", err)
		}
		if v.Len() > 0 {
			return ws.Close(websocket.StatusNormalClosure, "")
		}
	}
}

// dialGame opens the game connection with a cookie jar, as a page of the
// players' origin does.
func dialGame(ctx context.Context, hc *http.Client, jar http.CookieJar, base string) (*websocket.Conn, error) {
	c := *hc
	c.Jar = jar
	c.Timeout = 0
	u := "wss" + strings.TrimPrefix(base, "https") + "/ws"
	ws, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{
		HTTPClient: &c,
		HTTPHeader: http.Header{"Origin": []string{base}},
	})
	if err != nil {
		return nil, fmt.Errorf("smoke: the game connection: %w", err)
	}
	return ws, nil
}

// Guest makes a guest, as the page does, keeping its
// cookie in a jar, and reads it back from /api/me.
func Guest(ctx context.Context, client *http.Client, base string) (string, http.CookieJar, error) {
	cat, err := catalog.Load()
	if err != nil {
		return "", nil, err
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return "", nil, err
	}
	c := *client
	c.Jar = jar
	name := fmt.Sprintf("Smoke Test %d", time.Now().UnixNano()%1_000_000)
	body, err := json.Marshal(map[string]string{"name": name, "look": string(cat.Sailors[0].ID)})
	if err != nil {
		return "", nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/guest", bytes.NewReader(body))
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.Do(req)
	if err != nil {
		return "", nil, fmt.Errorf("smoke: POST /guest: %w", err)
	}
	reply, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		return "", nil, fmt.Errorf("smoke: POST /guest answered %s: %s", res.Status, reply)
	}
	req, err = http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/me", nil)
	if err != nil {
		return "", nil, err
	}
	res, err = c.Do(req)
	if err != nil {
		return "", nil, fmt.Errorf("smoke: /api/me: %w", err)
	}
	defer res.Body.Close()
	var me struct{ Name string }
	if err := json.NewDecoder(res.Body).Decode(&me); err != nil || res.StatusCode != http.StatusOK || me.Name != name {
		return "", nil, fmt.Errorf("smoke: /api/me answered %s, %q (%v); want the guest %q", res.Status, me.Name, err, name)
	}
	return name, jar, nil
}

// ModuleServed fetches the physics module as the page does. Browsers
// compile it while it downloads only when it comes as application/wasm.
func ModuleServed(ctx context.Context, client *http.Client, url string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("smoke: %w", err)
	}
	defer res.Body.Close()
	magic := make([]byte, 4)
	if _, err := io.ReadFull(res.Body, magic); err != nil || res.StatusCode != http.StatusOK || string(magic) != "\x00asm" {
		return fmt.Errorf("smoke: %s is not a WebAssembly module (%s)", url, res.Status)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/wasm") {
		return fmt.Errorf("smoke: %s is served as %q, not application/wasm", url, ct)
	}
	return nil
}
