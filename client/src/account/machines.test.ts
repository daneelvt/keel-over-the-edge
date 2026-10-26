// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { drawMachine, endsWords, lookWords, withPart } from './machineform';
import { fleetLine } from './machines';
import { type Fetch, type Me, resolveSailor } from './me';
import { MACHINE_REASONS, machineReasonText, REASONS } from './reasons';
import { recipes, recipeText } from './recipes';

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

describe('a machine sailor’s look', () => {
  const looks = catalog.machine;

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

  test('is written as the server writes it, finish, version, colour', () => {
    const d = drawMachine(looks, null, () => 0);
    expect(lookWords(d)).toBe(
      `${looks.finishes[0].name} · ${looks.versions[0].name} · ${looks.colours[0].name}`,
    );
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

  test('each app’s with its source and the day it was read', () => {
    const src = readFileSync(new URL('./recipes.ts', import.meta.url), 'utf8');
    const blocks = src.split(/\n {4}\{\n {6}app: /).slice(1);
    const comments = src.split(/\n {4}\{\n {6}app: /).slice(0, -1);
    expect(blocks).toHaveLength(all.length);
    for (let i = 0; i < all.length - 1; i++) {
      const above = comments[i]?.split('\n').slice(-4).join('\n') ?? '';
      expect(above, all[i]?.app).toMatch(/\/\/ https:\/\//);
      expect(above, all[i]?.app).toContain('Read 2026-10-25.');
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

describe('a player with machine sailors', () => {
  const ann: Me = { name: 'Ann Bonny', look: 'a', kind: 'human' };
  const run = async (me: Me) => {
    const log: string[] = [];
    const fetcher: Fetch = async () => new Response(JSON.stringify(me), { status: 200 });
    const out = await resolveSailor({
      fetch: fetcher,
      start: async () => ann,
      addPasskey: async (m) => m,
      machines: async (m) => {
        log.push(`machines ${m.machines}`);
        return m;
      },
      backSoon: () => {},
    });
    return { out, log };
  };

  test('is shown them before the sea; one with none goes straight to sea', async () => {
    expect((await run({ ...ann, machines: 2 })).log).toEqual(['machines 2']);
    expect((await run(ann)).log).toEqual([]);
    expect((await run({ ...ann, machines: 0 })).log).toEqual([]);
  });
});
