// SPDX-License-Identifier: AGPL-3.0-only

// Package fleettest keeps fleets in memory, for tests.
package fleettest

import (
	"context"
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Store is fleets in memory, as internal/fleet keeps them: the sailors'
// fleets' owners, their names, and one fleet's boats.
type Store struct {
	mu     sync.Mutex
	Owners map[store.AccountID]store.AccountID
	Names  map[store.AccountID]string
	Fleet  []store.Boat
}

func (m *Store) Boats(_ context.Context, owner store.AccountID) ([]store.Boat, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]store.Boat, len(m.Fleet))
	copy(out, m.Fleet)
	for i := range out {
		out[i].SailorName = m.Names[out[i].Sailor]
		out[i].Machine = out[i].Held && out[i].Sailor != owner
	}
	return out, nil
}

func (m *Store) FleetOwner(_ context.Context, id store.AccountID) (store.AccountID, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.Owners[id]
	if !ok {
		return o, store.ErrNotFound
	}
	return o, nil
}

func (m *Store) GiveBoat(_ context.Context, _, sailor store.AccountID, boat store.BoatID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.Fleet {
		if b := &m.Fleet[i]; b.Held && b.Sailor == sailor {
			b.Held, b.Sailor = false, store.AccountID{}
		}
	}
	for i := range m.Fleet {
		if b := &m.Fleet[i]; b.ID == boat {
			b.Held, b.Sailor = true, sailor
			return nil
		}
	}
	return store.ErrNotFound
}

func (m *Store) SetBoatLook(_ context.Context, _ store.AccountID, boat store.BoatID, l store.BoatLook) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.Fleet {
		if m.Fleet[i].ID == boat {
			m.Fleet[i].BoatLook = l
			return nil
		}
	}
	return store.ErrNotFound
}

func (m *Store) BoatNumberFree(_ context.Context, kind string, number int, except store.BoatID) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, b := range m.Fleet {
		if b.Kind == kind && b.Number == number && b.ID != except {
			return false, nil
		}
	}
	return true, nil
}
