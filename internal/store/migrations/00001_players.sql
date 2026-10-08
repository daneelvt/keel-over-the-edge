-- SPDX-License-Identifier: AGPL-3.0-only
-- Players: accounts, their sailors and their sessions.

-- +goose Up

-- An account is a human's or an AI agent's. A guest is a human account not
-- yet saved. An AI account always has an owner: a saved human account.
CREATE TABLE account (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  kind         text NOT NULL CHECK (kind IN ('human', 'ai')),
  owner_id     uuid REFERENCES account (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  saved_at     timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_ai_has_owner CHECK ((kind = 'ai') = (owner_id IS NOT NULL))
);
CREATE INDEX account_owner ON account (owner_id) WHERE owner_id IS NOT NULL;

-- A kind never changes; an owner never changes, and is a saved human.
-- +goose StatementBegin
CREATE FUNCTION account_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.kind IS DISTINCT FROM OLD.kind
                           OR NEW.owner_id IS DISTINCT FROM OLD.owner_id) THEN
    RAISE EXCEPTION 'an account''s kind and owner never change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.owner_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM account
       WHERE id = NEW.owner_id AND kind = 'human' AND saved_at IS NOT NULL) THEN
    RAISE EXCEPTION 'an owner is a saved human account'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
-- +goose StatementEnd

CREATE TRIGGER account_rules BEFORE INSERT OR UPDATE ON account
  FOR EACH ROW EXECUTE FUNCTION account_rules();

-- One sailor per account. name is shown as the player typed it, in its
-- display form; name_key is what two names are compared by, so names that
-- only look alike cannot both be taken. Deleting the account frees the name.
CREATE TABLE sailor (
  account_id uuid PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 80),
  name_key   text NOT NULL CONSTRAINT sailor_name_key UNIQUE,
  look       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A session is a browser's: only the SHA-256 of its token is stored.
CREATE TABLE session (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id   uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_account ON session (account_id);
