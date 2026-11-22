// SPDX-License-Identifier: AGPL-3.0-only

// A race in the sea: its course laid as the server tells it (the
// committee boat at the start line's starboard end, the pin, the marks; an
// island course's finish line, where it lies apart from the start, laid
// with a committee boat of its own; a dash's, along the line of its start
// up the wind, two buoys, the committee boat staying at the start), the
// flags her signals hoist (those of the moment for a race first told
// late), and her gun fired at each signal and for every finisher, from
// the finish line's boat (a dash's from the start's), the winner's the
// loudest. The race the boat sails in goes to the race line's store too.

import { catalog } from '../catalog';
import { STEPS_PER_SECOND } from '../game/clock';
import type { RaceSignalIn, RaceToldIn } from '../net/messages';
import { type CourseLaid, signalFlag } from '../render/committee';

/** What laying a race in the sea needs of the scene. */
export interface RaceSeaDeps {
  lay: (id: number, c: CourseLaid) => void;
  drop: (id: number) => void;
  signals: (id: number, flags: readonly number[]) => void;
  /** Fires the gun of the course laid as id, loud, heard as a racer's. */
  fire: (id: number, loud: number) => void;
  /** The world's tick now. */
  tick: () => number;
}

/** The finish line's course in the sea, beside its race's: where it lies apart from the start. */
export const FINISH_LAID = 0x4000_0000;

/** A dash's finish line's second buoy, beside its race's: the first is FINISH_LAID's pin. */
export const FINISH_END = 0x2000_0000;

/** How far apart the start and the finish lines' ends may be and still be one line, m. */
const ONE_LINE = 5;

/** How far off the start line's own line a dash's finish's buoys may lie, m; and how far beyond its ends, at most. */
const IN_LINE = 3;
const DASH_APART = 600;

/** The flags a race's committee boat flies after a signal: the class's pennant from the warning, P too from the preparatory, none from the start, X for a recall. */
export function raceFlags(
  signal: 'warning' | 'preparatory' | 'start' | 'recall',
  boat: string | undefined,
): number[] {
  const flags = catalog.world.committee.flags;
  const shown =
    signal === 'warning'
      ? [signalFlag(flags, 'class', boat)]
      : signal === 'preparatory'
        ? [signalFlag(flags, 'class', boat), signalFlag(flags, 'preparatory')]
        : signal === 'recall'
          ? [signalFlag(flags, 'recall')]
          : [];
  return shown.filter((f) => f >= 0);
}

/** The signal a race stands at by its ticks: before the preparatory, after it, or started. */
export function signalAt(t: RaceToldIn, tick: number): 'warning' | 'preparatory' | 'start' {
  if (t.start > 0 && tick >= t.start) {
    return 'start';
  }
  if (t.start > 0 && tick >= t.start - 60 * STEPS_PER_SECOND) {
    return 'preparatory';
  }
  return 'warning';
}

/** Whether a race's finish is a line of its own, apart from its start. */
function finishApart(t: RaceToldIn): boolean {
  const f = t.finish;
  const a = t.pin;
  const b = t.committee;
  if (f === null || a === null || b === null) {
    return false;
  }
  const near = (p: { east: number; north: number }, q: { east: number; north: number }) =>
    Math.hypot(p.east - q.east, p.north - q.north) <= ONE_LINE;
  return !((near(f[0], a) && near(f[1], b)) || (near(f[0], b) && near(f[1], a)));
}

/**
 * Whether a race's finish is a dash's: apart from its start, its two ends
 * on the start line's own line, near beyond it: two buoys, no boat.
 */
export function dashFinish(t: RaceToldIn): boolean {
  const f = t.finish;
  const a = t.pin;
  const b = t.committee;
  if (f === null || a === null || b === null || !finishApart(t)) {
    return false;
  }
  const dx = b.east - a.east;
  const dy = b.north - a.north;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) {
    return false;
  }
  for (const p of f) {
    // Off the line's own line, and along it from its middle.
    const off = Math.abs((p.east - a.east) * dy - (p.north - a.north) * dx) / len;
    const along = ((p.east - a.east) * dx + (p.north - a.north) * dy) / len - len / 2;
    if (off > IN_LINE || Math.abs(along) > len / 2 + DASH_APART) {
      return false;
    }
  }
  return true;
}

/** Lays races in the sea and fires their guns, as they are told. */
export function raceSea(d: RaceSeaDeps): {
  told: (t: RaceToldIn) => void;
  signal: (s: RaceSignalIn) => void;
  clear: () => void;
} {
  const laid = new Map<
    number,
    { boat: string | undefined; flags: number[]; apart: boolean; dash: boolean }
  >();
  const drop = (race: number) => {
    const r = laid.get(race);
    laid.delete(race);
    d.drop(race);
    if (r?.apart === true) {
      d.drop(race + FINISH_LAID);
    }
    if (r?.dash === true) {
      d.drop(race + FINISH_END);
    }
  };
  return {
    told(t) {
      if (t.gone) {
        drop(t.race);
        return;
      }
      const boat = catalog.boats[t.boat]?.id;
      const apart = finishApart(t);
      const dash = dashFinish(t);
      const known = laid.get(t.race) ?? {
        boat,
        flags: raceFlags(signalAt(t, d.tick()), boat),
        apart,
        dash,
      };
      known.apart = apart;
      known.dash = dash;
      laid.set(t.race, known);
      d.lay(t.race, { committee: t.committee, pin: t.pin, marks: t.marks, flags: known.flags });
      if (dash && t.finish !== null) {
        // A dash's finish: a buoy at each end, the guns from the start's boat.
        d.lay(t.race + FINISH_LAID, { committee: null, pin: t.finish[0], marks: [], flags: [] });
        d.lay(t.race + FINISH_END, { committee: null, pin: t.finish[1], marks: [], flags: [] });
      } else if (apart && t.finish !== null) {
        // The finish's boat at the line's starboard end as the boats come
        // in: the second end as told.
        d.lay(t.race + FINISH_LAID, {
          committee: t.finish[1],
          pin: t.finish[0],
          marks: [],
          flags: [],
        });
      }
    },
    signal(s) {
      const r = laid.get(s.race);
      if (r !== undefined && s.signal !== 'finish' && s.signal !== 'other') {
        r.flags = raceFlags(s.signal, r.boat);
        d.signals(s.race, r.flags);
      }
      if (s.gun) {
        const loud = s.signal === 'start' || (s.signal === 'finish' && s.place === 1) ? 1.6 : 1;
        d.fire(
          s.signal === 'finish' && r?.apart === true && r.dash !== true
            ? s.race + FINISH_LAID
            : s.race,
          loud,
        );
      }
    },
    clear() {
      for (const race of [...laid.keys()]) {
        drop(race);
      }
    },
  };
}
