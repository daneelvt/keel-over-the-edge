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
// The wake's waves (wakewaves.ts) are drawn as the detail band is: read at
// the tile's centre from their mipmap of about a tile's texels they tilt the
// tile as a whole, and read at the fragment, at its own place (a wake is
// where it is, not shifted by the tile's hash) and faded to nothing at the
// rim, they ripple it; their height lights its crest. Nothing lifts a tile.
// Where the foam map's track runs (foammap.ts), the wind's ripples are
// smoothed, so the lane mirrors the sky as a real wake's slick does, and the
// water is lightened toward its scattering colour, by the bubbles under it.
//
// On top comes the foam (foam.ts), held within each tile, and the boats'
// white water, softer; and against the land (shore.ts) the bed through
// shallow water, surf where the waves break, and calmer water in the lee.

import {
  abs,
  cameraPosition,
  clamp,
  dot,
  exp,
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
  select,
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
import { drainLines } from '../edge/lines';
import { cutAtLip } from '../edge/lip';
import { edgeLook } from '../edge/mist';
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
  wakeColour,
  wakeCover,
  whitecaps,
} from './foam';
import { GUST_LOOK } from './gusts';
import { TILE_APOTHEM } from './hex';
import { hulls } from './hulls';
import { DETAIL, FOAM, RAIN_CUT, TRACK } from './look';
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

/**
 * The developer panel's overlay of the wake on the tiles: 0 none, 1 the
 * wake's waves' height (red up, blue down, full at 5 cm drawn), 2 the
 * track's churn (green).
 */
export const wakeOverlay = uniform(0);

/** 1 to draw the detail band; 0 for the boat band alone (the developer panel, the tests). */
export const detailOn = uniform(1);

/**
 * How much steeper the detail band and the shimmer are drawn than the
 * spectrum has them, by the wind's force under the boat (look.ts): the
 * short sea heaps up in a storm.
 */
export const detailSteep = uniform(1);

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
  /**
   * The crest's lightening counts its height over half the significant
   * height, but no less than this many metres: light through a thin crest
   * is a big wave's sign, and a calm's low crests are faint.
   */
  crestLight: 0.6,
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
 * its own sea, in a breeze and in a gale alike. Where the whitecaps sit.
 */
const crestHeight = (height: Node<'float'>, hs: Node<'float'>): Node<'float'> =>
  height.div(max(hs.mul(0.5), SEA_LOOK.crestFloor)) as unknown as Node<'float'>;

/**
 * The boat band's height for the light through its crests: over half the
 * significant height, but never less than SEA_LOOK.crestLight, so a gale's
 * crests are lit and a calm's are faint.
 */
const crestLit = (height: Node<'float'>, hs: Node<'float'>): Node<'float'> =>
  height.div(max(hs.mul(0.5), SEA_LOOK.crestLight)) as unknown as Node<'float'>;

/**
 * The whitecaps a sea area keeps under rain of a share: rain takes a
 * moderate breeze's white horses, and not a gale's (RAIN_CUT).
 */
const rainKept = (whitecaps: Node<'float'>, rain: Node<'float'>): Node<'float'> =>
  whitecaps.mul(
    float(1).sub(rain.mul(float(1).sub(smoothstep(RAIN_CUT.from, RAIN_CUT.to, whitecaps)))),
  ) as unknown as Node<'float'>;

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

/**
 * Blends toward the horizon's colour with distance, and the band's mist at
 * the edge of the world (its depth along the ray, from the vertex), and
 * converts to linear light.
 */
const finish = (col: Node<'vec3'>, dist: Node<'float'>, mist: Node<'float'>): Node<'vec4'> => {
  const hazed = mix(col, look.skyHorizon, smoothstep(look.hazeNear, look.hazeFar, dist));
  return vec4(toLinear(mix(edgeLook.colour, hazed, exp(mist.negate()))), 1);
};

/** What the sea's look is made from, beside the tiles themselves. */
export interface SeaParts {
  /** The detail band, or null to draw the boat band alone. */
  detail: DetailNodes | null;
  /** Whether the shimmer stands in for the ripples the detail band leaves out. */
  shimmer: boolean;
  /** The foam's pattern and noise (pattern.ts). */
  pattern: Texture;
  /** The foam map at a scene point (foammap.ts): the boats' white water and the track; or null without it. */
  wakes: ((p: Node<'vec2'>) => Node<'vec2'>) | null;
  /** The wake's waves (wakewaves.ts), or null without them. */
  wakeWaves: WakeWavesNodes | null;
  /** The rain's share at a scene point (water.ts), 0 to 1, or null without it. */
  rain: ((p: Node<'vec2'>) => Node<'float'>) | null;
}

/**
 * What rain does to the water, at its fullest: the ripples flatten by flat,
 * a breeze's whitecaps go (RAIN_CUT), the colour goes toward its grey by
 * grey, and pocks of drops roughen it within pockReach m of the eye, pock
 * deep.
 */
export const RAIN_LOOK = { flat: 0.55, grey: 0.35, pock: 0.05, pockReach: 60, pockSize: 1.3 };

/** The rain's share at a scene point, or none. */
const rainHere = (parts: SeaParts, p: Node<'vec2'>): Node<'float'> =>
  (parts.rain === null ? float(0) : parts.rain(p)) as Node<'float'>;

/** A colour gone toward its own grey by share. */
const greyed = (c: Node<'vec3'>, share: Node<'float'>): Node<'vec3'> =>
  mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), share) as Node<'vec3'>;

/** The pocks of drops on the water at a scene point: a fine noise of the pattern, flickering, as slopes. */
const pocks = (parts: SeaParts, p: Node<'vec2'>): Node<'vec2'> => {
  const a = texture(
    parts.pattern,
    p.div(RAIN_LOOK.pockSize).add(vec2(seaTime.mul(0.71), seaTime.mul(0.37))),
  );
  const b = texture(
    parts.pattern,
    p.div(RAIN_LOOK.pockSize * 0.7).sub(vec2(seaTime.mul(0.53), seaTime.mul(0.91))),
  );
  return vec2(a.y.sub(b.w), a.w.sub(b.y)) as Node<'vec2'>;
};

/**
 * What the sea's material reads of the wake's waves: at a fragment (dist
 * metres from the eye), and at a tile's centre averaged over a tile; each
 * vec4(the slope along x and z, the convergence, the height in metres),
 * drawn. And whether a point is near enough the waves' square to read them.
 */
export interface WakeWavesNodes {
  fine(p: Node<'vec2'>, dist?: Node<'float'>): Node<'vec4'>;
  coarse(p: Node<'vec2'>): Node<'vec4'>;
  covers(p: Node<'vec2'>, margin: number): Node<'bool'>;
}

/** What a probe reads of a tile's fragment instead of its colour (the tests). */
export type Probe = 'detail' | 'foam' | 'crest' | 'gust' | 'ground' | 'wake';

/**
 * The tiles' fragment colour. With a probe, the fragment's numbers instead:
 * 'detail' gives vec4(the whole tile's tilt along x and z, the tile's own
 * ripples' slope along x and z); 'foam' vec4(the foam's cover with its
 * margin, its amount, the whitecaps' part, the streaks' part); 'crest'
 * vec4(the boat band's height in half significant heights, the detail's
 * height, how near the rim, the boats' white water's cover); 'gust'
 * vec4(the gust on the tile as it shows, its gust and its lull, 1);
 * 'ground' vec4(the water's depth, the waves' cap, the surf's amount, the
 * lee); 'wake' vec4(the boats' white water's amount, the track's churn, the
 * wake's waves' height and the size of their slope as drawn).
 */
export function tileLook(v: TileVaryings, parts: SeaParts, probe?: Probe): Node<'vec4'> {
  const detail = parts.detail;
  // Once a tile, in the vertex stage: the same for every fragment of it.
  const whole = detail === null ? null : (varying(detail.coarse(v.centre)) as Node<'vec4'>);
  return Fn(() => {
    // No water inside a hull.
    hulls.cut(positionWorld, v.nearHull);
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
    const map = (parts.wakes === null ? vec2(0) : parts.wakes(positionWorld.xz)).toVar();
    const white = map.x;
    const churn = map.y;

    // The short sea heaps up with the wind's force.
    tilt.mulAssign(detailSteep);
    ripple.mulAssign(detailSteep);
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
    // The track is smooth: the wind's ripples flattened in it.
    ripple.mulAssign(float(1).sub(churn.mul(TRACK.smooth)));
    // Rain flattens the ripples and pocks the water near the eye.
    const rain = rainHere(parts, positionWorld.xz).toVar();
    ripple.mulAssign(float(1).sub(rain.mul(RAIN_LOOK.flat)));
    const pockNear = float(1).sub(
      smoothstep(
        RAIN_LOOK.pockReach * 0.5,
        RAIN_LOOK.pockReach,
        length(cameraPosition.sub(positionWorld)),
      ),
    );
    ripple.addAssign(pocks(parts, positionWorld.xz).mul(rain.mul(pockNear).mul(RAIN_LOOK.pock)));
    // In the lee the wind raises less: smaller ripples, fewer whitecaps.
    const lee = clamp(v.lee, 0, 1.3);
    ripple.mulAssign(lee);
    // The wake's waves, as they are: the tile's tilt, its own ripples
    // faded to its rim, and the light of their crests. Read only on the
    // tiles of the waves' square (the same for all of a tile), and added at
    // once, so that little of them is held through the rest.
    const ww = parts.wakeWaves;
    const wakeHeight = float(0).toVar();
    const wakeSlope = float(0).toVar();
    if (ww !== null) {
      const centre = positionWorld.xz.sub(e);
      If(ww.covers(centre, TILE_APOTHEM * 1.2), () => {
        const whole = ww.coarse(centre);
        const here = ww.fine(positionWorld.xz, dist);
        tilt.addAssign(whole.xy);
        ripple.addAssign(here.xy.mul(inner));
        const [tileLift, fragmentLift] = SEA_LOOK.lift as [number, number];
        lift.addAssign(
          whole.w
            .mul(tileLift)
            .add(here.w.mul(fragmentLift).mul(inner))
            .mul(1 / DETAIL.height),
        );
        wakeHeight.assign(here.w);
        if (probe === 'wake') {
          wakeSlope.assign(length(here.xy));
        }
      });
    }
    const ground = v.ground;
    const breaking = surf(ground.x, ground.y, ground.w, v.area.w, v.period, lee).toVar();
    const slope = v.plane.yz.add(tilt).add(ripple);
    const N = normalize(vec3(slope.x.negate(), 1, slope.y.negate())).toVar();
    const top = v.side.greaterThan(-0.5);
    If(top.not(), () => {
      N.assign(normalize(vec3(e.x, 0, e.y)));
    });
    const crest = crestHeight(v.plane.w, v.area.w);
    const lightened = lightening(crestLit(v.plane.w, v.area.w), lift);
    const foam: FoamParts = {
      // Rain takes a breeze's whitecaps away, not a gale's.
      area: vec3(rainKept(v.area.x, rain).mul(lee), v.area.yz) as unknown as Node<'vec3'>,
      crest,
      detail: lift,
      lightened,
      folding,
      pattern,
      streak,
      boats: breaking.add(drainLines(positionWorld.xz)) as unknown as Node<'float'>,
    };
    const amount = foamAmount(foam).toVar();
    const cover = foamCover(amount, pattern).mul(foamMargin(fade)).toVar();
    const whiteCover = wakeCover(white, pattern).mul(foamMargin(fade)).toVar();
    if (probe === 'detail') {
      return vec4(tilt, ripple);
    }
    if (probe === 'foam') {
      return vec4(cover, amount, whitecaps(foam), streaks(foam));
    }
    if (probe === 'crest') {
      return vec4(crest, lift, rim, whiteCover);
    }
    if (probe === 'wake') {
      return vec4(white, churn, wakeHeight, wakeSlope);
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
      // The bubbles under the track lighten it toward the water's scattering colour.
      col.assign(mix(col, look.scatter, churn.mul(TRACK.bubbles)));
      col.assign(greyed(col, rain.mul(RAIN_LOOK.grey)));
      col.assign(mix(col, foamColour(N), cover.mul(FOAM.cover)));
      col.assign(mix(col, wakeColour(N, white), whiteCover.mul(FOAM.cover)));
      // The panel's overlay, where asked for.
      const up = clamp(wakeHeight.mul(20), -1, 1);
      const shown = select(
        wakeOverlay.lessThan(1.5),
        vec3(max(up, 0), 0, max(up.negate(), 0)),
        vec3(0, churn, 0),
      );
      col.assign(mix(col, shown, select(wakeOverlay.greaterThan(0.5), float(0.7), float(0))));
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
    return finish(col, dist, v.mist);
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
  /** The band's mist from the camera to the vertex. */
  mist: Node<'float'>;
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
    cutAtLip(positionWorld);
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
    const rain = rainHere(parts, at);
    ripple.mulAssign(lee.mul(float(1).sub(rain.mul(RAIN_LOOK.flat))).mul(detailSteep));
    const slope = plane.yz.add(ripple);
    const N = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
    const crest = crestHeight(plane.w, area.w);
    const lightened = lightening(crestLit(plane.w, area.w), lift);
    const g = v.ground;
    const foam: FoamParts = {
      area: vec3(rainKept(area.x, rain).mul(lee), area.yz) as unknown as Node<'vec3'>,
      crest,
      detail: lift,
      lightened,
      folding,
      pattern,
      streak,
      boats: surf(g.x, g.y, g.w, area.w, v.period, lee).add(
        drainLines(at),
      ) as unknown as Node<'float'>,
    };
    const cover = foamCover(foamAmount(foam), pattern);
    const col = mix(
      greyed(
        shallows(water({ normal: N, crest: lightened, glint: 1 }, normalize(toEye)), g.x, g.w),
        rain.mul(RAIN_LOOK.grey),
      ),
      foamColour(N),
      cover.mul(FOAM.cover),
    );
    return finish(col, dist, v.mist);
  })() as unknown as Node<'vec4'>;
}
