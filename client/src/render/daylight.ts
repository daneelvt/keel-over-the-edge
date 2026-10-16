// SPDX-License-Identifier: AGPL-3.0-only

// The light of the hour: one table, keyed by the sun's true height at the
// boat, read between its rows each frame. It gives the sky's colours and
// the glow at the horizon toward the sun, the main light and the
// hemisphere's, the sea's colours and its wide highlight, the haze, the
// clouds, the sail's glow, how faint a star still shows, and whether the
// lanterns are lit. Every colour in the scene comes from these, so this is
// the one writer of the day and the night.
//
// By day the main light is the sun. Once the sun is down it is the moon,
// by its lit share and its height, and never both. A moonless night keeps
// a floor of light from the hemisphere, so the boat, its sail and the
// sea's tiles can always be read.
//
// Colours are display (sRGB-encoded) values, as an artist picks them. The
// numbers are a look, tuned by eye, read by no rule of the game.

export type Rgb = readonly [number, number, number];

export interface Light {
  /** The sun's true height at the top of this row's span, in degrees. */
  height: number;
  skyTop: Rgb;
  skyHorizon: Rgb;
  /** The glow at the horizon toward the sun, and its strength. */
  glow: Rgb;
  glowStrength: number;
  /** The sun's colour, as a light and as its disc, and the light's strength. */
  sunColour: Rgb;
  sunLight: number;
  /** The moon's light at its fullest and highest: none while the sun is up. */
  moonLight: number;
  /** The light from the sky and from the sea below. */
  hemiSky: Rgb;
  hemiGround: Rgb;
  hemiLight: number;
  /** Deep water, and the light scattered through thin water. */
  deep: Rgb;
  scatter: Rgb;
  /** The main light's wide highlight on the water: its power and its strength. */
  broadPower: number;
  broadStrength: number;
  /** The sea blends toward the horizon's colour from here to there, in metres. */
  hazeNear: number;
  hazeFar: number;
  /**
   * The visual range, m: solid things (land, boats) keep exp(−3.912 d / V)
   * of their contrast against the horizon at d metres, 2% at V
   * (Koschmieder 1924).
   */
  visualRange: number;
  /** The clouds' colour. */
  cloud: Rgb;
  /** The sail's glow on its shaded side, light through flax. */
  sailGlow: Rgb;
  /** How pale the moon's disc is against the sky: 1 by night. */
  moonDisc: number;
  /** The faintest star that shows, as a magnitude: below -2, none. */
  starLimit: number;
  /** The lanterns: 0 dull brass and glass, 1 lit. */
  lanterns: number;
}

const DAY: Light = {
  height: 90,
  skyTop: [0.25, 0.48, 0.78],
  skyHorizon: [0.78, 0.86, 0.9],
  glow: [1, 0.72, 0.45],
  glowStrength: 0,
  sunColour: [1.0, 0.95, 0.85],
  sunLight: 2.6,
  moonLight: 0,
  hemiSky: [0.78, 0.86, 0.9],
  hemiGround: [0.06, 0.25, 0.32],
  hemiLight: 1.1,
  deep: [0.02, 0.16, 0.25],
  scatter: [0.07, 0.48, 0.5],
  broadPower: 14,
  broadStrength: 0.22,
  hazeNear: 220,
  hazeFar: 1000,
  visualRange: 6000,
  cloud: [0.97, 0.96, 0.93],
  sailGlow: [0.68, 0.665, 0.634],
  moonDisc: 0.3,
  starLimit: -3,
  lanterns: 0,
};

/** The colour of the moon's light, and of its lit face. */
export const MOON_COLOUR: Rgb = [0.72, 0.8, 0.95];

/**
 * The rows, from the highest sun to the lowest. Between two rows every
 * value is read in proportion; above the first, the first; below the
 * last, the last.
 */
export const LIGHT_TABLE: readonly Light[] = [
  DAY,
  {
    ...DAY,
    height: 10,
  },
  {
    // A low sun: the horizon warming toward it, the light warmer and weaker,
    // the widest highlight on the water.
    ...DAY,
    height: 3,
    skyTop: [0.23, 0.42, 0.7],
    skyHorizon: [0.72, 0.74, 0.72],
    glowStrength: 0.12,
    sunColour: [1.0, 0.82, 0.6],
    sunLight: 1.9,
    hemiSky: [0.72, 0.76, 0.8],
    hemiGround: [0.06, 0.22, 0.28],
    hemiLight: 0.95,
    deep: [0.02, 0.15, 0.23],
    scatter: [0.07, 0.43, 0.45],
    broadPower: 8,
    broadStrength: 0.22,
    cloud: [0.95, 0.88, 0.8],
    sailGlow: [0.62, 0.59, 0.53],
  },
  {
    // The sun's last degree: a warm band at the horizon, the zenith deepening.
    ...DAY,
    height: 1,
    skyTop: [0.17, 0.3, 0.55],
    skyHorizon: [0.7, 0.62, 0.55],
    glowStrength: 0.2,
    sunColour: [1.0, 0.62, 0.36],
    sunLight: 1.0,
    hemiSky: [0.58, 0.58, 0.62],
    hemiGround: [0.05, 0.18, 0.23],
    hemiLight: 0.75,
    deep: [0.02, 0.12, 0.19],
    scatter: [0.06, 0.32, 0.35],
    broadPower: 6,
    broadStrength: 0.2,
    hazeNear: 200,
    hazeFar: 950,
    cloud: [0.88, 0.7, 0.6],
    sailGlow: [0.52, 0.47, 0.41],
  },
  {
    // Sunset and sunrise: the lanterns are lit.
    ...DAY,
    height: 0,
    skyTop: [0.13, 0.22, 0.44],
    skyHorizon: [0.6, 0.5, 0.45],
    glowStrength: 0.2,
    sunColour: [1.0, 0.55, 0.3],
    sunLight: 0.35,
    hemiSky: [0.5, 0.5, 0.56],
    hemiGround: [0.04, 0.14, 0.19],
    hemiLight: 0.6,
    deep: [0.018, 0.1, 0.16],
    scatter: [0.05, 0.26, 0.29],
    broadPower: 6,
    broadStrength: 0.18,
    hazeNear: 190,
    hazeFar: 900,
    cloud: [0.7, 0.55, 0.5],
    sailGlow: [0.43, 0.39, 0.35],
    moonDisc: 0.45,
    lanterns: 1,
  },
  {
    // Dusk and dawn: a fading glow where the sun went, the rest deep blue,
    // and the brightest stars.
    ...DAY,
    height: -3,
    skyTop: [0.06, 0.1, 0.24],
    skyHorizon: [0.32, 0.3, 0.36],
    glowStrength: 0.12,
    sunColour: [1.0, 0.55, 0.3],
    sunLight: 0,
    moonLight: 0.35,
    hemiSky: [0.4, 0.44, 0.54],
    hemiGround: [0.07, 0.12, 0.16],
    hemiLight: 0.45,
    deep: [0.016, 0.075, 0.12],
    scatter: [0.035, 0.17, 0.2],
    broadPower: 6,
    broadStrength: 0.15,
    hazeNear: 180,
    hazeFar: 850,
    cloud: [0.32, 0.3, 0.36],
    sailGlow: [0.3, 0.28, 0.28],
    moonDisc: 0.75,
    starLimit: -1,
    lanterns: 1,
  },
  {
    // The end of dusk: a third of the day's sea, the horizon still plain.
    ...DAY,
    height: -6,
    skyTop: [0.03, 0.05, 0.12],
    skyHorizon: [0.17, 0.18, 0.24],
    glowStrength: 0.05,
    sunColour: [1.0, 0.55, 0.3],
    sunLight: 0,
    moonLight: 0.5,
    hemiSky: [0.36, 0.42, 0.54],
    hemiGround: [0.065, 0.11, 0.15],
    hemiLight: 0.34,
    deep: [0.014, 0.065, 0.105],
    scatter: [0.025, 0.13, 0.15],
    broadPower: 6,
    broadStrength: 0.13,
    hazeNear: 170,
    hazeFar: 800,
    cloud: [0.14, 0.15, 0.19],
    sailGlow: [0.22, 0.21, 0.21],
    moonDisc: 0.95,
    starLimit: 3.5,
    lanterns: 1,
  },
  {
    // Late dusk: near night, a last pale edge, every star out.
    ...DAY,
    height: -9,
    skyTop: [0.015, 0.025, 0.06],
    skyHorizon: [0.1, 0.12, 0.17],
    glowStrength: 0.02,
    sunColour: [1.0, 0.55, 0.3],
    sunLight: 0,
    moonLight: 0.55,
    hemiSky: [0.35, 0.42, 0.55],
    hemiGround: [0.06, 0.105, 0.145],
    hemiLight: 0.29,
    deep: [0.013, 0.06, 0.1],
    scatter: [0.022, 0.11, 0.13],
    broadPower: 6,
    broadStrength: 0.12,
    hazeNear: 160,
    hazeFar: 750,
    cloud: [0.08, 0.09, 0.12],
    sailGlow: [0.2, 0.2, 0.2],
    moonDisc: 1,
    starLimit: 5.5,
    lanterns: 1,
  },
  {
    // Night: near black to a dark blue-grey horizon, the sea a sixth to a
    // third of the day's, the floor of light that keeps a moonless night
    // readable. The deep water is no darker than WebGL 2's 8-bit scene
    // buffer can hold, or it would turn to black.
    ...DAY,
    height: -12,
    skyTop: [0.01, 0.015, 0.035],
    skyHorizon: [0.07, 0.09, 0.13],
    glowStrength: 0,
    sunColour: [1.0, 0.55, 0.3],
    sunLight: 0,
    moonLight: 0.6,
    hemiSky: [0.35, 0.42, 0.55],
    hemiGround: [0.06, 0.1, 0.14],
    hemiLight: 0.26,
    deep: [0.012, 0.055, 0.095],
    scatter: [0.02, 0.1, 0.12],
    broadPower: 6,
    broadStrength: 0.12,
    hazeNear: 150,
    hazeFar: 700,
    cloud: [0.05, 0.06, 0.08],
    sailGlow: [0.19, 0.19, 0.19],
    moonDisc: 1,
    starLimit: 5.5,
    lanterns: 1,
  },
];

/** The table's values, read at a sun's height, as plain numbers and colours. */
export type LightValues = {
  -readonly [K in keyof Light]: Light[K] extends Rgb ? number[] : number;
};

export function newLightValues(): LightValues {
  const v = {} as Record<string, number | number[]>;
  for (const [k, x] of Object.entries(DAY)) {
    v[k] = Array.isArray(x) ? [...x] : 0;
  }
  return v as LightValues;
}

const KEYS = Object.keys(DAY) as (keyof Light)[];

/** Reads the table at a sun's true height, in degrees, into out. Allocates nothing. */
export function readLight(
  height: number,
  out: LightValues,
  table: readonly Light[] = LIGHT_TABLE,
): LightValues {
  let i = 0;
  while (i < table.length - 1 && height < (table[i + 1] as Light).height) {
    i++;
  }
  const a = table[i] as Light;
  const b = table[Math.min(i + 1, table.length - 1)] as Light;
  const span = a.height - b.height;
  const f = span > 0 ? Math.min(Math.max((a.height - height) / span, 0), 1) : 0;
  const o = out as unknown as Record<string, number | number[]>;
  for (const k of KEYS) {
    const x = a[k];
    const y = b[k];
    if (typeof x === 'number' && typeof y === 'number') {
      o[k] = x + (y - x) * f;
    } else {
      const into = o[k] as number[];
      const xa = x as Rgb;
      const ya = y as Rgb;
      for (let c = 0; c < 3; c++) {
        into[c] = (xa[c] as number) + ((ya[c] as number) - (xa[c] as number)) * f;
      }
    }
  }
  out.height = height;
  return out;
}

/** Which body is the main light, and how strong: the sun above the horizon, else the moon. */
export interface MainLight {
  body: 'sun' | 'moon';
  /** The light's strength, and its colour (display values). */
  strength: number;
  colour: number[];
}

const DEG = Math.PI / 180;

/** The moon's light grows from nothing at the horizon to its full over this height, in radians. */
const MOON_RISE = 8 * DEG;

/**
 * The main light: the sun while it is above the true horizon, otherwise
 * the moon, by its lit share (0 new, 1 full) and its height; heights in
 * radians. Never both.
 */
export function mainLight(
  v: LightValues,
  sunHeight: number,
  moonHeight: number,
  lit: number,
  out: MainLight,
): MainLight {
  if (sunHeight > 0) {
    out.body = 'sun';
    out.strength = v.sunLight;
    for (let c = 0; c < 3; c++) {
      out.colour[c] = v.sunColour[c] ?? 0;
    }
    return out;
  }
  out.body = 'moon';
  const up = Math.min(Math.max(moonHeight / MOON_RISE, 0), 1);
  out.strength = v.moonLight * lit * up * up * (3 - 2 * up);
  for (let c = 0; c < 3; c++) {
    out.colour[c] = MOON_COLOUR[c] ?? 0;
  }
  return out;
}

export function newMainLight(): MainLight {
  return { body: 'sun', strength: 0, colour: [0, 0, 0] };
}

/** The brightness of a colour (display values), as luminance weights them (ITU-R BT.709). */
export function luminance(c: Rgb | number[]): number {
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
}
