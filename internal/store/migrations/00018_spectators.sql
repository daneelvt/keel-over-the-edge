-- SPDX-License-Identifier: AGPL-3.0-only
-- Spectators: whether a human sailor lets other players watch their boat,
-- always. Off for every account until its player turns it on; a choice for
-- one voyage is never stored, the game holds it with the boat.

-- +goose Up

-- A machine sailor is watchable whenever it sails: an AI account's is
-- never set.
ALTER TABLE account ADD COLUMN spectators boolean NOT NULL DEFAULT false;
ALTER TABLE account ADD CONSTRAINT account_spectators CHECK (NOT spectators OR kind = 'human') NOT VALID;
ALTER TABLE account VALIDATE CONSTRAINT account_spectators;
