// SPDX-License-Identifier: AGPL-3.0-only

// Sailing together, as the screens see it: the knocks on the skipper's
// boat, the player's own knock, being aboard another's boat as crew, who
// is aboard and who holds the controls, and the skipper's link. Its parts
// (deck.tsx) are loaded the first time one is needed: the game's first
// download holds none of them.

import { computed, type ReadonlySignal, type Signal, signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type {
  AboardTold,
  CrewTold,
  HandedTold,
  KnockCardTold,
  KnockingTold,
  PersonTold,
  Status,
  WatchingTold,
} from '../net/messages';

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
}

/** The game connection's side of it, as Online has it. */
export interface DeckSource {
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
): DeckView {
  const closed = signal(false);
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
    list: signal(false),
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

/** Whether any part of sailing together is on the screen. */
export function deckShown(d: DeckView): boolean {
  if (d.watching.value !== null) {
    return false;
  }
  const k = d.knocking.value;
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
