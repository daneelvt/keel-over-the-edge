// SPDX-License-Identifier: AGPL-3.0-only

// The sky at the boat now, as the pocket chart's weather pusher shows it:
// read as the harbourmaster's board reads its "Now", from the same points
// a quarter of a mile about, put into the same words, so the two never
// disagree; then one of seven decals. A storm near outranks the sky's
// words; a fair sky with less wind than force 1 is calm.

import { catalog } from '../catalog';
import { pointsAbout } from './board';
import type { Forecasting } from './forecasting';
import { weatherAt } from './placeweather';
import { type Box, boxOf, forceOf, NEAR, type PlaceWeather, SKIES, wordsOf } from './words';

/** The decals of the sky at the boat. */
export type PocketSky = 'fair' | 'showers' | 'rain' | 'squalls' | 'fog' | 'storm' | 'calm';

/** Each decal in words, for the pusher's name. */
export const SKY_WORDS: Record<PocketSky, string> = {
  fair: 'fair',
  showers: 'showers',
  rain: 'rain',
  squalls: 'squalls',
  fog: 'fog',
  storm: 'a storm',
  calm: 'calm',
};

/** The sky the pusher shows: its decal, by night the moon for the sun. */
export interface SkyShown {
  sky: PocketSky;
  night: boolean;
}

/** The weather pusher's name: what it switches, and the sky at the boat once read. */
export function pusherName(shown: SkyShown | null): string {
  return shown === null
    ? 'Weather on the pocket chart'
    : `Weather on the pocket chart; here, ${SKY_WORDS[shown.sky]}${shown.night && shown.sky === 'fair' ? ', by night' : ''}`;
}

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

/** The decal of the weather at a point now. */
export async function pocketSkyAt(
  src: Forecasting,
  east: number,
  north: number,
): Promise<PocketSky> {
  const fields = await src.made();
  const w = weatherAt(
    fields,
    src,
    { kind: 'now', tick: src.tick(), minutes: 0, issue: null },
    pointsAbout(east, north),
  );
  return pocketSkyOf(w, boxOf(w, wordsOf(catalog.weather)));
}
