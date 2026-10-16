-- SPDX-License-Identifier: AGPL-3.0-only
-- The edge: a boat going over the falls, and the closest approach to the
-- lip a voyage survived.

-- +goose Up

-- Going over is one row, 'over', where the boat's centre crossed the lip,
-- metres east and north of the world's centre. A voyage that survived an
-- approach to the lip ends with one row, 'approach': its least distance
-- inside the lip in distance, metres, and where that was. distance is null
-- for every other kind, which builds that know nothing of the edge go on
-- writing.
ALTER TABLE event DROP CONSTRAINT event_kind_check;
ALTER TABLE event ADD CONSTRAINT event_kind_check CHECK (kind IN ('launched', 'returned', 'expired', 'bump', 'over', 'approach'));
ALTER TABLE event ADD COLUMN distance double precision CHECK (distance >= 0);
ALTER TABLE event ADD CONSTRAINT event_edge_check CHECK (
  (kind = 'approach') = (distance IS NOT NULL)
  AND (kind NOT IN ('over', 'approach') OR x IS NOT NULL AND y IS NOT NULL)
);
