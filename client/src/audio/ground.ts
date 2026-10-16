// SPDX-License-Identifier: AGPL-3.0-only

// A hull meeting the ground, as numbers: a scrape where it runs onto a soft
// bottom, the recipe in art/sound/scrape.json mapped onto the boat's speed;
// a knock, as of a bump (knock.ts), where it strikes land or a hard bottom.

import scrape from '../../../art/sound/scrape.json';
import { ramp } from './voices';

export type ScrapeRecipe = typeof scrape;
export const SCRAPE: ScrapeRecipe = scrape;

export interface Scrape {
  /** The noise's band, Hz, and its Q. */
  band: number;
  q: number;
  /** How long it swells and how long it dies away, s. */
  rise: number;
  decay: number;
  /** Its level, as a gain. */
  level: number;
}

/** The scrape of a hull running onto the bottom at speed m/s. */
export function scrapeOf(r: ScrapeRecipe, speed: number): Scrape {
  const v = Math.max(0, speed);
  const hard = ramp(r.level.from, r.level.full, v);
  return {
    band: Math.min(r.band.most, r.band.atRest + r.band.perSpeed * v),
    q: r.q,
    rise: r.rise,
    decay: r.decay,
    level: hard > 0 ? r.level.least + (r.level.most - r.level.least) * hard : 0,
  };
}

/**
 * How a boat met the ground in its latest step, from Out's aground (0
 * afloat, 1 on the bottom, 2 against land) and the bed's friction under
 * it: a knock against land or a hard bottom, a scrape on a soft one.
 */
export function groundSound(aground: number, bedFriction: number): 'knock' | 'scrape' | null {
  if (aground === 2) {
    return 'knock';
  }
  if (aground === 1) {
    return bedFriction >= HARD_BED ? 'knock' : 'scrape';
  }
  return null;
}

/** A bed as rough as this or rougher (rock) knocks rather than scrapes. */
export const HARD_BED = 0.55;
