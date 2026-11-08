// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's people aboard, by hand: ?crew=N fills the boat with N
// people (the skipper among them, up to the boat's capacity), each in a
// look of their own drawn from the catalog's, the same at every load, every
// sixth a machine sailor; with more than one aboard, the first after the
// skipper holds the controls, so the skipper stands at that one's station
// and the helm is theirs. So the crew can be seen and measured offline.

import { codeOf, drawLook, type Look, type Looks, MACHINE } from '../catalog/looks';
import type { CrewShown } from '../render/sailors/crew';

/** The crew ?crew asks for on a boat that carries capacity; null for none asked. */
export function crewFromQuery(
  query: URLSearchParams,
  capacity: number,
  cat: Looks,
): CrewShown | null {
  const asked = Math.floor(Number(query.get('crew')));
  if (!query.has('crew') || !(asked > 0)) {
    return null;
  }
  return sandboxCrew(Math.min(asked, capacity), cat);
}

/** n people aboard in looks drawn from a fixed seed, the second holding the controls. */
export function sandboxCrew(n: number, cat: Looks): CrewShown {
  const random = seeded(0x5eed);
  const people = Array.from({ length: n }, (_, seat) => {
    const look: Look =
      seat % 6 === 5
        ? {
            look: MACHINE,
            version: pick(cat.machine.versions, random).id,
            finish: pick(cat.machine.finishes, random).id,
            colour: pick(cat.sailorOptions.colours, random).id,
          }
        : drawLook(cat, random);
    return { seat, look: codeOf(cat, look) };
  });
  return { people, holder: n > 1 ? 1 : 0 };
}

const pick = <T>(list: readonly T[], random: () => number): T =>
  list[Math.min(list.length - 1, Math.floor(random() * list.length))] as T;

/** A small seeded generator (mulberry32): the same looks at every load. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}
