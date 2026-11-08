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
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
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
}

// crew is a group's link, once its skipper has made it.
type crew struct {
	token chan string
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
	i := strings.LastIndex(l.URL, "/sail/")
	if i < 0 {
		return "", errors.New("a link with no /sail/ in it: " + l.URL)
	}
	return l.URL[i+len("/sail/"):], nil
}

// Boarder is what crews need of the accounts: the HTTP accounts have it.
type Boarder interface {
	readyToBoard(ctx context.Context, cookie string) error
	link(ctx context.Context, cookie string) (string, error)
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
		t, err := b.link(ctx, cookie)
		if err != nil {
			return nil, err
		}
		token = t
		g.token <- t
		close(g.token)
	} else {
		select {
		case t, ok := <-g.token:
			if ok {
				token = t
			}
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	rng := rand.New(rand.NewPCG(uint64(i), 13))
	return func(s *client.Sailor) {
		var aboard bool
		var people int
		var knockAt, handAt, backAt time.Time
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
			case *pb.ServerMessage_Handed:
				if !b.Handed.GetGone() {
					p.Crewing.Taken++
					_ = s.Command(ctx, &pb.Command{Body: &pb.Command_Take{Take: &pb.Take{}}})
				}
			}
		}
		s.OnView = chainView(s.OnView, func(ev *client.Event) {
			now := time.Now()
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
	}
	if c.Knocks == 0 && c.Handed == 0 {
		return
	}
	fmt.Fprintf(w, "crews: %d knocks (%d refused), %d let aboard, %d welcomed aboard; the controls handed %d times, taken %d, taken back %d\n",
		c.Knocks, c.Refused, c.Answered, c.Aboard, c.Handed, c.Taken, c.Back)
}
