// SPDX-License-Identifier: AGPL-3.0-only

// Package smoke holds the checks the development tools' smoke tests make of
// a running game, wherever it is served: a sailor made with a passkey and
// read back, the game connection, a second player seeing the first's boat,
// the physics module and keel's metrics.
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

	"github.com/daneelvt/keel-over-the-edge/internal/auth/softkey"
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
// sailor's cookie, as the page's net worker does, says Hello, and expects a
// Welcome, a snapshot, and a Pong to its Ping; then a second sailor's
// connection, whose snapshots must show the first sailor's boat.
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
	// The first sailor's connection reads on, so the server can write to it.
	client.Read(ws)
	if err := second(ctx, hc, jar2, base); err != nil {
		return err
	}
	return ws.Close(websocket.StatusNormalClosure, "")
}

// second connects a second sailor and decodes its snapshots until one
// shows another boat: the first sailor's, who joined just before, 20 m off
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

// DialGame opens the game connection with a cookie jar, as a page of the
// players' origin does.
func DialGame(ctx context.Context, hc *http.Client, jar http.CookieJar, base string) (*websocket.Conn, error) {
	return dialGame(ctx, hc, jar, base)
}

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

// Sailor makes a sailor with a passkey, as the page does, through the
// player's routes with a software authenticator, keeping its cookie in a
// jar, and reads it back from /api/me.
func Sailor(ctx context.Context, client *http.Client, base string) (string, http.CookieJar, error) {
	name, jar, _, err := SailorNamed(ctx, client, base, fmt.Sprintf("Smoke Test %d", time.Now().UnixNano()%1_000_000))
	return name, jar, err
}

// SailorNamed is Sailor, with the sailor's name, and its passkey.
func SailorNamed(ctx context.Context, client *http.Client, base, name string) (string, http.CookieJar, *softkey.Key, error) {
	cat, err := catalog.Load()
	if err != nil {
		return "", nil, nil, err
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return "", nil, nil, err
	}
	c := *client
	c.Jar = jar
	body, err := json.Marshal(map[string]string{"name": name, "look": string(cat.Sailors[0].ID)})
	if err != nil {
		return "", nil, nil, err
	}
	opts, err := Post(ctx, &c, base, "/account/begin", body, http.StatusOK)
	if err != nil {
		return "", nil, nil, err
	}
	key, answer, err := softkey.Create(opts, base)
	if err != nil {
		return "", nil, nil, err
	}
	if _, err := Post(ctx, &c, base, "/account/finish", answer, http.StatusCreated); err != nil {
		return "", nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/me", nil)
	if err != nil {
		return "", nil, nil, err
	}
	res, err := c.Do(req)
	if err != nil {
		return "", nil, nil, fmt.Errorf("smoke: /api/me: %w", err)
	}
	defer res.Body.Close()
	var me struct{ Name string }
	if err := json.NewDecoder(res.Body).Decode(&me); err != nil || res.StatusCode != http.StatusOK || me.Name != name {
		return "", nil, nil, fmt.Errorf("smoke: /api/me answered %s, %q (%v); want the sailor %q", res.Status, me.Name, err, name)
	}
	return name, jar, key, nil
}

// Post sends a JSON body, or none for nil, to one of the game's routes,
// and returns the answer's body if its status is want.
func Post(ctx context.Context, c *http.Client, base, path string, body []byte, want int) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.Do(req)
	if err != nil {
		return nil, fmt.Errorf("smoke: POST %s: %w", path, err)
	}
	defer res.Body.Close()
	reply, _ := io.ReadAll(res.Body)
	if res.StatusCode != want {
		return nil, fmt.Errorf("smoke: POST %s answered %s: %s", path, res.Status, reply)
	}
	return reply, nil
}

// Delete deletes a sailor made by SailorNamed as its player would: its
// passkey confirmed, its name typed again.
func Delete(ctx context.Context, client *http.Client, jar http.CookieJar, key *softkey.Key, base, name string) error {
	c := *client
	c.Jar = jar
	opts, err := Post(ctx, &c, base, "/api/account/confirm/begin", nil, http.StatusOK)
	if err != nil {
		return err
	}
	answer, err := key.Get(opts)
	if err != nil {
		return err
	}
	if _, err := Post(ctx, &c, base, "/api/account/confirm/finish", answer, http.StatusOK); err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"name": name})
	_, err = Post(ctx, &c, base, "/api/account/delete", body, http.StatusOK)
	return err
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
