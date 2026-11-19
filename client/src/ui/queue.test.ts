// SPDX-License-Identifier: AGPL-3.0-only

// The boat queue as the player sees it while the sea is full: the line
// with their place and how many wait, as the connection tells them, and
// gone once their boat is admitted.

import { existsSync, readFileSync } from 'node:fs';
import { signal } from '@preact/signals';
import type { ComponentChildren, VNode } from 'preact';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { PilotInput } from '../input/pilot';
import type { FromWorker, ToWorker } from '../net/messages';
import { Online, type Place, type Port } from '../net/online';
import { loadPhysics } from '../predict/physics';
import { Predictor } from '../predict/predictor';
import { QueueNotice } from './queue';

type Node = VNode<{ children?: ComponentChildren; role?: string; 'data-readout'?: string }>;

function textOf(node: ComponentChildren): string {
  if (Array.isArray(node)) {
    return node.map(textOf).join(' ');
  }
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node !== 'object') {
    return String(node);
  }
  return textOf((node as Node).props.children);
}

const wasm = new URL('../predict/physics.wasm', import.meta.url);
let bytes: Uint8Array<ArrayBuffer>;

beforeAll(() => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  bytes = new Uint8Array(readFileSync(wasm));
});

class FakePort implements Port {
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null = null;
  postMessage(_: ToWorker): void {}
  deliver(m: FromWorker): void {
    this.onmessage?.({ data: m } as MessageEvent<FromWorker>);
  }
}

async function online() {
  const p = new Predictor(
    await loadPhysics(bytes),
    catalog.boats[0].physics,
    catalog.weather,
    catalog.world,
  );
  const port = new FakePort();
  const o = new Online(port, p, {
    helm: { target: 0 },
    sheet: { target: 0.5 },
    pilot: new PilotInput(),
    beforeStep: null,
    clock: { steps: 0, alpha: 0 },
  });
  return { o, port };
}

const welcome: FromWorker = {
  type: 'welcome',
  boat: 1,
  rejoined: false,
  kind: 0,
  tick: 100,
  epochUs: 0,
  world: 'w',
  land: false,
  circulation: 0,
  tools: false,
  light: null,
  harbour: null,
  endsUs: 0,
  closingUs: 0,
  zone: '',
  watching: null,
  aboard: null,
  look: 0,
  boatLook: 0,
  boatName: '',
  first: true,
};

describe('the boat queue in the page', () => {
  test('the place and how many wait, read out as a status; nothing without a place', () => {
    const place = signal<Place | null>({ position: 3, waiting: 41 });
    const shown = QueueNotice({ place }) as Node;
    expect(shown.props.role).toBe('status');
    expect(shown.props['data-readout']).toBe('queue');
    expect(textOf(shown)).toBe('The sea is full. You are 3rd in line. 41 sailors waiting.');
    place.value = { position: 1, waiting: 1 };
    expect(textOf(QueueNotice({ place }))).toBe(
      'The sea is full. You are next in line. 1 sailor waiting.',
    );
    place.value = null;
    expect(QueueNotice({ place })).toBeNull();
  });

  test('the connection’s place moves the line, and the boat admitted takes it away', async () => {
    const { o, port } = await online();
    port.deliver({ type: 'status', status: 'queued', waitMs: 0, reason: '' });
    port.deliver({ type: 'queued', position: 12, waiting: 40, spectators: false });
    expect(textOf(QueueNotice({ place: o.place }))).toBe(
      'The sea is full. You are 12th in line. 40 sailors waiting.',
    );
    port.deliver({ type: 'queued', position: 2, waiting: 35, spectators: false });
    expect(textOf(QueueNotice({ place: o.place }))).toContain('You are 2nd in line.');
    // A place to watch is another queue: the boat's line stays.
    port.deliver({ type: 'queued', position: 9, waiting: 90, spectators: true });
    expect(o.place.value).toEqual({ position: 2, waiting: 35 });
    port.deliver(welcome);
    port.deliver({ type: 'status', status: 'sailing', waitMs: 0, reason: '' });
    expect(QueueNotice({ place: o.place })).toBeNull();
  });

  test('the connection lost while waiting takes the line away', async () => {
    const { o, port } = await online();
    port.deliver({ type: 'queued', position: 5, waiting: 6, spectators: false });
    expect(o.place.value).not.toBeNull();
    port.deliver({ type: 'status', status: 'waiting', waitMs: 1000, reason: '' });
    expect(QueueNotice({ place: o.place })).toBeNull();
  });
});
