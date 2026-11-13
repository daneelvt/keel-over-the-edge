// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { Matrix4, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { catalog } from '../../catalog';
import {
  BRIDGE_CLIPS,
  BRIDGE_FILE,
  bridgeAnchor,
  bridgeClips,
  bridgePlace,
  bridgePlaces,
  bridgeSide,
  inBridgeFile,
  namesBridgeClips,
} from './bridgedeck';

/** A model's nodes, by name: each one's place (its translation, the model's nodes being children of its root) and its data. */
function nodesOf(path: string): (name: string) => { at: Vector3; data: unknown } | null {
  const glb = readFileSync(new URL(`../../../../art/${path}`, import.meta.url));
  const length = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + length).toString('utf8')) as {
    nodes: { name?: string; extras?: unknown; translation?: number[] }[];
  };
  return (name) => {
    const n = gltf.nodes.find((x) => x.name === name);
    const t = n?.translation ?? [0, 0, 0];
    return n === undefined
      ? null
      : { at: new Vector3(t[0] ?? 0, t[1] ?? 0, t[2] ?? 0), data: n.extras };
  };
}

/** The kind whose art names the catamaran's clips. */
function theKind(): (typeof catalog.boats)[number] {
  const named = catalog.boats.filter((b) => namesBridgeClips(b.art));
  expect(named).toHaveLength(1);
  const kind = named[0];
  if (kind === undefined) {
    throw new Error('no kind names the catamaran’s clips');
  }
  return kind;
}

describe('the cruising catamaran’s clips', () => {
  test('are a file of their own beside a look’s clips', () => {
    expect(bridgeClips('sailors/rover/female.clips.glb')).toBe(
      'sailors/rover/female.bridgedeck.glb',
    );
  });

  test('only one kind’s art names them, and her model has their places', () => {
    const kind = theKind();
    expect(bridgePlaces(nodesOf(kind.art.model))).not.toBeNull();
    const other = catalog.boats.find((b) => !namesBridgeClips(b.art));
    expect(other).toBeDefined();
    if (other !== undefined) {
      expect(bridgePlaces(nodesOf(other.art.model))).toBeNull();
    }
  });

  test('those at the wheel and the braced have their -port mirrors; the idles, the walk, the turns and the ladder none', () => {
    for (const c of [
      BRIDGE_CLIPS.wheel,
      BRIDGE_CLIPS.seated,
      BRIDGE_CLIPS.tableBraced,
      BRIDGE_CLIPS.beamBraced,
    ]) {
      expect(inBridgeFile(c)).toBe(true);
      expect(inBridgeFile(`${c}-port`)).toBe(true);
      expect(bridgeSide(`${c}-port`)).toBe(-1);
      expect(bridgeAnchor(`${c}-port`)).toBe(bridgeAnchor(c));
    }
    for (const c of [
      BRIDGE_CLIPS.habit,
      ...BRIDGE_CLIPS.helmSeat,
      ...BRIDGE_CLIPS.table,
      ...BRIDGE_CLIPS.beam,
      ...BRIDGE_CLIPS.lounger,
      BRIDGE_CLIPS.walk,
      BRIDGE_CLIPS.turnLeft,
      BRIDGE_CLIPS.turnRight,
      BRIDGE_CLIPS.up,
      BRIDGE_CLIPS.down,
    ]) {
      expect(inBridgeFile(c)).toBe(true);
      expect(inBridgeFile(`${c}-port`)).toBe(false);
      expect(bridgeSide(c)).toBe(1);
    }
    // The other boats' are not hers.
    for (const c of ['helm-wheel', 'yacht-wheel', 'bench', 'hatch-sit', 'walk', 'cat-helm']) {
      expect(inBridgeFile(c)).toBe(false);
    }
    expect(BRIDGE_FILE).toHaveLength(30);
  });

  test('each from its place: the wheel’s at the stance, the seats’ at their edges, the walk on the sole, the ladder at its foot and its landing', () => {
    expect(bridgeAnchor(BRIDGE_CLIPS.wheel)).toBe('stance');
    expect(bridgeAnchor(BRIDGE_CLIPS.habit)).toBe('stance');
    expect(bridgeAnchor(BRIDGE_CLIPS.seated)).toBe('stance');
    for (const c of BRIDGE_CLIPS.helmSeat) {
      expect(bridgeAnchor(c)).toBe('helm');
    }
    for (const c of [...BRIDGE_CLIPS.table, BRIDGE_CLIPS.tableBraced]) {
      expect(bridgeAnchor(c)).toBe('table');
    }
    for (const c of [...BRIDGE_CLIPS.beam, BRIDGE_CLIPS.beamBraced]) {
      expect(bridgeAnchor(c)).toBe('beam');
    }
    for (const c of BRIDGE_CLIPS.lounger) {
      expect(bridgeAnchor(c)).toBe('lounger');
    }
    expect(bridgeAnchor(BRIDGE_CLIPS.walk)).toBe('sole');
    expect(bridgeAnchor(BRIDGE_CLIPS.up)).toBe('foot');
    expect(bridgeAnchor(BRIDGE_CLIPS.down)).toBe('landing');
    expect(bridgeAnchor('yacht-wheel')).toBeNull();
  });

  test('her places read from her model: the stance at her wheel, each seat’s edge at a station of hers facing as it faces, the ladder climbed forward and come down aft', () => {
    const kind = theKind();
    const nodes = nodesOf(kind.art.model);
    const places = bridgePlaces(nodes);
    if (places === null) {
      throw new Error('no places');
    }
    expect(places.stance.at.distanceTo(nodes('sailor')?.at ?? new Vector3())).toBeLessThan(1e-6);
    expect(places.stance.facing).toBe(0);
    // Each seat's place is at the front edge of a station of hers on it
    // (the station a little in from the edge, on its top), facing as she
    // has it face.
    for (const key of ['helm', 'table', 'beam', 'lounger'] as const) {
      const p = places[key];
      const near = kind.stations.filter((s) => {
        const [x, y, z] = s.at;
        return (
          s.facing === p.facing &&
          Math.abs((y ?? 0) - p.at.y) < 0.01 &&
          Math.hypot((x ?? 0) - p.at.x, (z ?? 0) - p.at.z) < 0.06
        );
      });
      expect(near.length, key).toBe(1);
    }
    // The ladder rises forward from its foot, on the sole, to its landing.
    expect(places.landing.at.z).toBeLessThan(places.foot.at.z - 1);
    expect(places.landing.at.y).toBeGreaterThan(places.foot.at.y + 0.9);
    expect(places.foot.facing).toBe(0);
    expect(places.landing.facing).toBe(180);
    // The sole where it is walked, under her seats' tops.
    expect(places.sole.at.y).toBeCloseTo(places.foot.at.y, 6);
    expect(places.table.at.y).toBeGreaterThan(places.sole.at.y + 0.4);
  });

  test('a clip is placed at its place, turned the way the place faces', () => {
    const at = new Vector3(1, 0.5, 3);
    const place = new Matrix4().makeTranslation(0.1, 0.2, 0.3);
    // Facing ahead: as it is.
    const a = new Vector3().setFromMatrixPosition(bridgePlace(place, { at, facing: 0 }));
    expect(a.x).toBeCloseTo(1.1, 6);
    expect(a.y).toBeCloseTo(0.7, 6);
    expect(a.z).toBeCloseTo(3.3, 6);
    // Facing to port: the place's ahead (−z) to port (−x), its aft (+z) to
    // starboard.
    const m = bridgePlace(place, { at, facing: 270 });
    const p = new Vector3().setFromMatrixPosition(m);
    expect(p.x).toBeCloseTo(1 + 0.3, 6);
    expect(p.z).toBeCloseTo(3 - 0.1, 6);
    const ahead = new Vector3(0, 0, -1).transformDirection(m);
    expect(ahead.x).toBeCloseTo(-1, 6);
  });
});
