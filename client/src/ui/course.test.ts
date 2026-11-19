// SPDX-License-Identifier: AGPL-3.0-only

// The course on the screens: the compass's mark turned to its bearing and
// its window's words, hidden with no course shown; the chart's boxes' keys;
// a tap on open water, within a system and past the rim; the pocket
// chart's dot, and its tick on a race's frame.

import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, test } from 'vitest';
import { chartOf, GULL, ROUND } from '../chart/coursesamples';
import { NM } from '../chart/store';
import { newPose } from '../predict/blend';
import { SIZES } from '../predict/layout.gen';
import { newBoatWind } from '../predict/weather';
import { CourseWindow } from './case';
import {
  ChartBox,
  type ChartSea,
  MarkedBox,
  openCourseBox,
  pocketCourse,
  tapOnPaper,
} from './chart';
import { type CompassCourse, HudModel } from './model';

const DEG = Math.PI / 180;

/** A tree with its function components drawn, as far as they draw without hooks. */
function drawn(node: ComponentChildren): ComponentChildren {
  if (Array.isArray(node)) {
    return node.map(drawn);
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return node;
  }
  const v = node as VNode<{ children?: ComponentChildren }>;
  if (typeof v.type === 'function') {
    return drawn((v.type as (p: unknown) => ComponentChildren)(v.props));
  }
  return { ...v, props: { ...v.props, children: drawn(v.props.children) } } as VNode;
}

/** The text of a drawn tree, in order. */
function text(node: ComponentChildren): string {
  if (Array.isArray(node)) {
    return node.map(text).join('');
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) {
    return '';
  }
  return text((node as VNode<{ children?: ComponentChildren }>).props.children);
}

/** The buttons of a drawn tree, their words and their presses. */
function buttons(node: ComponentChildren): { words: string; press: () => void }[] {
  if (Array.isArray(node)) {
    return node.flatMap(buttons);
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return [];
  }
  const v = node as VNode<{ children?: ComponentChildren; onClick?: () => void }>;
  return [
    ...(v.type === 'button' ? [{ words: text(v), press: v.props.onClick ?? (() => {}) }] : []),
    ...buttons(v.props.children),
  ];
}

/** The sea a chart's boxes want, the boat at the centre. */
function seaOf(chart = chartOf()): ChartSea {
  return {
    chart,
    boat: () => ({ east: 0, north: 0, heading: 0 }),
    tick: () => 0,
    hour: () => null,
    scale: 10,
    lip: 8334,
    characters: ['Fl(2) 10s', 'Oc 6s', 'Iso 4s'],
    news: async () => {
      throw new Error('no news');
    },
    forecasting: null,
    speed: () => 0,
    steer: null,
  };
}

/** The HUD drawn for a boat at (east, north) heading heading, its course aimed at where. */
function compassAt(
  heading: number,
  where: { east: number; north: number; name: string } | null,
): { model: HudModel; turned: string } {
  const model = new HudModel();
  const style = { transform: '' };
  model.courseMark.attach({ style } as unknown as SVGElement);
  const course: CompassCourse = { aim: () => where, arrive: () => {} };
  model.course = course;
  const pose = newPose();
  pose.heading = heading;
  model.frame(0, 0, pose, new Float64Array(SIZES.out), newBoatWind(), 0, 0, 0, 0);
  return { model, turned: style.transform };
}

describe('the compass', () => {
  test('carries the course’s mark at its bearing less the heading, and its distance at its foot', () => {
    const far = { east: 0, north: 1.2 * NM, name: 'Gull Rock' };
    const ahead = compassAt(0, far);
    expect(ahead.turned).toBe('rotate(0.0deg)');
    expect(ahead.model.courseDistance.value).toBe('1.2 NM');
    expect(ahead.model.courseWords.value).toBe('Course to Gull Rock: 000°, 1.2 NM');
    // Abeam to port, heading east; astern, heading south; close in, metres.
    expect(compassAt(90 * DEG, far).turned).toBe('rotate(-90.0deg)');
    expect(compassAt(180 * DEG, far).turned).toMatch(/^rotate\(-?180\.0deg\)$/);
    const near = compassAt(0, { east: 60, north: 60, name: 'Pin' });
    expect(near.turned).toBe('rotate(45.0deg)');
    expect(near.model.courseDistance.value).toBe('85 m');
    const card = drawn(CourseWindow({ model: near.model }));
    expect(text(card)).toBe('85m');
  });

  test('carries nothing with no course shown: none set, racing, or watching', () => {
    const none = compassAt(0, null);
    expect(none.turned).toBe('');
    expect(none.model.courseDistance.value).toBe('');
    expect(none.model.courseWords.value).toBe('');
    expect(CourseWindow({ model: none.model })).toBeNull();
  });
});

describe('the chart’s boxes', () => {
  test('a charted place’s box sets the course first, and then clears it; not on a boat watched', () => {
    const sea = seaOf();
    sea.chart.atWorld('w1');
    const keys = () => buttons(drawn(ChartBox({ sea, e: GULL, close: () => {} })));
    expect(keys().map((k) => k.words)).toEqual(['Set course', 'Show in the list', 'Close']);
    keys()[0]?.press();
    expect(sea.chart.course.value).toEqual({ kind: 'entry', subject: 'place', number: 4 });
    expect(keys().map((k) => k.words)).toEqual(['Clear course', 'Show in the list', 'Close']);
    keys()[0]?.press();
    expect(sea.chart.course.value).toBeNull();
    sea.chart.watching = () => true;
    expect(keys().map((k) => k.words)).toEqual(['Show in the list', 'Close']);
  });

  test('a pin’s box gives its position and sets it; past the rim it is no pin', () => {
    const sea = seaOf();
    const box = drawn(
      MarkedBox({ sea, m: { kind: 'pin', east: 0, north: 1852 }, close: () => {} }),
    );
    expect(text(box)).toContain('Pin');
    expect(text(box)).toContain('80°00′N 000°00′');
    expect(text(box)).toContain('000° 1.0 NM');
    const keys = buttons(box);
    expect(keys.map((k) => k.words)).toEqual(['Set course', 'Close']);
    keys[0]?.press();
    expect(sea.chart.course.value).toEqual({ kind: 'pin', east: 0, north: 1852 });
    const beyond = drawn(
      MarkedBox({ sea, m: { kind: 'pin', east: 9000, north: 0 }, close: () => {} }),
    );
    expect(text(beyond)).toBe('Beyond the edge.Close');
    expect(buttons(beyond).map((k) => k.words)).toEqual(['Close']);
  });

  test('a race course’s start’s box names it and sets it', () => {
    const sea = seaOf();
    const box = drawn(MarkedBox({ sea, m: { kind: 'start', course: ROUND }, close: () => {} }));
    expect(text(box)).toContain('Round Long Cay');
    expect(text(box)).toContain('The start of a course · Round an island');
    buttons(box)[0]?.press();
    expect(sea.chart.course.value).toEqual({ kind: 'start', course: 2 });
  });

  test('the course’s pin on the chart opens the box of what it was set for', () => {
    const sea = seaOf();
    const chart = sea.chart;
    chart.setCourse({ kind: 'entry', subject: 'place', number: 4 });
    openCourseBox(chart);
    expect(chart.picked.value).toBe(GULL);
    chart.setCourse({ kind: 'start', course: 2 });
    openCourseBox(chart);
    expect(chart.picked.value).toBeNull();
    expect(chart.marked.value).toEqual({ kind: 'start', course: ROUND });
    chart.setCourse({ kind: 'pin', east: 4, north: 5 });
    openCourseBox(chart);
    expect(chart.marked.value).toEqual({ kind: 'pin', east: 4, north: 5 });
  });
});

describe('a tap on the chart', () => {
  const system = { kind: 'system', slot: 1, seed: 7, at: { east: 10, north: 20 } } as const;
  const at = { east: 10, north: 20 };

  test('on open water drops a pin, with its box', () => {
    const chart = chartOf();
    tapOnPaper(chart, null, null, null, at, () => 0);
    expect(chart.marked.value).toEqual({ kind: 'pin', east: 10, north: 20 });
    expect(chart.picked.value).toBeNull();
    expect(chart.tapped.value).toBeNull();
    // Off the paper: nothing.
    tapOnPaper(chart, null, null, null, null, () => 0);
    expect(chart.marked.value).toBeNull();
    // On a boat watched, no pin: the course is the sailor's own.
    chart.watching = () => true;
    tapOnPaper(chart, null, null, null, at, () => 0);
    expect(chart.marked.value).toBeNull();
  });

  test('within a weather system opens its box, a place winning only under the finger', () => {
    const chart = chartOf();
    tapOnPaper(chart, null, null, system, at, () => 0);
    expect(chart.tapped.value).toBe(system);
    expect(chart.marked.value).toBeNull();
    tapOnPaper(chart, GULL, null, system, at, () => 40);
    expect(chart.tapped.value).toBe(system);
    expect(chart.picked.value).toBeNull();
    tapOnPaper(chart, GULL, null, system, at, () => 10);
    expect(chart.picked.value).toBe(GULL);
    expect(chart.tapped.value).toBeNull();
  });

  test('by a race course’s start opens its box, unless a charted thing is nearer', () => {
    const chart = chartOf();
    tapOnPaper(chart, null, ROUND, null, at, () => 5);
    expect(chart.marked.value).toEqual({ kind: 'start', course: ROUND });
    // Gull Rock at (1000, 1000), the start at (2000, 600): the nearer wins.
    const near = (e: number) => (e === 1000 ? 3 : 9);
    tapOnPaper(chart, GULL, ROUND, null, at, near);
    expect(chart.picked.value).toBe(GULL);
    expect(chart.marked.value).toBeNull();
    tapOnPaper(chart, GULL, ROUND, null, at, (e) => (e === 1000 ? 9 : 3));
    expect(chart.picked.value).toBeNull();
    expect(chart.marked.value).toEqual({ kind: 'start', course: ROUND });
  });
});

describe('the pocket chart', () => {
  test('a dot within its frame; out of a race’s frame, a tick on its rim the way it lies', () => {
    const frame = { east: 0, north: 0, radius: 1000 };
    const k = (240 * 0.48) / 1000;
    const dot = pocketCourse({ east: 500, north: 0 }, frame, k, 0.62, 240, 156);
    expect(dot).toEqual({ kind: 'dot', x: 120 + 500 * k, y: 78 });
    // Due north, beyond the frame: at its top, pointing up.
    const north = pocketCourse({ east: 0, north: 5000 }, frame, k, 0.62, 240, 156);
    expect(north.kind).toBe('tick');
    expect(north.x).toBeCloseTo(120, 6);
    expect(north.y).toBeCloseTo(78 - 1000 * k * 0.62, 6);
    expect(north.kind === 'tick' ? [north.dx, north.dy] : null).toEqual([0, -1]);
    // Due east: at its right, pointing right.
    const east = pocketCourse({ east: 4000, north: 0 }, frame, k, 0.62, 240, 156);
    expect(east.x).toBeCloseTo(120 + 1000 * k, 6);
    expect(east.kind === 'tick' ? east.dx : 0).toBeCloseTo(1, 6);
  });
});
