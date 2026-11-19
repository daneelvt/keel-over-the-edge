-- SPDX-License-Identifier: AGPL-3.0-only
-- The contributor agreement: signatures, and the pull requests waiting
-- for them.
;

-- name: AgreementSigned :many
-- Which of these GitHub accounts have a standing signature of a version.
SELECT DISTINCT github_id FROM agreement_signature
WHERE github_id = ANY(@github_ids::bigint[]) AND version = @version AND voided_at IS NULL;

-- name: AgreementSign :one
-- A signature; a standing one of the same version for the same account
-- is kept as it is, and nothing new is made.
INSERT INTO agreement_signature (github_id, login, name, version, text_sha256, how, guardian, guardian_email, note)
VALUES (@github_id, @login, @name, @version, @text_sha256, @how, @guardian, @guardian_email, @note)
ON CONFLICT (github_id, version) WHERE voided_at IS NULL DO NOTHING
RETURNING id;

-- name: AgreementSignaturesOf :many
-- An account's standing signatures, newest version first.
SELECT * FROM agreement_signature
WHERE github_id = @github_id AND voided_at IS NULL
ORDER BY version DESC, signed_at DESC;

-- name: AgreementSignatures :many
-- Every signature, voided ones too, oldest first: the owner's record.
SELECT * FROM agreement_signature ORDER BY signed_at, id;

-- name: AgreementVoid :one
-- A mistaken signature voided, with its reason; one already voided is
-- left as it is.
UPDATE agreement_signature SET voided_at = now(), void_reason = @reason
WHERE id = @id AND voided_at IS NULL
RETURNING github_id;

-- name: AgreementWaitingFor :many
-- The open pull requests waiting for an account.
SELECT repo, number FROM agreement_pull WHERE github_id = @github_id ORDER BY repo, number;

-- name: AgreementWaitingAll :many
-- Every pull request waiting for anyone.
SELECT DISTINCT repo, number FROM agreement_pull ORDER BY repo, number;

-- name: AgreementPullClear :exec
-- A pull request waits for nobody: checked, or closed.
DELETE FROM agreement_pull WHERE repo = @repo AND number = @number;

-- name: AgreementPullWait :exec
-- A pull request waits for an account.
INSERT INTO agreement_pull (repo, number, github_id, head_sha) VALUES (@repo, @number, @github_id, @head_sha)
ON CONFLICT (repo, number, github_id) DO UPDATE SET head_sha = excluded.head_sha;

-- name: AgreementReady :one
-- Whether the role may read its tables: the keeper's readiness.
SELECT (SELECT count(*) FROM agreement_signature WHERE false) + (SELECT count(*) FROM agreement_pull WHERE false) AS n;
