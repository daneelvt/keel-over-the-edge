// SPDX-License-Identifier: AGPL-3.0-only

// Shipmates, as the screens see them: the list as last read from the
// server (read as the page comes to sea, each time the server says it
// changed, and while the panel or a thread is open), the panel and the
// thread open, the notices under the case (a message while its thread is
// not open, an offer new to the page), and what the screens ask of it.
// When someone leaves the list, by either's ending or a block, their
// thread is forgotten and closes without a word. The parts that draw it
// (shipmates.tsx) load with sailing together's: none of them is in the
// game's first download.

import { effect, type ReadonlySignal, type Signal, signal } from '@preact/signals';
import {
  type ShipmateOffer,
  type ShipmatesList,
  type ShipmatesServer,
  type ShipmateTo,
  shipmatesServer,
} from '../account/shipmatesapi';
import type { ReportReasonTold, Status } from '../net/messages';
import type { Words } from './deckwords';
import type { ShipmateThreads } from './shipmatelog';
import { blockedWords, endedWords, NOT_DONE, offerWords } from './shipmatewords';

/** How often the list is read again while the panel or a thread is open, ms. */
export const REFRESH_EVERY = 20_000;

/** A notice under the case: a shipmate's message, or an offer; key is the page's own, for each new one. */
export interface ShipmateNotice {
  kind: 'message' | 'offer';
  id: string;
  name: string;
  key: number;
}

/** What came of the player's last act on a row of the panel, said under that row. */
export interface ShipmateTold {
  id: string;
  words: Words;
}

/** A question asked in a row's place, once: ending, a block, leaving the water to watch. */
export interface ShipmateAsk {
  id: string;
  what: 'end' | 'block' | 'watch';
}

/** What the screens show of shipmates, and what they ask of it. */
export interface ShipmatesView {
  /** The list as last read; null before it is. */
  list: Signal<ShipmatesList | null>;
  /** The last reading failed. */
  failed: Signal<boolean>;
  /** Whether the panel is open. */
  panel: Signal<boolean>;
  /** The shipmate whose thread is open, by account ID; null for none. */
  thread: Signal<string | null>;
  /** The notices waiting under the case, the oldest first. */
  notices: Signal<readonly ShipmateNotice[]>;
  /** The messages, by thread. */
  threads: ShipmateThreads;
  /** Each thread's field as typed, kept while it closes; in memory only. */
  drafts: Signal<ReadonlyMap<string, string>>;
  /** What came of the player's last act on a row. */
  told: Signal<ShipmateTold | null>;
  /** The row whose ⋯ opens open, and the question asked: the sandbox's scenes alone. */
  openRow?: string;
  asking?: ShipmateAsk;
  /** The height the keyboard covers, held by a scene (px); null to follow the visual viewport. */
  keyboard?: ReadonlySignal<number> | null;
  server: ShipmatesServer;
  /** Reads the list again. */
  refresh(): Promise<void>;
  /** Writes to a shipmate as self: false for nothing sent. */
  say(to: string, text: string, self: string): boolean;
  /** Asks to come aboard the boat a shipmate skippers. */
  knock(id: string): void;
  /** Watches a sailor's boat, by name. */
  watch(name: string): void;
  /** Offers to be shipmates: the words of what came of it. */
  offer(to: ShipmateTo, name: string): Promise<Words>;
  accept(o: ShipmateOffer): Promise<void>;
  /** Declines an offer, silently: they are never told. */
  decline(o: ShipmateOffer): Promise<void>;
  /** No longer shipmates: the words of what came of it. */
  end(to: ShipmateTo, name: string): Promise<Words>;
  block(id: string, name: string): Promise<void>;
  report(id: string, reason: ReportReasonTold, note: string): Promise<boolean>;
  /** Appear offline, or no longer. */
  setOffline(on: boolean): Promise<void>;
}

/** The game connection's side of shipmates, as Online has it. */
export interface ShipmatesSource {
  threads: ShipmateThreads;
  shipmatesChanged: ReadonlySignal<number>;
  status: ReadonlySignal<Status>;
  sayTo(to: string, text: string, self: string): boolean;
  knockShipmate(id: string): void;
  watch(sailor: string): void;
}

/** The offers among those read that the page has not seen before; seen takes them in. */
export function freshOffers(seen: Set<string>, offers: readonly ShipmateOffer[]): ShipmateOffer[] {
  const fresh = offers.filter((o) => !seen.has(o.id));
  for (const o of fresh) {
    seen.add(o.id);
  }
  return fresh;
}

/** The name the list gives a shipmate, or else the one their message came with. */
export function nameOf(list: ShipmatesList | null, id: string, otherwise = ''): string {
  return list?.shipmates.find((s) => s.id === id)?.name ?? otherwise;
}

/** Whether any part of shipmates is on the screen. */
export function shipmatesShown(v: ShipmatesView | null): boolean {
  return v !== null && (v.panel.value || v.thread.value !== null || v.notices.value.length > 0);
}

/**
 * The screens' view of shipmates. The list is read once as the game
 * connection is first welcomed, and again each time the server says it
 * changed; hide is given the name of someone blocked, whose lines are
 * hidden at once; watching goes through change, as any change of boat.
 */
export function shipmatesOf(
  o: ShipmatesSource,
  {
    server = shipmatesServer(),
    change = (act: () => void) => act(),
    hide = (_name: string) => {},
  }: {
    server?: ShipmatesServer;
    change?: (act: () => void) => void;
    hide?: (name: string) => void;
  } = {},
): ShipmatesView {
  const list = signal<ShipmatesList | null>(null);
  const failed = signal(false);
  const panel = signal(false);
  const thread = signal<string | null>(null);
  const notices = signal<readonly ShipmateNotice[]>([]);
  const told = signal<ShipmateTold | null>(null);
  const threads = o.threads;
  const seen = new Set<string>();
  let key = 0;
  let reading = 0;

  /** The list as read: notices for new offers, and nothing kept of anyone no longer a shipmate. */
  const take = (l: ShipmatesList) => {
    list.value = l;
    failed.value = false;
    const ids = new Set(l.shipmates.map((s) => s.id));
    threads.keep(ids);
    if (thread.peek() !== null && !ids.has(thread.peek() ?? '')) {
      thread.value = null;
    }
    const offers = new Set(l.offers.map((x) => x.id));
    const kept = notices
      .peek()
      .filter((n) => (n.kind === 'message' ? ids.has(n.id) : offers.has(n.id)));
    // An offer new to the page is a notice, unless the panel shows it already.
    const fresh = freshOffers(seen, l.offers).filter(
      (x) => !panel.peek() && !kept.some((n) => n.kind === 'offer' && n.id === x.id),
    );
    const next = [
      ...kept,
      ...fresh.map((x) => ({ kind: 'offer' as const, id: x.id, name: x.name, key: ++key })),
    ];
    if (next.length !== notices.peek().length || fresh.length > 0) {
      notices.value = next;
    }
  };
  const refresh = async () => {
    const n = ++reading;
    const l = await server.list();
    if (n !== reading) {
      return;
    }
    if (l === null) {
      failed.value = true;
      return;
    }
    take(l);
  };
  /** The list changed here before the server is read again. */
  const edit = (f: (l: ShipmatesList) => ShipmatesList) => {
    const l = list.peek();
    if (l !== null) {
      take(f(l));
    }
  };
  const drop = (id: string) =>
    edit((l) => ({
      ...l,
      shipmates: l.shipmates.filter((s) => s.id !== id),
      recent: l.recent.map((r) => (r.id === id ? { ...r, shipmate: false, can: false } : r)),
    }));

  // Read as the game connection is first welcomed, for offers waiting.
  let welcomed = false;
  effect(() => {
    if (!welcomed && o.status.value === 'sailing') {
      welcomed = true;
      void refresh();
    }
  });
  // Read again each time the server says the shipmates changed.
  let changes = o.shipmatesChanged.peek();
  effect(() => {
    const n = o.shipmatesChanged.value;
    if (n !== changes) {
      changes = n;
      void refresh();
    }
  });
  // A message while its thread is not open: a notice, one a shipmate.
  let heard = threads.heard.peek()?.key ?? 0;
  effect(() => {
    const h = threads.heard.value;
    if (h === null || h.key === heard) {
      return;
    }
    heard = h.key;
    if (thread.peek() === h.thread) {
      return;
    }
    const name = nameOf(list.peek(), h.thread, h.name);
    notices.value = [
      ...notices.peek().filter((n) => !(n.kind === 'message' && n.id === h.thread)),
      { kind: 'message', id: h.thread, name, key: ++key },
    ];
  });
  // The thread opened puts its notices away; the panel opened, the offers'.
  effect(() => {
    const t = thread.value;
    const p = panel.value;
    const was = notices.peek();
    const next = was.filter(
      (n) => !(n.kind === 'message' && n.id === t) && !(n.kind === 'offer' && p),
    );
    if (next.length !== was.length) {
      notices.value = next;
    }
  });
  // The panel closed forgets what came of its last act.
  effect(() => {
    if (!panel.value) {
      told.value = null;
    }
  });

  return {
    list,
    failed,
    panel,
    thread,
    notices,
    threads,
    drafts: signal(new Map()),
    told,
    server,
    refresh,
    say: (to, text, self) => o.sayTo(to, text, self),
    knock: (id) => o.knockShipmate(id),
    watch: (name) => change(() => o.watch(name)),
    async offer(to, name) {
      const r = await server.offer(to);
      const words = offerWords(r, name);
      if ('id' in to) {
        told.value = { id: to.id, words };
      }
      void refresh();
      return words;
    },
    async accept(x) {
      const r = await server.accept(x.id);
      told.value = { id: x.id, words: offerWords(r, x.name) };
      if (r === 'gone') {
        edit((l) => ({ ...l, offers: l.offers.filter((y) => y.id !== x.id) }));
      }
      void refresh();
    },
    async decline(x) {
      edit((l) => ({ ...l, offers: l.offers.filter((y) => y.id !== x.id) }));
      await server.decline(x.id);
      void refresh();
    },
    async end(to, name) {
      const ok = await server.end(to);
      const words = ok ? endedWords(name) : [NOT_DONE];
      if ('id' in to) {
        if (ok) {
          drop(to.id);
        }
        told.value = { id: to.id, words };
      }
      void refresh();
      return words;
    },
    async block(id, name) {
      const ok = await server.block(id);
      if (ok) {
        hide(name);
        drop(id);
        edit((l) => ({
          ...l,
          offers: l.offers.filter((y) => y.id !== id),
          recent: l.recent.filter((r) => r.id !== id),
        }));
      }
      told.value = { id, words: ok ? blockedWords(name) : [NOT_DONE] };
      void refresh();
    },
    report: (id, reason, note) => server.report(id, reason, note),
    async setOffline(on) {
      edit((l) => ({ ...l, offline: on }));
      if (!(await server.offline(on))) {
        edit((l) => ({ ...l, offline: !on }));
      }
      void refresh();
    },
  };
}
