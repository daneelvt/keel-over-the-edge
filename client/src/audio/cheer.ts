// SPDX-License-Identifier: AGPL-3.0-only

// The crowd's cheer as numbers: the recipe in art/sound/cheer.json mapped
// onto how many cheered and who hears it. A few voices' "huzzah" for one
// cheer, more voices, a roar and claps for many; the player's own cheer
// near and bright, the crowd cheering the player's boat distant, from the
// quay. The sound engine plays what this works out (SoundEngine.cheer):
// the one place a recorded crowd would take the synthesised one's.

import cheer from '../../../art/sound/cheer.json';

export type CheerRecipe = typeof cheer;
export const CHEER: CheerRecipe = cheer;

/** A voice of the crowd: when it starts after the cheer, s; its pitch, Hz; how long its vowel lasts, s; its level; where it stands, −1 … 1. */
export interface CheerVoice {
  at: number;
  pitch: number;
  length: number;
  level: number;
  pan: number;
}

/** A cheer to play once: its voices, its roar's level (0 for none) and its claps (each when, s, and where), the low-pass over it, Hz, and its level. */
export interface CheerSound {
  voices: CheerVoice[];
  roar: number;
  claps: { at: number; pan: number }[];
  cutoff: number;
  level: number;
}

/** How many voices count cheers raise. */
export function voicesOf(r: CheerRecipe, count: number): number {
  const v = r.voices;
  return Math.min(v.most, Math.round(v.least + v.perDouble * Math.log2(Math.max(count, 1))));
}

/**
 * The cheer of count cheers: own, the player's own "Huzzah!"; else the
 * crowd's, heard distant by a racer cheered, nearer by a spectator (racer
 * false). Random draws in [0, 1), Math.random by default.
 */
export function cheerOf(
  r: CheerRecipe,
  count: number,
  own: boolean,
  racer: boolean,
  random: () => number = Math.random,
): CheerSound {
  const n = Math.max(1, count);
  const doubles = Math.log2(n);
  const voices: CheerVoice[] = [];
  for (let i = 0; i < voicesOf(r, n); i++) {
    const [lo, hi] = r.vowel.length;
    voices.push({
      at: i === 0 ? 0 : random() * r.spread,
      pitch: r.pitch.low + random() * (r.pitch.high - r.pitch.low),
      length: (lo ?? 0.6) + random() * ((hi ?? 0.8) - (lo ?? 0.6)),
      level: (0.7 + 0.3 * random()) / Math.sqrt(1 + i * 0.5),
      pan: (random() * 2 - 1) * r.width,
    });
  }
  const roar =
    n >= r.roar.from ? Math.min(r.roar.most, r.roar.level + r.roar.perDouble * doubles) : 0;
  const claps: { at: number; pan: number }[] = [];
  if (n >= r.claps.from) {
    const k = Math.min(r.claps.most, Math.round(r.claps.rate * n * r.roar.length));
    for (let i = 0; i < k; i++) {
      claps.push({ at: random() * r.roar.length, pan: (random() * 2 - 1) * r.width });
    }
  }
  const distant = racer && !own;
  const level = own
    ? r.own.level
    : distant
      ? Math.min(r.distant.most, r.distant.level + r.distant.perDouble * doubles)
      : Math.min(r.distant.most, r.distant.level + r.distant.perDouble * doubles) * 0.8;
  return { voices, roar, claps, cutoff: distant ? r.distant.cutoff : 9000, level: level * r.level };
}
