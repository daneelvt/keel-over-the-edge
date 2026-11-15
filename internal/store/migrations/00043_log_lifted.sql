-- SPDX-License-Identifier: AGPL-3.0-only
-- A voyage its sailor ended by lifting the boat home to the start.

-- +goose Up

ALTER TABLE log_voyage DROP CONSTRAINT log_voyage_how_check;
ALTER TABLE log_voyage ADD CONSTRAINT log_voyage_how_check CHECK (
  how IN ('returned', 'expired', 'over', 'taken', 'aboard', 'ashore', 'landed', 'lifted')) NOT VALID;
ALTER TABLE log_voyage VALIDATE CONSTRAINT log_voyage_how_check;
