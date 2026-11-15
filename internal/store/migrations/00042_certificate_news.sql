-- SPDX-License-Identifier: AGPL-3.0-only
-- The news's story of a certificate earned, about its sailor (subject
-- 'sailor'), written with the earning.

-- +goose Up

ALTER TABLE news_item DROP CONSTRAINT news_item_story;
ALTER TABLE news_item ADD CONSTRAINT news_item_story CHECK (
  story IN ('great', 'record', 'life', 'crew', 'first', 'run', 'milestone', 'charting', 'arrival', 'review', 'edition',
            'course', 'race', 'trial', 'certificate')) NOT VALID;
ALTER TABLE news_item VALIDATE CONSTRAINT news_item_story;
