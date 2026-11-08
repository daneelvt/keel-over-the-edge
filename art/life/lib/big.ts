// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The big and rare bodies of the water: three whales, a mobula ray and an
// oceanic whitetip shark, lofted as the dolphin is (see swimmers.ts), each
// from its real proportions at a length of its own.

import { Body, type Corner } from './body.ts';

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** A flat dark quad lying on the body's back at its height there, x across and s along, fractions of the length. */
function patch(b: Body, y: number, corners: [number, number][], g = 1): void {
  b.quad(
    ...(corners.map(([x, s]) => ({ p: b.at([x, y, s]), r: 1, g })) as [
      Corner,
      Corner,
      Corner,
      Corner,
    ]),
    [0, 1, 0],
  );
}

/**
 * A humpback whale: a long head, a third of the body, flat and broad
 * from above, its rostrum and lower jaw set with knobs (tubercles); the
 * mouth's line arching back to below the eye; fourteen to twenty-two
 * ventral pleats from the chin to the navel; a small dorsal fin on a
 * hump about two thirds of the way back; pectoral flippers a third of the
 * length, the longest of any whale, white and knobbed along their leading
 * edges; and broad flukes, a third of the length across, their trailing
 * edges scalloped (NOAA Fisheries; Clapham, Encyclopedia of Marine
 * Mammals). Black above; in the Atlantic white beneath, on the flippers
 * and under the flukes.
 */
export function humpback(length: number): Body {
  const b = new Body(length);
  const surface = b.loft(
    [
      // The lower jaw's tip, just past the rostrum's.
      { s: 0, top: -0.028, bot: -0.028, w: 0 },
      { s: 0.03, top: -0.006, bot: -0.05, w: 0.032 },
      // The rostrum, flat on top, broadening back to the blowholes.
      { s: 0.1, top: 0.022, bot: -0.08, w: 0.058, full: 0.7 },
      { s: 0.2, top: 0.052, bot: -0.108, w: 0.078, full: 0.75 },
      // The pleated throat at its deepest, the flippers' roots behind it.
      { s: 0.31, top: 0.08, bot: -0.118, w: 0.09 },
      { s: 0.43, top: 0.092, bot: -0.104, w: 0.09 },
      { s: 0.55, top: 0.084, bot: -0.08, w: 0.074 },
      { s: 0.66, top: 0.068, bot: -0.058, w: 0.052 },
      // The tail stock, deep and narrow.
      { s: 0.78, top: 0.042, bot: -0.034, w: 0.026 },
      { s: 0.87, top: 0.02, bot: -0.014, w: 0.013 },
      { s: 0.915, top: 0.002, bot: 0.002, w: 0 },
    ],
    10,
    (s, c) => {
      if (c > 0) {
        return { r: 1 };
      }
      // The white belly fades toward the tail.
      const pale = 1 - smooth(0.5, 0.75, s);
      if (c > -0.6) {
        return { r: 1 - 0.1 * pale };
      }
      return { r: 0.6 - 0.6 * pale };
    },
  );
  // The dorsal fin on its hump, small and stubby.
  b.fin(
    [
      { lead: [0, 0.07, 0.6], trail: [0, 0.062, 0.7], thick: 0.012 },
      { lead: [0, 0.092, 0.645], trail: [0, 0.086, 0.69], thick: 0.006 },
    ],
    [0, 0.104, 0.695],
    [1, 0, 0],
    { r: [1, 1] },
  );
  for (const mirror of [false, true]) {
    // The flippers, low behind the head, held out and swept back, broad at
    // the elbow and tapering to the tip; knobbed (the dark marks) along
    // the leading edge.
    b.fin(
      [
        { lead: [0.07, -0.06, 0.28], trail: [0.07, -0.072, 0.37], thick: 0.016 },
        { lead: [0.15, -0.098, 0.335], trail: [0.14, -0.11, 0.42], thick: 0.01 },
        { lead: [0.24, -0.138, 0.42], trail: [0.225, -0.146, 0.48], thick: 0.006 },
      ],
      [0.31, -0.168, 0.53],
      [0, 1, 0],
      { r: [0.15, 0], lead: 0.45 },
      true,
      mirror,
    );
    // The flukes, swept back, their trailing edge scalloped, its middle
    // notched; black above, white beneath.
    b.fin(
      [
        { lead: [0, 0.006, 0.85], trail: [0, 0.0, 0.96], thick: 0.01 },
        { lead: [0.065, 0.003, 0.9], trail: [0.065, 0.0, 0.99], thick: 0.006 },
        { lead: [0.125, 0.0, 0.945], trail: [0.125, 0.0, 0.98], thick: 0.003 },
      ],
      [0.168, 0.0, 1.0],
      [0, 1, 0],
      { r: [1, 0], trail: 0.55 },
      false,
      mirror,
    );
  }
  // The eye, just above the mouth's corner; the mouth's line, arching up
  // from the chin and down again to below the eye.
  surface.spot(0.245, -0.035, 0.012, 0.008);
  surface.line(
    [
      [0.012, -0.03],
      [0.09, -0.034],
      [0.18, -0.04],
      [0.255, -0.056],
    ],
    0.006,
  );
  // The pleats, from the chin back to the navel.
  for (const j of [3.6, 4.2, 4.8]) {
    surface.line(
      [
        [0.06, surface.y(0.06, j)],
        [0.48, surface.y(0.48, j)],
      ],
      0.005,
      0.55,
    );
  }
  // The knobs on the rostrum and the chin.
  for (const [s, j] of [
    [0.06, 0.8],
    [0.13, 1.1],
    [0.04, 3.5],
  ] as [number, number][]) {
    surface.spot(s, surface.y(s, j), 0.01, 0.008, 0.8);
  }
  return b;
}

/**
 * A sperm whale: the head a third of the body long and squarish, its
 * front blunt and its single blowhole at its front, on the left; the
 * lower jaw narrow and underslung, set well back under the head; a low
 * triangular dorsal hump about two thirds of the way back and a row of
 * knuckles from it down the back toward the tail; small, rounded
 * pectorals; broad triangular flukes, a quarter of the length across; the
 * skin behind the head wrinkled (Whitehead, Encyclopedia of Marine Mammals;
 * NOAA Fisheries). Dark grey, a little paler beneath; white about the mouth.
 */
export function sperm(length: number): Body {
  const b = new Body(length);
  const box = 0.45;
  const surface = b.loft(
    [
      // The blunt front of the head, nearly flat.
      { s: 0, top: 0.035, bot: 0.035, w: 0 },
      { s: 0.006, top: 0.072, bot: -0.03, w: 0.046, full: box },
      { s: 0.05, top: 0.088, bot: -0.062, w: 0.066, full: box },
      { s: 0.2, top: 0.092, bot: -0.072, w: 0.074, full: box },
      // The head's end, the throat falling away behind the jaw.
      { s: 0.31, top: 0.09, bot: -0.088, w: 0.078, full: 0.6 },
      { s: 0.42, top: 0.08, bot: -0.082, w: 0.07 },
      { s: 0.54, top: 0.072, bot: -0.07, w: 0.062 },
      { s: 0.65, top: 0.066, bot: -0.054, w: 0.048 },
      // The tail stock, keeled below.
      { s: 0.77, top: 0.042, bot: -0.034, w: 0.026 },
      { s: 0.86, top: 0.022, bot: -0.016, w: 0.012 },
      { s: 0.905, top: 0.002, bot: 0.002, w: 0 },
    ],
    10,
    (_s, c) => ({ r: c > -0.3 ? 1 : 0.35 }),
  );
  // The lower jaw: a narrow rod under the head, its tip short of the front.
  b.loft(
    [
      { s: 0.06, top: -0.068, bot: -0.068, w: 0 },
      { s: 0.1, top: -0.058, bot: -0.08, w: 0.014 },
      { s: 0.24, top: -0.064, bot: -0.094, w: 0.018 },
      { s: 0.33, top: -0.08, bot: -0.08, w: 0 },
    ],
    4,
    (_s, c) => ({ r: c > 0.5 ? 0.4 : 0 }),
    1,
  );
  // The dorsal hump and the knuckles behind it.
  const hump: [number, number, number][] = [
    [0.6, 0.7, 0.03],
    [0.725, 0.76, 0.014],
    [0.78, 0.81, 0.011],
    [0.83, 0.855, 0.008],
  ];
  for (const [a, z, h] of hump) {
    const top = surface.station((a + z) / 2).top - 0.004;
    b.fin(
      [{ lead: [0, top, a], trail: [0, top - 0.004, z], thick: h * 0.4 }],
      [0, top + h, a + (z - a) * 0.55],
      [1, 0, 0],
      { r: [1, 1] },
    );
  }
  for (const mirror of [false, true]) {
    // The pectorals, small and spatulate, low behind the jaw's hinge.
    b.fin(
      [
        { lead: [0.068, -0.058, 0.33], trail: [0.064, -0.064, 0.37], thick: 0.006 },
        { lead: [0.1, -0.078, 0.36], trail: [0.095, -0.082, 0.395], thick: 0.004 },
      ],
      [0.12, -0.092, 0.405],
      [0, 1, 0],
      { r: [1, 0.6] },
      false,
      mirror,
    );
    // The flukes, broad triangles, their trailing edges nearly straight.
    b.fin(
      [
        { lead: [0, 0.005, 0.86], trail: [0, 0.0, 0.965], thick: 0.009 },
        { lead: [0.06, 0.003, 0.9], trail: [0.06, 0.0, 0.975], thick: 0.006 },
        { lead: [0.105, 0.0, 0.94], trail: [0.105, 0.0, 0.985], thick: 0.003 },
      ],
      [0.135, 0.0, 1.0],
      [0, 1, 0],
      { r: [1, 0.6], trail: 0.3 },
      false,
      mirror,
    );
  }
  // The eye, small, just above the corner of the mouth.
  surface.spot(0.3, -0.045, 0.008, 0.006);
  // The wrinkles behind the head.
  for (const [s, y] of [
    [0.36, 0.03],
    [0.42, -0.01],
    [0.48, 0.035],
    [0.55, -0.015],
  ] as [number, number][]) {
    surface.line(
      [
        [s, y + 0.025],
        [s + 0.012, y],
        [s + 0.004, y - 0.025],
      ],
      0.004,
      0.35,
    );
  }
  // The blowhole: an S-shaped slit at the front of the head, on the left.
  const top = surface.station(0.03).top + 0.001;
  patch(b, top, [
    [-0.022, 0.018],
    [-0.03, 0.022],
    [-0.042, 0.04],
    [-0.034, 0.036],
  ]);
  return b;
}

/**
 * A short-finned pilot whale: a bulbous melon with no beak, overhanging
 * the mouth; a low, broad-based, falcate dorsal fin set well forward,
 * about a third of the way back; long, slender, sickle-shaped flippers,
 * about a fifth of the length; a thick tail stock keeled above and below;
 * flukes about a fifth of the length across (Olson, Encyclopedia of Marine
 * Mammals; NOAA Fisheries). Black or dark grey all over, a paler saddle
 * behind the fin and a pale anchor-shaped patch on the throat.
 */
export function pilot(length: number): Body {
  const b = new Body(length);
  const saddle = (s: number): number => smooth(0.4, 0.45, s) * (1 - smooth(0.52, 0.6, s));
  const surface = b.loft(
    [
      { s: 0, top: -0.012, bot: -0.012, w: 0 },
      // The melon, round and blunt, rising straight from the mouth.
      { s: 0.018, top: 0.028, bot: -0.042, w: 0.036 },
      { s: 0.06, top: 0.07, bot: -0.066, w: 0.062 },
      { s: 0.13, top: 0.09, bot: -0.084, w: 0.076 },
      { s: 0.26, top: 0.102, bot: -0.098, w: 0.086 },
      { s: 0.4, top: 0.1, bot: -0.098, w: 0.084 },
      { s: 0.55, top: 0.084, bot: -0.08, w: 0.066 },
      { s: 0.68, top: 0.064, bot: -0.054, w: 0.04 },
      { s: 0.8, top: 0.042, bot: -0.032, w: 0.02 },
      { s: 0.88, top: 0.02, bot: -0.012, w: 0.01 },
      { s: 0.92, top: 0.002, bot: 0.002, w: 0 },
    ],
    10,
    (s, c) => {
      if (c > 0.6) {
        return { r: 1 - 0.6 * saddle(s) };
      }
      if (c > -0.6) {
        return { r: 1 - 0.3 * saddle(s) };
      }
      // The throat's pale patch.
      return { r: s > 0.06 && s < 0.22 ? 0 : 0.5 };
    },
  );
  // The dorsal fin: long-based and low, its tip swept back and hooked.
  b.fin(
    [
      { lead: [0, 0.096, 0.27], trail: [0, 0.094, 0.43], thick: 0.012 },
      { lead: [0, 0.13, 0.33], trail: [0, 0.128, 0.42], thick: 0.007 },
      { lead: [0, 0.155, 0.39], trail: [0, 0.153, 0.43], thick: 0.004 },
    ],
    [0, 0.162, 0.46],
    [1, 0, 0],
    { r: [1, 1] },
  );
  for (const mirror of [false, true]) {
    // The flippers: slender sickles, their elbows forward and their tips
    // swept far back.
    b.fin(
      [
        { lead: [0.06, -0.058, 0.165], trail: [0.06, -0.068, 0.215], thick: 0.01 },
        { lead: [0.12, -0.09, 0.21], trail: [0.11, -0.1, 0.255], thick: 0.006 },
        { lead: [0.165, -0.112, 0.28], trail: [0.15, -0.118, 0.3], thick: 0.003 },
      ],
      [0.19, -0.124, 0.36],
      [0, 1, 0],
      { r: [1, 0.85] },
      true,
      mirror,
    );
    // The flukes, swept back to pointed tips.
    b.fin(
      [
        { lead: [0, 0.004, 0.865], trail: [0, 0.0, 0.962], thick: 0.009 },
        { lead: [0.05, 0.002, 0.905], trail: [0.05, 0.0, 0.97], thick: 0.005 },
        { lead: [0.085, 0.0, 0.95], trail: [0.085, 0.0, 0.983], thick: 0.003 },
      ],
      [0.106, 0.0, 1.0],
      [0, 1, 0],
      { r: [1, 0.85] },
      false,
      mirror,
    );
  }
  // The eye, above and behind the mouth's corner; the short mouth,
  // turning up at its corner.
  surface.spot(0.085, -0.016, 0.008, 0.006);
  surface.line(
    [
      [0.012, -0.03],
      [0.04, -0.036],
      [0.07, -0.03],
    ],
    0.004,
  );
  return b;
}

/**
 * A mobula ray, as the Munk's and the spinetail devil rays: a flat
 * diamond disc about twice as wide as it is long, its wings' tips pointed
 * and swept back, their trailing edges hollow; two cephalic fins at the
 * front corners of the head, rolled into horns as it swims; a small
 * dorsal fin at the tail's root and a thin whip of a tail (Notarbartolo di
 * Sciara, Zoological Journal of the Linnean Society 1987; FishBase,
 * Mobula). Dark above, white below. Its wings are paddles: they flap.
 */
export function ray(length: number): Body {
  const b = new Body(length);
  // Half the span: a 2 m disc on a body 1.1 m long, horns to tail tip.
  const span = 2.0 / 1.1 / 2;
  const surface = b.loft(
    [
      { s: 0.07, top: 0.002, bot: 0.002, w: 0 },
      // The head, broad and flat between the horns, the mouth beneath.
      { s: 0.085, top: 0.022, bot: -0.018, w: 0.07, full: 0.6 },
      { s: 0.22, top: 0.058, bot: -0.032, w: 0.11, full: 0.6 },
      { s: 0.42, top: 0.062, bot: -0.03, w: 0.11, full: 0.6 },
      { s: 0.6, top: 0.04, bot: -0.018, w: 0.07 },
      // The tail's root and the whip.
      { s: 0.7, top: 0.014, bot: -0.004, w: 0.016 },
      { s: 0.84, top: 0.006, bot: 0.0, w: 0.005 },
      { s: 1, top: 0.003, bot: 0.003, w: 0 },
    ],
    8,
    (_s, c) => ({ r: c > -0.2 ? 1 : 0 }),
  );
  for (const mirror of [false, true]) {
    // The wings: out from the body's flanks to pointed tips swept back,
    // thick at the root and thin at the tip.
    b.fin(
      [
        { lead: [0.1, 0.018, 0.1], trail: [0.1, 0.016, 0.62], thick: 0.022 },
        { lead: [0.36, 0.01, 0.25], trail: [0.36, 0.01, 0.56], thick: 0.012 },
        { lead: [0.62, 0.0, 0.39], trail: [0.62, 0.0, 0.54], thick: 0.006 },
        { lead: [0.8, -0.008, 0.5], trail: [0.8, -0.008, 0.565], thick: 0.003 },
      ],
      [span, -0.014, 0.62],
      [0, 1, 0],
      { r: [1, 0], lead: 0.2 },
      true,
      mirror,
    );
    // The cephalic fins: horns, rolled, reaching forward of the mouth.
    b.fin(
      [
        { lead: [0.07, 0.024, 0.11], trail: [0.07, -0.018, 0.11], thick: 0.018 },
        { lead: [0.074, 0.014, 0.05], trail: [0.074, -0.01, 0.05], thick: 0.012 },
      ],
      [0.07, 0.002, 0],
      [1, 0, 0],
      { r: [1, 1] },
      false,
      mirror,
    );
    // The pelvic fins, small, either side of the tail's root.
    b.fin(
      [{ lead: [0.04, 0.0, 0.58], trail: [0.035, 0.0, 0.66], thick: 0.006 }],
      [0.06, -0.002, 0.68],
      [0, 1, 0],
      { r: [1, 0] },
      false,
      mirror,
    );
  }
  // The small dorsal fin at the tail's root, its tip white.
  b.fin(
    [{ lead: [0, 0.03, 0.62], trail: [0, 0.012, 0.69], thick: 0.006 }],
    [0, 0.05, 0.68],
    [1, 0, 0],
    { r: [1, 1], tipR: 0 },
  );
  // The eyes at the horns' roots; the gill slits beneath.
  surface.spot(0.12, 0.008, 0.012, 0.008);
  for (let k = 0; k < 5; k++) {
    const s = 0.2 + k * 0.035;
    surface.line(
      [
        [s, surface.y(s, 3.2)],
        [s + 0.004, surface.y(s, 3.8)],
      ],
      0.006,
      0.6,
    );
  }
  return b;
}

/**
 * An oceanic whitetip shark: stocky, its snout short and bluntly rounded;
 * a very large first dorsal fin, its tip broadly rounded; long, broad,
 * paddle-like pectorals, rounded at their tips; five gill slits; a small
 * second dorsal and anal fin; and a heterocercal tail, its upper lobe the
 * longer (NOAA Fisheries; Compagno, Sharks of the World). Bronze grey
 * above, white below; the tips of the first dorsal, the pectorals and the
 * tail's lobes mottled white.
 */
export function shark(length: number): Body {
  const b = new Body(length);
  const surface = b.loft(
    [
      { s: 0, top: -0.006, bot: -0.006, w: 0 },
      // The snout, short and blunt.
      { s: 0.03, top: 0.02, bot: -0.026, w: 0.026 },
      { s: 0.09, top: 0.046, bot: -0.048, w: 0.05 },
      { s: 0.19, top: 0.07, bot: -0.068, w: 0.07 },
      // Deepest under the first dorsal.
      { s: 0.33, top: 0.086, bot: -0.08, w: 0.076 },
      { s: 0.48, top: 0.07, bot: -0.068, w: 0.062 },
      { s: 0.62, top: 0.044, bot: -0.042, w: 0.038 },
      { s: 0.72, top: 0.026, bot: -0.022, w: 0.02 },
      { s: 0.77, top: 0.02, bot: -0.014, w: 0.014 },
      { s: 0.8, top: 0.006, bot: 0.006, w: 0 },
    ],
    10,
    (_s, c) => ({ r: c > 0.2 ? 1 : c > -0.3 ? 0.55 : 0 }),
  );
  // The first dorsal: tall, its tip rounded and mottled white.
  b.fin(
    [
      { lead: [0, 0.08, 0.28], trail: [0, 0.08, 0.46], thick: 0.011 },
      { lead: [0, 0.14, 0.31], trail: [0, 0.135, 0.45], thick: 0.007 },
      { lead: [0, 0.185, 0.34], trail: [0, 0.18, 0.44], thick: 0.004, r: 0.15 },
    ],
    [0, 0.205, 0.39],
    [1, 0, 0],
    { r: [1, 1], tipR: 0 },
  );
  // The second dorsal and the anal fin, small.
  b.fin(
    [{ lead: [0, 0.036, 0.62], trail: [0, 0.028, 0.68], thick: 0.004 }],
    [0, 0.06, 0.675],
    [1, 0, 0],
    { r: [1, 1], tipR: 0.3 },
  );
  b.fin(
    [{ lead: [0, -0.034, 0.64], trail: [0, -0.024, 0.7], thick: 0.004 }],
    [0, -0.058, 0.69],
    [1, 0, 0],
    { r: [0.4, 0.4], tipR: 0 },
  );
  // The tail: the upper lobe long and swept up, the lower shorter.
  b.fin(
    [
      { lead: [0, 0.022, 0.74], trail: [0, -0.012, 0.84], thick: 0.009 },
      { lead: [0, 0.06, 0.83], trail: [0, 0.04, 0.9], thick: 0.005 },
      { lead: [0, 0.098, 0.92], trail: [0, 0.084, 0.955], thick: 0.003, r: 0.3 },
    ],
    [0, 0.122, 1.0],
    [1, 0, 0],
    { r: [1, 1], trail: 0.3, tipR: 0 },
  );
  b.fin(
    [
      { lead: [0, -0.014, 0.76], trail: [0, 0.006, 0.83], thick: 0.007 },
      { lead: [0, -0.05, 0.8], trail: [0, -0.038, 0.84], thick: 0.003 },
    ],
    [0, -0.084, 0.86],
    [1, 0, 0],
    { r: [0.8, 0.8], tipR: 0 },
  );
  for (const mirror of [false, true]) {
    // The pectorals: long and broad, held out and down, rounded at their
    // white tips.
    b.fin(
      [
        { lead: [0.055, -0.045, 0.22], trail: [0.055, -0.052, 0.32], thick: 0.01 },
        { lead: [0.15, -0.07, 0.27], trail: [0.14, -0.078, 0.37], thick: 0.006 },
        { lead: [0.235, -0.092, 0.33], trail: [0.225, -0.096, 0.4], thick: 0.003, r: 0.1 },
      ],
      [0.275, -0.104, 0.4],
      [0, 1, 0],
      { r: [1, 0], tipR: 0 },
      true,
      mirror,
    );
    // The pelvic fins, under the belly behind the middle.
    b.fin(
      [{ lead: [0.03, -0.058, 0.52], trail: [0.025, -0.05, 0.58], thick: 0.004 }],
      [0.06, -0.072, 0.585],
      [0, 1, 0],
      { r: [0.6, 0] },
      false,
      mirror,
    );
  }
  // The eye; the mouth's curve beneath the snout; the five gill slits.
  surface.spot(0.075, 0.008, 0.008, 0.006);
  surface.line(
    [
      [0.07, surface.y(0.07, 4.2)],
      [0.1, surface.y(0.1, 3.6)],
      [0.115, surface.y(0.115, 3.1)],
    ],
    0.005,
  );
  for (let k = 0; k < 5; k++) {
    const s = 0.165 + k * 0.016;
    surface.line(
      [
        [s, surface.y(s, 1.9)],
        [s + 0.006, surface.y(s, 3.1)],
      ],
      0.004,
      0.7,
    );
  }
  return b;
}
