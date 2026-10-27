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
	"github.com/daneelvt/keel-over-the-edge/internal/auth/softkey"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/scripted"
)

// Accounts makes the bots' sailors, and checks and renews their sessions.
type Accounts interface {
	// Create makes a sailor of name with a passkey, as the start screen
	// does.
	Create(ctx context.Context, name string) (Bot, error)
	// Valid says whether a session's cookie is still good.
	Valid(ctx context.Context, cookie string) (bool, error)
	// SignIn signs in with a bot's passkey and returns a new session's
	// cookie, or errUnknownPasskey when its account is gone.
	SignIn(ctx context.Context, key *softkey.Key) (string, error)
}

// Bot is a bot's account as the sessions file keeps it: its session's
// cookie, and its passkey, which signs it in again when the session is
// gone.
type Bot struct {
	Cookie string       `json:"cookie"`
	Key    *softkey.Key `json:"passkey,omitempty"`
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
	Pilot      float64     // the share of the players on the autopilot
	Lag        *client.Lag // each connection through it, seeded apart, if not nil
	Accounts   Accounts
	Sessions   string // the sessions file
	Dial       Dialer
	// Watch, if not "", is a sailor's name: the players watch that
	// sailor's boat, as spectators, rather than sail.
	Watch string
	// Metrics, if not nil, reads the server's metrics in Prometheus's text
	// format, before and after the sail.
	Metrics func(ctx context.Context) (string, error)
	Out     io.Writer
}

// Report is what a run saw.
type Report struct {
	Players []Player
	Made    int // sailors made this run
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
	// The world's epoch as the last Welcome told it, in microseconds of UTC
	// since 1970; 0 if none came.
	EpochUs int64
	// Bumps are the bumps the player was told of: its own, with the
	// Article, and those it saw near, without.
	Bumps []*pb.Bump
}

// Return is a player's coming back after the connection ended.
type Return struct {
	Code     int // the close code, -1 for none
	Pause    time.Duration
	Rejoined bool // the Welcome was to the boat the player had
	Distance float64
}

// Run makes or finds the bots' sailors, sails them, and reports.
func Run(ctx context.Context, cfg Config) (*Report, error) {
	cookies, made, err := sessions(ctx, cfg)
	if err != nil {
		return nil, err
	}
	kind, waves, wx, enc, err := jollyBoat()
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
		p.Name = botName(i)
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
			if cfg.Watch != "" {
				watchOne(ctx, cfg, cookies[i], end, p)
				return
			}
			sailOne(ctx, cfg, kind, waves, wx, enc, cookies[i], uint64(i), end, p)
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

// watchOne watches the sailor's boat until end, connecting again a second
// after the connection ends.
func watchOne(ctx context.Context, cfg Config, cookie string, end time.Time, p *Player) {
	for ctx.Err() == nil && time.Until(end) > 0 {
		s := client.NewSpectator(func(ctx context.Context) (*websocket.Conn, error) { return cfg.Dial(ctx, cookie, nil) }, cfg.Watch)
		err := s.Watch(ctx, time.Until(end))
		addStats(&p.Stats, &s.Stats)
		if err == nil {
			return
		}
		p.Closes[int(websocket.CloseStatus(err))]++
		p.Errors++
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
		}
	}
}

// addStats adds a spectator's connection's counts to a player's.
func addStats(to, s *client.Stats) {
	to.Snapshots += s.Snapshots
	to.BytesIn += s.BytesIn
	to.BytesOut += s.BytesOut
	to.FramesIn += s.FramesIn
	to.FramesOut += s.FramesOut
	to.MessagesIn += s.MessagesIn
	to.MessagesOut += s.MessagesOut
	to.Views += s.Views
	to.Others += s.Others
	to.MaxOthers = max(to.MaxOthers, s.MaxOthers)
	to.Dropped += s.Dropped
	to.Resyncs += s.Resyncs
	to.Queued += s.Queued
	to.Bells += s.Bells
	to.Bumps += s.Bumps
}

// sailOne sails one player until end, connecting again after the
// connection ends: after 1012, a server's restart, in 0.5 to 5 s at
// random, as the page does; after 4002, versions that differ, never;
// after anything else, in a second.
func sailOne(ctx context.Context, cfg Config, kind *physics.Prepared, waves *physics.Waves, wx *physics.WeatherPrepared, enc *physics.EncounterPrepared, cookie string, i uint64, end time.Time, p *Player) {
	rng := rand.New(rand.NewPCG(i, 7))
	helm, sheet := 512, 512
	// A share of the players sail on the autopilot as the scripted sailors
	// do: at an angle to the wind drawn at random, the sheet trimmed for
	// where the boat points, a tack or a gybe every one to five minutes.
	// Its own numbers: a player steering by hand walks as it always has.
	prng := rand.New(rand.NewPCG(i, 11))
	pilot := prng.Float64() < cfg.Pilot
	angle := scripted.LeastAngle + prng.Float64()*(scripted.MostAngle-scripted.LeastAngle)
	engaged := false
	var order, way uint8
	turnEvery := func() int { return (60 + prng.IntN(240)) * physics.StepsPerSecond }
	turnAt := turnEvery()
	var s *client.Sailor
	controls := func(n int) client.Input {
		if !pilot {
			// The scripted sailors' old random walk, a move every half
			// second or so.
			if n%15 == 0 {
				helm = max(0, min(bus.Steps, helm+rng.IntN(257)-128))
				sheet = max(0, min(bus.Steps, sheet+rng.IntN(193)-96))
			}
			return client.Hand(uint16(helm), uint16(sheet))
		}
		p := s.Predictor
		if n%15 == 0 && p.Started {
			w := p.Wind()
			now := math.Remainder(w.MeanFrom-p.State.Heading, 2*math.Pi) * 180 / math.Pi
			if !engaged {
				engaged = true
				angle = math.Copysign(angle, now)
			}
			sheet = int(scripted.SheetIndex(now, w.Speed))
		}
		if !engaged {
			return client.Hand(uint16(helm), uint16(sheet))
		}
		if n >= turnAt {
			way = bus.WayTack
			if math.Abs(angle) > 90 {
				way = bus.WayGybe
			}
			order = (order + 1) & 3
			angle = -angle
			turnAt = n + turnEvery()
		}
		return client.Input{Helm: bus.Steps / 2, Sheet: uint16(sheet), Mode: bus.PilotWind, Way: way, Order: order, Target: scripted.Target(angle)}
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
	s = client.NewSailor(dial, kind, waves, wx, controls)
	s.Predictor.Encounters = enc
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
			p.EpochUs = s.Welcomes[n-1].EpochUs
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
	p.Bumps = s.Bumps
	p.RTT = time.Duration(s.Net.Clock.RTT) * time.Microsecond
}

// jollyBoat is the catalog's first boat, prepared: the players' boat, and
// the sea and the wind it sails in.
func jollyBoat() (*physics.Prepared, *physics.Waves, *physics.WeatherPrepared, *physics.EncounterPrepared, error) {
	cat, err := catalog.Load()
	if err != nil {
		return nil, nil, nil, nil, err
	}
	waves, kinds := cat.Prepare()
	return &kinds[0], waves, cat.PrepareWeather(), cat.PrepareEncounters(), nil
}

func botName(i int) string { return fmt.Sprintf("Loadbot %d", i+1) }

// savedSessions is the sessions file: the bots' accounts by origin, the
// i-th the i-th player's.
type savedSessions map[string][]Bot

// sessions finds the bots saved for the origin, signs in again those whose
// sessions are gone, makes those missing or whose accounts are gone, and
// saves them after each, so that a run cut short keeps the sailors it
// made. A file of an older form, from before passkeys, is started over.
func sessions(ctx context.Context, cfg Config) (cookies []string, made int, err error) {
	saved := savedSessions{}
	if data, err := os.ReadFile(cfg.Sessions); err == nil {
		if err := json.Unmarshal(data, &saved); err != nil {
			saved = savedSessions{}
		}
	}
	key := originKey(cfg.Accounts)
	bots := slices.Clone(saved[key])
	save := func() error {
		saved[key] = bots
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
		if i < len(bots) {
			ok, err := cfg.Accounts.Valid(ctx, bots[i].Cookie)
			if err != nil {
				return nil, made, err
			}
			if ok {
				continue
			}
			if bots[i].Key != nil {
				c, err := cfg.Accounts.SignIn(ctx, bots[i].Key)
				if err == nil {
					bots[i].Cookie = c
					if err := save(); err != nil {
						return nil, made, err
					}
					continue
				}
				if !errors.Is(err, errUnknownPasskey) {
					return nil, made, fmt.Errorf("signing in %s: %w", botName(i), err)
				}
			}
		}
		b, err := createBot(ctx, cfg.Accounts, i)
		if err != nil {
			return nil, made, err
		}
		made++
		if i < len(bots) {
			bots[i] = b
		} else {
			bots = append(bots, b)
		}
		if err := save(); err != nil {
			return nil, made, err
		}
	}
	cookies = make([]string, cfg.N)
	for i := range cookies {
		cookies[i] = bots[i].Cookie
	}
	return cookies, made, save()
}

// errNameRefused is a sailor's name the server would not take: taken, or
// caught by its filter (which reads digits as the letters they look like).
var errNameRefused = errors.New("the name was refused")

// errUnknownPasskey is a passkey whose account is gone.
var errUnknownPasskey = errors.New("no account has the passkey")

// createBot makes player i's sailor, trying other names when one is
// refused.
func createBot(ctx context.Context, a Accounts, i int) (Bot, error) {
	name := botName(i)
	for try := 1; ; try++ {
		b, err := a.Create(ctx, name)
		if !errors.Is(err, errNameRefused) || try == 8 {
			if err != nil {
				return Bot{}, fmt.Errorf("sailor %d (%s): %w", i+1, name, err)
			}
			return b, nil
		}
		name = fmt.Sprintf("Loadbot %d", rand.IntN(90000)+10000)
	}
}

// originKey is what a sessions file keeps a server's bots under.
func originKey(a Accounts) string {
	if h, ok := a.(*httpAccounts); ok {
		return h.base
	}
	return fmt.Sprintf("%T", a)
}

// httpAccounts makes sailors as the start screen does, with a passkey
// made by a software authenticator: POST /account/begin and /finish.
type httpAccounts struct {
	base   string
	client *http.Client
}

// post sends a JSON body to one of the game's routes, with the cookies
// given, and returns the answer.
func (a *httpAccounts) post(ctx context.Context, path string, body []byte, cookies []*http.Cookie) (*http.Response, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.base+path, bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", a.base)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	res, err := a.client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	reply, err := io.ReadAll(res.Body)
	return res, reply, err
}

func cookieOf(res *http.Response, name string) *http.Cookie {
	for _, c := range res.Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func (a *httpAccounts) Create(ctx context.Context, name string) (Bot, error) {
	cat, err := catalog.Load()
	if err != nil {
		return Bot{}, err
	}
	body, err := json.Marshal(map[string]string{"name": name, "look": string(cat.Sailors[0].ID)})
	if err != nil {
		return Bot{}, err
	}
	res, opts, err := a.post(ctx, "/account/begin", body, nil)
	if err != nil {
		return Bot{}, err
	}
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusUnprocessableEntity:
		return Bot{}, fmt.Errorf("%w: %s", errNameRefused, opts)
	default:
		return Bot{}, fmt.Errorf("POST /account/begin answered %s: %s", res.Status, opts)
	}
	ceremony := cookieOf(res, auth.CeremonyCookieName("create"))
	key, answer, err := softkey.Create(opts, a.base)
	if err != nil {
		return Bot{}, err
	}
	res, reply, err := a.post(ctx, "/account/finish", answer, []*http.Cookie{ceremony})
	if err != nil {
		return Bot{}, err
	}
	switch res.StatusCode {
	case http.StatusCreated:
	case http.StatusUnprocessableEntity:
		return Bot{}, fmt.Errorf("%w: %s", errNameRefused, reply)
	default:
		return Bot{}, fmt.Errorf("POST /account/finish answered %s: %s", res.Status, reply)
	}
	if c := cookieOf(res, auth.CookieName); c != nil {
		return Bot{Cookie: c.Value, Key: key}, nil
	}
	return Bot{}, errors.New("POST /account/finish set no session")
}

func (a *httpAccounts) SignIn(ctx context.Context, key *softkey.Key) (string, error) {
	res, opts, err := a.post(ctx, "/signin/begin", nil, nil)
	if err != nil {
		return "", err
	}
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("POST /signin/begin answered %s: %s", res.Status, opts)
	}
	ceremony := cookieOf(res, auth.CeremonyCookieName("signin"))
	answer, err := key.Get(opts)
	if err != nil {
		return "", err
	}
	res, reply, err := a.post(ctx, "/signin/finish", answer, []*http.Cookie{ceremony})
	if err != nil {
		return "", err
	}
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return "", errUnknownPasskey
	default:
		return "", fmt.Errorf("POST /signin/finish answered %s: %s", res.Status, reply)
	}
	if c := cookieOf(res, auth.CookieName); c != nil {
		return c.Value, nil
	}
	return "", errors.New("POST /signin/finish set no session")
}

func (a *httpAccounts) Valid(ctx context.Context, cookie string) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.base+"/api/me", nil)
	if err != nil {
		return false, err
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: cookie})
	res, err := a.client.Do(req)
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
