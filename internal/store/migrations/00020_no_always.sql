-- SPDX-License-Identifier: AGPL-3.0-only
-- No "always": a human sailor lets others watch them for one voyage at a
-- time, a choice the game holds with the boat and never stores. The
-- setting kept on the account goes, and with it every account's "always".

-- +goose Up

ALTER TABLE account DROP CONSTRAINT account_spectators;
ALTER TABLE account DROP COLUMN spectators;
