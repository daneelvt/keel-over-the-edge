// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import type { Fetch } from '../src/account/me';
import { approveReasonText, SAILOR_STOPPED } from '../src/account/reasons';
import { type ApproveReach, approve, continueWithPasskey } from './page';

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function reach(answers: Record<string, () => Response>): ApproveReach {
  const f: Fetch = async (input) => {
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
      get: async () => ({
        id: 'x',
        rawId: new Uint8Array([1]).buffer,
        type: 'public-key',
        response: { clientDataJSON: new Uint8Array([2]).buffer },
      }),
    },
    pkc: undefined,
    now: () => 0,
  };
}

test('stopped at the passkey’s step is the player’s own sailor; at the approval, the machine sailor chosen', async () => {
  const r = reach({
    '/oauth/approve/begin': () => answer(200, { publicKey: { challenge: 'AAAA' } }),
    '/oauth/approve/finish': () => answer(403, { error: 'stopped' }),
    '/oauth/approve': () => answer(409, { error: 'stopped' }),
  });
  expect(await continueWithPasskey(r)).toEqual({ ok: false, reason: SAILOR_STOPPED });
  expect(approveReasonText(SAILOR_STOPPED)).toBe(
    'This sailor has been stopped. It cannot sign in or sail.',
  );
  expect(await approve(r.fetch, 'm1')).toEqual({ ok: false, reason: 'stopped' });
  expect(approveReasonText('stopped')).toBe('That machine sailor has been stopped.');
});
