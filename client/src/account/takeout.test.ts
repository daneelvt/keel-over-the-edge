// SPDX-License-Identifier: AGPL-3.0-only

import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { drawLook } from '../catalog/looks';
import {
  KEEP_IT,
  NOT_TAKEN_OUT,
  START_AGAIN,
  STILL_AT_SEA,
  TAKE_IT_OUT,
  TAKE_OUT_DETAIL,
  TAKE_OUT_QUESTION,
  WATCH_ANOTHER_SAILOR,
} from '../ui/watchwords';
import { LookChooser } from './chooser';
import { voyage } from './letwatch';
import type { Fetch, Me } from './me';
import { TakeOut } from './takeout';
import { setSailAs, YourSailor } from './yoursailor';

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

/** A fetch that answers each call with status, keeping the paths it was sent. */
function server(status = 200) {
  const sent: string[] = [];
  const f: Fetch = (path) => {
    sent.push(path);
    return Promise.resolve(
      new Response(JSON.stringify({ out: true }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  return { f, sent };
}

/** Lets what a tap began run to its end. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const me: Me = {
  name: 'Anne Bonny',
  kind: 'human',
  ...drawLook(catalog, () => 0.3),
  lookChosen: true,
  atSea: true,
};

/** The player's panel, with the boat still in the water as out holds it. */
function panel(out: TakeOut, f: Fetch, opts: { sail?: () => void; watch?: () => void } = {}) {
  const chooser = new LookChooser(catalog, me, undefined, f);
  const v = voyage(me, f);
  const draw = () =>
    expand(
      YourSailor({
        me,
        voyage: v,
        sail: opts.sail ?? (() => {}),
        watch: opts.watch ?? null,
        chooser,
        out,
      }),
    );
  return { chooser, voyage: v, draw };
}

describe('a boat still in the water, on the start screen', () => {
  test('the note says so, and Set sail, Change your look, Watch another sailor and Start again are offered', () => {
    const s = server();
    const { draw } = panel(new TakeOut(true, s.f), s.f, { watch: () => {} });
    const v = draw();
    expect(text(v)).toContain(STILL_AT_SEA);
    for (const words of [
      setSailAs('Anne Bonny'),
      'Change your look',
      WATCH_ANOTHER_SAILOR,
      START_AGAIN,
    ]) {
      expect(named(v, words), words).toBeDefined();
    }
    expect(STILL_AT_SEA).toBe('Your boat is still in the water, where you left it.');
  });

  test('ashore, nothing is asked: no note, no Start again, a watch at once', () => {
    const s = server();
    let watched = 0;
    const out = new TakeOut(false, s.f);
    const { draw } = panel(out, s.f, { watch: () => watched++ });
    const v = draw();
    expect(text(v)).not.toContain(STILL_AT_SEA);
    expect(named(v, START_AGAIN)).toBeUndefined();
    tap(v, WATCH_ANOTHER_SAILOR);
    expect(watched).toBe(1);
    expect(out.asking.value).toBeNull();
    expect(s.sent).toEqual([]);
  });

  test('Watch another sailor asks first; Keep it changes nothing; Take it out takes the boat out, then opens the list', async () => {
    const s = server();
    let watched = 0;
    const out = new TakeOut(true, s.f);
    const { draw } = panel(out, s.f, { watch: () => watched++ });
    tap(draw(), WATCH_ANOTHER_SAILOR);
    const asked = draw();
    expect(text(asked)).toContain(TAKE_OUT_QUESTION);
    expect(text(asked)).toContain(TAKE_OUT_DETAIL);
    expect(named(asked, setSailAs('Anne Bonny'))).toBeUndefined();
    tap(asked, KEEP_IT);
    expect(watched).toBe(0);
    expect(s.sent).toEqual([]);
    expect(text(draw())).toContain(STILL_AT_SEA);
    tap(draw(), WATCH_ANOTHER_SAILOR);
    tap(draw(), TAKE_IT_OUT);
    await settle();
    expect(s.sent).toEqual(['/api/me/ashore']);
    expect(watched).toBe(1);
    expect(out.atSea.value).toBe(false);
    expect(text(draw())).not.toContain(STILL_AT_SEA);
  });

  test('a look saved asks first, and is saved once the boat is out', async () => {
    const s = server();
    const out = new TakeOut(true, s.f);
    const { chooser, draw } = panel(out, s.f);
    tap(draw(), 'Change your look');
    expect(chooser.mode.value).toBe('picking');
    tap(draw(), 'Save');
    expect(text(draw())).toContain(TAKE_OUT_QUESTION);
    expect(s.sent).toEqual([]);
    tap(draw(), TAKE_IT_OUT);
    await settle();
    expect(s.sent).toEqual(['/api/me/ashore', '/api/sailor/look']);
    expect(chooser.mode.value).toBe('shown');
  });

  test('Start again at Port Royal asks first, then takes the boat out and sets sail, the box for a new voyage', async () => {
    const s = server();
    let sailed = 0;
    const out = new TakeOut(true, s.f);
    const { voyage: v, draw } = panel(out, s.f, { sail: () => sailed++ });
    out.out = () => v.ashore();
    tap(draw(), START_AGAIN);
    expect(text(draw())).toContain(TAKE_OUT_QUESTION);
    expect(sailed).toBe(0);
    tap(draw(), TAKE_IT_OUT);
    await settle();
    expect(s.sent[0]).toBe('/api/me/ashore');
    expect(sailed).toBe(1);
    expect(v.going.value).toBe(true);
  });

  test('what waited on the answer runs only once what followed the boat out is done: a fleet read never lands after a boat chosen', async () => {
    const s = server();
    const order: string[] = [];
    let read = (): void => {};
    const out = new TakeOut(true, s.f);
    out.out = () =>
      new Promise<void>((resolve) => {
        order.push('reading');
        read = () => {
          order.push('read');
          resolve();
        };
      });
    out.guard(() => order.push('chosen'));
    const taken = out.take();
    await settle();
    expect(order).toEqual(['reading']);
    read();
    expect(await taken).toBe(true);
    expect(order).toEqual(['reading', 'read', 'chosen']);
  });

  test('a boat that cannot be taken out stays, the question open, saying so', async () => {
    const s = server(503);
    let watched = 0;
    const out = new TakeOut(true, s.f);
    const { draw } = panel(out, s.f, { watch: () => watched++ });
    tap(draw(), WATCH_ANOTHER_SAILOR);
    expect(await out.take()).toBe(false);
    expect(watched).toBe(0);
    expect(out.atSea.value).toBe(true);
    expect(text(draw())).toContain(NOT_TAKEN_OUT);
  });

  test('the question’s words', () => {
    expect(TAKE_OUT_QUESTION).toBe('Take your boat out of the water?');
    expect(TAKE_OUT_DETAIL).toBe('It ends that voyage.');
    expect([TAKE_IT_OUT, KEEP_IT]).toEqual(['Take it out', 'Keep it']);
    expect(START_AGAIN).toBe('Start again at Port Royal');
  });
});
