-- SPDX-License-Identifier: AGPL-3.0-only
-- The contributor agreement: who has signed which version, and which open
-- pull requests wait for whom. The keeper of the agreement, a process of
-- its own, reaches these two tables alone, as the role agreement, which
-- keel migrate grants them to once the role exists (GrantRoles).

-- +goose Up

-- A signature: a GitHub account, by its number, which outlives a rename;
-- its name when it signed; the full name it gave; the version signed and
-- the SHA-256 of that version's text. how is page when its holder signed
-- on the signing page, owner when the owner entered it by hand (a minor's,
-- with their parent's or guardian's consent, or one on paper), with the
-- owner's note. A mistaken signature is voided with its reason, never
-- deleted.
CREATE TABLE agreement_signature (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  github_id bigint NOT NULL CHECK (github_id > 0),
  login text NOT NULL,
  name text NOT NULL CHECK (name <> ''),
  version integer NOT NULL CHECK (version >= 1),
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  signed_at timestamptz NOT NULL DEFAULT now(),
  how text NOT NULL CHECK (how IN ('page', 'owner')),
  guardian text NOT NULL DEFAULT '',
  guardian_email text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  voided_at timestamptz,
  void_reason text NOT NULL DEFAULT '',
  CHECK ((voided_at IS NULL) = (void_reason = ''))
);

-- One standing signature of a version for an account: signing again
-- changes nothing.
CREATE UNIQUE INDEX agreement_signature_standing ON agreement_signature (github_id, version)
  WHERE voided_at IS NULL;

-- An open pull request waiting for an account to sign: checked again the
-- moment it does. A pull request's rows are replaced at each check.
CREATE TABLE agreement_pull (
  repo text NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  github_id bigint NOT NULL,
  head_sha text NOT NULL,
  since timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo, number, github_id)
);

CREATE INDEX agreement_pull_github_id ON agreement_pull (github_id);
