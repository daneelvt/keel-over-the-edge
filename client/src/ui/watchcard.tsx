// SPDX-License-Identifier: AGPL-3.0-only

// The card about a sailor one may watch, opened by ⓘ on the list in the
// same panel: the boat and how many watch it; the weather at the boat;
// where it is (how far inside the lip, the nearest charted island, the
// land in sight), unless the viewer's own boat is in the water; this
// voyage's closest pass to the falls and its latest charting; Follow;
// a link to watch; and Watch, always in view at the bottom. Read again
// every 5 seconds while open. And what the list and the card share: a
// row's facts as the server sends them, the cog and the boat's kind.

import { useEffect, useState } from 'preact/hooks';
import type { Fetch } from '../account/me';
import { call, reasonOf } from '../account/passkeys';
import { reasonText } from '../account/reasons';
import { catalog } from '../catalog';
import { type PocketSky, SKY_WORDS } from '../chart/pocketsky';
import { SkyDecal } from './decals';
import { PlayerText } from './player';
import {
  agentText,
  BACK,
  chartedText,
  edgeText,
  FOLLOW,
  FOLLOWING,
  IN_SIGHT,
  islandText,
  type Lively,
  livelyLine,
  skimmedText,
  THE_WEATHER,
  THIS_VOYAGE,
  TOO_MANY,
  WHERE,
  wavesText,
  windWords,
  withheldWords,
} from './watchlistwords';
import {
  COPIED,
  COPY_WATCH_LINK,
  endedText,
  READING,
  WATCH,
  watchersText,
  watchLink,
} from './watchwords';

/** Why a sailor followed or shown cannot be watched now, by kind: a machine sailor out of the water, or anyone else. */
export type Gone = 'not-at-sea' | 'cannot';

/** A boat one may watch, as GET /api/watch lists it. */
export interface WatchRow {
  name: string;
  /** A machine sailor's; one of the account's own. */
  machine: boolean;
  mine: boolean;
  /** Its kind, by the catalog's boat id. */
  kind: string;
  watchers: number;
  /** The sky at the boat, as the pocket chart's weather pusher shows it, and whether it is night there. */
  sky: PocketSky;
  night: boolean;
  /** The true wind at the boat, Beaufort; its speed, knots. */
  force: number;
  knots: number;
  state: 'sailing' | 'capsized' | 'righting';
  followed?: boolean;
  /** How far inside the lip, NM; left out while the viewer's own boat is in the water. */
  edgeNM?: number;
  /** Why it ranks high, in order. */
  lively?: Lively[];
  /** A followed sailor that cannot be watched now; or, on the phone, a row whose sailor has gone since it was read. */
  gone?: Gone;
}

/** GET /api/watch/sailor: the row and what the card adds. */
export interface CardFacts extends WatchRow {
  weather?: {
    /** Where the wind comes from, degrees. */
    windFrom: number;
    /** The waves, m. */
    waves: number;
    barometer: string;
    visibility: string;
    rain?: string;
    clouds?: string;
  };
  where?: {
    edgeNM?: number;
    island?: { name: string; bearing: number; nm: number };
    inSight?: string[];
  };
  voyage?: {
    skimmedM?: number;
    charted?: { subject?: string; minutes: number };
  };
  /** The viewer's own machine sailor's: whether its AI app is connected. */
  agent?: boolean;
}

/** The card's answer: its facts, gone by kind, or null if it cannot be read. */
export type CardAnswer = { card: CardFacts } | { gone: Gone } | null;

/** Following's answer: done, too many followed, gone by kind, or another reason's code. */
export type FollowAnswer = 'ok' | 'too-many' | Gone | (string & {});

export const browserFetch: Fetch = (input, init) => fetch(input, init);

/** A 404's kind: a machine sailor not in the water, or anyone else. */
function goneOf(body: unknown): Gone {
  return (body as { error?: unknown } | null)?.error === 'not-at-sea' ? 'not-at-sea' : 'cannot';
}

/** The card about a sailor. */
export async function readCard(name: string, f: Fetch = browserFetch): Promise<CardAnswer> {
  try {
    const res = await f(`/api/watch/sailor?${new URLSearchParams({ name })}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (res.status === 404) {
      return { gone: goneOf(await res.json().catch(() => null)) };
    }
    if (res.status !== 200) {
      return null;
    }
    const card = (await res.json()) as CardFacts;
    return typeof card?.name === 'string' ? { card } : null;
  } catch {
    return null;
  }
}

/** Follows a sailor, or stops following them. */
export async function postFollow(
  name: string,
  on: boolean,
  f: Fetch = browserFetch,
): Promise<FollowAnswer> {
  const a = await call(f, '/api/watch/follow', { name, on });
  if (a.status === 200) {
    return 'ok';
  }
  if (a.status === 404) {
    return goneOf(a.body);
  }
  return reasonOf(a);
}

/** A failure to follow in words. */
export function followProblem(a: FollowAnswer, sailor: string): string {
  if (a === 'ok') {
    return '';
  }
  if (a === 'too-many') {
    return TOO_MANY;
  }
  if (a === 'not-at-sea' || a === 'cannot') {
    return endedText(a as Gone, sailor);
  }
  return reasonText(a);
}

/** A boat's kind in words, by the catalog's id; the id itself for one the catalog lacks. */
export function kindName(id: string): string {
  return catalog.boats.find((b) => b.id === id)?.name ?? id;
}

/** The cog a machine sailor's name carries. */
export function Cog() {
  return (
    <span class="watch-cog" role="img" aria-label="machine sailor" title="machine sailor">
      ⚙
    </span>
  );
}

/** The small gold star of a sailor followed. */
export function Star() {
  return (
    <span class="watch-star" role="img" aria-label="followed" title="followed">
      ★
    </span>
  );
}

/** The sky at a boat: the weather pusher's decal, named in words for a screen reader. */
export function Sky({ sky, night }: { sky: PocketSky; night: boolean }) {
  const words = SKY_WORDS[sky] ?? '';
  return (
    <span
      class="watch-sky"
      role="img"
      aria-label={night && sky === 'fair' ? `${words}, by night` : words}
    >
      <SkyDecal sky={sky} night={night} />
    </span>
  );
}

/** Copies the address that opens the game watching a sailor. */
export function CopyWatchLink({ sailor }: { sailor: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      class="watch-link"
      onClick={() =>
        void navigator.clipboard.writeText(watchLink(location.origin, sailor)).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      {copied ? COPIED : COPY_WATCH_LINK}
    </button>
  );
}

/** Three words around an emphasised middle, the sailor's name or the words searched for. */
export function Around({ words }: { words: [string, string, string] }) {
  return (
    <>
      {words[0]}
      <em>
        <PlayerText text={words[1]} />
      </em>
      {words[2]}
    </>
  );
}

/** One line of a section, left out when empty. */
function Line({ text }: { text: string }) {
  return text === '' ? null : <p>{text}</p>;
}

/** The weather at the boat. */
function Weather({ c }: { c: CardFacts }) {
  const w = c.weather;
  return (
    <section class="watch-card-part" aria-label={THE_WEATHER}>
      <h3>{THE_WEATHER}</h3>
      <p class="watch-card-sky">
        <Sky sky={c.sky} night={c.night} />
        {SKY_WORDS[c.sky] ?? ''} · {windWords(c.force, w?.windFrom ?? 0)}
      </p>
      {w !== undefined ? (
        <>
          <Line text={[wavesText(w.waves), w.barometer].filter((t) => t !== '').join(' · ')} />
          <Line
            text={[w.visibility, w.rain ?? '', w.clouds ?? ''].filter((t) => t !== '').join(' · ')}
          />
        </>
      ) : null}
    </section>
  );
}

/** Where the boat is, or why that is not shown. */
function Where({ c, withheld }: { c: CardFacts; withheld: boolean }) {
  const w = c.where;
  if (w === undefined && !withheld) {
    return null;
  }
  return (
    <section class="watch-card-part" aria-label={WHERE}>
      <h3>{WHERE}</h3>
      {w === undefined ? (
        <p data-readout="withheld">
          <Around words={withheldWords(c.name)} />
        </p>
      ) : (
        <>
          {typeof w.edgeNM === 'number' ? <p>{edgeText(w.edgeNM)}</p> : null}
          {w.island !== undefined ? <p>{islandText(w.island)}</p> : null}
          {(w.inSight ?? []).length > 0 ? (
            <>
              <p class="watch-faint">{IN_SIGHT}</p>
              <ul class="watch-sight">
                {(w.inSight ?? []).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

/** This voyage's closest pass to the falls and its latest charting; nothing when it has neither. */
function Voyage({ c }: { c: CardFacts }) {
  const v = c.voyage;
  if (v === undefined || (v.skimmedM === undefined && v.charted === undefined)) {
    return null;
  }
  return (
    <section class="watch-card-part" aria-label={THIS_VOYAGE}>
      <h3>{THIS_VOYAGE}</h3>
      {typeof v.skimmedM === 'number' ? <p>{skimmedText(v.skimmedM)}</p> : null}
      {v.charted !== undefined ? (
        <p>{chartedText(v.charted.subject, v.charted.minutes, true)}</p>
      ) : null}
    </section>
  );
}

/**
 * The card as drawn: c is the last read, or the row until the card is
 * read (read false); gone greys it and takes Watch away; withheld says
 * where is kept from a player whose own boat is in the water.
 */
export function SailorCard({
  c,
  read,
  gone,
  withheld,
  problem,
  back,
  follow,
  watch,
}: {
  c: CardFacts;
  read: boolean;
  gone: Gone | null;
  withheld: boolean;
  problem: string;
  back: () => void;
  follow: (on: boolean) => void;
  watch: () => void;
}) {
  const followed = c.followed === true;
  const lively = gone === null ? livelyLine(c.lively) : '';
  return (
    <div class={`watch-card${gone !== null ? ' gone' : ''}`} data-sailor={c.name}>
      <div class="watch-card-top">
        <button type="button" class="watch-back" aria-label="Back" onClick={back}>
          {BACK}
        </button>
        {gone === null || followed ? (
          <button
            type="button"
            class="watch-follow"
            aria-pressed={followed}
            onClick={() => follow(!followed)}
          >
            {followed ? FOLLOWING : FOLLOW}
          </button>
        ) : null}
      </div>
      <h2 class="watch-card-name" id="watch-list-title">
        <PlayerText text={c.name} />
        {c.machine ? <Cog /> : null}
        <span class="watch-faint">{c.kind === '' ? '' : ` · ${kindName(c.kind)}`}</span>
      </h2>
      {problem !== '' ? (
        <p class="watch-problem" role="status">
          {problem}
        </p>
      ) : null}
      {gone !== null ? (
        <p class="watch-problem" role="status">
          {endedText(gone, c.name)}
        </p>
      ) : null}
      <div class="watch-card-body">
        {c.watchers > 0 ? <p class="watch-faint">{watchersText(c.watchers)}</p> : null}
        {c.mine && c.machine && typeof c.agent === 'boolean' ? (
          <p class="watch-faint" data-readout="agent">
            {agentText(c.agent)}
          </p>
        ) : null}
        {lively !== '' ? <p class="watch-lively">{lively}</p> : null}
        {read ? (
          <>
            <Weather c={c} />
            <Where c={c} withheld={withheld} />
            <Voyage c={c} />
          </>
        ) : (
          <p class="watch-faint" aria-live="polite">
            {READING}
          </p>
        )}
      </div>
      {gone === null ? (
        <div class="watch-card-foot">
          <CopyWatchLink sailor={c.name} />
          <button type="button" class="watch-go" onClick={watch}>
            {WATCH}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** How often the card is read again while it is open, ms. */
const AGAIN = 5_000;

/**
 * The card, read now and every 5 seconds while the page is in view.
 * first is the sailor's row, drawn until the card is read; followed is
 * told when Follow succeeds, so the list can show it.
 */
export function WatchCard({
  first,
  withheld,
  back,
  watch,
  followed,
  read = readCard,
  follow = postFollow,
}: {
  first: WatchRow;
  withheld: boolean;
  back: () => void;
  watch: () => void;
  followed: (name: string, on: boolean) => void;
  read?: (name: string) => Promise<CardAnswer>;
  follow?: (name: string, on: boolean) => Promise<FollowAnswer>;
}) {
  const name = first.name;
  const [c, setC] = useState<CardFacts>(first);
  const [isRead, setRead] = useState(false);
  const [gone, setGone] = useState<Gone | null>(first.gone ?? null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let live = true;
    const once = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      void read(name).then((a) => {
        if (!live || a === null) {
          return;
        }
        if ('gone' in a) {
          setGone(a.gone);
          return;
        }
        setGone(null);
        setC(a.card);
        setRead(true);
      });
    };
    once();
    const t = setInterval(once, AGAIN);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [name]);
  const toggle = async (on: boolean) => {
    setProblem('');
    const a = await follow(name, on);
    if (a !== 'ok') {
      setProblem(followProblem(a, name));
      return;
    }
    setC((was) => ({ ...was, followed: on }));
    followed(name, on);
  };
  return (
    <SailorCard
      c={c}
      read={isRead}
      gone={gone}
      withheld={withheld}
      problem={problem}
      back={back}
      follow={(on) => void toggle(on)}
      watch={watch}
    />
  );
}
