-- SPDX-License-Identifier: AGPL-3.0-only
-- Passkeys and the ceremonies that make and use them.
;

-- name: CreatePasskey :exec
INSERT INTO passkey (account_id, credential_id, public_key, algorithm, sign_count, flags, backup_eligible, backup_state,
  aaguid, transports, attestation_format, attachment, made_on)
VALUES (@account_id, @credential_id, @public_key, @algorithm, @sign_count, @flags, @backup_eligible, @backup_state,
  @aaguid, @transports, @attestation_format, @attachment, @made_on);

-- name: PasskeysOf :many
SELECT id, credential_id, public_key, algorithm, sign_count, clone_warning, flags, backup_eligible, backup_state,
  aaguid, transports, attestation_format, attachment, made_on, created_at, last_used_at
FROM passkey WHERE account_id = @account_id
ORDER BY created_at, id;

-- name: PasskeyUsed :execrows
-- What a sign-in learnt of a passkey, written back (WebAuthn Level 3,
-- 7.2, steps 25 and 26).
UPDATE passkey SET sign_count = @sign_count, clone_warning = @clone_warning, flags = @flags, backup_state = @backup_state,
  last_used_at = now()
WHERE credential_id = @credential_id AND account_id = @account_id;

-- name: CountPasskeys :one
SELECT count(*) FROM passkey WHERE account_id = @account_id;

-- name: DeletePasskey :execrows
DELETE FROM passkey WHERE id = @id AND account_id = @account_id;

-- name: InsertCeremony :exec
INSERT INTO webauthn_ceremony (handle_hash, kind, account_id, name, name_key, look, user_handle, session, build, expires_at)
VALUES (@handle_hash, @kind, @account_id, @name, @name_key, @look, @user_handle, @session, @build, @expires_at);

-- name: TakeCeremony :one
-- A ceremony finished: taken and gone, so it is used once.
DELETE FROM webauthn_ceremony WHERE handle_hash = @handle_hash AND kind = @kind
RETURNING account_id, name, name_key, look, user_handle, session, build, expires_at;
