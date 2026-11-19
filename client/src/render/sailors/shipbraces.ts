// SPDX-License-Identifier: AGPL-3.0-only

// A ship's braces as they are drawn, on the ship in view (her own or a
// watched one; the fleet draws none): each from its yard's arm, which turns
// with the yards and comes down with a reefed topsail's yard, to its block
// and on to its pin, both sides; and the fall of a brace being hauled, from
// its pin through the hands of those on it to a little past the last, and
// down to the deck. Line segments a pixel wide, as her model's other ropes
// are at any distance she is sailed at, in one draw, written each frame
// under her model.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  LineSegments,
  Matrix4,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { lineMaterial } from '../materials';
import type { Company } from './ship';
import type { ShipRules } from './shiprules';
import { armOf, turnOf, yardFrame } from './shipwork';

/** Her ropes' colour (her model's, as sRGB). */
const ROPE = new Color().setRGB(0.2, 0.15, 0.1, SRGBColorSpace);
/** A fall runs on this far past its last hauler, m, and then down to the deck. */
const FALL_ON = 0.7;
const FALL_DECK = 0.04;

const frame = new Matrix4();
const arm = new Vector3();
const a = new Vector3();
const b = new Vector3();

/** A ship's braces, drawn. */
export class ShipBraces {
  readonly mesh: LineSegments;
  readonly #position: BufferAttribute;
  #count = 0;
  readonly #most: number;

  constructor(readonly company: Company) {
    // Each brace's two lines each side, and each fall through its places.
    this.#most = company.braces.reduce((n, br) => n + 2 * (2 + br.hands.length + 2), 0);
    const g = new BufferGeometry();
    this.#position = new BufferAttribute(new Float32Array(this.#most * 2 * 3), 3);
    this.#position.setUsage(DynamicDrawUsage);
    g.setAttribute('position', this.#position);
    const m = lineMaterial({ color: ROPE });
    m.name = 'braces';
    this.mesh = new LineSegments(g, m);
    this.mesh.name = 'braces';
    this.mesh.frustumCulled = false;
  }

  #line(p: Vector3, q: Vector3): void {
    if (this.#count >= this.#most) {
      return;
    }
    const k = 2 * this.#count++;
    this.#position.setXYZ(k, p.x, p.y, p.z);
    this.#position.setXYZ(k + 1, q.x, q.y, q.z);
  }

  /**
   * Each brace as her yards are now (their turns, the fore's and the
   * after's, and her reef); a fall drawn through its hands where someone
   * is at it, as her rules have her people (null for nobody).
   */
  update(turns: { fore: number; after: number }, reef: number, rules: ShipRules | null): void {
    this.#count = 0;
    const c = this.company;
    // The places hauled on now, by brace and side: the furthest out.
    const hauled = new Map<string, number>();
    for (const m of rules?.members ?? []) {
      const h = m.ship.work?.haul ?? null;
      if (h !== null && m.ship.work?.phase === 'at') {
        const key = `${h.brace} ${h.side}`;
        hauled.set(key, Math.max(hauled.get(key) ?? -1, h.k));
      }
    }
    c.braces.forEach((br, i) => {
      const y = c.yards[br.yard];
      if (y === undefined) {
        return;
      }
      yardFrame(y, turnOf(y, turns), reef, frame);
      for (const side of [1, -1]) {
        armOf(y, side, arm).applyMatrix4(frame);
        a.set(side * br.block.x, br.block.y, br.block.z);
        this.#line(arm, a);
        b.set(side * br.lead.x, br.lead.y, br.lead.z);
        this.#line(a, b);
        const last = hauled.get(`${i} ${side}`) ?? -1;
        if (last < 0) {
          continue;
        }
        // The fall: from the pin through each hauler's hands, on past the last and down to the deck.
        a.copy(b);
        for (let k = 0; k <= last; k++) {
          const h = br.hands[k] as Vector3;
          b.set(side * h.x, h.y, h.z);
          this.#line(a, b);
          a.copy(b);
        }
        const before = last > 0 ? (br.hands[last - 1] as Vector3) : br.lead;
        const h = br.hands[last] as Vector3;
        const dx = h.x - before.x;
        const dz = h.z - before.z;
        const l = Math.hypot(dx, dz) || 1;
        b.set(side * (h.x + (dx / l) * FALL_ON), h.y, h.z + (dz / l) * FALL_ON);
        this.#line(a, b);
        a.copy(b);
        b.y = h.y - br.over + FALL_DECK;
        b.x += side * (dx / l) * 0.3;
        b.z += (dz / l) * 0.3;
        this.#line(a, b);
      }
    });
    this.mesh.geometry.setDrawRange(0, 2 * this.#count);
    this.#position.needsUpdate = true;
  }
}
