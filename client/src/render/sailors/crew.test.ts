// SPDX-License-Identifier: AGPL-3.0-only

// The people aboard: who is drawn at which station (whoever holds the
// controls at the helm, the skipper at the holder's station); every kind's
// stations on its model's deck, the first where its sailor is at the helm,
// those on a rail at the deck's edge, nothing of the hull where a person
// stands; and the figures as the GPU skins them, posed from the committed
// files: standing on the station's point, seated on it, on the keelboat's
// rail, facing the way the station faces; each alive in their own way, the
// same for every client, breathing only under reduced motion.

import { readFileSync } from 'node:fs';
import {
  type AnimationClip,
  Box3,
  DoubleSide,
  Matrix3,
  Matrix4,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  Raycaster,
  Texture,
  Vector3,
} from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { describe, expect, test } from 'vitest';
import { catalog } from '../../catalog';
import { seatFigure } from '../fleetparts';
import { Clip } from './clips';
import { crewPlaces, helmLook, stationPlace } from './crew';
import { CrewBody, stance } from './crewbody';
import { deckFigure, farFigure } from './crewfigures';
import { STRIDE } from './crewlevel';
import { type PoseInput, poseMember } from './crewpose';
import type { CrewMember } from './crewrules';
import { deckLook, FleetLook } from './fleetlooks';
import { placesOf } from './model';
import { boneNames } from './onboat';
import { railClips } from './rail';
import { Rig } from './rig';

const ART = new URL('../../../../art/', import.meta.url);

// GLTFLoader reaches for the page's global by name.
(globalThis as { self?: unknown }).self ??= globalThis;

/** Reads a glb in Node; its KTX2 textures stand in as blank ones. */
async function load(path: string): Promise<{ scene: Object3D; animations: AnimationClip[] }> {
  const buf = readFileSync(new URL(path, ART));
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const blank = {
    load: (_url: string, onLoad: (t: Texture) => void) => onLoad(new Texture()),
    detectSupport: () => blank,
  };
  loader.setKTX2Loader(blank as unknown as KTX2Loader);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return loader.parseAsync(ab, '');
}

function meshesOf(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o instanceof Mesh) {
      out.push(o);
    }
  });
  return out;
}

describe('who is drawn where', () => {
  const people = [0, 1, 2, 3].map((seat) => ({ seat, look: 100 + seat }));

  test('the skipper holding: the skipper at the helm, everyone else at their seat’s station', () => {
    const crew = { people, holder: 0 };
    expect(helmLook(crew)).toBe(100);
    expect(crewPlaces(crew, 5)).toEqual([
      { station: 1, look: 101 },
      { station: 2, look: 102 },
      { station: 3, look: 103 },
    ]);
  });

  test('another holding: that one at the helm, the skipper at their station', () => {
    const crew = { people, holder: 2 };
    expect(helmLook(crew)).toBe(102);
    expect(crewPlaces(crew, 5)).toEqual([
      { station: 2, look: 100 },
      { station: 1, look: 101 },
      { station: 3, look: 103 },
    ]);
  });

  test('a seat past the kind’s stations is not drawn', () => {
    expect(crewPlaces({ people, holder: 0 }, 3).map((p) => p.station)).toEqual([1, 2]);
  });

  test('nobody holding: nobody at the helm', () => {
    expect(helmLook({ people, holder: 7 })).toBeNull();
  });
});

describe('a crew to windward', () => {
  /** The kinds with stations to windward: a dinghy's crew on its rack, a keelboat's along her rail. */
  const crewed = catalog.boats.filter((b) => b.stations.some((s) => s.windward === true));
  const place = () => ({ at: [0, 0, 0] as [number, number, number], facing: 0 });

  test('some kinds have them, by data: the helm’s station never; a kind with one has all its crew’s stations to windward', () => {
    expect(crewed.length).toBeGreaterThan(1);
    for (const b of catalog.boats) {
      expect(b.stations[0]?.windward ?? false, b.id).toBe(false);
    }
    for (const b of crewed) {
      expect(
        b.stations.slice(1).every((s) => s.windward === true),
        b.id,
      ).toBe(true);
    }
  });

  test.each(crewed.map((b) => [b.name, b] as const))(
    '%s: each crew station on the windward side, its mirror on the other, facing the mirrored way',
    (_, boat) => {
      for (const s of boat.stations.filter((x) => x.windward === true)) {
        for (const side of [1, -1]) {
          const at = stationPlace(s, side, 1, place());
          expect(Math.sign(at.at[0])).toBe(side);
          expect(Math.abs(at.at[0])).toBeCloseTo(Math.abs(s.at[0] as number), 9);
          expect(at.at[1]).toBe(s.at[1]);
          expect(at.at[2]).toBe(s.at[2]);
          const own = Math.sign(s.at[0] as number);
          expect(at.facing).toBeCloseTo(side === own ? s.facing : 360 - s.facing, 9);
        }
      }
    },
  );

  test.each(crewed.map((b) => [b.name, b] as const))(
    '%s: handed over, the two change places: the old helm at the new one’s station',
    (_, boat) => {
      const people = [
        { seat: 0, look: 7 },
        { seat: 1, look: 9 },
      ];
      expect(helmLook({ people, holder: 0 })).toBe(7);
      expect(crewPlaces({ people, holder: 0 }, boat.stations.length)).toEqual([
        { station: 1, look: 9 },
      ]);
      expect(helmLook({ people, holder: 1 })).toBe(9);
      expect(crewPlaces({ people, holder: 1 }, boat.stations.length)).toEqual([
        { station: 1, look: 7 },
      ]);
    },
  );

  test('a station not to windward is where the catalog has it, whatever the side', () => {
    for (const b of catalog.boats) {
      for (const s of b.stations.filter((x) => x.windward !== true)) {
        for (const side of [1, -1]) {
          const at = stationPlace(s, side, 1, place());
          expect(at.at).toEqual(s.at);
          expect(at.facing).toBe(s.facing);
        }
      }
    }
  });

  test('the Jolly boat’s and the tall ship’s stations are as they were: none to windward, none on a rail', () => {
    for (const b of catalog.boats.filter((x) => x.capacity === 1 || x.capacity >= 40)) {
      expect(
        b.stations.some((s) => s.windward === true || s.pose === 'rail'),
        b.id,
      ).toBe(false);
    }
  });
});

describe.each(catalog.boats.map((b) => [b.name, b] as const))('%s’s stations', (_, boat) => {
  test('one for each person it carries, the first where its sailor is at the helm', async () => {
    expect(boat.stations).toHaveLength(boat.capacity);
    const model = await load(boat.art.model);
    model.scene.updateMatrixWorld(true);
    // At a wheel, the helmsman's place; else the seat on the gunwale.
    const helm = model.scene.getObjectByName(
      model.scene.getObjectByName('wheel') === undefined ? 'gunwale' : 'sailor',
    );
    const at = helm?.getWorldPosition(new Vector3());
    const first = boat.stations[0];
    expect(at).toBeDefined();
    expect(new Vector3(...(first?.at ?? [0, 0, 0])).distanceTo(at as Vector3)).toBeLessThan(0.01);
    expect(first?.pose).toBe(
      model.scene.getObjectByName('wheel') === undefined ? 'seated' : 'standing',
    );
  });

  test('each on the deck within the hull, within 1 cm, and nothing of the hull where a person stands', async () => {
    const model = await load(boat.art.model);
    const hull = meshesOf(model.scene.getObjectByName('hull') as Object3D).filter(
      (m) => (m.material as MeshStandardMaterial).name !== 'rope',
    );
    for (const m of hull) {
      (m.material as MeshStandardMaterial).side = DoubleSide;
    }
    const ray = new Raycaster();
    const off: string[] = [];
    const solid = model.scene.getObjectByName('hull')?.userData.solid as
      | { stations: number[][] }
      | undefined;
    /** The deck's edge out from the centreline at z: the hull's solid's half-beam at the sheer. */
    const edge = (z: number): number => {
      const st = solid?.stations ?? [];
      for (let k = 0; k + 1 < st.length; k++) {
        const a = st[k] as number[];
        const b = st[k + 1] as number[];
        if ((z - (a[0] as number)) * (z - (b[0] as number)) <= 0) {
          const f = (z - (a[0] as number)) / ((b[0] as number) - (a[0] as number));
          return (a[1] as number) + ((b[1] as number) - (a[1] as number)) * f;
        }
      }
      return Number.NaN;
    };
    boat.stations.forEach((s, i) => {
      const [x, y, z] = s.at;
      // On the rail: the deck just inboard of its edge, the point at the edge.
      const rail = s.pose === 'rail';
      const inboard = rail ? x - Math.sign(x) * 0.04 : x;
      ray.set(new Vector3(inboard, y + 1, z), new Vector3(0, -1, 0));
      const hit = ray.intersectObjects(hull, false)[0];
      if (hit === undefined || Math.abs(hit.point.y - y) > 0.01) {
        off.push(`${i}: the deck at ${hit?.point.y.toFixed(3) ?? 'none'}, not ${y}`);
      }
      if (rail && !(Math.abs(Math.abs(x) - edge(z)) < 0.01)) {
        off.push(`${i}: on the rail ${Math.abs(x)} out, the edge ${edge(z).toFixed(4)}`);
      }
      if (s.pose === 'standing') {
        // Up through the person, from the shins to the head.
        ray.set(new Vector3(x, y + 0.15, z), new Vector3(0, 1, 0));
        ray.far = 1.55;
        const above = ray.intersectObjects(hull, false)[0];
        ray.far = Number.POSITIVE_INFINITY;
        if (above !== undefined) {
          off.push(
            `${i}: ${((above.object as Mesh).material as MeshStandardMaterial).name} through them`,
          );
        }
      }
    });
    expect(off).toEqual([]);
  });
});

/** A look as the fleet's looks hold it: its deck level, its clips and the rail's, and its far figure, seated as the fleet seats them. */
async function fleetLook(
  art: (typeof catalog.sailors)[number]['versions'][number]['art'],
  machine = false,
) {
  const [deck, clipsFile, railFile, far, jolly] = await Promise.all([
    load(art.model),
    load(art.clips),
    load(railClips(art.clips)),
    load(art.far),
    load(catalog.boats[0]?.art.model as string),
  ]);
  jolly.scene.updateMatrixWorld(true);
  const g = (jolly.scene.getObjectByName('gunwale') as Object3D).getWorldPosition(new Vector3());
  const z = (jolly.scene.getObjectByName('sailor') as Object3D).getWorldPosition(new Vector3()).z;
  const seat = { out: g.x, y: g.y, z };
  const rig = Rig.from(deck.scene, boneNames(deck.scene));
  const look = new FleetLook(0, art, machine);
  look.deck = deckLook(meshesOf(deck.scene), rig, new Matrix3(), 0);
  const clips = new Map<string, Clip>();
  for (const file of [clipsFile, railFile]) {
    const places = placesOf(file.scene);
    for (const a of file.animations) {
      const place = places.get(`place-${a.name}`) ?? null;
      clips.set(
        a.name,
        Clip.from(a, rig, place !== null && !place.equals(new Matrix4()) ? place : null),
      );
    }
  }
  look.clips = clips;
  const farPlace = placesOf(far.scene).get('place') ?? null;
  look.far = seatFigure(far.scene, meshesOf(far.scene), farPlace, seat.out, seat.y, seat.z);
  return { look, seat };
}

/** A figure (sixteen floats a corner) skinned by a body's bones as the GPU does: its corners' places in the boat's model. */
function skinned(figure: Float32Array, bones: Float32Array): Vector3[] {
  const out: Vector3[] = [];
  for (let o = 0; o < figure.length; o += STRIDE) {
    const p = new Vector3();
    for (let k = 0; k < 4; k++) {
      const w = figure[o + 12 + k] as number;
      if (w <= 0) {
        continue;
      }
      const b = 12 * Math.round(figure[o + 8 + k] as number);
      const x = figure[o] as number;
      const y = figure[o + 1] as number;
      const z = figure[o + 2] as number;
      const r = (i: number): number => bones[b + i] as number;
      p.x += w * (r(0) * x + r(1) * y + r(2) * z + r(3));
      p.y += w * (r(4) * x + r(5) * y + r(6) * z + r(7));
      p.z += w * (r(8) * x + r(9) * y + r(10) * z + r(11));
    }
    out.push(p);
  }
  return out;
}

/** A member at a station, on a side, leaning so far, not moving. */
function at(station: number, side: number, lean = 0): CrewMember {
  return { seat: station, look: 0, station, side, lean, leanTo: lean, moving: null };
}

/** What posing someone needs, for a kind's stations and a look. */
function input(
  stations: PoseInput['stations'],
  look: FleetLook,
  seat: PoseInput['seat'],
  time = 0,
  still = false,
): PoseInput {
  return {
    stations,
    seat,
    clips: look.clips as Map<string, Clip>,
    time,
    duck: 0,
    life: { dt: 1 / 30, heel: 0, upright: 0.5, still },
    a: stance(),
    b: stance(),
  };
}

const keelboat = catalog.boats.find((b) => b.stations.some((s) => s.pose === 'rail'));
const tallShip = catalog.boats.find((b) => b.capacity >= 40);

describe.each([
  ['rover', 'female'],
  ['machine', 'male'],
])('%s %s, skinned', (name, version) => {
  const machine = name === 'machine';
  const art = machine
    ? catalog.machine.versions.find((v) => v.id === version)?.art
    : catalog.sailors.find((s) => s.id === name)?.versions.find((v) => v.id === version)?.art;
  const ready = fleetLook(art as NonNullable<typeof art>, machine);

  test('both levels skinned by the same bones: standing, the far figure as tall and broad as the deck level', async () => {
    const { look, seat } = await ready;
    const ship = tallShip as NonNullable<typeof tallShip>;
    const i = ship.stations.findIndex((s, k) => k > 0 && s.pose === 'standing');
    const body = new CrewBody(look.deck as NonNullable<typeof look.deck>, 3, machine);
    poseMember(body, at(i, 1), input(ship.stations, look, seat));
    const station = ship.stations[i] as (typeof ship.stations)[number];
    const boxes = [
      deckFigure(look.deck as NonNullable<typeof look.deck>),
      farFigure(look, seat) as Float32Array,
    ].map((f) => {
      expect(f.length % (3 * STRIDE)).toBe(0);
      return new Box3().setFromPoints(skinned(f, body.bones));
    });
    const [deck, far] = boxes as [Box3, Box3];
    for (const b of boxes) {
      // The soles on the deck at the station, the head a person's height over it.
      expect(Math.abs(b.min.y - (station.at[1] as number))).toBeLessThan(0.06);
      expect(b.max.y - (station.at[1] as number)).toBeGreaterThan(1.5);
      expect(b.max.y - (station.at[1] as number)).toBeLessThan(2.1);
      expect(Math.abs((b.min.x + b.max.x) / 2 - (station.at[0] as number))).toBeLessThan(0.3);
    }
    expect(Math.abs(deck.max.y - far.max.y)).toBeLessThan(0.06);
    expect(Math.abs(deck.max.x - deck.min.x - (far.max.x - far.min.x))).toBeLessThan(0.12);
  });

  test('on the keelboat, each station on both sides: the trimmer seated on the side deck, legs in; the others on the rail, legs over the side', async () => {
    const { look, seat } = await ready;
    const boat = keelboat as NonNullable<typeof keelboat>;
    const figure = deckFigure(look.deck as NonNullable<typeof look.deck>);
    const body = new CrewBody(look.deck as NonNullable<typeof look.deck>, 3, machine);
    for (let i = 1; i < boat.stations.length; i++) {
      const s = boat.stations[i] as (typeof boat.stations)[number];
      for (const side of [1, -1]) {
        for (const lean of [0, 1]) {
          poseMember(body, at(i, side, lean), input(boat.stations, look, seat));
          const box = new Box3().setFromPoints(skinned(figure, body.bones));
          const edge = Math.abs(s.at[0] as number);
          const label = `${i} ${side} ${lean}`;
          if (s.pose === 'rail') {
            // Out over the side: below the deck outboard of the edge.
            expect(side > 0 ? box.max.x : -box.min.x, label).toBeGreaterThan(edge + 0.1);
            expect(box.min.y, label).toBeLessThan((s.at[1] as number) - 0.25);
            // The hips in from the edge, over the deck.
            const hips = body.rig
              .position(body.rig.bone('pelvis'), new Vector3())
              .applyMatrix4(body.root);
            expect(side * hips.x, label).toBeLessThan(edge - 0.15);
            expect(side * hips.x, label).toBeGreaterThan(edge - 0.5);
            expect(Math.abs(hips.z - (s.at[2] as number)), label).toBeLessThan(0.2);
          } else {
            // Seated facing inboard, the feet in the cockpit.
            const feet = body.rig
              .position(body.rig.bone('foot_l'), new Vector3())
              .applyMatrix4(body.root);
            expect(side * feet.x, label).toBeLessThan(edge - 0.2);
            expect(feet.y, label).toBeLessThan(s.at[1] as number);
          }
          // Its head a seated person's height over the deck.
          expect(box.max.y - (s.at[1] as number), label).toBeGreaterThan(0.55);
          expect(box.max.y - (s.at[1] as number), label).toBeLessThan(1.1);
        }
      }
    }
  });

  test('alive: each seat its own life, the same for two clients at the same moment; under reduced motion breathing only', async () => {
    const { look } = await ready;
    const deck = look.deck as NonNullable<typeof look.deck>;
    const ship = tallShip as NonNullable<typeof tallShip>;
    const run = (
      seed: number,
      still: boolean,
      steps: number,
    ): { bones: Float32Array; head: Vector3[] } => {
      const body = new CrewBody(deck, seed, machine);
      const inp = input(ship.stations, look, { out: 0.69, y: 0.31, z: 0.35 }, 0, still);
      const head: Vector3[] = [];
      for (let k = 0; k < steps; k++) {
        inp.time = still ? 0 : k / 30;
        poseMember(body, at(3, 1), inp);
        head.push(body.head.clone());
      }
      return { bones: Float32Array.from(body.bones), head };
    };
    // Two clients, the same seat, the same moments: the same bones.
    const a = run(11, false, 300);
    const b = run(11, false, 300);
    expect(Array.from(a.bones)).toEqual(Array.from(b.bones));
    // Another seat: another life.
    const c = run(12, false, 300);
    expect(Array.from(a.bones)).not.toEqual(Array.from(c.bones));
    // Never still: the head moves over ten seconds.
    const spread = (h: Vector3[]): number =>
      new Box3().setFromPoints(h).getSize(new Vector3()).length();
    expect(spread(a.head)).toBeGreaterThan(0.005);
    // Under reduced motion: the head held (breathing moves the chest, not the head's place much).
    const still = run(11, true, 300);
    expect(spread(still.head)).toBeLessThan(spread(a.head) / 2);
    const chest = new CrewBody(deck, 11, machine);
    const inp = input(ship.stations, look, { out: 0.69, y: 0.31, z: 0.35 }, 0, true);
    const spine: Vector3[] = [];
    for (let k = 0; k < 150; k++) {
      poseMember(chest, at(3, 1), inp);
      spine.push(chest.rig.position(chest.rig.bone('clavicle_l'), new Vector3()));
    }
    // A person breathes; a machine does not.
    expect(spread(spine) > 0.0005).toBe(!machine);
  });
});

const DEG = Math.PI / 180;

/** The body's capsules: a bone to the next down its chain, and a radius. */
const CAPSULES: [string, string, number][] = [
  ['pelvis', 'spine_02', 0.08],
  ['spine_02', 'neck_01', 0.09],
  ['neck_01', 'head', 0.05],
  ['upperarm_l', 'lowerarm_l', 0.04],
  ['lowerarm_l', 'hand_l', 0.035],
  ['upperarm_r', 'lowerarm_r', 0.04],
  ['lowerarm_r', 'hand_r', 0.035],
  ['thigh_l', 'calf_l', 0.055],
  ['calf_l', 'foot_l', 0.045],
  ['foot_l', 'ball_l', 0.02],
  ['thigh_r', 'calf_r', 0.055],
  ['calf_r', 'foot_r', 0.045],
  ['foot_r', 'ball_r', 0.02],
];
/** The head, as a ball over its joint: its centre this far up, its radius. */
const HEAD_UP = 0.1;
const HEAD_R = 0.12;
/** The boom's and the mast's radii, m. */
const BOOM_R = 0.05;
const MAST_R = 0.06;

/** The nearest two segments come, a–b and c–d. */
function segments(a: Vector3, b: Vector3, c: Vector3, d: Vector3): number {
  const u = new Vector3().subVectors(b, a);
  const v = new Vector3().subVectors(d, c);
  const w = new Vector3().subVectors(a, c);
  const aa = u.dot(u);
  const bb = u.dot(v);
  const cc = v.dot(v);
  const dd = u.dot(w);
  const ee = v.dot(w);
  const den = aa * cc - bb * bb;
  let s = den > 1e-12 ? Math.max(0, Math.min(1, (bb * ee - cc * dd) / den)) : 0;
  let t = cc > 1e-12 ? Math.max(0, Math.min(1, (bb * s + ee) / cc)) : 0;
  s = aa > 1e-12 ? Math.max(0, Math.min(1, (bb * t - dd) / aa)) : 0;
  t = cc > 1e-12 ? Math.max(0, Math.min(1, (bb * s + ee) / cc)) : 0;
  return new Vector3()
    .addVectors(a, u.multiplyScalar(s))
    .distanceTo(c.clone().addScaledVector(v, t));
}

/** The keelboat as the checks need her: her deck, what stands on it, and the checks themselves. */
const keel = await (async () => {
  const boat = keelboat as NonNullable<typeof keelboat>;
  const {
    boomOver,
    CROSS_SPEED,
    crewPlan,
    crossingWay,
    crossPath,
    duckFor,
    PASS,
    walkPath,
    SIDE_HYSTERESIS,
  } = await import('./crewrules');
  const { CROUCH_SPEED } = await import('./rail');
  const { hullSolid, ballInside } = await import('./solid');
  const model = await load(boat.art.model);
  model.scene.updateMatrixWorld(true);
  const node = (name: string): Vector3 =>
    (model.scene.getObjectByName(name) as Object3D).getWorldPosition(new Vector3());
  const solid = hullSolid(model.scene.getObjectByName('hull')?.userData, node('board-root'), {
    span: boat.physics.foils.boardSpan,
    chord: boat.physics.foils.boardChord,
  });
  if (solid === null) {
    throw new Error('the keelboat has no solid');
  }
  const { modelDeck } = await import('./crew');
  const plan = crewPlan(
    boat.stations,
    solid,
    node('boom'),
    boat.physics.rig.foot,
    modelDeck(model.scene),
  );
  // What stands on her deck: the cuddy, the deadeyes and trim; not the deck, the hull or the rigging.
  const standing: Mesh[] = [];
  for (const part of ['hull', 'mast']) {
    model.scene.getObjectByName(part)?.traverse((o) => {
      if (o instanceof Mesh && o.parent?.name === part) {
        const name = (o.material as MeshStandardMaterial).name;
        if (
          !['deck', 'topsides', 'paint', 'copper', 'rope', 'spar', 'iron', 'bronze'].includes(name)
        ) {
          (o.material as MeshStandardMaterial).side = DoubleSide;
          standing.push(o);
        }
      }
    });
  }
  // What stands on her deck, as triangles in cells of a grid over the deck
  // (0.1 m), for a quick look straight down at a point.
  const CELL = 0.1;
  const cells = new Map<string, number[][]>();
  const cellKey = (x: number, z: number): string =>
    `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  for (const mesh of standing) {
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    const index = g.index;
    const count = index === null ? pos.count : index.count;
    const v = [new Vector3(), new Vector3(), new Vector3()];
    for (let k = 0; k < count; k += 3) {
      for (let c = 0; c < 3; c++) {
        const i = index === null ? k + c : index.getX(k + c);
        (v[c] as Vector3).fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      }
      const [a, b, c] = v as [Vector3, Vector3, Vector3];
      // Only what stands well clear of the deck (not the toe rail's lip).
      if (Math.max(a.y, b.y, c.y) < plan.sheer(a.z) + 0.06) {
        continue;
      }
      const tri = [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z];
      for (
        let cx = Math.floor(Math.min(a.x, b.x, c.x) / CELL);
        cx <= Math.floor(Math.max(a.x, b.x, c.x) / CELL);
        cx++
      ) {
        for (
          let cz = Math.floor(Math.min(a.z, b.z, c.z) / CELL);
          cz <= Math.floor(Math.max(a.z, b.z, c.z) / CELL);
          cz++
        ) {
          const key = `${cx},${cz}`;
          const list = cells.get(key) ?? [];
          list.push(tri);
          cells.set(key, list);
        }
      }
    }
  }
  /** The heights at which a vertical line through (x, z) meets what stands on the deck. */
  const above = (x: number, z: number): number[] => {
    const out: number[] = [];
    for (const t of cells.get(cellKey(x, z)) ?? []) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = t as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-12) {
        continue;
      }
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 >= 0 && l2 >= 0 && l3 >= 0) {
        out.push(l1 * ay + l2 * by + l3 * cy);
      }
    }
    return out;
  };
  /** Whether a point is inside something standing on the deck: under one of its surfaces, above the deck. */
  const inStanding = (p: Vector3): boolean => {
    if (p.y < plan.sheer(p.z) + 0.02) {
      return false;
    }
    return above(p.x, p.z).some((y) => y > p.y && y > plan.sheer(p.z) + 0.06);
  };
  const boomEnds = (boom: number): [Vector3, Vector3] => [
    new Vector3(0, plan.boom.y, plan.boom.z),
    new Vector3(
      plan.boom.length * Math.sin(boom),
      plan.boom.y,
      plan.boom.z + plan.boom.length * Math.cos(boom),
    ),
  ];
  const out = boat.physics.rig.boomOut * DEG;

  /** What a posed body passes through, but the boom: the hull, the cuddy, the deadeyes, the mast. */
  function through(body: CrewBody): string[] {
    const bad: string[] = [];
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const rig = body.rig;
    const pos = (bone: string, o: Vector3): Vector3 =>
      rig.position(rig.bone(bone), o).applyMatrix4(body.root);
    for (const [from, to, r] of CAPSULES) {
      pos(from, a);
      pos(to, b);
      for (let k = 0; k <= 4; k++) {
        c.lerpVectors(a, b, k / 4);
        // The feet on the deck may touch it: their bones' line kept out.
        // (A sole's joints 2 cm over it.)
        const feet = from.startsWith('foot');
        if (
          ballInside(
            solid as NonNullable<typeof solid>,
            c.x,
            feet ? c.y + 0.02 : c.y,
            c.z,
            feet ? 0 : r * 0.7,
          )
        ) {
          bad.push(
            `${from} in the hull at ${c.x.toFixed(2)}, ${c.y.toFixed(3)}, ${c.z.toFixed(2)}`,
          );
          break;
        }
        if (c.y > plan.sheer(c.z) && Math.hypot(c.x, c.z - plan.mastZ) < MAST_R + r) {
          bad.push(`${from} through the mast`);
          break;
        }
        const hit = [
          [0, 0],
          [r, 0],
          [-r, 0],
          [0, r],
          [0, -r],
        ].some(([dx, dz]) =>
          inStanding(new Vector3(c.x + (dx as number), c.y, c.z + (dz as number))),
        );
        if (hit) {
          bad.push(
            `${from} through the cuddy or a deadeye at ${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}`,
          );
          break;
        }
      }
    }
    return bad;
  }

  /** The part of the body the boom came nearest, at the last boomClear. */
  let boomPart = '';

  /** How near the boom comes to a posed body, beyond their radii: negative, through it. */
  function boomClear(body: CrewBody, boom: number): number {
    const [g, e] = boomEnds(boom);
    const rig = body.rig;
    const a = new Vector3();
    const b = new Vector3();
    const pos = (bone: string, o: Vector3): Vector3 =>
      rig.position(rig.bone(bone), o).applyMatrix4(body.root);
    let least = Number.POSITIVE_INFINITY;
    for (const [from, to, r] of CAPSULES) {
      const d = segments(pos(from, a), pos(to, b), g, e) - r - BOOM_R;
      if (d < least) {
        least = d;
        boomPart = from;
      }
    }
    // The head, a ball over its joint, up the neck's way.
    const neck = pos('neck_01', a);
    const head = pos('head', b);
    const centre = head.clone().addScaledVector(head.clone().sub(neck).normalize(), HEAD_UP);
    const hd = segments(centre, centre, g, e) - HEAD_R - BOOM_R;
    if (hd < least) {
      least = hd;
      boomPart = 'head';
    }
    return least;
  }

  return {
    boat,
    boomOver,
    CROSS_SPEED,
    crossingWay,
    crossPath,
    duckFor,
    PASS,
    walkPath,
    SIDE_HYSTERESIS,
    CROUCH_SPEED,
    plan,
    inStanding,
    through,
    boomClear,
    out,
    part: (): string => boomPart,
  };
})();

/** The looks the keelboat's checks pose, each as the fleet holds it. */
const keelLooks = await Promise.all(
  (
    [
      ['rover', 'female'],
      ['machine', 'male'],
    ] as const
  ).map(async ([name, version]) => {
    const machine = name === 'machine';
    const art = machine
      ? catalog.machine.versions.find((v) => v.id === version)?.art
      : catalog.sailors.find((s) => s.id === name)?.versions.find((v) => v.id === version)?.art;
    return {
      name,
      version,
      machine,
      ...(await fleetLook(art as NonNullable<typeof art>, machine)),
    };
  }),
);

describe('on the keelboat, nothing through anything', () => {
  const {
    boat,
    boomOver,
    CROSS_SPEED,
    crossingWay,
    crossPath,
    duckFor,
    PASS,
    walkPath,
    SIDE_HYSTERESIS,
    CROUCH_SPEED,
    plan,
    inStanding,
    through,
    boomClear,
    out,
    part,
  } = keel;

  test('the checks see the cuddy and a deadeye, and not the open deck or the cockpit', () => {
    expect(inStanding(new Vector3(0.3, 0.85, -0.3))).toBe(true);
    expect(inStanding(new Vector3(1.218, 0.85, -1.02))).toBe(true);
    expect(inStanding(new Vector3(0.9, 0.85, -0.3))).toBe(false);
    expect(inStanding(new Vector3(0.3, 0.6, 1))).toBe(false);
    expect(inStanding(new Vector3(0.5, 0.85, -1.6))).toBe(false);
  });

  describe.each(keelLooks.map((l) => [l.name, l.version, l] as const))(
    '%s %s',
    (name, version, l) => {
      const { look, seat, machine } = l;
      const deck = look.deck as NonNullable<typeof look.deck>;
      const body = new CrewBody(deck, 5, machine);
      const inp = input(boat.stations, look, seat);
      /** The duck last posed in, and the head (as it would be upright) of the pose last posed at duck 0. */
      let posedDuck = -1;
      const head = new Vector3();
      /** Poses a member upright, for its head; the duck then as the rule has it for each boom. */
      const upright = (m: CrewMember): void => {
        inp.duck = 0;
        poseMember(body, m, inp);
        head.copy(body.headUp);
        posedDuck = 0;
      };
      /** How clear of the boom the member last posed upright is, ducked as the rule has it for it. */
      const ducked = (m: CrewMember, boom: number): number => {
        const duck = Math.round(duckFor(plan, boom, 0, head) * 50) / 50;
        if (duck !== posedDuck) {
          inp.duck = duck;
          poseMember(body, m, inp);
          posedDuck = duck;
        }
        return boomClear(body, boom);
      };

      test('at every station, both sides, sitting up and leaning out, the boom anywhere to leeward or just over to windward', () => {
        const bad: string[] = [];
        for (let i = 1; i < boat.stations.length; i++) {
          for (const side of [1, -1]) {
            for (const lean of [0, 1]) {
              for (const t of [0, 2.8, 5.6, 8.4]) {
                inp.time = t;
                const m = at(i, side, lean);
                upright(m);
                for (const b of through(body)) {
                  bad.push(`${i} ${side} ${lean} ${t}: ${b}`);
                }
                for (let a = -SIDE_HYSTERESIS; a <= out + 1e-6; a += 5 * DEG) {
                  const boom = -side * Math.max(-SIDE_HYSTERESIS, a);
                  const clear = ducked(m, boom);
                  if (clear < 0) {
                    bad.push(
                      `${i} ${side} ${lean} ${t}: the boom at ${(boom / DEG).toFixed(0)}° ${clear.toFixed(3)} through`,
                    );
                  }
                }
              }
            }
          }
        }
        expect(bad).toEqual([]);
      });

      test('crossing, every way across, from either side, the boom anywhere on the side left; waiting while it lies over the place', () => {
        const bad: string[] = [];
        let least = Number.POSITIVE_INFINITY;
        let afterWait = Number.POSITIVE_INFINITY;
        const waits: string[] = [];
        for (let i = 1; i < boat.stations.length; i++) {
          const st = boat.stations[i] as (typeof boat.stations)[number];
          for (const from of [1, -1]) {
            // Each way across, with the angles of the boom it is taken at.
            const ways = new Map<string, { path: ReturnType<typeof crossPath>; booms: number[] }>();
            for (let a = SIDE_HYSTERESIS; a <= out + 1e-6; a += 5 * DEG) {
              const boom = from * a;
              const path = crossPath(plan, st, from, boom);
              const key = `${path.length.toFixed(4)} ${path.z[1]?.toFixed(3)}`;
              const way = ways.get(key) ?? { path, booms: [] };
              way.booms.push(boom);
              ways.set(key, way);
            }
            for (const { path, booms } of ways.values()) {
              const move = {
                path,
                from: { station: i, side: from },
                to: { station: i, side: -from },
                t: 0,
                duration: 1 + path.length,
                kind: 'cross' as const,
                waited: 0,
              };
              const m: CrewMember = { ...at(i, from), moving: move };
              for (let t = 0; t <= move.duration + 1e-6; t += 0.1) {
                move.t = t;
                upright(m);
                for (const b of through(body)) {
                  bad.push(`${i} from ${from} at ${t.toFixed(1)}: ${b}`);
                }
                for (const boom of booms) {
                  const waits0 = crossingWay(plan, st) === 'mast' && boomOver(plan, st, from, boom);
                  if (waits0 && t === 0) {
                    waits.push(`${i} from ${from} at ${(boom / DEG).toFixed(0)}°`);
                  }
                  const clear = ducked(m, boom);
                  if (waits0) {
                    // Gone all the same after the longest wait: measured.
                    afterWait = Math.min(afterWait, clear);
                    continue;
                  }
                  least = Math.min(least, clear);
                  if (clear < 0) {
                    bad.push(
                      `${i} from ${from} at ${t.toFixed(1)}: the boom at ${(boom / DEG).toFixed(0)}° ${clear.toFixed(3)} through, ${part()} (ducked ${inp.duck.toFixed(2)})`,
                    );
                  }
                }
              }
            }
          }
        }
        process.stdout.write(
          `${name} ${version}: crossing, the boom's least clearance ${least.toFixed(3)} m; waiting for it at ${waits.join(', ')}; gone after the wait, ${afterWait.toFixed(3)} m\n`,
        );
        expect(bad).toEqual([]);
      });

      test('changing places along the windward side deck, the boom anywhere to leeward', () => {
        const bad: string[] = [];
        for (let i = 1; i < boat.stations.length; i++) {
          for (const side of [1, -1]) {
            for (const [from, to] of [
              [-1, i],
              [i, -1],
            ] as const) {
              const z = (k: number): number =>
                (boat.stations[Math.max(0, k)]?.at[2] as number) ?? 0;
              const path = walkPath(plan, side, z(from), z(to), z(to) < z(from) ? -PASS : PASS);
              const move = {
                path,
                from: { station: from, side },
                to: { station: to, side },
                t: 0,
                duration: 1 + path.length,
                kind: 'change' as const,
                waited: 0,
              };
              const m: CrewMember = { ...at(Math.max(to, 0), side), moving: move };
              for (let t = 0; t <= move.duration + 1e-6; t += 0.1) {
                move.t = t;
                upright(m);
                for (const b of through(body)) {
                  bad.push(`${from}→${to} on ${side} at ${t.toFixed(1)}: ${b}`);
                }
                for (let a = 0; a <= out + 1e-6; a += 10 * DEG) {
                  const clear = ducked(m, -side * a);
                  if (clear < 0) {
                    bad.push(
                      `${from}→${to} on ${side} at ${t.toFixed(1)}: the boom at ${a / DEG}° ${clear.toFixed(3)} through`,
                    );
                  }
                }
              }
            }
          }
        }
        expect(bad).toEqual([]);
      });

      test('walking across, the feet that bear on the deck stay where they are put down where the path runs straight: the ball of the foot within 4 cm a step', () => {
        const report: string[] = [];
        let worstStraight = 0;
        let worstAll = 0;
        for (let i = 1; i < boat.stations.length; i++) {
          const st = boat.stations[i] as (typeof boat.stations)[number];
          const path = crossPath(plan, st, 1, 0);
          const move = {
            path,
            from: { station: i, side: 1 },
            to: { station: i, side: -1 },
            t: 0,
            duration: 1 + path.length,
            kind: 'cross' as const,
            waited: 0,
          };
          const m: CrewMember = { ...at(i, 1), moving: move };
          const dt = 1 / 60;
          // Each foot's ball, frame by frame, along the walk (after getting up, before sitting down), in
          // the boat's model and in the figure's own space.
          const track: Record<'l' | 'r', { p: Vector3; f: Vector3; straight: boolean }[]> = {
            l: [],
            r: [],
          };
          const here = { x: 0, y: 0, z: 0 };
          for (let t = 0.5; t <= 0.5 + path.length; t += dt) {
            move.t = t;
            inp.duck = 0;
            poseMember(body, m, inp);
            const s = t - 0.5;
            // Straight here: the way it heads a little before and after the same.
            const h0 = path.at(s - 0.15, here);
            const h1 = path.at(s + 0.15, here);
            const straight =
              Math.abs(Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0))) < 0.05 &&
              path.stepAt(s) === null;
            for (const side of ['l', 'r'] as const) {
              const f = body.rig.position(body.rig.bone(`ball_${side}`), new Vector3());
              track[side].push({ p: f.clone().applyMatrix4(body.root), f, straight });
            }
          }
          for (const side of ['l', 'r'] as const) {
            const t = track[side];
            // Bearing: the ball within 1.5 cm of the deck's height there.
            let drift = 0;
            let straightRun = true;
            const low = Math.min(...t.map((x) => x.f.y));
            for (let k = 1; k < t.length; k++) {
              const a = t[k - 1] as { p: Vector3; f: Vector3; straight: boolean };
              const b = t[k] as { p: Vector3; f: Vector3; straight: boolean };
              // Bearing: at its lowest in the figure's own space, going back under
              // the figure as the walk's bearing foot does (one in the air goes
              // forward).
              const back = (a.f.z - b.f.z) / dt;
              const flat = a.f.y < low + 0.008 && b.f.y < low + 0.008;
              if (flat && back > 0.6 * (CROSS_SPEED / CROUCH_SPEED) * CROUCH_SPEED) {
                drift += Math.hypot(b.p.x - a.p.x, b.p.z - a.p.z);
                straightRun &&= a.straight && b.straight;
                worstAll = Math.max(worstAll, drift);
                if (straightRun) {
                  worstStraight = Math.max(worstStraight, drift);
                }
              } else {
                drift = 0;
                straightRun = true;
              }
            }
          }
        }
        report.push(
          `${name} ${version}: a bearing foot slides at most ${(worstStraight * 100).toFixed(1)} cm a step where the path runs straight, ${(worstAll * 100).toFixed(1)} cm round its corners`,
        );
        process.stdout.write(`${report.join('\n')}\n`);
        // The ball's joint rolls over the toes as the heel lifts, and the
        // feet, a step apart either side, turn with the body as the path bends.
        expect(worstStraight).toBeLessThan(0.04);
      });

      test('the helm sat to leeward under an eased boom: measured, as the helm is drawn', () => {
        // The helm's station on the boom's side, sat in (as the physics' lee reach has it), not ducking.
        const helm = at(0, 1);
        helm.station = -1;
        let worst = Number.POSITIVE_INFINITY;
        let worstAt = 0;
        const hits: number[] = [];
        upright(helm);
        for (let a = 0; a <= out + 1e-6; a += 5 * DEG) {
          const clear = boomClear(body, a);
          if (clear < worst) {
            worst = clear;
            worstAt = a;
          }
          if (clear < 0) {
            hits.push(Math.round(a / DEG));
          }
        }
        process.stdout.write(
          `${name} ${version}: the helm to leeward, the boom's least clearance ${worst.toFixed(3)} m at ${(worstAt / DEG).toFixed(0)}°; through it at ${hits.length === 0 ? 'no angle' : `${hits[0]}°–${hits.at(-1)}°`}\n`,
        );
        expect(Number.isFinite(worst)).toBe(true);
      });
    },
  );
}, 20_000);
