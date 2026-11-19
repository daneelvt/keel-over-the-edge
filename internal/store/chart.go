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

// Charting is a subject of the world's chart charted: by its kind's word
// ("island", "place" or "feature") and its number; by whom, unless it was
// known from the world's start or charted with another, which With names;
// the boat, the tick and where the boat was; what it was worth; and the
// story it makes, if any. Once written, Written says it was (not charted
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
	// Opens are the island courses its charting opens, every place each
	// names now charted: each a story of the news.
	Opens []CourseOpen

	Written     bool
	Sailor      string
	AccountKind string
	At          time.Time
}

// NewsItem is the story a charting makes: its kind and score, its title
// and what it is, and where; Island the island it is on or by, −1 for
// none; and the boat that charted it, its name and kind's id. Unless it
// is a great discovery, a sailor's first charting ever is a story of its
// own (NewsRules).
type NewsItem struct {
	Story       string
	Score       int
	Title, What string
	Island      int32
	X, Y        float64
	Boat        string
	BoatKind    string
}

// CourseOpen is an island course a charting opens: its number in the
// world, its name and what it is ("a new course of 2.4 NM"), where its
// start lies, and its story's score.
type CourseOpen struct {
	Number      int32
	Title, What string
	X, Y        float64
	Score       int
}

// SubjectWorld is a news item's subject when it is the world itself.
const SubjectWorld = "world"

// WorldNews is an item about the world: its end, in a column of its own.
type WorldNews struct {
	Column      string
	Number      int // the world's
	Title, What string
	X, Y        float64 // where it is told of: the main port
	EndsAt      time.Time
}

// WriteWorldNews writes an item about the world, fenced by the lease's
// epoch.
func (s *Store) WriteWorldNews(ctx context.Context, lease int64, world [16]byte, n WorldNews) error {
	return s.fenced(ctx, lease, func(q *db.Queries) error {
		return q.InsertWorldNews(ctx, db.InsertWorldNewsParams{
			WorldID: pgtype.UUID{Bytes: world, Valid: true}, NewsColumn: n.Column, Number: int32(n.Number),
			Title: n.Title, What: n.What, X: n.X, Y: n.Y, EndsAt: stamp(n.EndsAt),
		})
	})
}

// writeChartings writes a batch's chartings, in order, in its transaction,
// and the stories they make; one already written is left as it was.
func writeChartings(ctx context.Context, q *db.Queries, world pgtype.UUID, b *Batch) error {
	var first map[AccountID]bool
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
		if c.Credited && b.News != nil {
			for k := range c.Opens {
				if err := courseStory(ctx, q, &newsWrite{world: world, rules: b.News}, c, &c.Opens[k]); err != nil {
					return err
				}
			}
		}
		if c.News == nil || !c.Credited || b.News == nil {
			continue
		}
		if first == nil {
			first = map[AccountID]bool{}
		}
		if err := chartingStory(ctx, q, &newsWrite{world: world, rules: b.News}, c, first); err != nil {
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
