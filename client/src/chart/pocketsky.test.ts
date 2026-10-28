// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { pocketSkyOf, pusherName } from './pocketsky';
import { type Box, NEAR, type PlaceSample, type PlaceWeather } from './words';

const KNOT = 1852 / 3600;

function weather(mean: number, near = 0): PlaceWeather {
  const p: PlaceSample = {
    mean: mean * KNOT,
    from: 0,
    gust: mean * KNOT,
    rain: 0,
    visibility: 20000,
    near,
  };
  return { points: [p, p], pressure: 1013, before: 1013, quarter: 1013, cyclonic: false };
}

function box(sky: string): Box {
  return { wind: '', gusts: '', sky, visibility: '', barometer: '' };
}

describe('the weather pusher’s decal', () => {
  test('is the sky of the board’s words', () => {
    const w = weather(12);
    expect(pocketSkyOf(w, box('Fair'))).toBe('fair');
    expect(pocketSkyOf(w, box('Showers'))).toBe('showers');
    expect(pocketSkyOf(w, box('Fog patches'))).toBe('fog');
    expect(pocketSkyOf(w, box('Rain'))).toBe('rain');
    expect(pocketSkyOf(w, box('Squally showers'))).toBe('squalls');
    expect(pocketSkyOf(w, box('Squalls with heavy rain'))).toBe('squalls');
  });

  test('is a storm while one is near, whatever the words', () => {
    expect(pocketSkyOf(weather(12, NEAR.storm), box('Fair'))).toBe('storm');
    expect(pocketSkyOf(weather(30, NEAR.storm | NEAR.squall), box('Squalls with heavy rain'))).toBe(
      'storm',
    );
  });

  test('is calm under force 1, in a fair sky only', () => {
    expect(pocketSkyOf(weather(0.4), box('Fair'))).toBe('calm');
    expect(pocketSkyOf(weather(1), box('Fair'))).toBe('fair');
    expect(pocketSkyOf(weather(0.4), box('Fog patches'))).toBe('fog');
  });

  test('its name carries the sky, and the moon by night', () => {
    expect(pusherName(null)).toBe('Weather on the pocket chart');
    expect(pusherName({ sky: 'rain', night: false })).toBe(
      'Weather on the pocket chart; here, rain',
    );
    expect(pusherName({ sky: 'storm', night: true })).toBe(
      'Weather on the pocket chart; here, a storm',
    );
    expect(pusherName({ sky: 'fair', night: true })).toBe(
      'Weather on the pocket chart; here, fair, by night',
    );
  });
});
