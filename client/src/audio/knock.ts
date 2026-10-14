// SPDX-License-Identifier: AGPL-3.0-only

// The knock of a bump, as numbers: the recipe in art/sound/bump.json mapped
// onto how hard the hulls closed and where the listener is. A thump of
// timber is a low, damped tone falling in pitch; the crack on top of it a
// short burst of noise in a band that brightens with the force of the blow
// (Farnell, Designing Sound, 2010, on impacts).

import bump from '../../../art/sound/bump.json';
import { ramp } from './voices';

export type KnockRecipe = typeof bump;
export const KNOCK: KnockRecipe = bump;

export interface Knock {
  /** The thump's starting frequency, Hz, and the share of it that it falls to. */
  thump: number;
  fall: number;
  thumpDecay: number;
  /** The crack's band, Hz, its Q, and its decay, s. */
  crack: number;
  q: number;
  crackDecay: number;
  /** Its level, as a gain, and where it is placed, −1 (left) … 1 (right). */
  level: number;
  pan: number;
}

/**
 * The knock of a bump the hulls closed at closing m/s, distance metres from
 * the listener, at bearing radians clockwise from where the listener faces.
 */
export function knockOf(r: KnockRecipe, closing: number, distance: number, bearing: number): Knock {
  const v = Math.max(0, closing);
  const hard = ramp(r.level.from, r.level.full, v);
  const near = r.distance / (r.distance + Math.max(0, distance));
  return {
    thump: Math.min(
      r.thump.frequency.most,
      r.thump.frequency.atRest + r.thump.frequency.perSpeed * v,
    ),
    fall: r.thump.fall,
    thumpDecay: r.thump.decay,
    crack: Math.min(r.crack.centre.most, r.crack.centre.atRest + r.crack.centre.perSpeed * v),
    q: r.crack.q,
    crackDecay: r.crack.decay,
    level: (r.level.least + (r.level.most - r.level.least) * hard) * near,
    pan: Math.max(-1, Math.min(1, Math.sin(bearing))),
  };
}
