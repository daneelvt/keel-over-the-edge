// SPDX-License-Identifier: AGPL-3.0-only

package watch

import (
	"cmp"
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The list of sailors a player may watch, and the setting that puts a
// human on it: a world's, built from its latest frame, the accounts that
// allow spectators always, and those that allow them for the voyage, which
// the game connection holds with their boats.

// PageSize is how many sailors a page of the list has.
const PageSize = 50

// Cached is how long the boats in the water and their sailors' names are
// kept for the list, before they are read again.
const Cached = 2 * time.Second

// The choices of the setting: whether a human lets anyone watch them.
const (
	AllowNo     = "no"
	AllowVoyage = "voyage"
	AllowAlways = "always"
)

// ErrAllow is a choice that is none of the setting's.
var ErrAllow = errors.New("watch: not a choice of the setting")

// Store is what watching reads and writes in the database.
type Store interface {
	SetSpectators(ctx context.Context, id store.AccountID, on bool) error
	SailorsByID(ctx context.Context, ids []store.AccountID) (map[store.AccountID]store.Sailor, error)
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
	Store    Store
	Allowing *Allowing
	Frames   *bus.Frames
	Edge     Edge
	// Kinds are the catalog's boats' ids, by the world's index of kinds.
	Kinds []string
}

// Service is a world's watching: the list, and the setting.
type Service struct {
	cfg Config

	mu    sync.Mutex
	at    time.Time
	boats []boat
}

// boat is a boat in the water, as the list reads it.
type boat struct {
	owner  store.AccountID
	id     uint64
	kind   uint16
	unseen bool
	sailor store.Sailor
}

// New makes a world's watching.
func New(cfg Config) *Service { return &Service{cfg: cfg} }

// Item is a sailor on the list: the name, whether a machine sailor and
// whether the viewer's own, the kind of boat, the catalog's id, and how
// many watch it.
type Item struct {
	Name     string `json:"name"`
	Machine  bool   `json:"machine"`
	Mine     bool   `json:"mine"`
	Kind     string `json:"kind"`
	Watchers int    `json:"watchers"`
}

// Page is a page of the list, and whether more follow.
type Page struct {
	Sailors []Item `json:"sailors"`
	More    bool   `json:"more"`
}

// List is the page of the list of every boat in the water the viewer may
// watch now, whose sailors' names hold q, folded as names are: the
// viewer's own machine sailors first, then the most watched, then by
// name. A human who does not allow spectators is never on it, nor the
// viewer's own boat.
func (s *Service) List(ctx context.Context, viewer store.AccountID, q string, page int) (Page, error) {
	boats, err := s.read(ctx)
	if err != nil {
		return Page{}, err
	}
	key := moderation.Key(q)
	watched := s.cfg.Edge.Watched()
	var items []Item
	for i := range boats {
		b := &boats[i]
		if b.sailor.Name == "" {
			continue
		}
		t := Target{ID: b.owner, Kind: b.sailor.Kind, Owner: b.sailor.Owner, Name: b.sailor.Name, Always: s.cfg.Allowing.Has(b.owner)}
		at := Boat{InWater: true, Unseen: b.unseen, Voyage: s.cfg.Edge.VoyageAllows(bus.Account(b.owner), b.id)}
		if Allowed(t, at, viewer) != Yes || key != "" && !strings.Contains(moderation.Key(t.Name), key) {
			continue
		}
		kind := ""
		if int(b.kind) < len(s.cfg.Kinds) {
			kind = s.cfg.Kinds[b.kind]
		}
		items = append(items, Item{Name: t.Name, Machine: t.Machine(), Mine: t.Mine(viewer), Kind: kind, Watchers: watched[bus.Account(b.owner)]})
	}
	slices.SortFunc(items, func(a, b Item) int {
		if a.Mine != b.Mine {
			if a.Mine {
				return -1
			}
			return 1
		}
		return cmp.Or(cmp.Compare(b.Watchers, a.Watchers), cmp.Compare(a.Name, b.Name))
	})
	from := max(page, 0) * PageSize
	if from >= len(items) {
		return Page{Sailors: []Item{}}, nil
	}
	to := min(from+PageSize, len(items))
	return Page{Sailors: items[from:to], More: to < len(items)}, nil
}

// read is the boats in the water with their sailors, read again once
// they are older than Cached.
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
	f.Release()
	names, err := s.cfg.Store.SailorsByID(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range boats {
		boats[i].sailor = names[boats[i].owner]
	}
	s.boats, s.at = boats, time.Now()
	return boats, nil
}

// Spectators is a human's choice: whether anyone may watch them always,
// for this voyage, or not.
func (s *Service) Spectators(id store.AccountID) string {
	switch {
	case s.cfg.Allowing.Has(id):
		return AllowAlways
	case s.cfg.Edge.Voyage(bus.Account(id)):
		return AllowVoyage
	}
	return AllowNo
}

// SetSpectators sets a human's choice: always is stored, this voyage held
// by the game connection with the boat. Turned off, every watch of the
// sailor's boat ends with the encoders' next snapshot.
func (s *Service) SetSpectators(ctx context.Context, id store.AccountID, allow string) error {
	switch allow {
	case AllowNo, AllowVoyage, AllowAlways:
	default:
		return ErrAllow
	}
	always := allow == AllowAlways
	if err := s.cfg.Store.SetSpectators(ctx, id, always); err != nil {
		return err
	}
	s.cfg.Allowing.Set(id, always)
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
