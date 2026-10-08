// SPDX-License-Identifier: AGPL-3.0-only

// A new sailor's look: drawn at random from the catalog's sailors, and drawn
// again on asking. Looks are read from the catalog, never named in code.

export interface Look {
  id: string;
  name: string;
}

/** Draws a look, another than current when there is a choice. */
export function drawLook<T extends Look>(
  sailors: readonly T[],
  current: T | null = null,
  random: () => number = Math.random,
): T {
  const others = sailors.length > 1 ? sailors.filter((s) => s !== current) : sailors;
  const pick = others[Math.floor(random() * others.length)] ?? others[0];
  if (pick === undefined) {
    throw new Error('the catalog has no sailors');
  }
  return pick;
}
