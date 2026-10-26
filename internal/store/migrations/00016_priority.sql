-- SPDX-License-Identifier: AGPL-3.0-only
-- Priority accounts: an account, human or AI, that never waits for a boat.
-- The owner sets it from the world page; a player never does.

-- +goose Up

-- A column with a constant default is added without rewriting the table:
-- the default is kept in the catalog and read for the rows already there.
ALTER TABLE account ADD COLUMN priority boolean NOT NULL DEFAULT false;
