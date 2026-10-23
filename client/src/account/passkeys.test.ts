// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import type { Fetch } from './me';
import {
  answerJSON,
  codeForm,
  creationOptions,
  fromBase64url,
  makeSailor,
  type Prompt,
  promptFailure,
  type Reach,
  requestOptions,
  signIn,
  toBase64url,
} from './passkeys';
import { quiet } from './start';

const bytes = (...b: number[]) => new Uint8Array(b);

// The server's options, as go-webauthn writes them.
const creation = {
  publicKey: {
    rp: { id: 'keelovertheedge.com', name: 'Keel Over the Edge' },
    user: { id: 'AQID_w', name: 'Ann Bonny', displayName: 'Ann Bonny' },
    challenge: 'q83vEjRWeJA',
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    excludeCredentials: [{ type: 'public-key', id: '_-8' }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    attestation: 'none',
    extensions: { credProps: true },
    timeout: 300000,
  },
};
const request = {
  publicKey: {
    challenge: 'q83vEjRWeJA',
    rpId: 'keelovertheedge.com',
    allowCredentials: [{ type: 'public-key', id: '_-8' }],
    userVerification: 'required',
  },
  mediation: 'conditional',
};

describe('base64url', () => {
  test('both ways, without padding, with - and _', () => {
    expect(toBase64url(bytes(1, 2, 3, 255))).toBe('AQID_w');
    expect(toBase64url(bytes(255, 239))).toBe('_-8');
    expect(new Uint8Array(fromBase64url('AQID_w'))).toEqual(bytes(1, 2, 3, 255));
    expect(new Uint8Array(fromBase64url('_-8'))).toEqual(bytes(255, 239));
    expect(toBase64url(new Uint8Array(0))).toBe('');
  });
});

describe("the server's options", () => {
  test('by hand, without the browser’s helpers', () => {
    const o = creationOptions(creation, undefined) as {
      challenge: ArrayBuffer;
      user: { id: ArrayBuffer; name: string };
      excludeCredentials: { id: ArrayBuffer }[];
      rp: { id: string };
      extensions: unknown;
    };
    expect(new Uint8Array(o.user.id)).toEqual(bytes(1, 2, 3, 255));
    expect(toBase64url(o.challenge)).toBe('q83vEjRWeJA');
    expect(new Uint8Array(o.excludeCredentials[0]?.id as ArrayBuffer)).toEqual(bytes(255, 239));
    expect(o.rp.id).toBe('keelovertheedge.com');
    expect(o.user.name).toBe('Ann Bonny');
    expect(o.extensions).toEqual({ credProps: true });
    const r = requestOptions(request, undefined) as {
      challenge: ArrayBuffer;
      allowCredentials: { id: ArrayBuffer }[];
      userVerification: string;
    };
    expect(toBase64url(r.challenge)).toBe('q83vEjRWeJA');
    expect(new Uint8Array(r.allowCredentials[0]?.id as ArrayBuffer)).toEqual(bytes(255, 239));
    expect(r.userVerification).toBe('required');
    // A discoverable sign-in names no passkey.
    const open = requestOptions({ publicKey: { challenge: 'AQID' } }, undefined) as object;
    expect('allowCredentials' in open).toBe(false);
  });

  test("with the browser's helpers when it has them", () => {
    const seen: unknown[] = [];
    const pkc = {
      parseCreationOptionsFromJSON: (o: unknown) => {
        seen.push(o);
        return 'parsed creation';
      },
      parseRequestOptionsFromJSON: (o: unknown) => {
        seen.push(o);
        return 'parsed request';
      },
    };
    expect(creationOptions(creation, pkc)).toBe('parsed creation');
    expect(requestOptions(request, pkc)).toBe('parsed request');
    expect(seen).toEqual([creation.publicKey, request.publicKey]);
  });
});

describe('the browser’s answer', () => {
  test('by its toJSON() when it has one', () => {
    const json = { id: 'x', type: 'public-key' };
    expect(
      answerJSON({
        id: 'x',
        rawId: new ArrayBuffer(1),
        type: 'public-key',
        response: { clientDataJSON: new ArrayBuffer(1) },
        toJSON: () => json,
      }),
    ).toBe(json);
  });

  test('by hand: a passkey made, and one used', () => {
    const made = answerJSON({
      id: 'AQI',
      rawId: bytes(1, 2).buffer,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: bytes(123, 125).buffer,
        attestationObject: bytes(160).buffer,
        getTransports: () => ['internal', 'hybrid'],
      },
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
    });
    expect(made).toEqual({
      id: 'AQI',
      rawId: 'AQI',
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: 'e30',
        attestationObject: 'oA',
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: { credProps: { rk: true } },
    });
    const used = answerJSON({
      id: 'AQI',
      rawId: bytes(1, 2).buffer,
      type: 'public-key',
      response: {
        clientDataJSON: bytes(123, 125).buffer,
        authenticatorData: bytes(1).buffer,
        signature: bytes(2).buffer,
        userHandle: bytes(3).buffer,
      },
    });
    expect(used.response).toEqual({
      clientDataJSON: 'e30',
      authenticatorData: 'AQ',
      signature: 'Ag',
      userHandle: 'Aw',
    });
    expect(used.clientExtensionResults).toEqual({});
  });
});

function answer(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

/** A server and a prompt that answer as told, and remember what they were asked. */
function stand(
  answers: Record<string, () => Response>,
  prompt: Partial<Prompt>,
): Reach & { asked: string[]; sent: unknown[] } {
  const asked: string[] = [];
  const sent: unknown[] = [];
  const f: Fetch = async (url, init) => {
    asked.push(url);
    if (init?.body !== undefined) {
      sent.push(JSON.parse(String(init.body)));
    }
    const a = answers[url];
    if (a === undefined) {
      throw new TypeError('offline');
    }
    return a();
  };
  return {
    fetch: f,
    prompt: {
      create: prompt.create ?? (async () => Promise.reject(new Error('no create'))),
      get: prompt.get ?? (async () => Promise.reject(new Error('no get'))),
    },
    pkc: undefined,
    asked,
    sent,
  };
}

const madeCred = {
  id: 'AQI',
  type: 'public-key',
  toJSON: () => ({ id: 'AQI', type: 'public-key', response: {} }),
};

function rejection(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

describe('making a sailor', () => {
  test('begun, made by the prompt, finished: the recovery code comes with it', async () => {
    const r = stand(
      {
        '/account/begin': () => answer(200, creation),
        '/account/finish': () =>
          answer(201, { name: 'Ann Bonny', look: 'a', recoveryCode: '7KQ2-M9XD' }),
      },
      { create: async () => madeCred },
    );
    const made = await makeSailor('Ann Bonny', 'a', r);
    expect(made).toEqual({
      ok: true,
      value: {
        me: { name: 'Ann Bonny', look: 'a', kind: 'human', noticesOff: [] },
        recoveryCode: '7KQ2-M9XD',
      },
    });
    expect(r.asked).toEqual(['/account/begin', '/account/finish']);
    expect(r.sent).toEqual([{ name: 'Ann Bonny', look: 'a' }, madeCred.toJSON()]);
  });

  test('a name refused before the prompt; a prompt closed; a name taken meanwhile', async () => {
    let prompted = 0;
    const refused = stand(
      { '/account/begin': () => answer(422, { error: 'words' }) },
      {
        create: async () => {
          prompted++;
          return madeCred;
        },
      },
    );
    expect(await makeSailor('Harbourmaster', 'a', refused)).toEqual({ ok: false, reason: 'words' });
    expect(prompted).toBe(0);

    const closed = stand(
      { '/account/begin': () => answer(200, creation) },
      { create: async () => Promise.reject(rejection('NotAllowedError')) },
    );
    expect(await makeSailor('Ann Bonny', 'a', closed)).toEqual({ ok: false, reason: 'cancelled' });
    expect(closed.asked).toEqual(['/account/begin']);

    const taken = stand(
      {
        '/account/begin': () => answer(200, creation),
        '/account/finish': () =>
          answer(422, { error: 'taken', unknown: { rpId: 'x', credentialId: 'AQI' } }),
      },
      { create: async () => madeCred },
    );
    expect(await makeSailor('Ann Bonny', 'a', taken)).toEqual({ ok: false, reason: 'taken' });
    expect(await makeSailor('Ann', 'a', stand({}, {}))).toEqual({ ok: false, reason: 'offline' });
  });
});

describe('signing in', () => {
  test('autofill: asked for with mediation, the browser’s refusal at once is quiet', async () => {
    const asks: { mediation?: string; signal?: AbortSignal }[] = [];
    const r = stand(
      { '/signin/begin?mediation=conditional': () => answer(200, request) },
      {
        get: async (o) => {
          asks.push(o);
          throw rejection('NotAllowedError');
        },
      },
    );
    const ctl = new AbortController();
    const res = await signIn(true, ctl.signal, r);
    expect(res).toEqual({ ok: false, reason: 'cancelled' });
    expect(asks[0]?.mediation).toBe('conditional');
    expect(asks[0]?.signal).toBe(ctl.signal);
    expect(r.asked).toEqual(['/signin/begin?mediation=conditional']);
    expect(quiet('cancelled', true)).toBe(true);
    expect(quiet('passkey-failed', true)).toBe(true);
    expect(quiet('unavailable', true)).toBe(true);
    // A passkey chosen and refused is said, autofill or not.
    expect(quiet('unknown-passkey', true)).toBe(false);
    expect(quiet('refused', true)).toBe(false);
    expect(quiet('unavailable', false)).toBe(false);
    expect(quiet('cancelled', false)).toBe(true);
  });

  test('signed in, the recovery notice carried; an unknown passkey said', async () => {
    const r = stand(
      {
        '/signin/begin': () => answer(200, { publicKey: { challenge: 'AQID' } }),
        '/signin/finish': () =>
          answer(200, {
            name: 'Ann Bonny',
            look: 'a',
            recovered: 1761177600000,
            accepted: { rpId: 'x', userId: 'AQ', allAcceptedCredentialIds: ['AQI'] },
          }),
      },
      { get: async () => madeCred },
    );
    const res = await signIn(false, undefined, r);
    expect(res.ok && res.value.recovered).toBe(1761177600000);
    expect(res.ok && res.value.me.name).toBe('Ann Bonny');

    const gone = stand(
      {
        '/signin/begin': () => answer(200, { publicKey: { challenge: 'AQID' } }),
        '/signin/finish': () =>
          answer(404, { error: 'unknown-passkey', unknown: { rpId: 'x', credentialId: 'AQI' } }),
      },
      { get: async () => madeCred },
    );
    expect(await signIn(false, undefined, gone)).toEqual({ ok: false, reason: 'unknown-passkey' });
  });

  test("the prompt's failures by name", () => {
    expect(promptFailure(rejection('NotAllowedError'))).toBe('cancelled');
    expect(promptFailure(rejection('AbortError'))).toBe('cancelled');
    expect(promptFailure(rejection('InvalidStateError'))).toBe('passkey-here');
    expect(promptFailure(rejection('SecurityError'))).toBe('passkey-domain');
    expect(promptFailure(rejection('NotSupportedError'))).toBe('no-passkeys');
    expect(promptFailure(new TypeError('?'))).toBe('passkey-failed');
    expect(promptFailure(null)).toBe('passkey-failed');
  });
});

describe('the recovery code as typed', () => {
  test('capitals, I and L as 1, O as 0, grouped by four, nothing else', () => {
    expect(codeForm('7kq2m9xd0f3hrb6cz1wn5tpe4g')).toBe('7KQ2-M9XD-0F3H-RB6C-Z1WN-5TPE-4G');
    expect(codeForm('7KQ2-M9XD-0F3H-RB6C-Z1WN-5TPE-4G')).toBe('7KQ2-M9XD-0F3H-RB6C-Z1WN-5TPE-4G');
    expect(codeForm(' 7kq2 m9xd ')).toBe('7KQ2-M9XD');
    expect(codeForm('iloO')).toBe('1100');
    expect(codeForm('u!@#')).toBe('');
    expect(codeForm('7KQ2')).toBe('7KQ2');
    expect(codeForm('7KQ2M')).toBe('7KQ2-M');
    // Never longer than a code.
    expect(codeForm('Z'.repeat(40)).replace(/-/g, '')).toHaveLength(26);
  });
});
