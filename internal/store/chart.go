// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// Charting is a subject of the world's chart charted: by its kind's word
// ("island", "place" or "feature") and its number; by whom, unless it was
// known from the world's start or charted with another, which With names;
// the boat, the tick and where the boat was; what it was worth; and the
// news it makes, if any. Once written, Written says it was (not charted
// already), with the sailor's name and account's kind as they were and when.
type Charting struct {
	Subject  string
	Number   int32
	Credited bool
	Account  [16]byte
	Boat     uint64
	Tick     int64
	X, Y     float64
	Worth    float64
	// WithSubject and WithNumber are the subject it was charted with, if
	// any: WithSubject is "" for none.
	WithSubject string
	WithNumber  int32
	News        *NewsItem

	Written     bool
	Sailor      string
	AccountKind string
	At          time.Time
}

// NewsItem is what a charting tells the news: its column, its title and
// what it is, and where; Island the island it is on or by, −1 for none;
// with Fold, it is folded into the sailor's item about the island within
// the batch's fold, if there is one.
type NewsItem struct {
	Column      string
	Title, What string
	Island      int32
	Fold        bool
	X, Y        float64
}

// Folded is a subject folded into a news item.
type Folded struct {
	Subject string `json:"subject"`
	Number  int32  `json:"number"`
	Title   string `json:"title"`
}

// News is an item of the news as it is read.
type News struct {
	ID          [16]byte
	Column      string
	Sailor      string
	AccountKind string
	Subject     string
	Number      int32
	Title, What string
	Worth       float64
	X, Y        float64
	Also        []Folded
	At          time.Time
}

// writeChartings writes a batch's chartings, in order, in its transaction,
// and the news they make; one already written is left as it was.
func writeChartings(ctx context.Context, q *db.Queries, world pgtype.UUID, b *Batch) error {
	for i := range b.Charting {
		c := &b.Charting[i]
		p := db.InsertChartingParams{WorldID: world, Subject: c.Subject, Number: c.Number, Tick: c.Tick, Worth: c.Worth}
		if c.Credited {
			p.AccountID = pgtype.UUID{Bytes: c.Account, Valid: true}
			p.Boat = pgtype.Int8{Int64: int64(c.Boat), Valid: true}
			p.X, p.Y = pgtype.Float8{Float64: c.X, Valid: true}, pgtype.Float8{Float64: c.Y, Valid: true}
		}
		if c.WithSubject != "" {
			p.WithSubject = pgtype.Text{String: c.WithSubject, Valid: true}
			p.WithNumber = pgtype.Int4{Int32: c.WithNumber, Valid: true}
		}
		row, err := q.InsertCharting(ctx, p)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		c.Written, c.Sailor, c.AccountKind, c.At = true, row.Sailor.String, row.AccountKind.String, row.ChartedAt
		n := c.News
		if n == nil || !c.Credited {
			continue
		}
		island := pgtype.Int4{Int32: n.Island, Valid: n.Island >= 0}
		if n.Fold && island.Valid {
			item, err := json.Marshal([]Folded{{Subject: c.Subject, Number: c.Number, Title: n.Title}})
			if err != nil {
				return err
			}
			folded, err := q.FoldNews(ctx, db.FoldNewsParams{Item: item, WorldID: world, AccountID: p.AccountID,
				IslandNumber: island, Within: b.FoldWithin.Seconds()})
			if err != nil {
				return err
			}
			if folded > 0 {
				continue
			}
		}
		err = q.InsertNews(ctx, db.InsertNewsParams{
			WorldID: world, NewsColumn: n.Column, AccountID: p.AccountID, Sailor: row.Sailor, AccountKind: row.AccountKind,
			Subject: c.Subject, Number: c.Number, Title: n.Title, What: n.What, IslandNumber: island,
			Worth: c.Worth, X: n.X, Y: n.Y,
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// Chartings are a world's chartings, the oldest first.
func (s *Store) Chartings(ctx context.Context, world [16]byte) ([]Charting, error) {
	rows, err := s.q.ChartRows(ctx, pgtype.UUID{Bytes: world, Valid: true})
	if err != nil {
		return nil, err
	}
	out := make([]Charting, len(rows))
	for i, r := range rows {
		out[i] = Charting{
			Subject: r.Subject, Number: r.Number, Credited: r.AccountID.Valid, Account: r.AccountID.Bytes,
			Boat: uint64(r.Boat.Int64), Tick: r.Tick, X: r.X.Float64, Y: r.Y.Float64, Worth: r.Worth,
			WithSubject: r.WithSubject.String, WithNumber: r.WithNumber.Int32,
			Written: true, Sailor: r.Sailor.String, AccountKind: r.AccountKind.String, At: r.ChartedAt,
		}
	}
	return out, nil
}

// News is up to limit of a world's news items written before the item
// before, or the newest with before nil, the newest first. An item's id is
// a UUIDv7, in the order the items were written.
func (s *Store) News(ctx context.Context, world [16]byte, before *[16]byte, limit int) ([]News, error) {
	p := db.NewsParams{WorldID: pgtype.UUID{Bytes: world, Valid: true}, Lim: int32(limit)}
	if before != nil {
		p.Before = pgtype.UUID{Bytes: *before, Valid: true}
	}
	rows, err := s.q.News(ctx, p)
	if err != nil {
		return nil, err
	}
	out := make([]News, len(rows))
	for i, r := range rows {
		n := News{
			ID: r.ID.Bytes, Column: r.NewsColumn, Sailor: r.Sailor.String, AccountKind: r.AccountKind.String,
			Subject: r.Subject, Number: r.Number, Title: r.Title, What: r.What, Worth: r.Worth, X: r.X, Y: r.Y, At: r.WrittenAt,
		}
		if err := json.Unmarshal(r.Also, &n.Also); err != nil {
			return nil, err
		}
		out[i] = n
	}
	return out, nil
}

// SetNoticesOff sets the kinds of notice an account's sailor has switched
// off; ErrNotFound if there is no such account.
func (s *Store) SetNoticesOff(ctx context.Context, id AccountID, off []string) error {
	if off == nil {
		off = []string{}
	}
	n, err := s.q.SetNoticesOff(ctx, db.SetNoticesOffParams{Off: off, ID: pgtype.UUID{Bytes: id, Valid: true}})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
