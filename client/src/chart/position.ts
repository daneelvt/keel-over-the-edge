// SPDX-License-Identifier: AGPL-3.0-only

// A position is a latitude and a longitude, the same words everywhere. The
// pole is the disk's centre, under the Hub Star: the latitude is the Hub
// Star's height, 90° at the pole falling 10° for each nautical mile out,
// 45° at the rim, every one north; the longitude is the meridian, the true
// bearing of the position from the pole, 000° to 359°. Both are given to
// the minute, rounded to the nearest, a half up, and carried, so no
// position reads 60′; written as IHO S-4 writes them (B-131), one space
// between, the longitude's degrees in three figures and no letter:
// 67°24′N 045°12′; at the pole the longitude is left out: 90°00′N. The
// server's twin is internal/chart/position.go; both are held to
// internal/chart/testdata/positions.json.

const MILE = 1852;
const DEGREES_PER_MILE = 10;

/** A position to the minute: the latitude in whole minutes north, the longitude in whole minutes 0 to 21,599, and whether it is the pole. */
export interface Position {
  latitude: number;
  longitude: number;
  pole: boolean;
}

/** A number of minutes to the nearest whole one, a half up. */
function roundMinutes(m: number): number {
  return Math.floor(m + 0.5);
}

/** The position of a point m east and north of the centre. */
export function positionOf(east: number, north: number): Position {
  const r = Math.sqrt(east * east + north * north) / MILE;
  const lat = roundMinutes((90 - DEGREES_PER_MILE * r) * 60);
  if (lat >= 90 * 60) {
    return { latitude: 90 * 60, longitude: 0, pole: true };
  }
  let b = (Math.atan2(east, north) * 180) / Math.PI;
  if (b < 0) {
    b += 360;
  }
  return { latitude: lat, longitude: roundMinutes(b * 60) % (360 * 60), pole: false };
}

/** The position as written: 67°24′N 045°12′, or 90°00′N. */
export function positionText(p: Position): string {
  const lat = `${Math.floor(p.latitude / 60)}°${String(p.latitude % 60).padStart(2, '0')}′N`;
  if (p.pole) {
    return lat;
  }
  const lon = `${String(Math.floor(p.longitude / 60)).padStart(3, '0')}°${String(p.longitude % 60).padStart(2, '0')}′`;
  return `${lat} ${lon}`;
}

/** The position of a point m east and north of the centre, as written. */
export function formatPosition(east: number, north: number): string {
  return positionText(positionOf(east, north));
}

/** The latitude of a parallel a whole number of degrees, as the chart letters it: "80°N". */
export function parallelText(degrees: number): string {
  return `${degrees}°N`;
}

/** A meridian a whole number of degrees, as the chart letters it: "030°". */
export function meridianText(degrees: number): string {
  return `${String(((degrees % 360) + 360) % 360).padStart(3, '0')}°`;
}

/** The latitude at r m from the centre, degrees. */
export function latitudeAt(r: number): number {
  return 90 - (DEGREES_PER_MILE * r) / MILE;
}

/** How far from the centre a latitude lies, m. */
export function radiusOf(latitude: number): number {
  return ((90 - latitude) / DEGREES_PER_MILE) * MILE;
}

/**
 * Reads a position as a person might write it: the latitude then the
 * longitude, each degrees and minutes, the degrees marked by ° or a space,
 * the minutes by ′, ' or nothing, decimal if wanted, the latitude's N
 * optional, never an S; a latitude alone is the pole only at 90°. It gives
 * the point m east and north of the centre, or an error's words.
 */
export function parsePosition(text: string): { east: number; north: number } | { error: string } {
  const parts: string[] = [];
  for (let f of text.split(/[ °′',º]+/)) {
    if (f === 'N' || f === 'n') {
      continue;
    }
    if (f === 'S' || f === 's') {
      return { error: 'every latitude is north' };
    }
    f = f.replace(/[Nn]$/, '');
    if (f !== '') {
      parts.push(f);
    }
  }
  const num = (i: number): number | null => {
    const s = parts[i] ?? '';
    if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) {
      return null;
    }
    return Number(s);
  };
  if (parts.length !== 2 && parts.length !== 4) {
    return {
      error:
        'write a position as degrees and minutes of latitude, then of longitude: 67°24′N 045°12′',
    };
  }
  const d = num(0);
  const m = num(1);
  if (d === null || m === null) {
    return { error: `${parts[d === null ? 0 : 1]} is not a number of degrees or minutes` };
  }
  if (m >= 60 || !Number.isInteger(d)) {
    return { error: 'the latitude’s degrees must be whole and its minutes under 60' };
  }
  const lat = d + m / 60;
  let lon = 0;
  if (parts.length === 2) {
    if (lat !== 90) {
      return { error: 'a latitude alone is the pole’s, 90°00′N: give the longitude too' };
    }
    return { east: 0, north: 0 };
  }
  const ld = num(2);
  const lm = num(3);
  if (ld === null || lm === null) {
    return { error: `${parts[ld === null ? 2 : 3]} is not a number of degrees or minutes` };
  }
  if (lm >= 60 || !Number.isInteger(ld) || ld >= 360) {
    return { error: 'the longitude’s degrees must be whole, under 360, and its minutes under 60' };
  }
  lon = ld + lm / 60;
  if (lat > 90) {
    return { error: 'no latitude is above 90°' };
  }
  const r = radiusOf(lat);
  const b = (lon * Math.PI) / 180;
  return { east: r * Math.sin(b), north: r * Math.cos(b) };
}
