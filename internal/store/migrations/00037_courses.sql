-- SPDX-License-Identifier: AGPL-3.0-only
-- Courses for races. A world's island courses go with its bundle's
-- records; what they add to the tables is a kind of place, the beacon, a
-- spar at the seaward end of a reef or bar a course passes, charted with
-- what it marks; and a kind of story, a course opened by charting, about
-- the course (subject 'course', its number in the world).

-- +goose Up

ALTER TABLE place DROP CONSTRAINT place_kind_check;
ALTER TABLE place ADD CONSTRAINT place_kind_check CHECK (kind IN (
  'island', 'group', 'port', 'fishing-village', 'lighthouse', 'anchorage', 'cove', 'lagoon', 'reef', 'sandbar', 'wreck',
  'beacon'
)) NOT VALID;
ALTER TABLE place VALIDATE CONSTRAINT place_kind_check;

ALTER TABLE news_item DROP CONSTRAINT news_item_story;
ALTER TABLE news_item ADD CONSTRAINT news_item_story CHECK (
  story IN ('great', 'record', 'life', 'crew', 'first', 'run', 'milestone', 'charting', 'arrival', 'review', 'edition',
            'course')) NOT VALID;
ALTER TABLE news_item VALIDATE CONSTRAINT news_item_story;
ALTER TABLE news_item DROP CONSTRAINT news_item_subject_check;
ALTER TABLE news_item ADD CONSTRAINT news_item_subject_check CHECK (
  subject IN ('island', 'place', 'feature', 'world', 'gale', 'sailor', 'course')) NOT VALID;
ALTER TABLE news_item VALIDATE CONSTRAINT news_item_subject_check;
