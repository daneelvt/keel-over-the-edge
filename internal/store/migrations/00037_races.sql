-- SPDX-License-Identifier: AGPL-3.0-only
-- Races: made by sailors, and by the world itself off Port Royal (the
-- harbour races, whose owner is the Harbourmaster, none of the accounts),
-- each for one kind of boat on one of the world's courses, joined by its
-- link's code. A race and what is entered, sailed and kept of it belong to
-- its world and go with its partitions; what a sailor won is kept for good
-- in race_record, a row of the sailor's own.

-- +goose Up

-- The racing limits and the harbour races' timetable, for the whole game:
-- the most races a sailor may be entered in that have not started
-- (race_ahead), start in a day (race_daily), make in a day (race_made) and
-- own not yet finished (race_owned); how long before a world's end no race
-- may start (race_cutoff); the harbour races every harbour_every hours on
-- the hour in the world's schedule's zone, their boats in turn
-- (harbour_boats, the catalog's ids), and the share of the week's
-- newcomers' harbour races at the hours that suit the US (greenhorn_us, a
-- percentage).
ALTER TABLE setting
  ADD COLUMN race_ahead    smallint NOT NULL DEFAULT 2 CONSTRAINT setting_race_ahead CHECK (race_ahead BETWEEN 1 AND 20),
  ADD COLUMN race_daily    smallint NOT NULL DEFAULT 8 CONSTRAINT setting_race_daily CHECK (race_daily BETWEEN 1 AND 100),
  ADD COLUMN race_made     smallint NOT NULL DEFAULT 8 CONSTRAINT setting_race_made CHECK (race_made BETWEEN 1 AND 100),
  ADD COLUMN race_owned    smallint NOT NULL DEFAULT 3 CONSTRAINT setting_race_owned CHECK (race_owned BETWEEN 1 AND 20),
  ADD COLUMN race_cutoff   interval NOT NULL DEFAULT '3 hours'
    CONSTRAINT setting_race_cutoff CHECK (race_cutoff BETWEEN interval '0' AND interval '24 hours'),
  ADD COLUMN harbour_every smallint NOT NULL DEFAULT 3 CONSTRAINT setting_harbour_every CHECK (harbour_every IN (1, 2, 3, 4, 6, 8, 12)),
  ADD COLUMN harbour_boats text[] NOT NULL
    DEFAULT '{jolly-boat,jolly-boat,skiff,jolly-boat,keelboat,jolly-boat,jolly-boat,jolly-boat}'
    CONSTRAINT setting_harbour_boats CHECK (cardinality(harbour_boats) BETWEEN 1 AND 24),
  ADD COLUMN greenhorn_us  smallint NOT NULL DEFAULT 50 CONSTRAINT setting_greenhorn_us CHECK (greenhorn_us BETWEEN 0 AND 100);

-- A race, or a time trial (a race of one, sailed alone as often as anyone
-- likes while it is open), by its link's code: its owner (none for a
-- harbour race); its course, an island course by its number in the world
-- or a buoy course laid in a racing area (course its number, 0 for a
-- trial's, laid in an area at each run) to a shape, short or long; its
-- boat, the catalog's id; who may enter; its name; when it starts (a
-- trial: when it opened) and whether its owner has moved that once; its
-- state, open, closed to entry, cancelled, racing or finished (a race
-- open or closed past its start is starting, waiting for its committee);
-- a harbour race's hour of the day in the schedule's zone; the race it is
-- a race again of.
CREATE TABLE race (
  world_id    uuid NOT NULL REFERENCES world (id),
  id          uuid NOT NULL DEFAULT uuidv7(),
  code        text NOT NULL DEFAULT link_code() CHECK (code ~ '^[a-z2-7]{10}$'),
  owner_id    uuid,
  kind        text NOT NULL CHECK (kind IN ('race', 'trial')),
  course_kind text NOT NULL CHECK (course_kind IN ('buoy', 'island')),
  course      integer NOT NULL CHECK (course >= 0),
  shape       text CHECK (shape IN ('windward-leeward', 'triangle')),
  long        boolean NOT NULL DEFAULT false,
  boat        text NOT NULL CHECK (octet_length(boat) BETWEEN 1 AND 40),
  who         text NOT NULL CHECK (who IN ('everyone', 'humans', 'machines', 'newcomers')),
  name        text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 200),
  starts_at   timestamptz NOT NULL,
  moved       boolean NOT NULL DEFAULT false,
  state       text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed', 'cancelled', 'racing', 'finished')),
  harbour     smallint CHECK (harbour BETWEEN 0 AND 23),
  again_of    uuid,
  made_at     timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  PRIMARY KEY (world_id, id),
  CONSTRAINT race_shape CHECK ((course_kind = 'buoy') = (shape IS NOT NULL)),
  CONSTRAINT race_harbour CHECK (harbour IS NULL OR owner_id IS NULL)
) PARTITION BY LIST (world_id);
CREATE UNIQUE INDEX race_code ON race (world_id, code);
CREATE INDEX race_code_any ON race (code);
CREATE UNIQUE INDEX race_harbour_once ON race (world_id, starts_at) WHERE harbour IS NOT NULL;
CREATE INDEX race_owner ON race (world_id, owner_id, made_at) WHERE owner_id IS NOT NULL;
CREATE INDEX race_starts ON race (world_id, starts_at);

-- An entry: a skipper's (account_id) boat in a race, by its race number,
-- and whether those aboard come with it; entered, and withdrawn or removed
-- by the race's owner (an entry withdrawn may be entered again); started,
-- set as the boat is placed on the line. A trial's runs are entries of one
-- skipper numbered by run; a race's entry is run 0.
CREATE TABLE race_entry (
  world_id     uuid NOT NULL REFERENCES world (id),
  race_id      uuid NOT NULL,
  account_id   uuid NOT NULL,
  run          smallint NOT NULL DEFAULT 0 CHECK (run >= 0),
  number       smallint NOT NULL CHECK (number > 0),
  machine      boolean NOT NULL DEFAULT false,
  with_crew    boolean NOT NULL DEFAULT false,
  entered_at   timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  removed      boolean NOT NULL DEFAULT false,
  started_at   timestamptz,
  PRIMARY KEY (world_id, race_id, account_id, run),
  FOREIGN KEY (world_id, race_id) REFERENCES race (world_id, id)
) PARTITION BY LIST (world_id);
CREATE INDEX race_entry_account ON race_entry (world_id, account_id);

-- What a boat came to in a race: its place; its time from the start, s;
-- the seconds added for fouls and starting early; how far it got (marks
-- rounded, and then the way's metres to the finish); how it ended
-- (finished, placed by progress, did not start, retired, removed); its
-- awards; and those aboard, as they were, copies.
CREATE TABLE race_result (
  world_id   uuid NOT NULL REFERENCES world (id),
  race_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  run        smallint NOT NULL DEFAULT 0 CHECK (run >= 0),
  place      smallint CHECK (place > 0),
  elapsed    real CHECK (elapsed >= 0),
  added      real NOT NULL DEFAULT 0 CHECK (added >= 0),
  marks      smallint NOT NULL DEFAULT 0 CHECK (marks >= 0),
  to_go      real CHECK (to_go >= 0),
  how        text NOT NULL CHECK (how IN ('finished', 'placed', 'dns', 'ret', 'removed')),
  medal      text CHECK (medal IN ('bronze', 'silver', 'gold', 'harbourmaster')),
  awards     text[] NOT NULL DEFAULT '{}',
  crew       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(crew) = 'array'),
  PRIMARY KEY (world_id, race_id, account_id, run),
  FOREIGN KEY (world_id, race_id) REFERENCES race (world_id, id)
) PARTITION BY LIST (world_id);

-- A boat's track in a race: its samples, coded.
CREATE TABLE race_track (
  world_id   uuid NOT NULL REFERENCES world (id),
  race_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  run        smallint NOT NULL DEFAULT 0 CHECK (run >= 0),
  samples    bytea NOT NULL,
  PRIMARY KEY (world_id, race_id, account_id, run),
  FOREIGN KEY (world_id, race_id) REFERENCES race (world_id, id)
) PARTITION BY LIST (world_id);

-- Each day of a world, its newcomers' harbour race's hour in the
-- schedule's zone: set once from the world's seed as it begins, kept with
-- the world so the week is known ahead and the same after a restart.
CREATE TABLE harbour_day (
  world_id uuid NOT NULL REFERENCES world (id),
  day      date NOT NULL,
  hour     smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  PRIMARY KEY (world_id, day)
) PARTITION BY LIST (world_id);

SELECT create_world_partitions(id) FROM world;

-- A race in a sailor's record, kept for good, with no key to the world:
-- the race as it was (its world's number, code, name, kind, course and
-- boat, how many boats raced, whether a harbour race or for newcomers),
-- the sailor's part in it (skipper, crew aboard another's boat, or its
-- owner, who ran it), the place of how many, how it ended, the medal and
-- the awards; a crew's skipper, copies. source makes a row once.
CREATE TABLE race_record (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id      uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (octet_length(source) BETWEEN 1 AND 200),
  world           integer NOT NULL CHECK (world > 0),
  at              timestamptz NOT NULL,
  code            text NOT NULL,
  race_name       text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('race', 'trial')),
  course_name     text NOT NULL,
  boat            text NOT NULL,
  boat_name       text,
  fleet           smallint NOT NULL DEFAULT 0 CHECK (fleet >= 0),
  harbour         boolean NOT NULL DEFAULT false,
  newcomers       boolean NOT NULL DEFAULT false,
  role            text NOT NULL CHECK (role IN ('skipper', 'crew', 'owner')),
  place           smallint CHECK (place > 0),
  how             text CHECK (how IN ('finished', 'placed', 'dns', 'ret', 'removed')),
  medal           text CHECK (medal IN ('bronze', 'silver', 'gold', 'harbourmaster')),
  awards          text[] NOT NULL DEFAULT '{}',
  skipper_id      uuid,
  skipper_name    text,
  skipper_machine boolean NOT NULL DEFAULT false,
  CONSTRAINT race_record_source UNIQUE (account_id, source)
);
CREATE INDEX race_record_at ON race_record (account_id, world, at);

-- The news's stories of races: a race won, and a time trial's gold, about
-- the race (subject 'race', number unused).
ALTER TABLE news_item DROP CONSTRAINT news_item_story;
ALTER TABLE news_item ADD CONSTRAINT news_item_story CHECK (
  story IN ('great', 'record', 'life', 'crew', 'first', 'run', 'milestone', 'charting', 'arrival', 'review', 'edition',
            'course', 'race', 'trial')) NOT VALID;
ALTER TABLE news_item VALIDATE CONSTRAINT news_item_story;
ALTER TABLE news_item DROP CONSTRAINT news_item_subject_check;
ALTER TABLE news_item ADD CONSTRAINT news_item_subject_check CHECK (
  subject IN ('island', 'place', 'feature', 'world', 'gale', 'sailor', 'course', 'race')) NOT VALID;
ALTER TABLE news_item VALIDATE CONSTRAINT news_item_subject_check;

-- The record's new action: the racing limits or the harbour timetable set.
ALTER TABLE account_action DROP CONSTRAINT account_action_action_check;
ALTER TABLE account_action ADD CONSTRAINT account_action_action_check CHECK (
  action IN ('stop', 'start', 'revoke', 'delete', 'flag', 'unflag', 'priority', 'unpriority', 'cap', 'lifetime',
             'link-lifetime', 'links', 'boarding', 'young',
             'chat', 'shipmate-messages', 'chat-countries', 'spectator-chat',
             'dismiss', 'warn', 'mute-chat', 'remove-line', 'purge', 'hold', 'release', 'under-13', 'referred',
             'rest', 'strike', 'unstrike', 'racing')) NOT VALID;
ALTER TABLE account_action VALIDATE CONSTRAINT account_action_action_check;
ALTER TABLE account_action DROP CONSTRAINT account_action_account;
ALTER TABLE account_action ADD CONSTRAINT account_action_account CHECK (
  CASE WHEN action IN ('lifetime', 'link-lifetime', 'links', 'boarding', 'chat', 'shipmate-messages', 'chat-countries',
                       'spectator-chat', 'racing')
         THEN account_id IS NULL
       WHEN action IN ('dismiss', 'remove-line', 'purge', 'hold', 'release', 'referred', 'strike', 'unstrike') THEN true
       ELSE account_id IS NOT NULL END) NOT VALID;
ALTER TABLE account_action VALIDATE CONSTRAINT account_action_account;
