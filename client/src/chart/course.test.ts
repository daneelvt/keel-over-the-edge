// SPDX-License-Identifier: AGPL-3.0-only

// The course: its point for each kind, its bearing, turn and distance from
// the boat, an island's reached at its nearest bounds; arrival, said and
// cleared, and not while racing or watching; kept for its world and
// dropped by another; and its words.

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { type NoticeKind, Notices } from '../ui/notices';
import {
  ARRIVE,
  type CourseKeep,
  courseAim,
  coursePoint,
  loadCourse,
  sameCourse,
  saveCourse,
  turnOf,
} from './course';
import { chartedStore, chartOf, memoryKeep, ROUND } from './coursesamples';
import {
  BEYOND_THE_EDGE,
  CLEAR_COURSE,
  courseLine,
  PIN,
  PIN_HERE,
  SET_COURSE,
  startName,
  tagText,
  windowParts,
} from './coursewords';
import { distanceText, NM } from './store';

const DEG = Math.PI / 180;

describe('the course', () => {
  test('a charted place: its bearing, distance and turn from the boat', () => {
    const store = chartedStore();
    const a = courseAim({ kind: 'entry', subject: 'place', number: 4 }, store, 0, 0);
    expect(a?.name).toBe('Gull Rock');
    expect(a?.reached).toBe('Gull Rock');
    expect(a?.distance).toBeCloseTo(Math.hypot(1000, 1000), 6);
    expect((a?.bearing ?? 0) / DEG).toBeCloseTo(45, 6);
    // Heading north it is 45° to starboard; heading east, 45° to port;
    // heading south-west, dead astern.
    expect(turnOf(a?.bearing ?? 0, 0)).toBeCloseTo(45, 6);
    expect(turnOf(a?.bearing ?? 0, 90 * DEG)).toBeCloseTo(-45, 6);
    expect(Math.abs(turnOf(a?.bearing ?? 0, 225 * DEG))).toBeCloseTo(180, 6);
    expect(turnOf(350 * DEG, 10 * DEG)).toBeCloseTo(-20, 6);
  });

  test('an island is reached at the nearest of its bounds, from wherever the boat is', () => {
    const store = chartedStore();
    const c = { kind: 'entry', subject: 'island', number: 3 } as const;
    // From the west, at its western edge, level with the boat.
    const w = courseAim(c, store, 0, 100);
    expect(w).toMatchObject({ east: 2500, north: 100, distance: 2500 });
    expect((w?.bearing ?? 0) / DEG).toBeCloseTo(90, 6);
    // From the north-east, at its north-east corner.
    const ne = courseAim(c, store, 4000, 1000);
    expect(ne).toMatchObject({ east: 3500, north: 400 });
    expect(ne?.distance).toBeCloseTo(Math.hypot(500, 600), 6);
    // Within them: there.
    expect(courseAim(c, store, 3000, 0)?.distance).toBe(0);
  });

  test('a race course’s start, a pin, and what is not charted', () => {
    const store = chartedStore();
    const s = coursePoint({ kind: 'start', course: 2 }, store);
    expect(s).toMatchObject({ east: 2000, north: 600, name: 'Start of Round Long Cay' });
    expect(s?.reached).toBe('the start of Round Long Cay');
    expect(startName(ROUND)).toBe('Start of Round Long Cay');
    const p = coursePoint({ kind: 'pin', east: -500, north: 20 }, store);
    expect(p).toMatchObject({ east: -500, north: 20, name: PIN, reached: 'your pin' });
    // Not yet charted (a reload, before the chart comes): no point, no aim.
    expect(coursePoint({ kind: 'entry', subject: 'feature', number: 9 }, store)).toBeNull();
    expect(coursePoint({ kind: 'start', course: 7 }, store)).toBeNull();
    expect(courseAim({ kind: 'start', course: 7 }, store, 0, 0)).toBeNull();
  });

  test('two courses are the same only when they name the same thing', () => {
    const pin = { kind: 'pin', east: 1, north: 2 } as const;
    expect(sameCourse(pin, { kind: 'pin', east: 1, north: 2 })).toBe(true);
    expect(sameCourse(pin, { kind: 'pin', east: 1, north: 3 })).toBe(false);
    expect(sameCourse({ kind: 'start', course: 2 }, { kind: 'start', course: 2 })).toBe(true);
    expect(
      sameCourse({ kind: 'entry', subject: 'island', number: 3 }, { kind: 'start', course: 3 }),
    ).toBe(false);
    expect(sameCourse(null, null)).toBe(true);
    expect(sameCourse(pin, null)).toBe(false);
  });

  test('arriving within a tenth of a mile says so and clears it, set again it replaces the last', () => {
    const chart = chartOf();
    chart.atWorld('w1');
    chart.setCourse({ kind: 'entry', subject: 'place', number: 4 });
    expect(chart.isCourse({ kind: 'entry', subject: 'place', number: 4 })).toBe(true);
    // Set on something else, that is the course.
    chart.setCourse({ kind: 'pin', east: 0, north: 500 });
    expect(chart.isCourse({ kind: 'entry', subject: 'place', number: 4 })).toBe(false);
    // Short of it, nothing.
    chart.arrive(0, 500 - ARRIVE - 1);
    expect(chart.course.value).not.toBeNull();
    expect(chart.notices.shown.value).toBeNull();
    // Within it: said, and gone.
    chart.arrive(0, 500 - ARRIVE + 1);
    expect(chart.course.value).toBeNull();
    expect(chart.notices.shown.value?.text).toBe("You've reached your pin");
    // A place by its name; an island at its shore.
    chart.notices.dismiss(2000);
    chart.setCourse({ kind: 'entry', subject: 'place', number: 4 });
    chart.arrive(1000, 1100);
    expect(chart.notices.shown.value?.text).toBe("You've reached Gull Rock");
    chart.notices.dismiss(2000);
    chart.setCourse({ kind: 'entry', subject: 'island', number: 3 });
    chart.arrive(2350, 0);
    expect(chart.course.value).toBeNull();
    expect(chart.notices.shown.value?.text).toBe("You've reached Long Cay");
  });

  test('racing, the compass gives way and it is kept; watching another’s boat, it is not shown', () => {
    const chart = chartOf();
    chart.atWorld('w1');
    chart.setCourse({ kind: 'pin', east: 0, north: 100 });
    let racing = true;
    chart.racing = () => racing;
    chart.arrive(0, 90);
    expect(chart.course.value).not.toBeNull();
    racing = false;
    let watching = true;
    chart.watching = () => watching;
    expect(chart.aim(0, 0)).toBeNull();
    chart.arrive(0, 90);
    expect(chart.course.value).not.toBeNull();
    watching = false;
    expect(chart.aim(0, 0)?.distance).toBe(100);
    chart.arrive(0, 90);
    expect(chart.course.value).toBeNull();
  });

  test('the compass and the sea’s tag carry it, but not in a race, nor on a boat watched', () => {
    const chart = chartOf();
    chart.setCourse({ kind: 'pin', east: 0, north: 300 });
    const compass = chart.compass();
    expect(compass.aim(0, 0)).toMatchObject({ east: 0, north: 300, name: 'Pin' });
    expect(chart.seaTag(0, 0)).toEqual({ east: 0, north: 300, text: 'Pin · 0.2 NM', sight: true });
    chart.racing = () => true;
    expect(compass.aim(0, 0)).toBeNull();
    expect(chart.seaTag(0, 0)).toBeNull();
    compass.arrive(0, 250);
    expect(chart.course.value).not.toBeNull();
    chart.racing = () => false;
    chart.watching = () => true;
    expect(compass.aim(0, 0)).toBeNull();
    expect(chart.seaTag(0, 0)).toBeNull();
    chart.watching = () => false;
    compass.arrive(0, 250);
    expect(chart.course.value).toBeNull();
  });

  test('kept for the week’s world: had back on a reload, dropped by a new world', () => {
    const keep = memoryKeep();
    const chart = chartOf(chartedStore(), keep);
    // Set before the world is known, it is held, not kept.
    chart.setCourse({ kind: 'pin', east: 5, north: 6 });
    expect(keep.items.size).toBe(0);
    chart.atWorld('w1');
    chart.setCourse({ kind: 'start', course: 2 });
    expect(loadCourse('w1', keep)).toEqual({ kind: 'start', course: 2 });
    // A reload: a new chart, the same world.
    const again = chartOf(chartedStore(), keep);
    again.atWorld('w1');
    expect(again.course.value).toEqual({ kind: 'start', course: 2 });
    // The next week's world: dropped, and forgotten.
    again.atWorld('w2');
    expect(again.course.value).toBeNull();
    expect(keep.items.size).toBe(0);
    const third = chartOf(chartedStore(), keep);
    third.atWorld('w1');
    expect(third.course.value).toBeNull();
    // Cleared, it is forgotten too.
    third.setCourse({ kind: 'entry', subject: 'island', number: 3 });
    third.clearCourse();
    expect(loadCourse('w1', keep)).toBeNull();
  });

  test('what is read back is a course, or nothing', () => {
    const keep = memoryKeep();
    for (const bad of [
      'not json',
      '{"world":"w1","course":{"kind":"pin","east":"1","north":2}}',
      '{"world":"w1","course":{"kind":"entry","subject":"town","number":1}}',
      '{"world":"w1","course":{"kind":"entry","subject":"place","number":-1}}',
      '{"world":"w1","course":{"kind":"start","course":1.5}}',
      '{"world":"w1","course":{"kind":"boat"}}',
      '{"world":"w1"}',
      'null',
    ]) {
      keep.items.set('keel.course', bad);
      expect(loadCourse('w1', keep), bad).toBeNull();
    }
    expect(saveCourse('w1', { kind: 'pin', east: 1.5, north: -2 }, keep)).toBe(true);
    expect(loadCourse('w1', keep)).toEqual({ kind: 'pin', east: 1.5, north: -2 });
    // A phone that refuses storage keeps nothing, and nothing breaks.
    const refusing: CourseKeep = {
      getItem: () => {
        throw new Error('refused');
      },
      setItem: () => {
        throw new Error('refused');
      },
      removeItem: () => {
        throw new Error('refused');
      },
    };
    expect(saveCourse('w1', { kind: 'pin', east: 1, north: 2 }, refusing)).toBe(false);
    expect(loadCourse('w1', refusing)).toBeNull();
    expect(saveCourse('w1', null, null)).toBe(false);
  });
});

describe('the course’s words', () => {
  test('the keys, the pin and the edge', () => {
    expect([SET_COURSE, CLEAR_COURSE, PIN_HERE, PIN, BEYOND_THE_EDGE]).toEqual([
      'Set course',
      'Clear course',
      'Pin here',
      'Pin',
      'Beyond the edge.',
    ]);
  });

  test('the compass’s window, the tag in the sea and the line read out', () => {
    expect(windowParts(distanceText(1.2 * NM))).toEqual({ figures: '1.2', unit: 'NM' });
    expect(windowParts(distanceText(90))).toEqual({ figures: '90', unit: 'm' });
    // Across the whole disk, at most three figures.
    expect(windowParts(distanceText(2 * 8334))).toEqual({ figures: '9.0', unit: 'NM' });
    expect(tagText('Gull Rock', 120)).toBe('Gull Rock · 120 m');
    expect(courseLine('Gull Rock', 45 * DEG, 1.2 * NM)).toBe('Course to Gull Rock: 045°, 1.2 NM');
  });

  test('the notices’ words, from the catalog', () => {
    const n = new Notices(catalog.notices.kinds as unknown as NoticeKind[], 3);
    n.raise('course-reached', { name: 'the start of Round Long Cay' }, 0);
    expect(n.shown.value?.text).toBe("You've reached the start of Round Long Cay");
    expect(n.kindFor('course-reached')?.switchable).toBe(false);
    n.dismiss(0);
    n.raise('shipmate-course', { who: 'Ann' }, 0);
    expect(n.shown.value?.text).toBe('Ann is sailing to you');
    n.raise('shipmate-course', { who: 'Ben' }, 0);
    expect(n.shown.value?.text).toBe('2 shipmates are sailing to you');
    expect(n.kindFor('shipmate-course')?.switchable).toBe(true);
  });
});
