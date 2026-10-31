// SPDX-License-Identifier: AGPL-3.0-only

// The sky at a boat as one of seven decals, from its weather in the
// harbourmaster's board's words, so the two never disagree: the card of a
// sailor to watch shows it, and the server makes the same for its list. A
// storm near outranks the sky's words; a fair sky with less wind than
// force 1 is calm.

import { type Box, forceOf, NEAR, type PlaceWeather, SKIES } from './words';

/** The decals of the sky at the boat. */
export type PocketSky = 'fair' | 'showers' | 'rain' | 'squalls' | 'fog' | 'storm' | 'calm';

/** Each decal in words. */
export const SKY_WORDS: Record<PocketSky, string> = {
  fair: 'fair',
  showers: 'showers',
  rain: 'rain',
  squalls: 'squalls',
  fog: 'fog',
  storm: 'a storm',
  calm: 'calm',
};

/** The decal of a place's weather and its box. */
export function pocketSkyOf(w: PlaceWeather, box: Box): PocketSky {
  if (w.points.some((p) => (p.near & NEAR.storm) !== 0)) {
    return 'storm';
  }
  switch (SKIES.indexOf(box.sky.toLowerCase() as (typeof SKIES)[number])) {
    case 1:
      return 'showers';
    case 2:
      return 'fog';
    case 3:
      return 'rain';
    case 4:
    case 5:
      return 'squalls';
  }
  return forceOf(w.points[0]?.mean ?? 0) < 1 ? 'calm' : 'fair';
}
