// SPDX-License-Identifier: AGPL-3.0-only

// People aboard the cruising boats, on a phone's screen (360 × 640). The
// yacht's eight: her helm at the windward wheel, three on her windward
// bench and four on her windward rail, crossing in a tack and a gybe in
// their order, changing places at a handover; and all eight seen from a
// friend's boat near her. The catamaran's twelve: two at her helm, five at
// her table, three on her aft bench and two on her lounger, sat up in a
// light wind and braced in a breeze, nobody moving in a tack or a gybe, a
// handover a walk along her cockpit and up her helm's ladder; and all
// twelve seen from a friend's boat near her. The others aboard are in
// crew.spec.ts; the two files run on different runners.

import { expect, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { openScene } from './helpers';

test.use({ viewport: { width: 360, height: 640 } });

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
