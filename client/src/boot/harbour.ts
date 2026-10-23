// SPDX-License-Identifier: AGPL-3.0-only

// The harbour the boat is in: from the towns' harbour discs, as the
// harbour's sounds find it, named by the chart; and a place on the water in
// Port Royal's, for the board's tests.

import { type ReadonlySignal, signal } from '@preact/signals';
import { catalog } from '../catalog';
import type { ChartStore } from '../chart/store';
import type { SeaScene } from '../render/scene';
import type { InPort } from '../ui/board';

/**
 * The port the boat is in, worked out once a second from the towns' harbour
 * discs: named by the nearest charted port, or Port Royal's island, or the
 * main port at the centre.
 */
export function watchHarbour(world: SeaScene, store: ChartStore): ReadonlySignal<InPort> {
  const port = signal<InPort>(null);
  setInterval(() => {
    const land = world.land;
    const p = world.pose;
    const heard = land?.towns.heardFrom(
      p.east,
      p.north,
      (e, n) => (land.heightAt(e, n) ?? -1) <= 0,
    );
    if (heard === undefined || !heard.inPort) {
      port.value = null;
      return;
    }
    let name = '';
    let at = { east: p.east, north: p.north };
    let best = 1500;
    for (const e of store.entries) {
      const harbour =
        (e.subject === 'place' && store.words.places[e.sort]?.site === 'harbour') ||
        (e.subject === 'island' && e.number === 0);
      const d = Math.hypot(e.east - p.east, e.north - p.north);
      if (harbour && d < best && e.name !== '') {
        best = d;
        name = e.name;
        at = { east: e.east, north: e.north };
      }
    }
    if (name === '') {
      name = Math.hypot(p.east, p.north) < 1852 ? catalog.world.mainPort.name : 'The harbour';
    }
    if (port.value?.name !== name) {
      port.value = { name, ...at };
    }
  }, 1000);
  return port;
}

/**
 * A place on the water within the harbour disc nearest the centre, Port
 * Royal's, of the towns handed: where ?board puts the boat; null if none
 * is held yet.
 */
export function harbourWater(world: SeaScene): { east: number; north: number } | null {
  const land = world.land;
  if (land === null) {
    return null;
  }
  let disc: { east: number; north: number; radius: number } | null = null;
  for (const d of land.towns.harbour()) {
    if (disc === null || Math.hypot(d.east, d.north) < Math.hypot(disc.east, disc.north)) {
      disc = d;
    }
  }
  if (disc === null) {
    return null;
  }
  for (let r = 0; r <= disc.radius * 0.9; r += 10) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      const east = disc.east + r * Math.sin(a);
      const north = disc.north + r * Math.cos(a);
      if ((land.heightAt(east, north) ?? 1) <= -1) {
        return { east, north };
      }
    }
  }
  return null;
}
