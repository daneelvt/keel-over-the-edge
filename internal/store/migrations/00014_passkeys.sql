-- SPDX-License-Identifier: AGPL-3.0-only
-- Passkeys: every account is made with one. The guests, kept by nothing
-- but a browser's cookie, are deleted; accounts gain their passkeys, the
-- WebAuthn user handle their passkeys carry, and a recovery code; a
-- ceremony with the browser's passkey prompt is a row of its own, used
-- once.

-- +goose Up

-- The guests go, with their sailors and sessions (the cascade): their
-- names are free again. What they charted keeps its place, credited to an
-- account that is gone, under no name, so that a name taken again cannot
-- pass for theirs.
UPDATE charting SET sailor = NULL
WHERE account_id IN (SELECT id FROM account WHERE kind = 'human' AND saved_at IS NULL);
UPDATE news_item SET sailor = NULL
WHERE account_id IN (SELECT id FROM account WHERE kind = 'human' AND saved_at IS NULL);
DELETE FROM account WHERE kind = 'human' AND saved_at IS NULL;

-- A human account's user handle: 64 random bytes its passkeys carry, which
-- name it and nothing else (WebAuthn Level 3, 14.6.1). Its recovery code,
-- only as its SHA-256: a code of 128 random bits, found by the code alone,
-- needs no salt or slow hash (NIST SP 800-63B-4, 3.1.2). recovered_at is
-- when the code was last used, until the next sign-in has shown it. Each
-- column is null for an AI account, and for the rows an older build makes.
ALTER TABLE account
  ADD COLUMN user_handle bytea CONSTRAINT account_user_handle UNIQUE CHECK (octet_length(user_handle) = 64),
  ADD COLUMN recovery_hash bytea CONSTRAINT account_recovery_hash UNIQUE CHECK (octet_length(recovery_hash) = 32),
  ADD COLUMN recovery_made_at timestamptz,
  ADD COLUMN recovered_at timestamptz;

-- A session made by the recovery code is held to adding a passkey until
-- one is added; confirmed_until is how long a passkey just confirmed
-- allows what cannot be undone: removing a passkey, a new recovery code,
-- deleting the account.
ALTER TABLE session
  ADD COLUMN held boolean NOT NULL DEFAULT false,
  ADD COLUMN confirmed_until timestamptz;

-- A passkey: the credential record WebAuthn's relying party keeps (Level
-- 3, 4, "credential record"). flags is the authenticator data's flags byte
-- as last seen, backup_eligible never changes, backup_state may; made_on
-- is the device and browser it was made on, as the account page lists it.
CREATE TABLE passkey (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id         uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  credential_id      bytea NOT NULL CONSTRAINT passkey_credential_id UNIQUE CHECK (octet_length(credential_id) BETWEEN 1 AND 1023),
  public_key         bytea NOT NULL,
  algorithm          integer NOT NULL,
  sign_count         bigint NOT NULL CHECK (sign_count BETWEEN 0 AND 4294967295),
  clone_warning      boolean NOT NULL DEFAULT false,
  flags              smallint NOT NULL CHECK (flags BETWEEN 0 AND 255),
  backup_eligible    boolean NOT NULL,
  backup_state       boolean NOT NULL,
  aaguid             bytea NOT NULL CHECK (octet_length(aaguid) IN (0, 16)),
  transports         text[] NOT NULL DEFAULT '{}',
  attestation_format text NOT NULL,
  attachment         text NOT NULL DEFAULT '',
  made_on            text NOT NULL CHECK (octet_length(made_on) <= 80),
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX passkey_account ON passkey (account_id);

-- A ceremony begun and not yet finished, keyed by the SHA-256 of the handle
-- its cookie carries. Making an account keeps the sailor's name, look and
-- user handle in it; adding a passkey and confirming one keep the account.
-- session is go-webauthn's SessionData as JSON, which only the build that
-- wrote it reads.
CREATE TABLE webauthn_ceremony (
  handle_hash bytea PRIMARY KEY CHECK (octet_length(handle_hash) = 32),
  kind        text NOT NULL CHECK (kind IN ('create', 'signin', 'add', 'confirm')),
  account_id  uuid REFERENCES account (id) ON DELETE CASCADE,
  name        text,
  name_key    text,
  look        text,
  user_handle bytea CHECK (octet_length(user_handle) = 64),
  session     bytea NOT NULL CHECK (octet_length(session) <= 16384),
  build       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webauthn_ceremony_account CHECK ((kind IN ('add', 'confirm')) = (account_id IS NOT NULL)),
  CONSTRAINT webauthn_ceremony_sailor CHECK (
    (kind = 'create') = (name IS NOT NULL AND name_key IS NOT NULL AND look IS NOT NULL AND user_handle IS NOT NULL))
);
CREATE INDEX webauthn_ceremony_expires ON webauthn_ceremony (expires_at);
CREATE INDEX webauthn_ceremony_account ON webauthn_ceremony (account_id) WHERE account_id IS NOT NULL;
