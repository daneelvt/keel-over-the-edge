// SPDX-License-Identifier: AGPL-3.0-only

// Sailing together on the screen: what each row of who is aboard offers,
// by who the player is and who holds the controls; when the plate stands
// at the foot in the controls' place, and when anything shows; the
// knocks' card and the plate drawn; and the skipper's link, kept on the
// device and read against the server's word.

import { signal } from '@preact/signals';
import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, test } from 'vitest';
import { deckScene } from '../dev/deckscenes';
import type { CrewTold, PersonTold, WhoTold } from '../net/messages';
import { ChatLog } from './chatlog';
import { DeckPlate, holderName, KnockCards, rowActions, secondsLeft, splitActions } from './deck';
import { canShareLink, deckOf, deckPlate, deckShown, selfOf, skipperAway } from './decklazy';
import {
  keepLink,
  keptLink,
  type LinkStore,
  linkServer,
  madeProblem,
  shownLink,
} from './sailwithme';

function person(seat: number, you = false): PersonTold {
  return {
    seat,
    look: 0,
    name: `Sailor ${seat}`,
    machine: false,
    you,
    muted: false,
    blocked: false,
    shipmate: false,
  };
}

/** What anyone aboard may do to anyone else: mute, block, report. */
const TIES = ['mute', 'block', 'report'];

/** Three aboard, the player in seat me, the controls held by holder. */
function crew(me: number | null, holder: number): CrewTold {
  return { people: [0, 1, 2].map((s) => person(s, s === me)), holder };
}

describe('who is aboard: what each row offers', () => {
  test('the skipper holding the controls hands them to anyone and puts anyone ashore', () => {
    const c = crew(0, 0);
    expect(rowActions(c, 0)).toEqual([]);
    expect(rowActions(c, 1)).toEqual(['hand', 'putAshore', ...TIES]);
    expect(rowActions(c, 2)).toEqual(['hand', 'putAshore', ...TIES]);
  });

  test('the skipper while another holds them takes them back, at once, and still puts anyone ashore', () => {
    const c = crew(0, 1);
    expect(rowActions(c, 0)).toEqual(['take']);
    expect(rowActions(c, 1)).toEqual(['putAshore', ...TIES]);
    expect(rowActions(c, 2)).toEqual(['putAshore', ...TIES]);
  });

  test('one of the crew holding them hands them on or gives them back; puts no one ashore', () => {
    const c = crew(2, 2);
    expect(rowActions(c, 2)).toEqual(['giveBack']);
    expect(rowActions(c, 0)).toEqual(['hand', ...TIES]);
    expect(rowActions(c, 1)).toEqual(['hand', ...TIES]);
  });

  test('one of the crew not holding them may only mute, block and report the others', () => {
    for (const holder of [0, 1]) {
      const c = crew(2, holder);
      expect([0, 1, 2].map((s) => rowActions(c, s))).toEqual([TIES, TIES, []]);
    }
  });

  test('a mute or a block in force is offered to be ended', () => {
    const c = crew(0, 0);
    c.people[1] = { ...person(1), muted: true };
    c.people[2] = { ...person(2), blocked: true };
    expect(rowActions(c, 1)).toEqual(['hand', 'putAshore', 'unmute', 'block', 'report']);
    expect(rowActions(c, 2)).toEqual(['hand', 'putAshore', 'mute', 'unblock', 'report']);
    // The controls stand on the row; the rest is behind its ⋯ key.
    expect(splitActions(rowActions(c, 1))).toEqual({
      keys: ['hand'],
      more: ['putAshore', 'unmute', 'block', 'report'],
    });
    expect(splitActions(['take'])).toEqual({ keys: ['take'], more: [] });
  });

  test('with shipmates, a person is offered to be shipmates, a shipmate ended, behind ⋯', () => {
    const c = crew(1, 0);
    c.people[2] = { ...person(2), shipmate: true };
    expect(rowActions(c, 0, true)).toEqual(['shipmates', ...TIES]);
    expect(rowActions(c, 2, true)).toEqual(['unship', ...TIES]);
    expect(rowActions(c, 1, true)).toEqual([]);
    expect(splitActions(rowActions(crew(0, 0), 1, true))).toEqual({
      keys: ['hand'],
      more: ['shipmates', 'putAshore', ...TIES],
    });
  });

  test('never shipmates with a machine sailor, nor anyone blocked; nothing for a spectator', () => {
    const c = crew(0, 0);
    c.people[1] = { ...person(1), machine: true };
    c.people[2] = { ...person(2), blocked: true };
    expect(rowActions(c, 1, true)).toEqual(['hand', 'putAshore', ...TIES]);
    expect(rowActions(c, 2, true)).toEqual(['hand', 'putAshore', 'mute', 'unblock', 'report']);
    expect(rowActions(crew(null, 0), 1, true)).toEqual([]);
  });

  test('a spectator, who is not aboard, may do nothing; nor to a seat no one has', () => {
    const c = crew(null, 0);
    expect([0, 1, 2].map((s) => rowActions(c, s))).toEqual([[], [], []]);
    expect(rowActions(crew(0, 0), 5)).toEqual([]);
    expect(selfOf(c)).toBeNull();
  });

  test('whoever holds them, by name', () => {
    expect(holderName(crew(0, 1))).toBe('Sailor 1');
    expect(holderName(null)).toBe('');
  });
});

describe('what shows of sailing together', () => {
  test('the plate stands in the controls’ place aboard without them, and for the skipper while another holds them', () => {
    const plate = (name: Parameters<typeof deckScene>[0]) => deckPlate(deckScene(name).deck);
    expect(plate('aboard')).toBe(true);
    expect(plate('handed')).toBe(true);
    expect(plate('skipper-away')).toBe(true);
    expect(plate('aboard-holding')).toBe(false);
    expect(plate('skipper')).toBe(false);
    expect(plate('knocks')).toBe(false);
    expect(skipperAway(deckScene('skipper-away').deck)).toBe(true);
    expect(skipperAway(deckScene('aboard').deck)).toBe(false);
  });

  test('nothing while sailing alone, and nothing while watching a crewed boat', () => {
    const alone = deckOf(source());
    expect(deckShown(alone)).toBe(false);
    expect(canShareLink(alone)).toBe(true);
    const s = source();
    s.watching.value = { sailor: 'Iron Mary', machine: false, mine: false, look: 0 };
    s.crew.value = crew(null, 0);
    const watching = deckOf(s);
    expect(deckShown(watching)).toBe(false);
    expect(deckPlate(watching)).toBe(false);
    expect(canShareLink(watching)).toBe(false);
  });

  test('a knock put away shows no more; a new word of it shows again', () => {
    const s = source();
    const d = deckOf(s);
    s.knocking.value = { state: 'waiting', skipper: 'Iron Mary', kind: 0, boat: '' };
    expect(deckShown(d)).toBe(true);
    d.dismissed.value = s.knocking.value;
    expect(deckShown(d)).toBe(false);
    s.knocking.value = { state: 'not-now', skipper: 'Iron Mary', kind: 0, boat: '' };
    expect(deckShown(d)).toBe(true);
  });

  test('no link aboard another’s boat; the switch is kept on the page and told to the server', () => {
    const s = source();
    const d = deckOf(s);
    d.closeKnocks(true);
    expect(d.closed.value).toBe(true);
    expect(s.told).toEqual(['closed true']);
    s.aboard.value = { skipper: 'Iron Mary', look: 0, seat: 1 };
    expect(canShareLink(d)).toBe(false);
  });

  test('going ashore goes through the change of boat', () => {
    const s = source();
    const changed: string[] = [];
    const d = deckOf(s, (act) => {
      changed.push('cover');
      act();
    });
    d.goAshore();
    expect(changed).toEqual(['cover']);
    expect(s.told).toEqual(['ashore']);
  });

  test('the seconds left to take the controls', () => {
    expect(secondsLeft(15, 1000, 1000)).toBe(15);
    expect(secondsLeft(15, 1000, 6000)).toBe(10);
    expect(secondsLeft(15, 0, 20_000)).toBe(0);
  });
});

/** The game connection's side, the screens' asks written down. */
function source() {
  const told: string[] = [];
  return {
    told,
    aboard: signal<{ skipper: string; look: number; seat: number } | null>(null),
    crew: signal<CrewTold | null>(null),
    knocks: signal([]),
    knocking: signal<{
      state: 'waiting' | 'not-now';
      skipper: string;
      kind: number;
      boat: string;
    } | null>(null),
    handed: signal(null),
    holding: signal(true),
    watching: signal<{ sailor: string; machine: boolean; mine: boolean; look: number } | null>(
      null,
    ),
    status: signal<'sailing'>('sailing'),
    kind: signal(0),
    boatLook: signal(null),
    answer: (k: number, l: boolean) => told.push(`answer ${k} ${l}`),
    hand: (s: number) => told.push(`hand ${s}`),
    take: () => told.push('take'),
    giveBack: () => told.push('give back'),
    goAshore: () => told.push('ashore'),
    putAshore: (s: number) => told.push(`put ashore ${s}`),
    closeKnocks: (c: boolean) => told.push(`closed ${c}`),
    chat: new ChatLog(),
    chatState: signal(null),
    sayAboard: (t: string) => told.push(`say ${t}`) > 0,
    mute: (_w: WhoTold, n: string, on: boolean) => told.push(`mute ${n} ${on}`),
    block: (_w: WhoTold, n: string, on: boolean) => told.push(`block ${n} ${on}`),
    report: (_w: WhoTold, r: string) => told.push(`report ${r}`),
  };
}

/** The text of a tree as written: its strings and numbers, in order. */
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
  return text((node as VNode<{ children?: ComponentChildren }>).props.children);
}

/** The buttons of a tree as written, and their presses. */
function buttons(node: ComponentChildren): { words: string; press: () => void }[] {
  if (Array.isArray(node)) {
    return node.flatMap(buttons);
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return [];
  }
  const v = node as VNode<{ children?: ComponentChildren; onClick?: () => void }>;
  return [
    ...(v.type === 'button' ? [{ words: text(v), press: v.props.onClick ?? (() => {}) }] : []),
    ...buttons(v.props.children),
  ];
}

describe('the parts drawn', () => {
  test('a knock: the oldest shown, Let aboard and Not now answer it, and how many more wait', () => {
    const s = deckScene('knocks', 'Saltpeter Sue');
    const card = KnockCards({ deck: s.deck });
    const keys = buttons(card);
    expect(keys.map((k) => k.words)).toEqual(['Let aboard', 'Not now']);
    keys[0]?.press();
    keys[1]?.press();
    expect(s.calls).toEqual(['answer 1 let', 'answer 1 not now']);
    expect((card as VNode<{ 'aria-label': string }>).props['aria-label']).toBe(
      'Saltpeter Sue asks to come aboard',
    );
    expect(text(card)).toContain('2 more waiting');
    expect(text(card)).not.toMatch(/\d+ years|age/i);
  });

  test('the plate aboard: Crew and Go ashore, which asks first', () => {
    const s = deckScene('aboard');
    const plate = DeckPlate({ deck: s.deck });
    const keys = buttons(plate);
    expect(keys.map((k) => k.words)).toEqual(['Crew', 'Go ashore']);
    keys[1]?.press();
    expect(s.deck.ashore.value).toBe(true);
    expect(s.calls).toEqual([]);
    keys[0]?.press();
    expect(s.deck.list.value).toBe(true);
  });

  test('the skipper’s plate while another holds the controls: Take back the controls, at once', () => {
    const s = deckScene('skipper-away');
    const plate = DeckPlate({ deck: s.deck });
    const keys = buttons(plate);
    expect(keys.map((k) => k.words)).toEqual(['Take back the controls', 'Crew']);
    keys[0]?.press();
    expect(s.calls).toEqual(['take']);
    expect((plate as VNode<{ 'aria-label': string }>).props['aria-label']).toBe(
      'At the helm Iron Mary',
    );
  });

  test('no plate while the player holds the controls', () => {
    expect(DeckPlate({ deck: deckScene('aboard-holding').deck })).toBeNull();
    expect(DeckPlate({ deck: deckScene('skipper').deck })).toBeNull();
  });
});

describe('the skipper’s link', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const link = { url: 'https://play.example/sail/abc', expires: now + 3_600_000 };

  test('shown when the device keeps the link the server says is out', () => {
    expect(shownLink({ live: true, expires: link.expires }, link, now)).toEqual({
      shown: { kind: 'here', link },
      forget: false,
    });
  });

  test('out but not here: it can only be ended or replaced, and the old one kept is forgotten', () => {
    expect(shownLink({ live: true, expires: link.expires + 60_000 }, link, now)).toEqual({
      shown: { kind: 'elsewhere', expires: link.expires + 60_000 },
      forget: true,
    });
    expect(shownLink({ live: true, expires: link.expires }, null, now).forget).toBe(false);
  });

  test('none out, or ended: the one kept is forgotten; unread, nothing changes', () => {
    expect(shownLink({ live: false }, link, now)).toEqual({
      shown: { kind: 'none', ended: false },
      forget: true,
    });
    expect(shownLink({ live: true, expires: now }, null, now).shown.kind).toBe('none');
    expect(shownLink(null, link, now)).toEqual({ shown: { kind: 'unread' }, forget: false });
  });

  test('kept on the device for each sailor, and forgotten', () => {
    const kept = new Map<string, string>();
    const store: LinkStore = {
      getItem: (k) => kept.get(k) ?? null,
      setItem: (k, v) => kept.set(k, v),
    };
    keepLink('Iron Mary', link, store);
    keepLink('Bosun Bly', { ...link, url: 'https://play.example/sail/def' }, store);
    expect(keptLink('Iron Mary', store)).toEqual(link);
    expect(keptLink('Bosun Bly', store)?.url).toBe('https://play.example/sail/def');
    keepLink('Iron Mary', null, store);
    expect(keptLink('Iron Mary', store)).toBeNull();
    expect(keptLink('Bosun Bly', store)).not.toBeNull();
  });

  test('kept in memory where the device keeps nothing', () => {
    keepLink('Gull', link, null);
    expect(keptLink('Gull', null)).toEqual(link);
    keepLink('Gull', null, null);
    expect(keptLink('Gull', null)).toBeNull();
  });

  test('the server’s answers', async () => {
    const answers: Record<string, Response> = {
      'GET /api/me': Response.json({ name: 'Iron Mary', born: true, rules: false }),
      'GET /api/sail/link': Response.json({ live: true, expires: '2026-11-09T12:00:00Z' }),
      'POST /api/sail/link': Response.json(
        { url: 'https://play.example/sail/abc', expires: '2026-11-09T12:00:00Z' },
        { status: 201 },
      ),
      'POST /api/sail/link/end': new Response(null, { status: 204 }),
    };
    const s = linkServer(async (input, init) => {
      const a = answers[`${init?.method ?? 'GET'} ${input}`];
      if (a === undefined) {
        throw new Error(`asked for ${input}`);
      }
      return a;
    });
    expect(await s.asks()).toEqual(['rules']);
    expect(await s.status()).toEqual({
      live: true,
      closed: false,
      expires: Date.parse('2026-11-09T12:00:00Z'),
    });
    expect(await s.make()).toEqual({
      link: { url: 'https://play.example/sail/abc', expires: Date.parse('2026-11-09T12:00:00Z') },
    });
    expect(await s.end()).toBe(true);
  });

  test('a link refused: the server’s reason', async () => {
    for (const [status, error] of [
      [403, 'born'],
      [403, 'rules'],
      [409, 'links-off'],
    ] as const) {
      const s = linkServer(async () => Response.json({ error }, { status }));
      expect(await s.make()).toEqual({ error });
    }
    expect(madeProblem('links-off')).toBe('Links are resting for now.');
    const down = linkServer(async () => {
      throw new Error('offline');
    });
    expect(await down.status()).toBeNull();
    expect(await down.asks()).toBeNull();
  });
});
