// SPDX-License-Identifier: AGPL-3.0-only

package watch

import (
	"cmp"
	"context"
	"errors"
	"math"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The list of sailors a player may watch, the card about one of them,
// the sailors a player follows, and the choice that puts a human on the
// list for a voyage: a world's, built from its latest frame and the
// facts the world makes of each boat once a cache window. The choice is
// held by the game connection with the boat, and is never stored.

// PageSize is how many sailors a page of the list has.
const PageSize = 50

// Cached is how long the boats in the water, their sailors' names and
// their facts are kept for the list, and a card's facts for its boat,
// before they are made again.
const Cached = 2 * time.Second

// MaxNames is how many sailors one refresh of the list may ask for by
// name.
const MaxNames = 100

// MaxFollows is how many sailors an account may follow.
const MaxFollows = 100

// The choices of who may watch a human: no one, or anyone for this
// voyage.
const (
	AllowNo     = "no"
	AllowVoyage = "voyage"
)

// The list's orders. In every one the viewer's own machine sailors come
// first, then the sailors the viewer follows.
const (
	SortLiveliest = "liveliest"
	SortWatched   = "watched"
	SortEdge      = "edge"
	SortWeather   = "weather"
	SortFast      = "fast"
	SortName      = "name"
)

// The list's filters.
const (
	WhoAll       = "all"
	WhoFollowing = "following"
	WhoMachine   = "machine"
	WhoHuman     = "human"
)

// Why a sailor on the Following filter cannot be watched now, as a
// refused watch says it: a machine sailor not in the water, and anyone
// else, whatever the reason.
const (
	GoneNotAtSea = "not-at-sea"
	GoneCannot   = "cannot"
)

var (
	// ErrAllow is a choice that is none of the setting's.
	ErrAllow = errors.New("watch: not a choice of the setting")
	// ErrNotAtSea is a machine sailor not in the water.
	ErrNotAtSea = errors.New("watch: not at sea")
	// ErrCannot is any other sailor who cannot be watched now.
	ErrCannot = errors.New("watch: cannot be watched")
	// ErrTooMany is a follow past MaxFollows.
	ErrTooMany = errors.New("watch: following too many")
)

// Store is what watching reads and writes in the database.
type Store interface {
	SailorsByID(ctx context.Context, ids []store.AccountID) (map[store.AccountID]store.Sailor, error)
	WatchTarget(ctx context.Context, key string) (store.WatchTarget, error)
	Follows(ctx context.Context, follower store.AccountID) ([]store.Followed, error)
	Follow(ctx context.Context, follower, followed store.AccountID) error
	Unfollow(ctx context.Context, follower, followed store.AccountID) error
}

// Edge is what watching asks of the game connection: who allows
// spectators for the voyage, and how many watch whom.
type Edge interface {
	SetVoyage(a bus.Account, on bool)
	Voyage(a bus.Account) bool
	VoyageAllows(a bus.Account, boat uint64) bool
	Watched() map[bus.Account]int
	Watchers(a bus.Account) int
}

// Config sets up a world's watching.
type Config struct {
	Store  Store
	Frames *bus.Frames
	Edge   Edge
	// Kinds are the catalog's boats' ids, by the world's index of kinds.
	Kinds []string
	// Sea makes the boats' facts; nil for none, when the list has only
	// names.
	Sea Sea
	// Agent, if not nil, says whether a machine sailor's AI app is
	// connected, by the sailor's account: told on its owner's card.
	Agent func(bus.Account) bool
}

// Service is a world's watching: the list, the card, following, and the
// choice.
type Service struct {
	cfg Config

	mu    sync.Mutex
	at    time.Time
	boats []boat

	cmu   sync.Mutex
	cards map[store.AccountID]card

	fmu     sync.Mutex
	follows map[store.AccountID]map[store.AccountID]store.Sailor
}

// boat is a boat in the water, as the list reads it.
type boat struct {
	owner  store.AccountID
	id     uint64
	kind   uint16
	unseen bool
	sailor store.Sailor
	key    string
	facts  Facts
}

// card is a card's facts of a boat, and when they were made.
type card struct {
	at   time.Time
	boat uint64
	c    Card
}

// New makes a world's watching.
func New(cfg Config) *Service {
	return &Service{cfg: cfg, cards: map[store.AccountID]card{}, follows: map[store.AccountID]map[store.AccountID]store.Sailor{}}
}

// Item is a sailor on the list: the name, whether a machine sailor and
// whether the viewer's own, the kind of boat, the catalog's id, how many
// watch it, the facts of its boat and why it ranks high. EdgeNM is left
// out while it is withheld. On the Following filter, Gone says why a
// sailor followed cannot be watched now, and the facts are zero.
type Item struct {
	Name     string   `json:"name"`
	Machine  bool     `json:"machine"`
	Mine     bool     `json:"mine"`
	Kind     string   `json:"kind"`
	Watchers int      `json:"watchers"`
	Sky      string   `json:"sky"`
	Night    bool     `json:"night"`
	Force    int      `json:"force"`
	Knots    float64  `json:"knots"`
	State    string   `json:"state"`
	Followed bool     `json:"followed,omitempty"`
	EdgeNM   *float64 `json:"edgeNM,omitempty"`
	Lively   []Lively `json:"lively,omitempty"`
	Gone     string   `json:"gone,omitempty"`
}

// Page is a page of the list, whether more follow, how many boats are in
// the water, and whether where they are is withheld from the viewer.
type Page struct {
	Sailors  []Item `json:"sailors"`
	More     bool   `json:"more"`
	AtSea    int    `json:"atSea"`
	Withheld bool   `json:"withheld"`
}

// Query is what a page of the list is asked for with: part of a name,
// the page, the order and the filter; or, for a refresh, the names of
// the sailors shown, which take the others' place.
type Query struct {
	Q     string
	Page  int
	Sort  string
	Who   string
	Names []string
}

// SailorCard is the card about a sailor: its row, the weather at its
// boat, where it is (left out while withheld), this voyage, and for the
// viewer's own machine sailor whether its AI app is connected.
type SailorCard struct {
	Item
	Weather *CardWeather `json:"weather,omitempty"`
	Where   *CardWhere   `json:"where,omitempty"`
	Voyage  *CardVoyage  `json:"voyage,omitempty"`
	Agent   *bool        `json:"agent,omitempty"`
}

// CardVoyage is this voyage: its closest pass to the lip it survived, m,
// and what it last charted.
type CardVoyage struct {
	SkimmedM int      `json:"skimmedM,omitempty"`
	Charted  *Charted `json:"charted,omitempty"`
}

// Charted is what a boat last charted, left out while withheld, and how
// many minutes ago.
type Charted struct {
	Subject string `json:"subject,omitempty"`
	Minutes int    `json:"minutes"`
}

// List is a page of the list of every boat in the water the viewer may
// watch now, whose sailors' names hold q.Q, folded as names are, kept by
// q.Who and in q.Sort's order; or, with q.Names, those of the sailors
// named that may be watched, in no order and on one page. A human who
// does not allow spectators is never on it, nor the viewer's own boat.
// While the viewer's own boat is in the water, where the others are is
// withheld: their nearness to the lip and what they charted, on rows and
// in the order.
func (s *Service) List(ctx context.Context, viewer store.AccountID, q Query) (Page, error) {
	boats, err := s.read(ctx)
	if err != nil {
		return Page{}, err
	}
	fol, err := s.followsOf(ctx, viewer)
	if err != nil {
		return Page{}, err
	}
	withheld := inWater(boats, viewer)
	order := q.Sort
	if withheld && order == SortEdge {
		order = SortLiveliest
	}
	var names map[string]bool
	if q.Names != nil {
		names = map[string]bool{}
		for _, n := range q.Names[:min(len(q.Names), MaxNames)] {
			names[moderation.Key(n)] = true
		}
	}
	key := moderation.Key(q.Q)
	watched := s.cfg.Edge.Watched()
	gone := map[store.AccountID]Verdict{}
	var rows []entry
	for i := range boats {
		b := &boats[i]
		if b.sailor.Name == "" {
			continue
		}
		t := b.target()
		_, followed := fol[b.owner]
		if v := Allowed(t, s.boatOf(b), viewer); v != Yes {
			if followed {
				gone[b.owner] = v
			}
			continue
		}
		delete(fol, b.owner)
		switch {
		case names != nil:
			if !names[b.key] {
				continue
			}
		case key != "" && !strings.Contains(b.key, key), !q.keeps(t, followed):
			continue
		}
		rows = append(rows, s.entry(b, t, viewer, followed, withheld, watched))
	}
	sortRows(rows, order)
	items := make([]Item, 0, len(rows))
	for _, r := range rows {
		items = append(items, r.item)
	}
	if q.Who == WhoFollowing && names == nil {
		items = append(items, goneItems(fol, gone, key, viewer)...)
	}
	p := Page{Sailors: []Item{}, AtSea: len(boats), Withheld: withheld}
	if names != nil {
		p.Sailors = items
		return p, nil
	}
	from := max(q.Page, 0) * PageSize
	if from < len(items) {
		to := min(from+PageSize, len(items))
		p.Sailors, p.More = items[from:to], to < len(items)
	}
	return p, nil
}

// keeps reports whether the filter keeps t, followed or not.
func (q Query) keeps(t Target, followed bool) bool {
	switch q.Who {
	case WhoFollowing:
		return followed
	case WhoMachine:
		return t.Machine()
	case WhoHuman:
		return !t.Machine()
	}
	return true
}

// goneItems are the sailors followed that cannot be watched now, whose
// names hold key, by name: those in the water by the rule's verdict,
// the rest a machine sailor not at sea, or anyone else who cannot be
// watched.
func goneItems(fol map[store.AccountID]store.Sailor, gone map[store.AccountID]Verdict, key string, viewer store.AccountID) []Item {
	var out []Item
	for id, sl := range fol {
		if key != "" && !strings.Contains(moderation.Key(sl.Name), key) {
			continue
		}
		t := Target{ID: id, Kind: sl.Kind, Owner: sl.Owner, Name: sl.Name}
		why := GoneCannot
		if v, ok := gone[id]; ok && v == NotAtSea || !ok && t.Machine() {
			why = GoneNotAtSea
		}
		out = append(out, Item{Name: sl.Name, Machine: t.Machine(), Mine: t.Mine(viewer), Followed: true, Gone: why})
	}
	slices.SortFunc(out, func(a, b Item) int { return cmp.Compare(a.Name, b.Name) })
	return out
}

// entry is a row of the list, with what it is sorted by.
type entry struct {
	item  Item
	facts *Facts
}

// entry is the row of boat b, whose sailor is t, as viewer sees it.
func (s *Service) entry(b *boat, t Target, viewer store.AccountID, followed, withheld bool, watched map[bus.Account]int) entry {
	x := &b.facts
	mine := t.Mine(viewer)
	hide := withheld && !mine
	it := Item{Name: t.Name, Machine: t.Machine(), Mine: mine, Kind: s.kindOf(b.kind), Watchers: watched[bus.Account(b.owner)],
		Sky: x.Sky, Night: x.Night, Force: x.Force, Knots: x.Knots, State: x.State, Followed: followed, Lively: lively(x, hide)}
	if !hide && x.Edge >= 0 {
		e := x.Edge
		it.EdgeNM = &e
	}
	return entry{item: it, facts: x}
}

// sortRows puts rows in order: the viewer's own machine sailors, the
// sailors followed, then by the order asked for, then by name.
func sortRows(rows []entry, order string) {
	slices.SortFunc(rows, func(a, b entry) int {
		if c := first(a.item.Mine, b.item.Mine); c != 0 {
			return c
		}
		if c := first(a.item.Followed, b.item.Followed); c != 0 {
			return c
		}
		x, y := a.facts, b.facts
		var c int
		switch order {
		case SortWatched:
			c = cmp.Compare(b.item.Watchers, a.item.Watchers)
		case SortEdge:
			c = cmp.Compare(edgeKey(x), edgeKey(y))
		case SortWeather:
			c = cmp.Or(cmp.Compare(y.Force, x.Force), cmp.Compare(roughness(y.Sky), roughness(x.Sky)))
		case SortFast:
			c = cmp.Compare(y.Knots, x.Knots)
		case SortName:
		default:
			c = cmp.Or(cmp.Compare(len(b.item.Lively), len(a.item.Lively)), cmp.Compare(b.item.Watchers, a.item.Watchers))
		}
		return cmp.Or(c, cmp.Compare(a.item.Name, b.item.Name))
	})
}

// first orders true before false.
func first(a, b bool) int {
	switch {
	case a == b:
		return 0
	case a:
		return -1
	}
	return 1
}

// edgeKey is a boat's distance inside the lip for Nearest the edge, not
// known last.
func edgeKey(x *Facts) float64 {
	if x.Edge < 0 {
		return math.Inf(1)
	}
	return x.Edge
}

// Card is the card about the sailor named name, as viewer sees it:
// ErrNotAtSea or ErrCannot when the viewer may not watch it now, as a
// watch is refused.
func (s *Service) Card(ctx context.Context, viewer store.AccountID, name string) (SailorCard, error) {
	boats, err := s.read(ctx)
	if err != nil {
		return SailorCard{}, err
	}
	b, t, err := s.watchable(ctx, boats, viewer, name)
	if err != nil {
		return SailorCard{}, err
	}
	fol, err := s.followsOf(ctx, viewer)
	if err != nil {
		return SailorCard{}, err
	}
	_, followed := fol[b.owner]
	withheld := inWater(boats, viewer) && !t.Mine(viewer)
	e := s.entry(b, t, viewer, followed, withheld, s.cfg.Edge.Watched())
	out := SailorCard{Item: e.item}
	if c, ok := s.cardOf(b); ok {
		out.Weather = &c.Weather
		if !withheld {
			where := c.Where
			where.EdgeNM = e.item.EdgeNM
			out.Where = &where
		}
	}
	x := &b.facts
	v := &CardVoyage{SkimmedM: int(math.Floor(x.Skimmed + 0.5))}
	if x.Charted != "" {
		v.Charted = &Charted{Minutes: x.Minutes}
		if !withheld {
			v.Charted.Subject = x.Charted
		}
	}
	if v.SkimmedM > 0 || v.Charted != nil {
		out.Voyage = v
	}
	if t.Mine(viewer) && s.cfg.Agent != nil {
		on := s.cfg.Agent(bus.Account(b.owner))
		out.Agent = &on
	}
	return out, nil
}

// cardOf is the card's facts of boat b, made again once older than
// Cached; false while the world makes none, or the boat has left the
// water.
func (s *Service) cardOf(b *boat) (Card, bool) {
	if s.cfg.Sea == nil {
		return Card{}, false
	}
	s.cmu.Lock()
	defer s.cmu.Unlock()
	if c, ok := s.cards[b.owner]; ok && c.boat == b.id && time.Since(c.at) < Cached {
		return c.c, true
	}
	f := s.cfg.Frames.Acquire()
	defer f.Release()
	sl := int32(-1)
	for _, o := range f.Live {
		if f.Boat[o] == b.id {
			sl = o
			break
		}
	}
	if sl < 0 {
		return Card{}, false
	}
	c := card{at: time.Now(), boat: b.id, c: s.cfg.Sea.Card(f, sl)}
	if len(s.cards) > 256 {
		for id, old := range s.cards {
			if time.Since(old.at) >= Cached {
				delete(s.cards, id)
			}
		}
	}
	s.cards[b.owner] = c
	return c.c, true
}

// watchable is the boat of the sailor named name and the sailor, if the
// viewer may watch it now; otherwise why not, as a watch is refused.
func (s *Service) watchable(ctx context.Context, boats []boat, viewer store.AccountID, name string) (*boat, Target, error) {
	key := moderation.Key(name)
	for i := range boats {
		b := &boats[i]
		if b.key != key || b.sailor.Name == "" {
			continue
		}
		t := b.target()
		switch Allowed(t, s.boatOf(b), viewer) {
		case Yes:
			return b, t, nil
		case NotAtSea:
			return nil, t, ErrNotAtSea
		}
		return nil, t, ErrCannot
	}
	if key == "" {
		return nil, Target{}, ErrCannot
	}
	wt, err := s.cfg.Store.WatchTarget(ctx, key)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, Target{}, ErrCannot
	case err != nil:
		return nil, Target{}, err
	}
	t := Target(wt)
	if Allowed(t, Boat{}, viewer) == NotAtSea {
		return nil, t, ErrNotAtSea
	}
	return nil, t, ErrCannot
}

// Follow follows the sailor named name, or with on false stops following
// it, and says how many the viewer follows then. Only a sailor the
// viewer may watch now can be followed, and no more than MaxFollows;
// stopping always succeeds.
func (s *Service) Follow(ctx context.Context, viewer store.AccountID, name string, on bool) (int, error) {
	fol, err := s.followsOf(ctx, viewer)
	if err != nil {
		return 0, err
	}
	if !on {
		key := moderation.Key(name)
		for id, sl := range fol {
			if moderation.Key(sl.Name) != key {
				continue
			}
			if err := s.cfg.Store.Unfollow(ctx, viewer, id); err != nil {
				return 0, err
			}
			return s.followed(viewer, id, store.Sailor{}, false), nil
		}
		return len(fol), nil
	}
	boats, err := s.read(ctx)
	if err != nil {
		return 0, err
	}
	b, _, err := s.watchable(ctx, boats, viewer, name)
	if err != nil {
		return 0, err
	}
	if _, ok := fol[b.owner]; ok {
		return len(fol), nil
	}
	if len(fol) >= MaxFollows {
		return 0, ErrTooMany
	}
	if err := s.cfg.Store.Follow(ctx, viewer, b.owner); err != nil {
		return 0, err
	}
	return s.followed(viewer, b.owner, b.sailor, true), nil
}

// followed writes a follow through to the cache, and says how many the
// follower follows then.
func (s *Service) followed(follower, id store.AccountID, sl store.Sailor, on bool) int {
	s.fmu.Lock()
	defer s.fmu.Unlock()
	m := s.follows[follower]
	if m == nil {
		return 0
	}
	if on {
		m[id] = sl
	} else {
		delete(m, id)
	}
	return len(m)
}

// followsOf is a copy of the sailors an account follows, by account: read
// from the database the first time they are asked for, and from the
// cache after.
func (s *Service) followsOf(ctx context.Context, id store.AccountID) (map[store.AccountID]store.Sailor, error) {
	s.fmu.Lock()
	m, ok := s.follows[id]
	s.fmu.Unlock()
	if !ok {
		rows, err := s.cfg.Store.Follows(ctx, id)
		if err != nil {
			return nil, err
		}
		m = make(map[store.AccountID]store.Sailor, len(rows))
		for _, r := range rows {
			m[r.ID] = r.Sailor
		}
		s.fmu.Lock()
		if have, ok := s.follows[id]; ok {
			m = have
		} else {
			s.follows[id] = m
		}
		s.fmu.Unlock()
	}
	s.fmu.Lock()
	defer s.fmu.Unlock()
	out := make(map[store.AccountID]store.Sailor, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out, nil
}

// Forget drops an account deleted from the follows kept: whom it
// followed, and its being followed. The database's go with the account.
func (s *Service) Forget(id store.AccountID) {
	s.fmu.Lock()
	defer s.fmu.Unlock()
	delete(s.follows, id)
	for _, m := range s.follows {
		delete(m, id)
	}
}

// read is the boats in the water with their sailors and their facts,
// made again once they are older than Cached.
func (s *Service) read(ctx context.Context) ([]boat, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.boats != nil && time.Since(s.at) < Cached {
		return s.boats, nil
	}
	f := s.cfg.Frames.Acquire()
	boats := make([]boat, 0, len(f.Live))
	ids := make([]store.AccountID, 0, len(f.Live))
	for _, slot := range f.Live {
		boats = append(boats, boat{owner: store.AccountID(f.Owner[slot]), id: f.Boat[slot], kind: f.Kind[slot], unseen: f.Unseen[slot]})
		ids = append(ids, store.AccountID(f.Owner[slot]))
	}
	facts := make([]Facts, len(boats))
	if s.cfg.Sea != nil {
		s.cfg.Sea.Facts(f, f.Live, facts)
	} else {
		for i := range facts {
			facts[i] = Facts{Edge: -1, State: StateSailing}
		}
	}
	f.Release()
	names, err := s.cfg.Store.SailorsByID(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range boats {
		b := &boats[i]
		b.sailor = names[b.owner]
		b.key = moderation.Key(b.sailor.Name)
		b.facts = facts[i]
	}
	s.boats, s.at = boats, time.Now()
	return boats, nil
}

// target is the sailor of boat b, as the rule is told it.
func (b *boat) target() Target {
	return Target{ID: b.owner, Kind: b.sailor.Kind, Owner: b.sailor.Owner, Name: b.sailor.Name}
}

// boatOf is what the rule is told of boat b.
func (s *Service) boatOf(b *boat) Boat {
	return Boat{InWater: true, Unseen: b.unseen, Voyage: s.cfg.Edge.VoyageAllows(bus.Account(b.owner), b.id)}
}

// kindOf is a kind of boat's catalog id, "" for one out of range.
func (s *Service) kindOf(k uint16) string {
	if int(k) < len(s.cfg.Kinds) {
		return s.cfg.Kinds[k]
	}
	return ""
}

// inWater reports whether an account's own boat is among boats.
func inWater(boats []boat, id store.AccountID) bool {
	for i := range boats {
		if boats[i].owner == id {
			return true
		}
	}
	return false
}

// Spectators is a human's choice for this voyage: whether anyone may
// watch them.
func (s *Service) Spectators(id store.AccountID) string {
	if s.cfg.Edge.Voyage(bus.Account(id)) {
		return AllowVoyage
	}
	return AllowNo
}

// SetSpectators sets a human's choice for the voyage under way, or, with
// no boat in the water, for the next boat's. The game connection holds it
// with the boat and lets it go when the boat leaves the water. Turned
// off, every watch of the sailor's boat ends with the encoders' next
// snapshot.
func (s *Service) SetSpectators(_ context.Context, id store.AccountID, allow string) error {
	switch allow {
	case AllowNo, AllowVoyage:
	default:
		return ErrAllow
	}
	s.cfg.Edge.SetVoyage(bus.Account(id), allow == AllowVoyage)
	return nil
}

// Watchers is how many watch an account's boat now.
func (s *Service) Watchers(id store.AccountID) int { return s.cfg.Edge.Watchers(bus.Account(id)) }

// AtSea reports whether an account's own boat is in the water.
func (s *Service) AtSea(id store.AccountID) bool {
	f := s.cfg.Frames.Acquire()
	defer f.Release()
	for _, slot := range f.Live {
		if f.Owner[slot] == bus.Account(id) {
			return true
		}
	}
	return false
}
