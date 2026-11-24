-- SPDX-License-Identifier: AGPL-3.0-only
-- The long Dash, twice as far to its mark, a course of its own in the
-- records: a race on it is the Dash's shape, long.

-- +goose Up

ALTER TABLE race_record DROP CONSTRAINT race_record_course;
ALTER TABLE race_record ADD CONSTRAINT race_record_course CHECK (
  course IN ('short', 'long', 'triangle', 'long-triangle', 'island', 'reach', 'dash', 'long-dash')) NOT VALID;
ALTER TABLE race_record VALIDATE CONSTRAINT race_record_course;
