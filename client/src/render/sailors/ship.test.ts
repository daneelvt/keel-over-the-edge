// SPDX-License-Identifier: AGPL-3.0-only

import { Matrix4, Object3D, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import {
  aloftClips,
  company,
  inAloftFile,
  inShipFile,
  shipAnchor,
  shipClips,
  shipPlace,
  shipPoint,
  shipSide,
} from './ship';

describe('the ship’s company’s clips', () => {
  test('their files sit beside a look’s clips', () => {
    expect(shipClips('sailors/rover/female.clips.glb')).toBe('sailors/rover/female.ship.glb');
    expect(aloftClips('sailors/rover/female.clips.glb')).toBe('sailors/rover/female.aloft.glb');
  });

  test('each clip is in one file, with its place on the ship', () => {
    for (const c of ['look-about', 'fold-arms', 'talking', 'walk']) {
      expect(inShipFile(c)).toBe(true);
      expect(shipAnchor(c)).toBeNull();
    }
    expect(shipAnchor('leaning')).toBe('rail');
    expect(shipAnchor('hatch-nod')).toBe('hatch');
    for (const c of ['haul', 'haul-port', 'aloft', 'aloft-port', 'yard', 'yard-port']) {
      expect(inAloftFile(c)).toBe(true);
      expect(inShipFile(c)).toBe(false);
    }
    expect(shipAnchor('yard-port')).toBe('yard');
    expect(shipSide('haul-port')).toBe(-1);
    expect(shipSide('haul')).toBe(1);
  });

  test('a place on the port side is the starboard one’s mirror, the figure unmirrored', () => {
    const place = new Matrix4().makeRotationY(Math.PI / 2).setPosition(0.1, 0.2, 0.3);
    const at = new Vector3(3, 5, 7);
    const star = shipPlace(place, at, 1);
    const port = shipPlace(place, at, -1, true);
    const p = new Vector3(0.2, 1, 0.4);
    const s = p.clone().applyMatrix4(star);
    const q = p
      .clone()
      .multiply(new Vector3(-1, 1, 1))
      .applyMatrix4(port);
    expect(q.x).toBeCloseTo(-s.x, 6);
    expect(q.y).toBeCloseTo(s.y, 6);
    expect(q.z).toBeCloseTo(s.z, 6);
    // A rigid move: no mirror in the figure.
    expect(port.determinant()).toBeCloseTo(1, 6);
    // A -port clip's place is only moved to the port side's point.
    expect(new Vector3().setFromMatrixPosition(shipPlace(new Matrix4(), at, -1)).x).toBe(-3);
  });

  test('her company’s places are read from her model’s node', () => {
    const node = new Object3D();
    node.userData = {
      rail: [3.9, 5.6, 7.6],
      hatch: { edge: [0, 3.6, -9.3], half: 0.9 },
      brace: { lead: [3.6, 5.7, 11], fall: [3.3, 5.7, 8.4] },
      top: { floor: [0, 13.4, -0.58] },
      yard: {
        node: 'main-topsail-yard',
        radius: 0.15,
        footrope: [
          [0.6, -0.25, 0.12],
          [2.2, -0.64, 0.12],
        ],
      },
    };
    const c = company(new Map([['company', node]]));
    expect(c?.rail.z).toBeCloseTo(7.6);
    expect(c?.yard.footrope[0]?.y).toBeCloseTo(-0.25);
    expect(company(new Map())).toBeNull();
    // The yard's point on its footrope's first length, in its node's frame.
    const yard = c === null ? null : shipPoint(c, 'yard');
    expect(yard?.node).toBe('main-topsail-yard');
    expect(yard?.at.y).toBe(0);
    // The hauler's on the fall, forward of the lead and over it.
    const brace = c === null ? null : shipPoint(c, 'brace');
    expect(brace?.at.z).toBeLessThan(11);
    expect(brace?.at.y).toBeCloseTo(5.8);
  });
});
