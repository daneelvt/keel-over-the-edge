-- SPDX-License-Identifier: AGPL-3.0-only
-- Shipmates: who sailed with whom, offers, shipmates, appearing offline.
-- Pairs are kept the lesser ID first. No message between shipmates is
-- written here.
;

-- name: AllShipmates :many
SELECT a_id, b_id FROM shipmate;

-- name: SawTogether :exec
-- Two people aboard the same boat together now; with sailed, together
-- five minutes or more.
INSERT INTO sailed_with (a_id, b_id, seen_at, sailed_at, boat)
VALUES (@a_id, @b_id, @at, CASE WHEN sqlc.arg(sailed)::boolean THEN @at::timestamptz END, @boat)
ON CONFLICT (a_id, b_id) DO UPDATE SET
  seen_at = greatest(sailed_with.seen_at, excluded.seen_at),
  sailed_at = CASE WHEN sqlc.arg(sailed)::boolean THEN greatest(sailed_with.sailed_at, excluded.sailed_at) ELSE sailed_with.sailed_at END,
  boat = excluded.boat;

-- name: SailedWith :one
SELECT seen_at, sailed_at, boat FROM sailed_with WHERE a_id = @a_id AND b_id = @b_id;

-- name: ForgetSailed :exec
-- No longer shipmates: an offer again needs sailing together again.
UPDATE sailed_with SET sailed_at = NULL WHERE a_id = @a_id AND b_id = @b_id;

-- name: ShipmatesOf :many
-- An account's shipmates, by name.
SELECT o.id, sl.name, sl.look,
  coalesce(sl.version, '')::text AS version, coalesce(sl.skin, '')::text AS skin, coalesce(sl.hair, '')::text AS hair,
  coalesce(sl.colour, '')::text AS colour, coalesce(sl.finish, '')::text AS finish, sl.look_chosen, o.appear_offline
FROM shipmate m
JOIN account o ON o.id = CASE WHEN m.a_id = @id THEN m.b_id ELSE m.a_id END
JOIN sailor sl ON sl.account_id = o.id
WHERE m.a_id = @id OR m.b_id = @id
ORDER BY sl.name_key;

-- name: CountShipmates :one
SELECT count(*)::bigint FROM shipmate WHERE a_id = @id OR b_id = @id;

-- name: OffersTo :many
-- The offers made to an account that reach it, waiting, the oldest
-- first.
SELECT o.from_id, sl.name, sl.look,
  coalesce(sl.version, '')::text AS version, coalesce(sl.skin, '')::text AS skin, coalesce(sl.hair, '')::text AS hair,
  coalesce(sl.colour, '')::text AS colour, coalesce(sl.finish, '')::text AS finish, sl.look_chosen
FROM shipmate_offer o JOIN sailor sl ON sl.account_id = o.from_id
WHERE o.to_id = @id AND NOT o.silent AND o.made_at > @since
ORDER BY o.made_at;

-- name: CountOffersFrom :one
SELECT count(*)::bigint FROM shipmate_offer WHERE from_id = @id AND made_at > @since;

-- name: OfferOf :one
SELECT silent, made_at FROM shipmate_offer WHERE from_id = @from_id AND to_id = @to_id AND made_at > @since;

-- name: InsertOffer :exec
-- An offer, or the one waiting already, unchanged.
INSERT INTO shipmate_offer (from_id, to_id, silent) VALUES (@from_id, @to_id, @silent)
ON CONFLICT (from_id, to_id) DO UPDATE SET made_at = now(), silent = excluded.silent
WHERE shipmate_offer.made_at <= sqlc.arg(since)::timestamptz;

-- name: SilenceOffer :execrows
-- An offer declined: it reaches its receiver no more, and its sender sees
-- it waiting until it lapses, as any other.
UPDATE shipmate_offer SET silent = true WHERE from_id = @from_id AND to_id = @to_id;

-- name: DeleteOffers :exec
-- Every offer between two accounts, both ways.
DELETE FROM shipmate_offer
WHERE (from_id = @a_id AND to_id = @b_id) OR (from_id = @b_id AND to_id = @a_id);

-- name: InsertShipmate :execrows
INSERT INTO shipmate (a_id, b_id) VALUES (@a_id, @b_id) ON CONFLICT DO NOTHING;

-- name: DeleteShipmate :execrows
DELETE FROM shipmate WHERE a_id = @a_id AND b_id = @b_id;

-- name: RecentCrew :many
-- Those an account was aboard with since since, the latest first: their
-- names and looks, the last time and boat, the last time they sailed
-- together five minutes or more, whether they are shipmates, and whether
-- the account's own offer to them waits.
SELECT o.id, sl.name, sl.look,
  coalesce(sl.version, '')::text AS version, coalesce(sl.skin, '')::text AS skin, coalesce(sl.hair, '')::text AS hair,
  coalesce(sl.colour, '')::text AS colour, coalesce(sl.finish, '')::text AS finish, sl.look_chosen, w.seen_at, w.sailed_at, w.boat,
  EXISTS (SELECT 1 FROM shipmate m WHERE m.a_id = w.a_id AND m.b_id = w.b_id)::boolean AS shipmate,
  EXISTS (SELECT 1 FROM shipmate_offer f WHERE f.from_id = @id AND f.to_id = o.id AND f.made_at > @offers_since)::boolean AS offered
FROM sailed_with w
JOIN account o ON o.id = CASE WHEN w.a_id = @id THEN w.b_id ELSE w.a_id END
JOIN sailor sl ON sl.account_id = o.id
WHERE (w.a_id = @id OR w.b_id = @id) AND w.seen_at > @since
ORDER BY w.seen_at DESC
LIMIT 50;

-- name: SetAppearOffline :execrows
UPDATE account SET appear_offline = @appear_offline WHERE id = @id AND kind = 'human';

-- name: DeleteSailedBefore :execrows
DELETE FROM sailed_with WHERE seen_at < @before;

-- name: DeleteOffersBefore :execrows
DELETE FROM shipmate_offer WHERE made_at < @before;
