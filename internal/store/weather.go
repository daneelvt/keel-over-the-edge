// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// Weather is a world's week of weather as stored: the version of the
// generator that made it, the world's epoch and end it was made for, its
// records, the digest of them, how long it took to make, and when it was
// made.
type Weather struct {
	Version      int
	Epoch        time.Time
	Ends         time.Time
	Records      []byte
	Digest       []byte
	GenerationMs int
	Made         time.Time
}

// StoreWeather stores the world's week, or replaces the one it has, in one
// statement fenced by the lease's epoch.
func (s *Store) StoreWeather(ctx context.Context, world [16]byte, epoch int64, w *Weather) error {
	if sum := sha256.Sum256(w.Records); string(sum[:]) != string(w.Digest) {
		return errors.New("store: a week that does not match its digest")
	}
	n, err := s.q.StoreWeather(ctx, db.StoreWeatherParams{
		WorldID: pgtype.UUID{Bytes: world, Valid: true}, Version: int32(w.Version), Epoch: w.Epoch, Ends: w.Ends,
		Records: w.Records, Digest: w.Digest, GenerationMs: int32(w.GenerationMs), Lease: epoch,
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("%w: the world's week was not stored by epoch %d", ErrFenced, epoch)
	}
	return nil
}

// LoadWeather reads the world's week, checked against its digest;
// ErrNotFound if it has none.
func (s *Store) LoadWeather(ctx context.Context, world [16]byte) (*Weather, error) {
	row, err := s.q.WorldWeather(ctx, pgtype.UUID{Bytes: world, Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if sum := sha256.Sum256(row.Records); string(sum[:]) != string(row.Digest) {
		return nil, errors.New("store: the world's week does not match its digest")
	}
	return &Weather{
		Version: int(row.Version), Epoch: row.Epoch.UTC(), Ends: row.Ends.UTC(), Records: row.Records, Digest: row.Digest,
		GenerationMs: int(row.GenerationMs), Made: row.Made.UTC(),
	}, nil
}
