-- SPDX-License-Identifier: AGPL-3.0-only
-- Jobs: each run, once for each job and each time it was due.
;

-- name: ClaimJobRun :one
-- A run of a job for a time it was due: a new row, or the row of a run that
-- failed at least retry_seconds ago, or of one whose process stopped before
-- it finished; nothing for one done, or running, or failed lately. Fenced
-- by the simulation's lease: a process that no longer holds it claims none.
INSERT INTO job_run (job, due, epoch)
SELECT @job, @due, @epoch::bigint
WHERE (SELECT epoch FROM sim_lease FOR SHARE) = @epoch::bigint
ON CONFLICT (job, due) DO UPDATE
SET started_at = now(), finished_at = NULL, outcome = NULL, detail = '', attempts = job_run.attempts + 1, epoch = excluded.epoch
WHERE (job_run.outcome = 'failed' AND job_run.finished_at < now() - make_interval(secs => @retry_seconds::float8))
   OR (job_run.outcome IS NULL AND job_run.epoch < excluded.epoch)
RETURNING id, attempts;

-- name: FinishJobRun :execrows
UPDATE job_run SET finished_at = now(), outcome = @outcome, detail = @detail
WHERE id = @id AND epoch = @epoch AND outcome IS NULL;

-- name: JobRun :one
SELECT outcome, detail, attempts, started_at, finished_at FROM job_run WHERE job = @job AND due = @due;

-- name: JobRuns :many
SELECT job, due, started_at, finished_at, outcome, detail, attempts FROM job_run ORDER BY started_at DESC, id DESC LIMIT @lim;

-- name: LastJobOutcomes :many
-- Each job's last run that finished, and when its last run that succeeded
-- finished: 1970 for none.
SELECT DISTINCT ON (job) job, outcome, finished_at,
  coalesce((SELECT max(o.finished_at) FROM job_run o WHERE o.job = r.job AND o.outcome = 'ok'), 'epoch')::timestamptz AS last_ok
FROM job_run r WHERE outcome IS NOT NULL
ORDER BY job, finished_at DESC;

-- name: DeleteOldJobRuns :execrows
DELETE FROM job_run WHERE started_at < @before AND outcome IS NOT NULL;
