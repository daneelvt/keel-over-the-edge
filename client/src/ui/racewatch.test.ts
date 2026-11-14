// SPDX-License-Identifier: AGPL-3.0-only

// Watching a race: ‹ and › through the whole fleet, round its ends; a
// switch within the server's second waits it out; follow the action holds
// twenty seconds and moves only for a boat clearly livelier, never in the
// watched boat's own rounding, and hands back to the spectator at their
// first switch; a boat watched home or retired left for its nearest; the
// crier's lines one at a time; a cheer once every ten seconds, the crowd's
// count coming back as lines, bunting and sound.

import { describe, expect, test } from 'vitest';
import type { RaceCheeredIn, RacePictureIn, RacerAtIn, RaceWatchAsk } from '../net/messages';
import { course, racer } from './racesamples';
import { Racing } from './racestate';
import {
  CHEER_EVERY,
  FOLLOW_HOLD,
  HOME_HOLD,
  RaceWatch,
  SWITCH_EVERY,
  scoreBoats,
} from './racewatch';
import {
  barWords,
  cheeredLine,
  cheeringText,
  crierCall,
  crierFinish,
  crierPlaces,
  standingRows,
} from './racewatchwords';

/** A spectator's watch of a race of five boats under way, the clock theirs to move. */
function watching() {
  let now = 100_000;
  const asked: RaceWatchAsk[] = [];
  const bursts: [number, boolean][] = [];
  const crowds: [number, boolean, boolean][] = [];
  let cheers = 0;
  const racing = new Racing();
  racing.now = () => now;
  racing.tell(
    course({
      entrants: [1, 2, 3, 4, 5].map((n) => ({
        number: n,
        name: `Boat ${n}`,
        boat: '',
        machine: false,
        me: false,
      })),
    }),
  );
  const w = new RaceWatch({
    racing,
    ask: (a) => asked.push(a),
    cheer: () => cheers++,
    now: () => now,
    length: () => 4,
    spectating: () => true,
    bunting: (n, own) => bursts.push([n, own]),
    crowd: (n, own, racer) => crowds.push([n, own, racer]),
  });
  /** Five boats racing up the course 100 m apart, by place, the eye eye. */
  const fleet = (eye: number, over: Partial<RacerAtIn>[] = []): RacePictureIn => ({
    race: 3,
    tick: now,
    eye,
    racers: [1, 2, 3, 4, 5].map((n, i) =>
      racer({
        number: n,
        place: n,
        state: 'racing',
        leg: 1,
        north: 300 - 100 * n,
        gap: 10 * n,
        ...over[i],
      }),
    ),
  });
  const take = (p: RacePictureIn) => {
    racing.take(p);
    w.picture(p);
  };
  return {
    w,
    racing,
    asked,
    bursts,
    crowds,
    take,
    fleet,
    cheers: () => cheers,
    at: (ms: number) => {
      now += ms;
      w.tick();
    },
  };
}

describe('watching a race', () => {
  test('‹ and › through the whole fleet, one switch a second', () => {
    const s = watching();
    s.take(s.fleet(3));
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      s.w.step(1);
      s.at(SWITCH_EVERY);
      const n = s.asked.at(-1)?.number ?? 0;
      seen.push(n);
      s.take(s.fleet(n));
    }
    // Behind the 3rd: 4, 5, then round to the leader and on.
    expect(seen).toEqual([4, 5, 1, 2, 3]);
    expect(s.asked.every((a) => a.race === 3 && a.code === 'abcdefghij')).toBe(true);
    // Ahead of the leader is the last.
    s.take(s.fleet(1));
    s.at(SWITCH_EVERY);
    s.w.step(-1);
    expect(s.asked.at(-1)?.number).toBe(5);
    // A second switch within the second waits for it, then goes.
    const n = s.asked.length;
    s.w.switchTo(2);
    expect(s.asked.length).toBe(n);
    expect(s.w.asking.value).toBe(2);
    s.at(SWITCH_EVERY);
    expect(s.asked.at(-1)?.number).toBe(2);
    // Refused as too soon, asked again.
    s.w.ended('quick');
    s.at(SWITCH_EVERY);
    expect(s.asked.at(-1)?.number).toBe(2);
    expect(s.asked.length).toBe(n + 2);
  });

  test('a boat retired skipped by ‹ and ›', () => {
    const s = watching();
    s.take(s.fleet(1, [{}, { state: 'retired', place: 0 }]));
    s.w.step(1);
    expect(s.asked.at(-1)?.number).toBe(3);
  });

  test('follow the action: holds twenty seconds, moves for a livelier boat, hands back', () => {
    const s = watching();
    s.w.follow.value = true;
    s.take(s.fleet(5));
    // The 3rd and 4th close together, the 5th alone: but not before the hold.
    const close = [{}, {}, { north: 0 }, { north: -8 }, { north: -400 }];
    s.at(5000);
    s.take(s.fleet(5, close));
    expect(s.asked.length).toBe(0);
    s.at(FOLLOW_HOLD);
    s.take(s.fleet(5, close));
    expect(s.asked.at(-1)?.number).toBe(3);
    s.at(3000);
    expect(s.w.crier.value?.text).toBe('Watching the fight for 3rd');
    expect(s.w.follow.value).toBe(true);
    // Now on the 3rd: held again before it moves anywhere.
    s.take(s.fleet(3, close));
    const n = s.asked.length;
    s.at(2000);
    s.take(s.fleet(3, [{ north: 0 }, { north: -8 }, { north: -300 }, { north: -600 }, {}]));
    expect(s.asked.length).toBe(n);
    // A switch by hand turns it off.
    s.w.switchTo(5);
    expect(s.w.follow.value).toBe(false);
    s.at(SWITCH_EVERY);
    s.take(s.fleet(5, close));
    s.at(FOLLOW_HOLD * 2);
    s.take(s.fleet(5, close));
    expect(s.asked.at(-1)?.number).toBe(5);
    // On again, it may move at once.
    s.w.setFollow(true);
    s.take(s.fleet(5, close));
    expect(s.asked.at(-1)?.number).toBe(3);
  });

  test('follow the action never moves during the watched boat’s own rounding', () => {
    const s = watching();
    s.w.setFollow(true);
    // The 5th at its mark (400 m north), the 1st and 2nd close together.
    const p = s.fleet(5, [{ north: 100 }, { north: 96 }, {}, {}, { north: 398 }]);
    s.take(p);
    expect(s.asked.length).toBe(0);
  });

  test('a boat watched home is left for its nearest after a while; one retired at once', () => {
    const s = watching();
    s.take(s.fleet(2));
    s.w.finish({ race: 3, number: 2, place: 1, elapsedMs: 600_000, added: 0 });
    const home = [{}, { state: 'finished' as const, place: 1 }, { north: 0 }];
    s.take(s.fleet(2, home));
    expect(s.asked.length).toBe(0);
    s.at(HOME_HOLD);
    s.take(s.fleet(2, home));
    expect(s.asked.at(-1)?.number).toBe(1);
    s.at(SWITCH_EVERY);
    s.take(s.fleet(1));
    s.w.switchTo(4);
    s.take(s.fleet(4));
    s.at(SWITCH_EVERY);
    s.take(s.fleet(4, [{}, {}, {}, { state: 'retired', place: 0 }]));
    expect(s.asked.at(-1)?.number).toBe(3);
  });

  test('a watch ended as its boat leaves the race moves to its nearest', () => {
    const s = watching();
    s.take(s.fleet(4));
    s.w.ended('off');
    expect([3, 5]).toContain(s.asked.at(-1)?.number);
  });

  test('the crier: one line at a time, the newest kept', () => {
    const s = watching();
    s.take(s.fleet(5));
    s.w.call({
      race: 3,
      kind: 'rounded',
      number: 2,
      other: 0,
      article: '',
      mark: 1,
      added: 0,
      place: 1,
    });
    expect(s.w.crier.value?.text).toBe('Boat 2 rounds Mark 1 first');
    s.w.call({
      race: 3,
      kind: 'overEarly',
      number: 4,
      other: 0,
      article: '',
      mark: 0,
      added: 10,
      place: 0,
    });
    s.w.call({
      race: 3,
      kind: 'retired',
      number: 5,
      other: 0,
      article: '',
      mark: 0,
      added: 0,
      place: 0,
    });
    s.w.call({
      race: 3,
      kind: 'bump',
      number: 1,
      other: 3,
      article: '10',
      mark: 0,
      added: 10,
      place: 0,
    });
    expect(s.w.crier.value?.text).toBe('Boat 2 rounds Mark 1 first');
    s.at(3000);
    expect(s.w.crier.value?.text).toBe('Boat 5 retires');
    s.at(3000);
    expect(s.w.crier.value?.text).toBe('Boat 1 fouls Boat 3: 10 seconds added');
    s.at(4000);
    expect(s.w.crier.value).toBeNull();
  });

  test('a cheer once every ten seconds; the crowd’s count comes back', () => {
    const s = watching();
    s.take(s.fleet(2));
    expect(s.w.cheerNow()).toBe(true);
    expect(s.w.cheerNow()).toBe(false);
    expect(s.cheers()).toBe(1);
    expect(s.bursts).toEqual([[1, true]]);
    const back = (over: Partial<RaceCheeredIn>): RaceCheeredIn => ({
      race: 3,
      number: 2,
      count: 12,
      crowd: 12,
      mine: true,
      ...over,
    });
    s.w.cheered(back({}));
    expect(s.w.cheeredText.value?.text).toBe('You and 11 others cheered');
    expect(s.bursts.at(-1)).toEqual([11, false]);
    // Another boat's cheers are not this page's.
    s.w.cheered(back({ number: 4 }));
    expect(s.bursts.length).toBe(2);
    s.at(CHEER_EVERY - 1);
    expect(s.w.cheerNow()).toBe(false);
    s.at(1);
    expect(s.w.cheerNow()).toBe(true);
    expect(s.cheers()).toBe(2);
  });

  test('a racer hears the crowd and its size', () => {
    const racing = new Racing();
    racing.tell(course());
    racing.take({ race: 3, tick: 1, eye: 1, racers: [racer({ state: 'racing' })] });
    const crowds: [number, boolean, boolean][] = [];
    const w = new RaceWatch({
      racing,
      ask: () => {},
      cheer: () => {},
      now: () => 0,
      length: () => 4,
      spectating: () => false,
      crowd: (n, own, r) => crowds.push([n, own, r]),
    });
    w.cheered({ race: 3, number: 1, count: 5, crowd: 9, mine: false });
    expect(w.cheering.value?.crowd).toBe(9);
    expect(crowds).toEqual([[5, false, true]]);
  });
});

describe('a race’s liveliness', () => {
  test('pairs near the front, changes of place and calls score', () => {
    const t = course();
    const r = (n: number, place: number, north: number) =>
      racer({ number: n, place, north, state: 'racing', leg: 1 });
    const now = [r(1, 1, 200), r(2, 2, 195), r(3, 3, 0), r(4, 4, -5), r(5, 5, -300)];
    const s = scoreBoats(t, now, [], 4);
    expect(s.get(1) ?? 0).toBeGreaterThan(s.get(3) ?? 0);
    expect(s.get(5)).toBe(0);
    const was = [r(1, 2, 200), r(2, 1, 195)];
    const changed = scoreBoats(t, now, was, 4);
    expect(changed.get(1) ?? 0).toBeGreaterThan(s.get(1) ?? 0);
    const called = scoreBoats(t, now, [], 4, [[5, 4]]);
    expect(called.get(5)).toBe(3);
  });
});

describe('watching a race’s words', () => {
  const t = course();
  const name = (n: number) => `Boat ${n}`;
  test('the race bar', () => {
    const racers = [
      racer({ number: 1, place: 1, state: 'racing', leg: 1 }),
      racer({ number: 2, place: 2, state: 'racing', leg: 1, gap: 42 }),
    ];
    expect(barWords(t, racers, 2, t.start + 30, name)).toEqual({
      over: 'Leg 1/2 · +0:42 · The Noon Gun',
      place: '2nd',
      name: 'Boat 2',
    });
    expect(barWords(t, racers, 1, t.start + 30, name).over).toBe('Leg 1/2 · first · The Noon Gun');
    expect(barWords(t, racers, 2, t.start - 90 * 30, name)).toEqual({
      over: 'The start in 1:30 · The Noon Gun',
      place: 'No. 2',
      name: 'Boat 2',
    });
  });

  test('the standings', () => {
    const rows = standingRows(t, [
      racer({ number: 3, state: 'retired' }),
      racer({ number: 2, place: 2, state: 'racing', leg: 2, gap: 130, added: 10 }),
      racer({ number: 1, place: 1, state: 'finished', leg: 2 }),
    ]);
    expect(rows.map((r) => [r.number, r.place, r.mark, r.gap])).toEqual([
      [1, '1', 'Home', '—'],
      [2, '2', 'Mk 1', '+2:10 · +10 s'],
      [3, '', '', 'RET'],
    ]);
  });

  test('the crier', () => {
    expect(
      crierCall(
        { race: 3, kind: 'rounded', number: 2, other: 0, article: '', mark: 2, added: 0, place: 4 },
        name,
      ),
    ).toBeNull();
    expect(crierFinish({ race: 3, number: 2, place: 1, elapsedMs: 1, added: 0 }, false, name)).toBe(
      'Boat 2 takes the gun!',
    );
    expect(crierFinish({ race: 3, number: 2, place: 2, elapsedMs: 1, added: 0 }, false, name)).toBe(
      'Boat 2 is home, 2nd',
    );
    expect(crierFinish({ race: 3, number: 2, place: 2, elapsedMs: 1, added: 0 }, true, name)).toBe(
      'A photo finish!',
    );
    const r = (n: number, place: number) => racer({ number: n, place, state: 'racing' });
    expect(crierPlaces([r(1, 1), r(2, 2)], [r(1, 2), r(2, 1)], 1, name)).toBe(
      'Boat 2 takes the lead!',
    );
    expect(crierPlaces([r(3, 4), r(4, 3)], [r(3, 3), r(4, 4)], 3, name)).toBe('Boat 3 takes 3rd');
    expect(crierPlaces([r(3, 4), r(4, 3)], [r(3, 3), r(4, 4)], 1, name)).toBeNull();
  });

  test('the cheers', () => {
    expect(cheeredLine(1)).toBe('You cheered');
    expect(cheeredLine(2)).toBe('You and 1 other cheered');
    expect(cheeredLine(12)).toBe('You and 11 others cheered');
    expect(cheeringText('14 watching', 12)).toBe('14 watching · 12 cheering');
    expect(cheeringText('', 3)).toBe('3 cheering');
  });
});
