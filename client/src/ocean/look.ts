// SPDX-License-Identifier: AGPL-3.0-only

// The numbers of the sea's look: what only the drawing reads. The detail
// band's patches and loops, the baked field of the low tier, and what the
// foam does by wind speed, a row for each Beaufort force. They are tuned by
// eye and are not kinds: the server reads none of them, so they live here
// and not in the catalog, whose every change is a change of the world.

/** One knot, in m/s. */
export const KNOT = 1852 / 3600;

/** Changed by hand whenever the tiers' values change: what a phone remembered of an older build's is let go. */
export const QUALITY_VERSION = 2;

/** The detail band: the waves shorter than the boat band's shortest, drawn and never felt. */
export const DETAIL = {
  /**
   * The side of the patch the band repeats over, in metres. The tile rows
   * are 4 m apart, so a patch of 32 m would repeat every eighth row exactly;
   * no two tile centres within 40 tiles of each other are a whole number of
   * 41 m patches apart to within 0.25 m.
   */
  patch: 41,
  /** The side of the second, finer patch, in metres: ripples of 6 to 32 cm, for the glitter. */
  finePatch: 7.3,
  /** The band repeats in time every this many seconds: every frequency is a whole multiple of 2π over it. */
  period: 128,
  /** The second patch carries no wave longer than this, in metres. */
  fineLongest: 1,
  /** The whole-tile tilt reads the detail averaged over about this many metres. */
  tileTexel: 2.5,
  /** The patch's inputs follow the sea under the boat over about this long, in seconds. */
  ease: 2,
  /** How fast foam spreads as it disperses, m²/s. */
  spread: 0.15,
  /**
   * The band's height is drawn over this many metres, not over its own
   * spread: a calm's ripples barely lighten the water, a gale's heaped
   * short sea does. About three standard deviations of its height in a
   * near gale.
   */
  height: 0.25,
} as const;

/** The low tier's detail: a short loop of the same band, made once on the device. */
export const BAKED = {
  /** Texels a side, over the detail's patch. */
  size: 64,
  /** Frames in the loop, and its length in seconds. */
  frames: 32,
  period: 8,
  /** The shortest wave it holds, in metres: at four frames a second, the shortest two frames can carry. */
  shortest: 2,
  /** The winds its two fields are made for, in knots; between them the fields are mixed. */
  winds: [6, 20],
  /** Texels a side of the field the whole-tile tilt reads. */
  coarse: 16,
  /** The fetch its fields are made for, in nautical miles: open water's. */
  fetch: 6,
} as const;

/** What the foam, and the water with it, does at a wind speed. */
export interface FoamLook {
  /**
   * Whitecaps on the boat band's crests, from 0. Up to 1 they come on the
   * highest crests; above 1 they reach down the crests too, so that more of
   * the sea breaks.
   */
  whitecaps: number;
  /** Streaks of foam down the wind, from 0: above 1 dense, and in patches. */
  streaks: number;
  /** Foam where the detail band folds, 0 to 1. */
  folding: number;
  /** The surface folds where the Jacobian of its horizontal shift falls below this. */
  threshold: number;
  /** How far the detail band's crests are sharpened: the shift's scale. */
  chop: number;
  /** How long folded foam lasts, in seconds. */
  decay: number;
  /** How much steeper the detail band is drawn than its spectrum: the short sea heaped up. */
  steep: number;
  /** Spray torn off the breaking crests: drops a crest a second, 0 for none. */
  spray: number;
  /** Spindrift: low streaks of spray blown along the water, 0 for none. */
  spindrift: number;
}

/** A Beaufort force: the wind it begins at, in knots (Met Office, Beaufort wind force scale). */
export const BEAUFORT_FROM = [0, 1, 4, 7, 11, 17, 22, 28, 34, 41, 48] as const;

/** The top force's row is read at this wind, in knots, where force 10 ends, and holds above it. */
export const FOAM_TOP_KNOTS = 55;

/**
 * The foam by Beaufort force, 0 to 10. A sailor reads the force from the
 * water whatever its fetch (Met Office, Beaufort wind force scale):
 * scattered white horses from force 3, frequent at 4, many at 5,
 * everywhere at 6; at 7 the sea heaps up and foam is blown in streaks; at 8
 * spindrift begins to be seen and the streaks are well marked; at 9 dense
 * streaks and spray that may affect visibility; at 10 the sea takes on a
 * white appearance. The drawn cover is about a sixth of Monahan and
 * O'Muircheartaigh's (1980) up to force 5, as a look, and rises toward it
 * from force 6: about half of it at 8, all of it at 10. The detail band is
 * drawn steeper by force, its rms slope 2.5 times force 2's at force 8.
 */
export const FOAM_BY_FORCE: readonly FoamLook[] = (
  [
    // whitecaps, streaks, folding, threshold, chop, decay, steep, spray, spindrift
    [0, 0, 0, 0.4, 0.6, 1.5, 1, 0, 0],
    [0, 0, 0, 0.4, 0.6, 1.5, 1, 0, 0],
    [0, 0, 0, 0.4, 0.6, 1.5, 1, 0, 0],
    [0.08, 0, 0.5, 0.4, 0.7, 1.8, 1, 0, 0],
    [0.25, 0, 0.8, 0.48, 0.8, 2.0, 1.06, 0, 0],
    [0.7, 0, 1.0, 0.66, 0.95, 2.8, 1.15, 0, 0],
    [1.1, 0, 1.0, 0.69, 1.15, 3.3, 1.33, 0, 0],
    [1.6, 0.5, 1.0, 0.71, 1.2, 3.8, 1.54, 1, 0],
    [2.0, 0.75, 1.0, 0.72, 1.3, 4.2, 1.74, 3, 1],
    [2.6, 1.0, 1.0, 0.74, 1.45, 4.6, 1.85, 8, 2],
    [3.6, 1.5, 1.0, 0.76, 1.6, 5.0, 1.95, 20, 4],
  ] as const
).map(([whitecaps, streaks, folding, threshold, chop, decay, steep, spray, spindrift]) => ({
  whitecaps,
  streaks,
  folding,
  threshold,
  chop,
  decay,
  steep,
  spray,
  spindrift,
}));

const FIELDS = [
  'whitecaps',
  'streaks',
  'folding',
  'threshold',
  'chop',
  'decay',
  'steep',
  'spray',
  'spindrift',
] as const;
/** The strengths: each is nothing below the force its row first has it at. */
const ONSET: ReadonlySet<string> = new Set([
  'whitecaps',
  'streaks',
  'folding',
  'spray',
  'spindrift',
]);
const TOP = FOAM_BY_FORCE.length - 1;

/**
 * The wind a force's row is read at, in knots: the middle of the force. The
 * top row is read where its force ends, and holds above.
 */
export function forceKnots(force: number): number {
  if (force >= TOP) {
    return FOAM_TOP_KNOTS;
  }
  const from = BEAUFORT_FROM[force] as number;
  // A force ends a knot below the next one's beginning.
  return (from + (BEAUFORT_FROM[force + 1] as number) - 1) / 2;
}

/** The Beaufort force of a wind in knots, 0 to 10. */
export function beaufort(knots: number): number {
  let force = 0;
  for (let f = 1; f < BEAUFORT_FROM.length; f++) {
    if (knots >= (BEAUFORT_FROM[f] as number)) {
      force = f;
    }
  }
  return force;
}

/**
 * The foam at a wind speed in knots, written into out: between two forces'
 * rows by how far the wind is between their middles. A strength a row is
 * the first to have begins at nothing where that row's force begins.
 */
export function foamAt(knots: number, out: FoamLook): FoamLook {
  let lo = 0;
  for (let f = 1; f <= TOP; f++) {
    if (knots >= forceKnots(f)) {
      lo = f;
    }
  }
  const hi = Math.min(lo + 1, TOP);
  const a = FOAM_BY_FORCE[lo] as FoamLook;
  const b = FOAM_BY_FORCE[hi] as FoamLook;
  const from = forceKnots(lo);
  const to = forceKnots(hi);
  const t = to > from ? Math.min(Math.max((knots - from) / (to - from), 0), 1) : 0;
  for (const k of FIELDS) {
    if (ONSET.has(k) && a[k] === 0 && b[k] > 0) {
      const begins = BEAUFORT_FROM[hi] as number;
      out[k] = knots <= begins ? 0 : (b[k] * (knots - begins)) / (to - begins);
    } else {
      out[k] = a[k] + (b[k] - a[k]) * t;
    }
  }
  return out;
}

/** A foam look of nothing, to write into. */
export function newFoamLook(): FoamLook {
  return {
    whitecaps: 0,
    streaks: 0,
    folding: 0,
    threshold: 0.4,
    chop: 0.6,
    decay: 1.5,
    steep: 1,
    spray: 0,
    spindrift: 0,
  };
}

/**
 * How much of the whitecaps rain takes away, 0 to 1, by their strength:
 * all of them up to force 4's, none from force 6's. Rain damps the short
 * waves and a moderate breeze's white horses with them; it does not stop
 * a gale's crests from breaking.
 */
export const RAIN_CUT = {
  /** Whitecaps of force 4's strength and less go wholly under heavy rain. */
  from: 0.25,
  /** From force 6's strength none go. */
  to: 1.0,
} as const;

/**
 * The share of the sea whitecaps cover at a wind 10 m up, in m/s: Monahan
 * and O'Muircheartaigh's fit (1980), W = 3.84 × 10⁻⁶ U₁₀^3.41. The foam drawn
 * is a look and covers several times this; the tests record both.
 */
export function whitecapCoverage(speed: number): number {
  return 3.84e-6 * Math.max(speed, 0) ** 3.41;
}

/** How the foam is laid on the water. */
export const FOAM = {
  /** Whitecaps come where the crest's height, in half significant heights, passes from the first to the second. */
  crest: [0.75, 1.5],
  /**
   * Whitecaps stronger than 1 begin this much lower down the crest for each
   * unit over, to no lower than the second: a storm's sea breaks over more
   * of each crest, not only at its top.
   */
  crestReach: [0.15, 0.25],
  /** How much the detail band's height adds to the boat band's for the whitecaps. */
  crestDetail: 0.35,
  /** Streaks are this many times longer down the wind than across it. */
  streakStretch: 13,
  /** Foam covers a tile's middle and fades by this share over this span of the rim's fade. */
  margin: [0.55, 0.85, 0.8],
  /** The foam's colour, display values, and how much of the water it hides at most. */
  colour: [0.94, 0.96, 0.95],
  cover: 0.92,
  /** The pattern's side in texels and in metres: it repeats every so far. */
  patternSize: 256,
  patternSpan: 43,
} as const;

/** The wake and the foam about a hull. */
export const WAKE = {
  /** The foam map's side, in metres: a square that follows the boat. */
  span: 256,
  /** A wake fades over this long, in seconds. */
  decay: 6,
  /** How fast it widens as it fades, m²/s. */
  spread: 0.08,
  /** A boat lays a full wake from this speed up, m/s. */
  fullSpeed: 3,
  /** The half-angle of the wake's arms: arcsin ⅓ (Thomson, "On ship waves", 1887). */
  kelvin: Math.asin(1 / 3),
  /** Another boat's speed is its drawn position's change, smoothed over this long, in seconds. */
  speedEase: 0.5,
} as const;

/** Spray: sprites thrown from the bow, and torn off the crests from force 7. */
export const SPRAY = {
  /** The bow throws spray when the sea rises against it faster than this, m/s. */
  rise: 0.2,
  /** No spray from a boat slower than this, m/s. */
  minSpeed: 1,
  /** A drop lives about this long, in seconds. */
  life: 1,
  /** Crests within this distance of the camera throw it, in metres. */
  crestReach: 60,
  /** A crest throws spray where it stands this high, in half significant heights. */
  crestFrom: 0.7,
  /** The bow's spray grows with the sea's significant height: so much more a metre of it, at most most times. */
  perHeight: 1,
  most: 3,
} as const;

/**
 * The chase camera in a big sea: a share of the boat's pitch and roll
 * (their swing about their own mean, so a steady heel does not tilt the
 * horizon), nothing under from metres of significant height, rising to
 * pitch and roll at full, low-passed over smooth seconds. Above quick
 * metres the camera follows the boat's heave over heave seconds, not its
 * usual half second.
 */
export const SEA_MOTION = {
  from: 0.4,
  full: 2,
  pitch: 0.2,
  roll: 0.12,
  smooth: 0.4,
  /** The mean the swing is taken about follows over this long, in seconds. */
  mean: 4,
  quick: 1,
  heave: 0.3,
} as const;
