// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's crew: as many as asked, up to the boat's capacity, each in
// a look of the catalog's, the same at every load, varied, a machine among
// them; the second at the helm when more than one is aboard.

import { expect, test } from 'vitest';
import { catalog } from '../catalog';
import { isMachine, lookOf } from '../catalog/looks';
import { crewFromQuery, sandboxCrew } from './crewscene';

test('?crew=N fills the boat with N, at most its capacity, the second at the helm', () => {
  expect(crewFromQuery(new URLSearchParams(''), 40, catalog)).toBeNull();
  expect(crewFromQuery(new URLSearchParams('crew=0'), 40, catalog)).toBeNull();
  expect(crewFromQuery(new URLSearchParams('crew=x'), 40, catalog)).toBeNull();
  const one = crewFromQuery(new URLSearchParams('crew=1'), 40, catalog);
  expect(one?.people).toHaveLength(1);
  expect(one?.holder).toBe(0);
  const five = crewFromQuery(new URLSearchParams('crew=9'), 5, catalog);
  expect(five?.people.map((p) => p.seat)).toEqual([0, 1, 2, 3, 4]);
  expect(five?.holder).toBe(1);
});

test('the looks are the catalog’s, varied, a machine among them, the same at every load', () => {
  const crew = sandboxCrew(40, catalog);
  const looks = crew.people.map((p) => lookOf(catalog, p.look));
  expect(looks.every((l) => l !== null)).toBe(true);
  expect(new Set(looks.map((l) => `${l?.look} ${l?.version}`)).size).toBeGreaterThan(10);
  expect(looks.filter((l) => l !== null && isMachine(l)).length).toBe(6);
  expect(sandboxCrew(40, catalog)).toEqual(crew);
});
