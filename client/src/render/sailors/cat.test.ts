// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { Matrix4, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { catalog } from '../../catalog';
import {
  aboardData,
  CAT_CLIPS,
  catAnchor,
  catClips,
  catPlace,
  catPoint,
  catSide,
  inCatFile,
  namesCatClips,
} from './cat';

/** The model's `aboard` node's data, as the beach cat's model has it. */
function aboardOf(path: string): unknown {
  const glb = readFileSync(new URL(`../../../../art/${path}`, import.meta.url));
  const length = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + length).toString('utf8')) as {
    nodes: { name?: string; extras?: unknown }[];
  };
  return gltf.nodes.find((n) => n.name === 'aboard')?.extras;
}

describe('the beach cat’s clips', () => {
  test('are a file of their own beside a look’s clips', () => {
    expect(catClips('sailors/rover/female.clips.glb')).toBe('sailors/rover/female.cat.glb');
  });

  test('only a kind whose art names them loads them: the boat of two hulls', () => {
    const named = catalog.boats.filter((b) => namesCatClips(b.art));
    expect(named).toHaveLength(1);
    expect(named[0]?.physics.hulls?.hullSpacing ?? 0).toBeGreaterThan(0);
  });

  test('those on the hull and the wire have their -port mirrors; the crossings and the righting have none', () => {
    for (const c of [
      CAT_CLIPS.helm,
      CAT_CLIPS.hike,
      CAT_CLIPS.crew,
      CAT_CLIPS.crewWire,
      CAT_CLIPS.wire,
    ]) {
      expect(inCatFile(c)).toBe(true);
      expect(inCatFile(`${c}-port`)).toBe(true);
      expect(catSide(`${c}-port`)).toBe(-1);
      expect(catAnchor(`${c}-port`)).toBe(catAnchor(c));
    }
    for (const c of [CAT_CLIPS.righting, ...CAT_CLIPS.crouch, ...CAT_CLIPS.crawl]) {
      expect(inCatFile(c)).toBe(true);
      expect(inCatFile(`${c}-port`)).toBe(false);
    }
    expect(inCatFile('helm')).toBe(false);
    expect(inCatFile('trapeze')).toBe(false);
  });

  test('each is placed from its station’s deck edge, the net’s middle, or where she is righted from', () => {
    expect(catAnchor(CAT_CLIPS.helm)).toBe('helm-inner');
    expect(catAnchor(CAT_CLIPS.hike)).toBe('helm-outer');
    expect(catAnchor(CAT_CLIPS.wireLow)).toBe('helm-outer');
    expect(catAnchor(CAT_CLIPS.crew)).toBe('crew-inner');
    expect(catAnchor(CAT_CLIPS.crewWire)).toBe('crew-outer');
    expect(catAnchor('net-crawl-left')).toBe('net');
    expect(catAnchor(CAT_CLIPS.righting)).toBe('stand');
    expect(catAnchor('haul')).toBeNull();
  });

  test('her model’s places read, and a clip placed at them on either side', () => {
    const cat = catalog.boats.find((b) => namesCatClips(b.art));
    const a = aboardData(aboardOf(cat?.art.model ?? ''));
    expect(a).not.toBeNull();
    if (a === null) {
      return;
    }
    const net = catPoint(a, 'net');
    expect(net?.x).toBe(0);
    expect(net?.y).toBe(a.net.y);
    expect(catPoint(a, 'stand')).toBeNull();
    const inner = catPoint(a, 'helm-inner') ?? new Vector3();
    const place = new Matrix4().makeTranslation(0.1, 0.2, 0.3);
    const p = new Vector3().setFromMatrixPosition(catPlace(place, inner, -1));
    expect(p.x).toBeCloseTo(-inner.x + 0.1, 6);
    expect(p.y).toBeCloseTo(inner.y + 0.2, 6);
    expect(aboardData({ helm: {} })).toBeNull();
  });
});
