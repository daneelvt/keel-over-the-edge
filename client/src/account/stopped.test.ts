// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { type Machine, stoppedOn } from './machines';
import type { Fetch } from './me';
import { type Reach, signIn, useRecoveryCode } from './passkeys';
import {
  approveReasonText,
  MACHINE_REASONS,
  machineReasonText,
  REASONS,
  reasonText,
  SAILOR_STOPPED,
} from './reasons';
import { quiet } from './start';

const SAILOR = 'This sailor has been stopped. It cannot sign in or sail.';
const MACHINE = 'That machine sailor has been stopped.';

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A server answering as told, and a browser that remembers what it was told to forget. */
function stand(answers: Record<string, () => Response>): Reach & { forgotten: string[] } {
  const forgotten: string[] = [];
  const f: Fetch = async (url) => {
    const a = answers[url];
    if (a === undefined) {
      throw new TypeError('offline');
    }
    return a();
  };
  return {
    fetch: f,
    prompt: {
      create: async () => Promise.reject(new Error('no create')),
      get: async () => ({ id: 'AQI', type: 'public-key', toJSON: () => ({ id: 'AQI' }) }),
    },
    pkc: {
      signalUnknownCredential: async (o: { credentialId: string }) => {
        forgotten.push(o.credentialId);
      },
    },
    forgotten,
  };
}

describe('a sailor stopped', () => {
  test('is told so in its player’s words, at sign-in and with the recovery code', async () => {
    expect(REASONS.stopped).toBe(SAILOR);
    expect(reasonText('stopped')).toBe(SAILOR);
    const r = stand({
      '/signin/begin': () => answer(200, { publicKey: { challenge: 'AQID' } }),
      '/signin/finish': () => answer(403, { error: 'stopped' }),
      '/signin/begin?mediation=conditional': () =>
        answer(200, { publicKey: { challenge: 'AQID' } }),
      '/signin/finish?mediation=conditional': () => answer(403, { error: 'stopped' }),
      '/recovery': () => answer(403, { error: 'stopped' }),
    });
    expect(await signIn(false, undefined, r)).toEqual({ ok: false, reason: 'stopped' });
    expect(await signIn(true, undefined, r)).toEqual({ ok: false, reason: 'stopped' });
    expect(await useRecoveryCode('7KQ2', r)).toEqual({ ok: false, reason: 'stopped' });
    // The passkey stands: its sailor is stopped, not gone.
    expect(r.forgotten).toEqual([]);
  });

  test('is said on the start screen, by autofill as by the button', () => {
    expect(quiet('stopped', true)).toBe(false);
    expect(quiet('stopped', false)).toBe(false);
  });

  test('a machine sailor stopped has words of its own; on the approval page too, but for the passkey’s step', () => {
    expect(MACHINE_REASONS.stopped).toBe(MACHINE);
    expect(machineReasonText('stopped')).toBe(MACHINE);
    expect(approveReasonText('stopped')).toBe(MACHINE);
    expect(approveReasonText(SAILOR_STOPPED)).toBe(SAILOR);
  });

  test('a machine sailor stopped says when, on the day as the page writes it', () => {
    const now = new Date(2026, 9, 26, 12).getTime();
    const m = {
      id: 'm',
      name: 'Tin Jack',
      apps: [],
      token: null,
      atSea: false,
    } as unknown as Machine;
    expect(stoppedOn({ ...m, stopped: now - 3_600_000 }, now)).toBe('Stopped on 26 October');
    expect(stoppedOn({ ...m, stopped: new Date(2025, 11, 2, 12).getTime() }, now)).toBe(
      'Stopped on 2 December 2025',
    );
    expect(stoppedOn({ ...m, stopped: 0 }, now)).toBe('');
    expect(stoppedOn(m, now)).toBe('');
  });
});
