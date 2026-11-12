// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { Matrix4, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { catalog } from '../../catalog';
import {
  inYachtFile,
  namesYachtClips,
  YACHT_CLIPS,
  YACHT_FILE,
  yachtAnchor,
  yachtClips,
  yachtPlace,
  yachtPlaces,
  yachtSide,
} from './yacht';

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

describe('the cruising yacht’s clips', () => {
  test('are a file of their own beside a look’s clips', () => {
    expect(yachtClips('sailors/rover/female.clips.glb')).toBe('sailors/rover/female.cruiser.glb');
  });

  test('only a kind whose art names them loads them: the boat of two wheels', () => {
    const named = catalog.boats.filter((b) => namesYachtClips(b.art));
    expect(named).toHaveLength(1);
    const kind = named[0];
    expect(kind).toBeDefined();
    if (kind === undefined) {
      return;
    }
    const places = yachtPlaces(nodesOf(kind.art.model));
    expect(places).not.toBeNull();
  });

  test('those at the wheel, braced on the bench and on the rail have their -port mirrors; the bench’s idles and the crossings have none', () => {
    for (const c of [
      YACHT_CLIPS.wheel,
      YACHT_CLIPS.seated,
      YACHT_CLIPS.braced,
      YACHT_CLIPS.rail,
      YACHT_CLIPS.railOut,
    ]) {
      expect(inYachtFile(c)).toBe(true);
      expect(inYachtFile(`${c}-port`)).toBe(true);
      expect(yachtSide(`${c}-port`)).toBe(-1);
      expect(yachtAnchor(`${c}-port`)).toBe(yachtAnchor(c));
    }
    for (const c of [
      YACHT_CLIPS.habit,
      ...YACHT_CLIPS.bench,
      ...YACHT_CLIPS.cockpit,
      YACHT_CLIPS.roof,
    ]) {
      expect(inYachtFile(c)).toBe(true);
      expect(inYachtFile(`${c}-port`)).toBe(false);
    }
    // The ship's and the dinghy's are not hers.
    for (const c of ['helm-wheel', 'habit-wheel', 'hatch-sit', 'rail', 'crouch-walk']) {
      expect(inYachtFile(c)).toBe(false);
    }
    expect(YACHT_FILE).toHaveLength(18);
  });

  test('each from its place: the wheel’s at the stance, the bench’s at its edge, the rail’s at the deck’s edge, the crossings on her centreline', () => {
    expect(yachtAnchor(YACHT_CLIPS.wheel)).toBe('stance');
    expect(yachtAnchor(YACHT_CLIPS.seated)).toBe('stance');
    expect(yachtAnchor(YACHT_CLIPS.habit)).toBe('stance');
    for (const c of [...YACHT_CLIPS.bench, YACHT_CLIPS.braced]) {
      expect(yachtAnchor(c)).toBe('bench');
    }
    expect(yachtAnchor(YACHT_CLIPS.rail)).toBe('rail');
    expect(yachtAnchor(YACHT_CLIPS.railOut)).toBe('rail');
    for (const c of YACHT_CLIPS.cockpit) {
      expect(yachtAnchor(c)).toBe('sole');
    }
    expect(yachtAnchor(YACHT_CLIPS.roof)).toBe('roof');
    expect(yachtAnchor('cat-helm')).toBeNull();
  });

  test('her places read from her model: the stance aft of the starboard wheel, the bench’s front edge on its top', () => {
    const kind = catalog.boats.find((b) => namesYachtClips(b.art));
    if (kind === undefined) {
      throw new Error('no kind names the yacht’s clips');
    }
    const nodes = nodesOf(kind.art.model);
    const places = yachtPlaces(nodes);
    if (places === null) {
      throw new Error('no places');
    }
    const sailor = nodes('sailor')?.at ?? new Vector3();
    const wheel = nodes('wheel');
    const spread = (wheel?.data as { wheel?: { spread?: number } } | undefined)?.wheel?.spread ?? 0;
    // Out from the stance between the wheels to the starboard one's, on
    // the sole, aft of its hub.
    expect(places.stance.x).toBeCloseTo(sailor.x + spread, 6);
    expect(places.stance.y).toBeCloseTo(sailor.y, 6);
    expect(places.stance.z).toBeGreaterThan(wheel?.at.z ?? Number.POSITIVE_INFINITY);
    // The bench to starboard, its top over the sole, inboard of the
    // stance's side (the cockpit's sides).
    expect(places.bench.x).toBeGreaterThan(0);
    expect(places.bench.y).toBeGreaterThan(sailor.y + 0.3);
    expect(places.bench.z).toBeLessThan(places.stance.z);
    // A kind without them has none.
    const other = catalog.boats.find((b) => !namesYachtClips(b.art));
    expect(other).toBeDefined();
    if (other !== undefined) {
      expect(yachtPlaces(nodesOf(other.art.model))).toBeNull();
    }
  });

  test('a place on the port side is the starboard’s mirror; a clip without a -port is turned about her middle', () => {
    const at = new Vector3(1, 0.33, 4.3);
    const place = new Matrix4().makeTranslation(0.1, 0.2, 0.3);
    const p = new Vector3().setFromMatrixPosition(yachtPlace(place, at, -1));
    expect(p.x).toBeCloseTo(-1 + 0.1, 6);
    expect(p.z).toBeCloseTo(4.3 + 0.3, 6);
    const q = new Vector3().setFromMatrixPosition(yachtPlace(place, at, -1, true));
    // Turned about the vertical: the clip's own offset reversed.
    expect(q.x).toBeCloseTo(-1 - 0.1, 6);
    expect(q.z).toBeCloseTo(4.3 - 0.3, 6);
    expect(q.y).toBeCloseTo(0.33 + 0.2, 6);
  });
});
