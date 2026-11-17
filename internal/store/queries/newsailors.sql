-- SPDX-License-Identifier: AGPL-3.0-only
-- New sailors from each address, and the owner's settings for them.
;

-- name: AddNewSailorFrom :exec
INSERT INTO new_sailor_from (key) VALUES (@key);

-- name: NewSailorsFrom :one
-- How many sailors were made from the address's key since a time, and the
-- oldest of them.
SELECT count(*)::bigint AS made, coalesce(min(made_at), now())::timestamptz AS oldest
FROM new_sailor_from WHERE key = @key AND made_at > @since;

-- name: DeleteNewSailorsFrom :execrows
DELETE FROM new_sailor_from WHERE ctid IN (
  SELECT f.ctid FROM new_sailor_from f WHERE f.made_at <= @before ORDER BY f.made_at LIMIT @lim
);

-- name: NewSailorSettings :one
SELECT new_sailors_per_address, human_check FROM setting;

-- name: SetNewSailorsPerAddress :execrows
UPDATE setting SET new_sailors_per_address = @new_sailors_per_address;

-- name: SetHumanCheck :execrows
UPDATE setting SET human_check = @human_check;
