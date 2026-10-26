// SPDX-License-Identifier: AGPL-3.0-only

package accounts

import (
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Set is the accounts stopped, in memory: those stopped themselves, and
// the machine sailors of a human stopped. It is loaded as keel starts and
// changed only by a stop and a start, each after its transaction commits,
// and read where a read of the database would sit on a path that must be
// quick: the game connection as it opens and as it claims its account,
// and each call of a machine sailor's agent. A write that failed after the
// commit is mended by the next start of keel, which loads it again.
type Set struct {
	mu sync.RWMutex
	m  map[store.AccountID]store.Kind
}

// NewSet is a set of the accounts given.
func NewSet(stopped map[store.AccountID]store.Kind) *Set {
	s := &Set{m: map[store.AccountID]store.Kind{}}
	for id, k := range stopped {
		s.m[id] = k
	}
	return s
}

// Has reports whether an account is stopped.
func (s *Set) Has(id store.AccountID) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.m[id]
	return ok
}

func (s *Set) add(kind store.Kind, ids ...store.AccountID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		s.m[id] = kind
	}
}

func (s *Set) remove(ids ...store.AccountID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		delete(s.m, id)
	}
}

// Count is how many accounts of a kind are stopped.
func (s *Set) Count(kind store.Kind) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, k := range s.m {
		if k == kind {
			n++
		}
	}
	return n
}
