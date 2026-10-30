// SPDX-License-Identifier: AGPL-3.0-only

// Watching another sailor's boat, the screens' parts of it: the list of
// sailors one may watch now, and the card about one (watchcard.tsx); the
// question before the own boat leaves the water to watch; the bar over a
// boat watched, "Watching Iron Mary ⚙" with Watch another and Sail, which
// says instead why a watch ended or the place in the spectators' queue;
// the button that brings the camera back behind the boat; and the switch
// that lets others watch the voyage under way.
//
// The list is in an order chosen above it (the liveliest first, unless
// the player picks another), shows everyone or some, and is narrowed by
// part of a name. Each row is the sky at the boat, the sailor, the boat
// and its facts, and why it ranks high. While it is open its rows' facts
// are read again every 10 seconds by name and changed in place, never
// reordered under the player's thumb: a row whose sailor can no longer be
// watched is greyed. Look again reads it in order.
//
// Loaded only when first needed (watchlazy.ts): none of it is in the
// game's first download.

import './watch.css';
import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Fetch, Me } from '../account/me';
import { call, reasonOf } from '../account/passkeys';
import { reasonText } from '../account/reasons';
import { PlayerText } from './player';
import { queueLines } from './queue';
import { loadSettings, saveWatchChoice, type WatchSort, type WatchWho } from './settings';
import {
  Around,
  browserFetch,
  type CardAnswer,
  Cog,
  type FollowAnswer,
  kindName,
  postFollow,
  readCard,
  Sky,
  Star,
  WatchCard,
  type WatchRow,
} from './watchcard';
import { sailsOwn, type WatchView } from './watchlazy';
import {
  ABOUT,
  aboutName,
  boatsAtSeaText,
  FOLLOWING_NONE,
  factsText,
  LET_WATCH_VOYAGE,
  livelyLine,
  lookAgainText,
  NONE_AT_SEA,
  noMatchWords,
  ORDER,
  PICK_ONE,
  SHOW,
  SORTS,
  UNFOLLOW,
  unfollowName,
  WHO_CAN_BE_WATCHED,
  WHOS,
} from './watchlistwords';
import {
  BEHIND_THE_BOAT,
  CLOSE,
  endedText,
  LEAVE,
  LEAVE_DETAIL,
  LEAVE_QUESTION,
  MORE,
  READING,
  SAIL,
  SEARCH,
  type Spectators,
  STAY,
  spectatorQueueLine,
  UNREADABLE,
  WATCH,
  WATCH_A_SAILOR,
  WATCH_ANOTHER,
  WATCHING,
} from './watchwords';

export { Cog, CopyWatchLink, kindName, type WatchRow } from './watchcard';

/** A page of GET /api/watch: 50 boats at most, whether more follow, how many boats are in the water, and whether where is withheld. */
export interface WatchPage {
  sailors: WatchRow[];
  more: boolean;
  /** Every boat in the water, watchable or not. */
  atSea: number;
  /** The viewer's own boat is in the water: how far from the edge is left out. */
  withheld: boolean;
}

/** What the list is asked for. */
export interface WatchQuery {
  q: string;
  page: number;
  sort: WatchSort;
  who: WatchWho;
}

/** The server's side of the list and the card; a test stands in for it. */
export interface WatchServer {
  page(query: WatchQuery): Promise<WatchPage | null>;
  /** The rows of those of these sailors one may watch now, in no order. */
  names(names: readonly string[]): Promise<WatchPage | null>;
  card(name: string): Promise<CardAnswer>;
  follow(name: string, on: boolean): Promise<FollowAnswer>;
}

/** A page as the server answers it, or null if it is not one. */
function pageOf(body: unknown): WatchPage | null {
  const b = body as Partial<WatchPage> | null;
  if (b === null || !Array.isArray(b.sailors)) {
    return null;
  }
  return {
    sailors: b.sailors,
    more: b.more === true,
    atSea: typeof b.atSea === 'number' ? b.atSea : 0,
    withheld: b.withheld === true,
  };
}

async function readPage(query: URLSearchParams, f: Fetch): Promise<WatchPage | null> {
  try {
    const res = await f(`/api/watch?${query}`, { cache: 'no-store', credentials: 'same-origin' });
    return res.status === 200 ? pageOf(await res.json()) : null;
  } catch {
    return null;
  }
}

/** The most names asked for at once. */
const NAMES = 100;

/** The list and the card as the server gives them. */
export function watchServer(f: Fetch = browserFetch): WatchServer {
  return {
    page: (w) =>
      readPage(new URLSearchParams({ q: w.q, page: String(w.page), sort: w.sort, who: w.who }), f),
    async names(names) {
      const out: WatchPage = { sailors: [], more: false, atSea: 0, withheld: false };
      for (let i = 0; i < names.length; i += NAMES) {
        const p = await readPage(
          new URLSearchParams({ names: names.slice(i, i + NAMES).join(',') }),
          f,
        );
        if (p === null) {
          return null;
        }
        out.sailors.push(...p.sailors);
        out.atSea = p.atSea;
        out.withheld = p.withheld;
      }
      return out;
    },
    card: (name) => readCard(name, f),
    follow: (name, on) => postFollow(name, on, f),
  };
}

const server = watchServer();

/**
 * The rows shown, their facts as read again: each sailor read again has
 * its new row in the same place; one not read again cannot be watched
 * now, and is greyed by kind.
 */
export function refreshRows(rows: readonly WatchRow[], fresh: readonly WatchRow[]): WatchRow[] {
  const by = new Map(fresh.filter((r) => r.gone === undefined).map((r) => [r.name, r]));
  return rows.map(
    (r): WatchRow =>
      by.get(r.name) ?? { ...r, gone: r.gone ?? (r.machine ? 'not-at-sea' : 'cannot') },
  );
}

/** How many of a page's sailors one may watch are not among the rows shown. */
export function newcomers(rows: readonly WatchRow[], page: readonly WatchRow[]): number {
  const shown = new Set(rows.map((r) => r.name));
  return page.filter((r) => r.gone === undefined && !shown.has(r.name)).length;
}

/**
 * One of the three liveliest rows one may watch, at random (random gives
 * a number from 0 to 1, as Math.random); null with fewer than two.
 */
export function pickOne(rows: readonly WatchRow[], random = Math.random): string | null {
  const can = rows.filter((r) => r.gone === undefined);
  if (can.length < 2) {
    return null;
  }
  const top = [...can]
    .sort(
      (a, b) =>
        (b.lively?.length ?? 0) - (a.lively?.length ?? 0) ||
        b.watchers - a.watchers ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    .slice(0, 3);
  return top[Math.min(top.length - 1, Math.floor(random() * top.length))]?.name ?? null;
}

/** The question before the own boat leaves the water to watch. */
export function LeaveQuestion({ leave, stay }: { leave: () => void; stay: () => void }) {
  return (
    <section class="watch-question" role="alertdialog" aria-labelledby="watch-leave-title">
      <h2 id="watch-leave-title">{LEAVE_QUESTION}</h2>
      <p>{LEAVE_DETAIL}</p>
      <div class="watch-buttons">
        <button type="button" class="watch-go" onClick={leave}>
          {LEAVE}
        </button>
        <button type="button" onClick={stay}>
          {STAY}
        </button>
      </div>
    </section>
  );
}

/**
 * A row of the list: the sky at the boat, the sailor, the cog, the star of
 * one followed and the boat; its facts, faint; why it ranks high, in gold;
 * ⓘ and Watch. A row whose sailor cannot be watched now is greyed with the
 * words of a refused watch, and has neither; ★ there unfollows one
 * followed.
 */
export function ListRow({
  r,
  about,
  watch,
  unfollow,
}: {
  r: WatchRow;
  about: () => void;
  watch: () => void;
  unfollow: () => void;
}) {
  const gone = r.gone !== undefined;
  const facts = gone ? '' : factsText(r);
  const lively = gone ? '' : livelyLine(r.lively);
  return (
    <li class={`watch-row${gone ? ' gone' : ''}`} data-sailor={r.name}>
      {gone ? <span class="watch-sky" /> : <Sky sky={r.sky} night={r.night} />}
      <div class="watch-what">
        <p class="watch-who">
          <strong>
            <PlayerText text={r.name} />
          </strong>
          {r.machine ? <Cog /> : null}
          {r.followed === true && !gone ? <Star /> : null}
          {r.kind !== '' ? <span class="watch-faint"> {kindName(r.kind)}</span> : null}
        </p>
        {gone ? <p class="watch-faint">{endedText(r.gone ?? 'cannot', r.name)}</p> : null}
        {facts !== '' ? <p class="watch-faint watch-facts">{facts}</p> : null}
        {lively !== '' ? <p class="watch-lively">{lively}</p> : null}
      </div>
      <span class="watch-buttons">
        {gone ? (
          r.followed === true ? (
            <button
              type="button"
              class="watch-unfollow"
              aria-label={unfollowName(r.name)}
              title={UNFOLLOW}
              onClick={unfollow}
            >
              ★
            </button>
          ) : null
        ) : (
          <>
            <button
              type="button"
              class="watch-about"
              aria-label={aboutName(r.name)}
              onClick={about}
            >
              {ABOUT}
            </button>
            <button type="button" class="watch-go" onClick={watch}>
              {WATCH}
            </button>
          </>
        )}
      </span>
    </li>
  );
}

/** The list with no one on it: why, and how many boats are in the water. */
export function EmptyList({ q, who, atSea }: { q: string; who: WatchWho; atSea: number }) {
  if (q !== '') {
    return (
      <p class="watch-faint watch-empty">
        <Around words={noMatchWords(q)} />
      </p>
    );
  }
  if (who === 'following') {
    return <p class="watch-faint watch-empty">{FOLLOWING_NONE}</p>;
  }
  const boats = boatsAtSeaText(atSea);
  return (
    <div class="watch-empty">
      <p>{NONE_AT_SEA}</p>
      <p class="watch-faint">{WHO_CAN_BE_WATCHED}</p>
      {boats !== '' ? <p class="watch-faint">{boats}</p> : null}
    </div>
  );
}

/** The order, in a row that scrolls sideways when narrow, and whom the list shows. */
export function Choices({
  sort,
  who,
  withheld,
  setSort,
  setWho,
}: {
  sort: WatchSort;
  who: WatchWho;
  withheld: boolean;
  setSort: (s: WatchSort) => void;
  setWho: (w: WatchWho) => void;
}) {
  // Nearest the edge is not offered while where is withheld: the server
  // orders it as the liveliest then.
  const shown = withheld && sort === 'edge' ? 'liveliest' : sort;
  return (
    <div class="watch-choose">
      <fieldset class="watch-sorts" aria-label={ORDER}>
        {SORTS.filter((s) => !(withheld && s.value === 'edge')).map((s) => (
          <button
            key={s.value}
            type="button"
            aria-pressed={shown === s.value}
            onClick={() => setSort(s.value)}
          >
            {s.words}
          </button>
        ))}
      </fieldset>
      <select
        class="watch-who-pick"
        name="watch-who"
        aria-label={SHOW}
        value={who}
        onChange={(e) => {
          const v = WHOS.find((w) => w.value === e.currentTarget.value);
          if (v !== undefined) {
            setWho(v.value);
          }
        }}
      >
        {WHOS.map((w) => (
          <option key={w.value} value={w.value}>
            {w.words}
          </option>
        ))}
      </select>
    </div>
  );
}

/** How long typing rests before the list is asked for again, ms. */
const TYPED = 250;

/** How often the rows shown are read again, ms. */
const AGAIN = 10_000;

/** The list as last read: its rows, the last page read, and the page's counts. */
interface Listing {
  rows: WatchRow[];
  page: number;
  more: boolean;
  atSea: number;
  withheld: boolean;
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

/**
 * The list of sailors to watch, closed back to where it was: choose is
 * given the sailor chosen, after the question when ask says the own boat
 * would leave the water; from is given, as a test stands in for the
 * server.
 */
export function WatchList({
  choose,
  ask,
  close,
  from = server,
  className = 'panel watch-list',
}: {
  choose: (sailor: string) => void;
  ask: () => boolean;
  close: () => void;
  from?: WatchServer;
  className?: string;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<WatchSort>(() => loadSettings().watchSort);
  const [who, setWho] = useState<WatchWho>(() => loadSettings().watchWho);
  const [list, setList] = useState<Listing | null>(null);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [card, setCard] = useState<WatchRow | null>(null);
  const [newer, setNewer] = useState(0);
  const [looks, setLooks] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolled = useRef(0);
  // What the timer reads: the list as now shown, and which reading it is.
  const now = useRef<{ list: Listing | null; card: boolean; query: WatchQuery; gen: number }>({
    list: null,
    card: false,
    query: { q, page: 0, sort, who },
    gen: 0,
  });
  now.current.list = list;
  now.current.card = card !== null;

  useEffect(() => {
    let live = true;
    const query: WatchQuery = { q, page: 0, sort, who };
    const gen = now.current.gen + 1;
    now.current.query = query;
    now.current.gen = gen;
    const t = setTimeout(
      () => {
        void from.page(query).then((p) => {
          if (!live) {
            return;
          }
          setFailed(p === null);
          setList(
            p === null
              ? { rows: [], page: 0, more: false, atSea: 0, withheld: false }
              : { rows: p.sailors, page: 0, more: p.more, atSea: p.atSea, withheld: p.withheld },
          );
          setNewer(0);
          scrolled.current = 0;
          if (scroller.current !== null) {
            scroller.current.scrollTop = 0;
          }
        });
      },
      q === '' ? 0 : TYPED,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, sort, who, looks]);

  // Every 10 seconds while the list is in view: the rows shown read
  // again by name, in place; with none shown, the first page again, so
  // that a sailor appears without a tap; and how many more the first
  // page now holds, for Look again.
  useEffect(() => {
    const t = setInterval(() => {
      const { list: l, card: open, query, gen } = now.current;
      if (l === null || open || hidden()) {
        return;
      }
      const same = () => now.current.gen === gen;
      if (l.rows.length === 0) {
        void from.page(query).then((p) => {
          if (p !== null && same() && (now.current.list?.rows.length ?? 0) === 0) {
            setFailed(false);
            setList({
              rows: p.sailors,
              page: 0,
              more: p.more,
              atSea: p.atSea,
              withheld: p.withheld,
            });
          }
        });
        return;
      }
      void from.names(l.rows.map((r) => r.name)).then((p) => {
        if (p === null || !same()) {
          return;
        }
        setList((was) =>
          was === null
            ? was
            : {
                ...was,
                rows: refreshRows(was.rows, p.sailors),
                atSea: p.atSea,
                withheld: p.withheld,
              },
        );
      });
      void from.page(query).then((p) => {
        if (p !== null && same()) {
          setNewer(newcomers(now.current.list?.rows ?? [], p.sailors));
        }
      });
    }, AGAIN);
    return () => clearInterval(t);
  }, [from]);

  // Back from a card: the list where it was.
  useLayoutEffect(() => {
    if (card === null && scroller.current !== null) {
      scroller.current.scrollTop = scrolled.current;
    }
  }, [card]);

  const next = async () => {
    if (list === null) {
      return;
    }
    const p = await from.page({ q, page: list.page + 1, sort, who });
    if (p === null) {
      setFailed(true);
      return;
    }
    const shown = new Set(list.rows.map((r) => r.name));
    setList({
      ...list,
      rows: [...list.rows, ...p.sailors.filter((r) => !shown.has(r.name))],
      page: list.page + 1,
      more: p.more,
      atSea: p.atSea,
      withheld: p.withheld,
    });
  };

  const go = (name: string) => {
    close();
    choose(name);
  };
  const watch = (name: string) => (ask() ? setAsking(name) : go(name));
  const about = (r: WatchRow) => {
    scrolled.current = scroller.current?.scrollTop ?? 0;
    setCard(r);
  };
  const followed = (name: string, on: boolean) =>
    setList((was) =>
      was === null
        ? was
        : { ...was, rows: was.rows.map((r) => (r.name === name ? { ...r, followed: on } : r)) },
    );
  const unfollow = (name: string) => {
    void from.follow(name, false).then((a) => {
      if (a === 'ok') {
        setList((was) =>
          was === null ? was : { ...was, rows: was.rows.filter((r) => r.name !== name) },
        );
      }
    });
  };

  if (asking !== null) {
    return (
      <div class={`${className} watch-panel`}>
        <LeaveQuestion leave={() => go(asking)} stay={() => setAsking(null)} />
      </div>
    );
  }

  if (card !== null) {
    return (
      <section class={`${className} watch-panel`} aria-labelledby="watch-list-title">
        <WatchCard
          first={card}
          withheld={list?.withheld ?? false}
          back={() => setCard(null)}
          watch={() => watch(card.name)}
          followed={followed}
          read={from.card}
          follow={from.follow}
        />
      </section>
    );
  }

  const rows = list?.rows ?? [];
  const pick = pickOne(rows) !== null;
  return (
    <section class={`${className} watch-panel`} aria-labelledby="watch-list-title">
      <div class="watch-top">
        <div class="watch-head">
          <h2 id="watch-list-title">{WATCH_A_SAILOR}</h2>
          <input
            class="watch-search"
            type="search"
            name="watch-search"
            aria-label={SEARCH}
            placeholder={SEARCH}
            autocomplete="off"
            spellcheck={false}
            value={q}
            onInput={(e) => setQ(e.currentTarget.value)}
          />
        </div>
        <Choices
          sort={sort}
          who={who}
          withheld={list?.withheld ?? false}
          setSort={(s) => {
            setSort(s);
            saveWatchChoice({ watchSort: s });
          }}
          setWho={(w) => {
            setWho(w);
            saveWatchChoice({ watchWho: w });
          }}
        />
        {rows.length > 0 ? (
          <div class="watch-again">
            {pick ? (
              <button
                type="button"
                onClick={() => {
                  const name = pickOne(rows);
                  if (name !== null) {
                    watch(name);
                  }
                }}
              >
                {PICK_ONE}
              </button>
            ) : null}
            <button type="button" class="watch-look" onClick={() => setLooks(looks + 1)}>
              {lookAgainText(newer)}
            </button>
          </div>
        ) : null}
      </div>
      <div class="watch-scroll" ref={scroller}>
        {list === null ? (
          <p class="watch-faint" aria-live="polite">
            {READING}
          </p>
        ) : failed ? (
          <p class="watch-faint" aria-live="polite">
            {UNREADABLE}
          </p>
        ) : rows.length === 0 ? (
          <EmptyList q={q} who={who} atSea={list.atSea} />
        ) : null}
        {rows.length > 0 ? (
          <ul class="watch-rows">
            {rows.map((r) => (
              <ListRow
                key={r.name}
                r={r}
                about={() => about(r)}
                watch={() => watch(r.name)}
                unfollow={() => unfollow(r.name)}
              />
            ))}
          </ul>
        ) : null}
        {list?.more === true ? (
          <button type="button" class="watch-more" onClick={() => void next()}>
            {MORE}
          </button>
        ) : null}
      </div>
      <button type="button" class="watch-close" onClick={close}>
        {CLOSE}
      </button>
    </section>
  );
}

/**
 * The bar over the boat watched: whose it is, Watch another and Sail; or,
 * with none watched, why the last watch ended or the place in the
 * spectators' queue, with the same. Nothing while the own boat sails.
 */
export function WatchBar({ view }: { view: WatchView }) {
  const w = view.watching.value;
  const place = view.place.value;
  const ended = view.ended.value;
  const boat = view.boatPlace.value;
  if (!view.spectating.value && w === null && place === null && view.status.value !== 'idle') {
    return null;
  }
  const another = (
    <button type="button" onClick={() => (view.list.value = true)}>
      {WATCH_ANOTHER}
    </button>
  );
  const sail =
    boat === null ? (
      <button type="button" class="watch-go" onClick={() => view.sail()}>
        {SAIL}
      </button>
    ) : null;
  return (
    <section class="panel watch-bar" aria-label={WATCHING} data-readout="watching">
      {w !== null ? (
        <p class="watch-whose">
          {WATCHING}{' '}
          <strong>
            <PlayerText text={w.sailor} />
          </strong>
          {w.machine ? <Cog /> : null}
        </p>
      ) : place !== null ? (
        <p class="watch-whose" role="status">
          {spectatorQueueLine(place)}
        </p>
      ) : ended !== null ? (
        <p class="watch-whose" role="status">
          {endedText(ended.why, ended.sailor)}
        </p>
      ) : null}
      {boat !== null ? (
        <p class="watch-faint" role="status">
          {queueLines(boat)[0]}
        </p>
      ) : null}
      <div class="watch-buttons">
        {another}
        {sail}
      </div>
    </section>
  );
}

/** Brings the camera back behind the boat watched, which it does not by itself. */
export function BehindTheBoat({ view }: { view: WatchView }) {
  return view.watching.value === null ? null : (
    <button type="button" class="panel watch-behind" onClick={() => view.behind()}>
      {BEHIND_THE_BOAT}
    </button>
  );
}

/** The list over the sea: watching from the own boat at sea asks first. */
export function SeaWatchList({ view }: { view: WatchView }) {
  return view.list.value ? (
    <WatchList
      choose={(sailor) => view.watch(sailor)}
      ask={() => sailsOwn(view)}
      close={() => (view.list.value = false)}
    />
  ) : null;
}

/** What the screen at sea shows of watching: the bar, the button behind the boat, and the list while it is open. */
export function WatchParts({ view }: { view: WatchView }) {
  return (
    <>
      <WatchBar view={view} />
      <BehindTheBoat view={view} />
      <SeaWatchList view={view} />
    </>
  );
}

/**
 * Before the sea is shown: why a watch the page opened with was refused,
 * or the place in the spectators' queue, and the list; until the result
 * takes it away.
 */
export function showWatchWaiting(parent: HTMLElement, view: WatchView): () => void {
  const host = document.createElement('div');
  host.className = 'hud watch-waiting';
  parent.append(host);
  render(<WatchParts view={view} />, host);
  return () => {
    render(null, host);
    host.remove();
  };
}

/** GET /api/me's choice of who may watch the account's boat, "no" if it says none. */
async function readSpectators(f: Fetch): Promise<Spectators | null> {
  try {
    const res = await f('/api/me', { cache: 'no-store', credentials: 'same-origin' });
    if (res.status !== 200) {
      return null;
    }
    const me = (await res.json()) as Me;
    return me.spectators === 'voyage' ? 'voyage' : 'no';
  } catch {
    return null;
  }
}

/**
 * The switch as drawn: on while others may watch the voyage under way, or
 * the next boat's voyage with none in the water; disabled until read.
 */
export function SpectatorsSwitch({
  allow,
  problem,
  set,
}: {
  allow: Spectators | null;
  problem: string;
  set: (on: boolean) => void;
}) {
  return (
    <div class="watch-allow">
      <label class="watch-allow-row">
        <span>{LET_WATCH_VOYAGE}</span>
        <input
          type="checkbox"
          name="spectators"
          checked={allow === 'voyage'}
          disabled={allow === null}
          onChange={(e) => set(e.currentTarget.checked)}
        />
      </label>
      {problem !== '' ? (
        <p class="watch-faint" aria-live="polite">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Let others watch me sail (this voyage)": the account's choice for the
 * voyage under way, saved as it is switched. It ends with the voyage.
 */
export function SpectatorsChoice({ f = browserFetch }: { f?: Fetch }) {
  const [allow, setAllow] = useState<Spectators | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let live = true;
    void readSpectators(f).then((a) => {
      if (live) {
        setAllow(a);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const set = async (on: boolean) => {
    const was = allow;
    const value: Spectators = on ? 'voyage' : 'no';
    setAllow(value);
    setProblem('');
    const a = await call(f, '/api/me/spectators', { allow: value });
    if (a.status !== 200) {
      setAllow(was);
      setProblem(reasonText(reasonOf(a)));
    }
  };
  return <SpectatorsSwitch allow={allow} problem={problem} set={(on) => void set(on)} />;
}
