// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { MACHINE, lookWords as wordsOf } from '../catalog/looks';
import { STILL_AT_SEA, WATCH, WATCH_ANOTHER_SAILOR } from '../ui/watchwords';
import { NOT_WATCHED, voyage, watchRefused } from './letwatch';
import {
  type Draft,
  drawMachine,
  endsWords,
  idsOf,
  lookWords,
  MachineFields,
  type MachineItem,
  withPart,
} from './machineform';
import {
  AI_SAILORS,
  AI_SAILORS_LINE,
  fleetLine,
  MachineList,
  type MachinesPage,
  picture,
  StartPair,
} from './machines';
import { type Fetch, type Me, resolveSailor } from './me';
import { Portrait, portraitFiles } from './portraits';
import { MACHINE_REASONS, machineReasonText, REASONS } from './reasons';
import { recipes, recipeText, STARTER, sailing } from './recipes';
import { SetSailOrMake } from './recovery';
import { YourSailor } from './yoursailor';

const DAY = 86_400_000;

describe('when an approval ends', () => {
  const now = new Date(2026, 9, 25, 12).getTime();

  test('within a week, in days, amber', () => {
    expect(endsWords(now + 5 * DAY, now)).toEqual({ text: 'ends in 5 days', soon: true });
    expect(endsWords(now + 7 * DAY, now)).toEqual({ text: 'ends in 7 days', soon: true });
    expect(endsWords(now + 4.2 * DAY, now)).toEqual({ text: 'ends in 5 days', soon: true });
    expect(endsWords(now + 3_600_000, now)).toEqual({ text: 'ends within a day', soon: true });
  });

  test('beyond it, on its day, as the player reads dates', () => {
    const jan = new Date(2027, 0, 22, 12).getTime();
    expect(endsWords(jan, now)).toEqual({ text: 'ends on 22 January 2027', soon: false });
    const nov = new Date(2026, 10, 20, 12).getTime();
    expect(endsWords(nov, now)).toEqual({ text: 'ends on 20 November', soon: false });
    expect(endsWords(now + 8 * DAY, now).soon).toBe(false);
    expect(endsWords(now - DAY, now).text).toBe('ended on 24 October');
  });
});

/** The choices of a machine sailor's look, as the server lists them. */
const machineLooks = { ...catalog.machine, colours: catalog.sailorOptions.colours };

describe('a machine sailor’s look', () => {
  const looks = machineLooks;

  test('is drawn from the catalog’s choices, another each time', () => {
    let d = drawMachine(looks);
    for (let i = 0; i < 50; i++) {
      const next = drawMachine(looks, d);
      expect(looks.versions).toContain(next.version);
      expect(looks.finishes).toContain(next.finish);
      expect(looks.colours).toContain(next.colour);
      if (looks.colours.length > 1) {
        expect(next.colour).not.toBe(d.colour);
      }
      d = next;
    }
  });

  test('is written as the server and the game write any look', () => {
    const d = drawMachine(looks, null, () => 0);
    expect(lookWords(d)).toBe(
      `Machine, ${looks.versions[0].name}, ${looks.finishes[0].name}, ${looks.colours[0].name}`,
    );
    expect(lookWords(d)).toBe(wordsOf(catalog, { look: MACHINE, ...idsOf(d) }));
    const last = looks.colours[looks.colours.length - 1];
    expect(withPart(looks, d, 'colour', last?.id ?? '').colour).toBe(last);
    expect(withPart(looks, d, 'colour', 'no such colour')).toBe(d);
  });
});

describe('the fleet', () => {
  test('in one line, by the catalog’s boats', () => {
    const boat = catalog.boats[0];
    if (boat === undefined) {
      throw new Error('no boats');
    }
    expect(fleetLine({ [boat.id]: 2 })).toBe(`2 ${boat.name}s`);
    expect(fleetLine({ [boat.id]: 1 })).toBe(`1 ${boat.name}`);
    expect(fleetLine({})).toBe('');
  });
});

describe('the recipes', () => {
  const address = 'https://keel.example/mcp';
  const all = recipes(address);

  test('one for each app, and for other programs', () => {
    expect(all.map((r) => r.app)).toEqual([
      'Claude',
      'Claude Code',
      'ChatGPT',
      'Gemini',
      'Codex',
      'VS Code',
      'Other programs',
    ]);
    const text = Object.fromEntries(all.map((r) => [r.app, recipeText(r)]));
    expect(text['Claude Code']).toContain(`claude mcp add --transport http keel ${address}`);
    expect(text['Claude Code']).toContain('/mcp');
    expect(text.Claude).toContain('The free plan allows one custom connector.');
    expect(text.Gemini).toContain('adults in the US');
    expect(text.Gemini).toContain('Gemini CLI');
    expect(text.Codex).toContain(`codex mcp add keel --url ${address}`);
    expect(text['Other programs']).toContain('Authorization: Bearer');
    expect(text['Other programs']).toContain('connection token');
    for (const r of all) {
      expect(recipeText(r)).not.toMatch(/\bbot\b|AI account/i);
    }
  });

  test('how each app is let sail', () => {
    const text = Object.fromEntries(sailing().map((r) => [r.app, recipeText(r)]));
    expect(text['Claude Code']).toContain('--allowedTools "mcp__keel__*"');
    expect(text['Claude Code']).toContain(STARTER);
    expect(text.Codex).toContain('tool_timeout_sec');
    expect(text['Gemini CLI']).toContain('--yolo');
    expect(text['Chat apps']).toContain('wait of 25');
  });

  test('each app’s with its source and the day it was read', () => {
    const [connecting = '', letting = ''] = readFileSync(
      new URL('./recipes.ts', import.meta.url),
      'utf8',
    ).split('export function sailing');
    // The last of each list is the game's own, with no app's documentation:
    // other programs, and in the sailing list the chat apps and a program.
    for (const [src, list, own] of [
      [connecting, all, 1],
      [letting, sailing(), 2],
    ] as const) {
      const blocks = src.split(/\n {4}\{\n {6}app: /).slice(1);
      const comments = src.split(/\n {4}\{\n {6}app: /).slice(0, -1);
      expect(blocks).toHaveLength(list.length);
      for (let i = 0; i < list.length - own; i++) {
        const above = comments[i]?.split('\n').slice(-4).join('\n') ?? '';
        expect(above, list[i]?.app).toMatch(/\/\/ https:\/\//);
        expect(above, list[i]?.app).toContain('Read 2026-10-25.');
      }
    }
  });
});

describe('the machine sailors’ words', () => {
  test('their own where the codes mean something else, the account’s otherwise', () => {
    for (const code of Object.keys(MACHINE_REASONS)) {
      expect(machineReasonText(code)).toBe(MACHINE_REASONS[code]);
    }
    expect(machineReasonText('taken')).toBe(REASONS.taken);
    expect(machineReasonText('cap')).toBe(REASONS.cap);
    expect(machineReasonText('too-many-apps')).toBe(REASONS['too-many-apps']);
  });
});

describe('every entry with a session', () => {
  const ann: Me = { name: 'Ann Bonny', look: 'a', version: 'v', colour: 'c', kind: 'human' };
  const run = async (me: Me, link = false) => {
    const log: string[] = [];
    const fetcher: Fetch = async () => new Response(JSON.stringify(me), { status: 200 });
    const out = await resolveSailor({
      fetch: fetcher,
      start: async () => ann,
      addPasskey: async (m) => {
        log.push('add a passkey');
        return { ...m, addPasskey: false };
      },
      ...(link
        ? {}
        : {
            sailor: async (m: Me) => {
              log.push(`your sailor, ${m.machines ?? 0} machine sailors`);
              return m;
            },
          }),
      backSoon: () => {},
    });
    return { out, log };
  };

  test('shows the player’s own sailor before the sea, with machine sailors or none', async () => {
    expect((await run({ ...ann, machines: 2 })).log).toEqual(['your sailor, 2 machine sailors']);
    expect((await run(ann)).log).toEqual(['your sailor, 0 machine sailors']);
    expect((await run({ ...ann, machines: 0 })).log).toEqual(['your sailor, 0 machine sailors']);
    // A session the recovery code made: a passkey first, then the same.
    expect((await run({ ...ann, addPasskey: true })).log).toEqual([
      'add a passkey',
      'your sailor, 0 machine sailors',
    ]);
  });

  test('but for a link to watch, which goes straight to the watch', async () => {
    expect(await run({ ...ann, machines: 2 }, true)).toEqual({
      out: { ...ann, machines: 2 },
      log: [],
    });
  });
});

// Expands function components, so a test can see the elements they make.
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

function textOf(node: ComponentChildren): string {
  if (Array.isArray(node)) {
    return node.map(textOf).join('');
  }
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node !== 'object') {
    return String(node);
  }
  return textOf((node as VNode<{ children?: ComponentChildren }>).props.children);
}

type Node = VNode<{ children?: ComponentChildren; class?: string }>;

function findAll(node: ComponentChildren, type: string): Node[] {
  if (Array.isArray(node)) {
    return node.flatMap((n) => findAll(n, type));
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return [];
  }
  const v = node as Node;
  return [...(v.type === type ? [v] : []), ...findAll(v.props.children, type)];
}

function checkboxes(node: ComponentChildren): { text: string; checked: boolean }[] {
  return findAll(node, 'label').flatMap((l) =>
    findAll(l, 'input')
      .filter((i) => (i.props as { type?: string }).type === 'checkbox')
      .map((i) => ({
        text: textOf(l.props.children).trim(),
        checked: (i.props as { checked?: boolean }).checked === true,
      })),
  );
}

function buttons(node: ComponentChildren): { text: string; gold: boolean }[] {
  return findAll(node, 'button').map((b) => ({
    text: textOf(b.props.children),
    gold: (b.props.class ?? '').split(' ').includes('start-go'),
  }));
}

describe('the start screen with machine sailors', () => {
  const ann: Me = {
    name: 'Ann Bonny',
    look: 'a',
    version: 'v',
    colour: 'c',
    kind: 'human',
    machines: 1,
  };
  const aila: MachineItem = {
    id: 'm1',
    name: 'AILA',
    look: {
      version: 'v',
      finish: 'f',
      colour: 'c',
      words: 'Machine, female, iron, rust orange',
      srgb: '#b5532a',
    },
    atSea: true,
    apps: [],
    token: null,
  };
  const page: MachinesPage = {
    mcp: 'https://keel.example/mcp',
    cap: 2,
    machines: [aila],
    fleet: {},
    looks: machineLooks,
    confirmedUntil: 0,
  };
  const draw = (me: Me) => {
    const tree = expand(
      StartPair({
        me,
        voyage: voyage(me, async () => new Response('{}')),
        sail: () => {},
        list: () => {},
        children: MachineList({
          page,
          heading: AI_SAILORS,
          line: AI_SAILORS_LINE,
          open: '',
          toggle: () => {},
          make: () => {},
          watch: () => {},
        }),
      }),
    ) as Node;
    const panels = (tree.props.children as Node[]).filter((n) => n !== null);
    return { tree, panels };
  };

  test('is two panels apart: the player’s own sailor, then the AI sailors', () => {
    const { tree, panels } = draw(ann);
    expect(tree.props.class).toBe('start-pair');
    expect(panels).toHaveLength(2);
    const [yours, ai] = panels;
    expect(yours?.props.class).toContain('start-panel');
    expect(ai?.props.class).toContain('ai-panel');

    // The player's: their sailor by name, and the only gold button, which sails it.
    expect(findAll(yours, 'h2').map((h) => textOf(h))).toEqual(['Your sailor']);
    expect(textOf(findAll(yours, 'bdi'))).toBe('Ann Bonny');
    expect(textOf(yours)).toContain('not at sea');
    expect(textOf(yours)).not.toContain(STILL_AT_SEA);
    expect(buttons(yours)).toEqual([
      { text: 'Set sail as Ann Bonny', gold: true },
      { text: WATCH_ANOTHER_SAILOR, gold: false },
    ]);
    expect(checkboxes(yours)).toEqual([{ text: 'Let others watch me sail', checked: false }]);
    expect(textOf(yours)).toContain('This voyage only.');
    expect(textOf(yours)).not.toContain('AILA');

    // The AI sailors': what they are, each one, and nothing gold to sail.
    expect(textOf(findAll(ai, 'h2'))).toBe(AI_SAILORS);
    expect(textOf(ai)).toContain(AI_SAILORS_LINE);
    expect(textOf(ai)).toContain('AILA');
    expect(textOf(ai)).not.toContain('Ann Bonny');
    expect(checkboxes(ai)).toEqual([]);
    expect(buttons(ai)).toEqual([
      { text: WATCH, gold: false },
      { text: 'How to connect', gold: false },
      { text: 'Make another machine sailor', gold: false },
    ]);
  });

  test('says so when the player’s own boat is in the water', () => {
    const [yours, ai] = draw({ ...ann, atSea: true }).panels;
    const lines = findAll(yours, 'p').map((p) => textOf(p));
    expect(lines).toContain('at sea');
    expect(lines).toContain(STILL_AT_SEA);
    expect(lines.indexOf(STILL_AT_SEA)).toBe(lines.indexOf('at sea') + 1);
    expect(textOf(ai)).not.toContain(STILL_AT_SEA);
    // The box between the note and Set sail.
    const order = ((yours?.props.children ?? []) as ComponentChildren[])
      .filter((n): n is Node => n !== null && typeof n === 'object')
      .map((n) => (n.props.class ?? '').split(' ')[0] ?? '');
    expect(order.slice(-4)).toEqual(['start-warning', 'let-watch', 'start-go', 'start-sign-in']);
  });

  test('the box: unticked with no boat in the water, the voyage’s choice with one', () => {
    const ticked = (me: Me) => checkboxes(draw({ ...ann, ...me }).panels[0])[0]?.checked;
    expect(ticked(ann)).toBe(false);
    // A choice made for a boat that never sailed is not shown, nor kept.
    expect(ticked({ ...ann, spectators: 'voyage' })).toBe(false);
    expect(ticked({ ...ann, atSea: true, spectators: 'no' })).toBe(false);
    expect(ticked({ ...ann, atSea: true, spectators: 'voyage' })).toBe(true);
  });
});

describe('the machine sailors’ portraits', () => {
  const looks = machineLooks;
  const [version, finish, colour] = [looks.versions[0], looks.finishes[1], looks.colours[2]];
  if (version === undefined || finish === undefined || colour === undefined) {
    throw new Error('the catalog has no machine look');
  }
  const ids = { version: version.id, finish: finish.id, colour: colour.id };
  const props = (n: Node | undefined) => (n?.props ?? {}) as Record<string, unknown>;
  const radios = (t: ComponentChildren) =>
    findAll(t, 'button').filter((b) => props(b).role === 'radio');

  test('the catalog’s, in the look’s colours, decorative beside the words', () => {
    const p = picture(ids, 40) as VNode<Parameters<typeof Portrait>[0]>;
    expect(p.type).toBe(Portrait);
    expect(p.props.look).toEqual({ look: MACHINE, ...ids });
    expect(p.props.size).toBe(40);
    expect(p.props.decorative).toBe(true);
    const canvas = Portrait(p.props) as VNode<Record<string, unknown>>;
    expect(canvas.props.files).toEqual(portraitFiles(version.art));
    expect(canvas.props.files).not.toBeNull();
    expect(canvas.props.colours).toEqual({ main: colour.colour, skin: finish.colour });
  });

  test('one in each AI sailor’s row, a row’s size, unnamed beside its look in words', () => {
    const m: MachineItem = {
      id: 'm1',
      name: 'AILA',
      look: { ...ids, words: wordsOf(catalog, { look: MACHINE, ...ids }), srgb: colour.colour },
      atSea: false,
      apps: [],
      token: null,
    };
    const page: MachinesPage = {
      mcp: 'https://keel.example/mcp',
      cap: 2,
      machines: [m, { ...m, id: 'm2', name: 'BOLT' }],
      fleet: {},
      looks,
      confirmedUntil: 0,
    };
    const t = expand(
      MachineList({ page, heading: AI_SAILORS, open: '', toggle: () => {}, make: () => {} }),
    );
    const rows = findAll(t, 'li');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const who = findAll(row, 'span').filter((s) => s.props.class === 'machine-who');
      expect(who).toHaveLength(1);
      const canvases = findAll(who, 'canvas');
      expect(canvases).toHaveLength(1);
      expect(props(canvases[0]).class).toBe('portrait portrait-40');
      expect(props(canvases[0])['aria-hidden']).toBe('true');
      expect(textOf(who)).toContain('Machine, female');
    }
  });

  test('the picker: its portrait, the look in words, each part chosen, and Draw another', () => {
    let d: Draft = drawMachine(looks, null, () => 0);
    let drew = 0;
    const form = () =>
      expand(
        MachineFields({
          looks,
          draft: d,
          problem: '',
          id: 'machine',
          setName: () => {},
          pick: (part, id) => {
            d = withPart(looks, d, part, id);
          },
          draw: () => {
            drew++;
            d = drawMachine(looks, d, () => 0.99);
          },
          picture,
        }),
      );
    const words = (t: ComponentChildren) =>
      findAll(t, 'span').filter((s) => s.props.class === 'machine-look');
    const groups = (t: ComponentChildren) =>
      findAll(t, 'div').filter((g) => props(g).role === 'radiogroup');
    const chosen = (t: ComponentChildren) =>
      groups(t).map((g) =>
        radios(g)
          .filter((b) => props(b)['aria-checked'] === true)
          .map((b) => props(b)['aria-label']),
      );

    let t = form();
    // The portrait, decorative: the words beside it say the look, as it changes.
    const canvas = findAll(t, 'canvas');
    expect(canvas).toHaveLength(1);
    expect(props(canvas[0]).class).toBe('portrait portrait-72');
    expect(props(canvas[0])['aria-hidden']).toBe('true');
    expect(props(words(t)[0])['aria-live']).toBe('polite');
    expect(textOf(words(t))).toBe(lookWords(d));

    // Three groups, each labelled: the versions in words, the finishes and colours as swatches.
    expect(
      findAll(t, 'span')
        .filter((s) => s.props.class === 'choices-label')
        .map((s) => textOf(s)),
    ).toEqual(['Version', 'Metal finish', 'Main colour']);
    const [versions, finishes, colours] = groups(t);
    expect(radios(versions).map((b) => textOf(b))).toEqual(looks.versions.map((v) => v.name));
    expect(radios(finishes).map((b) => props(b).class)).toEqual(looks.finishes.map(() => 'swatch'));
    expect(radios(colours).map((b) => props(b)['aria-label'])).toEqual(
      looks.colours.map((c) => c.name),
    );
    expect(chosen(t)).toEqual([[d.version.name], [d.finish.name], [d.colour.name]]);

    // Each part chosen by its own group.
    const click = (g: number, i: number) => {
      const b = radios(groups(t)[g])[i];
      (props(b).onClick as () => void)();
      t = form();
    };
    click(0, 1);
    click(1, 1);
    click(2, 2);
    expect(idsOf(d)).toEqual({
      version: looks.versions[1]?.id,
      finish: finish.id,
      colour: colour.id,
    });
    expect(chosen(t)).toEqual([[looks.versions[1]?.name], [finish.name], [colour.name]]);
    expect(textOf(words(t))).toBe(
      `Machine, ${looks.versions[1]?.name}, ${finish.name}, ${colour.name}`,
    );

    // Draw another: another look, said in words.
    const before = textOf(words(t));
    const draw = findAll(t, 'button').find((b) => textOf(b) === 'Draw another');
    (props(draw).onClick as () => void)();
    t = form();
    expect(drew).toBe(1);
    expect(textOf(words(t))).not.toBe(before);
    expect(textOf(words(t))).toBe(lookWords(d));
  });
});

describe('Set sail with the box', () => {
  const ann: Me = { name: 'Ann Bonny', look: 'a', version: 'v', colour: 'c', kind: 'human' };
  /** The server as the box sees it: each request logged, answered by answer. */
  const server = (answer: () => Response | Promise<Response>) => {
    const log: string[] = [];
    const f: Fetch = async (path, init) => {
      log.push(`${init?.method ?? 'GET'} ${path} ${init?.body ?? ''}`.trim());
      return answer();
    };
    return { log, f };
  };
  const ok = () => new Response(JSON.stringify(ann), { status: 200 });
  const sailed = async (v: ReturnType<typeof voyage>, log: string[]) => {
    await v.sail(() => log.push('to sea'));
    return log;
  };

  test('unticked, goes to sea and asks nothing', async () => {
    const { log, f } = server(ok);
    expect(await sailed(voyage(ann, f), log)).toEqual(['to sea']);
    expect(watchRefused).toBe(false);
  });

  test('ticked, asks for the voyage to be watched first', async () => {
    const { log, f } = server(ok);
    const v = voyage(ann, f);
    v.set(true);
    // Ticked with no boat in the water: nothing sent until Set sail.
    expect(log).toEqual([]);
    expect(await sailed(v, log)).toEqual(['POST /api/me/spectators {"allow":"voyage"}', 'to sea']);
    expect(watchRefused).toBe(false);
  });

  test('ticked, sets sail anyway if the server cannot take it, and says so at sea', async () => {
    for (const answer of [
      () => new Response('{"error":"unavailable"}', { status: 503 }),
      () => {
        throw new TypeError('offline');
      },
    ]) {
      const { log, f } = server(answer);
      const v = voyage(ann, f);
      v.set(true);
      expect(await sailed(v, log)).toEqual([
        'POST /api/me/spectators {"allow":"voyage"}',
        'to sea',
      ]);
      expect(watchRefused).toBe(true);
    }
    expect(NOT_WATCHED).toBe('Others cannot watch you this voyage');
  });

  test('unticked, takes back a choice made elsewhere for a boat that never sailed', async () => {
    const { log, f } = server(ok);
    expect(await sailed(voyage({ ...ann, spectators: 'voyage' }, f), log)).toEqual([
      'POST /api/me/spectators {"allow":"no"}',
      'to sea',
    ]);
    expect(watchRefused).toBe(false);
  });

  test('with the boat in the water, a change is sent at once, and taken back if refused', async () => {
    const { log, f } = server(ok);
    const v = voyage({ ...ann, atSea: true, spectators: 'voyage' }, f);
    v.set(false);
    expect(v.on.value).toBe(false);
    // Set sail waits for it, and sends nothing more: the voyage has its choice.
    expect(await sailed(v, log)).toEqual(['POST /api/me/spectators {"allow":"no"}', 'to sea']);

    const refused = server(() => new Response('{}', { status: 500 }));
    const w = voyage({ ...ann, atSea: true }, refused.f);
    w.set(true);
    expect(w.on.value).toBe(true);
    await sailed(w, refused.log);
    expect(w.on.value).toBe(false);
    expect(refused.log).toEqual(['POST /api/me/spectators {"allow":"voyage"}', 'to sea']);
  });

  test('the panel’s Set sail sails through the box, once', async () => {
    const { log, f } = server(ok);
    const v = voyage(ann, f);
    const draw = () =>
      expand(YourSailor({ me: ann, voyage: v, sail: () => log.push('to sea'), watch: null }));
    type Props = { onChange: (e: unknown) => void; onClick: () => void };
    const props = (tag: string) => findAll(draw(), tag)[0]?.props as unknown as Props;
    props('input').onChange({ currentTarget: { checked: true } });
    expect(findAll(draw(), 'input')[0]?.props).toMatchObject({ checked: true });
    // A second tap while the server is asked does nothing; the first is
    // answered at once.
    props('button').onClick();
    expect(findAll(draw(), 'button')[0]?.props).toMatchObject({ disabled: true });
    props('button').onClick();
    await expect.poll(() => log).toEqual(['POST /api/me/spectators {"allow":"voyage"}', 'to sea']);
  });
});

describe('the choice after the recovery code', () => {
  test('names the sailor just made, with the box, unticked', () => {
    const me: Me = { name: 'Ann Bonny', look: 'a', version: 'v', colour: 'c', kind: 'human' };
    const tree = expand(
      SetSailOrMake({
        name: me.name,
        voyage: voyage(me, async () => new Response('{}')),
        sail: () => {},
        make: () => {},
      }),
    );
    expect(textOf(findAll(tree, 'h1'))).toBe('Ann Bonny is ready to sail');
    expect(checkboxes(tree)).toEqual([{ text: 'Let others watch me sail', checked: false }]);
    expect(buttons(tree)).toEqual([
      { text: 'Set sail as Ann Bonny', gold: true },
      { text: 'Make a machine sailor first', gold: false },
    ]);
  });
});
