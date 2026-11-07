// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { BODY, SKY } from '../predict/physics';
import { builtLooks, readRoom, skyRecord, writeRoom } from './dressing';

describe('the room’s hash', () => {
  test('gives each view its own clip and light', () => {
    expect(readRoom('#sailors')).toMatchObject({
      view: 'lineup',
      clip: 'standing-idle',
      light: 'noon',
    });
    expect(readRoom('#sailors&view=deck')).toMatchObject({ clip: 'helm', light: 'noon' });
    expect(readRoom('#sailors&view=picker')).toMatchObject({ light: 'morning' });
  });

  test('reads what it says, and ignores what it cannot use', () => {
    const r = readRoom(
      '#sailors&view=face&light=dusk&level=far&main=9b2226&skin=nope&t=2.5&black=1',
    );
    expect(r).toMatchObject({
      view: 'face',
      light: 'dusk',
      level: 'far',
      main: '9B2226',
      skin: 'B2815F',
      t: 2.5,
      black: true,
      phone: false,
    });
    expect(readRoom('#sailors&view=attic&level=huge').view).toBe('lineup');
    expect(readRoom('#sailors&view=attic&level=huge').level).toBe('close');
    expect(readRoom('#sailors&look=rover').look).toBe('rover');
    expect(readRoom('#sailors&look=../x').look).toBe('');
    // The boat by its place in the catalog, within it.
    expect(readRoom('#sailors').boat).toBe(0);
    expect(readRoom('#sailors&boat=1').boat).toBe(Math.min(1, catalog.boats.length - 1));
    expect(readRoom('#sailors&boat=99').boat).toBe(catalog.boats.length - 1);
    expect(readRoom('#sailors&boat=-3').boat).toBe(0);
  });

  test('writes only what differs from the view’s defaults, and reads back the same', () => {
    expect(writeRoom(readRoom('#sailors&view=deck'))).toBe('#sailors&view=deck');
    const hash =
      '#sailors&view=lineup&clip=helm-idle&side=back&hair=C9AC7E&mask=1&phone=1&t=1&look=test&boat=1';
    expect(writeRoom(readRoom(hash))).toBe(hash);
  });
});

test('the built looks are found by folder, version and level', () => {
  const looks = builtLooks({
    '../../../art/sailors/test/female.glb': 'a',
    '../../../art/sailors/test/female.deck.glb': 'b',
    '../../../art/sailors/test/female.far.glb': 'c',
    '../../../art/sailors/test/female.clips.glb': 'd',
    '../../../art/sailors/test/male.glb': 'e',
    '../../../art/sailors/rover/female.glb': 'f',
  });
  expect(looks.map((l) => l.look)).toEqual(['rover', 'test']);
  const test = looks[1]?.versions;
  expect(test?.get('female')).toEqual({ levels: { close: 'a', deck: 'b', far: 'c' }, clips: 'd' });
  expect(test?.get('male')).toEqual({ levels: { close: 'e' } });
});

test('the sky’s record puts the sun up by day and down at night', () => {
  const height = (r: Float64Array, at: number) => r[at + BODY.altitude] ?? 0;
  expect(height(skyRecord('noon'), SKY.sun)).toBeCloseTo((55 * Math.PI) / 180, 10);
  expect(height(skyRecord('night'), SKY.sun)).toBeLessThan(0);
  expect(height(skyRecord('night'), SKY.moon)).toBeGreaterThan(0);
  const r = skyRecord('dusk');
  const len = Math.hypot(
    r[SKY.sun + BODY.east] ?? 0,
    r[SKY.sun + BODY.north] ?? 0,
    r[SKY.sun + BODY.up] ?? 0,
  );
  expect(len).toBeCloseTo(1, 10);
});
