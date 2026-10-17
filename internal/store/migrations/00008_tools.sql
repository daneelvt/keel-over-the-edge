-- SPDX-License-Identifier: AGPL-3.0-only
-- The owner's flag: an account whose sailor has the owner's tools in the
-- game, the free camera. Only a human account carries it.

-- +goose Up

-- A column with a constant default is added without rewriting the table
-- (PostgreSQL 11 on): the default is kept in the catalog and read for the
-- rows already there. The check is added not valid, then validated, so the
-- table is scanned under a lock that lets reads and writes go on.
ALTER TABLE account ADD COLUMN tools boolean NOT NULL DEFAULT false;
ALTER TABLE account ADD CONSTRAINT account_tools_human CHECK (NOT tools OR kind = 'human') NOT VALID;
ALTER TABLE account VALIDATE CONSTRAINT account_tools_human;
