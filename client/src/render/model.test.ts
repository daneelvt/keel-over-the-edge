// SPDX-License-Identifier: AGPL-3.0-only

// Every boat's model against the catalog: its named parts sit where the
// physics puts them, within 1 cm, its headsail's tack and head where the
// headsails' are, its downwind sail's where the downwind sail's are, a
// ship's square sails on her yards' joints where her square groups are, and
// each level is within the catalog's triangle budget.
// Every sailor's art is the sailors' build's: its deck level skinned and
// within its budget, its far level one posed figure seated by its place, and
// its clips every one the runtime sails with.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';

/** Most triangles in a sailor's deck and far levels (the build's tables.yaml). */
const DECK_BUDGET = 3300;
const FAR_BUDGET = 300;
const CM = 0.01;

interface Gltf {
  nodes: {
    name?: string;
    skin?: number;
    translation?: number[];
    mesh?: number;
    children?: number[];
    extras?: {
      plan?: { deviation: number; widest?: boolean; over?: string[] };
      rake?: number;
      restage?: number[];
      square?: { group: string; strip: number; split?: number; reefs?: number[] };
      number?: boolean;
      yard?: string;
      wheel?: { radius: number; spokes: number };
    };
  }[];
  meshes: {
    primitives: { attributes: Record<string, number>; indices: number; material: number }[];
  }[];
  materials: { name: string }[];
  accessors: { count: number; min?: number[]; max?: number[] }[];
  animations?: { name: string }[];
}

function triangles(g: Gltf): number {
  let n = 0;
  for (const m of g.meshes ?? []) {
    for (const p of m.primitives) {
      n += (g.accessors[p.indices]?.count ?? 0) / 3;
    }
  }
  return n;
}

function readGltf(path: string): Gltf {
  const glb = readFileSync(new URL(`../../../art/${path}`, import.meta.url));
  expect(glb.readUInt32LE(0)).toBe(0x46546c67);
  const length = glb.readUInt32LE(12);
  return JSON.parse(glb.subarray(20, 20 + length).toString('utf8')) as Gltf;
}

/** Every look's versions, the people's and the machine's, by name. */
const versions = [
  ...catalog.sailors.flatMap((s) => s.versions.map((v) => [`${s.name} ${v.name}`, v] as const)),
  ...catalog.machine.versions.map((v) => [`machine ${v.name}`, v] as const),
];

describe.each(versions)('sailor %s', (_, sailor) => {
  test(`its deck level is skinned, under ${DECK_BUDGET.toLocaleString('en')} triangles`, () => {
    const g = readGltf(sailor.art.model);
    expect(g.nodes.some((n) => n.skin !== undefined)).toBe(true);
    expect(triangles(g)).toBeGreaterThan(1000);
    expect(triangles(g)).toBeLessThan(DECK_BUDGET);
  });

  test(`its far level is one figure seated by its place, under ${FAR_BUDGET} triangles`, () => {
    const g = readGltf(sailor.art.far);
    expect(g.nodes.some((n) => n.name === 'place')).toBe(true);
    expect(triangles(g)).toBeLessThanOrEqual(FAR_BUDGET);
  });

  test('its clips are every one the runtime sails with, on both side decks', () => {
    const names = (readGltf(sailor.art.clips).animations ?? []).map((a) => a.name);
    for (const c of ['helm', 'hiking-1', 'hiking-2', 'hiking-3', 'cross', 'habit', 'climbing-in']) {
      expect(names).toContain(c);
      expect(names).toContain(`${c}-port`);
    }
    for (const c of ['treading-water', 'righting', 'standing-idle', 'habit-standing']) {
      expect(names).toContain(c);
    }
  });
});

describe.each(catalog.boats.map((b) => [b.name, b] as const))('%s', (_, boat) => {
  const g = readGltf(boat.art.model);
  const far = readGltf(boat.art.far);
  const node = (name: string) => {
    const n = g.nodes.find((x) => x.name === name);
    if (n === undefined) {
      throw new Error(`no node ${name}`);
    }
    return n;
  };
  const at = (name: string): number[] => node(name).translation ?? [0, 0, 0];
  /**
   * The bounds of a node's primitives of some materials (all, if none
   * given), in the node's frame; with its children's that have no place of
   * their own, if asked; in the near model, or the one given.
   */
  const bounds = (
    name: string,
    materials?: string[],
    children = false,
    model = g,
  ): { min: number[]; max: number[] } => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const add = (n: Gltf['nodes'][number]): void => {
      for (const p of model.meshes[n.mesh ?? -1]?.primitives ?? []) {
        if (
          materials !== undefined &&
          !materials.includes(model.materials[p.material]?.name ?? '')
        ) {
          continue;
        }
        const a = model.accessors[p.attributes.POSITION ?? -1];
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k] as number, a?.min?.[k] ?? Infinity);
          max[k] = Math.max(max[k] as number, a?.max?.[k] ?? -Infinity);
        }
      }
      for (const c of children ? (n.children ?? []) : []) {
        const child = model.nodes[c];
        if (child !== undefined && child.translation === undefined) {
          add(child);
        }
      }
    };
    const n = model.nodes.find((x) => x.name === name);
    if (n === undefined) {
      throw new Error(`no node ${name}`);
    }
    add(n);
    return { min, max };
  };
  /** The hull's shell: its planking, painted or bright, and its sheathing. */
  const SHELL = ['timber', 'topsides', 'paint', 'copper'];
  const { rig, foils, hull, sailor, headsails, square, downwind } = boat.physics;
  const has = (name: string): boolean => g.nodes.some((n) => n.name === name);
  /** A node's place in the model's frame: its own and its parents'. */
  const place = (name: string): number[] => {
    const index = g.nodes.findIndex((n) => n.name === name);
    const p = [...at(name)];
    for (let i = index; ; ) {
      const parent = g.nodes.findIndex((n) => n.children?.includes(i));
      if (parent < 0) {
        return p;
      }
      const t = g.nodes[parent]?.translation ?? [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        p[k] = (p[k] ?? 0) + (t[k] ?? 0);
      }
      i = parent;
    }
  };
  /** A boat steered by a wheel stands her sailor at it; one steered by a tiller seats him by it. */
  const wheel = has('wheel');
  /** The square-rigged: sails on yards turned by the braces. */
  const squareRigged = square.squareForeArea > 0 || square.squareAfterArea > 0;

  test('has every named part', () => {
    for (const name of [
      'hull',
      'mast',
      'boom',
      'sail',
      'telltales',
      'pennant',
      'rudder',
      'tiller',
      'daggerboard',
      'sailor',
      // What the sailor holds, stands on and sits against.
      ...(wheel ? ['wheel'] : ['extension', 'grip', 'sheet', 'sheet-boom']),
      'gunwale',
      'board-root',
    ]) {
      expect(() => node(name)).not.toThrow();
    }
    // A boat with headsails carries them.
    expect(g.nodes.some((n) => n.name === 'jib')).toBe(headsails.headsailArea > 0);
  });

  test('its far model has the parts drawn far off, where the near one has them', () => {
    for (const name of ['hull', 'mast', 'boom', 'sail', 'rudder', 'tiller', 'daggerboard']) {
      const n = far.nodes.find((x) => x.name === name);
      expect(n, name).toBeDefined();
      expect(n?.translation ?? [0, 0, 0]).toEqual(at(name));
    }
    expect(far.nodes.some((n) => n.name === 'jib')).toBe(headsails.headsailArea > 0);
  });

  test('its seat is the stage’s, or says how far it is from it', () => {
    const restage = node('sailor').extras?.restage;
    if (restage !== undefined) {
      expect(restage).toHaveLength(3);
      for (const v of restage) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  test('its hull is a solid the sailor is kept out of, and its gunwale is the outline’s', () => {
    const solid = (node('hull') as { extras?: { solid?: { stations: number[][] } } }).extras?.solid;
    expect(solid?.stations.length ?? 0).toBeGreaterThan(10);
    const g = at('gunwale');
    const u = (hull.transom - (g[2] ?? 0)) / boat.lengthOverall;
    const o = hull.outline;
    const x = u * (o.length - 1);
    const i = Math.floor(x);
    const half = (o[i] ?? 0) + ((o[i + 1] ?? 0) - (o[i] ?? 0)) * (x - i);
    expect(g[0] ?? 0).toBeCloseTo(half, 2);
    expect(g[2] ?? 0).toBeCloseTo(at('sailor')[2] ?? 1, 2);
  });

  test('its parts sit where the physics puts them', () => {
    // The bow is -z; positions are from the centre of gravity's station.
    expect(at('mast')[2]).toBeCloseTo(-rig.mastPosition, 2);
    expect(at('boom')[1]).toBeCloseTo(rig.boomHeight, 2);
    expect(at('boom')[2]).toBeCloseTo(-rig.mastPosition, 2);
    expect(at('sail')).toEqual(at('boom'));
    expect(at('telltales')).toEqual(at('boom'));
    if (squareRigged) {
      // Her sidelights at the rail on their sides, forward of the mainmast;
      // her sternlight on the centreline at the taffrail.
      const main = at('main-yards');
      for (const light of boat.lights) {
        const p = at(light);
        expect(p[1] ?? 0).toBeGreaterThan(1);
        expect(p[1] ?? 0).toBeLessThan(10);
        if (light === 'stern') {
          expect(Math.abs(p[0] ?? 1)).toBeLessThan(CM);
          expect(p[2] ?? 0).toBeGreaterThan(hull.transom - 0.5);
        } else {
          expect(Math.sign(p[0] ?? 0)).toBe(light === 'port' ? -1 : 1);
          expect(Math.abs(p[0] ?? 0)).toBeGreaterThan(boat.beam / 2 - 1);
          expect(p[2] ?? 0).toBeLessThan(main[2] ?? 0);
        }
      }
      // The pennant flies at the main truck, above the topgallant yards.
      expect(at('pennant')[2]).toBeCloseTo(main[2] ?? 0, 2);
      expect(at('pennant')[1] ?? 0).toBeGreaterThan(square.squareFootHeight + square.squareLuff);
    } else {
      // The lantern stands on the masthead, and the pennant flies from a
      // short staff above it.
      const masthead = rig.boomHeight + rig.luff;
      for (const light of boat.lights) {
        expect(at(light)[2]).toBeCloseTo(-rig.mastPosition, 2);
        expect(at(light)[1] ?? 0).toBeGreaterThan(masthead);
        expect(at(light)[1] ?? 0).toBeLessThan(masthead + 0.3);
      }
      expect(at('pennant')[2]).toBeCloseTo(-rig.mastPosition, 2);
      for (const light of boat.lights) {
        expect(at('pennant')[1] ?? 0).toBeGreaterThan(at(light)[1] ?? 0);
      }
      expect(at('pennant')[1] ?? 0).toBeLessThan(masthead + 0.5);
    }
    expect(at('rudder')[2]).toBeCloseTo(foils.rudderPosition, 2);
    expect(at('daggerboard')[2]).toBeCloseTo(-foils.boardPosition, 2);
    expect(at('sailor')[1]).toBeCloseTo(hull.centreOfGravity + sailor.sailorSeatHeight, 2);
    for (const name of ['mast', 'boom', 'rudder', 'daggerboard', 'sailor']) {
      expect(Math.abs(at(name)[0] ?? 1)).toBeLessThan(CM);
    }
  });

  test('its sheer is the outline the physics bumps hulls with, within 1 cm', () => {
    const plan = node('hull').extras?.plan;
    expect(plan).toBeDefined();
    expect(plan?.deviation ?? 1).toBeLessThan(CM);
  });

  test('its hull, sail and foils have the physics’ dimensions', () => {
    // The beam across the deck; or, where the model says its plan is at the
    // hull's widest (she tumbles home above it), across the planking; or,
    // where it says its plan is over parts of other stuff (racks' rails),
    // across those.
    const planks = bounds('hull', SHELL);
    const plan = node('hull').extras?.plan;
    const across =
      plan?.over !== undefined
        ? bounds('hull', plan.over)
        : plan?.widest === true
          ? planks
          : bounds('hull', ['deck']);
    expect(Math.abs((across.max[0] ?? 0) - (across.min[0] ?? 0) - boat.beam)).toBeLessThan(CM);
    expect(Math.abs((planks.max[2] ?? 0) - (planks.min[2] ?? 0) - boat.lengthOverall)).toBeLessThan(
      CM,
    );
    expect(Math.abs((planks.min[1] ?? 0) + hull.hullDraught)).toBeLessThan(CM);
    // The sail's luff up the mast to its head, or to the gaff's throat.
    const sail = bounds('sail');
    const head = has('gaff') ? (at('gaff')[1] ?? 0) : (sail.max[1] ?? 0);
    expect(Math.abs(head - (sail.min[1] ?? 0) - rig.luff)).toBeLessThan(CM);
    expect(Math.abs((sail.max[2] ?? 0) - (sail.min[2] ?? 0) - rig.foot)).toBeLessThan(CM);
    // The board or keel at its chord; the deepest of it (a keel's bulb) at the span.
    const board = bounds('daggerboard');
    const deepest = bounds('daggerboard', undefined, true);
    expect(Math.abs((deepest.min[1] ?? 0) + hull.hullDraught + foils.boardSpan)).toBeLessThan(CM);
    expect(Math.abs((board.max[2] ?? 0) - (board.min[2] ?? 0) - foils.boardChord)).toBeLessThan(CM);
    // A rudder hung on the sternpost, behind the deadwood, reaches the keel's depth.
    const rudder = bounds('rudder');
    const span = has('deadwood') ? foils.boardSpan : foils.rudderSpan;
    expect(Math.abs((rudder.min[1] ?? 0) + hull.hullDraught + span)).toBeLessThan(CM);
  });

  test('its telltales sit at the height of each sail strip’s centre of effort', () => {
    const t = bounds('telltales');
    const width = 0.012;
    expect(Math.abs((t.min[1] ?? 0) + width / 2 - rig.footStrip * rig.luff)).toBeLessThan(CM);
    expect(Math.abs((t.max[1] ?? 0) - width / 2 - rig.headStrip * rig.luff)).toBeLessThan(CM);
    // On both faces of the cloth, close aft of the luff.
    expect(t.min[0]).toBeLessThan(0);
    expect(t.max[0]).toBeGreaterThan(0);
    expect(t.min[2] ?? 1).toBeLessThan(0.5);
    const p = g.meshes[node('telltales').mesh ?? -1]?.primitives[0];
    expect(p?.attributes.TEXCOORD_1).toBeDefined();
  });

  test(`is within its budget: ${boat.art.budget.near.toLocaleString('en')} triangles near, ${boat.art.budget.far.toLocaleString('en')} far`, () => {
    expect(triangles(g)).toBeGreaterThan(1000);
    expect(triangles(g)).toBeLessThanOrEqual(boat.art.budget.near);
    expect(triangles(far)).toBeGreaterThan(100);
    expect(triangles(far)).toBeLessThanOrEqual(boat.art.budget.far);
  });

  test.runIf(headsails.headsailArea > 0 && !squareRigged)(
    'its jib is tacked and headed where the headsails are, flat on its stay',
    () => {
      // The tack: the node, ahead of the centre of gravity at its height.
      const tack = at('jib');
      expect(Math.abs(tack[0] ?? 1)).toBeLessThan(CM);
      expect(Math.abs((tack[1] ?? 0) - headsails.headsailTackHeight)).toBeLessThan(CM);
      expect(Math.abs((tack[2] ?? 0) + headsails.headsailTack)).toBeLessThan(CM);
      // The head: the luff's height above the tack, rake aft of it, ahead of
      // the mast; the foot from the tack, aft along the deck (the head, a
      // jib's narrow one, may lie aft of the clew, as a self-tacker's does).
      const jib = bounds('jib');
      const rake = node('jib').extras?.rake ?? -1;
      expect(Math.abs((jib.min[1] ?? 1) - 0)).toBeLessThan(CM);
      expect(Math.abs((jib.max[1] ?? 0) - headsails.headsailLuff)).toBeLessThan(CM);
      expect(Math.abs(jib.min[2] ?? 1)).toBeLessThan(CM);
      expect(jib.max[2] ?? 0).toBeGreaterThan(headsails.headsailFoot - CM);
      expect(jib.max[2] ?? 0).toBeLessThan(Math.max(headsails.headsailFoot, rake + 0.1) + CM);
      expect(rake).toBeGreaterThan(0);
      const head = (tack[2] ?? 0) + rake;
      expect(head).toBeLessThan(-rig.mastPosition);
      expect(head).toBeGreaterThan(-rig.mastPosition - 0.5);
      // Flat in the centreline plane, shaped by its fractions of chord and luff.
      expect(Math.max(Math.abs(jib.min[0] ?? 1), Math.abs(jib.max[0] ?? 1))).toBeLessThan(1e-4);
      const p = g.meshes[node('jib').mesh ?? -1]?.primitives[0];
      expect(p?.attributes.TEXCOORD_1).toBeDefined();
    },
  );

  test('has its downwind sail, near and far, tacked and headed where the downwind sail is, flat', () => {
    const kite = downwind.downwindArea > 0;
    expect(has('kite')).toBe(kite);
    expect(far.nodes.some((n) => n.name === 'kite')).toBe(kite);
    if (!kite) {
      return;
    }
    for (const model of [g, far]) {
      const n = model.nodes.find((x) => x.name === 'kite');
      // The tack: the node, ahead of the centre of gravity at its height.
      const tack = n?.translation ?? [1, 1, 1];
      expect(Math.abs(tack[0] ?? 1)).toBeLessThan(CM);
      expect(Math.abs((tack[1] ?? 0) - downwind.downwindTackHeight)).toBeLessThan(CM);
      expect(Math.abs((tack[2] ?? 0) + downwind.downwindTack)).toBeLessThan(CM);
      // The head the luff's height above the tack, rake aft of it, ahead of
      // the mast; the foot, its longest chord, aft from the tack.
      const b = bounds('kite', undefined, false, model);
      const rake = n?.extras?.rake ?? -1;
      expect(Math.abs(b.min[1] ?? 1)).toBeLessThan(CM);
      expect(Math.abs((b.max[1] ?? 0) - downwind.downwindLuff)).toBeLessThan(CM);
      expect(Math.abs(b.min[2] ?? 1)).toBeLessThan(CM);
      expect(Math.abs((b.max[2] ?? 0) - (b.min[2] ?? 0) - downwind.downwindFoot)).toBeLessThan(CM);
      expect(rake).toBeGreaterThan(0);
      expect((tack[2] ?? 0) + rake).toBeLessThan(-rig.mastPosition);
      // Flat in the centreline plane, shaped by its fractions of chord and luff.
      expect(Math.max(Math.abs(b.min[0] ?? 1), Math.abs(b.max[0] ?? 1))).toBeLessThan(1e-4);
      const p = model.meshes[n?.mesh ?? -1]?.primitives[0];
      expect(p?.attributes.TEXCOORD_1).toBeDefined();
    }
  });

  test.runIf(squareRigged)(
    'her headsails are about their tack, the jib with their luff and foot, flat on their stays',
    () => {
      const tack = at('jib');
      expect(Math.abs(tack[0] ?? 1)).toBeLessThan(CM);
      expect(Math.abs((tack[1] ?? 0) - headsails.headsailTackHeight)).toBeLessThan(CM);
      expect(Math.abs((tack[2] ?? 0) + headsails.headsailTack)).toBeLessThan(CM);
      const sails = (node('jib').children ?? []).map((i) => g.nodes[i]?.name ?? '');
      expect(sails.length).toBeGreaterThan(1);
      let jib = false;
      for (const name of sails.filter((n) => node(n).extras?.rake !== undefined)) {
        const b = bounds(name);
        const rake = node(name).extras?.rake ?? 0;
        // Flat in the centreline, tacked at its node, its head rake aft.
        expect(Math.max(Math.abs(b.min[0] ?? 1), Math.abs(b.max[0] ?? 1))).toBeLessThan(1e-4);
        expect(Math.abs(b.min[1] ?? 1)).toBeLessThan(CM);
        expect(Math.abs(b.min[2] ?? 1)).toBeLessThan(CM);
        expect(rake).toBeGreaterThan(0);
        const p = g.meshes[node(name).mesh ?? -1]?.primitives[0];
        expect(p?.attributes.TEXCOORD_1).toBeDefined();
        // The jib: the catalog's luff up its stay, and its foot (its head may lie aft of its clew).
        const luff = Math.hypot(b.max[1] ?? 0, rake);
        const reach = (b.max[2] ?? 0) - (b.min[2] ?? 0);
        if (Math.abs(luff - headsails.headsailLuff) < CM && reach > headsails.headsailFoot - CM) {
          jib = true;
        }
      }
      expect(jib).toBe(true);
    },
  );

  test.runIf(squareRigged)(
    'her square sails hang on her yards’ joints, where her square groups are',
    () => {
      // The joints at the masts, square at rest: the fore at its group's mast.
      for (const name of ['fore-yards', 'main-yards', 'mizzen-yards']) {
        expect(Math.abs(at(name)[0] ?? 1)).toBeLessThan(CM);
      }
      expect(at('fore-yards')[2]).toBeCloseTo(-square.squareForeMast, 2);
      expect(at('mizzen-yards')[2]).toBeCloseTo(at('mast')[2] ?? 0, 2);
      const fore = at('fore-yards')[2] ?? 0;
      expect(at('main-yards')[2] ?? 0).toBeGreaterThan(fore);
      expect(at('main-yards')[2] ?? 0).toBeLessThan(-square.squareAfterMast);
      // Each sail flat across its joint's plane, of a group and a strip;
      // the courses' foot and the topgallants' heads the luff apart.
      let lowest = Infinity;
      let highest = -Infinity;
      let numbered = 0;
      const groups = new Set<string>();
      for (const yards of ['fore-yards', 'main-yards', 'mizzen-yards']) {
        // The topsail's yard is its own node, which a reef lowers.
        const own = (node(yards).children ?? []).filter(
          (i) => g.nodes[i]?.extras?.yard !== undefined,
        );
        expect(own.map((i) => g.nodes[i]?.extras?.yard)).toEqual(['topsail']);
        for (const i of node(yards).children ?? []) {
          if (own.includes(i)) {
            continue;
          }
          const sail = g.nodes[i];
          const sq = sail?.extras?.square;
          expect(sq, sail?.name).toBeDefined();
          groups.add(sq?.group ?? '');
          expect([0, 1]).toContain(sq?.strip);
          const b = bounds(sail?.name ?? '');
          expect((b.max[2] ?? 0) - (b.min[2] ?? 0)).toBeLessThan(1e-4);
          lowest = Math.min(lowest, (b.min[1] ?? 0) + (at(yards)[1] ?? 0));
          highest = Math.max(highest, (b.max[1] ?? 0) + (at(yards)[1] ?? 0));
          numbered += sail?.extras?.number === true ? 1 : 0;
        }
      }
      expect([...groups].sort()).toEqual(['after', 'fore']);
      expect(Math.abs(lowest - square.squareFootHeight)).toBeLessThan(CM);
      expect(Math.abs(highest - square.squareFootHeight - square.squareLuff)).toBeLessThan(CM);
      expect(numbered).toBe(1);
    },
  );

  test.runIf(wheel)('her wheel stands before her helmsman, its axle fore and aft', () => {
    const w = place('wheel');
    const s = place('sailor');
    expect(Math.abs(w[0] ?? 1)).toBeLessThan(CM);
    expect(Math.abs((s[2] ?? 0) - (w[2] ?? 0) - 0.55)).toBeLessThan(CM);
    expect(Math.abs((w[1] ?? 0) - (s[1] ?? 0) - 1.05)).toBeLessThan(CM);
    const spec = node('wheel').extras?.wheel;
    expect(spec?.radius).toBeCloseTo(0.75, 2);
    expect(spec?.spokes).toBe(8);
    // The rim and its handles in the node's x-y plane.
    const b = bounds('wheel');
    expect(Math.abs((b.max[0] ?? 0) - 0.9)).toBeLessThan(CM);
    expect(Math.abs((b.max[1] ?? 0) - 0.9)).toBeLessThan(CM);
  });

  test('the sail carries its fraction of chord and luff, for its vertex node', () => {
    const sail = g.meshes[node('sail').mesh ?? -1]?.primitives[0];
    expect(sail?.attributes.TEXCOORD_1).toBeDefined();
  });
});
