-- SPDX-License-Identifier: AGPL-3.0-only
-- Machine sailors and the AI apps that sail them. A human account makes
-- AI accounts, up to its cap, each with a sailor of a machine look; the
-- account's fleet holds a boat for each of its sailors; an AI app approved
-- with the owner's passkey, or a connection token, is a grant, which holds
-- the tokens the app presents. The game is the apps' OAuth authorization
-- server: the clients that registered themselves, the authorization
-- requests waiting for their approval and the codes they are given are
-- kept here too. One setting, how long a grant lasts.

-- +goose Up

-- How many machine sailors a human account may make. An AI account's is
-- never read.
ALTER TABLE account ADD COLUMN machine_cap smallint NOT NULL DEFAULT 1;
ALTER TABLE account ADD CONSTRAINT account_machine_cap CHECK (machine_cap BETWEEN 0 AND 50) NOT VALID;
ALTER TABLE account VALIDATE CONSTRAINT account_machine_cap;

-- A machine sailor's look: its version, its metal's finish and its main
-- colour, ids of the catalog's machine sets. look is 'machine' for it, and
-- the three are set; a human sailor's are not.
ALTER TABLE sailor
  ADD COLUMN version text,
  ADD COLUMN finish text,
  ADD COLUMN colour text;
ALTER TABLE sailor ADD CONSTRAINT sailor_machine_look CHECK (
  CASE WHEN look = 'machine' THEN version IS NOT NULL AND finish IS NOT NULL AND colour IS NOT NULL
       ELSE version IS NULL AND finish IS NULL AND colour IS NULL END) NOT VALID;
ALTER TABLE sailor VALIDATE CONSTRAINT sailor_machine_look;

-- An AI account's sailor has the machine look, and only an AI account's
-- does.
-- +goose StatementBegin
CREATE FUNCTION sailor_look_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.look = 'machine') IS DISTINCT FROM EXISTS (
       SELECT 1 FROM account WHERE id = NEW.account_id AND kind = 'ai') THEN
    RAISE EXCEPTION 'a machine look is an AI account''s sailor''s, and only its'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
-- +goose StatementEnd

CREATE TRIGGER sailor_look_rules BEFORE INSERT OR UPDATE ON sailor
  FOR EACH ROW EXECUTE FUNCTION sailor_look_rules();

-- A human account's fleet: its boats, by the catalog's boat ids, shared by
-- its sailors. A boat outlives a machine sailor deleted; it goes with the
-- account.
CREATE TABLE boat (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (octet_length(kind) BETWEEN 1 AND 80),
  made_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boat_account ON boat (account_id);

-- Every human account's first boat.
INSERT INTO boat (account_id, kind) SELECT id, 'jolly-boat' FROM account WHERE kind = 'human';

-- An AI app that registered itself (RFC 7591): the client ID the game
-- issued it, the name it gave, and where its sign-ins may return.
CREATE TABLE oauth_client (
  client_id     text PRIMARY KEY CHECK (octet_length(client_id) BETWEEN 1 AND 64),
  name          text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 400),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  metadata      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_client_last_used ON oauth_client (last_used_at);

-- An authorization request shown on the approval page, keyed by the
-- SHA-256 of the handle its cookie carries, used once. account_id and
-- passkey_id are the account whose passkey approved it, until
-- confirmed_until.
CREATE TABLE oauth_request (
  handle_hash     bytea PRIMARY KEY CHECK (octet_length(handle_hash) = 32),
  client_id       text NOT NULL CHECK (octet_length(client_id) BETWEEN 1 AND 512),
  client_name     text NOT NULL,
  registered      boolean NOT NULL,
  redirect_uri    text NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 2048),
  state           text NOT NULL DEFAULT '' CHECK (octet_length(state) <= 512),
  code_challenge  text NOT NULL CHECK (octet_length(code_challenge) = 43),
  account_id      uuid REFERENCES account (id) ON DELETE CASCADE,
  passkey_id      uuid REFERENCES passkey (id) ON DELETE CASCADE,
  confirmed_until timestamptz,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_request_confirmed CHECK ((account_id IS NULL) = (confirmed_until IS NULL))
);
CREATE INDEX oauth_request_expires ON oauth_request (expires_at);

-- A grant: an AI app approved for a machine sailor, or its connection
-- token. It ends when revoked (revoked_why says by what), with its
-- account, or at its start (approved_at) plus the lifetime set.
CREATE TABLE ai_grant (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id   uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('app', 'connection')),
  client_id    text CHECK (octet_length(client_id) BETWEEN 1 AND 512),
  client_name  text,
  redirect_uri text,
  scope        text NOT NULL DEFAULT 'sail',
  approved_at  timestamptz NOT NULL DEFAULT now(),
  approved_by  uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  passkey_id   uuid REFERENCES passkey (id) ON DELETE SET NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_why  text CHECK (revoked_why IN ('owner', 'replaced', 'reuse', 'app')),
  CONSTRAINT ai_grant_app CHECK ((kind = 'app') = (client_id IS NOT NULL AND client_name IS NOT NULL AND redirect_uri IS NOT NULL)),
  CONSTRAINT ai_grant_revoked CHECK ((revoked_at IS NULL) = (revoked_why IS NULL))
);
CREATE INDEX ai_grant_account ON ai_grant (account_id);
CREATE INDEX ai_grant_client ON ai_grant (client_id) WHERE client_id IS NOT NULL;
-- One connection token at a time for a machine sailor.
CREATE UNIQUE INDEX ai_grant_connection ON ai_grant (account_id) WHERE kind = 'connection' AND revoked_at IS NULL;

-- A grant's tokens, only as the SHA-256 of what the app holds. An access
-- token and the refresh token issued with it share a pair; a refresh token
-- used is kept, with the pair issued in its place (next_pair), so that
-- presenting it again is known. An access token expires; a refresh or
-- connection token ends with its grant.
CREATE TABLE oauth_token (
  hash       bytea PRIMARY KEY CHECK (octet_length(hash) = 32),
  grant_id   uuid NOT NULL REFERENCES ai_grant (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('access', 'refresh', 'connection')),
  pair       uuid NOT NULL,
  expires_at timestamptz,
  used_at    timestamptz,
  next_pair  uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_token_expires CHECK ((kind = 'access') = (expires_at IS NOT NULL))
);
CREATE INDEX oauth_token_grant ON oauth_token (grant_id);
CREATE INDEX oauth_token_pair ON oauth_token (pair);
CREATE INDEX oauth_token_expires ON oauth_token (expires_at) WHERE expires_at IS NOT NULL;

-- An authorization code, by its SHA-256, given on approval and exchanged
-- once at the token endpoint for its grant's first tokens. A code used is
-- kept until it expires, so that its second use is known.
CREATE TABLE oauth_code (
  hash           bytea PRIMARY KEY CHECK (octet_length(hash) = 32),
  grant_id       uuid NOT NULL REFERENCES ai_grant (id) ON DELETE CASCADE,
  client_id      text NOT NULL,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);
CREATE INDEX oauth_code_expires ON oauth_code (expires_at);

-- The game's settings: one row. grant_lifetime is how long an approval or
-- a connection token lasts from when it is made.
CREATE TABLE setting (
  one            boolean PRIMARY KEY DEFAULT true CHECK (one),
  grant_lifetime interval NOT NULL DEFAULT '90 days'
    CONSTRAINT setting_grant_lifetime CHECK (grant_lifetime BETWEEN interval '1 minute' AND interval '400 days')
);
INSERT INTO setting DEFAULT VALUES;

-- The approval page's passkey: a ceremony of its own, with no account
-- until the passkey names one.
ALTER TABLE webauthn_ceremony DROP CONSTRAINT webauthn_ceremony_kind_check;
ALTER TABLE webauthn_ceremony ADD CONSTRAINT webauthn_ceremony_kind_check
  CHECK (kind IN ('create', 'signin', 'add', 'confirm', 'approve'));
