// SPDX-License-Identifier: AGPL-3.0-only

// The sea against the land, as the shaders draw it, from the ground window
// and the lee's texture (land/ground.ts, land/shelter.ts). At each hexagon
// of the sea's lattice:
//
//   - the water's depth, and whether it is land: a tile over land is not
//     drawn;
//   - the waves' cap: the boat band scaled by f = min(1, γ h / Hs), as the
//     physics scales it under a hull, so a tile and the boat on it heave
//     alike; where f < 1 the waves are breaking;
//   - the shallows: the bed's colour through the water, exp(−2 K h) of it
//     (Beer–Lambert, there and back);
//   - surf where the waves break, in bands running shoreward once a peak
//     period, placed by the depth so that they follow the coast; a reef's
//     crest foams whenever they break on it; less of it in the lee;
//   - the lee: the shelter's factor for the mean wind, which calms the gust
//     patches, the ripples and the whitecaps;
//   - the waves' lee: the share of the boat band the land leaves, as the
//     physics scales the waves under a hull (lee.ts), before the depth's cap.

import { Vector2, Vector3 } from 'three';
import {
  abs,
  clamp,
  exp,
  float,
  floor,
  fract,
  int,
  ivec2,
  max,
  mix,
  round,
  select,
  smoothstep,
  texture,
  textureLoad,
  uniform,
  uniformArray,
  vec2,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { GroundWindow, WINDOW_COLUMNS, WINDOW_ROWS } from '../land/ground';
import { SHELTER_SCALE, SHELTER_SIDE, ShelterTexture } from '../land/shelter';
import { GROUND } from '../predict/layout.gen';
import { look } from '../render/sky';
import { LEE_SIDE, LeeTexture } from './lee';
import { seaTime } from './seamaterial';

/** The ground window and the lee's texture the sea reads: one each, filled by the land. */
export const groundWindow = new GroundWindow();
export const shelterTexture = new ShelterTexture();
/** The waves' lee, filled from the module for the sea drawn (ocean.ts). */
export const leeTexture = new LeeTexture();

const HEX_STEP = 1.5 * (4 / Math.sqrt(3));
const COLUMN_ZERO = (GROUND.chunkSide * GROUND.chunkColumns) / 2;
const ROW_ZERO = (GROUND.chunkSide * GROUND.chunkRows) / 2;

/** What the sea's shaders read of the land. */
export const shore = {
  /** The ground window's first texel's column and row on the grid. */
  window: uniform(new Vector2()),
  /** The lee's first texel's cell on the grid of cells. */
  lee: uniform(new Vector2()),
  /** The waves' lee's first texel's cell. */
  waves: uniform(new Vector2()),
  /** γ: the most significant height a depth keeps, as a share of it (the catalog's). */
  breaking: uniform(0.5),
  /** K: how fast light fades in the water, per m (the catalog's). */
  attenuation: uniform(0.15),
  /** Each surface's bed seen through the water, display values. */
  beds: uniformArray(
    Array.from({ length: GROUND.surfaces }, () => new Vector3(0.8, 0.75, 0.6)),
    'vec3',
  ),
  /** Each surface's foam where the waves break over it, as a reef's crest foams. */
  crests: uniformArray(new Array<number>(GROUND.surfaces).fill(0), 'float'),
  /** 1 to draw the shallows, surf and the lee, once a world with land is in play; 0 for the open sea. */
  on: uniform(0),
};

/** Sets what the land's look is from the catalog: γ, K, the beds' colours and each surface's crest foam. */
export function setShoreLook(
  breaking: number,
  attenuation: number,
  beds: readonly [number, number, number][],
  crests: readonly number[],
): void {
  shore.breaking.value = breaking;
  shore.attenuation.value = attenuation;
  beds.forEach((c, i) => {
    const v = shore.beds.array[i] as Vector3 | undefined;
    v?.set(c[0] / 255, c[1] / 255, c[2] / 255);
  });
  crests.forEach((c, i) => {
    (shore.crests.array as number[])[i] = c;
  });
}

/**
 * The ground at hexagon (q, r), exact whole numbers: vec4(the water's depth
 * in metres, 1 for land, the surface's index, the land's height in metres).
 * Outside the window, open water 25.5 m deep.
 */
export function groundAtHex(hex: Node<'vec2'>): Node<'vec4'> {
  const q = hex.x;
  const col = q.add(COLUMN_ZERO).sub(shore.window.x);
  const row = hex.y
    .add(floor(q.mul(0.5)))
    .add(ROW_ZERO)
    .sub(shore.window.y);
  const inside = col
    .greaterThanEqual(0)
    .and(row.greaterThanEqual(0))
    .and(col.lessThan(WINDOW_COLUMNS))
    .and(row.lessThan(WINDOW_ROWS));
  const at = ivec2(int(clamp(col, 0, WINDOW_COLUMNS - 1)), int(clamp(row, 0, WINDOW_ROWS - 1)));
  const t = textureLoad(groundWindow.texture, at);
  const g = vec4(
    t.x.mul(25.5),
    select(t.w.greaterThan(0.5), 1, 0),
    round(t.z.mul(255)),
    t.y.mul(102),
  );
  return select(inside, g, vec4(25.5, 0, 0, 0)) as unknown as Node<'vec4'>;
}

/**
 * The hexagon that holds the scene point p, from the centre tile's scene
 * position centre and its (q, r) centreHex: cube rounding of p's axial
 * offset from it (Red Blob Games, "Hexagonal Grids").
 */
export function hexOf(
  p: Node<'vec2'>,
  centre: Node<'vec2'>,
  centreHex: Node<'vec2'>,
): Node<'vec2'> {
  const d = p.sub(centre);
  const qf = d.x.mul(1 / HEX_STEP);
  // The scene's z runs south.
  const rf = d.y.negate().mul(0.25).sub(qf.mul(0.5));
  const sf = qf.add(rf).negate();
  const q = round(qf);
  const r = round(rf);
  const s = round(sf);
  const dq = abs(q.sub(qf));
  const dr = abs(r.sub(rf));
  const ds = abs(s.sub(sf));
  const qFirst = dq.greaterThan(dr).and(dq.greaterThan(ds));
  const qq = select(qFirst, r.add(s).negate(), q);
  const rr = select(qFirst, r, select(dr.greaterThan(ds), q.add(s).negate(), r));
  return centreHex.add(vec2(qq, rr)) as unknown as Node<'vec2'>;
}

/** The waves' cap f at a hexagon of ground g for a sea of significant height hs: 0 on land, 1 where deep enough. */
export function depthCap(g: Node<'vec4'>, hs: Node<'float'>): Node<'float'> {
  const keep = shore.breaking.mul(g.x);
  const f = select(keep.greaterThanEqual(hs), float(1), max(keep.div(max(hs, 1e-6)), 0));
  return select(g.y.greaterThan(0.5), float(0), f) as unknown as Node<'float'>;
}

/**
 * The lee at the scene point p: the shelter's factor for the mean wind,
 * bilinear between cells' centres, 1 outside the texture. The cells' grid
 * is laid as the physics lays it (Shelter.At).
 */
export function leeAt(
  p: Node<'vec2'>,
  centre: Node<'vec2'>,
  centreHex: Node<'vec2'>,
): Node<'float'> {
  const d = p.sub(centre);
  // Columns and rows of hexagons from the grid's corner, at the point.
  const col = centreHex.x.add(d.x.mul(1 / HEX_STEP)).add(COLUMN_ZERO);
  const row = centreHex.y
    .add(centreHex.x.mul(0.5))
    .add(d.y.negate().mul(0.25))
    .sub(0.25)
    .add(ROW_ZERO);
  const fa = col.sub(3.5).mul(1 / 8);
  const fb = row.sub(3.5).mul(1 / 8);
  const uv = vec2(fa.sub(shore.lee.x).add(0.5), fb.sub(shore.lee.y).add(0.5)).mul(1 / SHELTER_SIDE);
  const inside = uv.x
    .greaterThan(0)
    .and(uv.y.greaterThan(0))
    .and(uv.x.lessThan(1))
    .and(uv.y.lessThan(1));
  const f = texture(shelterTexture.texture, uv)
    .level(float(0))
    .x.mul(255 / SHELTER_SCALE);
  return mix(float(1), select(inside, f, float(1)), shore.on) as unknown as Node<'float'>;
}

/**
 * The share of the boat band the land's lee leaves at the scene point p:
 * bilinear between cells' centres, as the physics reads it (LeeAt), in
 * floats from the four cells' texels; 1 outside the texture and on the
 * open sea.
 */
export function waveLeeAt(
  p: Node<'vec2'>,
  centre: Node<'vec2'>,
  centreHex: Node<'vec2'>,
): Node<'float'> {
  const d = p.sub(centre);
  const col = centreHex.x.add(d.x.mul(1 / HEX_STEP)).add(COLUMN_ZERO);
  const row = centreHex.y
    .add(centreHex.x.mul(0.5))
    .add(d.y.negate().mul(0.25))
    .sub(0.25)
    .add(ROW_ZERO);
  const fa = col
    .sub(3.5)
    .mul(1 / 8)
    .sub(shore.waves.x);
  const fb = row
    .sub(3.5)
    .mul(1 / 8)
    .sub(shore.waves.y);
  const a = floor(fa);
  const b = floor(fb);
  const ta = fa.sub(a);
  const tb = fb.sub(b);
  const cell = (da: number, db: number): Node<'float'> => {
    const u = a.add(da);
    const v = b.add(db);
    const inside = u
      .greaterThanEqual(0)
      .and(v.greaterThanEqual(0))
      .and(u.lessThan(LEE_SIDE))
      .and(v.lessThan(LEE_SIDE));
    const at = ivec2(int(clamp(u, 0, LEE_SIDE - 1)), int(clamp(v, 0, LEE_SIDE - 1)));
    return select(
      inside,
      textureLoad(leeTexture.texture, at).x,
      float(1),
    ) as unknown as Node<'float'>;
  };
  const f = mix(mix(cell(0, 0), cell(1, 0), ta), mix(cell(0, 1), cell(1, 1), ta), tb);
  return mix(float(1), f, shore.on) as unknown as Node<'float'>;
}

/**
 * The water's colour with the bed showing through it (display values): col
 * is the water's, depth the water's depth in metres over a bed of surface.
 */
export function shallows(
  col: Node<'vec3'>,
  depth: Node<'float'>,
  surface: Node<'float'>,
): Node<'vec3'> {
  const seen = exp(depth.mul(shore.attenuation).mul(-2)).mul(shore.on);
  const bed = (shore.beds.element(int(surface)) as unknown as Node<'vec3'>).mul(
    max(look.light.y, 0).mul(0.55).add(0.18).mul(look.lightColour.add(0.35)),
  );
  return mix(col, bed, clamp(seen.mul(0.85), 0, 1)) as unknown as Node<'vec3'>;
}

/**
 * Surf: the foam's amount where the waves break, 0 to 1: depth is the
 * water's, f the waves' cap there, surface the bed's, hs the sea's
 * significant height, period its peak period in seconds, lee the shelter's
 * factor.
 */
export function surf(
  depth: Node<'float'>,
  f: Node<'float'>,
  surface: Node<'float'>,
  hs: Node<'float'>,
  period: Node<'float'>,
  lee: Node<'float'>,
): Node<'float'> {
  const breaking = float(1).sub(f);
  // The bands' crests where the phase is 0: as time runs it is 0 in ever
  // shallower water, so they run up the shore.
  const phase = fract(seaTime.div(max(period, 1.5)).add(depth.mul(0.8)));
  const band = smoothstep(0, 0.12, phase).mul(float(1).sub(smoothstep(0.2, 0.55, phase)));
  const crest = shore.crests.element(int(surface)) as unknown as Node<'float'>;
  const amount = breaking
    .mul(band.mul(0.7).add(0.3).add(crest))
    .mul(clamp(hs.mul(2), 0.25, 1))
    .mul(clamp(lee, 0.3, 1));
  return clamp(amount, 0, 1).mul(shore.on) as unknown as Node<'float'>;
}

/** The ground's numbers a tile carries to its look: vec4(depth, f, land, surface). */
export function tileGround(g: Node<'vec4'>, f: Node<'float'>): Node<'vec4'> {
  return vec4(g.x, f, g.y, g.z) as unknown as Node<'vec4'>;
}
