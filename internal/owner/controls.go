// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	position "github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// The controls: each a POST of a JSON body, each logged with the account,
// the boat, what was done and the address the request came from, and
// counted (keel_owner_actions_total); what is refused is counted too
// (keel_owner_refused_total). They act on the owner's own boats alone: a
// boat whose account does not carry the owner's flag is not moved or
// hidden. Moving other players' boats is moderation, not the owner's tools.

// FlagRequest sets or clears an account's owner's flag.
type FlagRequest struct {
	Account string `json:"account"`
	On      bool   `json:"on"`
}

// PriorityRequest marks an account, human or AI, as a priority account,
// which never waits for a boat, or not.
type PriorityRequest struct {
	Account string `json:"account"`
	On      bool   `json:"on"`
}

// PlaceRequest moves a flagged account's boat, at rest: to a point (East
// and North, m), to a position as written (Position: 67°24′N 045°12′), to
// the start, to an island's approach (Island, its number), to a place's
// (Place, its number), or under its free camera (Camera). Heading is in
// degrees, clockwise from north; without it the boat keeps its own, or at
// an island or a place faces it.
type PlaceRequest struct {
	Boat     uint64   `json:"boat"`
	East     *float64 `json:"east,omitempty"`
	North    *float64 `json:"north,omitempty"`
	Position *string  `json:"position,omitempty"`
	Heading  *float64 `json:"heading,omitempty"`
	Start    bool     `json:"start,omitempty"`
	Island   *int     `json:"island,omitempty"`
	Place    *int     `json:"place,omitempty"`
	Town     *int     `json:"town,omitempty"`
	Feature  *int     `json:"feature,omitempty"`
	Camera   bool     `json:"camera,omitempty"`
}

// UnseenRequest keeps a flagged account's boat out of every other
// connection's view, or shows it again.
type UnseenRequest struct {
	Boat uint64 `json:"boat"`
	On   bool   `json:"on"`
}

// readBody decodes a control's body into v, answering 400 if it cannot.
func readBody(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		http.Error(w, "the body is not this control's", http.StatusBadRequest)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

// parseAccount reads an account's UUID, with its dashes or without.
func parseAccount(s string) (store.AccountID, bool) {
	var id store.AccountID
	raw := strings.ReplaceAll(s, "-", "")
	if len(raw) != 32 {
		return id, false
	}
	_, err := hex.Decode(id[:], []byte(raw))
	return id, err == nil
}

func (o *Owner) count(action string) {
	if m := o.cfg.Metrics; m != nil {
		m.OwnerActions.WithLabelValues(action).Inc()
	}
}

func (o *Owner) refuse(w http.ResponseWriter, what string, status int, why string) {
	if m := o.cfg.Metrics; m != nil {
		m.OwnerRefused.WithLabelValues(what).Inc()
	}
	http.Error(w, why, status)
}

// dbTimeout bounds a control's reads and writes of the database.
const dbTimeout = 5 * time.Second

// flag sets or clears an account's owner's flag: the database first, then
// the sessions' cache forgets the account, and its open connection is told,
// so the change takes effect at once. Cleared, its free camera comes back
// to the boat, and its boat is seen again.
//
//	POST /owner/api/flag {"account": "…", "on": true}
func (o *Owner) flag(w http.ResponseWriter, r *http.Request) {
	var req FlagRequest
	if !readBody(w, r, &req) {
		return
	}
	id, ok := parseAccount(req.Account)
	if !ok {
		o.refuse(w, "flag", http.StatusBadRequest, "account is not an account's id")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	err := o.cfg.Accounts.SetTools(ctx, id, req.On)
	switch {
	case errors.Is(err, store.ErrNotFound):
		o.refuse(w, "flag", http.StatusNotFound, "no human account of that id: only a human account carries the flag")
		return
	case err != nil:
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	if o.cfg.Sessions != nil {
		o.cfg.Sessions.ForgetAccount(id)
	}
	connected := false
	if o.cfg.Edge != nil {
		connected = o.cfg.Edge.Tools(bus.Account(id), req.On)
	}
	if !req.On {
		if boat, _, ok := o.boatOf(bus.Account(id)); ok {
			o.send(bus.Command{Op: bus.Unseen, Boat: boat, On: false})
		}
	}
	o.b.forget(id)
	action := "flag"
	if !req.On {
		action = "unflag"
	}
	o.count(action)
	o.record(r, action, &id, "")
	o.cfg.Log.Info("owner: an account's flag set", "action", action, "account", id.String(), "connected", connected, "from", r.RemoteAddr)
	writeJSON(w, map[string]any{"account": id.String(), "on": req.On, "connected": connected})
}

// priority marks an account, human or AI, as a priority account or not:
// the database first, then the sessions' cache and the machine sailors'
// door forget the account, so its next join reads it again. A boat at sea
// keeps the place it was given; the change applies from the account's
// next join.
//
//	POST /owner/api/priority {"account": "…", "on": true}
func (o *Owner) priority(w http.ResponseWriter, r *http.Request) {
	var req PriorityRequest
	if !readBody(w, r, &req) {
		return
	}
	id, ok := parseAccount(req.Account)
	if !ok {
		o.refuse(w, "priority", http.StatusBadRequest, "account is not an account's id")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	err := o.cfg.Accounts.SetPriority(ctx, id, req.On)
	switch {
	case errors.Is(err, store.ErrNotFound):
		o.refuse(w, "priority", http.StatusNotFound, "no account of that id")
		return
	case err != nil:
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	if o.cfg.Sessions != nil {
		o.cfg.Sessions.ForgetAccount(id)
	}
	if o.cfg.Door != nil {
		o.cfg.Door.ForgetAccounts(id)
	}
	o.b.forget(id)
	action := "priority"
	if !req.On {
		action = "unpriority"
	}
	o.count(action)
	o.record(r, action, &id, "")
	o.cfg.Log.Info("owner: an account's priority set", "action", action, "account", id.String(), "from", r.RemoteAddr)
	writeJSON(w, map[string]any{"account": id.String(), "on": req.On})
}

// boatOf is the boat of an account at sea and its state, in the latest
// frame.
func (o *Owner) boatOf(account bus.Account) (uint64, physics.State, bool) {
	f := o.cfg.Frames.Acquire()
	defer f.Release()
	for _, s := range f.Live {
		if f.Owner[s] == account {
			return f.Boat[s], f.State[s], true
		}
	}
	return 0, physics.State{}, false
}

// boat is a boat at sea: its account and state, and the other boats'
// places, from the latest frame.
func (o *Owner) boat(id uint64) (account bus.Account, st physics.State, others [][2]float64, ok bool) {
	f := o.cfg.Frames.Acquire()
	defer f.Release()
	for _, s := range f.Live {
		if f.Boat[s] == id {
			account, st, ok = f.Owner[s], f.State[s], true
			continue
		}
		others = append(others, [2]float64{f.State[s].X, f.State[s].Y})
	}
	return account, st, others, ok
}

// flagged reports whether an account carries the owner's flag, read from
// the database now.
func (o *Owner) flagged(ctx context.Context, account bus.Account) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, dbTimeout)
	defer cancel()
	found, err := o.cfg.Accounts.Accounts(ctx, []store.AccountID{store.AccountID(account)})
	if err != nil {
		return false, err
	}
	a, ok := found[store.AccountID(account)]
	return ok && a.Tools && a.Kind == store.Human, nil
}

// send sends one of the owner's tools' commands, trying for a second while
// the queue is full.
func (o *Owner) send(c bus.Command) error {
	var err error
	for range 30 {
		if err = o.cfg.Owner.TrySend(c); !errors.Is(err, bus.ErrBusy) {
			return err
		}
		time.Sleep(time.Second / 30)
	}
	return err
}

// ErrWater is a point a teleport refuses.
var ErrWater = errors.New("owner: no water there for a boat")

// water checks a point a boat may be put at: within the lip, at least the
// rules' depth over the land sailed, and clear of every other boat.
func (o *Owner) water(x, y float64, others [][2]float64) error {
	switch {
	case math.IsNaN(x) || math.IsNaN(y) || math.IsInf(x, 0) || math.IsInf(y, 0):
		return errors.New("not a point")
	case physics.EdgeDistance(o.cfg.Weather, x, y) <= 0:
		return errors.New("at or beyond the lip")
	}
	if g := o.cfg.Ground; g != nil {
		if e, _ := g.At(x, y); e > 0 {
			return errors.New("over land")
		} else if -e < o.cfg.Rules.Depth {
			return errors.New("shallower than the rules allow")
		}
	}
	for _, p := range others {
		if math.Hypot(p[0]-x, p[1]-y) < o.cfg.Rules.Clear {
			return errors.New("beside another boat")
		}
	}
	return nil
}

// place moves a flagged account's boat, at rest, through the simulation's
// Teleport: its course is cleared and its voyage earns nothing.
//
//	POST /owner/api/place {"boat": 1, "east": …, "north": …, "heading": …}
//	POST /owner/api/place {"boat": 1, "position": "67°24′N 045°12′"}
//	POST /owner/api/place {"boat": 1, "start": true}
//	POST /owner/api/place {"boat": 1, "island": 12}
//	POST /owner/api/place {"boat": 1, "town": 3}: in its harbour
//	POST /owner/api/place {"boat": 1, "camera": true}
func (o *Owner) place(w http.ResponseWriter, r *http.Request) {
	var req PlaceRequest
	if !readBody(w, r, &req) {
		return
	}
	account, st, others, ok := o.boat(req.Boat)
	if !ok {
		o.refuse(w, "place", http.StatusConflict, "no such boat at sea")
		return
	}
	if ok, err := o.flagged(r.Context(), account); err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	} else if !ok {
		o.refuse(w, "place", http.StatusForbidden, "the boat's account does not carry the owner's flag")
		return
	}
	heading := st.Heading
	c := bus.Command{Op: bus.Teleport, Boat: req.Boat}
	var x, y float64
	switch {
	case req.Start:
		c.Start = true
	case req.Island != nil:
		b := o.cfg.Bundle
		n := *req.Island
		if b == nil || n < 0 || n >= len(b.Islands) {
			o.refuse(w, "place", http.StatusBadRequest, "no such island")
			return
		}
		is := &b.Islands[n]
		ax, ay, found := approach(b.Ground, is, o.cfg.Rules.Approach)
		if !found {
			o.refuse(w, "place", http.StatusConflict, "the island has no approach")
			return
		}
		x, y = ax, ay
		heading = math.Atan2(is.X-x, is.Y-y)
	case req.Place != nil:
		b := o.cfg.Bundle
		var p *worldgen.Place
		if b != nil {
			for i := range b.Places {
				if int(b.Places[i].Number) == *req.Place {
					p = &b.Places[i]
				}
			}
		}
		if p == nil {
			o.refuse(w, "place", http.StatusBadRequest, "no such place")
			return
		}
		ax, ay, found := placeApproach(b.Ground, p.X, p.Y, o.cfg.Rules.Approach)
		if !found {
			o.refuse(w, "place", http.StatusConflict, "the place has no approach")
			return
		}
		x, y = ax, ay
		if math.Hypot(p.X-x, p.Y-y) > 1 {
			heading = math.Atan2(p.X-x, p.Y-y)
		}
	case req.Town != nil:
		b := o.cfg.Bundle
		n := *req.Town
		if b == nil || n < 0 || n >= len(b.Towns) {
			o.refuse(w, "place", http.StatusBadRequest, "no such town")
			return
		}
		t := &b.Towns[n]
		hx, hy, found := harbourPoint(&o.cfg, t)
		if !found {
			o.refuse(w, "place", http.StatusConflict, "the town's harbour has no water deep enough")
			return
		}
		x, y = hx, hy
		if t.Kind == "main" {
			heading = b.Start.HeadingOf(0)
		} else if math.Hypot(t.X-x, t.Y-y) > 1 {
			heading = math.Atan2(t.X-x, t.Y-y)
		}
	case req.Feature != nil:
		// Where a boat sees it from, facing it.
		b := o.cfg.Bundle
		n := *req.Feature
		if b == nil || n < 0 || n >= len(b.Features) {
			o.refuse(w, "place", http.StatusBadRequest, "no such feature")
			return
		}
		f := &b.Features[n]
		fx, fy, found := f.SightX, f.SightY, f.Seen
		if !found {
			fx, fy, found = placeApproach(b.Ground, f.X, f.Y, o.cfg.Rules.Approach)
		}
		if !found {
			o.refuse(w, "place", http.StatusConflict, "no water deep enough near the feature")
			return
		}
		x, y = fx, fy
		if math.Hypot(f.X-x, f.Y-y) > 1 {
			heading = math.Atan2(f.X-x, f.Y-y)
		}
	case req.Camera:
		ex, ey, roaming := o.cfg.Edge.Eye(account)
		if !roaming {
			o.refuse(w, "place", http.StatusConflict, "the boat's free camera is not roaming")
			return
		}
		x, y = ex, ey
	case req.Position != nil:
		px, py, err := position.ParsePosition(*req.Position)
		if err != nil {
			o.refuse(w, "place", http.StatusBadRequest, "the position: "+err.Error())
			return
		}
		x, y = px, py
	case req.East != nil && req.North != nil:
		x, y = *req.East, *req.North
	default:
		o.refuse(w, "place", http.StatusBadRequest, "east and north, a position, start, island, place, town or camera is required")
		return
	}
	if req.Heading != nil {
		if h := *req.Heading; math.IsNaN(h) || math.IsInf(h, 0) {
			o.refuse(w, "place", http.StatusBadRequest, "heading is not a heading")
			return
		}
		heading = *req.Heading * math.Pi / 180
	}
	heading = math.Remainder(heading, 2*math.Pi)
	if !c.Start {
		if err := o.water(x, y, others); err != nil {
			o.refuse(w, "place", http.StatusConflict, err.Error())
			return
		}
		c.State = physics.State{X: x, Y: y, Heading: heading}
	}
	if err := o.send(c); err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	o.count("place")
	o.cfg.Log.Info("owner: a boat teleported", "action", "place", "account", store.AccountID(account).String(), "boat", req.Boat,
		"east", x, "north", y, "heading", degrees(heading), "start", c.Start, "from", r.RemoteAddr)
	writeJSON(w, map[string]any{"boat": req.Boat, "east": round2(x), "north": round2(y), "heading": round2(degrees(heading)), "start": c.Start})
}

// unseen keeps a flagged account's boat out of every other connection's
// view, or shows it again.
//
//	POST /owner/api/unseen {"boat": 1, "on": true}
func (o *Owner) unseen(w http.ResponseWriter, r *http.Request) {
	var req UnseenRequest
	if !readBody(w, r, &req) {
		return
	}
	account, _, _, ok := o.boat(req.Boat)
	if !ok {
		o.refuse(w, "unseen", http.StatusConflict, "no such boat at sea")
		return
	}
	if ok, err := o.flagged(r.Context(), account); err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	} else if !ok {
		o.refuse(w, "unseen", http.StatusForbidden, "the boat's account does not carry the owner's flag")
		return
	}
	if err := o.send(bus.Command{Op: bus.Unseen, Boat: req.Boat, On: req.On}); err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	action := "unseen"
	if !req.On {
		action = "seen"
	}
	o.count(action)
	o.cfg.Log.Info("owner: a boat hidden or shown", "action", action, "account", store.AccountID(account).String(), "boat", req.Boat, "from", r.RemoteAddr)
	writeJSON(w, map[string]any{"boat": req.Boat, "on": req.On})
}
