// SPDX-License-Identifier: AGPL-3.0-only

// The developer panel's sky: the hour (dawn, noon, dusk, midnight, or any),
// the moon's age and the speed the drawn sky runs at; and a readout of the
// sun's and the moon's height and bearing at the boat, the Hub Star's
// height beside 90° less the scale's degrees for each mile from the centre,
// and every named star's height and bearing, all by the rule in the physics
// module. Setting them moves only the sky this page draws: nothing is sent,
// and the server's sky is unchanged.

import { catalog } from '../catalog';
import { BODY, type Physics, SKY } from '../predict/physics';
import {
  HOURS,
  hourAt,
  moonAgeAt,
  SKY_HOURS,
  type SkyChoice,
  type SkyTime,
  skyPeriods,
  skyTimeFor,
} from '../sky/skytime';

const DEG = Math.PI / 180;
const NAUTICAL_MILE = 1852;

/** The moon's ages the panel offers, as fractions of its month; null leaves it as the hour brings it. */
export const MOON_AGES: (number | null)[] = [null, 0, 0.25, 0.5, 0.75];
/** The speeds the drawn sky can run at: as the world, sixty times faster, held still. */
export const SKY_SPEEDS = [1, 60, 0];

/** Puts the drawn sky at a choice of hour and moon, from a world time in ticks on. */
export function setSky(sky: SkyTime, choice: SkyChoice, ticks: number): void {
  sky.set(skyTimeFor(choice, skyPeriods(catalog.sky)), ticks);
}

function deg(r: number): string {
  return `${(r / DEG).toFixed(1)}°`;
}

function bearing(r: number): string {
  return `${String(Math.round(r / DEG) % 360).padStart(3, '0')}°`;
}

/**
 * The readout, as lines, for the sky at sky time t from the place east and
 * north of the centre, in metres, by the module.
 */
export function skyLines(physics: Physics, t: number, east: number, north: number): string[] {
  const p = skyPeriods(catalog.sky);
  const r = physics.skyAt(t, east, north);
  const sun = SKY.sun;
  const moon = SKY.moon;
  const lines = [
    `hour    ${hourAt(t, p).toFixed(2)} of ${HOURS} at the centre, the moon ${(moonAgeAt(t, p) * 100).toFixed(0)}% through its month`,
    `sun     ${deg(r[sun + BODY.altitude] ?? 0)} up, bearing ${bearing(r[sun + BODY.bearing] ?? 0)}`,
    `moon    ${deg(r[moon + BODY.altitude] ?? 0)} up, bearing ${bearing(r[moon + BODY.bearing] ?? 0)}, ${((r[SKY.lit] ?? 0) * 100).toFixed(0)}% lit`,
  ];
  const miles = Math.hypot(east, north) / NAUTICAL_MILE;
  for (const s of catalog.sky.stars) {
    const b = physics.skyStar(t, east, north, s.rightAscension, s.declination);
    const alt = b[BODY.altitude] ?? 0;
    if (s.declination === 90) {
      lines.push(
        `${s.name.padEnd(12)}${deg(alt)} up; 90° − ${catalog.sky.scale}° × ${miles.toFixed(3)} NM = ${(90 - catalog.sky.scale * miles).toFixed(1)}°`,
      );
    } else if (alt > 0) {
      lines.push(`${s.name.padEnd(12)}${deg(alt)} up, bearing ${bearing(b[BODY.bearing] ?? 0)}`);
    }
  }
  return lines;
}

/** What the panel's sky part needs of the scene. */
export interface SkyWorld {
  skyTime: SkyTime | null;
  skyPhysics: Physics | null;
  skyAt: number;
  ticks: number;
  pose: { east: number; north: number };
}

function option(text: string, value: string, selected = false): HTMLOptionElement {
  const o = document.createElement('option');
  o.textContent = text;
  o.value = value;
  o.selected = selected;
  return o;
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const l = document.createElement('label');
  const s = document.createElement('span');
  s.textContent = text;
  l.append(s, control);
  return l;
}

/**
 * The sky's controls and readout: the readout's text is refreshed by
 * calling update, twice a second.
 */
export function skyPanel(world: SkyWorld): { elements: HTMLElement[]; update(): void } {
  const hour = document.createElement('select');
  hour.append(option('as it is', ''));
  for (const name of Object.keys(SKY_HOURS)) {
    hour.append(option(name, name));
  }
  for (let h = 0; h < HOURS; h += 2) {
    hour.append(option(`${h}:00`, String(h)));
  }
  const moon = document.createElement('select');
  for (const [i, a] of MOON_AGES.entries()) {
    moon.append(
      option(
        a === null
          ? 'as the hour brings it'
          : `${['new', 'first quarter', 'full', 'last quarter'][i - 1]}`,
        String(i),
      ),
    );
  }
  const speed = document.createElement('select');
  for (const [i, s] of SKY_SPEEDS.entries()) {
    speed.append(option(s === 1 ? '×1' : s === 0 ? 'held' : `×${s}`, String(i), i === 0));
  }
  const readout = document.createElement('pre');
  const apply = (): void => {
    const sky = world.skyTime;
    if (sky === null) {
      return;
    }
    const h = hour.value;
    const age = MOON_AGES[Number(moon.value)] ?? null;
    if (h === '' && age === null) {
      sky.offset = 0;
    } else {
      const p = skyPeriods(catalog.sky);
      const now = sky.at(world.ticks);
      const named = SKY_HOURS[h];
      const at = h === '' ? hourAt(now, p) : (named ?? Number(h));
      setSky(sky, { hour: at, moon: age }, world.ticks);
    }
  };
  hour.addEventListener('change', apply);
  moon.addEventListener('change', apply);
  speed.addEventListener('change', () => {
    if (world.skyTime !== null) {
      world.skyTime.speed = SKY_SPEEDS[Number(speed.value)] ?? 1;
    }
  });
  return {
    elements: [
      labelled('Sky: hour', hour),
      labelled('Sky: moon', moon),
      labelled('Sky: speed', speed),
      readout,
    ],
    update() {
      const physics = world.skyPhysics;
      readout.textContent =
        physics === null || world.skyTime === null
          ? 'sky     not yet: the world’s epoch comes with the Welcome'
          : skyLines(physics, world.skyAt, world.pose.east, world.pose.north).join('\n');
    },
  };
}
