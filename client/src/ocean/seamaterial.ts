// SPDX-License-Identifier: AGPL-3.0-only

// The sea's look. On the tiles it works in each tile's own coordinates: the
// offset from its centre, how near the rim it is, and its (q, r). From
// these come the dark seam and the faint lit bevel at every edge and a
// slight tint per tile. The water's colour is deep water lightened toward
// thin crests, the sky by Fresnel, the main light's sharp glint and its wide
// highlight (the sun's by day, the moon's path by night), and the haze
// toward the horizon. No water is drawn inside a hull (hulls.ts).
//
// The detail band (detail.ts) is drawn inside each tile, in two parts, so
// that what is drawn on a tile stays inside it. The band read once a tile,
// at its centre and averaged over about a tile's width, tilts and shades
// the tile as a whole: every fragment of the tile has the same. The band
// read at the fragment gives ripples that are the tile's own: read at a
// place shifted by the tile's hash, so neighbours do not continue each
// other, and faded to nothing at the rim, so they stop at its seam. The
// far sea, which has no tiles, reads the band plainly. Where the band
// leaves the finest ripples out, a shimmer of the pattern's noise stands in
// for them, the tile's own too.
//
// On top comes the foam (foam.ts), held within each tile; and against the
// land (shore.ts) the bed through shallow water, surf where the waves
// break, and calmer water in the lee.

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
  smoothstep,
  texture,
  uint,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node, Texture } from 'three/webgpu';
import { look, skyColour, toLinear } from '../render/sky';
import type { DetailNodes } from './detail';
import {
  type FoamParts,
  foamAmount,
  foamColour,
  foamCover,
  foamMargin,
  patternAt,
  streakAt,
  streaks,
  streaksOn,
  whitecaps,
} from './foam';
import { GUST_LOOK } from './gusts';
import { TILE_APOTHEM } from './hex';
import { hulls } from './hulls';
import { FOAM } from './look';
import { shallows, surf } from './shore';
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

/** 1 to draw the detail band; 0 for the boat band alone (the developer panel, the tests). */
export const detailOn = uniform(1);

/** The look's starting values; tuned in play. */
export const SEA_LOOK = {
  /** Seam: darkening by 40% over this span of the distance from centre to edge. */
  seam: [0.93, 0.99, 0.4],
  /** Bevel: a faint lit band over this span. */
  bevel: [0.86, 0.92, 0.95, 0.18],
  /** Seams, bevel and tint fade out between these distances, in metres. */
  fade: [50, 140],
  /** Each tile's colour shifts by up to this fraction. */
  tint: 0.03,
  /** The shimmer's ripple slope, and how fast it drifts, in pattern repeats a thousand seconds (whole, so that time may wrap). */
  shimmer: 0.07,
  shimmerDrift: [7, 4],
  /** How far a crest half the significant height up lightens the water, and how far the detail band's height does. */
  crest: 0.45,
  crestDetail: 0.4,
  /** The detail band's slope in the normal: averaged over the tile, and at the fragment. */
  tilt: 1.08,
  ripple: 0.67,
  /** Its height in the crest: the tile's, and the fragment's. */
  lift: [0.7, 0.3],
  /** The tile's own ripples are shifted by its hash, up to this many metres. */
  shift: 23,
  /** How much of the sun's sharp glint a tile's rim loses. */
  rimGlint: 1,
  /** A band that is not filtered with distance fades out between these distances, in metres. */
  unfiltered: [40, 110],
  /** Half the significant height counts as at least this, in metres: calm water has no crests. */
  crestFloor: 0.03,
};

interface WaterInput {
  /** The surface's normal. */
  normal: Node<'vec3'>;
  /** How far the crest lightens the water, 0 to 1 (lightening). */
  crest: Node<'float'>;
  /** How much of the sun's sharp glint shows, 0 to 1. */
  glint: Node<'float'> | number;
}

/**
 * The boat band's height in half significant heights: a crest is high for
 * its own sea, in a breeze and in a gale alike.
 */
const crestHeight = (height: Node<'float'>, hs: Node<'float'>): Node<'float'> =>
  height.div(max(hs.mul(0.5), SEA_LOOK.crestFloor)) as unknown as Node<'float'>;

/** How far a crest lightens the water: the boat band's height and the detail band's. */
const lightening = (crest: Node<'float'>, detail: Node<'float'>): Node<'float'> =>
  clamp(
    crest.mul(SEA_LOOK.crest).add(detail.mul(SEA_LOOK.crestDetail)).add(0.3),
    0,
    1,
  ) as unknown as Node<'float'>;

/** The water's colour (display values), before the tile style and the haze. */
const water = (input: WaterInput, V: Node<'vec3'>): Node<'vec3'> => {
  const N = input.normal;
  const L = look.light;
  const R = reflect(V.negate(), N);
  const crest = input.crest;
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
    look.lightColour.mul(
      pow(rl, 700).mul(6).mul(input.glint).add(pow(rl, look.broad.x).mul(look.broad.y)),
    ),
  );
};

/** Blends toward the horizon's colour with distance, and converts to linear light. */
const finish = (col: Node<'vec3'>, dist: Node<'float'>): Node<'vec4'> =>
  vec4(toLinear(mix(col, look.skyHorizon, smoothstep(look.hazeNear, look.hazeFar, dist))), 1);

/** What the sea's look is made from, beside the tiles themselves. */
export interface SeaParts {
  /** The detail band, or null to draw the boat band alone. */
  detail: DetailNodes | null;
  /** Whether the shimmer stands in for the ripples the detail band leaves out. */
  shimmer: boolean;
  /** The foam's pattern and noise (pattern.ts). */
  pattern: Texture;
  /** The wakes at a scene point (foammap.ts), or null without them. */
  wakes: ((p: Node<'vec2'>) => Node<'float'>) | null;
}

/** What a probe reads of a tile's fragment instead of its colour (the tests). */
export type Probe = 'detail' | 'foam' | 'crest' | 'gust' | 'ground';

/**
 * The tiles' fragment colour. With a probe, the fragment's numbers instead:
 * 'detail' gives vec4(the whole tile's tilt along x and z, the tile's own
 * ripples' slope along x and z); 'foam' vec4(the foam's cover with its
 * margin, its amount, the whitecaps' part, the streaks' part); 'crest'
 * vec4(the boat band's height in half significant heights, the detail's
 * height, how near the rim, the hulls' and wakes' foam); 'gust' vec4(the
 * gust on the tile as it shows, its gust and its lull, 1); 'ground'
 * vec4(the water's depth, the waves' cap, the surf's amount, the lee).
 */
export function tileLook(v: TileVaryings, parts: SeaParts, probe?: Probe): Node<'vec4'> {
  const detail = parts.detail;
  // Once a tile, in the vertex stage: the same for every fragment of it.
  const whole = detail === null ? null : (varying(detail.coarse(v.centre)) as Node<'vec4'>);
  return Fn(() => {
    // No water inside a hull; and the foam the hulls make.
    const wet = hulls.wet(positionWorld, v.nearHull);
    const toEye = cameraPosition.sub(positionWorld);
    const dist = length(toEye);
    const V = normalize(toEye);
    const e = v.offset;
    const el = abs(e);
    // Distance from the centre toward the nearest edge, over the apothem:
    // 1 on the edge. Corners point east and west (along x).
    const rim = max(el.y, el.x.mul(Math.sqrt(3) / 2).add(el.y.mul(0.5))).div(TILE_APOTHEM);
    // What is the tile's own fades from here to its rim.
    const fade = smoothstep(0.7, 0.93, rim).toVar();
    const inner = float(1).sub(fade);
    const near = float(1).sub(
      smoothstep(SEA_LOOK.fade[0] as number, SEA_LOOK.fade[1] as number, dist),
    );
    const hash = tileHashNode(v.hex);
    const unit = float(hash).div(16777216);
    // The tile's own place: the fragment's, shifted by the tile's hash.
    // With every tile drawn alike, the place within the tile alone.
    const own = e
      .add(
        positionWorld.xz
          .sub(e)
          .add(vec2(unit, fract(unit.mul(97))).mul(SEA_LOOK.shift))
          .mul(tileIdentity),
      )
      .toVar();

    // Every texture is read here, before anything branches.
    const pattern = texture(parts.pattern, patternAt(own, tileIdentity)).toVar();
    const tilt = vec2(0).toVar();
    const ripple = vec2(0).toVar();
    const lift = float(0).toVar();
    const folding = float(0).toVar();
    if (detail !== null && whole !== null) {
      const d = detail.fine(own).toVar();
      const [from, to] = SEA_LOOK.unfiltered as [number, number];
      const kept = detail.filtered ? float(1) : float(1).sub(smoothstep(from, to, dist));
      tilt.assign(whole.xy.mul(SEA_LOOK.tilt).mul(detailOn));
      ripple.assign(d.xy.mul(SEA_LOOK.ripple).mul(inner).mul(kept).mul(detailOn));
      if (detail.ripple !== null) {
        ripple.addAssign(detail.ripple(own).mul(SEA_LOOK.ripple).mul(inner).mul(detailOn));
      }
      const [tile, fragment] = SEA_LOOK.lift as [number, number];
      lift.assign(whole.w.mul(tile).add(d.w.mul(fragment).mul(kept)).mul(detailOn));
      folding.assign(
        mix(whole.z, d.z, 0.5)
          .mul(float(1).sub(fade.mul(0.5)))
          .mul(detailOn),
      );
    }
    if (parts.shimmer) {
      // The shimmer: the pattern's two fine noises as slopes, drifting.
      const [dx, dy] = SEA_LOOK.shimmerDrift as [number, number];
      const at = patternAt(own, tileIdentity).add(vec2(dx / 1000, dy / 1000).mul(seaTime));
      const noise = texture(parts.pattern, at).toVar();
      ripple.addAssign(vec2(noise.y, noise.w).sub(0.5).mul(SEA_LOOK.shimmer).mul(inner).mul(near));
    }
    const streak = float(0).toVar();
    If(streaksOn.greaterThan(0.5), () => {
      streak.assign(texture(parts.pattern, streakAt(own)).y);
    });
    const wakes = (parts.wakes === null ? float(0) : parts.wakes(positionWorld.xz)).toVar();

    // A gust is rougher water: the capillary ripples a gust raises are what
    // makes its patch dark, tilting the sight down into the water where
    // smooth water mirrors the sky (American Meteorological Society,
    // Glossary of Meteorology, "cat's paw"). So under a gust the tile's own
    // ripples are steeper, and in a lull flatter, and the water's own
    // shading does the rest, by day and by night.
    const gust = v.gust.toVar();
    const gusty = max(gust, 0);
    const lull = max(gust.negate(), 0);
    ripple.mulAssign(gusty.mul(GUST_LOOK.rough).sub(lull.mul(GUST_LOOK.smooth)).add(1));
    // In the lee the wind raises less: smaller ripples, fewer whitecaps.
    const lee = clamp(v.lee, 0, 1.3);
    ripple.mulAssign(lee);
    const ground = v.ground;
    const breaking = surf(ground.x, ground.y, ground.w, v.area.w, v.period, lee).toVar();
    const slope = v.plane.yz.add(tilt).add(ripple);
    const N = normalize(vec3(slope.x.negate(), 1, slope.y.negate())).toVar();
    const top = v.side.greaterThan(-0.5);
    If(top.not(), () => {
      N.assign(normalize(vec3(e.x, 0, e.y)));
    });
    const crest = crestHeight(v.plane.w, v.area.w);
    const lightened = lightening(crest, lift);
    const foam: FoamParts = {
      area: vec3(v.area.x.mul(lee), v.area.yz) as unknown as Node<'vec3'>,
      crest,
      detail: lift,
      lightened,
      folding,
      pattern,
      streak,
      boats: wet.add(wakes).add(breaking) as unknown as Node<'float'>,
    };
    const amount = foamAmount(foam).toVar();
    const cover = foamCover(amount, pattern).mul(foamMargin(fade)).toVar();
    if (probe === 'detail') {
      return vec4(tilt, ripple);
    }
    if (probe === 'foam') {
      return vec4(cover, amount, whitecaps(foam), streaks(foam));
    }
    if (probe === 'crest') {
      return vec4(crest, lift, rim, foam.boats);
    }
    if (probe === 'gust') {
      return vec4(gust, gusty, lull, 1);
    }
    if (probe === 'ground') {
      return vec4(ground.x, ground.y, breaking, v.lee);
    }
    // A tile's rim has no ripples of its own to scatter the sun: left to
    // itself it would mirror it, and every tile toward the sun would wear a
    // bright ring.
    const glint = float(1).sub(fade.mul(SEA_LOOK.rimGlint));
    const col = shallows(
      water({ normal: N, crest: lightened, glint }, V),
      ground.x,
      ground.w,
    ).toVar();
    If(top, () => {
      // And darker, as the whole patch reads from a distance.
      col.mulAssign(float(1).sub(gusty.mul(GUST_LOOK.dark)));
      col.assign(mix(col, foamColour(N), cover.mul(FOAM.cover)));
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
          max(dot(N, look.light), 0).mul(0.3).add(0.7),
        ),
      );
    });
    return finish(col, dist);
  })() as unknown as Node<'vec4'>;
}

/** What the far sea's look reads at each vertex (far.ts). */
export interface FarVaryings {
  plane: Node<'vec4'>;
  area: Node<'vec4'>;
  nearHull: Node<'float'>;
  ground: Node<'vec4'>;
  lee: Node<'float'>;
  period: Node<'float'>;
}

/**
 * The far sea's fragment colour: the same water and foam, without the tile
 * style, and the shallows and surf as far as the ground window reaches.
 * With probe, vec4(the detail's slope along x and z, 0, 0).
 */
export function farLook(v: FarVaryings, parts: SeaParts, probe = false): Node<'vec4'> {
  const { plane, area, nearHull } = v;
  const detail = parts.detail;
  return Fn(() => {
    hulls.cut(positionWorld, nearHull);
    const toEye = cameraPosition.sub(positionWorld);
    const dist = length(toEye);
    const at = positionWorld.xz;
    const pattern = texture(parts.pattern, patternAt(at)).toVar();
    const ripple = vec2(0).toVar();
    const lift = float(0).toVar();
    const folding = float(0).toVar();
    if (detail !== null) {
      // The band as it is: no tile to hold it in.
      const d = detail.fine(at).toVar();
      const [from, to] = SEA_LOOK.unfiltered as [number, number];
      const kept = detail.filtered ? float(1) : float(1).sub(smoothstep(from, to, dist));
      ripple.assign(d.xy.mul(kept).mul(detailOn));
      lift.assign(d.w.mul(kept).mul(detailOn));
      folding.assign(d.z.mul(detailOn));
    }
    const streak = float(0).toVar();
    If(streaksOn.greaterThan(0.5), () => {
      streak.assign(texture(parts.pattern, streakAt(at)).y);
    });
    if (probe) {
      return vec4(ripple, 0, 0);
    }
    const lee = clamp(v.lee, 0, 1.3);
    ripple.mulAssign(lee);
    const slope = plane.yz.add(ripple);
    const N = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
    const crest = crestHeight(plane.w, area.w);
    const lightened = lightening(crest, lift);
    const g = v.ground;
    const foam: FoamParts = {
      area: vec3(area.x.mul(lee), area.yz) as unknown as Node<'vec3'>,
      crest,
      detail: lift,
      lightened,
      folding,
      pattern,
      streak,
      boats: surf(g.x, g.y, g.w, area.w, v.period, lee) as unknown as Node<'float'>,
    };
    const cover = foamCover(foamAmount(foam), pattern);
    const col = mix(
      shallows(water({ normal: N, crest: lightened, glint: 1 }, normalize(toEye)), g.x, g.w),
      foamColour(N),
      cover.mul(FOAM.cover),
    );
    return finish(col, dist);
  })() as unknown as Node<'vec4'>;
}
