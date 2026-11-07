-- SPDX-License-Identifier: AGPL-3.0-only
-- No storms in the news: the news tells what is charted and the world's
-- own notices, and the weather is the chart's and the forecast's. The
-- items told of storms forming (subject 'gale') go, in every world.
--
-- Rows go, not the schema: the subject's check keeps 'gale' and the
-- news_item_gale index stays, so a build before this one, rolled back to,
-- still writes and reads its items as it did.

-- +goose Up

DELETE FROM news_item WHERE subject = 'gale';
