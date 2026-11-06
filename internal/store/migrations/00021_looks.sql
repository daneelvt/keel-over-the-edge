-- SPDX-License-Identifier: AGPL-3.0-only
-- Sailors' looks, chosen: a person's look is a look of the catalog's with
-- its version and three options, a skin, a hair colour and a main colour;
-- a machine sailor's keeps its version, finish and main colour, its colour
-- now one of the people's main colours. look_chosen is whether the sailor
-- chose it: every sailor made before looks were chosen had the one
-- stand-in, and is asked once at its next entry, starting from a look the
-- game draws for it.
--
-- A person's options are all set or, for one made before, all unset; the
-- game draws its look then, the same each time, until it is chosen.

-- +goose Up

ALTER TABLE sailor
  ADD COLUMN skin text,
  ADD COLUMN hair text,
  ADD COLUMN look_chosen boolean NOT NULL DEFAULT false;
UPDATE sailor SET look_chosen = true WHERE look = 'machine';

-- A machine sailor's colour, the nearest of the people's main colours.
UPDATE sailor SET colour = CASE colour
    WHEN 'deep-red' THEN 'madder-red'
    WHEN 'navy' THEN 'indigo-navy'
    WHEN 'ochre' THEN 'weld-yellow'
    WHEN 'plum' THEN 'madder-red'
    WHEN 'rust' THEN 'madder-orange'
    ELSE colour END
  WHERE look = 'machine';

ALTER TABLE sailor DROP CONSTRAINT sailor_machine_look;
ALTER TABLE sailor ADD CONSTRAINT sailor_look CHECK (
  CASE WHEN look = 'machine'
    THEN version IS NOT NULL AND finish IS NOT NULL AND colour IS NOT NULL AND skin IS NULL AND hair IS NULL
    ELSE finish IS NULL AND (
      (version IS NOT NULL AND skin IS NOT NULL AND hair IS NOT NULL AND colour IS NOT NULL) OR
      (version IS NULL AND skin IS NULL AND hair IS NULL AND colour IS NULL))
  END) NOT VALID;
ALTER TABLE sailor VALIDATE CONSTRAINT sailor_look;
ALTER TABLE sailor ADD CONSTRAINT sailor_look_size CHECK (
  octet_length(look) <= 80 AND octet_length(version) <= 80 AND octet_length(skin) <= 80 AND
  octet_length(hair) <= 80 AND octet_length(colour) <= 80 AND octet_length(finish) <= 80) NOT VALID;
ALTER TABLE sailor VALIDATE CONSTRAINT sailor_look_size;

-- A new sailor's look, kept while its passkey is made: its version and
-- options beside the look.
ALTER TABLE webauthn_ceremony
  ADD COLUMN version text,
  ADD COLUMN skin text,
  ADD COLUMN hair text,
  ADD COLUMN colour text;
