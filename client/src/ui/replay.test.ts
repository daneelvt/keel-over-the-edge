// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import type { LaidCourse, ReplayBoat, ReplayTold } from './raceapi';
import {
  clockAt,
  linesOf,
  progressOf,
  ReplayModel,
  readTrack,
  standingsAt,
  trackAt,
  trackBetween,
} from './replay';

const SECOND = 30;
const EVERY = 60;

/** A windward–leeward course: the line across (0, 0), the mark 400 m north, home over the line. */
const course: LaidCourse = {
  line: [-30, 0, 30, 0],
  finish: [-30, 0, 30, 0],
  marks: [[0, 400, 1, -1]],
  way: [0, 0, 0, 400, 0, 0],
  legs: [
    [0, 0, 0],
    [1, 0, 400],
    [0, 0, 0],
  ],
  east: 0,
  north: 200,
  reach: 450,
  laps: 1,
  expected: 600,
};

/** A track from the warning, two seconds a sample, through points m. */
function track(points: [number, number][], first = 0) {
  const p: number[] = [];
  let x = 0;
  let y = 0;
  for (const [e, n] of points) {
    p.push(e - x, n - y);
    x = e;
    y = n;
  }
  return { first, every: EVERY, p };
}

/** A boat sailing up to the mark and back at speed m a sample from the gun (sample 2), placed below the line before it. */
function sailing(speed: number, samples: number): [number, number][] {
  const out: [number, number][] = [
    [0, -20],
    [0, -10],
  ];
  let n = 0;
  let up = true;
  for (let i = 2; i < samples; i++) {
    n += up ? speed : -speed;
    if (n >= 400) {
      n = 800 - n;
      up = false;
    }
    out.push([up ? 0 : 5, Math.max(n, -5)]);
  }
  return out;
}

function boat(over: Partial<ReplayBoat>): ReplayBoat {
  return {
    number: 1,
    name: 'Mira',
    boat: 'Gull',
    machine: false,
    place: 1,
    how: 'finished',
    elapsed: 100,
    added: 0,
    marks: 1,
    toGo: -1,
    awards: [],
    ...over,
  };
}

/** A race of three: Mira fastest home, Tom second, Pip retired half way up. The gun at sample 2 (tick 120). */
function race(): ReplayTold {
  return {
    code: 'abcdefghij',
    link: 'https://keel.example/?r=abcdefghij',
    name: 'Tuesday Triangle',
    kind: 'race',
    boat: { id: 'jolly-boat', name: 'Jolly boat' },
    course: 'Short windward–leeward off Port Royal',
    world: 14,
    harbour: false,
    newcomers: false,
    at: 0,
    kept: true,
    second: SECOND,
    runs: [
      {
        run: 0,
        warning: 0 - 3600,
        start: 120,
        ended: 120 + 60 * EVERY,
        course,
        prizes: true,
        boats: [
          boat({ number: 1, place: 1, elapsed: 80, track: track(sailing(20, 42)) }),
          boat({
            number: 2,
            name: 'Tom',
            place: 2,
            elapsed: 100,
            track: track(sailing(16, 52)),
          }),
          boat({
            number: 3,
            name: null,
            boat: 'Petrel',
            place: 0,
            how: 'ret',
            elapsed: -1,
            track: track(sailing(10, 12)),
          }),
        ],
      },
    ],
  };
}

describe('a track read', () => {
  test('its samples where they were, between them where the boat was', () => {
    const t = readTrack(
      track(
        [
          [0, 0],
          [10, 0],
          [10, 20],
        ],
        600,
      ),
    );
    expect([...t.east]).toEqual([0, 10, 10]);
    expect([...t.north]).toEqual([0, 0, 20]);
    expect(trackAt(t, 599)).toBeNull();
    expect(trackAt(t, 600)).toEqual({ east: 0, north: 0, i: 0 });
    expect(trackAt(t, 630)).toEqual({ east: 5, north: 0, i: 0.5 });
    expect(trackAt(t, 690)).toEqual({ east: 10, north: 10, i: 1.5 });
    // After its last, at its last.
    expect(trackAt(t, 9999)).toEqual({ east: 10, north: 20, i: 2 });
  });

  test('drawn to the slider’s moment, ending where the boat was', () => {
    const t = readTrack(
      track([
        [0, 0],
        [10, 0],
        [10, 20],
      ]),
    );
    expect(trackBetween(t, 0, 90)).toEqual([0, 0, 10, 0, 10, 10]);
    expect(trackBetween(t, 30, 60)).toEqual([5, 0, 10, 0]);
    expect(trackBetween(t, 60, 60)).toEqual([]);
  });
});

describe('progress round the course', () => {
  test('nothing before the gun, the mark made near it, never going back', () => {
    const t = readTrack(track(sailing(20, 42)));
    const p = progressOf(t, course.legs, 120);
    expect(p.total).toBe(800);
    expect(p.progress[1]).toBe(-1);
    expect(p.progress[2]).toBeCloseTo(20);
    expect(p.leg[2]).toBe(1);
    // At the mark (sample 22, n = 400): the first leg made.
    expect(p.leg[24]).toBe(2);
    expect(p.progress[30]).toBeGreaterThan(400);
    for (let i = 3; i < p.progress.length; i++) {
      expect(p.progress[i]).toBeGreaterThanOrEqual(p.progress[i - 1] ?? 0);
    }
  });
});

describe('the standings at the slider’s moment', () => {
  const lines = linesOf(race());

  test('on the line before the gun, by number', () => {
    const s = standingsAt(lines, -10, SECOND);
    expect(s.map((x) => [x.key, x.state, x.place])).toEqual([
      [1, 'line', 0],
      [2, 'line', 0],
      [3, 'line', 0],
    ]);
  });

  test('racing by their progress, the way left told', () => {
    const s = standingsAt(lines, 10, SECOND);
    expect(s.map((x) => x.key)).toEqual([1, 2, 3]);
    expect(s.map((x) => x.place)).toEqual([1, 2, 3]);
    expect(s[0]?.toGo).toBeCloseTo(800 - 20 * 6, 0);
    expect(s[1]?.toGo).toBeCloseTo(800 - 16 * 6, 0);
    expect(s[0]?.state).toBe('racing');
  });

  test('home by the place, a boat gone out of the race last', () => {
    const s = standingsAt(lines, 85, SECOND);
    expect(s.map((x) => [x.key, x.state, x.place])).toEqual([
      [1, 'home', 1],
      [2, 'racing', 2],
      [3, 'retired', 0],
    ]);
  });
});

describe('a replay at the slider’s moment', () => {
  test('from the warning to the last boat’s end, its finish reached; the player’s boat followed', () => {
    const told = race();
    const b = told.runs[0]?.boats[1];
    if (b !== undefined) {
      b.me = true;
    }
    const m = new ReplayModel(told);
    expect(m.lo).toBe(-124);
    // Tom's last sample is 98 s from the gun; he was home at 100.
    expect(Math.ceil((51 * EVERY - 120) / SECOND)).toBe(98);
    expect(m.hi).toBe(100);
    expect(m.t.value).toBe(m.lo);
    expect(m.followed.value).toBe(2);
  });

  test('the tracks to the moment, the dots where the boats were, the leader and the followed boat’s next mark', () => {
    const m = new ReplayModel(race());
    m.setTime(20);
    const d = m.drawing();
    expect(d).not.toBeNull();
    if (d === null) {
      return;
    }
    expect(d.watched).toBe(1);
    expect(d.leader).toBe(1);
    expect(d.next).toBe(1);
    const mira = d.boats.find((b) => b.number === 1);
    // 20 s from the gun is ten samples on, 220 m up.
    expect(mira?.north).toBeCloseTo(220, 0);
    expect(mira?.place).toBe(1);
    const tr = d.tracks.get(1) ?? [];
    expect(tr.at(-1)).toBeCloseTo(220, 0);
    expect(tr.slice(0, 2)).toEqual([0, 20]);
    // Pip, retired after 12 samples, has no dot later.
    m.setTime(60);
    expect(m.drawing()?.boats.some((b) => b.number === 3)).toBe(false);
    expect(m.drawing()?.name(3)).toBe('the Petrel, 3');
  });

  test('play at 30× moves the slider thirty seconds a second, and stops at the end', () => {
    const m = new ReplayModel(race());
    m.setTime(0);
    m.speed.value = 30;
    m.toggle();
    m.play(1000);
    expect(m.t.value).toBe(30);
    m.play(100_000);
    expect(m.t.value).toBe(m.hi);
    expect(m.playing.value).toBe(false);
    // Play again from the start.
    m.toggle();
    expect(m.t.value).toBe(m.lo);
  });

  test('a boat followed by a tap; one with no track cannot be', () => {
    const m = new ReplayModel(race());
    expect(m.follow(2)).toBe(true);
    expect(m.drawing()?.watched).toBe(2);
    expect(m.follow(9)).toBe(false);
  });

  test('a time trial’s runs sail together, each from its own start, the fastest first', () => {
    const told: ReplayTold = {
      ...race(),
      kind: 'trial',
      runs: [
        {
          run: 1,
          start: 10_000,
          course,
          prizes: false,
          boats: [boat({ number: 1, elapsed: 100, track: track(sailing(16, 52), 10_000 - 120) })],
        },
        {
          run: 2,
          start: 50_000,
          course,
          prizes: false,
          boats: [
            boat({
              number: 1,
              elapsed: 80,
              medal: 'gold',
              track: track(sailing(20, 42), 50_000 - 120),
            }),
          ],
        },
      ],
    };
    const m = new ReplayModel(told);
    expect(m.lines.map((l) => [l.key, l.run, l.name])).toEqual([
      [1, 2, 'Mira, run 2'],
      [2, 1, 'Mira, run 1'],
    ]);
    expect(m.lo).toBe(-4);
    m.setTime(20);
    const d = m.drawing();
    expect(d?.boats.find((b) => b.number === 1)?.north).toBeCloseTo(220, 0);
    expect(d?.boats.find((b) => b.number === 2)?.north).toBeCloseTo(176, 0);
  });

  test('the results alone draw nothing', () => {
    const told = { ...race(), kept: false };
    for (const r of told.runs) {
      delete r.course;
      for (const b of r.boats) {
        delete b.track;
      }
    }
    expect(new ReplayModel(told).drawing()).toBeNull();
  });
});

test('the clock from the gun', () => {
  expect(clockAt(-80)).toBe('−1:20');
  expect(clockAt(400.6)).toBe('6:40');
  expect(clockAt(3725)).toBe('1:02:05');
});
