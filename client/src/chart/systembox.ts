// SPDX-License-Identifier: AGPL-3.0-only

// A weather system's box, when the sailor taps it on the chart, as a
// place's box opens: what it is; its wind; where it lies from the boat; how
// it moves and how long it has to live; and the course to meet it, the sum
// a navigator would do. At the boat's speed over the ground now, the course
// is the heading that reaches where the system will be when the boat gets
// there, tried minute by minute along its track as the forecast gives it
// and closed on between; for a line or a front, its nearest point. A system
// the boat cannot catch within the forecast's reach is faster than it, and
// the box gives the heading to where it will be in half an hour instead.

import type { ForecastTold } from '../net/messages';
import type { Physics } from '../predict/physics';
import { bearingText, distanceText } from './store';
import type { FieldGrid, SceneFront, SceneSystem, SystemPlace } from './weather';
import { systemTrack } from './weather';
import { forceOf, forceWord, point16 } from './words';

const SECOND = 30;
const MINUTE = 60 * SECOND;
const NM = 1852;
const KNOT = NM / 3600;

/** A front is tapped within this of its line, m. */
const FRONT_REACH = 0.3 * NM;

/** Where the boat makes for when the system will not be caught: its place this far on. */
export const PATH_AHEAD = 30 * MINUTE;

/** A point on the water, m. */
export interface Point {
  east: number;
  north: number;
}

/** What a tap on the chart's weather found: a system or a front, as the scene drew it. */
export type WeatherHit =
  | { kind: 'system'; system: SceneSystem }
  | { kind: 'front'; front: SceneFront };

/** The nearest point to p of a line's length, across its motion, about its centre. */
export function nearestOnLine(
  c: Pick<SystemPlace, 'east' | 'north' | 'heading' | 'length'>,
  p: Point,
): Point {
  // Its length runs along (uy, −ux).
  const wx = Math.cos(c.heading);
  const wy = -Math.sin(c.heading);
  const half = c.length / 2;
  const t = Math.min(Math.max((p.east - c.east) * wx + (p.north - c.north) * wy, -half), half);
  return { east: c.east + t * wx, north: c.north + t * wy };
}

/** The nearest point to p of a front's line. */
export function nearestOnFront(f: Pick<SceneFront, 'sin' | 'cos' | 'line'>, p: Point): Point {
  const off = f.line - (p.east * f.sin + p.north * f.cos);
  return { east: p.east + off * f.sin, north: p.north + off * f.cos };
}

/**
 * What a tap at a point of the chart's weather falls within, or null: a
 * line within its size of its length; a low or a storm within its ring or
 * its size; any other system within its size; a front within 0.3 NM of its
 * line, inside the disk. Of several, the one it falls deepest within.
 */
export function hitTest(
  scene: { systems: readonly SceneSystem[]; fronts: readonly SceneFront[] },
  at: Point,
  lip: number,
): WeatherHit | null {
  let best: WeatherHit | null = null;
  let score = 1;
  for (const s of scene.systems) {
    const reach = Math.max(s.size, s.ring);
    if (!(reach > 0)) {
      continue;
    }
    const near = s.length > 0 ? nearestOnLine(s, at) : s;
    const d = Math.hypot(at.east - near.east, at.north - near.north) / reach;
    if (d <= score) {
      score = d;
      best = { kind: 'system', system: s };
    }
  }
  if (Math.hypot(at.east, at.north) <= lip) {
    for (const f of scene.fronts) {
      const d = Math.abs(f.line - (at.east * f.sin + at.north * f.cos)) / FRONT_REACH;
      if (d <= score) {
        score = d;
        best = { kind: 'front', front: f };
      }
    }
  }
  return best;
}

/** The course to meet something: its heading, rad; when, ticks from now; where; and whether it is faster than the boat. */
export interface Course {
  heading: number;
  at: number;
  east: number;
  north: number;
  faster: boolean;
}

/**
 * The course to meet a target moving as target gives it, ticks from now
 * (null once it is gone), within reach ticks, for a boat at a point making
 * speed m/s over the ground: the heading that reaches it, found where the
 * boat's run first covers the distance to it, minute by minute, then
 * closed on, from when it is first there: one yet to be born is met no
 * sooner. Faster than the boat, or the boat still, the heading is to its
 * place ahead, half an hour on or its last. Null if it is not there at any
 * minute of the reach.
 */
export function courseToMeet(
  boat: Point,
  speed: number,
  target: (t: number) => Point | null,
  reach: number,
): Course | null {
  let born = 0;
  let first = target(0);
  while (first === null && born < reach) {
    born = Math.min(born + MINUTE, reach);
    first = target(born);
  }
  if (first === null) {
    return null;
  }
  const start = first;
  const short = (t: number): number | null => {
    const p = target(t);
    return p === null
      ? null
      : Math.hypot(p.east - boat.east, p.north - boat.north) - (speed * t) / SECOND;
  };
  const toward = (t: number, p: Point, faster: boolean): Course => ({
    heading: Math.atan2(p.east - boat.east, p.north - boat.north),
    at: t,
    east: p.east,
    north: p.north,
    faster,
  });
  if (speed > 0.05) {
    let lo = born;
    for (let t = born + MINUTE; t <= reach + MINUTE - 1; t += MINUTE) {
      const hi = Math.min(t, reach);
      const d = short(hi);
      if (d === null) {
        break;
      }
      if (d <= 0) {
        // Closed on between the minute before and this one.
        let a = lo;
        let b = hi;
        for (let i = 0; i < 24; i++) {
          const m = (a + b) / 2;
          if ((short(m) ?? 1) <= 0) {
            b = m;
          } else {
            a = m;
          }
        }
        return toward(b, target(b) ?? start, false);
      }
      lo = hi;
    }
  }
  // Out of reach: its path ahead, half an hour on, or the last of it known.
  let t = Math.min(born + PATH_AHEAD, reach);
  let p = target(t);
  while (p === null && t > born) {
    t = Math.max(t - MINUTE, born);
    p = target(t);
  }
  return toward(t, p ?? start, true);
}

/** A system's track as targets for the boat: its centre, or for a line the nearest point of its length. */
export function systemTarget(
  track: (tick: number) => SystemPlace | null,
  now: number,
  boat: Point,
): (t: number) => Point | null {
  return (t) => {
    const p = track(now + t);
    if (p === null) {
      return null;
    }
    return p.length > 0 ? nearestOnLine(p, boat) : { east: p.east, north: p.north };
  };
}

/** A front's line as targets for the boat, its nearest point, until it is off the disk at reach, m from the centre. */
export function frontTarget(
  f: SceneFront,
  boat: Point,
  reach: number,
): (t: number) => Point | null {
  return (t) => {
    const line = f.line + (f.speed * t) / SECOND;
    return line > reach ? null : nearestOnFront({ ...f, line }, boat);
  };
}

/** A tapped thing's box: its name and its lines, and the heading the Steer button sets, or null for none. */
export interface SystemBox {
  name: string;
  wind: string;
  where: string;
  motion: string;
  life: string;
  course: string;
  steer: number | null;
  /** Where the course leads and when the boat is there, the world's tick: where it meets the system, or its path ahead. */
  to: { east: number; north: number; at: number } | null;
}

/** Whole knots of a speed in m/s. */
function knots(speed: number): number {
  return Math.round(Math.max(speed, 0) / KNOT);
}

/** A mean wind's force as the box gives it: "F6", or a gale's shipping words, "Severe gale 9". */
export function forceText(mean: number): string {
  const f = forceOf(mean);
  if (f < 8) {
    return `F${f}`;
  }
  const w = forceWord(f);
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** A time to come, ticks, as the box gives it: "40 min", "1 h 20 min". */
export function minutesText(ticks: number): string {
  const m = Math.max(Math.round(ticks / MINUTE), 0);
  if (m < 60) {
    return `${m} min`;
  }
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** The box's words for something tapped, from where it is now, how it moves and the course to meet it. */
export function boxWords(o: {
  name: string;
  wind: number;
  gust: number;
  boat: Point;
  at: Point;
  heading: number;
  speed: number;
  /** Ticks it has to live, or null if not known. */
  lives: number | null;
  course: Course | null;
  now: number;
}): SystemBox {
  const d = Math.hypot(o.at.east - o.boat.east, o.at.north - o.boat.north);
  const where = `${bearingText(Math.atan2(o.at.east - o.boat.east, o.at.north - o.boat.north))} ${distanceText(d)} from you`;
  const moving = knots(o.speed);
  const motion = moving === 0 ? 'Still' : `${point16(o.heading)} ${moving} kn`;
  const life = o.lives === null ? '' : `${minutesText(o.lives)} more`;
  const c = o.course;
  let course = '';
  if (c !== null) {
    course = c.faster
      ? `It is faster than you. Its path ahead: ${bearingText(c.heading)}`
      : `Course to meet it ${bearingText(c.heading)}, in ${minutesText(c.at)}`;
  }
  return {
    name: o.name,
    wind: `${knots(o.wind)} kn, gusts ${knots(o.gust)} kn · ${forceText(o.wind)}`,
    where,
    motion,
    life,
    course,
    steer: c === null ? null : c.heading,
    to: c === null ? null : { east: c.east, north: c.north, at: o.now + c.at },
  };
}

/** The strongest mean wind and gust a front blows on the water near a point of its line, from the scene's grid. */
export function frontWind(
  grid: FieldGrid,
  f: SceneFront,
  near: Point,
): { wind: number; gust: number } {
  let wind = 0;
  let gust = 0;
  const n = grid.n;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const east = ((i + 0.5) / n - 0.5) * 2 * grid.lip;
      const north = (0.5 - (j + 0.5) / n) * 2 * grid.lip;
      if (
        Math.abs(f.line - (east * f.sin + north * f.cos)) > 2 * FRONT_REACH ||
        Math.hypot(east - near.east, north - near.north) > NM
      ) {
        continue;
      }
      const k = j * n + i;
      wind = Math.max(wind, grid.mean[k] ?? 0);
      gust = Math.max(gust, grid.gust[k] ?? 0);
    }
  }
  return { wind, gust: Math.max(gust, wind) };
}

/**
 * The box of something tapped on the chart, now: a system by its track as
 * the latest forecast gives it, or a front by its line, with the course to
 * meet it from the boat at its speed over the ground, m/s. reach is a
 * front's distance from the centre, m, where it leaves the disk.
 */
export function tappedBox(o: {
  hit: WeatherHit;
  grid: FieldGrid;
  boat: Point;
  speed: number;
  physics: Physics | null;
  latest: ForecastTold | null;
  /** The tick of the scene the hit was found in, and now. */
  shown: number;
  now: number;
  reach: number;
}): SystemBox | null {
  const { hit, boat, now } = o;
  if (hit.kind === 'front') {
    const f = { ...hit.front, line: hit.front.line + (hit.front.speed * (now - o.shown)) / SECOND };
    if (f.line > o.reach) {
      return null;
    }
    const near = nearestOnFront(f, boat);
    const lives = f.speed > 0 ? ((o.reach - f.line) / f.speed) * SECOND : null;
    const target = frontTarget(f, boat, o.reach);
    const { wind, gust } = frontWind(o.grid, hit.front, nearestOnFront(hit.front, boat));
    return boxWords({
      name: f.warm ? 'Warm front' : 'Cold front',
      wind,
      gust,
      boat,
      at: near,
      heading: Math.atan2(f.sin, f.cos),
      speed: f.speed,
      lives,
      course: courseToMeet(boat, o.speed, target, lives ?? 90 * MINUTE),
      now,
    });
  }
  const s = hit.system;
  const track = systemTrack(o.physics, o.latest, s, o.shown);
  // Where it is now, or for one yet to be born, where it is born.
  let at = now;
  let p = track.at(at);
  while (p === null && at < track.until) {
    at = Math.min(at + MINUTE, track.until);
    p = track.at(at);
  }
  if (p === null) {
    return null;
  }
  const target = systemTarget(track.at, now, boat);
  return boxWords({
    name: s.name,
    wind: s.wind,
    gust: s.gust,
    boat,
    at: p.length > 0 ? nearestOnLine(p, boat) : p,
    heading: p.heading,
    speed: p.speed,
    lives: s.gone === null ? null : s.gone - now,
    course: courseToMeet(boat, o.speed, target, Math.max(track.until - now, 0)),
    now,
  });
}
