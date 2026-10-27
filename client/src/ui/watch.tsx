// SPDX-License-Identifier: AGPL-3.0-only

// Watching another sailor's boat, the screens' parts of it: the list of
// sailors one may watch now (a search by part of a name, a page at a
// time, each row's boat, how many watch it, Watch, and a link to watch it
// that can be copied); the question before the own boat leaves the water
// to watch; the bar over a boat watched, "Watching Iron Mary ⚙" with
// Watch another and Sail, which says instead why a watch ended or the
// place in the spectators' queue; the button that brings the camera back
// behind the boat; and "Allow spectators", the account's choice of who may
// watch its own boat.
//
// Loaded only when first needed (watchlazy.ts): none of it is in the
// game's first download.

import './watch.css';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Fetch, Me } from '../account/me';
import { call, reasonOf } from '../account/passkeys';
import { reasonText } from '../account/reasons';
import { catalog } from '../catalog';
import { PlayerText } from './player';
import { queueLines } from './queue';
import { sailsOwn, type WatchView } from './watchlazy';
import {
  ALLOW_SPECTATORS,
  BEHIND_THE_BOAT,
  CLOSE,
  COPIED,
  COPY_WATCH_LINK,
  endedText,
  LEAVE,
  LEAVE_DETAIL,
  LEAVE_QUESTION,
  MORE,
  NONE_TO_WATCH,
  READING,
  SAIL,
  SEARCH,
  SPECTATOR_CHOICES,
  type Spectators,
  STAY,
  spectatorQueueLine,
  UNREADABLE,
  WATCH,
  WATCH_A_SAILOR,
  WATCH_ANOTHER,
  WATCHING,
  watchersText,
  watchLink,
} from './watchwords';

/** A boat one may watch, as GET /api/watch lists it. */
export interface WatchRow {
  name: string;
  /** A machine sailor's; one of the account's own. */
  machine: boolean;
  mine: boolean;
  /** Its kind, by the catalog's boat id. */
  kind: string;
  watchers: number;
}

/** A page of GET /api/watch: 50 boats at most, and whether more follow. */
export interface WatchPage {
  sailors: WatchRow[];
  more: boolean;
}

const browserFetch: Fetch = (input, init) => fetch(input, init);

/** A page of the boats one may watch now whose sailors' names hold q; null if it cannot be read. */
export async function readWatchPage(
  q: string,
  page: number,
  f: Fetch = browserFetch,
): Promise<WatchPage | null> {
  const query = new URLSearchParams({ q, page: String(page) });
  try {
    const res = await f(`/api/watch?${query}`, { cache: 'no-store', credentials: 'same-origin' });
    if (res.status !== 200) {
      return null;
    }
    const body = (await res.json()) as WatchPage;
    return Array.isArray(body.sailors) ? { sailors: body.sailors, more: body.more === true } : null;
  } catch {
    return null;
  }
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

/** How long typing rests before the list is asked for again, ms. */
const TYPED = 250;

/**
 * The list of sailors to watch, closed back to where it was: choose is
 * given the sailor chosen, after the question when ask says the own boat
 * would leave the water; read is given, as a test stands in for the
 * server.
 */
export function WatchList({
  choose,
  ask,
  close,
  read = readWatchPage,
  className = 'panel watch-list',
}: {
  choose: (sailor: string) => void;
  ask: () => boolean;
  close: () => void;
  read?: typeof readWatchPage;
  className?: string;
}) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<WatchRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [page, setPage] = useState(0);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () => {
        void read(q, 0).then((p) => {
          if (!live) {
            return;
          }
          setFailed(p === null);
          setRows(p?.sailors ?? []);
          setMore(p?.more ?? false);
          setPage(0);
        });
      },
      q === '' ? 0 : TYPED,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const next = async () => {
    const p = await read(q, page + 1);
    if (p === null) {
      setFailed(true);
      return;
    }
    setRows([...(rows ?? []), ...p.sailors]);
    setMore(p.more);
    setPage(page + 1);
  };

  const go = (name: string) => {
    close();
    choose(name);
  };

  if (asking !== null) {
    return (
      <div class={className}>
        <LeaveQuestion leave={() => go(asking)} stay={() => setAsking(null)} />
      </div>
    );
  }

  return (
    <section class={className} aria-labelledby="watch-list-title">
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
      {rows === null ? (
        <p class="watch-faint" aria-live="polite">
          {READING}
        </p>
      ) : (
        <>
          {failed ? (
            <p class="watch-faint" aria-live="polite">
              {UNREADABLE}
            </p>
          ) : rows.length === 0 ? (
            <p class="watch-faint">{NONE_TO_WATCH}</p>
          ) : null}
          <ul class="watch-rows">
            {rows.map((r) => (
              <li key={r.name} data-sailor={r.name}>
                <span class="watch-who">
                  <strong>
                    <PlayerText text={r.name} />
                  </strong>
                  {r.machine ? <Cog /> : null}
                  <span class="watch-faint">
                    {kindName(r.kind)}
                    {r.watchers > 0 ? ` · ${watchersText(r.watchers)}` : ''}
                  </span>
                </span>
                <span class="watch-buttons">
                  <button
                    type="button"
                    class="watch-go"
                    onClick={() => (ask() ? setAsking(r.name) : go(r.name))}
                  >
                    {WATCH}
                  </button>
                  <CopyWatchLink sailor={r.name} />
                </span>
              </li>
            ))}
          </ul>
          {more ? (
            <button type="button" onClick={() => void next()}>
              {MORE}
            </button>
          ) : null}
        </>
      )}
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
    return me.spectators ?? 'no';
  } catch {
    return null;
  }
}

/**
 * "Allow spectators": No, This voyage or Always, side by side, none
 * suggested; the account's, saved as it is chosen.
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
  const choose = async (value: Spectators) => {
    const was = allow;
    setAllow(value);
    setProblem('');
    const a = await call(f, '/api/me/spectators', { allow: value });
    if (a.status !== 200) {
      setAllow(was);
      setProblem(reasonText(reasonOf(a)));
    }
  };
  return (
    <fieldset class="watch-allow">
      <legend>{ALLOW_SPECTATORS}</legend>
      <div class="watch-choices">
        {SPECTATOR_CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            name="spectators"
            aria-pressed={allow === c.value}
            disabled={allow === null}
            onClick={() => void choose(c.value)}
          >
            {c.words}
          </button>
        ))}
      </div>
      {problem !== '' ? (
        <p class="watch-faint" aria-live="polite">
          {problem}
        </p>
      ) : null}
    </fieldset>
  );
}
