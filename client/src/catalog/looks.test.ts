// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { catalog } from '.';
import {
  artOf,
  codeOf,
  coloursOf,
  drawLook,
  hairsOf,
  type Look,
  lookOf,
  lookWords,
  MACHINE,
  MACHINE_MARK,
  validLook,
} from './looks';

describe('a look', () => {
  test('codes and decodes to itself, every look, version and option, and no two the same', () => {
    const seen = new Set<number>();
    const add = (l: Look) => {
      const c = codeOf(catalog, l);
      expect(validLook(catalog, l)).toBe(true);
      expect(c).toBeLessThan(2 ** 20);
      expect(seen.has(c)).toBe(false);
      seen.add(c);
      expect(lookOf(catalog, c)).toEqual(l);
    };
    const o = catalog.sailorOptions;
    for (const s of catalog.sailors) {
      for (const v of s.versions) {
        for (const skin of o.skins) {
          for (const hair of hairsOf(catalog, s)) {
            for (const colour of o.colours) {
              add({ look: s.id, version: v.id, skin: skin.id, hair: hair.id, colour: colour.id });
            }
          }
        }
      }
    }
    for (const v of catalog.machine.versions) {
      for (const f of catalog.machine.finishes) {
        for (const colour of o.colours) {
          add({ look: MACHINE, version: v.id, finish: f.id, colour: colour.id });
        }
      }
    }
    expect(seen.size).toBe(7 * 2 * 6 * 6 * 8 + 2 * 2 * 6 * 4 * 8 + 2 * 4 * 8);
  });

  test('codes as the server does: five fields of 4 bits from the low end', () => {
    const s = catalog.sailors[6];
    const l: Look = {
      look: s?.id ?? '',
      version: s?.versions[1]?.id ?? '',
      skin: catalog.sailorOptions.skins[4]?.id ?? '',
      hair: s === undefined ? '' : (hairsOf(catalog, s)[2]?.id ?? ''),
      colour: catalog.sailorOptions.colours[1]?.id ?? '',
    };
    expect(codeOf(catalog, l)).toBe(0x12416);
    expect(lookOf(catalog, MACHINE_MARK)?.look).toBe(MACHINE);
  });

  test('not made of the catalog’s choices is refused', () => {
    const good = drawLook(catalog, () => 0.5);
    expect(validLook(catalog, { ...good, skin: 'nobody' })).toBe(false);
    expect(validLook(catalog, { ...good, finish: catalog.machine.finishes[0]?.id ?? '' })).toBe(
      false,
    );
    expect(codeOf(catalog, { look: 'nobody', version: '', colour: '' })).toBe(0);
    expect(lookOf(catalog, 2 ** 20)).toBeNull();
    expect(lookOf(catalog, 14)).toBeNull();
  });

  test('drawn at random is any look, version and option', () => {
    const seen = new Set<string>();
    let r = 1;
    const random = () => {
      r = (r * 16807) % 2147483647;
      return r / 2147483647;
    };
    for (let i = 0; i < 2000; i++) {
      const l = drawLook(catalog, random);
      expect(validLook(catalog, l)).toBe(true);
      seen.add(`${l.look} ${l.version}`);
    }
    expect(seen.size).toBe(2 * catalog.sailors.length);
  });

  test('says itself in words, and has its art and colours', () => {
    const s = catalog.sailors[6];
    const l = lookOf(catalog, 0x12416) as Look;
    const o = catalog.sailorOptions;
    expect(lookWords(catalog, l)).toBe(
      [s?.name, s?.versions[1]?.name, o.colours[1]?.name, o.skins[4]?.name, o.greys[2]?.name].join(
        ', ',
      ),
    );
    expect(artOf(catalog, l)).toBe(s?.versions[1]?.art);
    expect(coloursOf(catalog, l)).toEqual({
      main: o.colours[1]?.colour,
      skin: o.skins[4]?.colour,
      hair: o.greys[2]?.colour,
    });
    const m = lookOf(catalog, MACHINE_MARK) as Look;
    expect(lookWords(catalog, m)).toBe(
      `Machine, ${catalog.machine.versions[0]?.name}, ${catalog.machine.finishes[0]?.name}, ${o.colours[0]?.name}`,
    );
    expect(coloursOf(catalog, m).hair).toBe(catalog.machine.lamp);
  });
});
