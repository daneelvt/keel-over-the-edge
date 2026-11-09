// SPDX-License-Identifier: AGPL-3.0-only

// Shipmates as the screens see them: the list read as the page comes to
// sea and each time the server says it changed; a notice for each offer
// new to the page, once, and for a message whose thread is not open;
// opening a thread or the panel puts their notices away; someone gone
// from the list takes their thread with them, closed without a word; and
// what the screens ask of it.

import { signal } from '@preact/signals';
import { describe, expect, test } from 'vitest';
import type { ShipmatesList, ShipmatesServer } from '../account/shipmatesapi';
import { deckScene } from '../dev/deckscenes';
import type { Status } from '../net/messages';
import { plain } from './deckwords';
import { ShipmateThreads } from './shipmatelog';
import { freshOffers, nameOf, shipmatesOf, shipmatesShown } from './shipmatesview';

function listed(more: Partial<ShipmatesList> = {}): ShipmatesList {
  return {
    offline: false,
    messages: true,
    shipmates: [
      { id: 'mary', name: 'Iron Mary', look: 0, presence: 'sea', skipper: true },
      { id: 'bly', name: 'Bosun Bly', look: 0, presence: 'game', skipper: false },
    ],
    offers: [],
    recent: [],
    ...more,
  };
}

/** A server that answers with the list as it stands, what it was asked written down. */
function serverOf(list: { value: ShipmatesList }) {
  const asked: string[] = [];
  const server: ShipmatesServer = {
    list: async () => {
      asked.push('list');
      return structuredClone(list.value);
    },
    offer: async () => 'offered',
    accept: async () => 'gone',
    decline: async (id) => asked.push(`decline ${id}`) > 0,
    end: async () => true,
    block: async (id) => asked.push(`block ${id}`) > 0,
    report: async () => true,
    offline: async () => false,
  };
  return { server, asked };
}

function sourceOf() {
  const told: string[] = [];
  const threads = new ShipmateThreads();
  return {
    told,
    threads,
    shipmatesChanged: signal(0),
    status: signal<Status>('connecting'),
    sayTo: (to: string, text: string) => told.push(`say ${to} ${text}`) > 0,
    knockShipmate: (id: string) => told.push(`knock ${id}`),
    watch: (name: string) => told.push(`watch ${name}`),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function message(threads: ShipmateThreads, thread: string, name: string, text: string) {
  threads.receive(
    { id: 1, seat: 0, name, machine: false, at: 1, text, you: false, echo: 0, refused: '', thread },
    1,
  );
}

describe('the list read', () => {
  test('once as the connection is first welcomed, and again each time the server says it changed', async () => {
    const list = { value: listed() };
    const { server, asked } = serverOf(list);
    const o = sourceOf();
    const v = shipmatesOf(o, { server });
    expect(asked).toEqual([]);
    o.status.value = 'sailing';
    await settle();
    expect(asked).toEqual(['list']);
    o.status.value = 'waiting';
    o.status.value = 'sailing';
    await settle();
    expect(asked).toEqual(['list']);
    o.shipmatesChanged.value++;
    await settle();
    expect(asked).toEqual(['list', 'list']);
    expect(v.list.value?.shipmates.map((s) => s.name)).toEqual(['Iron Mary', 'Bosun Bly']);
    expect(nameOf(v.list.value, 'bly')).toBe('Bosun Bly');
    expect(nameOf(v.list.value, 'nobody', 'Gull')).toBe('Gull');
  });

  test('a list that cannot be read keeps the last', async () => {
    const list = { value: listed() };
    const { server } = serverOf(list);
    const v = shipmatesOf(sourceOf(), { server });
    await v.refresh();
    server.list = async () => null;
    await v.refresh();
    expect(v.failed.value).toBe(true);
    expect(v.list.value?.shipmates).toHaveLength(2);
  });
});

describe('the notices', () => {
  test('an offer new to the page is a notice once; the panel opened puts it away', async () => {
    const list = { value: listed({ offers: [{ id: 'quill', name: 'Captain Quill', look: 0 }] }) };
    const { server } = serverOf(list);
    const v = shipmatesOf(sourceOf(), { server });
    await v.refresh();
    expect(v.notices.value).toMatchObject([{ kind: 'offer', id: 'quill', name: 'Captain Quill' }]);
    expect(shipmatesShown(v)).toBe(true);
    await v.refresh();
    expect(v.notices.value).toHaveLength(1);
    v.panel.value = true;
    expect(v.notices.value).toEqual([]);
    v.panel.value = false;
    await v.refresh();
    expect(v.notices.value).toEqual([]);
    expect(shipmatesShown(v)).toBe(false);
  });

  test('an offer withdrawn or lapsed takes its notice with it', async () => {
    const list = { value: listed({ offers: [{ id: 'quill', name: 'Captain Quill', look: 0 }] }) };
    const { server } = serverOf(list);
    const v = shipmatesOf(sourceOf(), { server });
    await v.refresh();
    list.value = listed();
    await v.refresh();
    expect(v.notices.value).toEqual([]);
  });

  test('a message while its thread is not open is a notice, one a shipmate; opening the thread puts it away', async () => {
    const o = sourceOf();
    const { server } = serverOf({ value: listed() });
    const v = shipmatesOf(o, { server });
    await v.refresh();
    message(o.threads, 'bly', 'Bosun Bly', 'Ahoy');
    message(o.threads, 'bly', 'Bosun Bly', 'Are you there?');
    message(o.threads, 'mary', 'Iron Mary', 'Fair winds');
    expect(v.notices.value.map((n) => `${n.kind} ${n.name}`)).toEqual([
      'message Bosun Bly',
      'message Iron Mary',
    ]);
    v.thread.value = 'bly';
    expect(v.notices.value.map((n) => n.name)).toEqual(['Iron Mary']);
    message(o.threads, 'bly', 'Bosun Bly', 'Here I am');
    expect(v.notices.value.map((n) => n.name)).toEqual(['Iron Mary']);
  });
});

describe('no longer shipmates', () => {
  test('gone from the list, their thread is forgotten and closes, their notice with it', async () => {
    const o = sourceOf();
    const list = { value: listed() };
    const { server } = serverOf(list);
    const v = shipmatesOf(o, { server });
    await v.refresh();
    message(o.threads, 'mary', 'Iron Mary', 'Ahoy');
    message(o.threads, 'bly', 'Bosun Bly', 'Ahoy');
    v.thread.value = 'bly';
    list.value = listed({ shipmates: [] });
    o.shipmatesChanged.value++;
    await settle();
    expect(v.thread.value).toBeNull();
    expect(o.threads.threads).toEqual([]);
    expect(v.notices.value).toEqual([]);
  });

  test('ending from the panel: their row gone at once, the words under it', async () => {
    const o = sourceOf();
    const list = { value: listed() };
    const { server } = serverOf(list);
    const v = shipmatesOf(o, { server });
    await v.refresh();
    // The server's list still has them until read again: the edit is the page's.
    server.list = async () => null;
    const words = await v.end({ id: 'mary' }, 'Iron Mary');
    expect(plain(words)).toBe('No longer shipmates with Iron Mary');
    expect(v.list.value?.shipmates.map((s) => s.id)).toEqual(['bly']);
    expect(v.told.value?.id).toBe('mary');
  });

  test('a block hides their lines at once and takes them off every list', async () => {
    const hidden: string[] = [];
    const list = {
      value: listed({
        recent: [
          { id: 'bly', name: 'Bosun Bly', look: 0, shipmate: true, offered: false, can: false },
        ],
      }),
    };
    const { server, asked } = serverOf(list);
    const v = shipmatesOf(sourceOf(), { server, hide: (n) => hidden.push(n) });
    await v.refresh();
    server.list = async () => null;
    await v.block('bly', 'Bosun Bly');
    expect(asked).toContain('block bly');
    expect(hidden).toEqual(['Bosun Bly']);
    expect(v.list.value?.shipmates.map((s) => s.id)).toEqual(['mary']);
    expect(v.list.value?.recent).toEqual([]);
  });
});

describe('what the screens ask', () => {
  test('a decline is silent and leaves the list at once; a lapsed offer is said', async () => {
    const list = { value: listed({ offers: [{ id: 'quill', name: 'Captain Quill', look: 0 }] }) };
    const { server, asked } = serverOf(list);
    const v = shipmatesOf(sourceOf(), { server });
    await v.refresh();
    server.list = async () => null;
    const offer = v.list.value?.offers[0];
    if (offer === undefined) {
      throw new Error('no offer');
    }
    await v.accept(offer);
    expect(plain(v.told.value?.words ?? [])).toBe('That offer has lapsed');
    expect(v.list.value?.offers).toEqual([]);
    list.value = listed({ offers: [offer] });
    server.list = async () => structuredClone(list.value);
    await v.refresh();
    await v.decline(offer);
    expect(asked).toContain('decline quill');
    expect(v.told.value?.id).toBe('quill');
  });

  test('an offer by seat says what came of it; appearing offline that fails is undone', async () => {
    const { server } = serverOf({ value: listed() });
    const v = shipmatesOf(sourceOf(), { server });
    await v.refresh();
    expect(plain(await v.offer({ seat: 2 }, 'Tarry Tom'))).toBe(
      'Offered: if Tarry Tom accepts, you’ll be shipmates',
    );
    // Offered by seat, not on the panel: no row's words.
    expect(v.told.value).toBeNull();
    await v.setOffline(true);
    expect(v.list.value?.offline).toBe(false);
  });

  test('messages, knocks and watches go to the game connection; a watch as a change of boat', () => {
    const o = sourceOf();
    const changed: string[] = [];
    const v = shipmatesOf(o, {
      server: serverOf({ value: listed() }).server,
      change: (act) => {
        changed.push('change');
        act();
      },
    });
    v.say('bly', 'Ahoy', 'Sue');
    v.knock('mary');
    v.watch('Iron Mary');
    expect(o.told).toEqual(['say bly Ahoy', 'knock mary', 'watch Iron Mary']);
    expect(changed).toEqual(['change']);
  });

  test('freshOffers: each offer once', () => {
    const seen = new Set<string>();
    const a = { id: 'a', name: 'A', look: 0 };
    const b = { id: 'b', name: 'B', look: 0 };
    expect(freshOffers(seen, [a])).toEqual([a]);
    expect(freshOffers(seen, [a, b])).toEqual([b]);
    expect(freshOffers(seen, [a, b])).toEqual([]);
  });
});

describe('the scenes', () => {
  test('each shipmates scene opens what it shows', () => {
    const v = (n: Parameters<typeof deckScene>[0]) => {
      const s = deckScene(n).deck.shipmates;
      if (s === null) {
        throw new Error('no shipmates');
      }
      return s;
    };
    expect(v('shipmates').panel.value).toBe(true);
    expect(v('shipmates-thread').thread.value).toBe('bly');
    expect(v('shipmates-thread').threads.lines('bly')).toHaveLength(4);
    expect(v('shipmates-away').threads.note('meg')).toMatchObject({ why: 'away' });
    expect(v('shipmates-notice').notices.value).toMatchObject([{ kind: 'message', id: 'bly' }]);
    expect(v('shipmates-offer-notice').notices.value).toMatchObject([{ kind: 'offer' }]);
    expect(v('shipmates-offline').list.value?.offline).toBe(true);
    expect(v('shipmates-empty').list.value?.shipmates).toEqual([]);
    expect(v('knocks').panel.value).toBe(false);
    expect(shipmatesShown(v('knocks'))).toBe(false);
  });
});
