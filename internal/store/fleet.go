// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// A human account's fleet: its boats, shared by its sailors, each with its
// look and the sailor whose boat it is.

// BoatID is a fleet boat's ID, a UUID's 16 bytes.
type BoatID [16]byte

// BoatLook is a boat's look: its paint's and cloth's places in the
// catalog's lists, its sail number and its name, "" for none.
type BoatLook struct {
	Paint, Cloth int
	Number       int
	Name         string
}

// Boat is one of a fleet's boats.
type Boat struct {
	ID   BoatID
	Kind string
	BoatLook
	// Sailor is the sailor whose boat it is, the one who sails it or sailed
	// it last and takes it again, with their name and whether they are a
	// machine sailor; Held is false for a boat no sailor has.
	Sailor     AccountID
	Held       bool
	SailorName string
	Machine    bool
	Made       time.Time
}

// ErrNumberTaken is a sail number another boat of its kind has.
var ErrNumberTaken = errors.New("store: the sail number is another boat's")

// Boats are a human account's boats, the oldest first.
func (s *Store) Boats(ctx context.Context, owner AccountID) ([]Boat, error) {
	rows, err := s.q.FleetBoats(ctx, uuidOf(owner))
	if err != nil {
		return nil, err
	}
	out := make([]Boat, len(rows))
	for i, r := range rows {
		out[i] = Boat{ID: r.ID.Bytes, Kind: r.Kind,
			BoatLook: BoatLook{Paint: int(r.Paint), Cloth: int(r.Cloth), Number: int(r.Number), Name: r.Name},
			Sailor:   r.Sailor.Bytes, Held: r.Sailor.Valid, SailorName: r.SailorName, Machine: r.Machine, Made: r.MadeAt}
	}
	return out, nil
}

// FleetOwner is the human account whose fleet an account's sailor sails
// from: the account itself, or a machine sailor's owner. ErrNotFound for
// no such account.
func (s *Store) FleetOwner(ctx context.Context, id AccountID) (AccountID, error) {
	u, err := s.q.FleetOwner(ctx, uuidOf(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return AccountID{}, ErrNotFound
	}
	return u.Bytes, err
}

// GiveBoat makes one of a human account's boats a sailor's: the sailor's
// boat until they are given another, and no longer the sailor's who had it
// before. ErrNotFound if the account has no such boat.
func (s *Store) GiveBoat(ctx context.Context, owner, sailor AccountID, boat BoatID) error {
	return s.inTx(ctx, func(q *db.Queries) error {
		id := pgtype.UUID{Bytes: boat, Valid: true}
		if err := q.LetBoatGo(ctx, db.LetBoatGoParams{Sailor: uuidOf(sailor), ID: id}); err != nil {
			return err
		}
		n, err := q.GiveBoat(ctx, db.GiveBoatParams{Sailor: uuidOf(sailor), ID: id, AccountID: uuidOf(owner)})
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// SetBoatLook sets the look of one of a human account's boats: ErrNotFound
// if it has no such boat, ErrNumberTaken if another boat of its kind has
// the sail number.
func (s *Store) SetBoatLook(ctx context.Context, owner AccountID, boat BoatID, l BoatLook) error {
	name := pgtype.Text{String: l.Name, Valid: l.Name != ""}
	n, err := s.q.SetBoatLook(ctx, db.SetBoatLookParams{Paint: int16(l.Paint), Cloth: int16(l.Cloth), Number: int32(l.Number), Name: name,
		ID: pgtype.UUID{Bytes: boat, Valid: true}, AccountID: uuidOf(owner)})
	switch {
	case uniqueViolation(err, "boat_kind_number"):
		return ErrNumberTaken
	case err != nil:
		return err
	case n == 0:
		return ErrNotFound
	}
	return nil
}

// BoatNumberFree reports whether no boat of a kind but the one given has a
// sail number.
func (s *Store) BoatNumberFree(ctx context.Context, kind string, number int, except BoatID) (bool, error) {
	taken, err := s.q.BoatNumberTaken(ctx, db.BoatNumberTakenParams{Kind: kind, Number: int32(number), ID: pgtype.UUID{Bytes: except, Valid: true}})
	return !taken, err
}

// createBoat adds a boat of a kind to an account's fleet within a
// transaction, with the lowest sail number of its kind no boat has.
func createBoat(ctx context.Context, q *db.Queries, owner AccountID, kind string) error {
	if err := q.LockBoatNumbers(ctx, kind); err != nil {
		return err
	}
	number, err := q.FreeBoatNumber(ctx, kind)
	if err != nil {
		return err
	}
	return q.CreateBoat(ctx, db.CreateBoatParams{AccountID: uuidOf(owner), Kind: kind, Number: number})
}
