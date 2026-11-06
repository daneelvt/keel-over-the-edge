// SPDX-License-Identifier: AGPL-3.0-only

// The machines' life over the clips, on a machine's skeleton read from its
// committed clips: no breath, glances in snapped steps with the ear discs
// ahead of the head, the lamps' pulse, each machine in its own rhythm.

import { readFileSync } from 'node:fs';
import { type Object3D, Quaternion, Vector3 } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, test } from 'vitest';
import { type LayerInput, Layers } from './layers';
import { GLANCE, MachineLayers, SNAP, STEP } from './machinelayers';
import { Rig } from './rig';

const ART = new URL('../../../../art/', import.meta.url);

async function rig(): Promise<Rig> {
  const buf = readFileSync(new URL('sailors/machine/female.clips.glb', ART));
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    '',
  );
  const out: string[] = [];
  (gltf.scene.getObjectByName('Root') as Object3D).traverse((o) => out.push(o.name));
  return Rig.from(gltf.scene, out);
}

const input = (time: number, still = false): LayerInput => ({
  dt: 1 / 30,
  time,
  effort: 0,
  heelAxis: new Vector3(0, 0, 1),
  heel: 0,
  upright: 0,
  still,
});

/** A bone's turn from its rest, radians, after the layers. */
function turned(r: Rig, name: string): number {
  const i = r.bone(name);
  const q = new Quaternion().fromArray(r.quat, 4 * i);
  const rest = new Quaternion().fromArray(r.restQuat, 4 * i);
  return q.angleTo(rest);
}

describe('a machine’s layers', () => {
  test('look about in steps: the head jumps a few degrees and holds', async () => {
    const r = await rig();
    const m = new MachineLayers(r, 7);
    const bearings: number[] = [];
    for (let k = 0; k < 30 * 60; k++) {
      r.reset();
      r.fk();
      m.apply(input(k / 30));
      bearings.push(m.bearing);
    }
    // Within its glance, never further.
    expect(Math.max(...bearings.map(Math.abs))).toBeLessThanOrEqual(GLANCE + 1e-6);
    // It moved; each move is quick and short; and most of the time it holds.
    const speeds = bearings.slice(1).map((b, k) => Math.abs(b - (bearings[k] as number)) * 30);
    const moving = speeds.filter((v) => v > 1e-4).length;
    expect(moving).toBeGreaterThan(10);
    expect(moving / speeds.length).toBeLessThan(0.25);
    // A step of at most STEP over SNAP seconds.
    expect(Math.max(...speeds)).toBeLessThanOrEqual((1.5 * STEP) / SNAP + 1e-6);
    expect(Math.max(...speeds)).toBeGreaterThan(STEP / (2 * SNAP));
  });

  test('turns its ear discs further than its head, and does not breathe', async () => {
    const r = await rig();
    const m = new MachineLayers(r, 3);
    let ears = 0;
    let head = 0;
    let chest = 0;
    for (let k = 0; k < 30 * 30; k++) {
      r.reset();
      r.fk();
      m.apply(input(k / 30));
      ears = Math.max(ears, turned(r, 'lid_lower_l'));
      head = Math.max(head, turned(r, 'head'));
      chest = Math.max(chest, turned(r, 'spine_03'));
    }
    expect(head).toBeGreaterThan(0);
    expect(ears).toBeGreaterThan(head);
    expect(chest).toBeLessThan(1e-3);
    // A person's layers breathe.
    const p = new Layers(r, 3);
    let breath = 0;
    for (let k = 0; k < 30 * 5; k++) {
      r.reset();
      r.fk();
      p.apply(input(k / 30));
      breath = Math.max(breath, turned(r, 'spine_03'));
    }
    expect(breath).toBeGreaterThan(5e-3);
  });

  test('pulses its lamps, each machine in its own rhythm; under reduced motion, steady', async () => {
    const r = await rig();
    const a = new MachineLayers(r, 1);
    const b = new MachineLayers(r, 2);
    const ga: number[] = [];
    const gb: number[] = [];
    for (let k = 0; k < 30 * 10; k++) {
      a.apply(input(k / 30));
      b.apply(input(k / 30));
      ga.push(a.glow);
      gb.push(b.glow);
    }
    for (const g of [...ga, ...gb]) {
      expect(g).toBeGreaterThanOrEqual(0.7);
      expect(g).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...ga) - Math.min(...ga)).toBeGreaterThan(0.2);
    expect(ga).not.toEqual(gb);
    a.apply(input(1, true));
    expect(a.glow).toBe(1);
  });

  test('is the same for the same seed', async () => {
    const r = await rig();
    const run = (): number[] => {
      const m = new MachineLayers(r, 11);
      const out: number[] = [];
      for (let k = 0; k < 600; k++) {
        m.apply(input(k / 30));
        out.push(m.bearing, m.glow);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});
