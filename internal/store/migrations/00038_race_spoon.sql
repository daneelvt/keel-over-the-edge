-- SPDX-License-Identifier: AGPL-3.0-only
-- The wooden spoon hung from the stern. A sailor given the spoon in a race
-- chooses whether their boats fly it for the rest of that world: on their
-- own record of the race, no to begin with, changed at any time. Only the
-- records of the world sailed now are read for it, so a new world starts
-- with every stern bare.

-- +goose Up

ALTER TABLE race_record ADD COLUMN hung boolean NOT NULL DEFAULT false;
CREATE INDEX race_record_hung ON race_record (account_id, world) WHERE hung;
