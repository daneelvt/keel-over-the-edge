// SPDX-License-Identifier: AGPL-3.0-only

import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, test } from 'vitest';
import { boatsAt } from '../boot/harbour';
import { sandboxFleet } from '../boot/harbourboats';
import { catalog } from '../catalog';
import { BOAT_NAME_LEAST, BOAT_NAME_MOST } from '../catalog/boatlooks';
import { BoatKeys, boatsHere, type HarbourView } from '../ui/board';
import { BoatChooser } from './boatchooser';
import {
  BOAT_NOTE,
  BoatLookChooser,
  BoatPicture,
  CHANGE_ASHORE,
  CHANGE_AT_SEA,
  CHANGE_BOAT,
  ChangeBoat,
  READING_FLEET,
  YOUR_BOAT,
  YourBoat,
} from './boats';
import {
  aboardWords,
  boatReasonText,
  boatTitle,
  changeOf,
  type Fleet,
  type FleetBoat,
  fleetRowWords,
  inOrder,
  standingWords,
} from './fleet';
import { voyage } from './letwatch';
import { machineBoat } from './machines';
import type { Fetch, Me } from './me';
import { REASONS } from './reasons';
import { YourSailor } from './yoursailor';

/** Expands function components, so a test can see the elements they make. */
function expand(node: ComponentChildren): ComponentChildren {
  if (Array.isArray(node)) {
    return node.map(expand);
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return node;
  }
  const v = node as VNode<{ children?: ComponentChildren }>;
  if (typeof v.type === 'function') {
    return expand((v.type as (p: unknown) => ComponentChildren)(v.props));
  }
  return { ...v, props: { ...v.props, children: expand(v.props.children) } } as VNode;
}

type Node = VNode<Record<string, unknown> & { children?: ComponentChildren }>;

function findAll(node: ComponentChildren, test: (n: Node) => boolean): Node[] {
  if (Array.isArray(node)) {
    return node.flatMap((n) => findAll(n, test));
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return [];
  }
  const v = node as Node;
  return [...(test(v) ? [v] : []), ...findAll(v.props.children, test)];
}

function text(node: ComponentChildren): string {
  if (Array.isArray(node)) {
    return node.map(text).join('');
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) {
    return '';
  }
  return text((node as Node).props.children);
}

const buttons = (n: ComponentChildren) => findAll(n, (x) => x.type === 'button');
const named = (n: ComponentChildren, words: string) =>
  buttons(n).find((b) => text(b.props.children) === words);
/** Taps a button by its words. */
const tap = (n: ComponentChildren, words: string) =>
  (named(n, words)?.props.onClick as (() => void) | undefined)?.();

/** The catalog's kinds, by what they are rather than their ids: the account's and a sailor's. */
const account = catalog.boats.find((b) => b.fleet === 'account');
const sailors = catalog.boats.find((b) => b.fleet === 'sailor');
const P = catalog.boatLooks.paints;
const C = catalog.boatLooks.cloths;

function boat(over: Partial<FleetBoat> & { id: string; kind: string }): FleetBoat {
  return {
    number: 1,
    name: '',
    paint: P[0]?.id ?? '',
    cloth: C[0]?.id ?? '',
    sailor: '',
    machine: false,
    atSea: false,
    yours: false,
    ...over,
  };
}

/** A fleet: the player's keelboat, a Jolly boat at sea with a machine sailor, an available one. */
function fleet(): Fleet {
  return {
    boat: 'k',
    boats: [
      boat({
        id: 'j1',
        kind: sailors?.id ?? '',
        number: 12,
        name: 'Gull',
        sailor: 'Iron Mary',
        machine: true,
        atSea: true,
      }),
      boat({
        id: 'k',
        kind: account?.id ?? '',
        number: 311,
        name: 'Saltpeter',
        sailor: 'Anne Bonny',
        yours: true,
      }),
      boat({ id: 'j2', kind: sailors?.id ?? '', number: 40 }),
    ],
  };
}

/** A server's answer. */
const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A fetch that answers each call in turn, keeping what it was sent. */
function server(...answers: (() => Response)[]) {
  const sent: { path: string; body: unknown }[] = [];
  const f: Fetch = (path, init) => {
    sent.push({
      path,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = answers.shift();
    return next === undefined ? Promise.reject(new Error('no answer')) : Promise.resolve(next());
  };
  return { f, sent };
}

async function loaded(...answers: (() => Response)[]) {
  const s = server(() => answer(200, fleet()), ...answers);
  const c = new BoatChooser(catalog, s.f);
  await c.load();
  return { c, sent: s.sent };
}

describe('the fleet in words', () => {
  test('a boat by its kind, its name and its number', () => {
    expect(boatTitle(catalog, { kind: account?.id ?? '', name: 'Saltpeter', number: 311 })).toBe(
      `${account?.name} «Saltpeter» 311`,
    );
    expect(boatTitle(catalog, { kind: sailors?.id ?? '', name: '', number: 40 })).toBe(
      `${sailors?.name} 40`,
    );
  });

  test('how many each kind takes', () => {
    expect(aboardWords({ capacity: 5 })).toBe('up to 5 aboard');
    expect(aboardWords({ capacity: 1 })).toBe('one aboard');
    expect(aboardWords(account)).toBe(`up to ${account?.capacity} aboard`);
  });

  test('where each boat is, to choose from: the player’s, taken by whom, or available', () => {
    const f = fleet();
    const [j1, k, j2] = f.boats as [FleetBoat, FleetBoat, FleetBoat];
    expect(standingWords(f, k)).toBe('yours');
    expect(standingWords(f, j1)).toBe('at sea · Iron Mary');
    expect(standingWords(f, j2)).toBe('available');
    expect(standingWords(f, { ...j2, sailor: 'Copper Kate' })).toBe(
      'available · last sailed by Copper Kate',
    );
  });

  test('the account page’s line for each boat', () => {
    const f = fleet();
    const [j1, k, j2] = f.boats as [FleetBoat, FleetBoat, FleetBoat];
    expect(fleetRowWords(catalog, f, j1)).toBe(`${sailors?.name} «Gull» 12 · at sea, Iron Mary`);
    expect(fleetRowWords(catalog, f, k)).toBe(`${account?.name} «Saltpeter» 311 · yours`);
    expect(fleetRowWords(catalog, f, j2)).toBe(`${sailors?.name} 40 · available`);
  });

  test('the boats in the catalog’s order of kinds, then by number', () => {
    const order = inOrder(catalog, fleet().boats).map((b) => b.id);
    const first = catalog.boats.findIndex((b) => b.id === sailors?.id);
    const second = catalog.boats.findIndex((b) => b.id === account?.id);
    expect(order).toEqual(first < second ? ['j1', 'j2', 'k'] : ['k', 'j1', 'j2']);
  });

  test('a machine sailor’s row names its boat; a player’s boat is not a machine’s', () => {
    expect(machineBoat(fleet(), 'Iron Mary')).toBe(`${sailors?.name} «Gull» 12`);
    expect(machineBoat(fleet(), 'Anne Bonny')).toBe('');
    expect(machineBoat(null, 'Iron Mary')).toBe('');
  });
});

describe('the ship of square sails', () => {
  /** The kind with square sails: the tall ship. */
  const ship = catalog.boats.find((b) => b.physics.square.squareAfterArea > 0);

  test('is one of the account’s, listed by her kind, name and number, available', () => {
    expect(ship?.fleet).toBe('account');
    const f = fleet();
    const her = boat({ id: 's', kind: ship?.id ?? '', number: 1, name: 'Resolution' });
    f.boats.push(her);
    expect(fleetRowWords(catalog, f, her)).toBe(`${ship?.name} «Resolution» 1 · available`);
    expect(standingWords(f, her)).toBe('available');
  });

  test('her picture draws her square sails on her masts, her number on the main topsail', () => {
    const sq = ship?.physics.square;
    const pic = expand(
      BoatPicture({
        cat: catalog,
        kind: ship?.id ?? '',
        paint: P[0]?.id ?? '',
        cloth: C[0]?.id ?? '',
        number: 7,
        width: 120,
      }),
    );
    const sails = findAll(
      pic,
      (n) => n.type === 'polygon' && n.props.class === 'boat-picture-sail',
    );
    expect(sails.length).toBe(4);
    const number = findAll(pic, (n) => n.type === 'text');
    expect(number.length).toBe(1);
    expect(Number(number[0]?.props.x)).toBeCloseTo(sq?.squareAfterMast ?? Number.NaN, 1);
    expect(text(number[0]?.props.children)).toBe('7');
  });

  test('a boat of two hulls is drawn with both, her main and her jib; one of one hull with one', () => {
    for (const b of catalog.boats.filter((x) => x.physics.square.squareForeArea === 0)) {
      const pic = expand(
        BoatPicture({
          cat: catalog,
          kind: b.id,
          paint: P[0]?.id ?? '',
          cloth: C[0]?.id ?? '',
          number: 3,
          width: 120,
        }),
      );
      const hulls = findAll(
        pic,
        (n) => n.type === 'path' && String(n.props.class).startsWith('boat-picture-hull'),
      );
      expect(hulls.length, b.id).toBe(b.physics.hulls.hullSpacing > 0 ? 2 : 1);
      const sails = findAll(
        pic,
        (n) => n.type === 'polygon' && n.props.class === 'boat-picture-sail',
      );
      expect(sails.length, b.id).toBe(b.physics.headsails.headsailArea > 0 ? 2 : 1);
    }
  });
});

describe('refusals in words', () => {
  test('a sail number another boat’s of its kind, and no room here, name the kind', () => {
    expect(boatReasonText(catalog, 'number', account, '12')).toBe(
      `Sail number 12 is another ${account?.name.toLowerCase()}’s: choose another.`,
    );
    expect(boatReasonText(catalog, 'room', account)).toBe(
      `No room here for a ${account?.name.toLowerCase()}: try the open water of the harbour.`,
    );
  });

  test('the place, the boat taken, and a busy harbour', () => {
    expect(boatReasonText(catalog, 'port')).toBe(
      'Only in port: in Port Royal’s harbour or a port town’s, not at a fishing village.',
    );
    expect(boatReasonText(catalog, 'taken')).toBe(
      'That boat is at sea with another of your sailors.',
    );
    expect(boatReasonText(catalog, 'busy')).toBe(
      'The harbour is busy just now. Try again in a moment.',
    );
    expect(boatReasonText(catalog, 'offline')).toBe(REASONS.offline);
  });

  test('a name’s reasons are the sailor’s, its length a boat name’s', () => {
    expect(boatReasonText(catalog, 'short')).toContain(`at least ${BOAT_NAME_LEAST} letters`);
    expect(boatReasonText(catalog, 'long')).toContain(`at most ${BOAT_NAME_MOST} letters`);
    for (const r of ['characters', 'scripts', 'words'] as const) {
      expect(boatReasonText(catalog, r)).toBe(REASONS[r]);
    }
  });
});

describe('the look’s chooser', () => {
  test('opens from the boat’s own look; Save sends only what changed', async () => {
    const { c, sent } = await loaded(() => answer(200, fleet()));
    c.openLook();
    expect(c.mode.value).toBe('look');
    expect(c.draft.value).toEqual({
      paint: P[0]?.id,
      cloth: C[0]?.id,
      number: '311',
      name: 'Saltpeter',
    });
    c.set('paint', P[3]?.id ?? '');
    c.set('name', '  Salt   Peter ');
    expect(await c.save()).toBe(true);
    expect(sent[1]).toEqual({
      path: '/api/boat/look',
      body: { boat: 'k', paint: P[3]?.id, name: 'Salt Peter' },
    });
    expect(c.mode.value).toBe('shown');
  });

  test('a name cleared is sent as none; nothing changed sends nothing', async () => {
    const { c, sent } = await loaded(() => answer(200, fleet()));
    c.openLook();
    expect(await c.save()).toBe(true);
    expect(sent).toHaveLength(1);
    c.openLook();
    c.set('name', '');
    await c.save();
    expect(sent[1]?.body).toEqual({ boat: 'k', name: '' });
  });

  test('a sail number out of range, or a name too short, is told before sending', async () => {
    const { c, sent } = await loaded();
    c.openLook();
    c.set('number', '0');
    expect(await c.save()).toBe(false);
    expect(c.problem.value).toBe(
      `A sail number is a whole number from 1 to ${catalog.boatLooks.numbers}.`,
    );
    expect(c.field.value).toBe('number');
    c.set('number', String(catalog.boatLooks.numbers + 1));
    expect(await c.save()).toBe(false);
    c.set('number', '12');
    c.set('name', 'S');
    expect(await c.save()).toBe(false);
    expect(c.field.value).toBe('name');
    expect(c.problem.value).toBe(boatReasonText(catalog, 'short'));
    expect(sent).toHaveLength(1);
  });

  test('the server’s refusals in words, beside their fields: 409 number, 422 name, 409 port', async () => {
    const { c } = await loaded(
      () => answer(409, { error: 'number' }),
      () => answer(422, { error: 'scripts' }),
      () => answer(409, { error: 'port' }),
      () => new Response('', { status: 503 }),
    );
    c.openLook();
    c.set('number', '12');
    expect(await c.save()).toBe(false);
    expect(c.problem.value).toBe(
      `Sail number 12 is another ${account?.name.toLowerCase()}’s: choose another.`,
    );
    expect(c.field.value).toBe('number');
    expect(c.mode.value).toBe('look');
    c.set('number', '13');
    expect(c.problem.value).toBe('');
    c.set('name', 'Saltpeterκ');
    expect(await c.save()).toBe(false);
    expect(c.problem.value).toBe(REASONS.scripts);
    expect(c.field.value).toBe('name');
    expect(await c.save()).toBe(false);
    expect(c.problem.value).toBe(boatReasonText(catalog, 'port'));
    expect(c.field.value).toBe('');
    expect(await c.save()).toBe(false);
    expect(c.problem.value).toBe(boatReasonText(catalog, 'busy'));
  });

  test('changeOf leaves out what is the boat’s already', () => {
    const k = fleet().boats[1] as FleetBoat;
    expect(
      changeOf(k, { paint: k.paint, cloth: C[4]?.id ?? '', number: '311', name: 'Saltpeter' }),
    ).toEqual({
      boat: 'k',
      cloth: C[4]?.id,
    });
  });

  test('drawn as the sailor’s picker: Paint and Cloth in the catalog’s order, the chosen ringed and named, a stripe banded', async () => {
    const { c } = await loaded();
    c.openLook();
    c.set('cloth', (C.find((x) => x.band !== undefined) ?? C[0])?.id ?? '');
    const v = expand(BoatLookChooser({ chooser: c }));
    const groups = findAll(v, (n) => n.props.role === 'radiogroup');
    expect(groups.map((g) => g.props['aria-labelledby'])).toEqual(['boat-paint', 'boat-cloth']);
    const names = (g: Node | undefined) =>
      findAll(g, (n) => n.props.role === 'radio').map((r) => r.props['aria-label']);
    expect(names(groups[0])).toEqual(P.map((p) => p.name));
    expect(names(groups[1])).toEqual(C.map((x) => x.name));
    const checked = findAll(v, (n) => n.props['aria-checked'] === true).map(
      (r) => r.props['aria-label'],
    );
    const striped = C.find((x) => x.band !== undefined);
    expect(checked).toEqual([P[0]?.name, striped?.name]);
    const named = findAll(v, (n) => n.props.class === 'choices-name').map((n) => text(n));
    expect(named).toEqual([P[0]?.name, striped?.name]);
    // A striped cloth's swatch is drawn with its band across it, a plain one without.
    const drawn = findAll(groups[1], (n) => n.props.class === 'swatch-colour').map((n) => {
      const el = { style: { backgroundColor: '', backgroundImage: '' } };
      (n.ref as unknown as (e: unknown) => void)(el);
      return el.style.backgroundImage;
    });
    expect(drawn).toHaveLength(C.length);
    C.forEach((x, i) => {
      if (x.band === undefined) {
        expect(drawn[i]).toBe('');
      } else {
        expect(drawn[i]).toContain(x.band);
      }
    });
    expect(text(v)).toContain(BOAT_NOTE);
    expect(
      buttons(v)
        .map((b) => text(b.props.children))
        .slice(-2),
    ).toEqual(['Cancel', 'Save']);
  });

  test('Cancel puts the look back as it was', async () => {
    const { c } = await loaded();
    c.openLook();
    c.set('paint', P[2]?.id ?? '');
    c.cancel();
    expect(c.mode.value).toBe('shown');
    c.openLook();
    expect(c.draft.value.paint).toBe(P[0]?.id);
  });
});

describe('the boat chosen from the fleet', () => {
  test('one available is chosen at once: POST /api/boat, the fleet as answered', async () => {
    const next = { ...fleet(), boat: 'j2' };
    const { c, sent } = await loaded(() => answer(200, next));
    c.openBoats();
    expect(await c.choose('j2')).toBe(true);
    expect(sent[1]).toEqual({ path: '/api/boat', body: { boat: 'j2' } });
    expect(c.yours?.id).toBe('j2');
    expect(c.mode.value).toBe('shown');
  });

  test('one taken is not asked for; refusals in words, naming the kind', async () => {
    const { c, sent } = await loaded(
      () => answer(409, { error: 'room' }),
      () => answer(409, { error: 'port' }),
    );
    c.openBoats();
    expect(await c.choose('j1')).toBe(false);
    expect(c.problem.value).toBe(boatReasonText(catalog, 'taken'));
    expect(sent).toHaveLength(1);
    expect(await c.choose('j2')).toBe(false);
    expect(c.problem.value).toBe(
      `No room here for a ${sailors?.name.toLowerCase()}: try the open water of the harbour.`,
    );
    expect(await c.choose('j2')).toBe(false);
    expect(c.problem.value).toBe(boatReasonText(catalog, 'port'));
    expect(c.mode.value).toBe('boats');
  });

  test('the fleet that cannot be read is said so', async () => {
    const c = new BoatChooser(catalog, server(() => new Response('', { status: 503 })).f);
    expect(text(expand(YourBoat({ chooser: c, changes: true })))).toBe(READING_FLEET);
    await c.load();
    expect(c.unread.value).toBe(boatReasonText(catalog, 'busy'));
    expect(text(expand(YourBoat({ chooser: c, changes: true })))).toBe(c.unread.value);
  });
});

describe('the player’s panel and the board', () => {
  test('the panel shows the boat, how many it takes, Your boat and Change boat ashore', async () => {
    const { c } = await loaded();
    const v = expand(YourBoat({ chooser: c, changes: true }));
    expect(text(v)).toContain(`${account?.name} «Saltpeter» 311`);
    expect(text(v)).toContain(`up to ${account?.capacity} aboard`);
    tap(v, YOUR_BOAT);
    expect(c.mode.value).toBe('look');
    c.cancel();
    tap(v, CHANGE_BOAT);
    expect(c.mode.value).toBe('boats');
    // At sea, the boat alone.
    expect(buttons(expand(YourBoat({ chooser: c, changes: false })))).toHaveLength(0);
  });

  test('the player’s own panel holds the boat above Set sail, and gives its place to the chooser', async () => {
    const { c } = await loaded();
    const me = { name: 'Anne Bonny', look: '', version: '', colour: '', kind: '' } as Me;
    const draw = (atSea: boolean) =>
      expand(
        YourSailor({
          me: { ...me, atSea },
          voyage: voyage(me, server().f),
          sail: () => {},
          watch: null,
          boats: c,
        }),
      );
    const all = buttons(draw(false)).map((b) => text(b.props.children));
    expect(all.indexOf(YOUR_BOAT)).toBeGreaterThanOrEqual(0);
    expect(all.indexOf(YOUR_BOAT)).toBeLessThan(all.indexOf('Set sail as Anne Bonny'));
    expect(all.indexOf(CHANGE_BOAT)).toBeLessThan(all.indexOf('Set sail as Anne Bonny'));
    // At sea the boat is shown, not changed.
    const atSea = draw(true);
    expect(text(atSea)).toContain('Saltpeter');
    expect(named(atSea, YOUR_BOAT)).toBeUndefined();
    c.openLook();
    expect(findAll(draw(false), (n) => n.props.id === 'boat-look-title')).toHaveLength(1);
    expect(named(draw(false), 'Set sail as Anne Bonny')).toBeUndefined();
    c.openBoats();
    expect(findAll(draw(false), (n) => n.props.id === 'change-boat-title')).toHaveLength(1);
  });

  test('ashore every boat is listed, one taken shown by whom and not chosen', async () => {
    const { c } = await loaded();
    const v = expand(ChangeBoat({ chooser: c }));
    expect(text(v)).toContain(CHANGE_ASHORE);
    const rows = findAll(v, (n) => n.props.class === 'change-boat-choice');
    expect(rows).toHaveLength(3);
    const taken = rows.find((r) => text(r).includes('at sea · Iron Mary'));
    expect(taken?.props.disabled).toBe(true);
    const yours = rows.find((r) => r.props['aria-current'] === 'true');
    expect(text(yours)).toContain('Saltpeter');
  });

  test('on the board, in a port, the available boats only', async () => {
    const { c } = await loaded();
    const v = expand(ChangeBoat({ chooser: c, board: true }));
    expect(text(v)).toContain(CHANGE_AT_SEA);
    const rows = findAll(v, (n) => n.props.class === 'change-boat-choice');
    expect(rows.map((r) => text(r)).some((t) => t.includes('Iron Mary'))).toBe(false);
    expect(rows).toHaveLength(2);
  });

  test('the board offers Your boat and Change boat in a port of boats, for the player’s own boat', async () => {
    const { c } = await loaded();
    const keys = expand(BoatKeys({ boats: c }));
    expect(buttons(keys).map((b) => text(b.props.children))).toEqual([YOUR_BOAT, CHANGE_BOAT]);
    expect(buttons(keys).every((b) => b.props.disabled === false)).toBe(true);
    tap(keys, CHANGE_BOAT);
    expect(c.mode.value).toBe('boats');
    const own = { value: true };
    const view = { boats: { own, chooser: c } } as unknown as HarbourView;
    const port = { name: 'Port Royal', east: 0, north: 0, boats: true };
    expect(boatsHere(view, port)).toBe(true);
    expect(boatsHere(view, { ...port, boats: false })).toBe(false);
    own.value = false;
    expect(boatsHere(view, port)).toBe(false);
    expect(boatsHere({} as HarbourView, port)).toBe(false);
  });

  test('a port’s harbour allows boats; a fishing village’s, by its size, does not', () => {
    const village = catalog.world.towns.inPort.village;
    const port = catalog.world.towns.inPort.port;
    expect(boatsAt([{ east: 0, north: 0, radius: port }], 10, 10)).toBe(true);
    expect(boatsAt([{ east: 0, north: 0, radius: village }], 10, 10)).toBe(false);
    expect(boatsAt([{ east: 0, north: 0, radius: port }], port + 1, 0)).toBe(false);
    expect(
      boatsAt(
        [
          { east: 0, north: 0, radius: village },
          { east: 50, north: 0, radius: 32 },
        ],
        40,
        0,
      ),
    ).toBe(true);
  });
});

describe('the sandbox’s fleet', () => {
  test('one boat of each kind; chosen, changed, and a number another’s refused', async () => {
    const c = new BoatChooser(catalog, sandboxFleet(catalog));
    await c.load();
    expect(c.fleet.value?.boats.map((b) => b.kind)).toEqual(catalog.boats.map((b) => b.id));
    const other = c.fleet.value?.boats[1];
    expect(await c.choose(other?.id ?? '')).toBe(true);
    expect(c.yours?.id).toBe(other?.id);
    c.openLook();
    c.set('name', 'Sea Wolf');
    expect(await c.save()).toBe(true);
    expect(c.yours?.name).toBe('Sea Wolf');
  });
});
