// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's look, as the catalog offers it: a look and its version with a
// skin, a hair colour and a main colour for a person; a version, a finish
// and a main colour for a machine sailor. It is checked against the
// catalog, packed into the look code the simulation and the wire carry,
// drawn at random and said in words, as internal/looks does on the server.
//
// The look code is five fields of 4 bits from the low end: the look's place
// among the catalog's sailors (MACHINE_MARK for a machine), the version's,
// the skin's (a machine's finish), the hair's (0 for a machine) and the main
// colour's.
//
// The catalog is passed in, never imported, so that pages and tests that
// cannot load its JSON can use these too.

import type { Catalog, Sailor, SailorArt, SailorOption, SailorVersion } from './types.gen';

/** The look a machine sailor's look names, as the server keeps it. */
export const MACHINE = 'machine';

/** A look code's first field for a machine sailor's look. */
export const MACHINE_MARK = 15;

/** The parts of the catalog a look is made from. */
export type Looks = Pick<Catalog, 'sailors' | 'sailorOptions' | 'machine'>;

/** A sailor's look, by the catalog's ids, as the server keeps and sends it. */
export interface Look {
  look: string;
  version: string;
  skin?: string;
  hair?: string;
  colour: string;
  finish?: string;
}

/** A look's colours, sRGB #rrggbb: its main colour, its skin or metal, and its hair or lamps' light. */
export interface LookColours {
  main: string;
  skin: string;
  hair: string;
}

/** Whether a look is a machine sailor's. */
export function isMachine(l: Look): boolean {
  return l.look === MACHINE;
}

/** The set a look's hair colour is chosen from. */
export function hairsOf(cat: Looks, s: Sailor): readonly SailorOption[] {
  return s.hair === 'greys' ? cat.sailorOptions.greys : cat.sailorOptions.hairs;
}

const at = <T extends { id: string }>(list: readonly T[], id: string | undefined): number =>
  id === undefined ? -1 : list.findIndex((x) => x.id === id);

/** A look's places in the catalog's lists, the look code's fields; null for one not made of the catalog's choices. */
function places(cat: Looks, l: Look): number[] | null {
  const colour = at(cat.sailorOptions.colours, l.colour);
  if (isMachine(l)) {
    const p = [
      MACHINE_MARK,
      at(cat.machine.versions, l.version),
      at(cat.machine.finishes, l.finish),
      0,
      colour,
    ];
    return p.every((v) => v >= 0) && (l.skin ?? '') === '' && (l.hair ?? '') === '' ? p : null;
  }
  const i = at(cat.sailors, l.look);
  const s = cat.sailors[i];
  if (s === undefined) {
    return null;
  }
  const p = [
    i,
    at(s.versions, l.version),
    at(cat.sailorOptions.skins, l.skin),
    at(hairsOf(cat, s), l.hair),
    colour,
  ];
  return p.every((v) => v >= 0) && (l.finish ?? '') === '' ? p : null;
}

/** Whether a look is made of the catalog's choices. */
export function validLook(cat: Looks, l: Look): boolean {
  return places(cat, l) !== null;
}

/** A look's code; 0 for one not made of the catalog's choices. */
export function codeOf(cat: Looks, l: Look): number {
  const p = places(cat, l);
  return p === null ? 0 : p.reduce((c, v, k) => c + (v & 15) * 16 ** k, 0);
}

/** The look a code names; null for a code that names none. */
export function lookOf(cat: Looks, code: number): Look | null {
  if (!Number.isInteger(code) || code < 0 || code >= 2 ** 20) {
    return null;
  }
  const p = [0, 1, 2, 3, 4].map((k) => Math.floor(code / 16 ** k) & 15) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const colour = cat.sailorOptions.colours[p[4]]?.id;
  if (p[0] === MACHINE_MARK) {
    const version = cat.machine.versions[p[1]]?.id;
    const finish = cat.machine.finishes[p[2]]?.id;
    return version === undefined || finish === undefined || colour === undefined || p[3] !== 0
      ? null
      : { look: MACHINE, version, finish, colour };
  }
  const s = cat.sailors[p[0]];
  const version = s?.versions[p[1]]?.id;
  const skin = cat.sailorOptions.skins[p[2]]?.id;
  const hair = s === undefined ? undefined : hairsOf(cat, s)[p[3]]?.id;
  return s === undefined ||
    version === undefined ||
    skin === undefined ||
    hair === undefined ||
    colour === undefined
    ? null
    : { look: s.id, version, skin, hair, colour };
}

const pick = <T>(list: readonly T[], random: () => number): T =>
  list[Math.min(list.length - 1, Math.floor(random() * list.length))] as T;

/** A person's look at random: any look and version, and any of their options. */
export function drawLook(cat: Looks, random: () => number = Math.random): Look {
  const s = pick(cat.sailors, random);
  return {
    look: s.id,
    version: pick(s.versions, random).id,
    skin: pick(cat.sailorOptions.skins, random).id,
    hair: pick(hairsOf(cat, s), random).id,
    colour: pick(cat.sailorOptions.colours, random).id,
  };
}

/** A look's catalog entries: its look (null for a machine), version, and options. */
export function partsOf(
  cat: Looks,
  l: Look,
): {
  sailor: Sailor | null;
  version: SailorVersion | undefined;
  colour: SailorOption | undefined;
  skin: SailorOption | undefined;
  hair: SailorOption | undefined;
  finish: SailorOption | undefined;
} {
  const colour = cat.sailorOptions.colours.find((c) => c.id === l.colour);
  if (isMachine(l)) {
    return {
      sailor: null,
      version: cat.machine.versions.find((v) => v.id === l.version),
      colour,
      skin: undefined,
      hair: undefined,
      finish: cat.machine.finishes.find((f) => f.id === l.finish),
    };
  }
  const sailor = cat.sailors.find((s) => s.id === l.look) ?? null;
  return {
    sailor,
    version: sailor?.versions.find((v) => v.id === l.version),
    colour,
    skin: cat.sailorOptions.skins.find((s) => s.id === l.skin),
    hair: sailor === null ? undefined : hairsOf(cat, sailor).find((h) => h.id === l.hair),
    finish: undefined,
  };
}

/** A look's art; the first look's first version's for one the catalog does not have. */
export function artOf(cat: Looks, l: Look): SailorArt {
  const v = partsOf(cat, l).version;
  return (v ?? (cat.sailors[0] as Sailor).versions[0]).art;
}

/** A look's colours: a machine's coat, metal and lamps; a person's main colour, skin and hair. */
export function coloursOf(cat: Looks, l: Look): LookColours {
  const p = partsOf(cat, l);
  const main = p.colour?.colour ?? '#808080';
  if (isMachine(l)) {
    return { main, skin: p.finish?.colour ?? '#808080', hair: cat.machine.lamp };
  }
  return { main, skin: p.skin?.colour ?? '#808080', hair: p.hair?.colour ?? '#808080' };
}

/**
 * A look in words, as an image's alternative text says it: "Old Salt,
 * female, indigo navy, Tone 5, silver"; "Machine, male, brass, sea green".
 */
export function lookWords(cat: Looks, l: Look): string {
  const p = partsOf(cat, l);
  const parts = isMachine(l)
    ? ['Machine', p.version?.name, p.finish?.name, p.colour?.name]
    : [p.sailor?.name, p.version?.name, p.colour?.name, p.skin?.name, p.hair?.name];
  return parts.filter((x) => x !== undefined && x !== '').join(', ');
}

/** A look as the server's answers carry it: its fields, picked from a larger record. */
export function lookFrom(r: Partial<Look> & { look: string }): Look {
  const l: Look = { look: r.look, version: r.version ?? '', colour: r.colour ?? '' };
  if (r.skin !== undefined && r.skin !== '') {
    l.skin = r.skin;
  }
  if (r.hair !== undefined && r.hair !== '') {
    l.hair = r.hair;
  }
  if (r.finish !== undefined && r.finish !== '') {
    l.finish = r.finish;
  }
  return l;
}
