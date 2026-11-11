// SPDX-License-Identifier: AGPL-3.0-only

// People aboard, on a phone's screen (360 × 640): forty aboard the tall
// ship, every one drawn in their own look at their station on her deck and
// one at the wheel, in a few more draws than her one sailor, her frames
// within the budget of a frame at 60 Hz on a real GPU and little dearer
// than with her one sailor on any. Far off, as the chase camera sees the ship, the crew are the looks' far
// figures; close, the nearest twelve their deck level. The keelboat's
// five to windward of the boom on both tacks, crossing in a tack and a
// gybe in turn, and changing places at a handover; the skiff's two
// likewise.

import { expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import type { Looks } from '../src/catalog/looks';
import { sandboxCrew } from '../src/sandbox/crewscene';
import { openScene, softwareGPU } from './helpers';

test.use({ viewport: { width: 360, height: 640 } });

/** A frame at 60 Hz, ms. */
const BUDGET = 1000 / 60;

/** Milliseconds a frame, end to end: frames drawn one after another, each waited for on the GPU. */
async function frameMs(page: Page, frames: number): Promise<number> {
  return page.evaluate((n) => globalThis.keel.frameCost(n), frames);
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] as number;
};

/** The box of the boat's parts on the screen, but the crew's, CSS pixels. */
async function shipBox(page: Page) {
  return page.evaluate(() => {
    const parts = globalThis.keel.boatBox().filter((b) => !b.name.startsWith('crew'));
    return {
      left: Math.min(...parts.map((b) => b.left)),
      right: Math.max(...parts.map((b) => b.right)),
      top: Math.min(...parts.map((b) => b.top)),
      bottom: Math.max(...parts.map((b) => b.bottom)),
    };
  });
}

/** The frame's draws and triangles, and the crew drawn. */
async function counts(page: Page) {
  return page.evaluate(async () => {
    const k = globalThis.keel;
    await k.show();
    const { drawCalls, triangles } = k.info();
    const { aboard, near, far, nearTriangles, farTriangles } = k.crew();
    return { drawCalls, triangles, aboard, near, far, nearTriangles, farTriangles };
  });
}

test('forty aboard the tall ship, at their stations, within a frame’s budget', {
  tag: '@long',
}, async ({ page }) => {
  test.setTimeout(240_000);
  await openScene(page, 'boat=tall-ship');
  // Her one sailor, for the frames to compare with, in the look of whoever
  // holds the controls among the forty, so that only the crew differs.
  const helm = sandboxCrew(40, data as unknown as Looks).people[1]?.look ?? 0;
  const show = (n: number) =>
    page.evaluate(
      async (a) => {
        const k = globalThis.keel;
        await k.showCrew(a.n);
        if (a.n === 0) {
          await k.lookAboard(a.helm);
        }
        await k.crewReady();
      },
      { n, helm },
    );
  await show(40);
  const crew = await page.evaluate(() => globalThis.keel.crew());
  // Thirty-nine at their stations, and one at the wheel in their own look.
  expect(crew.aboard).toBe(39);
  expect(crew.near + crew.far).toBe(39);
  expect(new Set(crew.heads.map((h) => h.station)).size).toBe(39);
  expect(crew.heads.every((h) => h.station >= 1)).toBe(true);
  // Every one aboard her: within her box on the screen.
  const ship = await shipBox(page);
  for (const h of crew.heads) {
    expect(h.x).toBeGreaterThan(ship.left);
    expect(h.x).toBeLessThan(ship.right);
    expect(h.y).toBeGreaterThan(ship.top);
    expect(h.y).toBeLessThan(ship.bottom);
  }

  // Her one sailor and forty in turn: the draws, and the frames' cost.
  const cost = (): Promise<number> => frameMs(page, softwareGPU ? 8 : 60);
  const ms = {
    one: [] as number[],
    forty: [] as number[],
    closeOne: [] as number[],
    close: [] as number[],
  };
  await show(0);
  const one = await counts(page);
  await show(40);
  const forty = await counts(page);
  // From the chase camera, all far: one draw of their far figures (at
  // most 300 triangles each), and its shadow's where the tier has shadows.
  expect(one.aboard).toBe(0);
  expect(forty.far).toBe(39);
  expect(forty.drawCalls - one.drawCalls).toBeLessThanOrEqual(2);
  expect(forty.drawCalls - one.drawCalls).toBeGreaterThan(0);
  expect(forty.triangles - one.triangles).toBeLessThanOrEqual(2 * 39 * 300);
  const rounds = 3;
  for (let round = 0; round < rounds; round++) {
    await show(0);
    ms.one.push(await cost());
    await show(40);
    ms.forty.push(await cost());
  }

  // Close: the dearest view.
  const close = async (n: number) => {
    await show(n);
    await page.evaluate(() =>
      globalThis.keel.camera({ azimuth: 0.35, elevation: 0.55, distance: 2.5 }),
    );
    await page.evaluate(() => globalThis.keel.crewReady());
  };
  await close(0);
  const closeOne = await counts(page);
  await close(40);
  const closeForty = await counts(page);
  // The nearest twelve at the deck level, the rest far: a draw each level,
  // and their shadows'.
  expect(closeForty.near).toBe(12);
  expect(closeForty.near + closeForty.far).toBe(39);
  expect(closeForty.drawCalls - closeOne.drawCalls).toBeLessThanOrEqual(4);
  for (let round = 0; round < rounds; round++) {
    await close(0);
    ms.closeOne.push(await cost());
    await close(40);
    ms.close.push(await cost());
  }
  test.info().annotations.push({
    type: 'measured',
    description: JSON.stringify({ one, forty, closeOne, close: closeForty, ms }),
  });
  // Forty cost little more than one; on a real GPU, a frame, end to end,
  // stays within a frame at 60 Hz.
  // (A software GPU's frames vary by a third from one set to the next.)
  const more = softwareGPU ? 1.5 : 1.25;
  expect(median(ms.forty)).toBeLessThan(median(ms.one) * more + 1);
  expect(median(ms.close)).toBeLessThan(median(ms.closeOne) * (more + 0.15) + 1.5);
  if (!softwareGPU) {
    expect(median(ms.forty)).toBeLessThan(BUDGET);
    expect(median(ms.close)).toBeLessThan(BUDGET);
  }
});

test('five aboard the keelboat: to windward on both tacks, through a tack and a gybe, and after a handover', async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  await openScene(page, 'boat=keelboat&crew=5');
  await page.evaluate(async () => {
    const k = globalThis.keel;
    k.setSky(12);
    // The skipper at the helm: the second aboard as the trimmer.
    await k.showCrew(5, 0);
    await k.crewReady();
    k.freezeTick(k.world.ticks);
  });
  /** Sails frames with the boom held and the bow so far off the wind (radians), and the crew as they then are. */
  const sail = (boom: number, off: number, frames: number) =>
    page.evaluate(
      ({ boom, off, frames }) => {
        const k = globalThis.keel;
        const heading = k.world.wind.meanFrom + off;
        const starts = new Map<number, number>();
        for (let i = 0; i < frames; i++) {
          k.setState({ boom, sailor: 0, heading });
          k.sailFrames(1, 1);
          // When each began to cross, in frames, by the station they left.
          for (const m of k.crew().members) {
            if (m.moving !== null && m.t > 0 && !starts.has(m.from)) {
              starts.set(m.from, i);
            }
          }
        }
        return { ...k.crew(), starts: Object.fromEntries(starts) };
      },
      { boom, off, frames },
    );
  /** A picture of the boat from her windward quarter, for the report. */
  const picture = async (name: string, side: number) => {
    await page.evaluate(async (side) => {
      const k = globalThis.keel;
      k.camera({ azimuth: side > 0 ? -0.8 : 0.8, elevation: 0.5, distance: 5 });
      await k.show();
    }, side);
    await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
  };
  /** Everyone at their station on the windward side, none moving, the helm drawn. */
  const toWindward = (c: Awaited<ReturnType<typeof sail>>, side: number, name: string) => {
    expect(c.aboard, name).toBe(4);
    expect(c.side, name).toBe(side);
    expect(c.helmShown, name).toBe(true);
    expect(
      c.members.filter((m) => m.station > 0).map((m) => m.side),
      name,
    ).toEqual([side, side, side, side]);
    for (const h of c.heads) {
      expect(h.moving, name).toBe(false);
      expect(Math.sign(h.across), `${name}: station ${h.station}`).toBe(side);
    }
    expect(c.heads.map((h) => h.station).sort(), name).toEqual([1, 2, 3, 4]);
  };
  const tack = -0.6;
  const gybe = Math.PI - 0.35;
  // Close-hauled, the boom to starboard: all on the port rail.
  const port = await sail(0.2, tack, 240);
  toWindward(port, -1, 'on port');
  await picture('to windward on port', -1);
  // A tack: each crosses in turn, the trimmer and the quarter first, then
  // the two forward in file round the mast, the bow hand leading; the two
  // forward in each other's places after it.
  const tacked = await sail(-0.2, tack, 300);
  expect(tacked.tack).toBe(true);
  const order = Object.entries(tacked.starts)
    .sort(([, a], [, b]) => (a as number) - (b as number))
    .map(([s]) => Number(s));
  expect(order).toEqual([1, 4, 2, 3]);
  const seatAt = (c: Awaited<ReturnType<typeof sail>>, station: number) =>
    c.members.find((m) => m.station === station)?.seat;
  expect([seatAt(tacked, 2), seatAt(tacked, 3)]).toEqual([3, 2]);
  toWindward(tacked, 1, 'after a tack');
  await picture('to windward on starboard, after a tack', 1);
  // A gybe, from a run, the boom at 29° where it lies over none of them
  // (the boom right over one, they wait for it): the one forward first,
  // the trimmer last; the two forward back in their own places.
  await sail(-0.5, gybe, 60);
  const gybed = await sail(0.5, gybe, 300);
  expect(gybed.tack).toBe(false);
  const gybeOrder = Object.entries(gybed.starts)
    .sort(([, a], [, b]) => (a as number) - (b as number))
    .map(([s]) => Number(s));
  expect(gybeOrder[0]).toBe(2);
  expect(gybeOrder.at(-1)).toBe(1);
  expect([seatAt(gybed, 2), seatAt(gybed, 3)]).toEqual([2, 3]);
  toWindward(gybed, -1, 'after a gybe');
  await picture('to windward on port, after a gybe', -1);
  // The skipper hands over to the bow hand: the two walk to each other's
  // places, the helm's figure away meanwhile.
  const before = await page.evaluate(() => globalThis.keel.crew().helm);
  await page.evaluate(async () => {
    const k = globalThis.keel;
    await k.showCrew(5, 2);
    await k.crewReady();
  });
  const walking = await sail(0.5, gybe, 30);
  expect(walking.helmAway).toBe(true);
  expect(walking.helmShown).toBe(false);
  expect(
    walking.members
      .filter((m) => m.moving === 'change')
      .map((m) => m.seat)
      .sort(),
  ).toEqual([0, 2]);
  await picture('changing places', -1);
  const handed = await sail(0.5, gybe, 240);
  toWindward(handed, -1, 'after a handover');
  expect(handed.helm).not.toBe(before);
  // The skipper where the bow hand was; the bow hand at the helm.
  expect(handed.members.find((m) => m.seat === 0)?.station).toBe(2);
  expect(handed.members.find((m) => m.seat === 2)?.station).toBe(-1);
  await picture('after a handover', -1);
});

test('two aboard the skiff: the crew to windward of the boom, after a tack and after a handover', async ({
  page,
}) => {
  const skiff = data.boats.find(
    (b) => b.capacity === 2 && b.stations.some((s) => 'windward' in s && s.windward),
  );
  test.skip(skiff === undefined, 'no kind has a crew of two to windward');
  await openScene(page, `boat=${skiff?.id}&crew=2`);
  const out = await page.evaluate(async () => {
    const k = globalThis.keel;
    await k.crewReady();
    k.freezeTick(k.world.ticks);
    // Frames with the helm held this far out, close-hauled with the wind on
    // that side, the boom on the other.
    const sail = (sailor: number, frames: number) => {
      const heading = k.world.wind.meanFrom - Math.sign(sailor) * 0.8;
      for (let i = 0; i < frames; i++) {
        k.setState({ sailor, boom: -0.3 * Math.sign(sailor), heading });
        k.sailFrames(1, 1);
      }
      return k.crew();
    };
    // Met on the starboard rack.
    k.setState({ sailor: 0.8, boom: -0.3, heading: k.world.wind.meanFrom - 0.8 });
    k.settleSailor();
    const starboard = sail(0.8, 150);
    // A tack: the helm crosses to the port rack, and the crew at a crouch.
    const crossing = sail(-0.8, 25);
    const tacked = sail(-0.8, 150);
    // Handed over: the other holds the controls, the first is crew.
    await k.showCrew(2, 0);
    await k.crewReady();
    const handed = sail(-0.8, 150);
    return { starboard, crossing, tacked, handed };
  });
  for (const [name, c, side] of [
    ['on the starboard rack', out.starboard, 1],
    ['after a tack', out.tacked, -1],
    ['after a handover', out.handed, -1],
  ] as const) {
    expect(c.aboard, name).toBe(1);
    expect(c.side, name).toBe(side);
    expect(Math.sign(c.heads[0]?.across ?? 0), name).toBe(side);
    expect(Math.abs(c.heads[0]?.across ?? 0), name).toBeGreaterThan(0.5);
  }
  // Crossing at a crouch, not carried over still.
  expect(out.crossing.members.find((m) => m.station > 0)?.moving).toBe('cross');
  // The two changed places: another look at the helm.
  expect(out.handed.helm).not.toBe(out.tacked.helm);
});

test('a friend’s boat near a crewed keelboat, skiff and tall ship sees their crews: to windward, through a tack and a handover', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const kindOf = (pred: (b: (typeof data.boats)[number]) => boolean) => data.boats.findIndex(pred);
  const keelboat = kindOf((b) => b.stations.some((s) => s.pose === 'rail'));
  const skiff = kindOf(
    (b) => b.capacity === 2 && b.stations.some((s) => 'windward' in s && s.windward),
  );
  const ship = kindOf((b) => b.capacity >= 40);
  await openScene(page, 'boat=jolly-boat');
  await page.evaluate(
    async ({ keelboat, skiff, ship }) => {
      const k = globalThis.keel;
      k.setSky(12);
      const from = k.world.wind.meanFrom;
      const me = k.boat().state;
      const at = (ahead: number, beam: number) => ({
        east: me.x + Math.sin(me.heading) * ahead + Math.cos(me.heading) * beam,
        north: me.y + Math.cos(me.heading) * ahead - Math.sin(me.heading) * beam,
      });
      // Each close-hauled on port, the boom to starboard: her crew on the port rail.
      const boat = (kind: number, n: number, seed: number, ahead: number, beam: number) => {
        const { crew, look } = k.fleetCrew(n, 0, seed);
        return {
          kind,
          crew,
          look,
          ...at(ahead, beam),
          heading: from - 0.7,
          boom: 0.25,
          sailor: -0.3,
        };
      };
      k.setFleet([
        boat(keelboat, 5, 1, 12, 6),
        boat(skiff, 2, 2, 22, -6),
        boat(ship, 40, 3, 60, 25),
      ]);
      await k.fleetLoaded();
      await k.fleetCrewsReady();
      k.freezeTick(k.world.ticks);
    },
    { keelboat, skiff, ship },
  );
  /** Sails frames, the keelboat's boom and heading as given, and the crews as they then are. */
  const sail = (frames: number, boom: number, off: number) =>
    page.evaluate(
      ({ frames, boom, off }) => {
        const k = globalThis.keel;
        const starts = new Map<number, number>();
        for (let i = 0; i < frames; i++) {
          k.moveFleet(0, { boom, heading: k.world.wind.meanFrom + off });
          k.sailFrames(1, 1);
          for (const m of k.fleetCrews().boats.find((b) => b.slot === 0)?.members ?? []) {
            if (m.moving !== null && m.t > 0 && !starts.has(m.from)) {
              starts.set(m.from, i);
            }
          }
        }
        return { ...k.fleetCrews(), starts: Object.fromEntries(starts) };
      },
      { frames, boom, off },
    );
  const picture = async (
    name: string,
    view: { azimuth: number; elevation: number; distance: number },
  ) => {
    await page.evaluate(async (v) => {
      const k = globalThis.keel;
      k.camera(v);
      await k.show();
    }, view);
    await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
  };
  const boatOf = (c: Awaited<ReturnType<typeof sail>>, slot: number) => {
    const b = c.boats.find((x) => x.slot === slot);
    expect(b, `the boat in slot ${slot}`).toBeDefined();
    return b as NonNullable<typeof b>;
  };
  const toWindward = (
    c: Awaited<ReturnType<typeof sail>>,
    slot: number,
    n: number,
    side: number,
    name: string,
  ) => {
    const b = boatOf(c, slot);
    expect(b.drawn, name).toBe(true);
    expect(b.side, name).toBe(side);
    const crew = b.members.filter((m) => m.station > 0);
    expect(crew, name).toHaveLength(n);
    expect(
      crew.every((m) => m.moving === null),
      name,
    ).toBe(true);
    expect(b.heads, name).toHaveLength(n);
  };
  const met = await sail(60, 0.25, -0.7);
  // The keelboat's four and the skiff's one to windward (port); the ship's thirty-nine at their stations.
  toWindward(met, 0, 4, -1, 'the keelboat');
  toWindward(met, 1, 1, -1, 'the skiff');
  expect(boatOf(met, 2).members.filter((m) => m.station > 0)).toHaveLength(39);
  expect(boatOf(met, 2).heads).toHaveLength(39);
  expect(met.drawn.near + met.drawn.far).toBe(44);
  await picture('a friend near a keelboat of five, a skiff of two and a tall ship of forty', {
    azimuth: 2.6,
    elevation: 0.35,
    distance: 30,
  });
  // The keelboat tacks: her crew cross in turn, to the starboard rail.
  const tacking = await sail(40, -0.25, 0.7);
  await picture('the keelboat tacking, her crew crossing', {
    azimuth: 2.6,
    elevation: 0.5,
    distance: 18,
  });
  const tacked = await sail(300, -0.25, 0.7);
  // When each began, counting on from the first forty frames.
  const later = Object.fromEntries(
    Object.entries(tacked.starts).map(([s, i]) => [s, (i as number) + 40]),
  );
  const order = Object.entries({ ...later, ...tacking.starts })
    .sort(([, a], [, b]) => (a as number) - (b as number))
    .map(([s]) => Number(s));
  // The trimmer and the quarter first, then the two forward in file.
  expect(order).toEqual([1, 4, 2, 3]);
  toWindward(tacked, 0, 4, 1, 'the keelboat after her tack');
  await picture('the keelboat after her tack, her crew on the starboard rail', {
    azimuth: 2.6,
    elevation: 0.5,
    distance: 18,
  });
  // Her skipper hands the controls to her trimmer: the two change places, her helm away from the tiller meanwhile.
  await page.evaluate(() => {
    const k = globalThis.keel;
    const { crew } = k.fleetCrew(5, 1, 1);
    k.moveFleet(0, { crew, look: crew.people[1]?.look ?? -1 });
  });
  const walking = await sail(20, -0.25, 0.7);
  expect(boatOf(walking, 0).helmAway).toBe(true);
  expect(
    boatOf(walking, 0)
      .members.filter((m) => m.moving === 'change')
      .map((m) => m.seat)
      .sort(),
  ).toEqual([0, 1]);
  await picture('the keelboat changing hands', { azimuth: 2.6, elevation: 0.5, distance: 18 });
  const handed = await sail(240, -0.25, 0.7);
  expect(boatOf(handed, 0).helmAway).toBe(false);
  expect(boatOf(handed, 0).members.find((m) => m.seat === 0)?.station).toBe(1);
  toWindward(handed, 0, 4, 1, 'the keelboat after the handover');
});
