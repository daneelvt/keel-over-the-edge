// SPDX-License-Identifier: AGPL-3.0-only

// People aboard, on a phone's screen (360 × 640): forty aboard the tall
// ship, every one drawn in their own look at their station on her deck and
// one at the wheel, in a few more draws than her one sailor, her frames
// within the budget of a frame at 60 Hz on a real GPU and little dearer
// than with her one sailor on any. Far off, as the chase camera sees the ship, the crew are the looks' far
// figures; close, the nearest twelve their deck level. The keelboat's
// five to windward of the boom on both tacks, crossing in a tack and a
// gybe in turn, and changing places at a handover; the skiff's two
// likewise. The beach cat's two on her windward hull and out on the wire
// together, across her net in a tack (the crew first) and a gybe (the helm
// first), changing places along her hull, and in the water, up on her
// lower hull and back aboard after a capsize; and seen so from a friend's
// boat near her. The yacht's eight: her helm at the windward wheel, three
// on her windward bench and four on her windward rail, crossing in a tack
// and a gybe in their order, changing places at a handover; and all eight
// seen from a friend's boat near her. The catamaran's twelve: two at her
// helm, five at her table, three on her aft bench and two on her lounger,
// sat up in a light wind and braced in a breeze, nobody moving in a tack
// or a gybe, a handover a walk along her cockpit and up her helm's ladder;
// and all twelve seen from a friend's boat near her.

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

test('forty aboard the tall ship: alive at their stations, through a tack and a reef, and a handover that relieves the wheel, within a frame’s budget', async ({
  page,
}, info) => {
  test.setTimeout(300_000);
  await openScene(page, 'boat=tall-ship&crew=40');
  await page.evaluate(async () => {
    const k = globalThis.keel;
    k.setSky(12);
    k.setWind(16, 0);
    await k.crewReady();
    k.freezeTick(k.world.ticks);
    k.setControls(0, 0.2);
  });
  /**
   * Sails on as the physics has her, so many seconds, so many ticks a
   * frame; each frame what is asked of the crew then, and the crew at the
   * end.
   */
  const run = (seconds: number, steps: number, until: 'after' | 'fore' | null = null) =>
    page.evaluate(
      ({ seconds, steps, until }) => {
        const k = globalThis.keel;
        const seen = {
          groups: [] as string[],
          most: 0,
          hauling: 0,
          falls: 0,
          aloft: 0,
          onYards: 0,
          yardClips: 0,
        };
        for (let i = 0; i < (seconds * 30) / steps; i++) {
          k.sailFrames(1, steps);
          const c = k.crew();
          const g = c.gang?.group;
          if (g !== undefined && !seen.groups.includes(g)) {
            seen.groups.push(g);
          }
          const work = c.members.filter((m) => m.work?.kind === 'haul');
          seen.most = Math.max(seen.most, work.length);
          seen.hauling = Math.max(
            seen.hauling,
            c.heads.filter((h) => h.clip?.startsWith('haul') === true).length,
          );
          seen.falls = Math.max(seen.falls, c.braces);
          seen.aloft = Math.max(
            seen.aloft,
            c.members.filter((m) => m.work?.kind === 'aloft').length,
          );
          const out = c.heads.filter((h) => h.clip?.startsWith('yard') === true);
          seen.yardClips = Math.max(seen.yardClips, out.length);
          seen.onYards = Math.max(seen.onYards, out.filter((h) => h.model[1] > 20).length);
          if (until !== null && g === until) {
            break;
          }
        }
        return { ...k.crew(), seen };
      },
      { seconds, steps, until },
    );
  const picture = async (name: string, view = { azimuth: 0.5, elevation: 0.5, distance: 1.2 }) => {
    await page.evaluate(async (v) => {
      const k = globalThis.keel;
      k.camera(v);
      await k.show();
    }, view);
    await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
  };
  const at = (c: Awaited<ReturnType<typeof run>>, seat: number) =>
    c.heads.find((h) => h.seat === seat);
  // Under way, close-hauled on the autopilot, the wind over her port side.
  await run(30, 30);
  await page.evaluate(() => globalThis.keel.autopilot('wind'));
  const port = await run(10, 30);
  expect(port.aboard).toBe(39);
  expect(port.side).toBe(-1);
  // Seat 1 holds the controls; the skipper beside the wheel to windward, seat 2 to leeward.
  expect(port.wheel).toBe(1);
  expect(Math.sign(at(port, 0)?.model[0] ?? 0)).toBe(-1);
  expect(Math.sign(at(port, 2)?.model[0] ?? 0)).toBe(1);
  // Alive: idles of every kind about her; one in the top; none still for long.
  const clips = new Set(port.heads.map((h) => h.clip));
  expect(clips.size).toBeGreaterThanOrEqual(4);
  expect(port.heads.some((h) => h.station === 7 && h.model[1] > 13)).toBe(true);
  // Her braces drawn, two lines each a side, none hauled.
  expect(port.braces).toBe(32);
  await picture('forty aboard, the weather to port');
  const later = await run(60, 30);
  const changed = later.heads.filter(
    (h) => port.heads.find((p) => p.seat === h.seat)?.clip !== h.clip,
  ).length;
  expect(changed).toBeGreaterThan(5);
  // About: the after yards swing at "mainsail haul" and the hands go to
  // their lee braces and haul; then forward to the head braces at "let go
  // and haul"; the two beside the wheel cross to the new weather and lee
  // sides; then all back.
  await page.evaluate(() => globalThis.keel.autopilot('tack'));
  const ready = await run(80, 15, 'after');
  expect(ready.gang?.group).toBe('after');
  const haul = await run(14, 15);
  expect(haul.seen.groups).toEqual(['after']);
  expect(haul.seen.most).toBeGreaterThan(10);
  expect(haul.seen.hauling).toBeGreaterThan(4);
  expect(haul.seen.falls).toBeGreaterThan(32);
  // What forty at work cost: a frame drawn as they haul and walk.
  const working = await frameMs(page, softwareGPU ? 6 : 30);
  await picture('mainsail haul: the hands at the after braces, to leeward', {
    azimuth: -1.2,
    elevation: 0.45,
    distance: 0.9,
  });
  const forward = await run(40, 15, 'fore');
  expect(forward.gang?.group).toBe('fore');
  await run(12, 15);
  await picture('let go and haul: at the head braces', {
    azimuth: -1.6,
    elevation: 0.5,
    distance: 0.9,
  });
  const tacked = await run(60, 15);
  expect(tacked.gang).toBeNull();
  expect(tacked.members.every((m) => m.moving === null && (m.work ?? null) === null)).toBe(true);
  expect(tacked.side).toBe(1);
  expect(Math.sign(at(tacked, 0)?.model[0] ?? 0)).toBe(1);
  expect(Math.sign(at(tacked, 2)?.model[0] ?? 0)).toBe(-1);
  await picture('after a tack, the weather to starboard');
  // The topgallants taken in: the topmen up the weather shrouds and out
  // on the topgallant yards, down again once the reef is in.
  await page.evaluate(() => globalThis.keel.setReef(1));
  const reefing = await run(100, 30);
  expect(reefing.aloftBand).toBe(1);
  expect(reefing.seen.aloft).toBe(8);
  expect(reefing.seen.onYards).toBeGreaterThanOrEqual(6);
  await picture('taking in the topgallants: the topmen on the yards', {
    azimuth: 1.4,
    elevation: 0.35,
    distance: 1.6,
  });
  const reefed = await run(90, 30);
  expect(reefed.aloftBand).toBe(0);
  expect(reefed.members.every((m) => m.moving === null && (m.work ?? null) === null)).toBe(true);
  const tacked2 = reefed;
  // A handover to seat 2, to leeward of the wheel: seat 1 keeps the wheel
  // till seat 2 has come behind them; then seat 1 walks to their own place,
  // and the skipper, who stood there, to seat 2's.
  const helmBefore = tacked2.helm;
  await page.evaluate(async () => {
    const k = globalThis.keel;
    await k.showCrew(40, 2);
    await k.crewReady();
  });
  const walking = await run(2, 3);
  expect(walking.wheel).toBe(1);
  expect(walking.helm).toBe(helmBefore);
  expect(walking.members.find((m) => m.seat === 2)?.moving).not.toBeNull();
  await picture('the relief walking aft to the wheel');
  const relieved = await run(12, 6);
  expect(relieved.wheel).toBe(2);
  expect(relieved.members.some((m) => m.seat === 2)).toBe(false);
  expect(relieved.members.find((m) => m.seat === 1)?.station).toBe(1);
  expect(relieved.members.find((m) => m.seat === 0)?.station).toBe(2);
  await page.evaluate(() => globalThis.keel.crewReady());
  await expect.poll(() => page.evaluate(() => globalThis.keel.crew().helm)).not.toBe(helmBefore);
  const done = await run(6, 6);
  expect(done.members.every((m) => m.moving === null)).toBe(true);
  expect(at(done, 1)?.station).toBe(1);
  expect(at(done, 0)?.station).toBe(2);
  await picture('relieved, the old helmsman back at their place');
  // Within a frame's budget: forty idling cost little more than her helmsman alone.
  const cost = (): Promise<number> => frameMs(page, softwareGPU ? 6 : 30);
  const forty = await cost();
  await page.evaluate(async () => {
    const k = globalThis.keel;
    await k.showCrew(1);
    await k.crewReady();
  });
  const one = await cost();
  test.info().annotations.push({
    type: 'measured',
    description: JSON.stringify({ one, forty, working }),
  });
  expect(forty).toBeLessThan(one * (softwareGPU ? 1.6 : 1.3) + 1.5);
  expect(working).toBeLessThan(one * (softwareGPU ? 1.6 : 1.3) + 1.5);
  if (!softwareGPU) {
    expect(forty).toBeLessThan(BUDGET);
    expect(working).toBeLessThan(BUDGET);
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
    // that side, the boom on the other, held upright (a capsize would put
    // everyone in the water).
    const sail = (sailor: number, frames: number) => {
      const heading = k.world.wind.meanFrom - Math.sign(sailor) * 0.8;
      for (let i = 0; i < frames; i++) {
        k.setState({ sailor, boom: -0.3 * Math.sign(sailor), heading, heel: 0, sailorMode: 0 });
        k.sailFrames(1, 1);
      }
      return k.crew();
    };
    // Met on the starboard rack.
    k.setState({ sailor: 0.8, boom: -0.3, heading: k.world.wind.meanFrom - 0.8, heel: 0 });
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

test('two aboard the beach cat: on her windward hull and out on the wire, across her net in a tack and a gybe in their order, changing places along her hull, and in the water and righting her together after a capsize', async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const cat = data.boats.find((b) => b.physics.hulls.hullSpacing > 0);
  test.skip(cat === undefined, 'no kind has two hulls');
  await openScene(page, `boat=${cat?.id}&crew=2`);
  await page.evaluate(async () => {
    const k = globalThis.keel;
    k.setSky(12);
    await k.crewReady();
    k.freezeTick(k.world.ticks);
  });
  /**
   * Sails frames of 0.1 s, each with the state script gives at its time
   * (s): the boom, the sailor's offset and mode, the heel, and the bow so
   * far off the wind (radians, + with the wind over starboard); the crew as
   * they then are, and when each first set off across her net.
   */
  const sail = (seconds: number, script: string) =>
    page.evaluate(
      ({ seconds, script }) => {
        const k = globalThis.keel;
        const at = new Function('t', `return (${script})(t);`) as (t: number) => {
          boom: number;
          sailor: number;
          off: number;
          heel?: number;
          mode?: number;
        };
        let crewGoes = Number.POSITIVE_INFINITY;
        let helmGoes = Number.POSITIVE_INFINITY;
        const wet = new Set<string>();
        const changed = new Set<number>();
        let wires = 0;
        for (let i = 0; i * 0.1 <= seconds; i++) {
          const t = i * 0.1;
          const s = at(t);
          k.setState({
            boom: s.boom,
            sheetLimit: Math.abs(s.boom),
            sailor: s.sailor,
            heel: s.heel ?? 0,
            sailorMode: s.mode ?? 0,
            sailorTimer: 30,
            heading: k.world.wind.meanFrom - s.off,
          });
          k.sailFrames(1, 3);
          const c = k.crew();
          for (const m of c.members) {
            if (m.net !== null) {
              crewGoes = Math.min(crewGoes, t);
            }
            if (m.wet !== null) {
              wet.add(m.wet);
            }
            if (m.moving === 'change') {
              changed.add(m.seat);
            }
          }
          if (c.helmNet !== null) {
            helmGoes = Math.min(helmGoes, t);
          }
          wires = Math.max(wires, c.crewWires.filter((w) => w).length);
        }
        return {
          ...k.crew(),
          crewGoes,
          helmGoes,
          wet: [...wet],
          changed: [...changed],
          wiresSeen: wires,
        };
      },
      { seconds, script },
    );
  const picture = async (name: string, view = { azimuth: -0.6, elevation: 0.7, distance: 5 }) => {
    await page.evaluate(async (v) => {
      const k = globalThis.keel;
      k.camera(v);
      await k.show();
    }, view);
    await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
  };
  const crewOf = (c: Awaited<ReturnType<typeof sail>>) => c.members.find((m) => m.station > 0);
  // Close-hauled, the wind over starboard, the boom to port: both on the
  // starboard hull, sat; then the helm out on the wire, and the crew with them.
  const sat = await sail(4, '() => ({ boom: -0.25, sailor: 0.8, off: 0.8 })');
  expect(sat.aboard).toBe(1);
  expect(sat.side).toBe(1);
  expect(crewOf(sat)?.lean).toBe(0);
  expect(sat.heads[0]?.across).toBeGreaterThan(0.5);
  await picture('two aboard, sat on her starboard hull');
  const wire = await sail(4, '() => ({ boom: -0.25, sailor: 2.1, off: 0.8 })');
  expect(crewOf(wire)?.lean).toBe(1);
  expect(wire.crewWires).toEqual([true, false]);
  expect(wire.heads[0]?.across).toBeGreaterThan(1.5);
  await picture('both out on the wire to starboard');
  // A tack: the bow through the wind over 4 s, the boom over as it passes,
  // the helm's weight over a second later. The crew first, as the wind
  // comes ahead; the helm once they are clear.
  const tacked = await sail(
    12,
    `(t) => {
      const turn = Math.max(0, Math.min(1, t / 4));
      const off = 0.8 - turn * 1.6;
      const boom = off > 0 ? -Math.min(0.25, off * 0.6) : Math.min(0.25, -off * 0.6);
      const over = Math.max(0, Math.min(1, (t - 3) / 1.5));
      return { boom, sailor: 0.8 - 1.6 * over, off };
    }`,
  );
  expect(tacked.crewGoes).toBeLessThan(tacked.helmGoes);
  expect(tacked.helmGoes).toBeLessThan(12);
  expect(tacked.side).toBe(-1);
  expect(crewOf(tacked)?.side).toBe(-1);
  expect(crewOf(tacked)?.moving).toBeNull();
  expect(tacked.helmSide).toBe(-1);
  await picture('after a tack, both on her port hull', {
    azimuth: 0.6,
    elevation: 0.7,
    distance: 5,
  });
  // A gybe: from a broad reach on port to one on starboard, the boom over
  // fast. The helm first; the crew once the helm is along the way.
  const gybed = await sail(
    12,
    `(t) => {
      const turn = Math.max(0, Math.min(1, t / 3));
      const off = -(2.4 + turn * 1.5);
      const boom = t < 1.5 ? 1.1 : t < 2 ? 1.1 - (t - 1.5) * 4.4 : -1.1;
      const over = Math.max(0, Math.min(1, (t - 2.5) / 1.5));
      return { boom, sailor: -0.8 + 1.6 * over, off: Math.atan2(Math.sin(off), Math.cos(off)) };
    }`,
  );
  expect(gybed.helmGoes).toBeLessThan(gybed.crewGoes);
  expect(gybed.crewGoes).toBeLessThan(12);
  expect(gybed.side).toBe(1);
  expect(crewOf(gybed)?.side).toBe(1);
  expect(gybed.helmSide).toBe(1);
  await picture('after a gybe, both on her starboard hull');
  // A handover: the crew to the helm along her hull, the helm forward on the net beside it.
  const helmBefore = gybed.helm;
  await page.evaluate(async () => {
    const k = globalThis.keel;
    await k.showCrew(2, 0);
    await k.crewReady();
  });
  const handed = await sail(8, '() => ({ boom: -0.25, sailor: 0.8, off: 0.8 })');
  expect(handed.changed.sort()).toEqual([0, 1]);
  expect(handed.helm).not.toBe(helmBefore);
  expect(handed.members.every((m) => m.moving === null)).toBe(true);
  expect(crewOf(handed)?.side).toBe(1);
  await picture('after a handover');
  // A capsize: in the water as the sailor falls in, up on her lower hull
  // as the sailor rights her, climbing back as she comes up.
  const capsized = await sail(
    16,
    `(t) => {
      const mode = t < 5 ? 1 : t < 10 ? 2 : t < 12 ? 3 : 0;
      const heel = t < 8 ? 1.45 : t < 12 ? 1.45 - (t - 8) * 0.34 : 0.05;
      return { boom: -0.25, sailor: mode === 0 ? 0.8 : 0, off: 0.8, heel, mode };
    }`,
  );
  expect(capsized.wet.sort()).toEqual(['board', 'climb', 'water']);
  expect(crewOf(capsized)?.wet).toBeNull();
  expect(crewOf(capsized)?.side).toBe(1);
  await picture('righted, both back aboard');
});

test('eight aboard the yacht: three on her windward bench and four on her windward rail on both tacks, leaning out as she heels, through a tack and a gybe in their order, and after a handover', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  // The kind whose people are drawn with a cruising yacht's clips.
  const yacht = data.boats.find((b) =>
    (b.art.sailorClips as string[] | undefined)?.includes('cruiser'),
  );
  test.skip(yacht === undefined, 'no kind names a cruising yacht’s clips');
  const kind = yacht as NonNullable<typeof yacht>;
  await openScene(page, `boat=${kind.id}&crew=${kind.capacity}`);
  await page.evaluate(async (n) => {
    const k = globalThis.keel;
    k.setSky(12);
    // The skipper at the helm.
    await k.showCrew(n, 0);
    await k.crewReady();
    k.freezeTick(k.world.ticks);
  }, kind.capacity);
  /** Sails frames with the boom held, the bow so far off the wind and her heel (radians), and the crew as they then are. */
  const sail = (boom: number, off: number, heel: number, frames: number) =>
    page.evaluate(
      ({ boom, off, heel, frames }) => {
        const k = globalThis.keel;
        const heading = k.world.wind.meanFrom + off;
        const starts = new Map<number, number>();
        for (let i = 0; i < frames; i++) {
          k.setState({ boom, sailor: 0, heading, heel });
          k.sailFrames(1, 3);
          // When each began to move, in frames, by the station they left.
          for (const m of k.crew().members) {
            if (m.moving !== null && m.t > 0 && !starts.has(m.from)) {
              starts.set(m.from, i);
            }
          }
        }
        return { ...k.crew(), starts: Object.fromEntries(starts) };
      },
      { boom, off, heel, frames },
    );
  const picture = async (name: string, side: number) => {
    await page.evaluate(async (side) => {
      const k = globalThis.keel;
      k.camera({ azimuth: side > 0 ? -0.9 : 0.9, elevation: 0.55, distance: 12 });
      await k.show();
    }, side);
    await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
  };
  const pose = (station: number): string | undefined => kind.stations[station]?.pose;
  /** Everyone at their station on the windward side, none moving, the helm at the windward wheel. */
  const toWindward = (c: Awaited<ReturnType<typeof sail>>, side: number, name: string) => {
    expect(c.aboard, name).toBe(kind.capacity - 1);
    expect(c.side, name).toBe(side);
    expect(c.helmShown, name).toBe(true);
    expect(c.helmWheel, name).toBe(side);
    expect(c.helmWalking, name).toBe(false);
    const crew = c.members.filter((m) => m.station > 0);
    expect(
      crew.map((m) => m.side),
      name,
    ).toEqual(crew.map(() => side));
    for (const h of c.heads) {
      expect(h.moving, name).toBe(false);
      expect(Math.sign(h.across), `${name}: station ${h.station}`).toBe(side);
    }
    expect(
      c.heads.filter((h) => pose(h.station) === 'bench'),
      name,
    ).toHaveLength(3);
    expect(
      c.heads.filter((h) => pose(h.station) === 'rail'),
      name,
    ).toHaveLength(4);
  };
  const tack = -0.75;
  // A broad reach: the wind well over a quarter, not by the lee.
  const gybe = Math.PI - 0.7;
  const heeled = 0.2;
  // Close-hauled, the boom to starboard, heeled to starboard: on the port
  // bench and the port rail, leaning out.
  const port = await sail(0.15, tack, heeled, 120);
  toWindward(port, -1, 'on port');
  expect(port.members.filter((m) => m.station > 0).every((m) => m.lean === 1)).toBe(true);
  await picture('eight aboard on port, leaning out', -1);
  // A light wind, upright: sat up.
  const upright = await sail(0.15, tack, 0.02, 60);
  expect(upright.members.filter((m) => m.station > 0).every((m) => m.lean === 0)).toBe(true);
  await picture('eight aboard on port, sat up', -1);
  // A tack: the cockpit first, the trimmer leading, then the rail once she
  // has come upright, in file over the coachroof.
  const tacking = await sail(-0.15, -tack, 0.02, 60);
  await picture('tacking: the cockpit crossing', -1);
  const tacked = await sail(-0.15, -tack, -heeled, 360);
  expect(tacked.tack).toBe(true);
  // When each began, counting on from the first sixty frames.
  const starts: Record<string, number> = Object.fromEntries(
    Object.entries(tacked.starts).map(([s, i]) => [s, (i as number) + 60]),
  );
  for (const [s, i] of Object.entries(tacking.starts)) {
    starts[s] = i as number;
  }
  const order = Object.entries(starts)
    .sort(([, a], [, b]) => (a as number) - (b as number))
    .map(([s]) => Number(s));
  expect(order).toHaveLength(kind.capacity - 1);
  expect(order[0]).toBe(1);
  expect(pose(order[1] as number)).toBe('bench');
  toWindward(tacked, 1, 'after a tack');
  await picture('eight aboard on starboard, after a tack', 1);
  // A gybe from a broad reach on starboard, the wind over her starboard
  // quarter, to one on port: the rail first.
  const reach = await sail(0.9, gybe, 0, 30);
  // The windward side by the wind, and the boom to leeward of it: all there.
  const from = reach.helmWheel;
  await sail(-from * 0.9, gybe, 0, 240);
  // The wind over the other quarter, the boom over.
  const gybed = await sail(from * 0.9, -gybe, 0, 420);
  expect(gybed.tack).toBe(false);
  const gybeOrder = Object.entries(gybed.starts)
    .sort(([, a], [, b]) => (a as number) - (b as number))
    .map(([s]) => Number(s));
  expect(pose(gybeOrder[0] as number)).toBe('rail');
  toWindward(gybed, -from, 'after a gybe');
  await picture('eight aboard after a gybe', -from);
  // The skipper hands over to the one at the bench's forward end: the two
  // walk to each other's places, the helm's figure away meanwhile.
  const bench = kind.stations.findIndex((s, i) => s.pose === 'bench' && i > 1);
  await page.evaluate(async (holder) => {
    const k = globalThis.keel;
    await k.showCrew(8, holder);
    await k.crewReady();
  }, bench);
  const walking = await sail(from * 0.9, -gybe, 0, 30);
  expect(walking.helmAway).toBe(true);
  expect(
    walking.members
      .filter((m) => m.moving === 'change')
      .map((m) => m.seat)
      .sort(),
  ).toEqual([0, bench]);
  await picture('changing places', -from);
  const handed = await sail(from * 0.9, -gybe, 0, 240);
  toWindward(handed, -from, 'after a handover');
  expect(handed.members.find((m) => m.seat === 0)?.station).toBe(bench);
  expect(handed.members.find((m) => m.seat === bench)?.station).toBe(-1);
  await picture('after a handover', -from);
});

test('a friend’s boat near a crewed yacht sees all eight: the helm at the windward wheel, three on the bench and four on the rail, through a tack', async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const yacht = data.boats.findIndex((b) =>
    (b.art.sailorClips as string[] | undefined)?.includes('cruiser'),
  );
  test.skip(yacht < 0, 'no kind names a cruising yacht’s clips');
  const capacity = data.boats[yacht]?.capacity ?? 0;
  await openScene(page, 'boat=jolly-boat');
  await page.evaluate(
    async ({ yacht, capacity }) => {
      const k = globalThis.keel;
      k.setSky(12);
      const from = k.world.wind.meanFrom;
      const me = k.boat().state;
      const { crew, look } = k.fleetCrew(capacity, 0, 7);
      k.setFleet([
        {
          kind: yacht,
          crew,
          look,
          east: me.x + Math.sin(me.heading) * 14 + Math.cos(me.heading) * 8,
          north: me.y + Math.cos(me.heading) * 14 - Math.sin(me.heading) * 8,
          heading: from - 0.75,
          boom: 0.15,
          heel: 0.2,
          sailor: 0,
        },
      ]);
      await k.fleetLoaded();
      await k.fleetCrewsReady();
      k.freezeTick(k.world.ticks);
    },
    { yacht, capacity },
  );
  const sail = (frames: number, boom: number, off: number, heel: number) =>
    page.evaluate(
      ({ frames, boom, off, heel }) => {
        const k = globalThis.keel;
        for (let i = 0; i < frames; i++) {
          k.moveFleet(0, { boom, heel, heading: k.world.wind.meanFrom + off });
          k.sailFrames(1, 3);
        }
        return k.fleetCrews().boats.find((b) => b.slot === 0);
      },
      { frames, boom, off, heel },
    );
  const picture = async (name: string) => {
    await page.evaluate(async () => {
      const k = globalThis.keel;
      k.camera({ azimuth: 2.6, elevation: 0.4, distance: 22 });
      await k.show();
    });
    await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
  };
  const met = await sail(60, 0.15, -0.75, 0.2);
  expect(met?.drawn).toBe(true);
  expect(met?.side).toBe(-1);
  // Everyone but her helm (the fleet's sailor, at her wheel) drawn, to windward.
  expect(met?.members.filter((m) => m.station > 0)).toHaveLength(capacity - 1);
  expect(met?.heads).toHaveLength(capacity - 1);
  expect(met?.members.filter((m) => m.station > 0).every((m) => m.side === -1)).toBe(true);
  await picture('a friend near the yacht and her eight');
  // She tacks: all of them across, to the starboard side.
  const tacked = await sail(420, -0.15, 0.75, -0.2);
  expect(tacked?.side).toBe(1);
  expect(
    tacked?.members.filter((m) => m.station > 0 && m.moving === null && m.side === 1),
  ).toHaveLength(capacity - 1);
  await picture('a friend near the yacht after her tack');
});

/** The kind whose people are drawn with a cruising catamaran's clips. */
const catamaran = data.boats.findIndex((b) =>
  (b.art.sailorClips as string[] | undefined)?.includes('bridgedeck'),
);

test('twelve aboard the catamaran: two at her helm, five at her table, three on her aft bench and two on her lounger, sat up in a light wind and braced in a breeze, nobody moving in a tack or a gybe, and a handover up her ladder', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  test.skip(catamaran < 0, 'no kind names a cruising catamaran’s clips');
  const kind = data.boats[catamaran] as (typeof data.boats)[number];
  await openScene(page, `boat=${kind.id}&crew=${kind.capacity}`);
  /** Shows n aboard, the seat given holding the controls, and holds the world's time. */
  const aboard = (n: number, holder = 0) =>
    page.evaluate(
      async ({ n, holder }) => {
        const k = globalThis.keel;
        k.setSky(12);
        await k.showCrew(n, holder);
        await k.crewReady();
        k.freezeTick(k.world.ticks);
      },
      { n, holder },
    );
  /** Sails frames in a wind (knots), the boom held, the bow so far off the wind, and the crew as they then are. */
  const sail = (knots: number, boom: number, off: number, frames: number) =>
    page.evaluate(
      ({ knots, boom, off, frames }) => {
        const k = globalThis.keel;
        const from = k.world.wind.meanFrom;
        k.setWind(knots, from);
        const moved = new Set<number>();
        for (let i = 0; i < frames; i++) {
          k.setState({ boom, sailor: 0, heading: from + off, heel: 0.02 });
          k.sailFrames(1, 3);
          for (const m of k.crew().members) {
            if (m.moving !== null && m.t > 0) {
              moved.add(m.seat);
            }
          }
        }
        return { ...k.crew(), moved: [...moved] };
      },
      { knots, boom, off, frames },
    );
  const picture = async (name: string, azimuth = -2.4) => {
    await page.evaluate(async (azimuth) => {
      const k = globalThis.keel;
      k.camera({ azimuth, elevation: 0.6, distance: 13 });
      await k.show();
    }, azimuth);
    await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
  };
  const pose = (station: number): string | undefined => kind.stations[station]?.pose;
  /** Everyone at their station, nobody moving: where their heads are, by the seat's place. */
  const seated = (c: Awaited<ReturnType<typeof sail>>, n: number, name: string) => {
    expect(c.aboard, name).toBe(n - 1);
    expect(c.helmShown, name).toBe(true);
    for (const h of c.heads) {
      expect(h.moving, name).toBe(false);
      expect(pose(h.station), `${name}: station ${h.station}`).toBe('bench');
      // Each head over their own station's seat.
      const st = kind.stations[h.station]?.at as number[];
      expect(Math.hypot(h.model[0] - (st[0] ?? 0), h.model[2] - (st[2] ?? 0)), name).toBeLessThan(
        0.45,
      );
    }
  };
  const tack = 0.85;
  for (const n of [2, 6, kind.capacity]) {
    await aboard(n);
    // A light wind: sat up, the helm on the settle behind the wheel.
    const light = await sail(2, -0.06, tack, 150);
    seated(light, n, `${n} in a light wind`);
    expect(light.members.filter((m) => m.station > 0).every((m) => m.lean === 0)).toBe(true);
    expect(light.helmSeat).toBe(1);
    await picture(`${n} aboard, sat up in a light wind`);
    // A breeze: braced, the helm standing at the wheel.
    const breeze = await sail(18, -0.06, tack, 150);
    seated(breeze, n, `${n} in a breeze`);
    expect(breeze.members.filter((m) => m.station > 0).every((m) => m.lean === 1)).toBe(true);
    expect(breeze.helmSeat).toBe(0);
    await picture(`${n} aboard, braced in a breeze`);
  }
  // The heads of all twelve: two at the helm (the helm drawn by her
  // sailor), five at the table, three on the aft bench, two on the lounger.
  const all = await sail(18, -0.06, tack, 1);
  expect(all.heads).toHaveLength(kind.capacity - 1);
  // A tack in four frames: through the wind, the boom over; nobody moves.
  const before = all.changes;
  const frames = [
    [0.4, -0.03],
    [0, 0],
    [-0.4, 0.03],
    [-tack, 0.06],
  ] as const;
  let k = 0;
  for (const [off, boom] of frames) {
    const c = await sail(18, boom, off, 45);
    expect(c.moved, `a tack, frame ${k}`).toEqual([]);
    seated(c, kind.capacity, `a tack, frame ${k}`);
    await picture(`a tack, ${['bearing up', 'head to wind', 'falling off', 'on the new tack'][k]}`);
    k++;
  }
  const tacked = await sail(18, 0.06, -tack, 30);
  expect(tacked.changes).toBeGreaterThan(before);
  expect(tacked.tack).toBe(true);
  // A gybe: the wind over the quarter, the boom across; nobody moves.
  const gybe = Math.PI - 0.6;
  await sail(10, 1.1, -gybe, 120);
  const gybed = await sail(10, -1.1, gybe, 240);
  expect(gybed.tack).toBe(false);
  expect(gybed.moved).toEqual([]);
  seated(gybed, kind.capacity, 'after a gybe');
  // A handover: the skipper hands the wheel to the one at the aft bench's
  // port end, who walks her cockpit and climbs her ladder; the skipper
  // comes down it and walks to their seat.
  const holder = kind.stations.findIndex(
    (s, i) => i > 1 && s.facing === 0 && (s.at[0] as number) >= 0 && (s.at[0] as number) < 0.3,
  );
  expect(holder).toBeGreaterThan(1);
  await aboard(kind.capacity, holder);
  const seen = new Map<string, number>();
  const shots: string[] = [];
  for (let i = 0; i < 80; i++) {
    const c = await sail(18, 0.06, -tack, 10);
    const walkers = c.members.filter((m) => m.moving === 'change');
    for (const m of walkers) {
      const what = m.stretch ?? (m.t > 0 ? 'walking' : 'waiting');
      seen.set(`${m.seat} ${what}`, (seen.get(`${m.seat} ${what}`) ?? 0) + 1);
    }
    const climber = walkers.find((m) => m.seat === holder);
    const phase =
      climber === undefined
        ? 'at the wheel'
        : climber.stretch === 'up'
          ? 'up the ladder'
          : climber.t > 0
            ? 'along the cockpit'
            : null;
    if (
      phase !== null &&
      !shots.includes(phase) &&
      (phase !== 'at the wheel' || shots.length > 0)
    ) {
      shots.push(phase);
      await picture(`a handover: ${phase}`, -1.9);
    }
    if (walkers.length === 0 && shots.includes('at the wheel')) {
      break;
    }
  }
  expect(seen.get(`${holder} up`)).toBeGreaterThan(0);
  expect(seen.get('0 down')).toBeGreaterThan(0);
  const handed = await sail(18, 0.06, -tack, 1);
  expect(handed.members.find((m) => m.seat === 0)?.station).toBe(holder);
  expect(handed.members.find((m) => m.seat === holder)?.station).toBe(-1);
  seated(handed, kind.capacity, 'after a handover');
  await picture('after a handover');
});

test('a friend’s boat near a crewed catamaran sees all twelve: two at her helm, five at her table, three on her aft bench and two on her lounger, through a tack', async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  test.skip(catamaran < 0, 'no kind names a cruising catamaran’s clips');
  const capacity = data.boats[catamaran]?.capacity ?? 0;
  await openScene(page, 'boat=jolly-boat');
  await page.evaluate(
    async ({ catamaran, capacity }) => {
      const k = globalThis.keel;
      k.setSky(12);
      const from = k.world.wind.meanFrom;
      const me = k.boat().state;
      const { crew, look } = k.fleetCrew(capacity, 0, 7);
      k.setFleet([
        {
          kind: catamaran,
          crew,
          look,
          east: me.x + Math.sin(me.heading) * 18 + Math.cos(me.heading) * 10,
          north: me.y + Math.cos(me.heading) * 18 - Math.sin(me.heading) * 10,
          heading: from - 0.85,
          boom: 0.06,
          heel: 0.02,
          sailor: 0,
        },
      ]);
      await k.fleetLoaded();
      await k.fleetCrewsReady();
      k.freezeTick(k.world.ticks);
    },
    { catamaran, capacity },
  );
  const sail = (frames: number, boom: number, off: number) =>
    page.evaluate(
      ({ frames, boom, off }) => {
        const k = globalThis.keel;
        const moved = new Set<number>();
        for (let i = 0; i < frames; i++) {
          k.moveFleet(0, { boom, heel: 0.02, heading: k.world.wind.meanFrom + off });
          k.sailFrames(1, 3);
          const b = k.fleetCrews().boats.find((x) => x.slot === 0);
          for (const m of b?.members ?? []) {
            if (m.moving !== null) {
              moved.add(m.seat);
            }
          }
        }
        return { boat: k.fleetCrews().boats.find((b) => b.slot === 0), moved: [...moved] };
      },
      { frames, boom, off },
    );
  const picture = async (name: string) => {
    await page.evaluate(async () => {
      const k = globalThis.keel;
      k.camera({ azimuth: 2.5, elevation: 0.35, distance: 24 });
      await k.show();
    });
    await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
  };
  const met = await sail(60, 0.06, -0.85);
  expect(met.boat?.drawn).toBe(true);
  // Everyone but her helm (the fleet's sailor, at her wheel) drawn.
  expect(met.boat?.members.filter((m) => m.station > 0)).toHaveLength(capacity - 1);
  expect(met.boat?.heads).toHaveLength(capacity - 1);
  await picture('a friend near the catamaran and her twelve');
  // She tacks: nobody moves.
  const tacked = await sail(300, -0.06, 0.85);
  expect(tacked.moved).toEqual([]);
  expect(tacked.boat?.heads).toHaveLength(capacity - 1);
  await picture('a friend near the catamaran after her tack');
});

test('a friend’s boat near a crewed keelboat, skiff, tall ship and beach cat sees their crews: to windward, through a tack and a handover, and the beach cat’s on the wire', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const kindOf = (pred: (b: (typeof data.boats)[number]) => boolean) => data.boats.findIndex(pred);
  // The keelboat: her crew on her rail, her trimmer sat to windward in her cockpit.
  const keelboat = kindOf(
    (b) =>
      b.stations.some((s) => s.pose === 'rail') &&
      b.stations.some((s) => s.pose === 'seated' && 'windward' in s && s.windward),
  );
  const skiff = kindOf(
    (b) => b.capacity === 2 && b.stations.some((s) => 'windward' in s && s.windward),
  );
  const ship = kindOf((b) => b.stations.some((s) => s.pose === 'aloft'));
  const cat = kindOf((b) => b.physics.hulls.hullSpacing > 0);
  await openScene(page, 'boat=jolly-boat');
  await page.evaluate(
    async ({ keelboat, skiff, ship, cat }) => {
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
        ...(cat < 0 ? [] : [boat(cat, 2, 4, 16, -14)]),
      ]);
      await k.fleetLoaded();
      await k.fleetCrewsReady();
      k.freezeTick(k.world.ticks);
    },
    { keelboat, skiff, ship, cat },
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
  // Her company by a ship's rules: her lookout in the main top, 13 m and more over the sea.
  expect(boatOf(met, 2).heads.some((h) => h.up > 13)).toBe(true);
  if (cat >= 0) {
    // The beach cat's crew on her port hull, beside her helm.
    toWindward(met, 3, 1, -1, 'the beach cat');
  }
  expect(met.drawn.near + met.drawn.far).toBe(cat >= 0 ? 45 : 44);
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
  if (cat >= 0) {
    // The beach cat's helm out on the wire to port: her crew out on theirs
    // beside them, the crew's wire drawn to them.
    const wire = await page.evaluate(() => {
      const k = globalThis.keel;
      for (let i = 0; i < 60; i++) {
        k.moveFleet(3, { sailor: -2.1, boom: 0.25, heading: k.world.wind.meanFrom - 0.7 });
        k.sailFrames(1, 1);
      }
      return k.fleetCrews().boats.find((b) => b.slot === 3);
    });
    expect(wire?.members.find((m) => m.station > 0)?.lean).toBe(1);
    expect(wire?.hooked).toBe(-1);
    await picture('the beach cat’s two out on the wire, from a friend’s boat', {
      azimuth: 2.6,
      elevation: 0.35,
      distance: 14,
    });
  }
});

test('a friend’s boat near the tall ship sees her company at work: at the braces in her tack, and her topmen aloft as she reefs', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const ship = data.boats.findIndex((b) => b.capacity >= 40);
  await openScene(page, 'boat=jolly-boat');
  await page.evaluate(async (ship) => {
    const k = globalThis.keel;
    k.setSky(12);
    const from = k.world.wind.meanFrom;
    const me = k.boat().state;
    const { crew, look } = k.fleetCrew(40, 0, 3);
    k.setFleet([
      {
        kind: ship,
        crew,
        look,
        east: me.x + Math.sin(me.heading) * 45 + Math.cos(me.heading) * 20,
        north: me.y + Math.cos(me.heading) * 45 - Math.sin(me.heading) * 20,
        heading: from - 1.2,
        yardsTurn: -0.67,
        foreYardsTurn: -0.67,
      },
    ]);
    await k.fleetLoaded();
    await k.fleetCrewsReady();
    k.freezeTick(k.world.ticks);
  }, ship);
  /**
   * Seconds of her as drawn, her yards' turns and her reef by the second
   * (as her tack and her reef run), a frame each 0.2 s; her crew then, and
   * the most seen at the braces and out on the yards meanwhile.
   */
  const sail = (from: number, seconds: number, tack: boolean, reef: number) =>
    page.evaluate(
      ({ from, seconds, tack, reef }) => {
        const k = globalThis.keel;
        const turn = (t: number, at: number) =>
          Math.max(-0.67, Math.min(0.67, -0.67 + Math.max(0, t - at) * 0.056));
        let hauling = 0;
        let aloft = 0;
        let groups = 0;
        for (let i = 0; i < seconds * 5; i++) {
          const t = from + i / 5;
          k.moveFleet(0, {
            yardsTurn: tack ? turn(t, 2) : 0.67,
            foreYardsTurn: tack ? turn(t, 22) : 0.67,
            reef: Math.min(reef, Math.max(0, (t - 1) / 120)),
          });
          k.sailFrames(1, 6);
          const b = k.fleetCrews().boats.find((x) => x.slot === 0);
          const work = b?.members.filter((m) => m.work?.kind === 'haul').length ?? 0;
          hauling = Math.max(hauling, work);
          aloft = Math.max(aloft, b?.heads.filter((h) => h.up > 20).length ?? 0);
          groups += work > 0 ? 1 : 0;
        }
        const b = k.fleetCrews().boats.find((x) => x.slot === 0);
        return { b, hauling, aloft, groups };
      },
      { from, seconds, tack, reef },
    );
  const picture = async (name: string) => {
    await page.evaluate(async () => {
      const k = globalThis.keel;
      k.camera({ azimuth: 2.4, elevation: 0.3, distance: 40 });
      await k.show();
    });
    await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
  };
  const haul = await sail(0, 14, true, 0);
  // Her hands at her after braces, drawn as the friend sees them.
  expect(haul.hauling).toBeGreaterThan(10);
  expect(haul.b?.heads).toHaveLength(39);
  await picture('her hands at the braces, from a friend’s boat');
  const rest = await sail(14, 70, true, 0);
  expect(rest.b?.members.every((m) => m.work === null && m.moving === null)).toBe(true);
  // She reefs: her topmen go aloft and lie out on her topgallant yards.
  const reefing = await sail(0, 70, false, 1);
  expect(reefing.aloft).toBeGreaterThanOrEqual(6);
  await picture('her topmen aloft, from a friend’s boat');
});
