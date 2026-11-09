// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// Crews: with -crews k the players sail in groups of k, the first of each
// its skipper and the rest its crew, as friends who share a link do. The
// skipper makes a link; each of the others, in the water, knocks with it;
// the skipper lets every knock aboard. From then the skipper hands the
// controls to someone aboard now and then, who takes them, and takes them
// back a while later; someone put ashore by the boat leaving knocks again.

// Crewing is what the load bot does of sailing together, by player.
type Crewing struct {
	Knocks   int // knocks made
	Aboard   int // times let aboard
	Answered int // knocks the skipper let aboard
	Handed   int // the controls handed on
	Taken    int // the controls taken when handed
	Back     int // the controls taken back by the skipper
	Refused  int // knocks told anything but waiting or let aboard
	// Chat, with -chat: lines said, said lines that came back said,
	// lines refused, and lines heard from others aboard.
	Said, Echoed, Silenced, Heard int
}

// chatLines are what the bots say aboard: sailors' talk, 30 to 160
// bytes, nothing the filter refuses.
var chatLines = []string{
	"Ready about? I will ease the sheet as we come through the wind.",
	"The breeze is filling in from the west, we should be able to lay the point on this tack.",
	"Mind the boom when she gybes.",
	"There is a squall line on the horizon, maybe reef now before it reaches us and the sea builds up.",
	"Nice puff, she is really moving now, look at the wake.",
	"Can you take the helm for a bit while I sort out the lines in the cockpit and coil the main sheet?",
	"Land ho, fine on the port bow.",
	"Shall we head for the harbour before dark, or stay out and watch the stars come up over the water tonight?",
}

// crew is a group's link: ready is closed once its skipper has made it,
// token then its token.
type crew struct {
	ready chan struct{}
	token string
}

// readyToBoard answers, for an older bot, the age question once (as an
// adult; a second answer is refused and harmless) and accepts the Rules
// of the sea, as the start screen asks a player before their first knock
// or link.
func (a *httpAccounts) readyToBoard(ctx context.Context, cookie string) error {
	c := []*http.Cookie{{Name: auth.CookieName, Value: cookie}}
	res, body, err := a.post(ctx, "/api/me/born", []byte(`{"year":1990,"month":1}`), c)
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusNoContent && res.StatusCode != http.StatusConflict {
		return fmt.Errorf("POST /api/me/born answered %s: %s", res.Status, body)
	}
	res, body, err = a.post(ctx, "/api/me/rules", []byte(`{}`), c)
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusNoContent {
		return fmt.Errorf("POST /api/me/rules answered %s: %s", res.Status, body)
	}
	return nil
}

// roomyBoat takes, from the bot's fleet, the smallest boat that carries
// at least n, for its next voyage, as the start screen's Change boat does.
func (a *httpAccounts) roomyBoat(ctx context.Context, cookie string, n int) error {
	cat, err := catalog.Load()
	if err != nil {
		return err
	}
	room := map[string]int{}
	for _, b := range cat.Boats {
		room[string(b.ID)] = b.Capacity
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.base+"/api/fleet", nil)
	if err != nil {
		return err
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: cookie})
	res, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var f struct {
		Boats []struct {
			ID   string `json:"id"`
			Kind string `json:"kind"`
		} `json:"boats"`
	}
	if err := json.NewDecoder(res.Body).Decode(&f); err != nil {
		return err
	}
	best, most := "", 0
	for _, b := range f.Boats {
		if c := room[b.Kind]; c >= n && (best == "" || c < most) {
			best, most = b.ID, c
		}
	}
	if best == "" {
		return fmt.Errorf("no boat in the fleet carries %d", n)
	}
	body, _ := json.Marshal(map[string]string{"boat": best})
	r, reply, err := a.post(ctx, "/api/boat", body, []*http.Cookie{{Name: auth.CookieName, Value: cookie}})
	if err != nil {
		return err
	}
	if r.StatusCode != http.StatusOK {
		return fmt.Errorf("POST /api/boat answered %s: %s", r.Status, reply)
	}
	return nil
}

// link makes a link to come aboard the bot's boat and returns its token.
func (a *httpAccounts) link(ctx context.Context, cookie string) (string, error) {
	res, body, err := a.post(ctx, "/api/sail/link", []byte(`{}`), []*http.Cookie{{Name: auth.CookieName, Value: cookie}})
	if err != nil {
		return "", err
	}
	if res.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("POST /api/sail/link answered %s: %s", res.Status, body)
	}
	var l struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(body, &l); err != nil {
		return "", err
	}
	u, err := url.Parse(l.URL)
	if err != nil {
		return "", err
	}
	token := u.Query().Get("s")
	if token == "" {
		return "", errors.New("a link with no token in it: " + l.URL)
	}
	return token, nil
}

// Boarder is what crews need of the accounts: the HTTP accounts have it.
type Boarder interface {
	readyToBoard(ctx context.Context, cookie string) error
	link(ctx context.Context, cookie string) (string, error)
	roomyBoat(ctx context.Context, cookie string, n int) error
}

var _ Boarder = (*httpAccounts)(nil)

// crewOne sets player i's sailor up to sail in its group: the skipper
// makes the link and shares it; everyone answers what a first knock or
// link asks. It returns the hooks to give the sailor.
func crewOne(ctx context.Context, cfg Config, groups []*crew, i int, cookie string, p *Player) (func(s *client.Sailor), error) {
	b, ok := cfg.Accounts.(Boarder)
	if !ok {
		return nil, errors.New("-crews needs the game's own accounts")
	}
	if err := b.readyToBoard(ctx, cookie); err != nil {
		return nil, err
	}
	g := groups[i/cfg.Crews]
	skipper := i%cfg.Crews == 0
	token := ""
	if skipper {
		if err := b.roomyBoat(ctx, cookie, cfg.Crews); err != nil {
			return nil, err
		}
		t, err := b.link(ctx, cookie)
		if err != nil {
			return nil, err
		}
		token = t
		g.token = t
		close(g.ready)
	} else {
		select {
		case <-g.ready:
			token = g.token
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	rng := rand.New(rand.NewPCG(uint64(i), 13))
	return func(s *client.Sailor) {
		var aboard bool
		var people int
		var knockAt, handAt, backAt, sayAt time.Time
		var said uint32
		every := time.Duration(0)
		if cfg.Chat > 0 {
			every = time.Duration(float64(time.Minute) / cfg.Chat)
		}
		knock := func() {
			if time.Now().Before(knockAt) {
				return
			}
			knockAt = time.Now().Add(15 * time.Second)
			p.Crewing.Knocks++
			_ = s.Command(ctx, &pb.Command{Body: &pb.Command_Knock{Knock: &pb.Knock{Token: token}}})
		}
		s.OnDeck = func(m *pb.ServerMessage) {
			switch b := m.Body.(type) {
			case *pb.ServerMessage_Welcome:
				aboard = b.Welcome.GetAboard() != nil
				if aboard {
					p.Crewing.Aboard++
				}
				if !skipper && !aboard {
					knockAt = time.Time{}
					knock()
				}
				if skipper {
					handAt = time.Now().Add(time.Duration(20+rng.IntN(40)) * time.Second)
				}
			case *pb.ServerMessage_Knock:
				if skipper && !b.Knock.GetGone() {
					p.Crewing.Answered++
					_ = s.Command(ctx, &pb.Command{Body: &pb.Command_Answer{Answer: &pb.Answer{Knock: b.Knock.GetId(), Let: true}}})
				}
			case *pb.ServerMessage_Knocking:
				if st := b.Knocking.GetState(); st != pb.KnockState_KNOCK_STATE_WAITING && st != pb.KnockState_KNOCK_STATE_LET {
					p.Crewing.Refused++
				}
			case *pb.ServerMessage_Crew:
				people = len(b.Crew.GetPeople())
			case *pb.ServerMessage_Chat:
				switch c := b.Chat; {
				case !c.GetYou():
					p.Crewing.Heard++
				case c.GetRefused() == pb.ChatRefusal_CHAT_REFUSAL_UNSPECIFIED:
					p.Crewing.Echoed++
				default:
					p.Crewing.Silenced++
				}
			case *pb.ServerMessage_Handed:
				if !b.Handed.GetGone() {
					p.Crewing.Taken++
					_ = s.Command(ctx, &pb.Command{Body: &pb.Command_Take{Take: &pb.Take{}}})
				}
			}
		}
		s.OnView = chainView(s.OnView, func(ev *client.Event) {
			now := time.Now()
			if every > 0 && people > 1 && (aboard || skipper) && now.After(sayAt) {
				if !sayAt.IsZero() {
					said++
					p.Crewing.Said++
					_ = s.Command(ctx, &pb.Command{Body: &pb.Command_Say{Say: &pb.Say{Text: chatLines[rng.IntN(len(chatLines))], Id: said}}})
				}
				sayAt = now.Add(every/2 + time.Duration(rng.Int64N(int64(every))))
			}
			switch {
			case !skipper:
				if !aboard {
					knock()
				}
			case people > 1 && !ev.Snapshot.Elsewhere && now.After(handAt):
				handAt = now.Add(time.Duration(30+rng.IntN(60)) * time.Second)
				backAt = now.Add(time.Duration(10+rng.IntN(20)) * time.Second)
				p.Crewing.Handed++
				_ = s.Command(ctx, &pb.Command{Body: &pb.Command_Hand{Hand: &pb.Hand{To: uint32(1 + rng.IntN(people-1))}}})
			case ev.Snapshot.Elsewhere && !backAt.IsZero() && now.After(backAt):
				// Taken back mid-whatever, at once.
				backAt = time.Time{}
				p.Crewing.Back++
				_ = s.Command(ctx, &pb.Command{Body: &pb.Command_Take{Take: &pb.Take{}}})
			}
		})
	}, nil
}

// chainView calls a, if not nil, then b.
func chainView(a, b func(ev *client.Event)) func(ev *client.Event) {
	return func(ev *client.Event) {
		if a != nil {
			a(ev)
		}
		b(ev)
	}
}

// printCrews writes what the crews did.
func (r *Report) printCrews(w io.Writer) {
	var c Crewing
	for _, p := range r.Players {
		x := p.Crewing
		c.Knocks += x.Knocks
		c.Aboard += x.Aboard
		c.Answered += x.Answered
		c.Handed += x.Handed
		c.Taken += x.Taken
		c.Back += x.Back
		c.Refused += x.Refused
		c.Said += x.Said
		c.Echoed += x.Echoed
		c.Silenced += x.Silenced
		c.Heard += x.Heard
	}
	if c.Knocks == 0 && c.Handed == 0 {
		return
	}
	fmt.Fprintf(w, "crews: %d knocks (%d refused), %d let aboard, %d welcomed aboard; the controls handed %d times, taken %d, taken back %d\n",
		c.Knocks, c.Refused, c.Answered, c.Aboard, c.Handed, c.Taken, c.Back)
	if c.Said > 0 {
		fmt.Fprintf(w, "chat: %d lines said, %d said back to their sender, %d refused, %d heard by others aboard\n", c.Said, c.Echoed, c.Silenced, c.Heard)
	}
}
