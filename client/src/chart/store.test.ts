// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ChartEntry, CourseOpen } from '../net/messages';
import {
  ChartStore,
  courseFrame,
  courseLines,
  creditText,
  dayText,
  distanceText,
  edgeCaption,
  NM,
  pocketCaption,
} from './store';

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

  it('stops telling a listener that has let go, keeping no hold on it', () => {
    const s = new ChartStore(words);
    const told: string[] = [];
    const before = s.listening;
    const stop = s.onCharted((es) => told.push(...es.map((e) => s.title(e))));
    s.receive([entry({ number: 7, name: 'Keyhole Rock', by: 'Mira' })], false);
    stop();
    stop();
    s.receive([entry({ number: 8, name: 'Gull Reach', by: 'Mira' })], false);
    expect(told).toEqual(['Keyhole Rock']);
    expect(s.listening).toBe(before);
  });

  it('says how far the edge is: miles to a tenth, metres under a tenth of a mile', () => {
    expect(edgeCaption(0, 0, 8334)).toBe('edge 4.5 NM');
    expect(edgeCaption(8200, 0, 8334)).toBe('edge 134 m');
    expect(distanceText(0.1 * NM)).toBe('0.1 NM');
  });

  it('captions the pocket chart in a line or two, the chart in its name and never on it', () => {
    // Before the boat's first position: the edge's line kept, empty.
    expect(pocketCaption('', '')).toEqual({ lines: [''], name: 'Chart: open the chart' });
    expect(pocketCaption('', '6d 23h')).toEqual({
      lines: ['', 'new world 6d 23h'],
      name: 'Chart, new world 6d 23h: open the chart',
    });
    // With no world's end known, one line.
    expect(pocketCaption('edge 3.4 NM', '')).toEqual({
      lines: ['edge 3.4 NM'],
      name: 'Chart, edge 3.4 NM: open the chart',
    });
    expect(pocketCaption('edge 3.4 NM', '2d 17h')).toEqual({
      lines: ['edge 3.4 NM', 'new world 2d 17h'],
      name: 'Chart, edge 3.4 NM, new world 2d 17h: open the chart',
    });
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

function course(c: Partial<CourseOpen>): CourseOpen {
  return {
    number: 0,
    kind: 'round',
    name: 'Round Gannet Holm',
    way: [
      [1000, 0],
      [2000, 1000],
      [1000, 2000],
      [1000, 0],
    ],
    length: 4500,
    rounds: [{ subject: 'island', number: 7, starboard: true }],
    boats: [
      { kind: 0, seconds: 37 * 60 },
      { kind: 1, seconds: 26 * 60 + 20 },
    ],
    ...c,
  };
}

describe('the island courses', () => {
  it('are held as they open, each once, and dropped with the chart had whole', () => {
    const s = new ChartStore(words);
    s.receive([entry({ name: 'Port Royal' })], true, [course({})]);
    s.receive([], false, [
      course({}),
      course({ number: 2, name: 'Port Royal to Saltcliff', kind: 'passage' }),
    ]);
    expect(s.courses.map((c) => c.name)).toEqual(['Round Gannet Holm', 'Port Royal to Saltcliff']);
    const v = s.version.value;
    s.receive([], true);
    expect(s.courses).toHaveLength(0);
    expect(s.version.value).toBeGreaterThan(v);
  });

  it('are listed nearest start first, with where each starts, its length and the boats it suits', () => {
    const far = course({ number: 1, name: 'Round Saltcliff', way: [[-5000, 0]], kind: 'light' });
    const lines = courseLines([far, course({})], 0, 0, ['Jolly boat', 'Skiff']);
    expect(lines.map((l) => l.course.name)).toEqual(['Round Gannet Holm', 'Round Saltcliff']);
    expect(lines[0]?.where).toBe('090° 0.5 NM · 2.4 NM long');
    expect(lines[0]?.boats).toBe('Jolly boat 37 min · Skiff 26 min');
    expect(lines[0]?.kind).toBe('Round an island');
    expect(lines[1]?.kind).toBe('Round a light');
  });

  it('are framed whole on the chart', () => {
    const f = courseFrame(course({}));
    expect(f.east).toBe(1500);
    expect(f.north).toBe(1000);
    expect(f.distance).toBeGreaterThan(2000);
  });
});
