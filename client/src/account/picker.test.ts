// SPDX-License-Identifier: AGPL-3.0-only

import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { hairsOf, type Look, lookWords, validLook } from '../catalog/looks';
import { LOOK_AWAY, LookChooser } from './chooser';
import type { Me } from './me';
import {
  chosen,
  NEXT_LOOK,
  Picker,
  PICKER_NOTE,
  placeWords,
  PREVIOUS_LOOK,
  shuffled,
  stepLook,
  undone,
  versionsOf,
} from './picker';

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

const first = (): Look => {
  const s = catalog.sailors[0];
  const o = catalog.sailorOptions;
  return {
    look: s?.id ?? '',
    version: s?.versions[0]?.id ?? '',
    skin: o.skins[0]?.id ?? '',
    hair: o.hairs[0]?.id ?? '',
    colour: o.colours[0]?.id ?? '',
  };
};

describe('the picker', () => {
  test('goes through every look and version in the catalog’s order, round', () => {
    const all = versionsOf(catalog);
    expect(all).toHaveLength(18);
    let l = first();
    const seen = [];
    for (let i = 0; i < all.length; i++) {
      seen.push(`${l.look} ${l.version}`);
      expect(validLook(catalog, l)).toBe(true);
      l = stepLook(catalog, l, 1);
    }
    expect(seen).toEqual(all.map((p) => `${p.look} ${p.version}`));
    expect(l).toEqual(first());
    expect(stepLook(catalog, first(), -1).look).toBe(catalog.sailors.at(-1)?.id);
  });

  test('takes a grey for a look of greys, and back, its place in the set kept', () => {
    const greying = catalog.sailors.findIndex((s) => s.hair === 'greys');
    const before = catalog.sailors[greying - 1];
    const s = catalog.sailors[greying];
    if (before === undefined || s === undefined) {
      throw new Error('no look of greys after another');
    }
    const l: Look = {
      ...first(),
      look: before.id,
      version: before.versions.at(-1)?.id ?? '',
      hair: catalog.sailorOptions.hairs[2]?.id ?? '',
    };
    const next = stepLook(catalog, l, 1);
    expect(next.look).toBe(s.id);
    expect(next.hair).toBe(hairsOf(catalog, s)[2]?.id);
    expect(validLook(catalog, next)).toBe(true);
  });

  test('says the look, its version and its place: "female · 1 of 18"', () => {
    const w = placeWords(catalog, first());
    expect(w.name).toBe(catalog.sailors[0]?.name);
    expect(w.place).toBe(`${catalog.sailors[0]?.versions[0]?.name} · 1 of 18`);
  });

  test('has its groups of named swatches, the chosen ringed, and the look in words', () => {
    const chose: Look[] = [];
    const tree = expand(
      Picker({
        looks: catalog,
        look: first(),
        choose: (l) => chose.push(l),
        shuffle: () => {},
        undo: null,
        figure: true,
      }),
    );
    const groups = findAll(tree, (n) => n.props.role === 'radiogroup');
    expect(groups).toHaveLength(3);
    const radios = findAll(tree, (n) => n.props.role === 'radio');
    expect(radios.map((r) => r.props['aria-label'])).toEqual([
      ...catalog.sailorOptions.skins.map((o) => o.name),
      ...catalog.sailorOptions.hairs.map((o) => o.name),
      ...catalog.sailorOptions.colours.map((o) => o.name),
    ]);
    expect(radios.filter((r) => r.props['aria-checked'] === true)).toHaveLength(3);
    const live = findAll(tree, (n) => n.props['aria-live'] === 'polite');
    expect(text(live)).toBe(lookWords(catalog, first()));
    expect(text(tree)).toContain(PICKER_NOTE);
    // A swatch chooses its option, the arrows the next look.
    const colour = catalog.sailorOptions.colours[3];
    (radios.find((r) => r.props['aria-label'] === colour?.name)?.props.onClick as () => void)();
    expect(chose.at(-1)?.colour).toBe(colour?.id);
    const next = findAll(tree, (n) => n.props['aria-label'] === NEXT_LOOK)[0];
    (next?.props.onClick as () => void)();
    expect(chose.at(-1)).toEqual(stepLook(catalog, first(), 1));
    expect(findAll(tree, (n) => n.props['aria-label'] === PREVIOUS_LOOK)).toHaveLength(1);
    // No Undo before a shuffle; the portrait only where the stage draws no figure.
    expect(text(tree)).not.toContain('Undo');
    expect(findAll(tree, (n) => n.props.class === 'picker-portrait')).toHaveLength(0);
  });

  test('Shuffle draws another look; Undo takes it back, once', () => {
    let r = 0.1;
    const random = () => {
      r = (r + 0.37) % 1;
      return r;
    };
    const s = shuffled(catalog, chosen(first()), random);
    expect(`${s.look.look} ${s.look.version}`).not.toBe(`${first().look} ${first().version}`);
    expect(validLook(catalog, s.look)).toBe(true);
    expect(s.before).toEqual(first());
    const back = undone(s);
    expect(back).toEqual({ look: first(), before: null });
    expect(undone(back)).toBe(back);
  });
});

describe('a look changed on the player’s panel', () => {
  const me: Me = { name: 'Ann Bonny', kind: 'human', ...first(), lookChosen: true };

  test('is kept by the server, and refused away from Port Royal', async () => {
    const sent: unknown[] = [];
    let status = 409;
    const fetcher = async (_: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status });
    };
    const c = new LookChooser(catalog, me, undefined, fetcher);
    expect(c.mode.value).toBe('shown');
    c.open();
    expect(c.mode.value).toBe('picking');
    const next = stepLook(catalog, first(), 3);
    c.choose(next);
    expect(await c.save()).toBe(false);
    expect(c.problem.value).toBe(LOOK_AWAY);
    expect(c.look.value).toEqual(first());
    status = 200;
    expect(await c.save()).toBe(true);
    expect(sent.at(-1)).toEqual(next);
    expect(c.look.value).toEqual(next);
    expect(c.mode.value).toBe('shown');
    expect(c.applied(me)).toMatchObject({ ...next, lookChosen: true });
  });

  test('is asked once of a sailor whose look the game drew: Keep keeps it', async () => {
    const sent: unknown[] = [];
    const fetcher = async (_: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    };
    const c = new LookChooser(catalog, { ...me, lookChosen: false }, undefined, fetcher);
    expect(c.mode.value).toBe('once');
    c.choose(stepLook(catalog, first(), 5));
    expect(await c.save(c.look.value)).toBe(true);
    expect(sent).toEqual([first()]);
    expect(c.chosen).toBe(true);
    expect(c.mode.value).toBe('shown');
  });
});
