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
import { type CrewMember, RISE, SIT } from './crewrules';
import { deckLook, FleetLook } from './fleetlooks';
import { placesOf } from './model';
import { boneNames } from './onboat';
import { railClips } from './rail';
import { Rig } from './rig';
import type { ShipMember } from './shiprules';

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
  /** The kinds with stations to windward of the boom: a dinghy's crew on its rack, a keelboat's along her rail (not a ship's, whose weather side is her yards'). */
  const crewed = catalog.boats.filter(
    (b) =>
      b.stations.some((s) => s.windward === true) && !b.stations.some((s) => s.pose === 'aloft'),
  );
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

  test('the Jolly boat’s station is as it was: not to windward, not on a rail', () => {
    for (const b of catalog.boats.filter((x) => x.capacity === 1)) {
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
      if (boat.stations.some((t) => t.pose === 'aloft') && s.pose !== 'standing') {
        // A ship's people leaning on her rail, sat on her hatch or in her top: held to her model aboard her (below).
        return;
      }
      // On the rail: the deck just inboard of its edge, the point at the
      // edge; on a bench, its top just outboard of its front edge.
      const rail = s.pose === 'rail';
      const inboard = rail
        ? x - Math.sign(x) * 0.04
        : s.pose === 'bench'
          ? x + Math.sign(x) * 0.04
          : x;
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
/** The tiller's and its extension's radii, and the extension's length (the keelboat's), m. */
const TILLER_R = 0.03;
const EXTENSION = 1.27;

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
    changePath,
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
  const { tillerOf } = await import('./crew');
  const plan = crewPlan(
    boat.stations,
    solid,
    node('boom'),
    boat.physics.rig.foot,
    modelDeck(model.scene),
    tillerOf(model.scene),
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

  /**
   * How near a point comes to the tiller, beyond its radius, wherever the
   * rudder swings it (to 30° either way); and to the extension, held by
   * the helm at their place on the side extension is told, if it is.
   */
  const tillerAt = plan.tiller as NonNullable<typeof plan.tiller>;
  let extension = 0;
  const tillerNear = (p: Vector3): number => {
    const t = tillerAt;
    let d = Number.POSITIVE_INFINITY;
    const head = new Vector3(0, t.top - TILLER_R, t.head);
    const length = t.head - t.hinge;
    for (const a of [-30, -15, 0, 15, 30]) {
      const hinge = new Vector3(
        length * Math.sin(a * DEG),
        t.top - TILLER_R,
        t.head - length * Math.cos(a * DEG),
      );
      d = Math.min(d, segments(p, p, head, hinge) - TILLER_R);
      if (extension !== 0 && a === 0) {
        // To the helm's aft hand, by the gunwale forward of the hinge.
        const grip = new Vector3(extension * 0.95, 1.0, 1.3)
          .sub(hinge)
          .setLength(EXTENSION)
          .add(hinge);
        d = Math.min(d, segments(p, p, hinge, grip) - TILLER_R);
      }
    }
    return d;
  };

  /** What a posed body passes through, but the boom: the hull, the cuddy, the deadeyes, the mast, the tiller. */
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
        const tiller = tillerNear(c);
        if (tiller < r) {
          bad.push(
            `${from} through the tiller at ${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}`,
          );
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
    changePath,
    SIDE_HYSTERESIS,
    CROUCH_SPEED,
    plan,
    inStanding,
    through,
    boomClear,
    out,
    part: (): string => boomPart,
    tillerNear,
    /** The extension held by a helm at their place on side (+1 starboard); 0 for none. */
    holdExtension: (side: number): void => {
      extension = side;
    },
  };
})();

/**
 * How far apart any two aboard keep, beyond their radii, m: walking; and
 * getting up or sitting down beside someone, no nearer than two sat
 * shoulder to shoulder on the rail come (their capsules are generous).
 */
const PEOPLE_APART = 0.02;
const SAT_CLOSE = -0.07;
/** How clear of the boom everyone keeps, crossing, beyond their radii and its, m. */
const BOOM_MARGIN = 0.01;

/** The looks the keelboat's checks pose, every one, the machines too, each as the fleet holds it. */
const keelLooks = await Promise.all(
  [
    ...catalog.sailors.flatMap((s) => s.versions.map((v) => [s.id, v.id] as const)),
    ...catalog.machine.versions.map((v) => ['machine', v.id] as const),
  ].map(async ([name, version]) => {
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
    changePath,
    SIDE_HYSTERESIS,
    CROUCH_SPEED,
    plan,
    inStanding,
    through,
    boomClear,
    out,
    part,
    holdExtension,
    tillerNear,
  } = keel;

  test('the checks see the cuddy, a deadeye, the tiller and the extension, and not the open deck or the cockpit', () => {
    expect(inStanding(new Vector3(0.3, 0.85, -0.3))).toBe(true);
    expect(inStanding(new Vector3(1.218, 0.85, -1.02))).toBe(true);
    expect(inStanding(new Vector3(0.9, 0.85, -0.3))).toBe(false);
    expect(inStanding(new Vector3(0.3, 0.6, 1))).toBe(false);
    expect(inStanding(new Vector3(0.5, 0.85, -1.6))).toBe(false);
    // The tiller wherever the rudder swings it, and the extension only while held.
    const t = plan.tiller as NonNullable<typeof plan.tiller>;
    expect(tillerNear(new Vector3(0, t.top - 0.03, (t.head + t.hinge) / 2))).toBeLessThan(0);
    expect(tillerNear(new Vector3(0.4, t.top, t.hinge + 0.4))).toBeLessThan(0.05);
    expect(tillerNear(new Vector3(0.9, t.top, t.hinge))).toBeGreaterThan(0.3);
    const onExtension = new Vector3(0.3, 0.88, t.hinge - 0.2);
    expect(tillerNear(onExtension)).toBeGreaterThan(0.1);
    holdExtension(1);
    expect(tillerNear(onExtension)).toBeLessThan(0.06);
    holdExtension(0);
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

      test('at every station, both sides, sitting up and leaning out, the boom anywhere to leeward or just over to windward, clear of the tiller and the helm’s extension', () => {
        const bad: string[] = [];
        for (let i = 1; i < boat.stations.length; i++) {
          for (const side of [1, -1]) {
            for (const lean of [0, 1]) {
              for (const t of [0, 2.8, 5.6, 8.4]) {
                inp.time = t;
                const m = at(i, side, lean);
                upright(m);
                // The helm beside them to windward, the extension in their aft hand.
                holdExtension(side);
                for (const b of through(body)) {
                  bad.push(`${i} ${side} ${lean} ${t}: ${b}`);
                }
                holdExtension(0);
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

      test('crossing, every way across, from either side, the boom anywhere on the side left, clear of it by a centimetre; waiting while it lies over the place, and clear of it after the wait', () => {
        const bad: string[] = [];
        let least = Number.POSITIVE_INFINITY;
        let afterWait = Number.POSITIVE_INFINITY;
        const waits: string[] = [];
        for (let i = 1; i < boat.stations.length; i++) {
          const st = boat.stations[i] as (typeof boat.stations)[number];
          for (const from of [1, -1]) {
            // Each way across, with the angles of the boom it is taken at.
            // To their own place, or, round the mast in file, to another's of the same way.
            const ways = new Map<
              string,
              { path: ReturnType<typeof crossPath>; booms: number[]; to: number }
            >();
            const sameWay = boat.stations
              .map((_, k) => k)
              .filter(
                (k) =>
                  k > 0 &&
                  crossingWay(plan, boat.stations[k] as typeof st) === crossingWay(plan, st) &&
                  (k === i || crossingWay(plan, st) === 'mast'),
              );
            for (const to of sameWay) {
              for (let a = SIDE_HYSTERESIS; a <= out + 1e-6; a += 5 * DEG) {
                const boom = from * a;
                const path = crossPath(plan, st, from, boom, boat.stations[to] as typeof st);
                const key = `${to} ${path.length.toFixed(4)} ${path.z[1]?.toFixed(3)}`;
                const way = ways.get(key) ?? { path, booms: [], to };
                way.booms.push(boom);
                ways.set(key, way);
              }
            }
            for (const { path, booms, to } of ways.values()) {
              const move = {
                path,
                from: { station: i, side: from },
                to: { station: to, side: -from },
                t: 0,
                duration: 1 + path.length,
                kind: 'cross' as const,
                waited: 0,
              };
              const m: CrewMember = { ...at(to, from), moving: move };
              for (let t = 0; t <= move.duration + 1e-6; t += 0.1) {
                move.t = t;
                upright(m);
                for (const b of through(body)) {
                  bad.push(`${i}→${to} from ${from} at ${t.toFixed(1)}: ${b}`);
                }
                for (const boom of booms) {
                  const waits0 = crossingWay(plan, st) === 'mast' && boomOver(plan, st, from, boom);
                  if (waits0 && t === 0) {
                    waits.push(`${i}→${to} from ${from} at ${(boom / DEG).toFixed(0)}°`);
                  }
                  const clear = ducked(m, boom);
                  if (waits0) {
                    // Gone all the same after the longest wait.
                    afterWait = Math.min(afterWait, clear);
                  } else {
                    least = Math.min(least, clear);
                  }
                  if (clear < BOOM_MARGIN) {
                    bad.push(
                      `${i}→${to} from ${from} at ${t.toFixed(1)}${waits0 ? ' after the wait' : ''}: the boom at ${(boom / DEG).toFixed(0)}° ${clear.toFixed(3)} near, ${part()} (ducked ${inp.duck.toFixed(2)})`,
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

      test('changing places on the windward side, the boom anywhere to leeward', () => {
        const bad: string[] = [];
        for (let i = 1; i < boat.stations.length; i++) {
          for (const side of [1, -1]) {
            for (const [from, to] of [
              [-1, i],
              [i, -1],
            ] as const) {
              const z = (k: number): number =>
                (boat.stations[Math.max(0, k)]?.at[2] as number) ?? 0;
              const path = changePath(plan, side, z(from), z(to));
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

/** The capsules of a posed body in the boat's model, the head as a ball: [a, b, radius]. */
function capsulesOf(body: CrewBody): [Vector3, Vector3, number][] {
  const rig = body.rig;
  const pos = (bone: string): Vector3 =>
    rig.position(rig.bone(bone), new Vector3()).applyMatrix4(body.root);
  const out: [Vector3, Vector3, number][] = CAPSULES.map(([a, b, r]) => [pos(a), pos(b), r]);
  const neck = pos('neck_01');
  const head = pos('head');
  const centre = head.clone().addScaledVector(head.clone().sub(neck).normalize(), HEAD_UP);
  out.push([centre, centre, HEAD_R]);
  return out;
}

/** How far apart two posed bodies are, beyond their radii: negative, one through the other. */
function apart(a: [Vector3, Vector3, number][], b: [Vector3, Vector3, number][]): number {
  let least = Number.POSITIVE_INFINITY;
  for (const [a0, a1, ra] of a) {
    for (const [b0, b1, rb] of b) {
      least = Math.min(least, segments(a0, a1, b0, b1) - ra - rb);
    }
  }
  return least;
}

describe('on the keelboat, nobody through anybody', () => {
  const { boat, plan, duckFor } = keel;
  /** Two looks: a woman's and the male machine, the tallest. */
  const looks = keelLooks.filter(
    (l) =>
      (l.name === 'rover' && l.version === 'female') ||
      (l.name === 'machine' && l.version === 'male'),
  );

  /**
   * Sails a crew under the rules for seconds, the boom (radians) and the
   * wind off the bow as boomAt gives them at each moment, posing everyone
   * aboard ten times a second, each in their own look: the least any two
   * come to each other, and when.
   */
  async function sailApart(
    people: number,
    script: (
      rules: import('./crewrules').CrewRules,
      t: number,
    ) => { boom: number; windOffBow: number },
    seconds: number,
  ): Promise<{
    least: number;
    at: string;
    seated: number;
    walking: number;
    walkingAt: string;
  }> {
    const { CrewRules, duckStep } = await import('./crewrules');
    const rules = new CrewRules(plan);
    rules.set(
      {
        people: Array.from({ length: people }, (_, seat) => ({ seat, look: seat })),
        holder: 0,
      },
      false,
    );
    const bodies = new Map<number, { body: CrewBody; inp: PoseInput; duck: number }>();
    const dt = 1 / 30;
    let least = Number.POSITIVE_INFINITY;
    let when = '';
    let boom = 0;
    /** The nearest any two sat at their places come, as their places put them. */
    let seated = Number.POSITIVE_INFINITY;
    let walking = Number.POSITIVE_INFINITY;
    let walkingAt = '';
    for (let k = 0; k * dt <= seconds; k++) {
      const t = k * dt;
      const now = script(rules, t);
      const rate = (now.boom - boom) / dt;
      boom = now.boom;
      rules.step({ dt, boom: now.boom, windOffBow: now.windOffBow, depth: 0 });
      if (k % 3 !== 0) {
        continue;
      }
      const posed: {
        seat: number;
        caps: [Vector3, Vector3, number][];
        moving: boolean;
        /** Walking along their path, not getting up or sitting down. */
        walking: boolean;
        what: string;
      }[] = [];
      for (const m of rules.members) {
        if (m.station <= 0 && m.moving === null) {
          continue;
        }
        const l = looks[m.seat % looks.length] as (typeof looks)[number];
        let b = bodies.get(m.seat);
        if (b === undefined) {
          b = {
            body: new CrewBody(
              l.look.deck as NonNullable<typeof l.look.deck>,
              m.seat + 1,
              l.machine,
            ),
            inp: input(boat.stations, l.look, l.seat),
            duck: 0,
          };
          bodies.set(m.seat, b);
        }
        b.inp.time = t;
        b.inp.duck = b.duck;
        poseMember(b.body, m, b.inp);
        b.duck = duckStep(b.duck, duckFor(plan, boom, rate, b.body.headUp), 3 * dt);
        const mv = m.moving;
        posed.push({
          seat: m.seat,
          caps: capsulesOf(b.body),
          moving: mv !== null && mv.t >= 0,
          walking: mv !== null && mv.t >= RISE && mv.t <= mv.duration - SIT,
          what:
            mv === null
              ? `at ${m.station}`
              : `${mv.kind} ${mv.from.station}→${mv.to.station} ${mv.t.toFixed(1)}/${mv.duration.toFixed(1)}`,
        });
      }
      for (let i = 0; i < posed.length; i++) {
        for (let j = i + 1; j < posed.length; j++) {
          const d = apart(
            (posed[i] as (typeof posed)[number]).caps,
            (posed[j] as (typeof posed)[number]).caps,
          );
          if (!posed[i]?.moving && !posed[j]?.moving) {
            // Two sat at their places, as close as their places put them.
            seated = Math.min(seated, d);
            continue;
          }
          if (posed[i]?.walking && posed[j]?.walking && d < walking) {
            walking = d;
            walkingAt = `seats ${posed[i]?.seat} (${posed[i]?.what}) and ${posed[j]?.seat} (${posed[j]?.what}) at ${t.toFixed(1)} s`;
          }
          if (d < least) {
            least = d;
            when = `seats ${posed[i]?.seat} (${posed[i]?.what}) and ${posed[j]?.seat} (${posed[j]?.what}) at ${t.toFixed(1)} s`;
          }
        }
      }
    }
    return { least, at: when, seated, walking, walkingAt };
  }

  const tack = (to: number) => (_r: unknown, t: number) => ({
    boom: t < 1 ? -to : to,
    windOffBow: 30 * DEG,
  });
  const gybe = (to: number) => (_r: unknown, t: number) => ({
    boom: t < 1 ? -to : to,
    windOffBow: 160 * DEG,
  });

  test.each([
    ['a tack', tack(0.2)],
    ['a gybe, the boom out to 40°', gybe(40 * DEG)],
    ['a gybe, the boom out to 60°', gybe(60 * DEG)],
    ['a gybe, the boom out to 80°', gybe(80 * DEG)],
  ] as const)(
    'five aboard crossing in %s: everyone moving apart from everyone',
    async (what, script) => {
      const r = await sailApart(5, script, 14);
      process.stdout.write(
        `five aboard, ${what}: nearest ${r.least.toFixed(3)} m, ${r.at}; two walking ${r.walking.toFixed(3)} m; sat shoulder to shoulder ${r.seated.toFixed(3)} m\n`,
      );
      // Two walking apart; getting up or sitting down beside someone, no nearer than two sit.
      expect(r.walking, r.walkingAt).toBeGreaterThan(PEOPLE_APART);
      expect(r.least, r.at).toBeGreaterThan(SAT_CLOSE);
    },
  );

  test.each([
    [5, 1, true],
    [5, 4, true],
    [3, 1, true],
    [2, 1, true],
    [5, 2, false],
    [5, 3, false],
    [3, 2, false],
  ])(
    '%i aboard, the skipper handing the controls to the one in seat %i: beside the cockpit (%s), the two change places apart from each other and from everyone else; forward of it, measured',
    async (n, holder, beside) => {
      const r = await sailApart(
        n,
        (rules, t) => {
          if (Math.abs(t - 1) < 1e-6) {
            rules.set({
              people: Array.from({ length: n }, (_, seat) => ({ seat, look: seat })),
              holder,
            });
          }
          return { boom: -0.25, windOffBow: 40 * DEG };
        },
        7,
      );
      process.stdout.write(
        `${n} aboard, handed to seat ${holder}${beside ? '' : ' (forward of the cockpit: passing on the side deck)'}: nearest ${r.least.toFixed(3)} m, ${r.at}; two walking ${r.walking.toFixed(3)} m; sat ${r.seated.toFixed(3)} m\n`,
      );
      if (beside) {
        expect(r.walking, r.walkingAt).toBeGreaterThan(PEOPLE_APART);
        expect(r.least, r.at).toBeGreaterThan(SAT_CLOSE);
      }
    },
  );
}, 60_000);

// --- Aboard the tall ship ----------------------------------------------------

/** The nearest point of a triangle to p (Ericson's), its distance. */
function triangleDistance(p: Vector3, a: Vector3, b: Vector3, c: Vector3): number {
  const ab = new Vector3().subVectors(b, a);
  const ac = new Vector3().subVectors(c, a);
  const ap = new Vector3().subVectors(p, a);
  const d1 = ab.dot(ap);
  const d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) {
    return p.distanceTo(a);
  }
  const bp = new Vector3().subVectors(p, b);
  const d3 = ab.dot(bp);
  const d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) {
    return p.distanceTo(b);
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    return p.distanceTo(a.clone().addScaledVector(ab, d1 / (d1 - d3)));
  }
  const cp = new Vector3().subVectors(p, c);
  const d5 = ab.dot(cp);
  const d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) {
    return p.distanceTo(c);
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    return p.distanceTo(a.clone().addScaledVector(ac, d2 / (d2 - d6)));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return p.distanceTo(
      b.clone().addScaledVector(new Vector3().subVectors(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))),
    );
  }
  const denom = 1 / (va + vb + vc);
  return p.distanceTo(
    a
      .clone()
      .addScaledVector(ab, vb * denom)
      .addScaledVector(ac, vc * denom),
  );
}

/** The tall ship as her company's checks need her: her plan, rules, and what of her a body may not pass through. */
const ship = await (async () => {
  const kind = tallShip as NonNullable<typeof tallShip>;
  const model = await load(kind.art.model);
  model.scene.updateMatrixWorld(true);
  const parts = new Map<string, Object3D>();
  model.scene.traverse((o) => {
    if (o.name !== '' && !parts.has(o.name)) {
      parts.set(o.name, o);
    }
  });
  const { company } = await import('./ship');
  const { ShipRules, shipPlan } = await import('./shiprules');
  const c = company(parts);
  const plan = shipPlan(kind.stations, c);
  if (c === null || plan === null) {
    throw new Error('the tall ship has no company');
  }
  // What of her a body may not pass through: her bulwarks, rails, the
  // breaks, hatches, capstan, fife rails, bitts, the longboat and its
  // skids, the masts, the wheel and the binnacle; not her decks (walked
  // on), her ropes, sails or what is outboard of her.
  const solid = ['paint', 'rail', 'spar', 'blackwood', 'iron', 'varnish', 'brass'];
  const CELL = 0.25;
  const cells = new Map<string, Vector3[][]>();
  const names = new Map<Vector3[], string>();
  model.scene.traverse((o) => {
    if (!(o instanceof Mesh)) {
      return;
    }
    const mat = (o.material as MeshStandardMaterial).name;
    // Not the yards (aloft) nor the mizzen's boom and gaff, 2 m over her quarterdeck (heads pass under it).
    const node = o.parent?.name ?? '';
    if (
      !solid.includes(mat) ||
      node.includes('yard') ||
      node === 'boom' ||
      node === 'gaff' ||
      o.name === 'boom' ||
      o.name === 'gaff'
    ) {
      return;
    }
    const g = o.geometry;
    const pos = g.getAttribute('position');
    const index = g.index;
    const count = index === null ? pos.count : index.count;
    for (let k = 0; k < count; k += 3) {
      const tri = [0, 1, 2].map((j) =>
        new Vector3()
          .fromBufferAttribute(pos, index === null ? k + j : index.getX(k + j))
          .applyMatrix4(o.matrixWorld),
      ) as [Vector3, Vector3, Vector3];
      // Only what stands over her decks, inboard of her sides.
      if (Math.max(...tri.map((p) => p.y)) < 2.5) {
        continue;
      }
      names.set(tri, `${o.parent?.name ?? ''}/${o.name}:${mat}`);
      const lo = new Vector3(
        ...[0, 1, 2].map((a) => Math.min(...tri.map((p) => p.getComponent(a)))),
      );
      const hi = new Vector3(
        ...[0, 1, 2].map((a) => Math.max(...tri.map((p) => p.getComponent(a)))),
      );
      for (let x = Math.floor(lo.x / CELL); x <= Math.floor(hi.x / CELL); x++) {
        for (let z = Math.floor(lo.z / CELL); z <= Math.floor(hi.z / CELL); z++) {
          const key = `${x},${z}`;
          const list = cells.get(key) ?? [];
          list.push(tri);
          cells.set(key, list);
        }
      }
    }
  });
  /** How near a point comes to her, and to what. */
  const near = (p: Vector3, reach: number): { d: number; what: string } => {
    let best = { d: Number.POSITIVE_INFINITY, what: '' };
    const k = Math.ceil(reach / CELL);
    const cx = Math.floor(p.x / CELL);
    const cz = Math.floor(p.z / CELL);
    const seen = new Set<Vector3[]>();
    for (let x = cx - k; x <= cx + k; x++) {
      for (let z = cz - k; z <= cz + k; z++) {
        for (const t of cells.get(`${x},${z}`) ?? []) {
          if (seen.has(t)) {
            continue;
          }
          seen.add(t);
          const d = triangleDistance(p, t[0] as Vector3, t[1] as Vector3, t[2] as Vector3);
          if (d < best.d) {
            best = { d, what: names.get(t) ?? '' };
          }
        }
      }
    }
    return best;
  };
  const rules = (still = false) => new ShipRules({ stations: kind.stations, ship: plan }, still);
  return { kind, company: c, plan, near, rules };
})();

/** A look as the fleet holds it with a ship's clips too: about her decks, and her work and aloft. */
async function shipLook(art: Parameters<typeof fleetLook>[0], machine: boolean) {
  const { look } = await fleetLook(art, machine);
  const { shipClips, aloftClips } = await import('./ship');
  const [deck, aloft, model] = await Promise.all([
    load(shipClips(art.clips)),
    load(aloftClips(art.clips)),
    load(art.model),
  ]);
  const rig = Rig.from(model.scene, boneNames(model.scene));
  const clips = look.clips as Map<string, Clip>;
  for (const file of [deck, aloft]) {
    const places = placesOf(file.scene);
    for (const a of file.animations) {
      const place = places.get(`place-${a.name}`) ?? null;
      clips.set(
        a.name,
        Clip.from(a, rig, place !== null && !place.equals(new Matrix4()) ? place : null),
      );
    }
  }
  return look;
}

/** The looks posed aboard her: a woman's and a man's of the Rover, and the male machine. */
const shipLooks = await Promise.all(
  [
    ['rover', 'female'],
    ['rover', 'male'],
    ['machine', 'male'],
  ].map(async ([name, version]) => {
    const machine = name === 'machine';
    const art = machine
      ? catalog.machine.versions.find((v) => v.id === version)?.art
      : catalog.sailors.find((s) => s.id === name)?.versions.find((v) => v.id === version)?.art;
    return {
      name: `${name} ${version}`,
      machine,
      look: await shipLook(art as NonNullable<typeof art>, machine),
    };
  }),
);

describe('aboard the tall ship', () => {
  const { kind, near, rules: makeRules, company: c } = ship;

  /** A ship's pose input for a look, at a moment. */
  const shipInput = async (
    rules: Awaited<ReturnType<typeof makeRules>>,
    look: FleetLook,
    world: number,
    up = new Vector3(0, 1, 0),
  ) => {
    const { stance } = await import('./crewbody');
    return {
      rules,
      clips: look.clips as Map<string, Clip>,
      machine: look.machine,
      time: world,
      world,
      life: { dt: 1 / 30, heel: 0, upright: 0, still: false, plumb: null },
      up,
      a: stance(),
      b: stance(),
    };
  };

  test('every station’s person stands on her deck, within a centimetre (in the top, on its floor; sat, on the hatch’s grating)', () => {
    const { shipStation, standPoint } = shipRules;
    const deck = modelDeckOf(ship);
    const off: string[] = [];
    kind.stations.forEach((s, i) => {
      for (const weather of [1, -1]) {
        const sp = shipStation(s, weather, { at: new Vector3(), facing: 0, side: 1 });
        const p = standPoint(s, sp, new Vector3());
        const y = s.pose === 'aloft' ? c.top.y : deck(p.x, p.z);
        if (y === null || Math.abs(y - p.y) > 0.01) {
          off.push(`${i} (${s.pose}): stands at ${p.y.toFixed(3)}, the deck at ${y?.toFixed(3)}`);
        }
        if (s.pose === 'seated' && Math.abs(s.at[1] - c.hatch.y) > 0.001) {
          off.push(`${i}: sat ${s.at[1]}, the grating at ${c.hatch.y}`);
        }
      }
    });
    expect(off).toEqual([]);
  });

  test('every way clear of her by a body’s breadth (the masts, rails, fife rails, capstan, hatches, the skids, the wheel and the binnacle), and of everyone at their stations', () => {
    const ways = c.ways as NonNullable<typeof c.ways>;
    const { PASS_SIDE, shipStation, standPoint } = shipRules;
    const stands: Vector3[] = [];
    kind.stations.forEach((s, i) => {
      if (i === 0) {
        return;
      }
      for (const weather of [1, -1]) {
        const sp = shipStation(s, weather, { at: new Vector3(), facing: 0, side: 1 });
        stands.push(standPoint(s, sp, new Vector3()));
      }
    });
    const bad: string[] = [];
    let least = Number.POSITIVE_INFINITY;
    // The ladders' ends, where a walker stands at its foot or head and is gone up or down it.
    const ladders = ways.edges
      .filter((e) => e[2] === 1)
      .flatMap(([a, b]) => [ways.nodes[a] as Vector3, ways.nodes[b] as Vector3]);
    for (const [a, b, kindOf] of ways.edges) {
      if (kindOf !== 0) {
        continue;
      }
      const pa = ways.nodes[a] as Vector3;
      const pb = ways.nodes[b] as Vector3;
      const l = Math.hypot(pa.x - pb.x, pa.z - pb.z);
      const side =
        Math.abs(pb.z - pa.z) > 2 * Math.abs(pb.x - pa.x) &&
        Math.abs(pa.x) > 1 &&
        Math.abs(pb.x) > 1;
      for (const off of side ? [-PASS_SIDE, 0, PASS_SIDE] : [0]) {
        for (let k = 0; k <= Math.ceil(l / 0.1); k++) {
          const p = pa.clone().lerp(pb, k / Math.ceil(l / 0.1));
          p.x += off;
          if (
            ladders.some(
              (q) => Math.hypot(q.x - p.x, q.z - p.z) < 0.35 && Math.abs(q.y - p.y) < 0.2,
            )
          ) {
            continue;
          }
          // A body: a column from the shins to the head, a person's breadth.
          for (const h of [0.3, 0.9, 1.5, 1.75]) {
            const q = p.clone();
            q.y += h;
            const n = near(q, 0.5);
            least = Math.min(least, n.d);
            if (n.d < 0.22) {
              bad.push(
                `${a}–${b} at ${p.x.toFixed(2)}, ${p.z.toFixed(2)}, ${h} up: ${n.what} ${n.d.toFixed(2)} m`,
              );
            }
          }
          for (const s of stands) {
            if (Math.abs(s.y - p.y) < 1 && Math.hypot(s.x - p.x, s.z - p.z) < 0.45) {
              bad.push(
                `${a}–${b} at ${p.x.toFixed(2)}, ${p.z.toFixed(2)}: a station's person at ${s.x.toFixed(2)}, ${s.z.toFixed(2)}`,
              );
            }
          }
        }
      }
    }
    expect([...new Set(bad)].slice(0, 20)).toEqual([]);
    process.stdout.write(`the ways: nearest her ${least.toFixed(3)} m\n`);
  });

  test.each(shipLooks.map((l) => [l.name, l] as const))(
    '%s: every station’s idles, on either side, nothing through her',
    async (_, { look, machine }) => {
      const { CrewBody } = await import('./crewbody');
      const { poseShip } = await import('./shippose');
      const { IDLES } = shipRules;
      const bad: string[] = [];
      let least = Number.POSITIVE_INFINITY;
      for (const yards of [0.4, -0.4]) {
        const rules = makeRules();
        rules.set(
          { people: Array.from({ length: 40 }, (_, seat) => ({ seat, look: 0 })), holder: 0 },
          false,
        );
        rules.step({
          dt: 1 / 30,
          boom: 0,
          windOffBow: 0,
          depth: 0,
          ship: { yards, heel: 0, wind: 5, time: 0 },
        });
        for (const m of rules.members) {
          const s = kind.stations[m.station] as (typeof kind.stations)[number];
          const set =
            s.pose === 'standing'
              ? IDLES.standing
              : (IDLES[s.pose as keyof typeof IDLES] ?? IDLES.standing);
          const body = new CrewBody(look.deck as NonNullable<typeof look.deck>, 7, machine);
          for (let k = 0; k < set.length; k++) {
            // Each idle in turn, by the time it comes up for this seat; a few moments into it.
            let world = 0;
            const { idleAt } = shipRules;
            const id = { now: 0, was: 0, f: 0 };
            for (
              let t = 0;
              t < 4000 && !(idleAt(m.seat, t, set.length, id).now === k && id.f >= 1);
              t += 1
            ) {
              world = t + 1;
            }
            for (const dt of [0, 1.3, 2.9]) {
              const input = await shipInput(rules, look, world + dt);
              m.ship.company = true;
              if (!poseShip(body, m, input)) {
                continue;
              }
              const clip = input.a.clip?.name ?? '';
              for (const [p0, p1, r, part] of capsulesNamed(body)) {
                // Hands and forearms rest on the rail leaning; in the top a hand holds a shroud.
                if (
                  (clip === 'leaning' || clip.startsWith('aloft')) &&
                  /hand|lowerarm/.test(part)
                ) {
                  continue;
                }
                for (let j = 0; j <= 4; j++) {
                  const q = p0.clone().lerp(p1, j / 4);
                  const n = near(q, 0.5);
                  least = Math.min(least, n.d - r);
                  if (n.d < r * 0.7) {
                    bad.push(
                      `${m.station} ${clip}: ${part} through ${n.what} (${(n.d - r).toFixed(3)})`,
                    );
                    break;
                  }
                }
              }
            }
          }
        }
      }
      process.stdout.write(`${_}: nearest her ${least.toFixed(3)} m beyond the radii\n`);
      expect([...new Set(bad)].slice(0, 20)).toEqual([]);
    },
    120_000,
  );

  test('standing, kept plumb as she heels: upright at 0° and 10°, leaning with her past 12°, the feet where they were', async () => {
    const { CrewBody } = await import('./crewbody');
    const { poseShip, plumbOf } = await import('./shippose');
    const { look, machine } = shipLooks[0] as (typeof shipLooks)[number];
    const rules = makeRules();
    rules.set(
      { people: Array.from({ length: 12 }, (_, seat) => ({ seat, look: 0 })), holder: 0 },
      false,
    );
    rules.step({
      dt: 1 / 30,
      boom: 0,
      windOffBow: 0,
      depth: 0,
      ship: { yards: 0.4, heel: 0, wind: 5, time: 0 },
    });
    const m = rules.members.find((x) => x.station === 8) as ShipMember;
    const lean = (heel: number) => {
      const model = new Matrix4().makeRotationZ(-heel * DEG);
      const up = plumbOf(model, new Vector3());
      const body = new CrewBody(look.deck as NonNullable<typeof look.deck>, 7, machine);
      return shipInput(rules, look, 3, up).then((input) => {
        input.life.plumb = null;
        poseShip(body, m, input);
        // The figure's own up, in the world, and its feet in the model.
        const figureUp = new Vector3(0, 1, 0)
          .transformDirection(body.root)
          .transformDirection(model);
        const foot = body.rig
          .position(body.rig.bone('foot_l'), new Vector3())
          .applyMatrix4(body.root);
        const hips = body.rig
          .position(body.rig.bone('pelvis'), new Vector3())
          .applyMatrix4(body.root);
        return { tilt: Math.acos(Math.min(1, figureUp.y)) / DEG, foot, hips };
      });
    };
    const flat = await lean(0);
    const ten = await lean(10);
    const twenty = await lean(20);
    expect(flat.tilt).toBeLessThan(0.5);
    expect(ten.tilt).toBeLessThan(0.5);
    expect(twenty.tilt).toBeCloseTo(8, 0);
    expect(ten.foot.distanceTo(flat.foot)).toBeLessThan(0.01);
    expect(twenty.foot.distanceTo(flat.foot)).toBeLessThan(0.01);
    // No jump as she comes through upright.
    const little = await lean(0.2);
    expect(little.tilt).toBeLessThan(0.5);
    expect(little.hips.distanceTo(flat.hips)).toBeLessThan(0.01);
  });

  test('two clients at the same moment pose everyone alike', async () => {
    const { CrewBody } = await import('./crewbody');
    const { poseShip } = await import('./shippose');
    const { look, machine } = shipLooks[1] as (typeof shipLooks)[number];
    const pose = async () => {
      const rules = makeRules();
      rules.set(
        { people: Array.from({ length: 40 }, (_, seat) => ({ seat, look: 0 })), holder: 0 },
        false,
      );
      rules.step({
        dt: 1 / 30,
        boom: 0,
        windOffBow: 0,
        depth: 0,
        ship: { yards: 0.4, heel: 0, wind: 5, time: 523.4 },
      });
      const out: number[][] = [];
      for (const m of rules.members) {
        const body = new CrewBody(
          look.deck as NonNullable<typeof look.deck>,
          1 + m.seat * 977,
          machine,
        );
        poseShip(body, m, await shipInput(rules, look, 523.4));
        out.push(Array.from(body.bones));
      }
      return out;
    };
    expect(await pose()).toEqual(await pose());
  });
});

describe('all hands aboard the tall ship', () => {
  const { near, rules: makeRules, company: c } = ship;

  /** Her company at forty, the yards braced as given, a moment on. */
  const forty = (yards = 0.4) => {
    const rules = makeRules();
    rules.set(
      { people: Array.from({ length: 40 }, (_, seat) => ({ seat, look: 0 })), holder: 0 },
      false,
    );
    rules.step({
      dt: 1 / 30,
      boom: 0,
      windOffBow: 0,
      depth: 0,
      ship: { yards, foreYards: yards, reef: 0, heel: 0, wind: 5, time: 0 },
    });
    return rules;
  };
  const input = async (rules: ReturnType<typeof forty>, look: FleetLook, world: number) => {
    const { stance } = await import('./crewbody');
    return {
      rules,
      clips: look.clips as Map<string, Clip>,
      machine: look.machine,
      time: world,
      world,
      life: { dt: 1 / 30, heel: 0, upright: 0, still: false, plumb: null },
      up: new Vector3(0, 1, 0),
      a: stance(),
      b: stance(),
    };
  };
  /** A member put to work at a place: at it, hauling (pull 1) or out on a yard. */
  const atWork = (m: ShipMember, work: ShipMember['ship']['work']): void => {
    m.ship.route = null;
    m.ship.to = shipRules.WORK;
    m.ship.work = work;
  };

  test.each(shipLooks.map((l) => [l.name, l] as const))(
    '%s: hauling at every place on every brace, either side, through the haul: nothing through her, the hands on the fall, and nobody through the one before them',
    async (_, { look, machine }) => {
      const { CrewBody } = await import('./crewbody');
      const { poseShip } = await import('./shippose');
      const { haulPlaces } = await import('./shipwork');
      const rules = forty();
      const m = rules.members[10] as ShipMember;
      const bad: string[] = [];
      let least = Number.POSITIVE_INFINITY;
      let off = 0;
      let apartLeast = Number.POSITIVE_INFINITY;
      for (const group of ['after', 'fore'] as const) {
        for (const side of [1, -1]) {
          const places = haulPlaces(c, group, side);
          for (const t of [0.4, 1.5, 2.9, 3.8]) {
            let before: { brace: number; caps: ReturnType<typeof capsulesOf> } | null = null;
            for (const q of places) {
              const body = new CrewBody(look.deck as NonNullable<typeof look.deck>, 7, machine);
              atWork(m, {
                kind: 'haul',
                haul: q,
                pull: 1,
                yard: null,
                foot: q.feet,
                climb: 0,
                phase: 'at',
              });
              const inp = await input(rules, look, t);
              expect(poseShip(body, m, inp)).toBe(true);
              const clip = inp.a.clip?.name ?? '';
              expect(clip, `${q.brace} ${q.k}`).toBe(
                machine ? 'standing-idle' : side * Math.cos(q.yaw) > 0 ? 'haul' : 'haul-port',
              );
              const caps = capsulesOf(body);
              for (const [p0, p1, r] of caps) {
                for (let j = 0; j <= 4; j++) {
                  const at = p0.clone().lerp(p1, j / 4);
                  const n = near(at, 0.5);
                  least = Math.min(least, n.d - r);
                  if (n.d < r * 0.7) {
                    bad.push(`${group} ${side} ${q.brace}/${q.k}: through ${n.what}`);
                  }
                }
              }
              if (!machine) {
                // The hands on the fall: each within reach of the line through the places.
                const rig = body.rig;
                for (const hand of ['hand_l', 'hand_r']) {
                  const h = rig.position(rig.bone(hand), new Vector3()).applyMatrix4(body.root);
                  const d = Math.hypot(h.x - q.hands.x, h.y - q.hands.y - 0.0, h.z - q.hands.z);
                  off = Math.max(off, Math.abs(h.y - q.hands.y));
                  expect(d, `${hand} ${q.brace}/${q.k}`).toBeLessThan(0.75);
                }
              }
              if (before !== null && before.brace === q.brace) {
                apartLeast = Math.min(apartLeast, apart(before.caps, caps));
              }
              before = { brace: q.brace, caps };
            }
          }
        }
      }
      process.stdout.write(
        `${_} hauling: nearest her ${least.toFixed(3)} m beyond the radii; hands ${off.toFixed(3)} m off the fall's height at most; neighbours ${apartLeast.toFixed(3)} m apart\n`,
      );
      expect([...new Set(bad)].slice(0, 20)).toEqual([]);
      expect(apartLeast).toBeGreaterThan(0);
    },
    120_000,
  );

  test('on a yard: out along it, the belly over it, the feet on its footrope; turned with the braces and lowered with the reef, they go with it', async () => {
    const { CrewBody } = await import('./crewbody');
    const { poseShip } = await import('./shippose');
    const { yardFrame, yardPlaces } = await import('./shipwork');
    const { look, machine } = shipLooks[0] as (typeof shipLooks)[number];
    const rules = forty();
    const m = rules.members[10] as ShipMember;
    const yi = c.yards.findIndex((y) => y.name === 'main-topsail');
    const y = c.yards[yi] as (typeof c.yards)[number];
    for (const place of yardPlaces(c, yi)) {
      const local: Vector3[] = [];
      for (const [turn, reef] of [
        [0, 1],
        [0.5, 1],
        [-0.6, 1.5],
        [0.3, 2],
      ] as const) {
        rules.turns.after = turn;
        rules.reef = reef;
        atWork(m, {
          kind: 'aloft',
          haul: null,
          pull: 0,
          yard: place,
          foot: new Vector3(),
          climb: 0,
          phase: 'at',
        });
        const body = new CrewBody(look.deck as NonNullable<typeof look.deck>, 7, machine);
        expect(poseShip(body, m, await input(rules, look, 2))).toBe(true);
        expect(body.root).toBeDefined();
        // The hips in the yard's own frame: the same however it is turned or lowered.
        const hips = body.rig
          .position(body.rig.bone('pelvis'), new Vector3())
          .applyMatrix4(body.root)
          .applyMatrix4(yardFrame(y, turn, reef, new Matrix4()).invert());
        local.push(hips);
        // Out at its place along the yard, aft of it and over it.
        expect(hips.x).toBeCloseTo(place.x, 0);
        expect(hips.z).toBeGreaterThan(0.2);
        expect(hips.y).toBeGreaterThan(0);
      }
      for (const p of local) {
        expect(p.distanceTo(local[0] as Vector3)).toBeLessThan(1e-4);
      }
    }
  });
});

/** The capsules of a posed body, by the bone each starts at. */
function capsulesNamed(body: CrewBody): [Vector3, Vector3, number, string][] {
  const caps = capsulesOf(body);
  return caps.map((c, i) => [c[0], c[1], c[2], CAPSULES[i]?.[0] ?? 'head']);
}

/** Her decks' height under (x, z), as her model has them. */
function modelDeckOf(s: {
  kind: { art: { model: string } };
}): (x: number, z: number) => number | null {
  return deckBy.get(s.kind.art.model) as (x: number, z: number) => number | null;
}
const deckBy = new Map<string, (x: number, z: number) => number | null>();
{
  const m = await load((tallShip as NonNullable<typeof tallShip>).art.model);
  const { modelDeck } = await import('./crew');
  deckBy.set((tallShip as NonNullable<typeof tallShip>).art.model, modelDeck(m.scene));
}
const shipRules = await import('./shiprules');
