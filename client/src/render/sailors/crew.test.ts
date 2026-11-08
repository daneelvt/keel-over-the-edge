// SPDX-License-Identifier: AGPL-3.0-only

// The people aboard: who is drawn at which station (whoever holds the
// controls at the helm, the skipper at the holder's station); every kind's
// stations on its model's deck, the first where its sailor is at the helm,
// nothing of the hull where a person stands; and the figures posed from the
// committed files, standing on the station's point and seated on it, facing
// the way the station faces.

import { readFileSync } from 'node:fs';
import {
  type AnimationClip,
  Box3,
  DoubleSide,
  Matrix3,
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
import { crewPlaces, helmLook, poseDeck, poseFar } from './crew';
import { deckLook, FleetLook } from './fleetlooks';
import { placesOf } from './model';
import { boneNames } from './onboat';
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
    boat.stations.forEach((s, i) => {
      const [x, y, z] = s.at;
      ray.set(new Vector3(x, y + 1, z), new Vector3(0, -1, 0));
      const hit = ray.intersectObjects(hull, false)[0];
      if (hit === undefined || Math.abs(hit.point.y - y) > 0.01) {
        off.push(`${i}: the deck at ${hit?.point.y.toFixed(3) ?? 'none'}, not ${y}`);
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

/** A look as the fleet's looks hold it: its deck level, clips and far figure, seated as the fleet seats them. */
async function fleetLook(art: (typeof catalog.sailors)[number]['versions'][number]['art']) {
  const [deck, clipsFile, far, jolly] = await Promise.all([
    load(art.model),
    load(art.clips),
    load(art.far),
    load(catalog.boats[0]?.art.model as string),
  ]);
  jolly.scene.updateMatrixWorld(true);
  const g = (jolly.scene.getObjectByName('gunwale') as Object3D).getWorldPosition(new Vector3());
  const seat = { out: g.x, y: g.y, z: g.z };
  const rig = Rig.from(deck.scene, boneNames(deck.scene));
  const look = new FleetLook(0, art, false);
  look.deck = deckLook(meshesOf(deck.scene), rig, new Matrix3(), 0);
  const places = placesOf(clipsFile.scene);
  look.clips = new Map(
    clipsFile.animations.map((a) => [
      a.name,
      Clip.from(a, rig, places.get(`place-${a.name}`) ?? null),
    ]),
  );
  const farPlace = placesOf(far.scene).get('place') ?? null;
  look.far = seatFigure(far.scene, meshesOf(far.scene), farPlace, seat.out, seat.y, seat.z);
  return { look, seat };
}

/** A figure's corners' box, and the box of those lowest (its feet): place at 0, 1 and 2 of each 8. */
function bounds(f: Float32Array): { all: Box3; feet: Box3 } {
  const all = new Box3();
  const v = new Vector3();
  for (let o = 0; o < f.length; o += 8) {
    all.expandByPoint(v.set(f[o] as number, f[o + 1] as number, f[o + 2] as number));
  }
  const feet = new Box3();
  for (let o = 0; o < f.length; o += 8) {
    if ((f[o + 1] as number) < all.min.y + 0.08) {
      feet.expandByPoint(v.set(f[o] as number, f[o + 1] as number, f[o + 2] as number));
    }
  }
  return { all, feet };
}

describe.each([
  ['rover', 'female'],
  ['machine', 'male'],
])('%s %s, posed for a station', (name, version) => {
  const art =
    name === 'machine'
      ? catalog.machine.versions.find((v) => v.id === version)?.art
      : catalog.sailors.find((s) => s.id === name)?.versions.find((v) => v.id === version)?.art;

  test('standing, near and far: on the station’s point, upright, facing +z', async () => {
    const { look, seat } = await fleetLook(art as NonNullable<typeof art>);
    const boxes = [
      poseDeck(look, false, seat) as Float32Array,
      poseFar(look, false, seat) as Float32Array,
    ].map((f) => {
      expect(f.length % 24).toBe(0);
      const { all, feet } = bounds(f);
      // The soles on the deck, the head a person's height over it.
      expect(Math.abs(all.min.y)).toBeLessThan(0.05);
      expect(all.max.y).toBeGreaterThan(1.5);
      expect(all.max.y).toBeLessThan(2.1);
      // Over the point between the feet.
      expect(Math.abs((all.min.x + all.max.x) / 2)).toBeLessThan(0.25);
      expect(Math.abs((feet.min.z + feet.max.z) / 2)).toBeLessThan(0.2);
      // The toes ahead, +z, of the heels: the feet's box reaches further forward than back.
      expect(feet.max.z).toBeGreaterThan(-feet.min.z - 0.05);
      return all;
    });
    // The far figure stood up as the deck level stands: the same height and breadth, within a few cm.
    const [deck, far] = boxes as [Box3, Box3];
    expect(Math.abs(deck.max.y - far.max.y)).toBeLessThan(0.06);
    expect(Math.abs(deck.max.x - deck.min.x - (far.max.x - far.min.x))).toBeLessThan(0.1);
  });

  test('seated, near and far: on the seat at the station’s point, the legs reaching the way it faces, the feet below it', async () => {
    const { look, seat } = await fleetLook(art as NonNullable<typeof art>);
    for (const f of [
      poseDeck(look, true, seat) as Float32Array,
      poseFar(look, true, seat) as Float32Array,
    ]) {
      const { all, feet } = bounds(f);
      // The feet 0.1 to 0.35 m under the seat, some 0.4 to 0.9 m ahead of it.
      expect(all.min.y).toBeLessThan(-0.1);
      expect(all.min.y).toBeGreaterThan(-0.4);
      expect((feet.min.z + feet.max.z) / 2).toBeGreaterThan(0.35);
      expect((feet.min.z + feet.max.z) / 2).toBeLessThan(0.9);
      // The head over the seat, a seated person's height.
      expect(all.max.y).toBeGreaterThan(0.6);
      expect(all.max.y).toBeLessThan(1.2);
    }
  });
});
