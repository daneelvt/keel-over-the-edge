// SPDX-License-Identifier: AGPL-3.0-only

// A boat's look, as the catalog offers it: the paint on its hull and the
// cloth of its sails, places in the catalog's boatLooks lists, and its sail
// number; its name is player text, sent apart. Packed into the boat look
// code the simulation and the wire carry, as internal/looks's boat.go does
// on the server: the paint in bits 0–3, the cloth in bits 4–7 and the
// number in bits 8–21.
//
// The catalog is passed in, never imported, so that pages and tests that
// cannot load its JSON can use these too.

import type { BoatCloth, BoatPaint, Catalog } from './types.gen';

/** The parts of the catalog a boat's look is made from. */
export type BoatLooks = Pick<Catalog, 'boatLooks'>;

/** A boat's look by its places in the catalog's lists, and its sail number (0 for none told). */
export interface BoatLook {
  paint: number;
  cloth: number;
  number: number;
}

/** The boat look code of a look. */
export function boatCode(l: BoatLook): number {
  return (l.paint & 15) | ((l.cloth & 15) << 4) | ((l.number & 0x3fff) << 8);
}

/** The boat look a code names, unchecked; a negative code (none told) is the first paint and cloth with no number. */
export function boatLookOf(code: number): BoatLook {
  if (code < 0) {
    return { paint: 0, cloth: 0, number: 0 };
  }
  return { paint: code & 15, cloth: (code >> 4) & 15, number: (code >> 8) & 0x3fff };
}

/** The paint a look's place names, the first for one the catalog does not have. */
export function paintOf(cat: BoatLooks, i: number): BoatPaint {
  const ps = cat.boatLooks.paints;
  return (ps[i] ?? ps[0]) as BoatPaint;
}

/** The cloth a look's place names, the first for one the catalog does not have. */
export function clothOf(cat: BoatLooks, i: number): BoatCloth {
  const cs = cat.boatLooks.cloths;
  return (cs[i] ?? cs[0]) as BoatCloth;
}

/** A paint's or cloth's place among the catalog's by its id; −1 for none. */
export function paintAt(cat: BoatLooks, id: string): number {
  return cat.boatLooks.paints.findIndex((p) => p.id === id);
}

export function clothAt(cat: BoatLooks, id: string): number {
  return cat.boatLooks.cloths.findIndex((c) => c.id === id);
}

/** A boat as it is named: its kind, its name in «» if it has one, and its sail number: "Keelboat «Saltpeter» 311". */
export function boatNamed(kind: string, name: string, number: number): string {
  let s = kind;
  if (name !== '') {
    s += ` «${name}»`;
  }
  if (number > 0) {
    s += ` ${number}`;
  }
  return s;
}

/** A boat's look in words: "red ochre, tanbark sails". */
export function boatWords(cat: BoatLooks, l: BoatLook): string {
  return `${paintOf(cat, l.paint).name}, ${clothOf(cat, l.cloth).name} sails`;
}

/** The shortest and longest a boat's name may be, in characters as the server counts them (a letter with its marks once). */
export const BOAT_NAME_LEAST = 2;
export const BOAT_NAME_MOST = 20;
