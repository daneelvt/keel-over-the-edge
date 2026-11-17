// SPDX-License-Identifier: AGPL-3.0-only

import type { VNode } from 'preact';
import { afterEach, describe, expect, test } from 'vitest';
import { updated } from '../boot/updated';
import { UpdateLine } from './updateline';
import { RELOAD, UPDATED } from './updatewords';

type Props = { class: string; children: VNode<{ children: string; onClick: () => void }>[] };

describe('the update line', () => {
  afterEach(() => {
    updated.value = false;
  });

  test('its words, short and plain, and its one key', () => {
    expect(UPDATED).toBe('The game was updated. Reload to carry on.');
    expect(RELOAD).toBe('Reload');
  });

  test('nothing until the game was updated', () => {
    expect(UpdateLine({})).toBeNull();
    expect(UpdateLine({ start: true })).toBeNull();
  });

  test('at sea with the notices, its key reloading only when pressed', () => {
    updated.value = true;
    let reloads = 0;
    const line = UpdateLine({ reload: () => reloads++ }) as VNode<Props>;
    expect(line.props.class).toContain('notice');
    const [words, key] = line.props.children;
    expect(words?.props.children).toBe(UPDATED);
    expect(key?.props.children).toBe(RELOAD);
    expect(reloads).toBe(0);
    key?.props.onClick();
    expect(reloads).toBe(1);
  });

  test('on the start screen at the top', () => {
    updated.value = true;
    const line = UpdateLine({ start: true }) as VNode<Props>;
    expect(line.props.class).toContain('back-soon');
  });
});
