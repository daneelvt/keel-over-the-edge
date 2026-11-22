// SPDX-License-Identifier: AGPL-3.0-only

// A newcomer's three hints on the race line, each once a race: placed on
// the line, at the start, nearing the first mark; a race sailed alone's
// first hint a trial's; none for a sailor past the green ribbon. And the
// committee's question, answered by a tap: Still racing is offered for
// the minute the boat has to answer, and the tap tells the server.

import { describe, expect, test } from 'vitest';
import { HINT_GO, HINT_LINE, HINT_LINE_ALONE, HINT_MARK } from './racelinewords';
import { course, racer } from './racesamples';
import { ASKED_SHOWN, Racing } from './racestate';

/** The call the race line shows, as words. */
function said(r: Racing): string | undefined {
  return r.call.peek()?.text;
}

function pic(me: Parameters<typeof racer>[0]) {
  return { race: 3, tick: 1, eye: 1, racers: [racer({ number: 1, ...me })] };
}

describe('a newcomer’s hints', () => {
  test('placed, at the gun, nearing the mark: each once', () => {
    const r = new Racing();
    r.newcomer = () => true;
    r.tell(course());
    r.take(pic({ state: 'placed' }));
    expect(said(r)).toBe(HINT_LINE);
    r.call.value = null;
    r.take(pic({ state: 'placed' }));
    expect(said(r)).toBeUndefined();
    r.take(pic({ state: 'racing', leg: 1, north: 10 }));
    expect(said(r)).toBe(HINT_GO);
    r.take(pic({ state: 'racing', leg: 1, north: 360 }));
    expect(said(r)).toBe(HINT_MARK);
    r.call.value = null;
    r.take(pic({ state: 'racing', leg: 1, north: 380 }));
    expect(said(r)).toBeUndefined();
  });

  test('a race sailed alone: cross the line when ready', () => {
    const r = new Racing();
    r.newcomer = () => true;
    r.tell(course({ alone: true, start: 0 }));
    r.take(pic({ state: 'placed' }));
    expect(said(r)).toBe(HINT_LINE_ALONE);
  });

  test('none past the green ribbon, nor for a page opened mid-race', () => {
    const r = new Racing();
    r.tell(course());
    r.take(pic({ state: 'placed' }));
    r.take(pic({ state: 'racing', leg: 1, north: 360 }));
    expect(said(r)).toBeUndefined();
    const late = new Racing();
    late.newcomer = () => true;
    late.tell(course());
    late.take(pic({ state: 'racing', leg: 1, north: 100 }));
    expect(said(late)).toBeUndefined();
  });
});

describe('still racing?', () => {
  test('offered for the minute after the question; a tap tells the server', () => {
    let now = 1000;
    let told = 0;
    const r = new Racing();
    r.now = () => now;
    r.stillRacing = () => told++;
    r.tell(course());
    r.called({
      race: 3,
      kind: 'drifting',
      number: 1,
      other: 0,
      article: '',
      mark: 0,
      added: 0,
      place: 0,
    });
    expect(r.asked.value).toBe(1000 + ASKED_SHOWN);
    expect(said(r)).toMatch(/^Still racing\?/);
    r.answer();
    expect(told).toBe(1);
    expect(r.asked.value).toBe(0);
    expect(said(r)).toBeUndefined();
    // Asked again, and not answered: it goes with its minute.
    r.called({
      race: 3,
      kind: 'drifting',
      number: 1,
      other: 0,
      article: '',
      mark: 0,
      added: 0,
      place: 0,
    });
    now += ASKED_SHOWN;
    r.expire();
    expect(r.asked.value).toBe(0);
  });

  test('another boat’s question is not ours', () => {
    const r = new Racing();
    r.tell(course());
    r.called({
      race: 3,
      kind: 'drifting',
      number: 2,
      other: 0,
      article: '',
      mark: 0,
      added: 0,
      place: 0,
    });
    expect(r.asked.value).toBe(0);
  });
});
