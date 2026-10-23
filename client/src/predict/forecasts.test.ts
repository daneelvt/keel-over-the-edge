// SPDX-License-Identifier: AGPL-3.0-only

// The issues and the truth the phone keeps: each issue for ninety minutes,
// what has been after a Welcome, the keyframe at each five minutes as the
// weather is sent, and the truth and the issue about any tick of them.

import { describe, expect, test } from 'vitest';
import type { ForecastTold, WeatherKeyframe } from '../net/messages';
import { Forecasts, issueOf, PAST_EVERY, spellsAbout } from './forecast';
import { RECORDS, SIZES } from './layout.gen';

const H = RECORDS.forecastHead;
const P = RECORDS.spell;
const ISSUE = 18000;

/** An issue at a tick, of ten steps, with no systems. */
function issue(tick: number, gale = false): ForecastTold {
  const head = new Array<number>(SIZES.forecastHead).fill(0);
  head[H.issue] = tick;
  head[H.steps] = 10;
  head[H.step] = ISSUE;
  return {
    head,
    spells: [],
    systems: [],
    gale: gale
      ? { key: tick, steps: 2, first: 1, force: 8, from: 0, east: 0, north: 0, place: null }
      : null,
  };
}

function spell(begin: number): number[] {
  const s = new Array<number>(SIZES.spell).fill(0);
  s[P.begin] = begin;
  return s;
}

function key(tick: number): WeatherKeyframe {
  return { tick, systems: [[3, new Array<number>(SIZES.system).fill(1)]] };
}

describe('the forecasts kept', () => {
  test('a Welcome brings what has been: the issue of ninety minutes before and the truth since', () => {
    const f = new Forecasts();
    const now = 100 * ISSUE;
    f.receive(issue(now), {
      issue: issue(now - 9 * ISSUE),
      truth: [key(now - 9 * ISSUE), key(now - 9 * ISSUE + PAST_EVERY)],
      spells: [spell(now - 20 * ISSUE)],
    });
    expect(f.latest === null ? null : issueOf(f.latest)).toBe(now);
    const old = f.issueAt(now - 5 * ISSUE);
    expect(old === null ? null : issueOf(old)).toBe(now - 9 * ISSUE);
    const t = f.truthAt(now - 9 * ISSUE + 100);
    expect(t?.keys.map((k) => k.tick)).toEqual([now - 9 * ISSUE, now - 9 * ISSUE + PAST_EVERY]);
    expect(t?.spells.length).toBe(1);
  });

  test('keeps the keyframe at each five minutes as the weather is sent, and forgets what is too old', () => {
    const f = new Forecasts();
    f.keep([spell(0)], [key(PAST_EVERY - 300), key(PAST_EVERY), key(PAST_EVERY + 300)]);
    expect(f.truth.map((k) => k.tick)).toEqual([PAST_EVERY]);
    const v = f.version;
    f.keep(null, [key(2 * PAST_EVERY + 300)]);
    expect(f.version).toBe(v);
    for (let t = 0; t <= 30; t++) {
      f.keep(null, [key(t * PAST_EVERY)]);
    }
    f.receive(issue(30 * PAST_EVERY));
    // Ninety minutes and a step are kept: no more.
    expect(f.truth[0]?.tick).toBeGreaterThanOrEqual(30 * PAST_EVERY - 100 * 60 * 30);
    expect(f.truthAt(0)).toBeNull();
  });

  test('an issue sent again replaces the one of its tick; a new world forgets', () => {
    const f = new Forecasts();
    f.receive(issue(ISSUE));
    f.receive(issue(ISSUE, true));
    expect(f.latest?.gale?.force).toBe(8);
    expect(f.issueAt(ISSUE + 10)?.gale).not.toBeNull();
    f.reset();
    expect(f.latest).toBeNull();
    expect(f.truth.length).toBe(0);
  });

  test('the spells about a tick are the one in effect, the one before and the one after', () => {
    const s = [0, 100, 200, 300, 400].map((b) => Float64Array.from(spell(b)));
    expect(spellsAbout(s, 250).map((x) => x[P.begin])).toEqual([100, 200, 300]);
    expect(spellsAbout(s, 50).map((x) => x[P.begin])).toEqual([0, 100]);
  });
});
