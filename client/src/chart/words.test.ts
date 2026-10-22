// SPDX-License-Identifier: AGPL-3.0-only

// The page's words of the weather are the server's: the same box, outlook,
// gale warning and general situation for every case of
// internal/weather/testdata/words.json, made from the same fields.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import {
  type Box,
  boxOf,
  generalSituation,
  type OutlookSample,
  outlook,
  type PlaceWeather,
  type Situation,
  type Warning,
  type Words,
  warningParts,
  warningText,
  wordsOf,
} from './words';

interface WordsFile {
  words: Words;
  boxes: { weather: PlaceWeather; box: Box }[];
  outlooks: { samples: OutlookSample[]; falls: boolean; outlook: string }[];
  warnings: { warning: Warning; wind: string; when: string; where: string; text: string }[];
  situations: { situation: Situation; lines: string[] }[];
}

const file = JSON.parse(
  readFileSync(new URL('../../../internal/weather/testdata/words.json', import.meta.url), 'utf8'),
) as WordsFile;

describe('the words of the weather', () => {
  test('are made with the catalog’s thresholds, as the server’s are', () => {
    expect(wordsOf(catalog.weather)).toEqual(file.words);
  });

  test('a box', () => {
    for (const c of file.boxes) {
      expect(boxOf(c.weather, file.words)).toEqual(c.box);
    }
  });

  test('an outlook', () => {
    for (const c of file.outlooks) {
      expect(outlook(c.samples, c.falls, file.words)).toBe(c.outlook);
    }
  });

  test('a gale warning', () => {
    for (const c of file.warnings) {
      expect(warningText(c.warning, file.words)).toBe(c.text);
      expect(warningParts(c.warning, file.words)).toEqual({
        wind: c.wind,
        when: c.when,
        where: c.where,
      });
    }
  });

  test('the general situation', () => {
    for (const c of file.situations) {
      expect(generalSituation(c.situation, file.words)).toEqual(c.lines);
    }
  });
});
