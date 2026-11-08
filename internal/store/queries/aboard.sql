-- SPDX-License-Identifier: AGPL-3.0-only
-- Sailing together: a player's month of birth and the Rules of the sea, a
-- skipper's links, and the owner's switches.
;

-- name: SailLinkByHash :one
-- A link and its skipper, by its token's hash.
SELECT l.skipper_id, l.made_at, l.expires_at, (l.ended_at IS NOT NULL)::boolean AS ended, a.kind, sl.name, sl.look,
  coalesce(sl.version, '')::text AS version, coalesce(sl.skin, '')::text AS skin, coalesce(sl.hair, '')::text AS hair,
  coalesce(sl.colour, '')::text AS colour, coalesce(sl.finish, '')::text AS finish, sl.look_chosen
FROM sail_link l
JOIN account a ON a.id = l.skipper_id
JOIN sailor sl ON sl.account_id = a.id
WHERE l.hash = @hash;

-- name: KnockerOf :one
-- An account as a knock shows it, and what it may do.
SELECT a.kind, coalesce(a.born, 0)::integer AS born, (a.rules_at IS NOT NULL)::boolean AS rules, sl.name, sl.look,
  coalesce(sl.version, '')::text AS version, coalesce(sl.skin, '')::text AS skin, coalesce(sl.hair, '')::text AS hair,
  coalesce(sl.colour, '')::text AS colour, coalesce(sl.finish, '')::text AS finish, sl.look_chosen
FROM account a
JOIN sailor sl ON sl.account_id = a.id
WHERE a.id = @id;

-- name: EndLiveSailLink :execrows
-- The skipper's live link ended.
UPDATE sail_link SET ended_at = now() WHERE skipper_id = @skipper_id AND ended_at IS NULL;

-- name: InsertSailLink :execrows
-- A link made for a human skipper.
INSERT INTO sail_link (skipper_id, hash, made_at, expires_at)
SELECT a.id, @hash, @made_at, @expires_at FROM account a WHERE a.id = @skipper_id AND a.kind = 'human';

-- name: EndAllSailLinks :execrows
UPDATE sail_link SET ended_at = now() WHERE ended_at IS NULL;

-- name: LiveSailLink :one
-- The skipper's link not ended, if it has one: it may have expired.
SELECT made_at, expires_at FROM sail_link WHERE skipper_id = @skipper_id AND ended_at IS NULL;

-- name: CountLiveSailLinks :one
-- The links that work now, under the lifetime given.
SELECT count(*) FROM sail_link
WHERE ended_at IS NULL AND expires_at > now() AND made_at + sqlc.arg(micros)::bigint * interval '1 microsecond' > now();

-- name: SailLinksEndedBy :one
-- How many links that work under the lifetime now a new one would stop.
SELECT count(*) FROM sail_link
WHERE ended_at IS NULL AND expires_at > now()
  AND made_at + sqlc.arg(now_micros)::bigint * interval '1 microsecond' > now()
  AND made_at + sqlc.arg(micros)::bigint * interval '1 microsecond' <= now();

-- name: DeleteStoppedSailLinks :execrows
-- The links that stopped working before the time given: ended, expired,
-- or past the lifetime given.
DELETE FROM sail_link WHERE id IN (
  SELECT l.id FROM sail_link l
  WHERE least(l.ended_at, l.expires_at) < sqlc.arg(before)::timestamptz
    OR l.made_at + sqlc.arg(micros)::bigint * interval '1 microsecond' < sqlc.arg(before)::timestamptz
  LIMIT @lim
);

-- name: SetBorn :execrows
-- A human's month of birth, once.
UPDATE account SET born = @born WHERE id = @id AND kind = 'human' AND born IS NULL;

-- name: AccountBorn :one
SELECT kind, (born IS NOT NULL)::boolean AS answered FROM account WHERE id = @id;

-- name: AcceptRules :execrows
-- The Rules of the sea accepted, when first.
UPDATE account SET rules_at = coalesce(rules_at, now()) WHERE id = @id AND kind = 'human';

-- name: SailSettings :one
SELECT (extract(epoch FROM link_lifetime) * 1000000)::bigint AS micros, links, boarding FROM setting;

-- name: SetLinkLifetime :execrows
UPDATE setting SET link_lifetime = sqlc.arg(micros)::bigint * interval '1 microsecond';

-- name: SetLinks :execrows
UPDATE setting SET links = @links;

-- name: SetBoarding :execrows
UPDATE setting SET boarding = @boarding;
