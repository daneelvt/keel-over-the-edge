// SPDX-License-Identifier: AGPL-3.0-only

// The near sea: one instanced mesh of hexagonal tiles, every tile within
// 150 m of the tile under the boat. Each tile is a rigid flat slab: every
// vertex takes its height from the one plane of its tile,
//   y = H(c) + ∇H(c)·e,
// c the tile's centre and e the vertex's horizontal offset from it, with its
// horizontal position c + e unchanged. So the tile never bends, its outline
// seen from above is always the exact hexagon, and neighbours meet with a
// step along their shared edge, never a gap. A skirt hangs from each tile's
// rim, so a step shows as a short dark wall.
//
// The lattice is fixed in the world. The field's instances are fixed
// offsets around a centre tile; when the boat enters a new tile, the centre
// tile's (q, r) and position change, and every instance names a new tile.
//
// A tile over land, or at or beyond the lip of the falls, is not drawn: its
// vertices all fall to one point. Each tile carries its ground to the look
// (shore.ts): the depth, the waves' cap, the bed's surface, and the lee
// about it.

import {
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  Vector2,
} from 'three';
import {
  abs,
  attribute,
  dot,
  float,
  instanceIndex,
  int,
  ivec2,
  length,
  positionGeometry,
  select,
  sign,
  smoothstep,
  textureLoad,
  uniform,
  varying,
  vec3,
} from 'three/tsl';
import type { Node, Texture } from 'three/webgpu';
import { beyondLip, lipPlane } from '../edge/lip';
import { GUST_LOOK, type GustField, gustAt } from './gusts';
import type { Field } from './hex';
import { FIELD_RADIUS, TILE_RADIUS } from './hex';
import { HULL_MARGIN, hulls } from './hulls';
import { depthCap, groundAtHex, leeAt, tileGround } from './shore';
import { GROUND_ROW, GUST_ROW, PASS_WIDTH } from './tilepass';
import { type BandUniforms, boatBandAt, cappedBand, periodAt, seaAreaAt, seaPlaneOf } from './wave';

/** Depth of each tile's skirt, in metres: deeper than the steps a gale gives. */
export const SKIRT_DEPTH = 1.1;

/**
 * The shared tile: a centre and six corners on top (6 triangles), and a
 * skirt of six quads from the rim down, facing outward (12 triangles).
 * Each vertex's position is (ex, s, ez): its offset from the tile's centre
 * in the scene's x and z, and s = 0 on top, -1 at the skirt's foot.
 */
export function tileGeometry(): { position: Float32Array; index: Uint16Array } {
  const position = new Float32Array(19 * 3);
  const corner = (i: number): [number, number] => {
    // Corners point east and west. World (east, north) to scene (x, z = -north).
    const a = (i * Math.PI) / 3;
    return [TILE_RADIUS * Math.cos(a), -TILE_RADIUS * Math.sin(a)];
  };
  // 0: centre; 1–6: top corners; 7–12: skirt top; 13–18: skirt foot.
  for (let i = 0; i < 6; i++) {
    const [x, z] = corner(i);
    position.set([x, 0, z], (1 + i) * 3);
    position.set([x, 0, z], (7 + i) * 3);
    position.set([x, -1, z], (13 + i) * 3);
  }
  const index: number[] = [];
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    // Counter-clockwise seen from above.
    index.push(0, 1 + i, 1 + j);
    // Counter-clockwise seen from outside the tile.
    index.push(7 + i, 13 + i, 7 + j, 7 + j, 13 + i, 13 + j);
  }
  return { position, index: Uint16Array.from(index) };
}

/** What the sea's look reads of a tile, as varyings. */
export interface TileVaryings {
  /** The fragment's offset from its tile's centre, scene x and z. */
  offset: Node<'vec2'>;
  /** 0 on the tile's top, below 0 on its skirt. */
  side: Node<'float'>;
  /** The tile's plane: H, ∂H/∂x, ∂H/∂z, and the band's height h. */
  plane: Node<'vec4'>;
  /** The tile's (q, r). */
  hex: Node<'vec2'>;
  /** The sea area's foam at the tile (whitecaps, streaks, folding) and the significant height of its waves, in metres. */
  area: Node<'vec4'>;
  /** Above 0 where a hull or its foam may reach the tile. */
  nearHull: Node<'float'>;
  /** The tile's centre in the scene (x, z): a vertex-stage value, the same for every vertex of the tile. */
  centre: Node<'vec2'>;
  /**
   * The gust on the tile, as it shows: the gust field at the tile's centre,
   * above 0 in a gust and below in a lull, times how strongly the spell's
   * gusts show, fading to nothing at the tile field's rim, and calmed in the
   * lee.
   */
  gust: Node<'float'>;
  /** The tile's ground: the water's depth, m, the waves' cap there, 1 for land, the bed's surface. */
  ground: Node<'vec4'>;
  /** The lee at the tile: the shelter's factor for the mean wind. */
  lee: Node<'float'>;
  /** The sea's peak period at the tile, s. */
  period: Node<'float'>;
}

export class Tiles {
  readonly mesh: Mesh;
  /** The centre tile's scene position relative to the floating origin. */
  readonly centre = uniform(new Vector2());
  /** The centre tile's (q, r), exact in float32 anywhere on the disk. */
  readonly centreHex = uniform(new Vector2());
  /** The vertex node: a tile vertex's scene position. */
  readonly position: Node<'vec3'>;
  readonly varyings: TileVaryings;
  readonly geometry: InstancedBufferGeometry;

  /**
   * planes is the tile pass's target, or null to compute each tile's plane
   * in the vertex stage (the fallback without float render targets).
   */
  constructor(field: Field, band: BandUniforms, planes: Texture | null, gusts: GustField) {
    const g = tileGeometry();
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(g.position, 3));
    geometry.setIndex(new BufferAttribute(g.index, 1));
    const tile = new Float32Array(field.count * 4);
    for (let i = 0; i < field.count; i++) {
      tile[i * 4] = field.offset[i * 2] ?? 0;
      tile[i * 4 + 1] = -(field.offset[i * 2 + 1] ?? 0);
      tile[i * 4 + 2] = field.hex[i * 2] ?? 0;
      tile[i * 4 + 3] = field.hex[i * 2 + 1] ?? 0;
    }
    geometry.setAttribute('tile', new InstancedBufferAttribute(tile, 4));
    geometry.instanceCount = field.count;
    this.geometry = geometry;

    const t = attribute<'vec4'>('tile', 'vec4');
    const index = int(instanceIndex);
    const c = this.centre.add(t.xy);
    const hex = this.centreHex.add(t.zw);
    // Without the pass the band is summed here for the plane, and capped by
    // the depth; with it the plane and the ground are read, and only the
    // sea area's values, which need no sum, are computed here.
    const summed = planes === null ? boatBandAt(band)(c) : null;
    let ground: Node<'vec4'>;
    let plane: Node<'vec4'>;
    if (summed !== null) {
      const g = groundAtHex(hex);
      const f = depthCap(g, summed.w);
      ground = tileGround(g, f);
      plane = seaPlaneOf(cappedBand(summed, f), c);
    } else {
      const row = index.div(PASS_WIDTH);
      plane = textureLoad(planes as Texture, ivec2(index.mod(PASS_WIDTH), row));
      ground = textureLoad(planes as Texture, ivec2(index.mod(PASS_WIDTH), row.add(GROUND_ROW)));
    }
    const lee = leeAt(c, this.centre, this.centreHex);
    // The gust field at the tile's centre: read from the pass, or summed here.
    const field0 =
      planes === null
        ? gustAt(gusts)(c)
        : textureLoad(planes, ivec2(index.mod(PASS_WIDTH), index.div(PASS_WIDTH).add(GUST_ROW))).x;
    const rim = smoothstep(FIELD_RADIUS - GUST_LOOK.rim, FIELD_RADIUS, length(t.xy));
    // A patch reads as a patch: the field shows from a little off its
    // middle, and in full well before its strongest.
    const [from, full] = GUST_LOOK.shows;
    const shown = smoothstep(from, full, abs(field0)).mul(sign(field0));
    const gust = shown.mul(gusts.uniforms.strength).mul(float(1).sub(rim)).mul(lee);
    // Over land, or at or beyond the lip, every vertex falls to the tile's
    // centre, well below the sea: its triangles have no area, and nothing is
    // drawn. Near the lip the tile sags and tips over the brink.
    const land = ground.z.greaterThan(0.5).or(beyondLip(c));
    plane = lipPlane(c, plane);
    const e = select(land, positionGeometry.xz.mul(0), positionGeometry.xz);
    const s = positionGeometry.y;
    const y = select(land, plane.x.sub(50), plane.x.add(dot(plane.yz, e)).add(s.mul(SKIRT_DEPTH)));
    this.position = vec3(c.x.add(e.x), y, c.y.add(e.y));
    this.varyings = {
      offset: varying(e),
      side: varying(s),
      plane: varying(plane),
      hex: varying(hex),
      area: varying(seaAreaAt(band)(c)),
      nearHull: varying(hulls.near(c, TILE_RADIUS + HULL_MARGIN)),
      centre: c,
      gust: varying(gust),
      ground: varying(ground),
      lee: varying(lee),
      period: varying(periodAt(band)(c)),
    };

    this.mesh = new Mesh(geometry);
    this.mesh.name = 'tiles';
    // The tiles are placed by their vertex node, not by the mesh's bounds.
    this.mesh.frustumCulled = false;
  }
}
