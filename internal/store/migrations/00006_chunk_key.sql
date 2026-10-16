-- SPDX-License-Identifier: AGPL-3.0-only
-- A world's chunk key: 32 random bytes of its own, from which the addresses
-- its chunks are served at are signed (an HMAC of the world and the chunk),
-- so that a chunk can be fetched only by whoever was handed its address.
-- Made with the bundle; a world whose bundle was stored before it gets one
-- at its next start. Never logged and never sent.

-- +goose Up

ALTER TABLE world_bundle
  ADD COLUMN chunk_key bytea CHECK (chunk_key IS NULL OR length(chunk_key) = 32);
