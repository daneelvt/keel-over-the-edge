// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ChartEntry } from '../net/messages';
import { ChartStore, creditText, dayText, distanceText, edgeCaption, NM } from './store';

const words = {
  places: [{ name: 'Port' }, { name: 'Lighthouse' }],
  features: [{ name: 'Sea arch' }],
  scale: 10,
  lip: 8334,
  great: 20,
};

function entry(e: Partial<ChartEntry>): ChartEntry {
  return {
    subject: 'island',
    number: 0,
    sort: 0,
    name: '',
    east: 0,
    north: 0,
    by: '',
    ai: false,
    at: 0,
    worth: 1,
    island: -1,
    group: '',
    bounds: null,
    highest: 0,
    zone: 0,
    className: 'C',
    model: '',
    light: -1,
    character: 0,
    focal: 0,
    range: 0,
    ship: '',
    sunk: false,
    withSubject: null,
    withNumber: 0,
    ...e,
  };
}

describe('the chart’s store', () => {
  it('holds each subject once, and tells of what is charted, not of the chart had whole', () => {
    const s = new ChartStore(words);
    const told: string[] = [];
    s.onCharted((es) => told.push(...es.map((e) => s.title(e))));
    s.receive([entry({ name: 'Port Royal' })], true);
    s.receive([entry({ number: 7, name: 'Keyhole Rock', by: 'Mira', worth: 24 })], false);
    s.receive([entry({ number: 7, name: 'Keyhole Rock' })], false);
    s.receive([entry({ subject: 'feature', number: 3, sort: 0, island: 7 })], false);
    expect(s.size).toBe(3);
    expect(told).toEqual(['Keyhole Rock', 'a sea arch on Keyhole Rock']);
    s.me = 'Mira';
    const k = s.get('island', 7);
    expect(k && s.mine(k) && s.great(k)).toBe(true);
    s.receive([entry({ name: 'Port Royal' })], true);
    expect(s.size).toBe(1);
  });

  it('says how far the edge is: miles to a tenth, metres under a tenth of a mile', () => {
    expect(edgeCaption(0, 0, 8334)).toBe('Chart · edge 4.5 NM');
    expect(edgeCaption(8200, 0, 8334)).toBe('Chart · edge 134 m');
    expect(distanceText(0.1 * NM)).toBe('0.1 NM');
  });

  it('dates a charting in the viewer’s own time zone', () => {
    const at = Date.UTC(2026, 9, 20, 23, 30); // a Tuesday, 23:30 UTC
    const now = at + 3_600_000;
    expect(dayText(at, now, 'en-GB', 'UTC')).toBe('yesterday');
    expect(dayText(at, now, 'en-GB', 'Pacific/Auckland')).toBe('today');
    expect(dayText(at, at + 3 * 86_400_000, 'en-GB', 'UTC')).toBe('Tuesday');
    expect(creditText(entry({ by: 'Mira', at }), at + 60_000, 'UTC')).toBe(
      'Charted by Mira, today',
    );
    expect(creditText(entry({}), at)).toBe('Known');
  });
});
