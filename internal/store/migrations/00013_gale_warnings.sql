-- SPDX-License-Identifier: AGPL-3.0-only
-- Gale warnings in the news: an item for each warning, once, whatever
-- restarts there are while it is in force.

-- +goose Up

-- A gale warning's item is about the gale, its number the warning's: the
-- issue of the forecast it came into force at, counted in issues from the
-- world's epoch. A second write of one warning does nothing.
ALTER TABLE news_item DROP CONSTRAINT news_item_subject_check;
ALTER TABLE news_item ADD CONSTRAINT news_item_subject_check CHECK (subject IN ('island', 'place', 'feature', 'world', 'gale'));
CREATE UNIQUE INDEX news_item_gale ON news_item (world_id, number) WHERE subject = 'gale';
