// SPDX-License-Identifier: AGPL-3.0-only

// An AI app's sign-in, against keel and its database: the test plays the
// app, registering itself and sending the browser to the authorization
// endpoint with PKCE; the approval page shows where the sign-in returns,
// takes the player's passkey on the browser's prompt (Playwright's virtual
// authenticator), makes a machine sailor, and approves; and the browser is
// sent back to the app with the code, its state and the issuer. A form
// draws nothing, so one back end is enough.

import { createHash, randomBytes } from 'node:crypto';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { holdPasskeys, sailor } from './helpers';

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'a form: one back end is enough');
});

/** The app's redirect, on this computer: nothing listens there, the test answers it. */
const redirect = 'http://localhost:47615/callback';

/** Registers an app as one would (RFC 7591): its client ID. */
async function register(request: APIRequestContext): Promise<string> {
  const res = await request.post('/oauth/register', {
    data: { redirect_uris: [redirect], client_name: 'Test app' },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

test('an AI app approved: the passkey, a machine sailor made, and back to the app with the code', async ({
  context,
  page,
  baseURL,
}) => {
  const made = await sailor(context, 'Approver');
  await holdPasskeys(context, made.passkey);
  const clientId = await register(context.request);
  const { challenge } = pkce();
  const state = randomBytes(12).toString('base64url');
  const origin = new URL(baseURL ?? '').origin;

  // The app's callback, answered by the test.
  let back: URL | null = null;
  await page.route(`${redirect}**`, async (route) => {
    back = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'back at the app' });
  });

  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${origin}/mcp`,
  });
  await page.goto(`/oauth/authorize?${q}`);
  // Where the sign-in returns, first: an app on this computer, with the warning.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('an app on this computer');
  await expect(page.getByText('could pose as it')).toBeVisible();
  await expect(page.getByText('An app that calls itself Test app')).toBeVisible();
  await expect(
    page.getByText('will sail one of your machine sailors and speak as it'),
  ).toBeVisible();

  const finish = page.waitForResponse((r) => r.url().endsWith('/oauth/approve/finish'));
  await page.getByRole('button', { name: 'Continue with your passkey' }).click();
  expect((await finish).status()).toBe(200);
  await expect(page.getByText(`Signed in as ${made.name}`)).toBeVisible();

  // No machine sailor yet: the form, its look drawn already.
  const name = `Tin ${Date.now() % 10_000_000}`;
  await expect(page.getByRole('radio', { name: 'Make a machine sailor' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Draw another' })).toBeVisible();
  // A name too short is refused in words, beside the field.
  await page.getByLabel('Its name').fill('Ti');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('That name is too short')).toBeVisible();
  await page.getByLabel('Its name').fill(name);
  await page.getByRole('button', { name: 'Approve' }).click();

  await expect.poll(() => back?.pathname ?? '').toBe('/callback');
  const params = (back as URL | null)?.searchParams;
  expect(params?.get('code')).toBeTruthy();
  expect(params?.get('state')).toBe(state);
  expect(params?.get('iss')).toBe(origin);
  expect(params?.get('error')).toBeNull();

  // The machine sailor is the player's, the app approved for it.
  const list = await context.request.get('/api/machines');
  expect(list.status()).toBe(200);
  const body = (await list.json()) as {
    machines: { name: string; apps: { name: string; loopback?: boolean }[] }[];
  };
  const tin = body.machines.find((m) => m.name === name);
  expect(tin?.apps).toEqual([expect.objectContaining({ name: 'Test app', loopback: true })]);

  // The request is spent: the page, opened again, says to connect again.
  await page.goto('/approve.html');
  await expect(page.getByText('Go back to your AI app and connect again.')).toBeVisible();
});

test('an AI app turned down: back to the app with access_denied', async ({ context, page }) => {
  const clientId = await register(context.request);
  let back: URL | null = null;
  await page.route(`${redirect}**`, async (route) => {
    back = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'back at the app' });
  });
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    state: 'turned-down',
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
  });
  await page.goto(`/oauth/authorize?${q}`);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => back?.pathname ?? '').toBe('/callback');
  const params = (back as URL | null)?.searchParams;
  expect(params?.get('error')).toBe('access_denied');
  expect(params?.get('state')).toBe('turned-down');
  expect(params?.get('code')).toBeNull();
});
