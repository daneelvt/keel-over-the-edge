// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Guests makes guests and checks sessions.
type Guests interface {
	// Create makes a guest of name and returns its session's cookie.
	Create(ctx context.Context, name string) (string, error)
	// Valid says whether a session's cookie is still good.
	Valid(ctx context.Context, cookie string) (bool, error)
}

// Dialer opens the game connection with a session's cookie, through wrap if
// it is not nil.
type Dialer func(ctx context.Context, cookie string, wrap func(net.Conn) net.Conn) (*websocket.Conn, error)

// Config is a run's.
type Config struct {
	N          int
	Sail       time.Duration // once all have joined
	Ramp       time.Duration // the joining spread over
	FrameEvery time.Duration
	Lag        *client.Lag // each connection through it, seeded apart, if not nil
	Guests     Guests
	Sessions   string // the sessions file
	Dial       Dialer
	// Metrics, if not nil, reads the server's metrics in Prometheus's text
	// format, before and after the sail.
	Metrics func(ctx context.Context) (string, error)
	Out     io.Writer
}

// Report is what a run saw.
type Report struct {
	Players []Player
	Made    int // guests made this run
	Seconds float64
	Server  ServerReport
}

// Player is one player's sail.
type Player struct {
	Name   string
	Stats  client.Stats
	Closes map[int]int // close codes, -1 for none, and how often
	Errors int
	RTT    time.Duration // the round trip the clock measured last
	// Each time the connection ended and the player came back: the pause,
	// from the last snapshot before to the first after; whether the
	// Welcome was to the same boat; and how far the boat was from where
	// it had been, m.
	Returns []Return
}

// Return is a player's coming back after the connection ended.
type Return struct {
	Code     int // the close code, -1 for none
	Pause    time.Duration
	Rejoined bool // the Welcome was to the boat the player had
	Distance float64
}

// Run makes or finds the guests, sails them, and reports.
func Run(ctx context.Context, cfg Config) (*Report, error) {
	cookies, made, err := sessions(ctx, cfg)
	if err != nil {
		return nil, err
	}
	kind, err := jollyBoat()
	if err != nil {
		return nil, err
	}
	var before string
	if cfg.Metrics != nil {
		before, _ = cfg.Metrics(ctx)
	}
	rep := &Report{Players: make([]Player, cfg.N), Made: made}
	start := time.Now()
	end := start.Add(cfg.Ramp + cfg.Sail)
	var wg sync.WaitGroup
	for i := range cfg.N {
		p := &rep.Players[i]
		p.Name = guestName(i)
		p.Closes = map[int]int{}
		delay := time.Duration(0)
		if cfg.N > 1 {
			delay = cfg.Ramp * time.Duration(i) / time.Duration(cfg.N-1)
		}
		wg.Go(func() {
			select {
			case <-time.After(delay):
			case <-ctx.Done():
				return
			}
			sailOne(ctx, cfg, kind, cookies[i], uint64(i), end, p)
		})
	}
	wg.Wait()
	rep.Seconds = time.Since(start).Seconds()
	if cfg.Metrics != nil {
		if after, err := cfg.Metrics(ctx); err == nil {
			rep.Server = serverReport(before, after, rep.Seconds)
		}
	}
	if cfg.Out != nil {
		rep.print(cfg.Out, cfg)
	}
	return rep, ctx.Err()
}

// sailOne sails one player until end, connecting again after the
// connection ends: after 1012, a server's restart, in 0.5 to 5 s at
// random, as the page does; after 4002, versions that differ, never;
// after anything else, in a second.
func sailOne(ctx context.Context, cfg Config, kind *physics.Prepared, cookie string, i uint64, end time.Time, p *Player) {
	rng := rand.New(rand.NewPCG(i, 7))
	helm, sheet := 512, 512
	controls := func(n int) (uint16, uint16) {
		// The scripted sailors' random walk, a move every half second or so.
		if n%15 == 0 {
			helm = max(0, min(bus.Steps, helm+rng.IntN(257)-128))
			sheet = max(0, min(bus.Steps, sheet+rng.IntN(193)-96))
		}
		return uint16(helm), uint16(sheet)
	}
	connection := uint64(0)
	dial := func(ctx context.Context) (*websocket.Conn, error) {
		var wrap func(net.Conn) net.Conn
		if cfg.Lag != nil {
			l := *cfg.Lag
			l.Seed = i*1_000_003 + connection
			connection++
			wrap = l.Wrap
		}
		return cfg.Dial(ctx, cookie, wrap)
	}
	s := client.NewSailor(dial, kind, controls)
	s.FrameEvery = cfg.FrameEvery
	// The last snapshot, and a return under way: the connection ended,
	// and no snapshot has come since.
	var last struct {
		at   time.Time
		x, y float64
		boat uint64
	}
	var back *Return
	welcomes := 0
	s.OnView = func(ev *client.Event) {
		now := time.Now()
		st := ev.Snapshot.State
		if back != nil && len(s.Welcomes) > welcomes {
			w := s.Welcomes[len(s.Welcomes)-1]
			back.Pause = now.Sub(last.at)
			back.Rejoined = w.Rejoined && w.Boat == last.boat
			back.Distance = math.Hypot(st.X-last.x, st.Y-last.y)
			p.Returns = append(p.Returns, *back)
			back = nil
		}
		last.at, last.x, last.y = now, st.X, st.Y
		if n := len(s.Welcomes); n > 0 {
			last.boat = s.Welcomes[n-1].Boat
		}
	}
	for ctx.Err() == nil && time.Until(end) > 0 {
		err := s.Connect(ctx)
		if err == nil {
			err = s.Sail(ctx, time.Until(end))
		}
		s.Drop()
		if err != nil && ctx.Err() == nil {
			code := int(websocket.CloseStatus(err))
			p.Errors++
			p.Closes[code]++
			if back == nil && !last.at.IsZero() {
				back, welcomes = &Return{Code: code}, len(s.Welcomes)
			}
			if code == int(edge.CloseVersion) {
				// The server is of another version: the page reloads, and a
				// bot of this build can do nothing more.
				break
			}
			wait := time.Second
			if code == int(websocket.StatusServiceRestart) {
				wait = 500*time.Millisecond + time.Duration(rng.Float64()*float64(4500*time.Millisecond))
			}
			select {
			case <-time.After(wait):
			case <-ctx.Done():
			}
		}
	}
	p.Stats = s.Stats
	p.RTT = time.Duration(s.Net.Clock.RTT) * time.Microsecond
}

// jollyBoat is the catalog's first boat, prepared: the players' boat.
func jollyBoat() (*physics.Prepared, error) {
	cat, err := catalog.Load()
	if err != nil {
		return nil, err
	}
	params := catalog.PhysicsParams(&cat.Boats[0])
	var k physics.Prepared
	physics.Prepare(&params, &k)
	return &k, nil
}

func guestName(i int) string { return fmt.Sprintf("Loadbot %d", i+1) }

// savedSessions is the sessions file: the guests' cookies by origin, the
// i-th the i-th player's.
type savedSessions map[string][]string

// sessions finds the cookies of the guests saved for the origin, makes the
// guests missing or whose sessions are gone, and saves them, after each
// guest made, so that a run cut short keeps the guests it made.
func sessions(ctx context.Context, cfg Config) (cookies []string, made int, err error) {
	saved := savedSessions{}
	if data, err := os.ReadFile(cfg.Sessions); err == nil {
		if err := json.Unmarshal(data, &saved); err != nil {
			return nil, 0, fmt.Errorf("%s: %w", cfg.Sessions, err)
		}
	}
	key := originKey(cfg.Guests)
	cookies = slices.Clone(saved[key])
	save := func() error {
		saved[key] = cookies
		data, err := json.MarshalIndent(saved, "", "  ")
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(cfg.Sessions), 0o700); err != nil {
			return err
		}
		return os.WriteFile(cfg.Sessions, append(data, '\n'), 0o600)
	}
	for i := range cfg.N {
		if i < len(cookies) {
			ok, err := cfg.Guests.Valid(ctx, cookies[i])
			if err != nil {
				return nil, made, err
			}
			if ok {
				continue
			}
		}
		c, err := createGuest(ctx, cfg.Guests, i)
		if err != nil {
			return nil, made, err
		}
		made++
		if i < len(cookies) {
			cookies[i] = c
		} else {
			cookies = append(cookies, c)
		}
		if err := save(); err != nil {
			return nil, made, err
		}
	}
	return cookies, made, save()
}

// errNameRefused is a guest's name the server would not take: taken, or
// caught by its filter (which reads digits as the letters they look like).
var errNameRefused = errors.New("the name was refused")

// createGuest makes player i's guest, trying other names when one is
// refused.
func createGuest(ctx context.Context, g Guests, i int) (string, error) {
	name := guestName(i)
	for try := 1; ; try++ {
		c, err := g.Create(ctx, name)
		if !errors.Is(err, errNameRefused) || try == 8 {
			if err != nil {
				return "", fmt.Errorf("guest %d (%s): %w", i+1, name, err)
			}
			return c, nil
		}
		name = fmt.Sprintf("Loadbot %d", rand.IntN(90000)+10000)
	}
}

// originKey is what a sessions file keeps a server's guests under.
func originKey(g Guests) string {
	if h, ok := g.(*httpGuests); ok {
		return h.base
	}
	return fmt.Sprintf("%T", g)
}

// httpGuests makes guests as the start screen does: POST /guest.
type httpGuests struct {
	base   string
	client *http.Client
}

func (g *httpGuests) Create(ctx context.Context, name string) (string, error) {
	cat, err := catalog.Load()
	if err != nil {
		return "", err
	}
	body, err := json.Marshal(map[string]string{"name": name, "look": string(cat.Sailors[0].ID)})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.base+"/guest", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", g.base)
	res, err := g.client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		reply, _ := io.ReadAll(res.Body)
		if res.StatusCode == http.StatusUnprocessableEntity {
			return "", fmt.Errorf("%w: %s", errNameRefused, reply)
		}
		return "", fmt.Errorf("POST /guest answered %s: %s", res.Status, reply)
	}
	for _, c := range res.Cookies() {
		if c.Name == auth.CookieName {
			return c.Value, nil
		}
	}
	return "", errors.New("POST /guest set no session")
}

func (g *httpGuests) Valid(ctx context.Context, cookie string) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.base+"/api/me", nil)
	if err != nil {
		return false, err
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: cookie})
	res, err := g.client.Do(req)
	if err != nil {
		return false, err
	}
	res.Body.Close()
	return res.StatusCode == http.StatusOK, nil
}

// wsDialer opens /ws of the origin base, as a page of it does.
func wsDialer(hc *http.Client, base string) Dialer {
	u := strings.Replace(strings.TrimSuffix(base, "/"), "http", "ws", 1) + "/ws"
	return func(ctx context.Context, cookie string, wrap func(net.Conn) net.Conn) (*websocket.Conn, error) {
		c := *hc
		c.Timeout = 0
		if wrap != nil {
			under, ok := hc.Transport.(*http.Transport)
			if !ok {
				under = http.DefaultTransport.(*http.Transport)
			}
			tr := under.Clone()
			var d net.Dialer
			tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
				nc, err := d.DialContext(ctx, network, addr)
				if err != nil {
					return nil, err
				}
				return wrap(nc), nil
			}
			c.Transport = tr
		}
		ws, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{
			HTTPClient: &c,
			HTTPHeader: http.Header{
				"Cookie": []string{auth.CookieName + "=" + cookie},
				"Origin": []string{strings.TrimSuffix(base, "/")},
			},
		})
		return ws, err
	}
}
