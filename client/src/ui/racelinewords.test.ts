// SPDX-License-Identifier: AGPL-3.0-only

// The race line in each of its states: before the start (the class's
// flag, then P in the last minute; the countdown; the line's distance,
// and Over on the course's side), a time trial waiting for its crossing,
// racing (the place of how many, the gap to the boat ahead or the lead,
// the next mark's bearing and distance and which way to turn), home,
// retired and out of it; and the calls a boat is told, in the log's words.

import { describe, expect, test } from 'vitest';
import type { RaceCallIn, RacerAtIn } from '../net/messages';
import {
  awardLines,
  awardName,
  bearingOf,
  callLine,
  clockOf,
  countdownOf,
  distanceOf,
  gapWords,
  legLabel,
  lineSide,
  lineView,
  medalName,
  ordinal,
  resultWords,
} from './racelinewords';
import { course, racer } from './racesamples';

const START = 1000 + 120 * 30;

describe('the words of numbers', () => {
  test('places, clocks, distances and bearings', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '101st',
    ]);
    expect(clockOf(247.9)).toBe('4:07');
    expect(clockOf(3727)).toBe('1:02:07');
    expect(countdownOf(101.2)).toBe('−1:42');
    expect(distanceOf(312)).toBe('310 m');
    expect(distanceOf(1150)).toBe('0.62 NM');
    expect(bearingOf(45)).toBe('045°');
    expect(bearingOf(-10)).toBe('350°');
  });
});

describe('before the start', () => {
  const at = (north: number, tick: number) =>
    lineView({
      told: course(),
      me: racer({ north }),
      racers: [racer({ north }), racer({ number: 2 })],
      tick,
      boat: { east: 0, north, heading: 0 },
      finish: null,
    });

  test('the class’s flag two minutes out, P in the last minute, the line below', () => {
    expect(at(-40, START - 100 * 30)).toEqual({
      kind: 'before',
      flag: 'class',
      clock: '−1:40',
      line: '40 m to the line',
      over: false,
    });
    expect(at(-40, START - 42 * 30)).toMatchObject({ flag: 'P', clock: '−0:42' });
  });

  test('over the line on the course’s side, whichever way the line was laid', () => {
    expect(at(12, START - 20 * 30)).toMatchObject({ line: 'Over · 10 m', over: true });
    const flipped = course({ pin: { east: 30, north: 0 }, committee: { east: -30, north: 0 } });
    expect(lineSide(flipped, { east: 0, north: 12 })).toEqual({ metres: 12, over: true });
    expect(lineSide(flipped, { east: 0, north: -12 })).toEqual({ metres: 12, over: false });
    // Beyond the line's end, as far as the nearer end; on the course's
    // side well beyond it, not over, as the committee judges.
    expect(lineSide(course(), { east: 70, north: -30 })?.metres).toBeCloseTo(50);
    expect(lineSide(course(), { east: 40, north: 5 })?.over).toBe(true);
    expect(lineSide(course(), { east: 70, north: 5 })?.over).toBe(false);
  });

  test('a time trial waits for its boat to cross', () => {
    expect(
      lineView({
        told: course({ trial: true, start: 0 }),
        me: racer({}),
        racers: [racer({})],
        tick: 50_000,
        boat: { east: 0, north: -30, heading: 0 },
        finish: null,
      }),
    ).toEqual({ kind: 'trial', line: '30 m to the line', over: false });
  });
});

describe('racing', () => {
  const racers = [
    racer({ number: 3, place: 1, gap: 0, state: 'racing', leg: 2 }),
    racer({ number: 2, place: 2, gap: 6.5, state: 'racing', leg: 1 }),
    racer({ number: 1, place: 3, gap: 24.5, state: 'racing', leg: 1 }),
    racer({ number: 4, place: 0, state: 'dns' }),
  ];

  test('the place of those that started, the gap to the boat ahead, the next mark', () => {
    const v = lineView({
      told: course(),
      me: racers[2] ?? null,
      racers,
      tick: START + 300 * 30,
      boat: { east: 0, north: 90, heading: Math.PI / 2 },
      finish: null,
    });
    expect(v).toEqual({
      kind: 'racing',
      place: '3/3',
      gap: '+0:18',
      next: { label: 'Mk 1', bearing: '000°', distance: '310 m', turn: -90 },
    });
  });

  test('the leader’s lead, the finish as the last leg, a trial’s clock', () => {
    expect(gapWords(racers[0] as RacerAtIn, racers)).toBe('lead 0:06');
    expect(legLabel(course(), 2)).toBe('Finish');
    expect(legLabel(course(), 0)).toBe('Line');
    const v = lineView({
      told: course({ trial: true }),
      me: racer({ state: 'racing', leg: 2 }),
      racers: [racer({ state: 'racing', leg: 2 })],
      tick: START + 247 * 30,
      boat: { east: 0, north: 300, heading: Math.PI },
      finish: null,
    });
    expect(v).toMatchObject({ kind: 'racing', place: '4:07', gap: '', next: { label: 'Finish' } });
  });
});

describe('home and out', () => {
  const base = {
    told: course(),
    racers: [racer({ place: 1, state: 'finished' }), racer({ number: 2, state: 'racing' })],
    tick: START + 700 * 30,
    boat: { east: 0, north: 0, heading: 0 },
  };
  test('home, its place of how many, its time and the seconds added', () => {
    expect(
      lineView({
        ...base,
        me: racer({ place: 2, state: 'finished' }),
        finish: { race: 3, number: 1, place: 2, elapsedMs: 604_200, added: 10 },
      }),
    ).toEqual({ kind: 'done', text: 'Home 2nd of 2 · 10:04 · 10 s added' });
  });
  test('retired, out of it, and placed as the race ended', () => {
    expect(lineView({ ...base, me: racer({ state: 'retired' }), finish: null })).toMatchObject({
      text: 'Retired · the results when the race ends',
    });
    expect(lineView({ ...base, me: racer({ state: 'dns' }), finish: null }).kind).toBe('done');
    expect(
      lineView({ ...base, me: racer({ state: 'placedAtEnd', place: 2 }), finish: null }),
    ).toMatchObject({ text: '2nd of 2 · placed as the race ended' });
  });
});

describe('calls', () => {
  const call = (over: Partial<RaceCallIn>): RaceCallIn => ({
    race: 3,
    kind: 'bump',
    number: 1,
    other: 2,
    article: '10',
    mark: 0,
    added: 10,
    place: 0,
    ...over,
  });
  const name = (n: number) => (n === 2 ? 'the Petrel, 2' : 'Mira');

  test('a bump in the log’s words, to the boat at fault and the boat bumped', () => {
    expect(callLine(call({}), 1, name)).toEqual({
      text: 'Port tack keeps clear of starboard · 10 seconds added',
      short: 'Port keeps clear of starboard · +10 s',
      warn: true,
    });
    expect(callLine(call({ number: 2, other: 1, article: '16.1' }), 1, name)).toEqual({
      text: 'A boat with right of way changing course gives room · 10 seconds to the Petrel, 2',
      short: 'Changing course, give room · +10 s to the Petrel, 2',
      warn: false,
    });
    expect(callLine(call({ number: 2, other: 3 }), 1, name)).toBeNull();
  });

  test('over early, a mark missed, drifting, retired and a rounding: the boat’s own', () => {
    expect(callLine(call({ kind: 'overEarly' }), 1, name)?.text).toBe(
      'Over early · 10 seconds added',
    );
    expect(callLine(call({ kind: 'missedMark', mark: 2 }), 1, name)?.text).toBe(
      'Mark 2 missed: go back',
    );
    expect(callLine(call({ kind: 'drifting' }), 1, name)?.warn).toBe(true);
    expect(callLine(call({ kind: 'rounded', mark: 1, place: 3 }), 1, name)?.text).toBe(
      'Mark 1 rounded · 3rd',
    );
    expect(callLine(call({ kind: 'overEarly', number: 2 }), 1, name)).toBeNull();
  });
});

describe('the results’ words', () => {
  test('the awards read warmly, a photo finish’s two boats in one line', () => {
    const name = (n: number) => ['', 'Mira', 'the Petrel, 2', 'Iron Mary ⚙', 'Old Tom'][n] ?? '';
    expect(
      awardLines(
        [
          { number: 1, awards: ['best-start', 'photo-finish'] },
          { number: 2, awards: ['photo-finish'] },
          { number: 3, awards: [] },
          { number: 4, awards: ['spoon'] },
        ],
        name,
      ),
    ).toEqual([
      'Best start to Mira, away clean with the gun',
      'A photo finish! Mira and the Petrel, 2, within two seconds',
      'The wooden spoon to Old Tom, who never gave up',
    ]);
    expect(awardName('crowd')).toBe('Crowd’s favourite');
    expect(medalName('harbourmaster')).toBe('The harbourmaster’s time');
  });
  test('a time, the way to go, or why there is no place', () => {
    expect(resultWords({ how: 'finished', elapsedMs: 604_200, toGo: 0, added: 10 })).toBe(
      '10:04 · +10 s',
    );
    expect(resultWords({ how: 'placed', elapsedMs: 0, toGo: 222, added: 0 })).toBe('220 m to go');
    expect(resultWords({ how: 'ret', elapsedMs: 0, toGo: 0, added: 0 })).toBe('Retired');
  });
});
