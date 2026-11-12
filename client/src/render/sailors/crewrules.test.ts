// SPDX-License-Identifier: AGPL-3.0-only

// The crew's rules, with no drawing: to windward of the boom with a
// hysteresis, a tack told from a gybe, the crossings' order and stagger
// and their paths, the leaning out and sitting up with the helm, and the
// change of places when the controls are handed over; and who fills the
// keelboat's stations as people come aboard.

import { readFileSync } from 'node:fs';
import { type Object3D, Vector3 } from 'three';
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
import { type Company, company } from './ship';
import {
  IDLE_BLEND,
  idleAt,
  idleStart,
  LADDER_TIME,
  RELIEF_AFT,
  type ShipMember,
  type ShipPlan,
  ShipRules,
  ShipWayGraph,
  shipPlan,
  standPoint,
} from './shiprules';

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

// --- The tall ship's company ------------------------------------------------

const tallShip = catalog.boats.find((b) => b.stations.some((s) => s.pose === 'aloft'));

/** The tall ship's company's places and ways, as her model's `company` node has them. */
function shipCompany(): Company {
  const kind = tallShip as NonNullable<typeof tallShip>;
  const buf = readFileSync(new URL(`../../../../art/${kind.art.model}`, import.meta.url));
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString()) as {
    nodes: { name?: string; extras?: unknown }[];
  };
  const node = json.nodes.find((n) => n.name === 'company');
  return company(
    new Map([['company', { userData: node?.extras } as unknown as Object3D]]),
  ) as Company;
}

/** A ship's rules for her stations, with n aboard (seat k in look k) and holder holding. */
function shipRules(n: number, holder = 0, still = false): ShipRules {
  const kind = tallShip as NonNullable<typeof tallShip>;
  const plan = shipPlan(kind.stations, shipCompany()) as ShipPlan;
  const rules = new ShipRules({ stations: kind.stations, ship: plan }, still);
  rules.set(shipCrew(n, holder), false);
  return rules;
}

function shipCrew(n: number, holder = 0): CrewAboard {
  return { people: Array.from({ length: n }, (_, seat) => ({ seat, look: seat })), holder };
}

/** A frame of the ship: her after yards' turn, heel and wind, time on. */
function sailShip(
  rules: ShipRules,
  dt: number,
  yards: number,
  at: { time: number },
  heel = 0,
  wind = 5,
): void {
  at.time += dt;
  rules.step({ dt, boom: 0, windOffBow: 0, depth: 0, ship: { yards, heel, wind, time: at.time } });
}

/** Where each member stands now, by seat: along their walk or at their place. */
function standing(rules: ShipRules): Map<number, { at: Vector3; gone: boolean; walking: boolean }> {
  const out = new Map<number, { at: Vector3; gone: boolean; walking: boolean }>();
  const sp = { at: new Vector3(), facing: 0, side: 1 };
  for (const m of rules.members) {
    const at = new Vector3();
    const r = m.ship.route;
    if (r !== null) {
      const w = r.at(Math.max(r.legs[0]?.t0 ?? 0, m.ship.t), at);
      out.set(m.seat, { at, gone: w.gone, walking: true });
    } else {
      const s = kindStations()[m.station];
      rules.spotOf(m.station, sp);
      if (s !== undefined) {
        standPoint(s, sp, at);
      }
      out.set(m.seat, { at, gone: false, walking: false });
    }
  }
  return out;
}

const kindStations = () => (tallShip as NonNullable<typeof tallShip>).stations;
/** The mainmast, fore (−) of which a station is forward. */
const MAIN_Z = -0.578;

describe('the tall ship’s company, as seats fill', () => {
  test('the wheel; the weather and the lee side beside it; the gangway, the taffrail, two lookouts forward and one in the top; then pairs fore and aft of the mainmast in turn', () => {
    const st = kindStations();
    expect(st).toHaveLength(40);
    expect(st[0]?.pose).toBe('standing');
    expect([st[1]?.windward, st[2]?.lee, st[3]?.windward]).toEqual([true, true, true]);
    // Beside the wheel, a pace either side.
    for (const k of [1, 2]) {
      expect(Math.abs((st[k]?.at[2] as number) - (st[0]?.at[2] as number))).toBeLessThan(0.5);
      expect(Math.abs(st[k]?.at[0] as number)).toBeGreaterThan(1);
    }
    // The gangway at the break of the quarterdeck, the taffrail aft.
    expect(st[3]?.at[2]).toBeLessThan(7);
    expect(st[4]?.at[2]).toBeGreaterThan(15);
    // The lookouts forward, a pace or two apart; one aloft.
    expect(st[5]?.at[2]).toBeLessThan(-14);
    expect(st[6]?.at[2]).toBeLessThan(-14);
    expect(Math.abs((st[5]?.at[0] as number) - (st[6]?.at[0] as number))).toBeLessThan(2);
    expect(st[7]?.pose).toBe('aloft');
    expect(st[7]?.at[1]).toBeGreaterThan(13);
    // The rest in pairs, a side each, in turn forward and aft of the mainmast.
    for (let k = 8; k < 40; k += 2) {
      const a = st[k] as (typeof st)[number];
      const b = st[k + 1] as (typeof st)[number];
      expect(a.at[0], `${k}`).toBeCloseTo(-(b.at[0] as number), 6);
      expect(a.at[2], `${k}`).toBe(b.at[2]);
      const forward = (a.at[2] as number) < MAIN_Z;
      expect(forward, `${k}`).toBe((k / 2) % 2 === 1);
    }
  });

  test.each([
    [1, []],
    [3, [1, 2]],
    [8, [1, 2, 3, 4, 5, 6, 7]],
  ])('%i aboard: at stations %j, the skipper at the wheel', (n, stations) => {
    const rules = shipRules(n);
    expect(rules.wheelSeat).toBe(0);
    expect(rules.members.map((m) => m.station)).toEqual(stations);
  });

  test('forty aboard: everyone at their own station, peopled fore and aft', () => {
    const rules = shipRules(40);
    expect(rules.members.map((m) => m.station)).toEqual(
      Array.from({ length: 39 }, (_, i) => i + 1),
    );
    const zs = rules.members.map((m) => kindStations()[m.station]?.at[2] as number);
    expect(zs.filter((z) => z < MAIN_Z).length).toBeGreaterThan(14);
    expect(zs.filter((z) => z > MAIN_Z).length).toBeGreaterThan(14);
  });

  test('nobody within a person’s breadth of another where they stand, with the weather on either side', () => {
    for (const yards of [0.4, -0.4]) {
      const rules = shipRules(40);
      sailShip(rules, 1 / 30, yards, { time: 0 });
      const at = [...standing(rules).values()].map((s) => s.at);
      for (let i = 0; i < at.length; i++) {
        for (let j = 0; j < i; j++) {
          const a = at[i] as Vector3;
          const b = at[j] as Vector3;
          if (Math.abs(a.y - b.y) < 1) {
            expect(Math.hypot(a.x - b.x, a.z - b.z), `${i} and ${j}`).toBeGreaterThan(0.45);
          }
        }
      }
    }
  });
});

describe('the tall ship’s weather side: the side her after yards are braced for', () => {
  /** A seat's side now, by where they stand (+ starboard). */
  const sideOf = (rules: ShipRules, seat: number): number =>
    Math.sign((standing(rules).get(seat) as { at: Vector3 }).at.x);

  test.each([
    [0.4, 1],
    [-0.4, -1],
  ])(
    'the yards turned %f: the weather side %i; the master to windward, the mate to leeward, the gangway and the top to windward',
    (yards, weather) => {
      const rules = shipRules(8);
      sailShip(rules, 1 / 30, yards, { time: 0 });
      expect(rules.side.side).toBe(weather);
      expect(sideOf(rules, 1)).toBe(weather);
      expect(sideOf(rules, 2)).toBe(-weather);
      expect(sideOf(rules, 3)).toBe(weather);
      expect(sideOf(rules, 7)).toBe(weather);
      // Nobody walks to begin with.
      expect(rules.members.every((m) => m.ship.route === null)).toBe(true);
    },
  );

  test('yards slatting about square move nobody', () => {
    const rules = shipRules(8);
    const t = { time: 0 };
    sailShip(rules, 1 / 30, 0.4, t);
    for (let i = 0; i < 300; i++) {
      sailShip(rules, 1 / 30, 2 * DEG * Math.sin(i / 10), t);
    }
    expect(rules.side.changes).toBe(0);
    expect(rules.members.every((m) => m.ship.route === null)).toBe(true);
  });

  test('through a tack: as the after yards swing, the four to windward and to leeward walk across, nobody else; each to the new side', () => {
    const rules = shipRules(40);
    const t = { time: 0 };
    sailShip(rules, 1 / 30, 0.45, t);
    // Mainsail haul: the after yards swing over 30 s from one side to the other.
    let walked = new Set<number>();
    for (let i = 0; i <= 900; i++) {
      sailShip(rules, 1 / 30, 0.45 - (0.9 * i) / 900, t);
      for (const m of rules.members) {
        if (m.ship.route !== null) {
          walked.add(m.seat);
        }
      }
    }
    expect(rules.side.side).toBe(-1);
    expect(rules.side.changes).toBe(1);
    expect([...walked].sort((a, b) => a - b)).toEqual([1, 2, 3, 7]);
    walked = new Set();
    for (let i = 0; i < 60 * 30; i++) {
      sailShip(rules, 1 / 30, -0.45, t);
    }
    expect(rules.members.every((m) => m.ship.route === null)).toBe(true);
    expect(sideOf(rules, 1)).toBe(-1);
    expect(sideOf(rules, 2)).toBe(1);
    expect(sideOf(rules, 3)).toBe(-1);
    expect(sideOf(rules, 7)).toBe(-1);
  });
});

describe('never still: an idle at a time', () => {
  test('a change every 20 to 60 seconds, by the seat and the world’s time, each seat in its own time', () => {
    for (const seat of [1, 7, 23]) {
      const starts = Array.from({ length: 200 }, (_, k) => idleStart(seat, k));
      for (let k = 1; k < starts.length; k++) {
        const gap = (starts[k] as number) - (starts[k - 1] as number);
        expect(gap).toBeGreaterThanOrEqual(20);
        expect(gap).toBeLessThanOrEqual(60);
      }
    }
    expect(idleStart(1, 5)).not.toBe(idleStart(2, 5));
  });

  test('the same for every client at the same moment; blended over IDLE_BLEND as one goes into the next', () => {
    const a = { now: 0, was: 0, f: 0 };
    const b = { now: 0, was: 0, f: 0 };
    for (let time = 0; time < 2000; time += 7.3) {
      idleAt(9, time, 5, a);
      idleAt(9, time, 5, b);
      expect(b).toEqual(a);
    }
    const k = 12;
    const t0 = idleStart(9, k);
    expect(idleAt(9, t0 + IDLE_BLEND / 2, 5, a).f).toBeCloseTo(0.5, 6);
    expect(idleAt(9, t0 + IDLE_BLEND + 1, 5, a).f).toBe(1);
    expect(idleAt(9, t0 - 0.01, 5, b).now).toBe(a.was);
    // The five standing idles all come up in time.
    const seen = new Set<number>();
    for (let time = 0; time < 5000; time += 10) {
      seen.add(idleAt(9, time, 5, a).now);
    }
    expect(seen.size).toBe(5);
  });

  test('talking only with someone within 2.5 m: the two lookouts have each other, the one at the taffrail nobody', () => {
    const rules = shipRules(8);
    sailShip(rules, 1 / 30, 0.4, { time: 0 });
    const m = (seat: number) => rules.members.find((x) => x.seat === seat) as ShipMember;
    expect(m(5).ship.company).toBe(true);
    expect(m(6).ship.company).toBe(true);
    expect(m(4).ship.company).toBe(false);
    expect(m(7).ship.company).toBe(false);
  });
});

describe('sat on the hatch in light weather', () => {
  test('they stand past 8° of heel or force 5, in turn, and sit again only under the hysteresis', () => {
    const rules = shipRules(16);
    const t = { time: 0 };
    const sat = () =>
      rules.members
        .filter((m) => kindStations()[m.station]?.pose === 'seated')
        .map((m) => m.ship.sat);
    for (let i = 0; i < 300; i++) {
      sailShip(rules, 1 / 30, 0.4, t, 5 * DEG);
    }
    expect(sat()).toEqual([1, 1]);
    for (let i = 0; i < 600; i++) {
      sailShip(rules, 1 / 30, 0.4, t, 9 * DEG);
    }
    expect(rules.standing).toBe(true);
    expect(sat()).toEqual([0, 0]);
    // Back to 7°: still standing; to 5°, sat again.
    for (let i = 0; i < 600; i++) {
      sailShip(rules, 1 / 30, 0.4, t, 7 * DEG);
    }
    expect(sat()).toEqual([0, 0]);
    for (let i = 0; i < 600; i++) {
      sailShip(rules, 1 / 30, 0.4, t, 5 * DEG);
    }
    expect(sat()).toEqual([1, 1]);
    // Force 6: standing, whatever the heel.
    for (let i = 0; i < 300; i++) {
      sailShip(rules, 1 / 30, 0.4, t, 0, 11.5);
    }
    expect(sat()).toEqual([0, 0]);
  });

  test('the heel smoothed: her roll in a sea stands nobody up', () => {
    const rules = shipRules(16);
    const t = { time: 0 };
    for (let i = 0; i < 900; i++) {
      sailShip(rules, 1 / 30, 0.4, t, 3 * DEG + 7 * DEG * Math.sin(i / 20));
    }
    expect(rules.standing).toBe(false);
  });
});

describe('walking her ways', () => {
  /** Hands the controls over and sails on till everyone is still, recording each frame. */
  function handOver(
    n: number,
    from: number,
    to: number,
    yards = 0.4,
    each?: (rules: ShipRules, t: number) => void,
  ): { rules: ShipRules; frames: number; relievedAt: number } {
    const rules = shipRules(n, from);
    const t = { time: 0 };
    sailShip(rules, 1 / 30, yards, t);
    rules.set(shipCrew(n, to));
    let relievedAt = -1;
    let frames = 0;
    for (; frames < 120 * 30; frames++) {
      sailShip(rules, 1 / 30, yards, t);
      each?.(rules, frames / 30);
      if (relievedAt < 0 && rules.wheelSeat === to) {
        relievedAt = frames / 30;
      }
      if (relievedAt >= 0 && rules.members.every((m) => m.ship.route === null)) {
        break;
      }
    }
    return { rules, frames, relievedAt };
  }

  test('a handover to the lookout on the forecastle: the skipper keeps the wheel till the lookout comes aft behind them; the skipper then walks to the lookout’s place', () => {
    const seen: number[] = [];
    const { rules, relievedAt } = handOver(8, 0, 5, 0.4, (r) => {
      seen.push(r.wheelSeat);
    });
    // The walk aft along the deck and up two ladders takes half a minute or so.
    expect(relievedAt).toBeGreaterThan(20);
    expect(relievedAt).toBeLessThan(60);
    expect(seen.slice(0, Math.floor(relievedAt * 30) - 1).every((s) => s === 0)).toBe(true);
    expect(rules.wheelSeat).toBe(5);
    const skipper = rules.members.find((m) => m.seat === 0) as ShipMember;
    expect(skipper.station).toBe(5);
    expect(skipper.ship.route).toBeNull();
    expect(rules.members.some((m) => m.seat === 5)).toBe(false);
  });

  test('walking aft, the lookout crosses to the lee side where the waist opens abaft the longboat, and keeps to it; a ladder is a cut, its walker gone meanwhile', () => {
    const aft: number[] = [];
    let gone = 0;
    handOver(8, 0, 5, 0.4, (r) => {
      const w = standing(r).get(5);
      // Abaft the waist's crossing, up to the wheel.
      if (w?.walking && !w.gone && w.at.z > 2 && w.at.z < 12.4) {
        aft.push(w.at.x);
      }
      if (w?.gone === true) {
        gone += 1 / 30;
      }
    });
    // The weather to starboard: walked to port.
    expect(aft.length).toBeGreaterThan(30);
    expect(
      aft.every((x) => x < -1),
      JSON.stringify(aft.map((x) => x.toFixed(2))),
    ).toBe(true);
    // Two ladders, each a cut of LADDER_TIME.
    expect(gone).toBeCloseTo(2 * LADDER_TIME, 0);
  });

  test.each([
    [1, 0.4],
    [6, 0.4],
    [7, -0.4],
    [21, 0.4],
    [30, -0.4],
    [39, 0.4],
  ])(
    'handing to seat %i with forty aboard (yards %f): every walk ends at its place, and nobody walks through anybody',
    (to, yards) => {
      let nearest = Number.POSITIVE_INFINITY;
      let who = '';
      const { rules, relievedAt } = handOver(40, 0, to, yards, (r) => {
        const at = standing(r);
        for (const [a, pa] of at) {
          if (!pa.walking || pa.gone) {
            continue;
          }
          for (const [b, pb] of at) {
            if (a === b || pb.gone || Math.abs(pa.at.y - pb.at.y) > 1) {
              continue;
            }
            const d = Math.hypot(pa.at.x - pb.at.x, pa.at.z - pb.at.z);
            if (d < nearest) {
              nearest = d;
              who = `${a} and ${b} at ${pa.at.x.toFixed(2)}, ${pa.at.z.toFixed(2)}`;
            }
          }
        }
      });
      expect(relievedAt).toBeGreaterThan(0);
      expect(rules.wheelSeat).toBe(to);
      const skipper = rules.members.find((m) => m.seat === 0) as ShipMember;
      expect(skipper.station).toBe(to);
      // Everyone at their own place after.
      for (const m of rules.members) {
        expect(m.station, `seat ${m.seat}`).toBe(m.seat === 0 ? to : m.seat);
      }
      expect(nearest, who).toBeGreaterThan(0.4);
    },
  );

  test('a second handover during the walk: the first relief walks back to their place, the wheel kept by its holder', () => {
    const rules = shipRules(8, 0);
    const t = { time: 0 };
    sailShip(rules, 1 / 30, 0.4, t);
    rules.set(shipCrew(8, 5));
    for (let i = 0; i < 150; i++) {
      sailShip(rules, 1 / 30, 0.4, t);
    }
    rules.set(shipCrew(8, 0));
    for (let i = 0; i < 90 * 30; i++) {
      sailShip(rules, 1 / 30, 0.4, t);
    }
    expect(rules.wheelSeat).toBe(0);
    expect(rules.members.find((m) => m.seat === 5)?.station).toBe(5);
    expect(rules.members.every((m) => m.ship.route === null)).toBe(true);
  });

  test('under reduced motion a walk is a cut: the relief at the wheel at once, the skipper at their place', () => {
    const rules = shipRules(8, 0, true);
    sailShip(rules, 1 / 30, 0.4, { time: 0 });
    rules.set(shipCrew(8, 5));
    expect(rules.wheelSeat).toBe(5);
    expect(rules.members.find((m) => m.seat === 0)?.station).toBe(5);
    expect(rules.members.every((m) => m.ship.route === null)).toBe(true);
  });

  test('the ways join every station: a walk from each to behind the helmsman', () => {
    const rules = shipRules(40);
    sailShip(rules, 1 / 30, 0.4, { time: 0 });
    const graph = new ShipWayGraph(shipCompany().ways as NonNullable<Company['ways']>);
    const sp = { at: new Vector3(), facing: 0, side: 1 };
    const relief = new Vector3(0, 5, 12.6 + RELIEF_AFT);
    for (let k = 1; k < 40; k++) {
      rules.spotOf(k, sp);
      const from = standPoint(
        kindStations()[k] as (typeof kindStations extends () => infer R ? R : never)[number],
        sp,
        new Vector3(),
      );
      const route = graph.route(from, relief, () => 1);
      expect(route.length, `${k}`).toBeGreaterThan(2);
      // No stretch between two points of a walk jumps a deck.
      for (let i = 1; i < route.length; i++) {
        const a = route[i - 1]?.at as Vector3;
        const b = route[i]?.at as Vector3;
        if ((route[i]?.kind ?? 0) === 0) {
          expect(Math.abs(a.y - b.y), `${k}: ${i}`).toBeLessThan(0.7);
        }
      }
    }
  });
});
