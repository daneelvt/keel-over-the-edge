// SPDX-License-Identifier: AGPL-3.0-only

package watch

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A world for the list: boats in a frame, their sailors in a store, who
// allows spectators for the voyage, and the facts of each boat.

type fakeStore struct {
	mu      sync.Mutex
	sailors map[store.AccountID]store.Sailor
	follows map[store.AccountID][]store.AccountID
	reads   int
}

func (d *fakeStore) SailorsByID(_ context.Context, ids []store.AccountID) (map[store.AccountID]store.Sailor, error) {
	out := map[store.AccountID]store.Sailor{}
	for _, id := range ids {
		if s, ok := d.sailors[id]; ok {
			out[id] = s
		}
	}
	return out, nil
}

func (d *fakeStore) WatchTarget(_ context.Context, key string) (store.WatchTarget, error) {
	for id, s := range d.sailors {
		if moderation.Key(s.Name) == key {
			return store.WatchTarget{ID: id, Kind: s.Kind, Owner: s.Owner, Name: s.Name}, nil
		}
	}
	return store.WatchTarget{}, store.ErrNotFound
}

func (d *fakeStore) Follows(_ context.Context, follower store.AccountID) ([]store.Followed, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.reads++
	var out []store.Followed
	for _, id := range d.follows[follower] {
		out = append(out, store.Followed{ID: id, Sailor: d.sailors[id]})
	}
	return out, nil
}

func (d *fakeStore) Follow(_ context.Context, follower, followed store.AccountID) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.follows == nil {
		d.follows = map[store.AccountID][]store.AccountID{}
	}
	d.follows[follower] = append(d.follows[follower], followed)
	return nil
}

func (d *fakeStore) Unfollow(_ context.Context, follower, followed store.AccountID) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.follows[follower] = slices.DeleteFunc(d.follows[follower], func(id store.AccountID) bool { return id == followed })
	return nil
}

type fakeEdge struct {
	voyage  map[bus.Account]bool
	watched map[bus.Account]int
}

func (e *fakeEdge) SetVoyage(a bus.Account, on bool) { e.voyage[a] = on }
func (e *fakeEdge) Voyage(a bus.Account) bool        { return e.voyage[a] }
func (e *fakeEdge) VoyageAllows(a bus.Account, _ uint64) bool {
	return e.voyage[a]
}
func (e *fakeEdge) Watched() map[bus.Account]int { return e.watched }
func (e *fakeEdge) Watchers(a bus.Account) int   { return e.watched[a] }

// fakeSea gives each boat the facts set for its owner.
type fakeSea struct {
	facts map[bus.Account]Facts
	cards int
}

func (s *fakeSea) Facts(f *bus.Frame, slots []int32, out []Facts) {
	for i, sl := range slots {
		x, ok := s.facts[f.Owner[sl]]
		if !ok {
			x = Facts{Edge: 9, State: StateSailing, Sky: "fair"}
		}
		out[i] = x
	}
}

func (s *fakeSea) Card(f *bus.Frame, sl int32) Card {
	s.cards++
	return Card{Weather: CardWeather{WindFrom: 225, Barometer: "1004 hPa, falling"},
		Where: CardWhere{Island: &Island{Name: "Gull Island", Bearing: 45, NM: 3.1}, InSight: []string{"Gull Island · 045° 3.1 NM"}}}
}

type world struct {
	t      *testing.T
	frames *bus.Frames
	db     *fakeStore
	edge   *fakeEdge
	sea    *fakeSea
	s      *Service
	boat   uint64
	agent  bool
}

func newWorld(t *testing.T) *world {
	w := &world{t: t, frames: bus.NewFrames(256), db: &fakeStore{sailors: map[store.AccountID]store.Sailor{}},
		edge: &fakeEdge{voyage: map[bus.Account]bool{}, watched: map[bus.Account]int{}}, sea: &fakeSea{facts: map[bus.Account]Facts{}}}
	w.frames.Publish(bus.NewFrame(256))
	w.s = New(Config{Store: w.db, Frames: w.frames, Edge: w.edge, Kinds: []string{"jolly"}, Sea: w.sea,
		Agent: func(bus.Account) bool { return w.agent }})
	return w
}

// account makes an account with its sailor; owner zero for a human.
func (w *world) account(n byte, name string, owner store.AccountID) store.AccountID {
	id := store.AccountID{n}
	kind := store.Human
	if owner != (store.AccountID{}) {
		kind = store.AI
	}
	w.db.sailors[id] = store.Sailor{Name: name, Kind: kind, Owner: owner}
	return id
}

// sail puts boats of these accounts in the water, and only them, with
// the facts given, and lets the list read them again.
func (w *world) sail(ids ...store.AccountID) {
	f := bus.NewFrame(256)
	for i, id := range ids {
		sl := int32(i)
		f.Live = append(f.Live, sl)
		f.Owner[sl] = bus.Account(id)
		w.boat++
		f.Boat[sl] = w.boat
	}
	w.frames.Publish(f)
	w.s.mu.Lock()
	w.s.boats = nil
	w.s.mu.Unlock()
}

func (w *world) facts(id store.AccountID, x Facts) { w.sea.facts[bus.Account(id)] = x }

func (w *world) list(viewer store.AccountID, q Query) Page {
	w.t.Helper()
	p, err := w.s.List(context.Background(), viewer, q)
	if err != nil {
		w.t.Fatal(err)
	}
	return p
}

func names(p Page) string {
	var out []string
	for _, it := range p.Sailors {
		out = append(out, it.Name)
	}
	return strings.Join(out, ",")
}

func whys(it Item) string {
	var out []string
	for _, l := range it.Lively {
		s := l.Why
		if l.Subject != "" {
			s += ":" + l.Subject
		}
		out = append(out, s)
	}
	return strings.Join(out, ",")
}

// TestListOrders: the liveliest first, each reason a point; each other
// order; and in all of them the viewer's own machine sailors first, then
// those followed.
func TestListOrders(t *testing.T) {
	w := newWorld(t)
	viewer := w.account(1, "Viewer", store.AccountID{})
	other := w.account(2, "Other", store.AccountID{})
	calm := w.account(10, "Calm Kate", other)
	storm := w.account(11, "Storm Sal", other)
	lip := w.account(12, "Lip Lou", other)
	fast := w.account(13, "Fast Fay", other)
	mine := w.account(14, "Zed Mine", viewer)
	w.facts(calm, Facts{Sky: "calm", Force: 0, Knots: 1, Edge: 20, State: StateSailing})
	w.facts(storm, Facts{Sky: "storm", Force: 8, Knots: 6, Edge: 12, State: StateCapsized})
	w.facts(lip, Facts{Sky: "fair", Force: 4, Knots: 5, Edge: 0.4, Approaching: true, State: StateSailing, Charted: "Gull Island", Minutes: 3})
	w.facts(fast, Facts{Sky: "rain", Force: 4, Knots: 9, Edge: 5, State: StateSailing, Charted: "Old Rock", Minutes: 40})
	w.facts(mine, Facts{Sky: "fair", Force: 2, Knots: 2, Edge: 30, State: StateSailing})
	w.edge.watched[bus.Account(fast)] = 3
	w.sail(calm, storm, lip, fast, mine)

	for _, tc := range []struct{ sort, want string }{
		{"", "Zed Mine,Lip Lou,Storm Sal,Fast Fay,Calm Kate"},
		{SortLiveliest, "Zed Mine,Lip Lou,Storm Sal,Fast Fay,Calm Kate"},
		{SortWatched, "Zed Mine,Fast Fay,Calm Kate,Lip Lou,Storm Sal"},
		{SortEdge, "Zed Mine,Lip Lou,Fast Fay,Storm Sal,Calm Kate"},
		{SortWeather, "Zed Mine,Storm Sal,Fast Fay,Lip Lou,Calm Kate"},
		{SortFast, "Zed Mine,Fast Fay,Storm Sal,Lip Lou,Calm Kate"},
		{SortName, "Zed Mine,Calm Kate,Fast Fay,Lip Lou,Storm Sal"},
	} {
		if got := names(w.list(viewer, Query{Sort: tc.sort})); got != tc.want {
			t.Errorf("%q: %s, want %s", tc.sort, got, tc.want)
		}
	}
	p := w.list(viewer, Query{})
	if p.AtSea != 5 || p.Withheld {
		t.Fatalf("at sea %d, withheld %v", p.AtSea, p.Withheld)
	}
	for _, it := range p.Sailors {
		want := map[string]string{"Lip Lou": "edge,approach,charted:Gull Island", "Storm Sal": "storm,capsized", "Fast Fay": "", "Calm Kate": "", "Zed Mine": ""}[it.Name]
		if got := whys(it); got != want {
			t.Errorf("%s's reasons: %s, want %s", it.Name, got, want)
		}
		if it.EdgeNM == nil || it.Kind != "jolly" || it.State == "" {
			t.Errorf("%s's facts: %+v", it.Name, it)
		}
	}
	if got := p.Sailors[1].Lively[2].Minutes; got == nil || *got != 3 {
		t.Errorf("charted minutes ago: %v", got)
	}
	// Following Calm Kate puts her after the own machine sailor, in every
	// order.
	if _, err := w.s.Follow(context.Background(), viewer, "calm kate", true); err != nil {
		t.Fatal(err)
	}
	for _, sort := range []string{SortLiveliest, SortFast, SortName} {
		p := w.list(viewer, Query{Sort: sort})
		if got := names(p); !strings.HasPrefix(got, "Zed Mine,Calm Kate,") || !p.Sailors[1].Followed {
			t.Errorf("%s with Calm Kate followed: %s", sort, got)
		}
	}
}

// TestListFilters: by kind, by follows, by part of a name, and by names
// asked for again; a human only while allowing for the voyage; never the
// viewer's own boat.
func TestListFilters(t *testing.T) {
	w := newWorld(t)
	viewer := w.account(1, "Viewer", store.AccountID{})
	other := w.account(2, "Other", store.AccountID{})
	ann := w.account(3, "Ann Bonny", store.AccountID{})
	bob := w.account(4, "Bob", store.AccountID{})
	mary := w.account(10, "Iron Mary", other)
	tom := w.account(11, "Tin Tom", other)
	w.edge.voyage[bus.Account(ann)] = true
	w.sail(viewer, ann, bob, mary, tom)
	for _, tc := range []struct {
		q    Query
		want string
	}{
		{Query{Sort: SortName}, "Ann Bonny,Iron Mary,Tin Tom"},
		{Query{Sort: SortName, Who: WhoMachine}, "Iron Mary,Tin Tom"},
		{Query{Sort: SortName, Who: WhoHuman}, "Ann Bonny"},
		{Query{Sort: SortName, Q: "ON"}, "Ann Bonny,Iron Mary"},
		{Query{Sort: SortName, Who: WhoMachine, Q: "tom"}, "Tin Tom"},
		{Query{Names: []string{"tin tom", "Bob", "Viewer", "Ann Bonny", "Nobody"}}, ""},
	} {
		got := names(w.list(viewer, tc.q))
		if tc.q.Names != nil {
			parts := strings.Split(got, ",")
			slices.Sort(parts)
			got = strings.Join(parts, ",")
			tc.want = "Ann Bonny,Tin Tom"
		}
		if got != tc.want {
			t.Errorf("%+v: %s, want %s", tc.q, got, tc.want)
		}
	}
	// A page at a time.
	var ids []store.AccountID
	for i := range PageSize + 3 {
		ids = append(ids, w.account(byte(100+i), fmt.Sprintf("Bot %02d", i), other))
	}
	w.sail(ids...)
	p0, p1 := w.list(viewer, Query{Sort: SortName}), w.list(viewer, Query{Sort: SortName, Page: 1})
	if len(p0.Sailors) != PageSize || !p0.More || len(p1.Sailors) != 3 || p1.More || p1.Sailors[0].Name != "Bot 50" {
		t.Fatalf("pages: %d %v, %d %v", len(p0.Sailors), p0.More, len(p1.Sailors), p1.More)
	}
	if p := w.list(viewer, Query{Page: 9}); len(p.Sailors) != 0 || p.Sailors == nil {
		t.Fatalf("past the end: %+v", p)
	}
}

// TestWhereWithheld: while the viewer's own boat is in the water, the
// others' nearness to the lip and what they charted are left out of the
// rows, the reasons, the order and the card; the viewer's own machine
// sailor's are not. A viewer with no boat in the water sees them.
func TestWhereWithheld(t *testing.T) {
	w := newWorld(t)
	viewer := w.account(1, "Viewer", store.AccountID{})
	other := w.account(2, "Other", store.AccountID{})
	lip := w.account(10, "Lip Lou", other)
	far := w.account(11, "Far Fay", other)
	mine := w.account(12, "My Max", viewer)
	w.facts(lip, Facts{Sky: "squalls", Edge: 0.5, State: StateSailing, Charted: "Gull Island", Minutes: 2, Skimmed: 140})
	w.facts(far, Facts{Sky: "fair", Edge: 40, State: StateSailing, Knots: 4})
	w.facts(mine, Facts{Sky: "fair", Edge: 0.8, State: StateSailing, Charted: "Old Rock", Minutes: 1})
	w.sail(viewer, lip, far, mine)
	p := w.list(viewer, Query{Sort: SortEdge})
	if !p.Withheld || names(p) != "My Max,Lip Lou,Far Fay" {
		t.Fatalf("withheld %v, %s", p.Withheld, names(p))
	}
	for _, it := range p.Sailors {
		switch it.Name {
		case "My Max":
			if it.EdgeNM == nil || whys(it) != "edge,charted:Old Rock" {
				t.Errorf("the own machine sailor: %v %s", it.EdgeNM, whys(it))
			}
		case "Lip Lou":
			if it.EdgeNM != nil || whys(it) != "squalls,charted" {
				t.Errorf("Lip Lou: %v %s", it.EdgeNM, whys(it))
			}
		default:
			if it.EdgeNM != nil {
				t.Errorf("%s: %v", it.Name, *it.EdgeNM)
			}
		}
	}
	c, err := w.s.Card(context.Background(), viewer, "Lip Lou")
	if err != nil || c.Where != nil || c.Weather == nil || c.Voyage == nil || c.Voyage.Charted.Subject != "" || c.Voyage.SkimmedM != 140 || c.Agent != nil {
		t.Fatalf("Lip Lou's card at sea: %+v %v", c, err)
	}
	c, err = w.s.Card(context.Background(), viewer, "my max")
	if err != nil || c.Where == nil || c.Where.EdgeNM == nil || *c.Where.EdgeNM != 0.8 || c.Agent == nil || *c.Agent {
		t.Fatalf("the own machine sailor's card: %+v %v", c, err)
	}
	// Off the water, everything.
	w.sail(lip, far, mine)
	c, err = w.s.Card(context.Background(), viewer, "Lip Lou")
	if err != nil || c.Where == nil || c.Where.Island.Name != "Gull Island" || *c.Where.EdgeNM != 0.5 || c.Voyage.Charted.Subject != "Gull Island" {
		t.Fatalf("Lip Lou's card off the water: %+v %v", c, err)
	}
	p = w.list(viewer, Query{})
	if p.Withheld || p.Sailors[1].Name != "Lip Lou" || whys(p.Sailors[1]) != "squalls,edge,charted:Gull Island" {
		t.Fatalf("off the water: %v %s", p.Withheld, whys(p.Sailors[1]))
	}
	// The card's facts are made once a cache window.
	n := w.sea.cards
	if _, err := w.s.Card(context.Background(), viewer, "Lip Lou"); err != nil || w.sea.cards != n {
		t.Fatalf("made again within the window: %d after %d", w.sea.cards, n)
	}
}

// TestCardRefused: a card, and a follow, are refused as a watch is: a
// machine sailor not in the water is not at sea; a human not allowing,
// not at sea, unknown or the viewer's own, cannot be watched.
func TestCardRefused(t *testing.T) {
	w := newWorld(t)
	viewer := w.account(1, "Viewer", store.AccountID{})
	other := w.account(2, "Other", store.AccountID{})
	ann := w.account(3, "Ann Bonny", store.AccountID{})
	w.account(4, "Bob", store.AccountID{})
	w.account(10, "Iron Mary", other)
	w.sail(viewer, ann)
	for name, want := range map[string]error{
		"Iron Mary": ErrNotAtSea, "Ann Bonny": ErrCannot, "Bob": ErrCannot, "Nobody": ErrCannot, "Viewer": ErrCannot, "": ErrCannot,
	} {
		if _, err := w.s.Card(context.Background(), viewer, name); !errors.Is(err, want) {
			t.Errorf("card of %q: %v, want %v", name, err, want)
		}
		if _, err := w.s.Follow(context.Background(), viewer, name, true); !errors.Is(err, want) {
			t.Errorf("follow of %q: %v, want %v", name, err, want)
		}
	}
}

// TestFollowing: a follow only of a sailor that may be watched, at most
// MaxFollows, read from the database once; the Following filter, with
// those that cannot be watched now after, by kind; a human who stops
// allowing is no longer a row; unfollowing; and an account deleted
// forgotten.
func TestFollowing(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	viewer := w.account(1, "Viewer", store.AccountID{})
	other := w.account(2, "Other", store.AccountID{})
	ann := w.account(3, "Ann Bonny", store.AccountID{})
	mary := w.account(10, "Iron Mary", other)
	tom := w.account(11, "Tin Tom", other)
	w.edge.voyage[bus.Account(ann)] = true
	w.sail(ann, mary, tom)
	for _, name := range []string{"Ann Bonny", "iron mary"} {
		if _, err := w.s.Follow(ctx, viewer, name, true); err != nil {
			t.Fatal(name, err)
		}
	}
	if n, err := w.s.Follow(ctx, viewer, "Iron Mary", true); err != nil || n != 2 {
		t.Fatalf("following again: %d %v", n, err)
	}
	if got := names(w.list(viewer, Query{Who: WhoFollowing})); got != "Ann Bonny,Iron Mary" {
		t.Fatalf("following, all at sea: %s", got)
	}
	// Ann stops allowing; Iron Mary leaves the water.
	w.edge.voyage[bus.Account(ann)] = false
	w.sail(ann, tom)
	p := w.list(viewer, Query{Who: WhoFollowing})
	if len(p.Sailors) != 2 || p.Sailors[0].Gone != GoneCannot || p.Sailors[0].Name != "Ann Bonny" ||
		p.Sailors[1].Gone != GoneNotAtSea || p.Sailors[1].Name != "Iron Mary" || p.Sailors[1].Sky != "" {
		t.Fatalf("following, none watchable: %+v", p.Sailors)
	}
	if got := names(w.list(viewer, Query{})); got != "Tin Tom" {
		t.Fatalf("everyone: %s", got)
	}
	if n, err := w.s.Follow(ctx, viewer, "Ann Bonny", false); err != nil || n != 1 {
		t.Fatalf("unfollowing: %d %v", n, err)
	}
	if n, err := w.s.Follow(ctx, viewer, "Nobody", false); err != nil || n != 1 {
		t.Fatalf("unfollowing one not followed: %d %v", n, err)
	}
	if w.db.reads != 1 {
		t.Fatalf("the follows read %d times", w.db.reads)
	}
	// The most.
	var ids []store.AccountID
	for i := range MaxFollows {
		ids = append(ids, w.account(byte(100+i), fmt.Sprintf("Bot %03d", i), other))
	}
	w.sail(ids...)
	var err error
	for i := range MaxFollows {
		if _, err = w.s.Follow(ctx, viewer, fmt.Sprintf("Bot %03d", i), true); err != nil {
			break
		}
	}
	if !errors.Is(err, ErrTooMany) {
		t.Fatalf("past the most: %v", err)
	}
	// An account deleted goes from the follows kept.
	w.s.Forget(mary)
	if fol, _ := w.s.followsOf(ctx, viewer); len(fol) != MaxFollows-1 {
		t.Fatalf("after Iron Mary went: %d", len(fol))
	}
}

// TestSpectatorsChoice: no or this voyage, never always.
func TestSpectatorsChoice(t *testing.T) {
	w := newWorld(t)
	ann := w.account(3, "Ann Bonny", store.AccountID{})
	ctx := context.Background()
	if err := w.s.SetSpectators(ctx, ann, "always"); !errors.Is(err, ErrAllow) {
		t.Fatalf("always: %v", err)
	}
	if err := w.s.SetSpectators(ctx, ann, AllowVoyage); err != nil || w.s.Spectators(ann) != AllowVoyage {
		t.Fatalf("this voyage: %v %s", err, w.s.Spectators(ann))
	}
	if err := w.s.SetSpectators(ctx, ann, AllowNo); err != nil || w.s.Spectators(ann) != AllowNo {
		t.Fatalf("no: %v %s", err, w.s.Spectators(ann))
	}
}
