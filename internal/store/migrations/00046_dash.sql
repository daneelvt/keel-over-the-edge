-- SPDX-License-Identifier: AGPL-3.0-only
-- A fourth shape of buoy course, the Dash: across the wind to one mark and
-- home to a finish line of its own, every harbour race's and every buoy
-- race a sailor makes. A race's shape and a record's course may be it. And
-- a race called off at its warning signal says why: a storm at its place.

-- +goose Up

ALTER TABLE race DROP CONSTRAINT race_shape_check;
ALTER TABLE race ADD CONSTRAINT race_shape_check CHECK (shape IN ('windward-leeward', 'triangle', 'reach', 'dash')) NOT VALID;
ALTER TABLE race VALIDATE CONSTRAINT race_shape_check;

ALTER TABLE race_record DROP CONSTRAINT race_record_course;
ALTER TABLE race_record ADD CONSTRAINT race_record_course CHECK (
  course IN ('short', 'long', 'triangle', 'long-triangle', 'island', 'reach', 'dash')) NOT VALID;
ALTER TABLE race_record VALIDATE CONSTRAINT race_record_course;

ALTER TABLE race ADD COLUMN called_off text CHECK (called_off IN ('storm'));
ALTER TABLE race ADD CONSTRAINT race_called_off CHECK (called_off IS NULL OR state = 'cancelled') NOT VALID;
ALTER TABLE race VALIDATE CONSTRAINT race_called_off;
