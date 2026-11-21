-- SPDX-License-Identifier: AGPL-3.0-only
-- A third shape of buoy course, the reach: across the wind to one mark
-- and back, the Harbourmaster's standing trial for a first run. A race's
-- shape and a record's course may be it.

-- +goose Up

ALTER TABLE race DROP CONSTRAINT race_shape_check;
ALTER TABLE race ADD CONSTRAINT race_shape_check CHECK (shape IN ('windward-leeward', 'triangle', 'reach')) NOT VALID;
ALTER TABLE race VALIDATE CONSTRAINT race_shape_check;

ALTER TABLE race_record DROP CONSTRAINT race_record_course;
ALTER TABLE race_record ADD CONSTRAINT race_record_course CHECK (
  course IN ('short', 'long', 'triangle', 'long-triangle', 'island', 'reach')) NOT VALID;
ALTER TABLE race_record VALIDATE CONSTRAINT race_record_course;
