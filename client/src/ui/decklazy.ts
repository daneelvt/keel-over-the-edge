// SPDX-License-Identifier: AGPL-3.0-only

// Sailing together, as the screens see it: the knocks on the skipper's
// boat, the player's own knock, being aboard another's boat as crew, who
// is aboard and who holds the controls, the skipper's link, and shipmates
// (shipmatesview.ts). Its parts
// (deck.tsx) are loaded the first time one is needed: the game's first
// download holds none of them.

import { computed, effect, type ReadonlySignal, type Signal, signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { type ChatServer, chatServer } from '../account/chatapi';
import type {
  AboardTold,
  ChatStateTold,
  CrewTold,
  HandedTold,
  KnockCardTold,
  KnockingTold,
  PersonTold,
  ReportReasonTold,
  Status,
  WatchingTold,
  WhoTold,
} from '../net/messages';
import type { ChatLog } from './chatlog';
import { type ShipmatesView, shipmatesShown } from './shipmatesview';

/** Whom the sheet of mute, block and report is about, and how far along it is. */
export interface ChatSheet {
  who: WhoTold;
  name: string;
  machine: boolean;
  /** Someone on the shipmates panel, by account ID, reported over HTTP rather than on the game connection. */
  shipmate?: string;
  /** The sheet's keys; the one question before a block; the report's form. */
  step: 'menu' | 'block' | 'report';
}

/** Chat aboard, as the screens see it, and what they ask of it. */
export interface ChatView {
  /** The lines, the note, and whose lines are hidden. */
  log: ChatLog;
  /** How chat stands for the connection; null before it is told. */
  state: ReadonlySignal<ChatStateTold | null>;
  /** The strip open, showing the last lines and the field. */
  open: Signal<boolean>;
  /** The field's words as typed, kept while the strip folds; in memory only. */
  draft: Signal<string>;
  /** The sheet of mute, block and report, or null. */
  sheet: Signal<ChatSheet | null>;
  /** A window of chat's own: the Rules of the sea before a first line, or turning chat on. */
  ask: Signal<'rules' | 'turn-on' | null>;
  /** A line held while the Rules are asked, sent once they are accepted. */
  held: Signal<string>;
  /** The height the keyboard covers, held by a scene (px); null to follow the visual viewport. */
  keyboard: ReadonlySignal<number> | null;
  /** The account's side of chat. */
  server: ChatServer;
  say(text: string, self: string): boolean;
  mute(who: WhoTold, name: string, on: boolean): void;
  block(who: WhoTold, name: string, on: boolean): void;
  report(who: WhoTold, reason: ReportReasonTold, note: string): void;
}

/** The game connection's side of chat, as Online has it. */
export interface ChatSource {
  chat: ChatLog;
  chatState: ReadonlySignal<ChatStateTold | null>;
  sayAboard(text: string, self: string): boolean;
  mute(who: WhoTold, name: string, on: boolean): void;
  block(who: WhoTold, name: string, on: boolean): void;
  report(who: WhoTold, reason: ReportReasonTold, note: string): void;
}

/** The screens' view of chat. */
export function chatOf(o: ChatSource, server: ChatServer = chatServer()): ChatView {
  return {
    log: o.chat,
    state: o.chatState,
    open: signal(false),
    draft: signal(''),
    sheet: signal(null),
    ask: signal(null),
    held: signal(''),
    keyboard: null,
    server,
    say: (text, self) => o.sayAboard(text, self),
    mute: (who, name, on) => o.mute(who, name, on),
    block: (who, name, on) => o.block(who, name, on),
    report: (who, reason, note) => o.report(who, reason, note),
  };
}

/** What the screens show of sailing together, and what they ask of it. */
export interface DeckView {
  /** Whose boat the player is aboard as crew, or null. */
  aboard: ReadonlySignal<AboardTold | null>;
  /** Who is aboard the boat in view, and who holds the controls; null for the skipper alone. */
  crew: ReadonlySignal<CrewTold | null>;
  /** The knocks waiting on the own boat, oldest first. */
  knocks: ReadonlySignal<readonly KnockCardTold[]>;
  /** The player's own knock as it stands, or null. */
  knocking: ReadonlySignal<KnockingTold | null>;
  /** The controls offered to the player, or null. */
  handed: ReadonlySignal<HandedTold | null>;
  /** The player holds the controls of the boat they sail or are aboard. */
  holding: ReadonlySignal<boolean>;
  /** The boat watched, or null: none of sailing together shows then. */
  watching: ReadonlySignal<WatchingTold | null>;
  /** Where the connection stands. */
  status: ReadonlySignal<Status>;
  /** The boat in view's kind, an index into the catalog's boats, and its name ("" for none). */
  kind: ReadonlySignal<number>;
  boatName: ReadonlySignal<string>;
  /** The own boat is closed to knocks for this voyage, as last switched on this page. */
  closed: Signal<boolean>;
  /** Whether the skipper's link panel is open. */
  link: Signal<boolean>;
  /** Whether the list of who is aboard is open. */
  list: Signal<boolean>;
  /** The seat whose row of who is aboard opens with its ⋯ open: the sandbox's scenes alone. */
  openRow?: number;
  /** Whether the question before going ashore is asked. */
  ashore: Signal<boolean>;
  /** The player's own knock put away. */
  dismissed: Signal<KnockingTold | null>;
  answer(knock: number, let_: boolean): void;
  hand(seat: number): void;
  take(): void;
  giveBack(): void;
  goAshore(): void;
  putAshore(seat: number): void;
  closeKnocks(closed: boolean): void;
  /** Chat aboard. */
  chat: ChatView;
  /** Shipmates; null where there are none (the offline sandbox). */
  shipmates: ShipmatesView | null;
}

/** The game connection's side of it, as Online has it. */
export interface DeckSource extends ChatSource {
  aboard: ReadonlySignal<AboardTold | null>;
  crew: ReadonlySignal<CrewTold | null>;
  knocks: ReadonlySignal<readonly KnockCardTold[]>;
  knocking: ReadonlySignal<KnockingTold | null>;
  handed: ReadonlySignal<HandedTold | null>;
  holding: ReadonlySignal<boolean>;
  watching: ReadonlySignal<WatchingTold | null>;
  status: ReadonlySignal<Status>;
  kind: ReadonlySignal<number>;
  boatLook: ReadonlySignal<{ look: number; name: string } | null>;
  answer(knock: number, let_: boolean): void;
  hand(seat: number): void;
  take(): void;
  giveBack(): void;
  goAshore(): void;
  putAshore(seat: number): void;
  closeKnocks(closed: boolean): void;
}

/**
 * The screens' view of the game connection's side; goAshore is given the
 * change of boat (the cover down while the own boat comes back), where the
 * page has one.
 */
export function deckOf(
  o: DeckSource,
  change: (act: () => void) => void = (act) => act(),
  shipmates: ShipmatesView | null = null,
): DeckView {
  const closed = signal(false);
  const list = signal(false);
  // The controls offered close the list, so its window never covers the
  // offer's Take them.
  effect(() => {
    if (o.handed.value !== null) {
      list.value = false;
    }
  });
  return {
    aboard: o.aboard,
    crew: o.crew,
    knocks: o.knocks,
    knocking: o.knocking,
    handed: o.handed,
    holding: o.holding,
    watching: o.watching,
    status: o.status,
    kind: o.kind,
    boatName: computed(() => o.boatLook.value?.name ?? ''),
    closed,
    link: signal(false),
    list,
    ashore: signal(false),
    dismissed: signal(null),
    answer: (knock, let_) => o.answer(knock, let_),
    hand: (seat) => o.hand(seat),
    take: () => o.take(),
    giveBack: () => o.giveBack(),
    goAshore: () => change(() => o.goAshore()),
    putAshore: (seat) => o.putAshore(seat),
    closeKnocks: (c) => {
      closed.value = c;
      o.closeKnocks(c);
    },
    chat: chatOf(o),
    shipmates,
  };
}

/** The player among those aboard, or null for one who is not (a spectator). */
export function selfOf(crew: CrewTold | null): PersonTold | null {
  return crew?.people.find((p) => p.you) ?? null;
}

/** The skipper's own boat sails on while another aboard holds its controls. */
export function skipperAway(d: DeckView): boolean {
  const crew = d.crew.value;
  return (
    d.watching.value === null &&
    d.aboard.value === null &&
    crew !== null &&
    selfOf(crew)?.seat === 0 &&
    crew.holder !== 0
  );
}

/**
 * Whether the plate of sailing together stands at the foot of the
 * screen, in the watch plate's place: aboard without the controls, or
 * the skipper while another holds them.
 */
export function deckPlate(d: DeckView): boolean {
  return (
    d.watching.value === null && ((d.aboard.value !== null && !d.holding.value) || skipperAway(d))
  );
}

/**
 * Whether the chat strip is on the screen: with anyone else aboard the
 * boat sailed or aboard; and for anyone watching a boat with company where
 * everyone aboard is a machine sailor, to read.
 */
export function chatShown(d: DeckView): boolean {
  if (d.crew.value === null) {
    return false;
  }
  const w = d.watching.value;
  // Watching, anyone reads a boat's chat only while everyone aboard is a
  // machine sailor: what machine sailors say is public. With a person
  // aboard it is theirs alone, as the server keeps it.
  return w === null || (w.machine && d.crew.value.people.every((p) => p.machine));
}

/** Whether the strip only reads: a spectator's, who never says anything. */
export function chatReadOnly(d: DeckView): boolean {
  return d.watching.value !== null;
}

/** Whether any part of sailing together is on the screen. */
export function deckShown(d: DeckView): boolean {
  if (
    chatShown(d) ||
    d.chat.sheet.value !== null ||
    d.chat.ask.value !== null ||
    shipmatesShown(d.shipmates)
  ) {
    return true;
  }
  const k = d.knocking.value;
  if (d.watching.value !== null) {
    // Watching, the knocks on the player's own machine sailor's boat, their
    // machine sailor's knock, and its owner's windows.
    const w = d.watching.value;
    return (
      d.knocks.value.length > 0 ||
      (k !== null && k !== d.dismissed.value && (k.machine ?? '') !== '') ||
      (w.machine && w.mine && (d.link.value || d.list.value))
    );
  }
  return (
    d.aboard.value !== null ||
    d.crew.value !== null ||
    d.knocks.value.length > 0 ||
    d.handed.value !== null ||
    d.ashore.value ||
    (k !== null && k !== d.dismissed.value) ||
    d.link.value
  );
}

/** The player's own machine sailor watched, whose link and crew they may see to: its name, or null. */
export function machineShared(d: DeckView): string | null {
  const w = d.watching.value;
  return w?.machine && w.mine ? w.sailor : null;
}

/** Whether "Sail with me" is offered: the own boat in the water, not aboard another or watching. */
export function canShareLink(d: DeckView): boolean {
  return d.status.value === 'sailing' && d.aboard.value === null && d.watching.value === null;
}

type Deck = typeof import('./deck');

let loading: Promise<Deck> | null = null;

/** The parts' module, loaded once; tried again after a failure. */
export function loadDeck(): Promise<Deck> {
  if (loading === null) {
    loading = import('./deck').catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** The parts' module once loaded, or null until then; nothing is loaded until need. */
export function useDeck(need = true): Deck | null {
  const [m, setM] = useState<Deck | null>(null);
  useEffect(() => {
    if (!need || m !== null) {
      return;
    }
    let live = true;
    loadDeck().then(
      (mod) => {
        if (live) {
          setM(mod);
        }
      },
      () => {
        // Not shown: asked for again when next needed.
      },
    );
    return () => {
      live = false;
    };
  }, [need, m]);
  return m;
}
