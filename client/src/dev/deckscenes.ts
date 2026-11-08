// SPDX-License-Identifier: AGPL-3.0-only

// Sailing together's screens with no server, for the browser tests and
// their pictures: a stand-in for the game connection's side in each of
// its states, the knocks on the skipper's boat, the player's own knock,
// aboard with the controls or without, the skipper while another holds
// them, the controls offered, who is aboard and the skipper's link. What
// the screens ask of it is written down, not sent.

import { computed, signal } from '@preact/signals';
import { catalog } from '../catalog';
import { codeOf, drawLook } from '../catalog/looks';
import type {
  AboardTold,
  CrewTold,
  HandedTold,
  KnockCardTold,
  KnockingTold,
  KnockStateTold,
  PersonTold,
} from '../net/messages';
import type { DeckView } from '../ui/decklazy';
import type { WatchView } from '../ui/watchlazy';

/** The scenes, by name. */
export const DECK_SCENES = [
  'knocks',
  'knocking',
  'skipper',
  'skipper-away',
  'aboard',
  'aboard-holding',
  'handed',
  'list',
  'list-skipper',
  'ashore',
  'link',
] as const;

export type DeckSceneName = (typeof DECK_SCENES)[number];

/** A look code drawn from the catalog by a fixed number, so each scene's faces stay the same. */
function look(n: number): number {
  return codeOf(
    catalog,
    drawLook(catalog, () => n),
  );
}

/** The screen's two views of a scene: sailing together's, and watching's (nothing steers without the controls). */
export interface DeckScene {
  deck: DeckView;
  watch: WatchView;
  /** What the screens asked of it, in order: "answer 1 let", "take". */
  calls: string[];
}

/**
 * A scene: name, the sailor named in it (the skipper, or the one who
 * knocks), and for a knock the state it stands in.
 */
export function deckScene(
  name: DeckSceneName,
  sailor = 'Iron Mary',
  state: KnockStateTold = 'waiting',
): DeckScene {
  const calls: string[] = [];
  const aboard =
    name.startsWith('aboard') || name === 'handed' || name === 'list' || name === 'ashore';
  const skipper = name.startsWith('skipper') || name === 'list-skipper' || name === 'link';
  const away = name === 'skipper-away' || name === 'list-skipper';
  const holding = !aboard ? !away : name === 'aboard-holding';
  const people: PersonTold[] = [
    {
      seat: 0,
      look: look(0.1),
      name: skipper ? 'Saltpeter Sue' : sailor,
      machine: false,
      you: skipper,
    },
    { seat: 1, look: look(0.5), name: skipper ? sailor : 'Bosun Bly', machine: false, you: false },
    { seat: 2, look: look(0.8), name: 'Saltpeter Sue', machine: false, you: aboard },
  ];
  if (skipper) {
    people[2] = { seat: 2, look: look(0.8), name: 'Bosun Bly', machine: false, you: false };
  }
  const crew: CrewTold | null =
    aboard || skipper ? { people, holder: name === 'aboard-holding' ? 2 : away ? 1 : 0 } : null;
  const knocks: KnockCardTold[] =
    name === 'knocks'
      ? [
          { id: 1, sailor, look: look(0.3), gone: false },
          { id: 2, sailor: 'Bosun Bly', look: look(0.6), gone: false },
          { id: 3, sailor: 'Gull', look: look(0.9), gone: false },
        ]
      : [];
  const knocking: KnockingTold | null =
    name === 'knocking' ? { state, skipper: sailor, kind: 1, boat: '' } : null;
  const handed: HandedTold | null =
    name === 'handed' ? { from: sailor, seconds: 15, gone: false } : null;
  const told: AboardTold | null = aboard ? { skipper: sailor, look: look(0.1), seat: 2 } : null;
  const closed = signal(false);
  const deck: DeckView = {
    aboard: signal(told),
    crew: signal(crew),
    knocks: signal(knocks),
    knocking: signal(knocking),
    handed: signal(handed),
    holding: signal(holding),
    watching: signal(null),
    status: signal('sailing'),
    kind: signal(1),
    boatName: computed(() => ''),
    closed,
    link: signal(name === 'link'),
    list: signal(name === 'list' || name === 'list-skipper'),
    ashore: signal(name === 'ashore'),
    dismissed: signal(null),
    answer: (k, l) => calls.push(`answer ${k} ${l ? 'let' : 'not now'}`),
    hand: (seat) => calls.push(`hand ${seat}`),
    take: () => calls.push('take'),
    giveBack: () => calls.push('give back'),
    goAshore: () => calls.push('go ashore'),
    putAshore: (seat) => calls.push(`put ashore ${seat}`),
    closeKnocks: (c) => {
      closed.value = c;
      calls.push(`closed ${c}`);
    },
  };
  const watch: WatchView = {
    watching: signal(null),
    spectating: signal(!holding),
    status: signal('sailing'),
    ended: signal(null),
    place: signal(null),
    boatPlace: signal(null),
    watchers: signal(0),
    list: signal(false),
    watch: () => {},
    sail: () => {},
    unwatch: () => {},
  };
  return { deck, watch, calls };
}
