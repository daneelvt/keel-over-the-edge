// SPDX-License-Identifier: AGPL-3.0-only

// The numbers of the sea's look: what only the drawing reads. The detail
// band's patches and loops, the baked field of the low tier, and what the
// foam does by wind speed, a row for each Beaufort force. They are tuned by
// eye and are not kinds: the server reads none of them, so they live here
// and not in the catalog, whose every change is a change of the world.

/** One knot, in m/s. */
export const KNOT = 1852 / 3600;

/** Changed by hand whenever the tiers' values change: what a phone remembered of an older build's is let go. */
export const QUALITY_VERSION = 1;

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

/** What the foam does at a wind speed. */
export interface FoamLook {
  /** Whitecaps on the boat band's crests, 0 to 1. */
  whitecaps: number;
  /** Streaks of foam down the wind, 0 to 1. */
  streaks: number;
  /** Foam where the detail band folds, 0 to 1. */
  folding: number;
  /** The surface folds where the Jacobian of its horizontal shift falls below this. */
  threshold: number;
  /** How far the detail band's crests are sharpened: the shift's scale. */
  chop: number;
  /** How long folded foam lasts, in seconds. */
  decay: number;
}

/** A Beaufort force: the wind it begins at, in knots (Met Office, Beaufort wind force scale). */
export const BEAUFORT_FROM = [0, 1, 4, 7, 11, 17, 22, 28, 34, 41] as const;

/**
 * The foam by Beaufort force, 0 to 9. A sailor reads the force from the
 * water (NOAA, Beaufort scale with sea criteria): scattered whitecaps from
 * force 3, frequent at 4, many at 5, everywhere at 6, foam blown in streaks
 * from 7, in long streaks at 8.
 */
export const FOAM_BY_FORCE: readonly FoamLook[] = [
  { whitecaps: 0, streaks: 0, folding: 0, threshold: 0.4, chop: 0.6, decay: 1.5 },
  { whitecaps: 0, streaks: 0, folding: 0, threshold: 0.4, chop: 0.6, decay: 1.5 },
  { whitecaps: 0, streaks: 0, folding: 0, threshold: 0.4, chop: 0.6, decay: 1.5 },
  { whitecaps: 0.08, streaks: 0, folding: 0.5, threshold: 0.4, chop: 0.7, decay: 1.8 },
  { whitecaps: 0.25, streaks: 0, folding: 0.8, threshold: 0.48, chop: 0.8, decay: 2.0 },
  { whitecaps: 0.7, streaks: 0, folding: 1.0, threshold: 0.66, chop: 0.95, decay: 2.8 },
  { whitecaps: 0.85, streaks: 0, folding: 1.0, threshold: 0.69, chop: 1.0, decay: 3.3 },
  { whitecaps: 0.95, streaks: 0.4, folding: 1.0, threshold: 0.71, chop: 1.05, decay: 3.8 },
  { whitecaps: 1.0, streaks: 0.75, folding: 1.0, threshold: 0.72, chop: 1.1, decay: 4.0 },
  { whitecaps: 1.0, streaks: 0.75, folding: 1.0, threshold: 0.72, chop: 1.1, decay: 4.0 },
];

const FIELDS = ['whitecaps', 'streaks', 'folding', 'threshold', 'chop', 'decay'] as const;
/** The strengths: each is nothing below the force its row first has it at. */
const ONSET: ReadonlySet<string> = new Set(['whitecaps', 'streaks', 'folding']);
const TOP = FOAM_BY_FORCE.length - 2;

/**
 * The wind a force's row is read at, in knots: the middle of the force. The
 * top rows hold from where force 8 begins, the gale the look was chosen in.
 */
export function forceKnots(force: number): number {
  if (force >= TOP) {
    return BEAUFORT_FROM[TOP] as number;
  }
  const from = BEAUFORT_FROM[force] as number;
  // A force ends a knot below the next one's beginning.
  return (from + (BEAUFORT_FROM[force + 1] as number) - 1) / 2;
}

/** The Beaufort force of a wind in knots, 0 to 9. */
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
  return { whitecaps: 0, streaks: 0, folding: 0, threshold: 0.4, chop: 0.6, decay: 1.5 };
}

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

/** Spray: sprites thrown from the bow, and blown off the crests in a gale. */
export const SPRAY = {
  /** The bow throws spray when the sea rises against it faster than this, m/s. */
  rise: 0.2,
  /** No spray from a boat slower than this, m/s. */
  minSpeed: 1,
  /** A drop lives about this long, in seconds. */
  life: 1,
  /** Spray is blown off the crests from this force up. */
  crestForce: 8,
  /** Crests within this distance of the camera throw it, in metres. */
  crestReach: 60,
} as const;
