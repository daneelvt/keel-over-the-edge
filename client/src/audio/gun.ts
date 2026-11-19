// SPDX-License-Identifier: AGPL-3.0-only

// The race committee's signal gun as numbers: the recipe in
// art/sound/gun.json mapped onto how loud the report is and where the
// listener is. A racer or a spectator of the race hears every gun at full
// level, wherever they are, after the sound's flight over at most the
// recipe's near distance, so the smoke is seen a moment before the bang;
// anyone else hears it as a sound of the world, fainter and duller with
// distance, as thunder is (audio/thunder.ts).

import gun from '../../../art/sound/gun.json';
import { airCutoff } from './air';
import { type At, panOf, pointLevel } from './harbour';

export type GunRecipe = typeof gun;
export const GUN: GunRecipe = gun;

/** A report to play once, as the listener hears it. */
export interface GunReport {
  /** How long after now it is heard, s. */
  delay: number;
  /** Its level, as a gain, and where it is placed, −1 (left) … 1 (right). */
  level: number;
  pan: number;
  /** The air's low-pass over its distance, Hz. */
  cutoff: number;
  /** How loud it is against a signal's: 1 a signal, more for the start's and the winner's. */
  loud: number;
  /** Its echoes: each later, fainter and duller. */
  echoes: { delay: number; level: number; cutoff: number }[];
}

/**
 * The report of a gun fired at the muzzle, heard by a listener looking
 * along look (radians clockwise from north): loud 1 for a signal, more for
 * a louder one; inRace for a racer or a spectator of the race. Null for
 * one too far to hear.
 */
export function gunReport(
  r: GunRecipe,
  muzzle: At,
  listener: At,
  look: number,
  loud: number,
  inRace: boolean,
): GunReport | null {
  const d = Math.hypot(muzzle.east - listener.east, muzzle.north - listener.north);
  const far = inRace ? Math.min(d, r.near) : d;
  const fall = inRace ? 1 : pointLevel(d, r.near, r.reach);
  if (!(fall > 0)) {
    return null;
  }
  const louder = 1 + r.loud * Math.max(loud - 1, 0);
  const tail = 1 + r.tail * Math.max(loud - 1, 0);
  const cutoff = airCutoff(r.absorption, r.cutoff.least, r.cutoff.most, far);
  return {
    delay: far / r.speed,
    level: r.level * fall * louder,
    pan: d < 1 ? 0 : panOf(listener, muzzle, look),
    cutoff,
    loud,
    echoes: r.echoes.map((e) => ({
      delay: e.delay * tail,
      level: e.level,
      cutoff: Math.min(e.cutoff, cutoff),
    })),
  };
}
