// SPDX-License-Identifier: AGPL-3.0-only

// Racing on the world page: the form filled with the settings as they
// are, the change it asks for (only the fields that differ, hours as
// seconds), none while a field is not a number keel could take, and the
// settings in words.

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { changeOf, fieldsOf, type RaceSettings, racingWords } from './racing';

const settings: RaceSettings = {
  ahead: 2,
  daily: 8,
  made: 8,
  owned: 3,
  cutoff: 10_800,
  every: 3,
  boats: catalog.boats.slice(0, 2).map((b) => b.id),
  greenhornUS: 50,
};

describe('the racing settings', () => {
  test('unchanged, the form asks for nothing', () => {
    expect(changeOf(settings, fieldsOf(settings))).toEqual({});
  });

  test('only the fields changed, the cutoff in seconds', () => {
    const [a = '', b = ''] = catalog.boats.map((k) => k.id);
    const s = { ...settings, boats: [a, b] };
    const f = { ...fieldsOf(s), daily: '10', cutoff: '2.5', boats: `${b}, ${a} ,${a}` };
    expect(changeOf(s, f)).toEqual({ daily: 10, cutoff: 9000, boats: [b, a, a] });
  });

  test('a field that is no whole number asks for nothing', () => {
    expect(changeOf(settings, { ...fieldsOf(settings), ahead: '1.5' })).toBeNull();
    expect(changeOf(settings, { ...fieldsOf(settings), made: '' })).toBeNull();
    expect(changeOf(settings, { ...fieldsOf(settings), cutoff: '-1' })).toBeNull();
    expect(changeOf(settings, { ...fieldsOf(settings), boats: 'no-such-boat' })).toBeNull();
    expect(changeOf(settings, { ...fieldsOf(settings), boats: ' , ' })).toBeNull();
  });

  test('in words', () => {
    const w = new Map(racingWords(settings));
    expect(w.get('Races started a day')).toBe('8 races');
    expect(w.get('Last start before the end')).toBe('3 hours');
    expect(w.get('Harbour races')).toBe('every 3 hours');
    expect(w.get('Greenhorn Cups at US hours')).toBe('50%');
  });
});
