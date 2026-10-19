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

// The outcomes of a job's run.
const (
	JobOK      = "ok"
	JobFailed  = "failed"
	JobSkipped = "skipped" // nothing to do
)

// JobClaim is a job's run claimed: its row's id, and which attempt it is.
type JobClaim struct {
	ID      [16]byte
	Attempt int
	Job     string
	Due     time.Time
	epoch   int64
}

// ClaimJob claims the run of a job for a time it was due, fenced by the
// lease's epoch: a new run, or one that failed at least retry ago, or one
// whose process stopped before it finished. ok is false when the run is
// done, under way, failed lately, or the lease is another's.
func (s *Store) ClaimJob(ctx context.Context, lease int64, job string, due time.Time, retry time.Duration) (JobClaim, bool, error) {
	r, err := s.q.ClaimJobRun(ctx, db.ClaimJobRunParams{Job: job, Due: due, Epoch: lease, RetrySeconds: retry.Seconds()})
	if errors.Is(err, pgx.ErrNoRows) {
		return JobClaim{}, false, nil
	}
	if err != nil {
		return JobClaim{}, false, err
	}
	return JobClaim{ID: r.ID.Bytes, Attempt: int(r.Attempts), Job: job, Due: due, epoch: lease}, true, nil
}

// FinishJob records how a run claimed ended. A run another process has
// taken over since is left as that process has it.
func (s *Store) FinishJob(ctx context.Context, c JobClaim, outcome, detail string) error {
	_, err := s.q.FinishJobRun(ctx, db.FinishJobRunParams{
		Outcome: pgtype.Text{String: outcome, Valid: true}, Detail: detail, ID: pgtype.UUID{Bytes: c.ID, Valid: true}, Epoch: c.epoch,
	})
	return err
}

// JobRun is a run of a job as recorded.
type JobRun struct {
	Job      string
	Due      time.Time
	Started  time.Time
	Finished time.Time // zero while it runs
	Outcome  string    // "" while it runs
	Detail   string
	Attempts int
}

// JobRunOf is the run of a job for a time it was due, or ErrNotFound.
func (s *Store) JobRunOf(ctx context.Context, job string, due time.Time) (JobRun, error) {
	r, err := s.q.JobRun(ctx, db.JobRunParams{Job: job, Due: due})
	if errors.Is(err, pgx.ErrNoRows) {
		return JobRun{}, ErrNotFound
	}
	if err != nil {
		return JobRun{}, err
	}
	return JobRun{Job: job, Due: due.UTC(), Started: r.StartedAt.UTC(), Finished: timeOf(r.FinishedAt), Outcome: r.Outcome.String,
		Detail: r.Detail, Attempts: int(r.Attempts)}, nil
}

// JobRuns are the latest runs, the newest first.
func (s *Store) JobRuns(ctx context.Context, limit int) ([]JobRun, error) {
	rows, err := s.q.JobRuns(ctx, int32(limit))
	if err != nil {
		return nil, err
	}
	out := make([]JobRun, len(rows))
	for i, r := range rows {
		out[i] = JobRun{Job: r.Job, Due: r.Due.UTC(), Started: r.StartedAt.UTC(), Finished: timeOf(r.FinishedAt),
			Outcome: r.Outcome.String, Detail: r.Detail, Attempts: int(r.Attempts)}
	}
	return out, nil
}

// JobOutcome is a job's last finished run's outcome, and when it last
// succeeded: zero if never.
type JobOutcome struct {
	Job      string
	Outcome  string
	Finished time.Time
	LastOK   time.Time
}

// JobOutcomes are each job's last outcomes.
func (s *Store) JobOutcomes(ctx context.Context) ([]JobOutcome, error) {
	rows, err := s.q.LastJobOutcomes(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]JobOutcome, len(rows))
	for i, r := range rows {
		o := JobOutcome{Job: r.Job, Outcome: r.Outcome.String, Finished: timeOf(r.FinishedAt)}
		if r.LastOk.Unix() > 0 {
			o.LastOK = r.LastOk.UTC()
		}
		out[i] = o
	}
	return out, nil
}

// DeleteJobRuns deletes the finished runs started before the time given.
func (s *Store) DeleteJobRuns(ctx context.Context, before time.Time) (int64, error) {
	return s.q.DeleteOldJobRuns(ctx, before)
}

// SessionBatch is how many sessions one statement deletes.
const SessionBatch = 1000

// DeleteSessions deletes the sessions last seen before the time given,
// SessionBatch at a time, so no statement holds many rows' locks; it
// returns how many it deleted.
func (s *Store) DeleteSessions(ctx context.Context, before time.Time) (int64, error) {
	var total int64
	for {
		n, err := s.q.DeleteStaleSessions(ctx, db.DeleteStaleSessionsParams{Before: before, Lim: SessionBatch})
		total += n
		if err != nil || n < SessionBatch {
			return total, err
		}
	}
}
