// SPDX-License-Identifier: AGPL-3.0-only

// "Sail with me": the skipper's link, which anyone who opens it may use
// to ask to come aboard. The server keeps only the link's hash, so the
// page keeps the address it was given, in memory and on the device for
// each sailor, to share it again while it lasts; a link out that this
// device does not have can only be ended or replaced. Share (the phone's
// own sheet, where it has one) and Copy; New link, which ends the old;
// Links off; and Closed to knocks for the voyage. Before the first link,
// the questions not yet answered: when the sailor was born, and the
// Rules of the sea.

import { useEffect, useState } from 'preact/hooks';
import { FirstAsks, firstAsks } from '../account/firstasks';
import type { FirstAsk } from '../account/firstwords';
import type { Fetch } from '../account/me';
import { call, reasonOf } from '../account/passkeys';
import { reasonText } from '../account/reasons';
import type { DeckView } from './decklazy';
import {
  CLOSE,
  CLOSED_DETAIL,
  CLOSED_TO_KNOCKS,
  COPIED,
  COPY,
  endsText,
  LINK_ENDED,
  LINK_NOT_HERE,
  LINK_UNREADABLE,
  LINKS_OFF,
  LINKS_RESTING,
  NEW_LINK,
  NO_LINK,
  READING_LINK,
  SAIL_WITH_ME,
  SAIL_WITH_ME_DETAIL,
  SHARE,
} from './deckwords';

/** A link as the server gave it: its address, and when it ends, ms of UTC. */
export interface SailLink {
  url: string;
  expires: number;
}

/** GET /api/sail/link: whether a link is out, and when it ends; null if unread. */
export type LinkStatus = { live: true; expires: number } | { live: false };

/** A new link, or why none was made: the server's reason. */
export type Made = { link: SailLink } | { error: string };

/** The server's side of the link; a test stands in for it. */
export interface LinkServer {
  /** What is still to be asked before a link, or null if unread. */
  asks(): Promise<FirstAsk[] | null>;
  status(): Promise<LinkStatus | null>;
  make(): Promise<Made>;
  end(): Promise<boolean>;
}

/** An RFC 3339 time as ms of UTC; NaN for none. */
function msOf(t: unknown): number {
  return typeof t === 'string' ? Date.parse(t) : Number.NaN;
}

/**
 * The link's routes, as the server answers them: the player's own, or,
 * with machine, that of one of the player's machine sailors, by its name.
 */
export function linkServer(
  f: Fetch = (input, init) => fetch(input, init),
  machine = '',
): LinkServer {
  const body = machine === '' ? undefined : { machine };
  const query = machine === '' ? '' : `?machine=${encodeURIComponent(machine)}`;
  return {
    async asks() {
      try {
        const res = await f('/api/me', { cache: 'no-store', credentials: 'same-origin' });
        return res.status === 200 ? firstAsks(await res.json()) : null;
      } catch {
        return null;
      }
    },
    async status() {
      try {
        const res = await f(`/api/sail/link${query}`, {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (res.status !== 200) {
          return null;
        }
        const b = (await res.json()) as { live?: unknown; expires?: unknown };
        const expires = msOf(b.expires);
        return b.live === true && Number.isFinite(expires)
          ? { live: true, expires }
          : { live: false };
      } catch {
        return null;
      }
    },
    async make() {
      const a = await call(f, '/api/sail/link', body);
      const url = a.body?.url;
      const expires = msOf(a.body?.expires);
      if (a.status === 201 && typeof url === 'string' && Number.isFinite(expires)) {
        return { link: { url, expires } };
      }
      return { error: a.status === 201 ? 'unavailable' : reasonOf(a) };
    },
    async end() {
      return (await call(f, '/api/sail/link/end', body)).status === 204;
    },
  };
}

/** Where the links are kept on the device, each sailor's. */
const KEY = 'keel.sailLinks';

/** What localStorage offers; tests stand in for it. */
export interface LinkStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): LinkStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The links of this page's life, each sailor's, where the device keeps none. */
const memory = new Map<string, SailLink>();

function readAll(store: LinkStore | null): Record<string, SailLink> {
  try {
    const raw = JSON.parse(store?.getItem(KEY) ?? '{}') as unknown;
    return raw !== null && typeof raw === 'object' ? (raw as Record<string, SailLink>) : {};
  } catch {
    return {};
  }
}

/** The sailor's link as kept, or null. */
export function keptLink(
  sailor: string,
  store: LinkStore | null = defaultStore(),
): SailLink | null {
  const l = readAll(store)[sailor] ?? memory.get(sailor);
  return l !== undefined && typeof l.url === 'string' && typeof l.expires === 'number' ? l : null;
}

/** Keeps the sailor's link, or forgets it (null). */
export function keepLink(
  sailor: string,
  link: SailLink | null,
  store: LinkStore | null = defaultStore(),
): void {
  if (link === null) {
    memory.delete(sailor);
  } else {
    memory.set(sailor, link);
  }
  const all = readAll(store);
  if (link === null) {
    delete all[sailor];
  } else {
    all[sailor] = link;
  }
  try {
    store?.setItem(KEY, JSON.stringify(all));
  } catch {
    // Private browsing, or no room: kept for the page's life.
  }
}

/** What the panel shows of the link: being read, unread, none out, one out elsewhere, or this one. */
export type LinkShown =
  | { kind: 'reading' }
  | { kind: 'unread' }
  | { kind: 'none'; ended: boolean }
  | { kind: 'elsewhere'; expires: number }
  | { kind: 'here'; link: SailLink };

/** The link shown, from the server's word and the one kept; whether to forget the one kept. */
export function shownLink(
  status: LinkStatus | null,
  kept: SailLink | null,
  now: number,
): { shown: LinkShown; forget: boolean } {
  if (status === null) {
    return { shown: { kind: 'unread' }, forget: false };
  }
  if (!status.live || status.expires <= now) {
    return { shown: { kind: 'none', ended: false }, forget: kept !== null };
  }
  if (kept !== null && Math.abs(kept.expires - status.expires) < 1000) {
    return { shown: { kind: 'here', link: kept }, forget: false };
  }
  return { shown: { kind: 'elsewhere', expires: status.expires }, forget: kept !== null };
}

/** The words of a link not made: the server's reason. */
export function madeProblem(error: string): string {
  return error === 'links-off' ? LINKS_RESTING : reasonText(error);
}

const defaultServer = linkServer();

/** How often the time left is read again, ms. */
const AGAIN = 30_000;

/** The skipper's link, in a window over the sea. */
export function SailWithMe({
  deck,
  sailor,
  close,
  from = defaultServer,
  store = defaultStore(),
  title = SAIL_WITH_ME,
  detail = SAIL_WITH_ME_DETAIL,
}: {
  /** The boat closed to knocks, and the switch; null for none here. */
  deck: Pick<DeckView, 'closed' | 'closeKnocks'> | null;
  sailor: string | null;
  close: () => void;
  from?: LinkServer;
  store?: LinkStore | null;
  title?: string;
  detail?: string;
}) {
  const who = sailor ?? '';
  const [shown, setShown] = useState<LinkShown>({ kind: 'reading' });
  const [asks, setAsks] = useState<FirstAsk[]>([]);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [young, setYoung] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    void from.status().then((status) => {
      if (!live) {
        return;
      }
      const s = shownLink(status, keptLink(who, store), Date.now());
      if (s.forget) {
        keepLink(who, null, store);
      }
      setShown(s.shown);
    });
    const t = setInterval(() => setNow(Date.now()), AGAIN);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && asks.length === 0) {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [asks.length]);

  const post = async () => {
    const m = await from.make();
    if ('link' in m) {
      keepLink(who, m.link, store);
      setShown({ kind: 'here', link: m.link });
      setNow(Date.now());
      setCopied(false);
    } else if (m.error === 'born' || m.error === 'rules') {
      setAsks([m.error === 'born' ? 'age' : 'rules']);
    } else {
      setProblem(madeProblem(m.error));
    }
  };

  const make = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setProblem('');
    const need = await from.asks();
    if (need !== null && need.length > 0) {
      setAsks(need);
    } else {
      await post();
    }
    setBusy(false);
  };

  const end = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setProblem('');
    if (await from.end()) {
      keepLink(who, null, store);
      setShown({ kind: 'none', ended: true });
    } else {
      setProblem(reasonText('unavailable'));
    }
    setBusy(false);
  };

  if (asks.length > 0) {
    return (
      <div class="deck-window deck-asks">
        <FirstAsks
          asks={asks}
          onDone={() => {
            setAsks([]);
            setBusy(true);
            void post().finally(() => setBusy(false));
          }}
          onCancel={() => setAsks([])}
          onYoung={() => setYoung(true)}
        />
        {young ? (
          <button type="button" class="plate-key deck-close" onClick={close}>
            {CLOSE}
          </button>
        ) : null}
      </div>
    );
  }

  const link = shown.kind === 'here' ? shown.link : null;
  const share =
    link !== null && typeof navigator !== 'undefined' && typeof navigator.share === 'function'
      ? () => void navigator.share({ title, url: link.url }).catch(() => {})
      : null;
  const copy = () => {
    if (link === null) {
      return;
    }
    void navigator.clipboard.writeText(link.url).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <section class="panel deck-window deck-link" aria-labelledby="deck-link-title">
      <h2 id="deck-link-title">{title}</h2>
      <p class="deck-faint">{detail}</p>
      {shown.kind === 'reading' ? <p aria-live="polite">{READING_LINK}</p> : null}
      {shown.kind === 'unread' ? <p aria-live="polite">{LINK_UNREADABLE}</p> : null}
      {shown.kind === 'none' ? <p>{shown.ended ? LINK_ENDED : NO_LINK}</p> : null}
      {shown.kind === 'elsewhere' ? (
        <>
          <p>{LINK_NOT_HERE}</p>
          <p class="deck-faint">{endsText(shown.expires, now)}</p>
        </>
      ) : null}
      {link !== null ? (
        <>
          <input
            class="deck-url"
            type="text"
            name="sail-link"
            readOnly
            aria-label={title}
            value={link.url}
            onFocus={(e) => e.currentTarget.select()}
          />
          <p class="deck-faint" data-readout="link-ends">
            {endsText(link.expires, now)}
          </p>
          <div class="deck-keys">
            {share !== null ? (
              <button type="button" class="plate-key key-main" onClick={share}>
                {SHARE}
              </button>
            ) : null}
            <button
              type="button"
              class={`plate-key${share === null ? ' key-main' : ''}`}
              onClick={copy}
            >
              {copied ? COPIED : COPY}
            </button>
          </div>
        </>
      ) : null}
      {problem !== '' ? (
        <p class="deck-problem" aria-live="polite">
          {problem}
        </p>
      ) : null}
      {shown.kind !== 'reading' ? (
        <div class="deck-keys">
          <button
            type="button"
            class={`plate-key${link === null ? ' key-main' : ''}`}
            disabled={busy}
            onClick={() => void make()}
          >
            {NEW_LINK}
          </button>
          {shown.kind === 'here' || shown.kind === 'elsewhere' ? (
            <button type="button" class="plate-key" disabled={busy} onClick={() => void end()}>
              {LINKS_OFF}
            </button>
          ) : null}
        </div>
      ) : null}
      {deck === null ? null : (
        <label class="deck-switch">
          <span>
            {CLOSED_TO_KNOCKS}
            <span class="deck-faint deck-switch-detail">{CLOSED_DETAIL}</span>
          </span>
          <input
            type="checkbox"
            name="closed-to-knocks"
            checked={deck.closed.value}
            onChange={(e) => deck.closeKnocks(e.currentTarget.checked)}
          />
        </label>
      )}
      <button type="button" class="plate-key deck-close" onClick={close}>
        {CLOSE}
      </button>
    </section>
  );
}
