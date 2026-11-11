// SPDX-License-Identifier: AGPL-3.0-only

// The crew's rules, with no drawing: to windward of the boom with a
// hysteresis, a tack told from a gybe, the crossings' order and stagger
// and their paths, the leaning out and sitting up with the helm, and the
// change of places when the controls are handed over; and who fills the
// keelboat's stations as people come aboard.

import { describe, expect, test } from 'vitest';
import { catalog } from '../../catalog';
import { crewPlaces } from './crew';
import {
  CROSS_GAP,
  type CrewAboard,
  type CrewPlan,
  CrewRules,
  CrewSide,
  changePath,
  crewPlan,
  crossingWay,
  crossPath,
  DUCK_DOWN,
  DUCK_NEAR,
  DUCK_UP,
  duckFor,
  duckStep,
  LEAN_STAGGER,
  LEAN_TIME,
  moveAt,
  SIDE_HYSTERESIS,
} from './crewrules';

const DEG = Math.PI / 180;
const keelboat = catalog.boats.find((b) => b.stations.filter((s) => s.windward).length > 1);

/** The keelboat's plan, its deck as her model's hull solid has it (numbers from her model). */
function keelPlan(): CrewPlan {
  const kind = keelboat as NonNullable<typeof keelboat>;
  // Her hull's solid: z, half-beam, sheer, keel depth, transom to stem.
  const stations = [
    [3.05, 0.8, 0.702, -0.08],
    [2.021, 1.04, 0.6987, 0.099],
    [1.335, 1.14, 0.6968, 0.1869],
    [0.649, 1.2, 0.6954, 0.2498],
    [-0.037, 1.2215, 0.6945, 0.2874],
    [-0.723, 1.2115, 0.6944, 0.3],
    [-1.409, 1.16, 0.6954, 0.2988],
    [-2.095, 1.045, 0.6977, 0.2737],
    [-3.81, 0, 0.712, -0.712],
  ];
  return crewPlan(
    kind.stations,
    {
      stations,
      exponent: 2.2,
      cockpit: { fore: 0.25, aft: 2.55, halfWidth: 0.7324, floor: 0.5036 },
      board: { y: -0.3, z: -0.9, span: 1, chord: 0.5, thickness: 0.03 },
    },
    { y: 1.45, z: -kind.physics.rig.mastPosition },
    kind.physics.rig.foot,
  );
}

/** n aboard, the skipper holding the controls. */
function aboard(n: number, holder = 0): CrewAboard {
  return { people: Array.from({ length: n }, (_, seat) => ({ seat, look: 100 + seat })), holder };
}

/** Steps the rules for seconds at dt, the boom and wind held. */
function sail(
  r: CrewRules,
  seconds: number,
  boom: number,
  windOffBow = 0.7,
  depth = 0,
  dt = 1 / 30,
): void {
  for (let t = 0; t < seconds; t += dt) {
    r.step({ dt, boom, windOffBow, depth });
  }
}

test('there is a keelboat with a crew to windward', () => {
  expect(keelboat).toBeDefined();
});

describe('who sits where on the keelboat, as seats fill', () => {
  const stations = keelboat?.stations ?? [];
  test.each([
    [1, []],
    [2, [1]],
    [3, [1, 2]],
    [4, [1, 2, 3]],
    [5, [1, 2, 3, 4]],
  ])('%i aboard: the stations %j', (n, want) => {
    expect(crewPlaces(aboard(n), stations.length).map((p) => p.station)).toEqual(want);
  });

  test('the trimmer just aft of the cuddy, legs in; the bow hand and the middle on the rail beside it; a fifth on the quarter', () => {
    const [helm, trimmer, bow, middle, quarter] = stations;
    expect(trimmer?.pose).toBe('seated');
    expect(bow?.pose).toBe('rail');
    expect(middle?.pose).toBe('rail');
    expect(quarter?.pose).toBe('rail');
    for (const s of [trimmer, bow, middle, quarter]) {
      expect(s?.windward).toBe(true);
    }
    expect(helm?.windward ?? false).toBe(false);
    // The forward two a rail's width apart; the quarter aft of the helm.
    expect(Math.abs((bow?.at[2] ?? 0) - (middle?.at[2] ?? 0))).toBeCloseTo(0.53, 2);
    expect((quarter?.at[2] ?? 0) - (helm?.at[2] ?? 0)).toBeGreaterThan(0.45);
  });
});

describe('the side, away from the boom', () => {
  test('first met: away from the boom, without a crossing', () => {
    const s = new CrewSide();
    expect(s.step(0.3, 0)).toBe(false);
    expect(s.side).toBe(-1);
    const t = new CrewSide();
    t.step(-0.3, 0);
    expect(t.side).toBe(1);
  });

  test('changes only once the boom is past the centreline by the hysteresis', () => {
    const s = new CrewSide();
    s.step(-0.4, 0);
    expect(s.side).toBe(1);
    // A slatting boom: across the centreline, but not by 5°.
    for (const b of [0, 2 * DEG, 4.9 * DEG, -3 * DEG, 4 * DEG]) {
      expect(s.step(b, 0)).toBe(false);
      expect(s.side).toBe(1);
    }
    expect(SIDE_HYSTERESIS).toBeCloseTo(5 * DEG, 9);
    expect(s.step(5.1 * DEG, 0)).toBe(true);
    expect(s.side).toBe(-1);
    // Back over by less than the hysteresis: held.
    expect(s.step(-4 * DEG, 0)).toBe(false);
    expect(s.side).toBe(-1);
  });

  test('a tack with the wind forward of the beam, a gybe abaft it', () => {
    const s = new CrewSide();
    s.step(-0.2, 0);
    s.step(0.2, 30 * DEG);
    expect(s.tack).toBe(true);
    s.step(-1.3, 170 * DEG);
    expect(s.tack).toBe(false);
    s.step(1.3, -150 * DEG);
    expect(s.tack).toBe(false);
  });
});

describe('the crew to windward', () => {
  test('everyone on the side away from the boom, on both tacks, whatever the helm', () => {
    const plan = keelPlan();
    for (const boom of [0.3, -0.3, 1.2, -1.2]) {
      const r = new CrewRules(plan);
      r.set(aboard(5));
      // The helm hiking to leeward or not: the crew go by the boom.
      sail(r, 0.1, boom, 0.7, 0.3);
      for (const m of r.members.filter((x) => x.station > 0)) {
        expect(m.side, `boom ${boom}`).toBe(-Math.sign(boom));
        expect(m.moving).toBeNull();
      }
    }
  });

  test('a tack: each crosses in turn, through the cockpit first, then round the mast in file, the bow hand leading; all on the new side after, the two forward in each other’s places', () => {
    const plan = keelPlan();
    const r = new CrewRules(plan);
    r.set(aboard(5));
    sail(r, 1, -0.2);
    r.step({ dt: 1 / 30, boom: 0.2, windOffBow: 30 * DEG, depth: 0 });
    expect(r.side.tack).toBe(true);
    const start = (station: number): number => {
      const m = r.members.find((x) => x.moving?.from.station === station)?.moving;
      return -(m?.t ?? Number.NaN);
    };
    // Trimmer, quarter, bow hand, middle: 0.4 s apart.
    expect([1, 4, 2, 3].map(start).map((t) => Math.round((t + 1 / 30) / CROSS_GAP))).toEqual([
      0, 1, 2, 3,
    ]);
    // The bow hand leads round the mast to the middle's place, the middle following to the bow hand's.
    const seatAt = (station: number): number | undefined =>
      r.members.find((x) => x.station === station)?.seat;
    expect([seatAt(2), seatAt(3)]).toEqual([3, 2]);
    sail(r, 10, 0.2, 30 * DEG);
    for (const m of r.members.filter((x) => x.station > 0)) {
      expect(m.side).toBe(-1);
      expect(m.moving).toBeNull();
    }
    expect([seatAt(2), seatAt(3)]).toEqual([3, 2]);
    // Told the crew afresh, they keep their places.
    r.set(aboard(5));
    expect([seatAt(2), seatAt(3)]).toEqual([3, 2]);
  });

  test('a gybe: the other way about, the bow hand first and the trimmer last', () => {
    const r = new CrewRules(keelPlan());
    r.set(aboard(5));
    sail(r, 1, -1.2, 160 * DEG);
    r.step({ dt: 1 / 30, boom: 0.3, windOffBow: 170 * DEG, depth: 0 });
    expect(r.side.tack).toBe(false);
    const order = r.members
      .filter((m) => m.moving !== null)
      .sort((a, b) => (b.moving?.t ?? 0) - (a.moving?.t ?? 0))
      .map((m) => m.moving?.from.station);
    expect(order).toEqual([2, 3, 4, 1]);
  });

  test('the ways across: the trimmer and the quarter through the cockpit, the forward two round the front of the mast', () => {
    const plan = keelPlan();
    const st = plan.stations;
    expect([1, 2, 3, 4].map((i) => crossingWay(plan, st[i] as (typeof st)[number]))).toEqual([
      'cockpit',
      'mast',
      'mast',
      'cockpit',
    ]);
    for (const i of [2, 3]) {
      const p = crossPath(plan, st[i] as (typeof st)[number], 1);
      // Forward of the mast at its furthest, and from one side deck to the other.
      expect(Math.min(...p.z)).toBeLessThan(plan.mastZ - 0.3);
      expect(p.x[0]).toBeGreaterThan(0.5);
      expect(p.x.at(-1)).toBeLessThan(-0.5);
      // Each crossing about 2 to 4 s at 1 m/s.
      expect(p.length).toBeGreaterThan(1.5);
      expect(p.length).toBeLessThan(4.5);
    }
    for (const i of [1, 4]) {
      const p = crossPath(plan, st[i] as (typeof st)[number], -1);
      // Straight across the cockpit's floor.
      expect(Math.max(...p.y) - Math.min(...p.y)).toBeLessThan(0.01);
      expect(p.y[0]).toBeCloseTo(0.5036, 3);
      expect(Math.sign(p.x[0] ?? 0)).toBe(-1);
      expect(Math.sign(p.x.at(-1) ?? 0)).toBe(1);
    }
  });

  test('crossing a boom that comes back before the crossing is done: back again after', () => {
    const r = new CrewRules(keelPlan());
    r.set(aboard(2));
    sail(r, 1, -0.2);
    sail(r, 1, 0.2);
    sail(r, 10, -0.2);
    const m = r.members.find((x) => x.station === 1);
    expect(m?.side).toBe(1);
    expect(m?.moving).toBeNull();
  });
});

describe('sitting up and leaning out with the helm', () => {
  test('each leans out over LEAN_TIME once the helm hikes, aft first, LEAN_STAGGER apart, and sits up again only below the hysteresis', () => {
    const r = new CrewRules(keelPlan());
    r.set(aboard(5));
    sail(r, 1, -0.2, 0.7, 0);
    expect(r.members.every((m) => m.lean === 0)).toBe(true);
    const dt = 1 / 60;
    // The helm out past the first quarter of the hiking clip.
    const seen = new Map<number, number>();
    for (let t = 0; t < 3; t += dt) {
      r.step({ dt, boom: -0.2, windOffBow: 0.7, depth: 0.4 });
      for (const m of r.members) {
        if (m.station > 0 && m.lean > 0 && !seen.has(m.station)) {
          seen.set(m.station, t);
        }
      }
    }
    // Aft first: the quarter, the trimmer, the middle, the bow hand.
    const begun = [4, 1, 3, 2].map((s) => seen.get(s) ?? Number.NaN);
    for (let k = 1; k < begun.length; k++) {
      expect((begun[k] as number) - (begun[k - 1] as number)).toBeCloseTo(LEAN_STAGGER, 1);
    }
    expect(r.members.filter((m) => m.station > 0).every((m) => m.lean === 1)).toBe(true);
    // A blend, not a jump: half way after half the time.
    const half = new CrewRules(keelPlan());
    half.set(aboard(2));
    sail(half, 1, -0.2);
    for (let t = 0; t < LEAN_TIME / 2 + 1e-6; t += dt) {
      half.step({ dt, boom: -0.2, windOffBow: 0.7, depth: 0.4 });
    }
    // The trimmer is the second aft (behind the helm's station): its turn after one stagger.
    const lean = half.members.find((m) => m.station === 1)?.lean ?? 0;
    expect(lean).toBeGreaterThan(0);
    expect(lean).toBeLessThan(1);
    // Held out while the helm eases in a little; in, once well in.
    sail(r, 2, -0.2, 0.7, 0.2);
    expect(r.members.filter((m) => m.station > 0).every((m) => m.lean === 1)).toBe(true);
    sail(r, 3, -0.2, 0.7, 0.1);
    expect(r.members.filter((m) => m.station > 0).every((m) => m.lean === 0)).toBe(true);
  });
});

describe('a change of hands', () => {
  test('the old helm and the bow hand walk to each other’s places along the windward side deck, one inboard of the other; the helm away meanwhile', () => {
    const plan = keelPlan();
    const r = new CrewRules(plan);
    r.set(aboard(3));
    sail(r, 1, 0.3);
    expect(r.helmAway).toBe(false);
    // The skipper hands the controls to the bow hand (seat 2).
    r.set(aboard(3, 2));
    const skipper = r.members.find((m) => m.seat === 0);
    const bow = r.members.find((m) => m.seat === 2);
    expect(skipper?.station).toBe(2);
    expect(bow?.station).toBe(-1);
    expect(skipper?.moving?.kind).toBe('change');
    expect(bow?.moving?.kind).toBe('change');
    expect(skipper?.moving?.from.station).toBe(-1);
    expect(bow?.moving?.from.station).toBe(2);
    expect(r.helmAway).toBe(true);
    // Along the windward (port) side deck, one inboard of the other, at once.
    for (const m of [skipper, bow]) {
      const p = m?.moving?.path;
      expect(p).toBeDefined();
      expect(Math.max(...(p?.x ?? [0]))).toBeLessThan(-0.5);
      expect(m?.moving?.t).toBeCloseTo(0, 9);
    }
    expect(skipper?.moving?.path.x[0]).not.toBeCloseTo(bow?.moving?.path.x.at(-1) ?? 0, 2);
    // About 2 m at 1 m/s and the getting up and down.
    expect(skipper?.moving?.duration).toBeGreaterThan(2);
    expect(skipper?.moving?.duration).toBeLessThan(4.5);
    sail(r, 5, 0.3);
    expect(r.helmAway).toBe(false);
    expect(skipper?.moving).toBeNull();
    expect(skipper?.side).toBe(-1);
    // The trimmer did not move.
    expect(r.members.find((m) => m.seat === 1)?.station).toBe(1);
  });

  test('the helm and the trimmer beside the cockpit: the new helm along the side deck, the old one on the cockpit’s floor, in turn to keep apart', () => {
    const plan = keelPlan();
    const r = new CrewRules(plan);
    r.set(aboard(2));
    sail(r, 1, 0.3);
    r.set(aboard(2, 1));
    const skipper = r.members.find((m) => m.seat === 0)?.moving;
    const trimmer = r.members.find((m) => m.seat === 1)?.moving;
    expect(skipper).toBeDefined();
    expect(trimmer).toBeDefined();
    // The trimmer along the side deck, the skipper inboard on the floor, in its lane to leeward of the middle.
    expect(Math.min(...(trimmer?.path.x.map((x) => -x) ?? [0]))).toBeGreaterThan(0.8);
    expect(Math.min(...(skipper?.path.y ?? [1]))).toBeLessThan(0.55);
    expect(Math.max(...(skipper?.path.x ?? [0]))).toBeGreaterThan(0.2);
    // One goes at once, the other waits.
    expect(Math.max(skipper?.t ?? 1, trimmer?.t ?? 1)).toBeCloseTo(0, 9);
    expect(Math.min(skipper?.t ?? 0, trimmer?.t ?? 0)).toBeLessThan(0);
    sail(r, 8, 0.3);
    expect(r.members.every((m) => m.moving === null)).toBe(true);
    expect(r.members.find((m) => m.seat === 0)?.station).toBe(1);
  });

  test('the walk’s path: beside the cockpit, on its floor in the lanes for each way, apart; forward of it, along the side deck', () => {
    const plan = keelPlan();
    const forward = changePath(plan, 1, 1.25, 0.8);
    const aft = changePath(plan, 1, 0.8, 1.25);
    for (const p of [forward, aft]) {
      expect(Math.max(...p.y)).toBeLessThan(0.55);
      expect(Math.max(...p.x)).toBeLessThan(0.6);
    }
    const laneAt = (p: typeof forward, z: number): number => {
      let best = 0;
      let d = Number.POSITIVE_INFINITY;
      p.z.forEach((zz, i) => {
        if (Math.abs(zz - z) < d) {
          d = Math.abs(zz - z);
          best = p.x[i] as number;
        }
      });
      return best;
    };
    expect(laneAt(aft, 1.02) - laneAt(forward, 1.02)).toBeGreaterThan(0.4);
    const deck = changePath(plan, 1, 1.25, -0.66, -0.08);
    expect(Math.min(...deck.x)).toBeGreaterThan(0.7);
    expect(Math.max(...deck.x)).toBeLessThan(1.15);
    expect(Math.min(...deck.y)).toBeGreaterThan(0.69);
  });

  test('someone coming aboard is put at their station at once; nobody walks', () => {
    const r = new CrewRules(keelPlan());
    r.set(aboard(2));
    sail(r, 1, 0.3);
    r.set(aboard(4));
    expect(r.members.every((m) => m.moving === null)).toBe(true);
    expect(r.members.filter((m) => m.station > 0).map((m) => m.station)).toEqual([1, 2, 3]);
  });
});

test('a move: getting up, along the path at 1 m/s, sitting down', () => {
  const plan = keelPlan();
  const p = crossPath(plan, plan.stations[1] as (typeof plan.stations)[number], 1);
  const m = {
    path: p,
    from: { station: 1, side: 1 },
    to: { station: 1, side: -1 },
    t: 0,
    duration: 0,
    kind: 'cross' as const,
    waited: 0,
  };
  expect(moveAt({ ...m, t: 0.25 })).toEqual({ rise: 0.5, along: 0, sit: 0 });
  expect(moveAt({ ...m, t: 1 }).along).toBeCloseTo(0.5, 6);
  const end = moveAt({ ...m, t: 0.5 + p.length + 0.25 });
  expect(end.along).toBeCloseTo(p.length, 6);
  expect(end.sit).toBeCloseTo(0.5, 6);
});

describe('ducking under the boom', () => {
  test('fully as the boom comes within reach of the head, not at all far from it, sooner as it swings near', () => {
    const plan = keelPlan();
    // A head over the cockpit at z 0.45, 1.4 m up: the boom swung over it.
    const head = { x: 0.3, y: 1.4, z: 0.45 };
    expect(duckFor(plan, 0, 0, head)).toBe(1);
    expect(duckFor(plan, -1, 0, head)).toBe(0);
    // Swinging toward it fast: down before it is there.
    const swing = Math.atan2(0.3, 0.45 + 1.14);
    expect(duckFor(plan, swing - 0.4, 0, head)).toBeLessThan(1);
    expect(duckFor(plan, swing - 0.4, 2, head)).toBe(1);
    expect(DUCK_NEAR).toBeGreaterThan(0.3);
    // Down quickly, up slowly.
    expect(duckStep(0, 1, DUCK_DOWN / 2)).toBeCloseTo(0.5, 6);
    expect(duckStep(1, 0, DUCK_UP / 2)).toBeCloseTo(0.5, 6);
  });
});
