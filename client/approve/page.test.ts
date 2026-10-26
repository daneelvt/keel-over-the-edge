// SPDX-License-Identifier: AGPL-3.0-only

import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, test } from 'vitest';
import { drawMachine, type MachineItem } from '../src/account/machineform';
import type { Fetch } from '../src/account/me';
import { APPROVE_REASONS, approveReasonText, REASONS } from '../src/account/reasons';
import {
  type ApproveReach,
  ApproveView,
  AT_ONCE,
  approve,
  canMake,
  continueWithPasskey,
  deny,
  firstChoice,
  MAKE,
  type Phase,
  type RequestData,
  readRequest,
  type ViewProps,
} from './page';

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

function findAll(node: ComponentChildren, type: string): VNode<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    return node.flatMap((n) => findAll(n, type));
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return [];
  }
  const v = node as VNode<{ children?: ComponentChildren }>;
  return [
    ...(v.type === type ? [v as VNode<Record<string, unknown>>] : []),
    ...findAll(v.props.children, type),
  ];
}

function buttons(node: ComponentChildren): string[] {
  return findAll(node, 'button').map((b) => textOf(b.props.children as ComponentChildren));
}

const looks = {
  versions: [
    { id: 'v1', name: 'female' },
    { id: 'v2', name: 'male' },
  ],
  finishes: [
    { id: 'f1', name: 'Brass', colour: '#c9a04a' },
    { id: 'f2', name: 'Iron', colour: '#5d6066' },
  ],
  colours: [
    { id: 'c1', name: 'deep red', colour: '#9e2b25' },
    { id: 'c2', name: 'navy blue', colour: '#24406b' },
  ],
};

const tin: MachineItem = {
  id: 'm1',
  name: 'Tin Jack',
  look: {
    version: 'v1',
    finish: 'f1',
    colour: 'c1',
    words: 'Brass · female · deep red',
    srgb: '#9e2b25',
  },
  atSea: true,
  apps: [
    {
      id: 'g1',
      name: 'Claude',
      returnHost: 'claude.ai',
      approved: 1,
      lastUsed: 2,
      ends: 3,
    },
    {
      id: 'g2',
      name: 'Old app',
      returnHost: 'example.com',
      approved: 1,
      lastUsed: 2,
      ends: 3,
      ended: true,
      endedHow: 'revoked',
    },
  ],
  token: null,
};

function request(over: Partial<RequestData> = {}): RequestData {
  return {
    client: { name: 'Claude', registered: false, vouchedBy: 'claude.ai' },
    returnHost: 'claude.ai',
    loopback: false,
    expires: 0,
    signedIn: null,
    looks,
    ...over,
  };
}

const noop = () => {};

function view(phase: Phase, over: Partial<ViewProps> = {}) {
  const props: ViewProps = {
    phase,
    blocked: null,
    problem: '',
    busy: false,
    choice: phase.kind === 'ready' ? firstChoice(phase.data) : MAKE,
    draft: drawMachine(looks, null, () => 0),
    copied: false,
    onContinue: noop,
    onChoose: noop,
    onApprove: noop,
    onCancel: noop,
    onCopy: noop,
    setName: noop,
    pick: noop,
    draw: noop,
    ...over,
  };
  return expand(ApproveView(props));
}

describe('the approval page', () => {
  test('before the passkey: the return host first, the app, what it may do, and the passkey', () => {
    const v = view({ kind: 'ready', data: request() });
    const text = textOf(v);
    const host = findAll(v, 'h1');
    expect(host).toHaveLength(1);
    expect(textOf(host[0]?.props.children as ComponentChildren)).toBe('claude.ai');
    expect(text.indexOf('claude.ai')).toBeLessThan(text.indexOf('Claude,'));
    expect(text).toContain('Claude, vouched for by claude.ai');
    expect(text).toContain('will sail one of your machine sailors and speak as it');
    expect(buttons(v)).toEqual(['Continue with your passkey', 'Cancel']);
    expect(text).not.toContain('Signed in as');
  });

  test('an app that registered itself only calls itself its name', () => {
    const text = textOf(
      view({
        kind: 'ready',
        data: request({ client: { name: 'Claude', registered: true } }),
      }),
    );
    expect(text).toContain('An app that calls itself Claude');
    expect(text).not.toContain('vouched');
  });

  test('a loopback redirect is an app on this computer, with a warning', () => {
    const v = view({ kind: 'ready', data: request({ returnHost: '', loopback: true }) });
    expect(textOf(findAll(v, 'h1')[0]?.props.children as ComponentChildren)).toBe(
      'an app on this computer',
    );
    expect(textOf(v)).toContain('Any page or program on this computer could pose as it');
  });

  test('signed in with machine sailors: each to choose, its look, at sea, its apps', () => {
    const data = request({
      signedIn: { name: 'Ann Bonny', machines: [tin], cap: 2, until: 0 },
    });
    const v = view({ kind: 'ready', data });
    const text = textOf(v);
    expect(text).toContain('Signed in as Ann Bonny');
    expect(text).toContain('Tin Jack');
    expect(text).toContain('Brass · female · deep red');
    expect(text).toContain('at sea');
    expect(text).toContain('Approved: Claude');
    expect(text).not.toContain('Old app');
    expect(text).toContain('Make a machine sailor');
    const radios = findAll(v, 'input').filter((i) => i.props.type === 'radio');
    expect(radios.map((r) => r.props.checked)).toEqual([true, false]);
    expect(buttons(v)).toEqual(['Approve', 'Cancel']);
    // The swatch is coloured by script, not by an inline style.
    expect(findAll(v, 'span').some((s) => s.props.style !== undefined)).toBe(false);
  });

  test('signed in with none: the form to make one, drawn already', () => {
    const data = request({ signedIn: { name: 'Ann Bonny', machines: [], cap: 1, until: 0 } });
    expect(firstChoice(data)).toBe(MAKE);
    const v = view({ kind: 'ready', data });
    const text = textOf(v);
    expect(text).toContain('Make a machine sailor');
    expect(text).toContain('Its name');
    expect(text).toContain('Brass · female · deep red');
    expect(buttons(v)).toEqual(['Draw another', 'Approve', 'Cancel']);
  });

  test('at the cap: no machine sailor to make', () => {
    const data = request({ signedIn: { name: 'Ann Bonny', machines: [tin], cap: 1, until: 0 } });
    expect(canMake(data)).toBe(false);
    const text = textOf(view({ kind: 'ready', data }));
    expect(text).not.toContain('Make a machine sailor');
    expect(text).toContain('You have as many machine sailors as you may.');
  });

  test('a window without passkeys: told so, with the link to copy', () => {
    const v = view({ kind: 'ready', data: request() }, { blocked: { app: null } });
    expect(textOf(v)).toContain('Passkeys don’t work in this window');
    expect(buttons(v)).toEqual(['Copy the link', 'Cancel']);
    const app = view(
      { kind: 'ready', data: request() },
      { blocked: { app: { app: 'Instagram', steps: 'Tap ⋯.' } }, copied: true },
    );
    expect(textOf(app)).toContain('Inside Instagram, passkeys don’t work.');
    expect(buttons(app)).toContain('Copied');
  });

  test('refusals in words, beside the field or the buttons', () => {
    const before = view(
      { kind: 'ready', data: request() },
      { problem: approveReasonText('refused') },
    );
    expect(textOf(before)).toContain(REASONS.refused);
    const data = request({ signedIn: { name: 'Ann', machines: [], cap: 1, until: 0 } });
    const form = view({ kind: 'ready', data }, { problem: approveReasonText('taken') });
    expect(textOf(form)).toContain(REASONS.taken);
    expect(textOf(view({ kind: 'ended', words: approveReasonText('again') }))).toContain(
      'Go back to your AI app and connect again.',
    );
    for (const code of [
      'again',
      'confirm',
      'add-passkey',
      'not-found',
      'window',
      'cap',
      'too-many-apps',
      'look',
    ]) {
      expect(approveReasonText(code), code).not.toBe('Something went wrong. Try again.');
    }
    expect(Object.keys(APPROVE_REASONS)).toContain('again');
  });
});

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A server and prompt standing in: each path answers as given, and the prompt as asked. */
function reach(
  answers: Record<string, () => Response>,
  prompt: () => Promise<unknown>,
  elapsed = 0,
): ApproveReach & { asked: string[]; bodies: unknown[] } {
  const asked: string[] = [];
  const bodies: unknown[] = [];
  let t = 0;
  const f: Fetch = async (input, init) => {
    asked.push(input);
    bodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
    const a = answers[input];
    if (a === undefined) {
      throw new TypeError('offline');
    }
    return a();
  };
  return {
    fetch: f,
    prompt: {
      create: () => Promise.reject(new Error('not asked')),
      get: () => prompt(),
    },
    pkc: undefined,
    now: () => {
      const v = t;
      t += elapsed;
      return v;
    },
    asked,
    bodies,
  };
}

const options = { publicKey: { challenge: 'AAAA', rpId: 'localhost' } };
const credential = {
  id: 'x',
  rawId: new Uint8Array([1]).buffer,
  type: 'public-key',
  response: { clientDataJSON: new Uint8Array([2]).buffer },
};
const notAllowed = () =>
  Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }));

describe('the approval page’s calls', () => {
  test('the request read, or none to go on with', async () => {
    const r = reach({ '/oauth/request': () => answer(200, request()) }, notAllowed);
    expect(await readRequest(r.fetch)).toEqual({ ok: true, value: request() });
    const none = reach({ '/oauth/request': () => answer(409, { error: 'again' }) }, notAllowed);
    expect(await readRequest(none.fetch)).toEqual({ ok: false, reason: 'again' });
    expect(await readRequest(reach({}, notAllowed).fetch)).toEqual({
      ok: false,
      reason: 'offline',
    });
  });

  test('the passkey: begun, answered on the modal prompt, finished', async () => {
    const signedIn = request({ signedIn: { name: 'Ann', machines: [], cap: 1, until: 9 } });
    let asked: unknown;
    const r = reach(
      {
        '/oauth/approve/begin': () => answer(200, options),
        '/oauth/approve/finish': () => answer(200, signedIn),
      },
      async () => credential,
    );
    r.prompt.get = async (o) => {
      asked = o;
      return credential;
    };
    expect(await continueWithPasskey(r)).toEqual({ ok: true, value: signedIn });
    expect(r.asked).toEqual(['/oauth/approve/begin', '/oauth/approve/finish']);
    // Never autofill: no mediation asked for.
    expect(asked).not.toHaveProperty('mediation');
    expect(r.bodies[1]).toMatchObject({ id: 'x', type: 'public-key' });
  });

  test('a prompt refused at once is this window; one closed later says nothing', async () => {
    const begin = { '/oauth/approve/begin': () => answer(200, options) };
    expect(await continueWithPasskey(reach(begin, notAllowed, 50))).toEqual({
      ok: false,
      reason: 'window',
    });
    expect(await continueWithPasskey(reach(begin, notAllowed, AT_ONCE + 1))).toEqual({
      ok: false,
      reason: 'cancelled',
    });
  });

  test('the server’s refusals pass through as their codes', async () => {
    for (const [status, code] of [
      [400, 'refused'],
      [403, 'add-passkey'],
      [404, 'unknown-passkey'],
      [409, 'again'],
    ] as const) {
      const r = reach(
        {
          '/oauth/approve/begin': () => answer(200, options),
          '/oauth/approve/finish': () => answer(status, { error: code }),
        },
        async () => credential,
      );
      expect(await continueWithPasskey(r)).toEqual({ ok: false, reason: code });
    }
  });

  test('approved for one, or one made; denied; each given the way back', async () => {
    const r = reach(
      {
        '/oauth/approve': () => answer(200, { redirect: 'https://claude.ai/cb?code=c' }),
        '/oauth/deny': () => answer(200, { redirect: 'https://claude.ai/cb?error=access_denied' }),
      },
      notAllowed,
    );
    expect(await approve(r.fetch, 'm1')).toEqual({
      ok: true,
      value: 'https://claude.ai/cb?code=c',
    });
    const d = { ...drawMachine(looks, null, () => 0), name: 'Tin Jack' };
    await approve(r.fetch, d);
    expect(r.bodies).toEqual([
      { machine: 'm1' },
      { make: { name: 'Tin Jack', version: 'v1', finish: 'f1', colour: 'c1' } },
    ]);
    expect(await deny(r.fetch)).toEqual({
      ok: true,
      value: 'https://claude.ai/cb?error=access_denied',
    });
    const cap = reach({ '/oauth/approve': () => answer(409, { error: 'cap' }) }, notAllowed);
    expect(await approve(cap.fetch, d)).toEqual({ ok: false, reason: 'cap' });
  });
});
