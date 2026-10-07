// SPDX-License-Identifier: AGPL-3.0-only

// The sea's look. On the tiles it works in each tile's own coordinates: the
// offset from its centre, how near the rim it is, and its (q, r). From
// these come the dark seam and the faint lit bevel at every edge, a slight
// tint per tile, and the calm water's shimmer, small ripples of the tile's
// own that fade to nothing at its rim. So what is drawn on a tile stays
// inside it. The water's colour is deep water lightened toward thin crests,
// the sky by Fresnel, the sun's sharp glint and its wide highlight, and the
// haze toward the horizon.

import {
  abs,
  cameraPosition,
  clamp,
  dot,
  Fn,
  float,
  floor,
  fract,
  If,
  length,
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { look, skyColour, toLinear } from '../render/sky';
import { TILE_APOTHEM } from './hex';
import type { TileVaryings } from './tiles';

/** Seconds, wrapped, for the shimmer. */
export const seaTime = uniform(0);

/** 1 to give each tile its own tint and shimmer; 0 to draw every tile alike (for tests). */
export const tileIdentity = uniform(1);

/**
 * A tile's hash, as tileHash in hex.ts: lowbias32 of (q, r) packed into one
 * word, its top 24 bits. Integer arithmetic, so every GPU gets the same.
 */
export const tileHashNode = /* @__PURE__ */ Fn(([hex]: [Node<'vec2'>]) => {
  const q = uint(floor(hex.x.add(0.5)).add(32768)).bitAnd(uint(0xffff));
  const r = uint(floor(hex.y.add(0.5)).add(32768)).bitAnd(uint(0xffff));
  const x = q.bitOr(r.shiftLeft(uint(16))).toVar();
  x.assign(x.bitXor(x.shiftRight(uint(16))));
  x.assign(x.mul(uint(0x7feb352d)));
  x.assign(x.bitXor(x.shiftRight(uint(15))));
  x.assign(x.mul(uint(0x846ca68b)));
  x.assign(x.bitXor(x.shiftRight(uint(16))));
  return x.shiftRight(uint(8));
});

const hash2 = Fn(([p]: [Node<'vec2'>]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

const valueNoise = Fn(([p]: [Node<'vec2'>]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const a = hash2(i);
  const b = hash2(i.add(vec2(1, 0)));
  const c = hash2(i.add(vec2(0, 1)));
  const d = hash2(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

/** The look's starting values, from the waves rendering; tuned in play. */
export const SEA_LOOK = {
  /** Seam: darkening by 40% over this span of the distance from centre to edge. */
  seam: [0.93, 0.99, 0.4],
  /** Bevel: a faint lit band over this span. */
  bevel: [0.86, 0.92, 0.95, 0.18],
  /** Seams, bevel and tint fade out between these distances, in metres. */
  fade: [50, 140],
  /** Each tile's colour shifts by up to this fraction. */
  tint: 0.03,
  /** The shimmer's ripple slope. */
  shimmer: 0.09,
};

interface WaterInput {
  /** The surface's normal. */
  normal: Node<'vec3'>;
  /** The boat band's height here, for the crests' colour. */
  height: Node<'float'>;
}

/** The water's colour (display values), before the tile style and the haze. */
const water = (input: WaterInput, V: Node<'vec3'>): Node<'vec3'> => {
  const N = input.normal;
  const L = look.sun;
  const R = reflect(V.negate(), N);
  const crest = clamp(input.height.mul(0.45).add(0.3), 0, 1);
  const flatSun = normalize(vec3(L.x, 0, L.z));
  const toward = pow(max(dot(V.negate(), flatSun), 0), 3).mul(
    float(1).sub(smoothstep(0.35, 0.9, L.y)),
  );
  const body = mix(look.deep, look.scatter, crest.mul(toward.mul(0.9).add(0.32))).mul(
    max(dot(N, L), 0).mul(0.65).add(0.5),
  );
  const fresnel = pow(float(1).sub(max(dot(N, V), 0)), 5)
    .mul(0.98)
    .add(0.02);
  const col = mix(body, skyColour(R), clamp(fresnel.mul(0.9), 0, 1));
  const rl = max(dot(R, L), 0);
  return col.add(
    look.sunColour.mul(pow(rl, 700).mul(6).add(pow(rl, look.broad.x).mul(look.broad.y))),
  );
};

/** Blends toward the horizon's colour with distance, and converts to linear light. */
const finish = (col: Node<'vec3'>, dist: Node<'float'>): Node<'vec4'> =>
  vec4(toLinear(mix(col, look.skyHorizon, smoothstep(look.hazeNear, look.hazeFar, dist))), 1);

/** The tiles' fragment colour. */
export function tileLook(v: TileVaryings): Node<'vec4'> {
  return Fn(() => {
    const toEye = cameraPosition.sub(positionWorld);
    const dist = length(toEye);
    const V = normalize(toEye);
    const e = v.offset;
    const el = abs(e);
    // Distance from the centre toward the nearest edge, over the apothem:
    // 1 on the edge. Corners point east and west (along x).
    const rim = max(el.y, el.x.mul(Math.sqrt(3) / 2).add(el.y.mul(0.5))).div(TILE_APOTHEM);
    const near = float(1).sub(
      smoothstep(SEA_LOOK.fade[0] as number, SEA_LOOK.fade[1] as number, dist),
    );
    const hash = tileHashNode(v.hex);
    const unit = float(hash).div(16777216);

    // The shimmer: ripples of the tile's own, offset by its hash, faded at its rim.
    const tp = e.add(
      vec2(unit, fract(unit.mul(97)))
        .mul(23)
        .mul(tileIdentity),
    );
    const rp = tp.mul(2.2);
    const rip = vec2(
      valueNoise(rp.add(seaTime.mul(0.7))),
      valueNoise(rp.yx.mul(1.1).sub(seaTime.mul(0.6))),
    )
      .sub(0.5)
      .add(
        vec2(valueNoise(rp.mul(2.7).add(seaTime.mul(1.1))), valueNoise(rp.yx.mul(3.1).sub(seaTime)))
          .sub(0.5)
          .mul(0.5),
      )
      .mul(SEA_LOOK.shimmer)
      .mul(float(1).sub(smoothstep(0.7, 0.93, rim)))
      .mul(near);
    const slope = v.plane.yz.add(rip);
    const N = normalize(vec3(slope.x.negate(), 1, slope.y.negate())).toVar();
    const top = v.side.greaterThan(-0.5);
    If(top.not(), () => {
      N.assign(normalize(vec3(e.x, 0, e.y)));
    });
    const col = water({ normal: N, height: v.plane.w }, V).toVar();
    If(top, () => {
      const [s0, s1, sk] = SEA_LOOK.seam as [number, number, number];
      const [b0, b1, b2, bk] = SEA_LOOK.bevel as [number, number, number, number];
      col.mulAssign(
        unit
          .sub(0.5)
          .mul(2 * SEA_LOOK.tint)
          .mul(near)
          .mul(tileIdentity)
          .add(1),
      );
      col.mulAssign(float(1).sub(smoothstep(s0, s1, rim).mul(sk).mul(near)));
      col.addAssign(
        look.scatter.mul(
          smoothstep(b0, b1, rim)
            .mul(float(1).sub(smoothstep(b1, b2, rim)))
            .mul(bk)
            .mul(near),
        ),
      );
    }).Else(() => {
      // The skirt: the dark wall of a step.
      col.assign(
        mix(look.deep.mul(0.75), look.scatter.mul(0.5), 0.2).mul(
          max(dot(N, look.sun), 0).mul(0.3).add(0.7),
        ),
      );
    });
    return finish(col, dist);
  })() as unknown as Node<'vec4'>;
}

/** The far sea's fragment colour: the same water, without the tile style. */
export function farLook(plane: Node<'vec4'>): Node<'vec4'> {
  return Fn(() => {
    const toEye = cameraPosition.sub(positionWorld);
    const dist = length(toEye);
    const N = normalize(vec3(plane.y.negate(), 1, plane.z.negate()));
    return finish(water({ normal: N, height: plane.w }, normalize(toEye)), dist);
  })() as unknown as Node<'vec4'>;
}
