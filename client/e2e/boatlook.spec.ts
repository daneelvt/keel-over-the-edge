// SPDX-License-Identifier: AGPL-3.0-only

// Each boat drawn in its own look, on each back end: the own boat takes the
// paint, cloth, sail number and name it is told, and keeps them on every
// other kind; each boat of the fleet, of every kind, takes its own, near
// and far, its name lettered only near and only once; a boat changed to
// another kind in port keeps its look; and the fleet's draws are the same
// whatever the looks.

import { expect, test } from '@playwright/test';
import { openScene } from './helpers';

/** A boat look code: a paint's and a cloth's places in the catalog's lists, and a sail number. */
const code = (paint: number, cloth: number, number: number): number =>
  (paint & 15) | ((cloth & 15) << 4) | ((number & 0x3fff) << 8);

test('the own boat takes its look and its name, on every kind', async ({ page }) => {
  await openScene(page);
  const drawn = await page.evaluate(
    async (c) => {
      const k = globalThis.keel;
      const before = k.boatLooksDrawn().own;
      k.setBoatLook(c, 'Saltpeter');
      const after = k.boatLooksDrawn().own;
      await k.useBoat(1);
      const keelboat = k.boatLooksDrawn().own;
      await k.useBoat(3);
      const skiff = k.boatLooksDrawn().own;
      k.setBoatLook(-1, '');
      const none = k.boatLooksDrawn().own;
      return { before, after, keelboat, skiff, none };
    },
    code(2, 4, 311),
  );
  // None told: the first paint and cloth, no number, no name.
  expect(drawn.before).toMatchObject({ paint: 0, cloth: 0, number: 0, name: '', row: -1 });
  expect(drawn.after).toMatchObject({ paint: 2, cloth: 4, number: 311, name: 'Saltpeter', row: 0 });
  // The palette draws the catalog's colours: a band on a cloth that has one.
  expect(drawn.after?.colours.hull).toMatch(/^#[0-9a-f]{6}$/);
  expect(drawn.after?.colours.hull).not.toBe(drawn.before?.colours.hull);
  expect(drawn.after?.colours.band).not.toBeNull();
  expect(drawn.before?.colours.band).toBeNull();
  expect(drawn.keelboat).toMatchObject({ paint: 2, cloth: 4, number: 311, name: 'Saltpeter' });
  expect(drawn.skiff).toMatchObject({ paint: 2, cloth: 4, number: 311, name: 'Saltpeter' });
  expect(drawn.none).toMatchObject({ paint: 0, cloth: 0, number: 0, name: '', row: -1 });
});

test('each boat of the fleet takes its own look, its name only near and lettered once', async ({
  page,
}) => {
  await openScene(page);
  const looks = [code(1, 0, 7), code(3, 2, 4711), -1, code(5, 5, 99), code(4, 1, 512)];
  const r = await page.evaluate(async (looks) => {
    const k = globalThis.keel;
    const b = k.boat().state;
    const names = ['Tern', 'Kittiwake', '', 'Halcyon', 'Petrel'];
    // Four near, of three kinds, the skiff with her gennaker set; the
    // fourth far off.
    const boats = looks.map((boatLook, i) => ({
      kind: i === 1 ? 1 : i === 4 ? 3 : 0,
      east: b.x + (i === 3 ? 300 : 8 * (i + 1)),
      north: b.y + 6,
      kite: i === 4 ? 0.9 : 0,
      hoist: i === 4 ? 1 : 0,
      heading: 1.5708,
      boom: 0.5,
      sail: 15,
      machine: i === 3 ? 1 : 0,
      boatLook,
      name: names[i] ?? '',
    }));
    k.setFleet(boats);
    k.render();
    await k.fleetLoaded();
    k.render();
    const first = k.boatLooksDrawn();
    for (let i = 0; i < 20; i++) {
      k.render();
    }
    const later = k.boatLooksDrawn();
    // The Jolly boat in slot 0 changed to a keelboat in port: the same
    // slot, another kind, its look kept.
    k.setFleet([{ ...boats[0], kind: 1 }]);
    k.render();
    const changed = k.boatLooksDrawn();
    return { first, later, changed, budget: k.fleetBudget() };
  }, looks);
  const by = (n: number) =>
    r.first.fleet.find((f) => f.number === n && (n !== 0 || f.kind === 0)) ?? null;
  expect(by(7)).toMatchObject({ kind: 0, level: 'near', paint: 1, cloth: 0 });
  expect(by(4711)).toMatchObject({ kind: 1, level: 'near', paint: 3, cloth: 2 });
  expect(by(512)).toMatchObject({ kind: 3, level: 'near', paint: 4, cloth: 1 });
  // A test's boat with no look told: the first paint and cloth, no number.
  expect(r.first.fleet.filter((f) => f.number === 0)).toEqual([
    expect.objectContaining({ paint: 0, cloth: 0, row: -1 }),
  ]);
  // Far off: its look, and no name.
  expect(by(99)).toMatchObject({ level: 'far', paint: 5, cloth: 5, row: -1 });
  // The names near, each in a row, lettered once however often drawn.
  expect(r.first.names?.rows.filter((n) => n !== '').sort()).toEqual([
    'Kittiwake',
    'Petrel',
    'Tern',
  ]);
  expect(r.later.names?.drawn).toBe(r.first.names?.drawn);
  expect((by(7)?.row ?? -1) >= 0 && (by(4711)?.row ?? -1) >= 0 && (by(512)?.row ?? -1) >= 0).toBe(
    true,
  );
  expect(r.changed.fleet).toEqual([
    expect.objectContaining({ kind: 1, level: 'near', paint: 1, cloth: 0, number: 7 }),
  ]);
});
