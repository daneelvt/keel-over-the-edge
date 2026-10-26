// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// MachineLook is the look a machine sailor's sailor row has.
const MachineLook = "machine"

// MaxMachineCap is the most machine sailors an account may be allowed.
const MaxMachineCap = 50

// NewMachine is a machine sailor to make: its name, as a human sailor's,
// and its look, by the catalog's machine sets' ids.
type NewMachine struct {
	Name, NameKey           string
	Version, Finish, Colour string
}

// Machine is one of a human account's machine sailors.
type Machine struct {
	ID                      AccountID
	Name                    string
	Version, Finish, Colour string
	Created                 time.Time
}

// ErrCap is a machine sailor refused: its owner has as many as it may.
var ErrCap = errors.New("store: the account has as many machine sailors as it may")

// createMachine makes a machine sailor for owner within a transaction:
// the owner's row locked, its machine sailors counted against its cap, the
// AI account and its sailor made, and a boat added to the fleet if it has
// fewer boats of the kind than sailors.
func createMachine(ctx context.Context, q *db.Queries, owner AccountID, m NewMachine, boat string) (AccountID, error) {
	limit, err := q.LockOwner(ctx, uuidOf(owner))
	if errors.Is(err, pgx.ErrNoRows) {
		return AccountID{}, ErrNotFound
	}
	if err != nil {
		return AccountID{}, err
	}
	n, err := q.CountMachines(ctx, uuidOf(owner))
	if err != nil {
		return AccountID{}, err
	}
	if n >= int64(limit) {
		return AccountID{}, ErrCap
	}
	u, err := q.CreateMachineAccount(ctx, uuidOf(owner))
	if err != nil {
		return AccountID{}, err
	}
	if err := q.CreateMachineSailor(ctx, db.CreateMachineSailorParams{
		AccountID: u, Name: m.Name, NameKey: m.NameKey, Version: text(m.Version), Finish: text(m.Finish), Colour: text(m.Colour),
	}); err != nil {
		return AccountID{}, err
	}
	// The account's own sailor and each machine sailor, the new one
	// among them.
	if err := fillFleet(ctx, q, owner, boat, n+2); err != nil {
		return AccountID{}, err
	}
	return u.Bytes, nil
}

// fillFleet adds a boat of a kind to an account's fleet while it has
// fewer of them than sailors.
func fillFleet(ctx context.Context, q *db.Queries, owner AccountID, kind string, sailors int64) error {
	have, err := q.CountBoats(ctx, db.CountBoatsParams{AccountID: uuidOf(owner), Kind: kind})
	if err != nil {
		return err
	}
	for ; have < sailors; have++ {
		if err := q.CreateBoat(ctx, db.CreateBoatParams{AccountID: uuidOf(owner), Kind: kind}); err != nil {
			return err
		}
	}
	return nil
}

// CreateMachine makes a machine sailor for a human account, up to its cap,
// with a boat of the kind given in its fleet if it needs one: ErrCap at
// the cap, ErrNameTaken for a name another sailor has, ErrNotFound for an
// owner that is not a human account.
func (s *Store) CreateMachine(ctx context.Context, owner AccountID, m NewMachine, boat string) (AccountID, error) {
	var id AccountID
	err := s.inTx(ctx, func(q *db.Queries) error {
		var err error
		id, err = createMachine(ctx, q, owner, m, boat)
		return err
	})
	if uniqueViolation(err, "sailor_name_key") {
		return AccountID{}, ErrNameTaken
	}
	return id, err
}

// Machines are a human account's machine sailors, the oldest first.
func (s *Store) Machines(ctx context.Context, owner AccountID) ([]Machine, error) {
	rows, err := s.q.MachinesOf(ctx, uuidOf(owner))
	if err != nil {
		return nil, err
	}
	out := make([]Machine, len(rows))
	for i, r := range rows {
		out[i] = Machine{ID: r.ID.Bytes, Name: r.Name, Version: r.Version, Finish: r.Finish, Colour: r.Colour, Created: r.CreatedAt}
	}
	return out, nil
}

// MachineCap is how many machine sailors a human account may make.
func (s *Store) MachineCap(ctx context.Context, owner AccountID) (int, error) {
	n, err := s.q.MachineCap(ctx, uuidOf(owner))
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return int(n), err
}

// SetMachineCap sets how many machine sailors a human account may make,
// from 0 to MaxMachineCap, or returns ErrNotFound: no such account, or an
// AI's. Those it has already stay.
func (s *Store) SetMachineCap(ctx context.Context, id AccountID, limit int) error {
	if limit < 0 || limit > MaxMachineCap {
		return errors.New("store: a machine cap out of its bounds")
	}
	n, err := s.q.SetMachineCap(ctx, db.SetMachineCapParams{MachineCap: int16(limit), ID: uuidOf(id)})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// Fleet is how many boats of each kind a human account's fleet holds.
func (s *Store) Fleet(ctx context.Context, owner AccountID) (map[string]int, error) {
	rows, err := s.q.Fleet(ctx, uuidOf(owner))
	if err != nil {
		return nil, err
	}
	out := make(map[string]int, len(rows))
	for _, r := range rows {
		out[r.Kind] = int(r.Boats)
	}
	return out, nil
}

// DeleteMachine deletes one of a human account's machine sailors, with its
// grants and their tokens, freeing its name; what it charted keeps its
// place under no name, and its boat stays in the fleet. ErrNotFound if the
// account has no such machine sailor.
func (s *Store) DeleteMachine(ctx context.Context, owner, id AccountID) error {
	return s.inTx(ctx, func(q *db.Queries) error {
		if err := q.ForgetCredits(ctx, uuidOf(id)); err != nil {
			return err
		}
		n, err := q.DeleteMachine(ctx, db.DeleteMachineParams{ID: uuidOf(id), OwnerID: uuidOf(owner)})
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// MachineCounts is how many machine sailors there are, how many were made
// in the last week, and the grants live within the lifetime, by kind.
type MachineCounts struct {
	Total, Week int64
	Grants      map[string]int64
}

// MachineCounts counts the machine sailors and their live grants.
func (s *Store) MachineCounts(ctx context.Context, lifetime time.Duration) (MachineCounts, error) {
	r, err := s.q.MachineCounts(ctx)
	if err != nil {
		return MachineCounts{}, err
	}
	rows, err := s.q.LiveGrants(ctx, lifetime.Microseconds())
	if err != nil {
		return MachineCounts{}, err
	}
	c := MachineCounts{Total: r.Total, Week: r.Week, Grants: map[string]int64{}}
	for _, g := range rows {
		c.Grants[g.Kind] = g.Grants
	}
	return c, nil
}
