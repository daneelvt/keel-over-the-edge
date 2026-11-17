// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// The record's actions for the owner's settings for new sailors: how many
// one address may make in a day, and the human check switched.
const (
	ActionNewSailors = "new-sailors"
	ActionHumanCheck = "human-check"
)

// NewSailorWindow is how long a new sailor counts toward its address's
// limit, and how long its row is kept.
const NewSailorWindow = 24 * time.Hour

// The bounds and default of how many new sailors one address may make in
// a NewSailorWindow, as the database holds them.
const (
	DefaultNewSailorsPerAddress = 20
	MinNewSailorsPerAddress     = 1
	MaxNewSailorsPerAddress     = 1000
)

// NewSailorsFrom is how many sailors were made from the address whose key
// is given since a time, and when the oldest of them was (now, for none).
func (s *Store) NewSailorsFrom(ctx context.Context, key []byte, since time.Time) (int64, time.Time, error) {
	r, err := s.q.NewSailorsFrom(ctx, db.NewSailorsFromParams{Key: key, Since: since})
	if err != nil {
		return 0, time.Time{}, err
	}
	return r.Made, r.Oldest, nil
}

// NewSailorBatch is how many rows one statement deletes.
const NewSailorBatch = 1000

// DeleteNewSailors deletes the rows of sailors made at or before the time
// given, NewSailorBatch at a time; it returns how many.
func (s *Store) DeleteNewSailors(ctx context.Context, before time.Time) (int64, error) {
	var total int64
	for {
		n, err := s.q.DeleteNewSailorsFrom(ctx, db.DeleteNewSailorsFromParams{Before: before, Lim: NewSailorBatch})
		total += n
		if err != nil || n < NewSailorBatch {
			return total, err
		}
	}
}

// NewSailorSettings are the owner's settings for new sailors as kept: how
// many one address may make in a day, and whether the human check is on.
func (s *Store) NewSailorSettings(ctx context.Context) (perAddress int, check bool, err error) {
	r, err := s.q.NewSailorSettings(ctx)
	if err != nil {
		return 0, false, err
	}
	return int(r.NewSailorsPerAddress), r.HumanCheck, nil
}

// SetNewSailorsPerAddress sets how many new sailors one address may make
// in a day, from 1 to 1000, with its record.
func (s *Store) SetNewSailorsPerAddress(ctx context.Context, n int, a Action) error {
	a.Action = ActionNewSailors
	return s.setting(ctx, a, func(q *db.Queries) error {
		_, err := q.SetNewSailorsPerAddress(ctx, int16(n))
		return err
	})
}

// SetHumanCheck switches the human check on new sailors on or off, with
// its record.
func (s *Store) SetHumanCheck(ctx context.Context, on bool, a Action) error {
	a.Action = ActionHumanCheck
	return s.setting(ctx, a, func(q *db.Queries) error {
		_, err := q.SetHumanCheck(ctx, on)
		return err
	})
}
