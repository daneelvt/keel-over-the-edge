// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's boat as the course: nowhere until the server first says where
// it is, then there and moved on between its fixes; told only of the boat
// set; alongside within a tenth of a mile, said and cleared; ended by the
// server, said with its words and cleared; kept for the world and had back
// with no point until told again; and its words.

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { type NoticeKind, Notices } from '../ui/notices';
import { sailTo, setSailToHost } from '../ui/sailto';
import { BoatFixes, type Course, coursePoint, loadCourse, sameCourse } from './course';
import { chartedStore, chartOf, memoryKeep } from './coursesamples';
import { courseEndedText, MACHINE_AT_SEA, SAIL_TO, SHIPMATE_AT_SEA } from './coursewords';

const ANN: Course = { kind: 'boat', sailor: 'a1', name: 'Ann Bonny', machine: false };

describe('a boat as the course', () => {
  test('nowhere until told, then where it was told, moved on by the way it made', () => {
    let now = 0;
    const fixes = new BoatFixes(() => now);
    const store = chartedStore();
    expect(coursePoint(ANN, store, fixes)).toBeNull();
    expect(coursePoint(ANN, store)).toBeNull();
    fixes.take('a1', 100, 200);
    expect(coursePoint(ANN, store, fixes)).toMatchObject({
      east: 100,
      north: 200,
      bounds: null,
      name: 'Ann Bonny',
      reached: 'Ann Bonny',
    });
    // Another's fixes are not Ann's.
    expect(fixes.where('b2')).toBeNull();
    // 20 m north in two seconds: a second on, 10 m further.
    now = 2000;
    fixes.take('a1', 100, 220);
    expect(fixes.where('a1')).toEqual({ east: 100, north: 220 });
    now = 3000;
    expect(fixes.where('a1')).toEqual({ east: 100, north: 230 });
    // No further than four seconds on: past it, held.
    now = 60_000;
    expect(fixes.where('a1')).toEqual({ east: 100, north: 260 });
    // Fixes far apart give no way: held where last told.
    fixes.take('a1', 500, 500);
    now = 61_000;
    expect(fixes.where('a1')).toEqual({ east: 500, north: 500 });
    // Nor does a leap no boat sails, back to port or into another boat.
    now = 63_000;
    fixes.take('a1', 500, 1500);
    now = 64_000;
    expect(fixes.where('a1')).toEqual({ east: 500, north: 1500 });
    // Another sailor's first fix forgets Ann's.
    fixes.take('b2', 0, 0);
    expect(fixes.where('a1')).toBeNull();
    fixes.forget();
    expect(fixes.where('b2')).toBeNull();
  });

  test('the same boat is the same course, whatever its name', () => {
    expect(sameCourse(ANN, { ...ANN, name: 'Anne Bonny' })).toBe(true);
    expect(sameCourse(ANN, { ...ANN, sailor: 'b2' })).toBe(false);
    expect(sameCourse(ANN, { kind: 'pin', east: 0, north: 0 })).toBe(false);
  });

  test('told only of the boat set; a new name kept', () => {
    const chart = chartOf();
    chart.atWorld('w1');
    chart.boatAt({ sailor: 'a1', name: 'Ann Bonny', east: 0, north: 500 });
    expect(chart.aim(0, 0)).toBeNull();
    chart.setCourse(ANN);
    expect(chart.aim(0, 0)).toBeNull();
    chart.boatAt({ sailor: 'b2', name: 'Bob', east: 0, north: 500 });
    expect(chart.aim(0, 0)).toBeNull();
    chart.boatAt({ sailor: 'a1', name: 'Anne Bonny', east: 0, north: 500 });
    expect(chart.aim(0, 0)).toMatchObject({ distance: 500, name: 'Anne Bonny' });
    expect(chart.course.value).toMatchObject({ kind: 'boat', sailor: 'a1', name: 'Anne Bonny' });
    // Set to something else, the boat's fixes go with it.
    chart.setCourse({ kind: 'pin', east: 1, north: 1 });
    chart.setCourse(ANN);
    expect(chart.aim(0, 0)).toBeNull();
  });

  test('alongside within a tenth of a mile: said, and cleared', () => {
    const chart = chartOf();
    chart.setCourse(ANN);
    chart.boatAt({ sailor: 'a1', name: 'Ann Bonny', east: 0, north: 500 });
    chart.arrive(0, 0);
    expect(chart.course.value).not.toBeNull();
    chart.arrive(0, 350);
    expect(chart.course.value).toBeNull();
    expect(chart.notices.shown.value?.text).toBe("You're alongside Ann Bonny");
  });

  test('ended by the server: cleared, and why said; another’s end changes nothing', () => {
    for (const [why, text] of [
      ['ashore', 'Ann Bonny has come ashore'],
      ['gone', 'Ann Bonny is no longer at sea'],
      ['refused', "You can't sail to Ann Bonny now"],
    ] as const) {
      const chart = chartOf();
      chart.setCourse(ANN);
      chart.boatEnded('b2', why);
      expect(chart.course.value).not.toBeNull();
      chart.boatEnded('a1', why);
      expect(chart.course.value).toBeNull();
      expect(chart.notices.shown.value?.text).toBe(text);
    }
    // With no boat set, nothing is said.
    const chart = chartOf();
    chart.setCourse({ kind: 'pin', east: 1, north: 1 });
    chart.boatEnded('a1', 'refused');
    expect(chart.course.value).not.toBeNull();
    expect(chart.notices.shown.value).toBeNull();
  });

  test('kept for the world, and had back with no point until told again', () => {
    const keep = memoryKeep();
    const chart = chartOf(chartedStore(), keep);
    chart.atWorld('w1');
    const mary: Course = { kind: 'boat', sailor: 'm1', name: 'Iron Mary', machine: true };
    chart.setCourse(mary);
    chart.boatAt({ sailor: 'm1', name: 'Iron Mary', east: 0, north: 900 });
    expect(loadCourse('w1', keep)).toEqual(mary);
    const again = chartOf(chartedStore(), keep);
    again.atWorld('w1');
    expect(again.course.value).toEqual(mary);
    expect(again.aim(0, 0)).toBeNull();
    again.boatAt({ sailor: 'm1', name: 'Iron Mary', east: 0, north: 800 });
    expect(again.aim(0, 0)?.distance).toBe(800);
    for (const bad of [
      '{"world":"w1","course":{"kind":"boat","sailor":"","name":"A","machine":false}}',
      '{"world":"w1","course":{"kind":"boat","sailor":"a1","name":3,"machine":false}}',
      '{"world":"w1","course":{"kind":"boat","sailor":"a1","name":"A"}}',
    ]) {
      keep.items.set('keel.course', bad);
      expect(loadCourse('w1', keep), bad).toBeNull();
    }
  });

  test('watching another’s boat, or racing, it is not shown', () => {
    const chart = chartOf();
    chart.setCourse(ANN);
    chart.boatAt({ sailor: 'a1', name: 'Ann Bonny', east: 0, north: 500 });
    chart.watching = () => true;
    expect(chart.aim(0, 0)).toBeNull();
    chart.watching = () => false;
    chart.racing = () => true;
    expect(chart.compass().aim(0, 0)).toBeNull();
    chart.arrive(0, 450);
    expect(chart.course.value).not.toBeNull();
  });
});

describe('Sail to', () => {
  test('offered only where its host says it may be', () => {
    setSailToHost(null);
    expect(sailTo()).toBeNull();
    let able = false;
    const chart = chartOf();
    setSailToHost({
      able: () => able,
      is: (s) => {
        const c = chart.course.value;
        return c?.kind === 'boat' && c.sailor === s;
      },
      sail: (sailor, name, machine) => chart.setCourse({ kind: 'boat', sailor, name, machine }),
      clear: () => chart.clearCourse(),
    });
    expect(sailTo()).toBeNull();
    able = true;
    sailTo()?.sail('a1', 'Ann Bonny', false);
    expect(chart.course.value).toEqual(ANN);
    expect(sailTo()?.is('a1')).toBe(true);
    sailTo()?.clear();
    expect(chart.course.value).toBeNull();
    setSailToHost(null);
  });
});

describe('a boat course’s words', () => {
  test('the key, the box and the ends', () => {
    expect([SAIL_TO, SHIPMATE_AT_SEA, MACHINE_AT_SEA]).toEqual([
      'Sail to',
      'Shipmate at sea',
      'Your machine sailor at sea',
    ]);
    expect(courseEndedText('ashore', 'Iron Mary')).toBe('Iron Mary has come ashore');
    expect(courseEndedText('gone', 'Iron Mary')).toBe('Iron Mary is no longer at sea');
    expect(courseEndedText('refused', 'Ann')).toBe("You can't sail to Ann now");
  });

  test('the notices, from the catalog: neither may be switched off', () => {
    const n = new Notices(catalog.notices.kinds as unknown as NoticeKind[], 3);
    n.raise('course-alongside', { who: 'Ann' }, 0);
    expect(n.shown.value?.text).toBe("You're alongside Ann");
    n.dismiss(0);
    n.raise('course-ended', { why: courseEndedText('gone', 'Ann') }, 0);
    expect(n.shown.value?.text).toBe('Ann is no longer at sea');
    n.raise('course-ended', { why: courseEndedText('refused', 'Bob') }, 0);
    expect(n.shown.value?.text).toBe("You can't sail to Bob now");
    expect(n.kindFor('course-alongside')?.switchable).toBe(false);
    expect(n.kindFor('course-ended')?.switchable).toBe(false);
  });
});
