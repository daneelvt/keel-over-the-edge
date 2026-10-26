// SPDX-License-Identifier: AGPL-3.0-only

// The passkey ceremonies in the browser. The server begins each one and
// sends its options as JSON (WebAuthn Level 3's
// PublicKeyCredentialCreationOptionsJSON or ...RequestOptionsJSON, inside
// {"publicKey": …}); the browser's prompt answers; the answer goes back as
// JSON, as PublicKeyCredential's toJSON() writes it, and the server checks
// it. Browsers without the JSON helpers (before Chrome 129, Firefox 119,
// Safari 18.4) are given the same through base64url by hand.
//
// The session cookie is the server's alone (HttpOnly): an answer carries
// the sailor, and for a new account its recovery code, never a token.

import type { Fetch, Me } from './me';

/** base64url without padding, as WebAuthn's JSON forms write bytes. */
export function toBase64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const c of b) {
    s += String.fromCharCode(c);
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out.buffer;
}

type JSONObject = Record<string, unknown>;

/** The browser's PublicKeyCredential, as far as the ceremonies use it. */
interface PKC {
  parseCreationOptionsFromJSON?: (o: JSONObject) => unknown;
  parseRequestOptionsFromJSON?: (o: JSONObject) => unknown;
  isConditionalMediationAvailable?: () => Promise<boolean>;
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
  getClientCapabilities?: () => Promise<Record<string, boolean>>;
  signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void>;
  signalAllAcceptedCredentials?: (o: {
    rpId: string;
    userId: string;
    allAcceptedCredentialIds: string[];
  }) => Promise<void>;
}

/** The browser's PublicKeyCredential, or undefined where there is none. */
export function publicKeyCredential(): PKC | undefined {
  return (globalThis as unknown as { PublicKeyCredential?: PKC }).PublicKeyCredential;
}

function withIds(list: unknown): unknown {
  if (!Array.isArray(list)) {
    return list;
  }
  return list.map((d: JSONObject) => ({ ...d, id: fromBase64url(String(d.id)) }));
}

/** A server's creation options as navigator.credentials.create() takes them. */
export function creationOptions(json: JSONObject, pkc: PKC | undefined = publicKeyCredential()) {
  const o = json.publicKey as JSONObject;
  if (pkc?.parseCreationOptionsFromJSON) {
    return pkc.parseCreationOptionsFromJSON(o);
  }
  const user = o.user as JSONObject;
  return {
    ...o,
    challenge: fromBase64url(String(o.challenge)),
    user: { ...user, id: fromBase64url(String(user.id)) },
    ...(o.excludeCredentials !== undefined
      ? { excludeCredentials: withIds(o.excludeCredentials) }
      : {}),
  };
}

/** A server's request options as navigator.credentials.get() takes them. */
export function requestOptions(json: JSONObject, pkc: PKC | undefined = publicKeyCredential()) {
  const o = json.publicKey as JSONObject;
  if (pkc?.parseRequestOptionsFromJSON) {
    return pkc.parseRequestOptionsFromJSON(o);
  }
  return {
    ...o,
    challenge: fromBase64url(String(o.challenge)),
    ...(o.allowCredentials !== undefined ? { allowCredentials: withIds(o.allowCredentials) } : {}),
  };
}

/** A credential the browser answered with, as its toJSON() writes it. */
interface Answered {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  authenticatorAttachment?: string | null;
  response: {
    clientDataJSON: ArrayBuffer;
    attestationObject?: ArrayBuffer;
    authenticatorData?: ArrayBuffer;
    signature?: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
    getTransports?: () => string[];
  };
  getClientExtensionResults?: () => JSONObject;
  toJSON?: () => JSONObject;
}

/** A credential the browser answered with, as JSON for the server. */
export function answerJSON(cred: Answered): JSONObject {
  if (typeof cred.toJSON === 'function') {
    return cred.toJSON();
  }
  const r = cred.response;
  const response: JSONObject = { clientDataJSON: toBase64url(r.clientDataJSON) };
  if (r.attestationObject !== undefined) {
    response.attestationObject = toBase64url(r.attestationObject);
    response.transports = r.getTransports?.() ?? [];
  }
  if (r.authenticatorData !== undefined) {
    response.authenticatorData = toBase64url(r.authenticatorData);
  }
  if (r.signature !== undefined) {
    response.signature = toBase64url(r.signature);
  }
  if (r.userHandle != null) {
    response.userHandle = toBase64url(r.userHandle);
  }
  return {
    id: cred.id,
    rawId: toBase64url(cred.rawId),
    type: cred.type,
    response,
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    ...(cred.authenticatorAttachment
      ? { authenticatorAttachment: cred.authenticatorAttachment }
      : {}),
  };
}

/** The browser's passkey prompt: navigator.credentials, so tests can stand in for it. */
export interface Prompt {
  create(options: { publicKey: unknown }): Promise<unknown>;
  get(options: { publicKey: unknown; mediation?: string; signal?: AbortSignal }): Promise<unknown>;
}

/** What the ceremonies reach: the server, and the browser's prompt. */
export interface Reach {
  fetch: Fetch;
  prompt: Prompt;
  pkc: PKC | undefined;
}

function browserReach(): Reach {
  return {
    fetch: (input, init) => fetch(input, init),
    prompt: navigator.credentials as unknown as Prompt,
    pkc: publicKeyCredential(),
  };
}

/** A server's answer: its status, and its JSON, or null. */
export interface Answer {
  status: number;
  body: JSONObject | null;
}

/** POSTs JSON to one of the account's routes; the status is 0 when the server cannot be reached. */
export async function call(f: Fetch, path: string, body?: unknown): Promise<Answer> {
  let res: Response;
  try {
    res = await f(path, {
      method: 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { status: 0, body: null };
  }
  let parsed: JSONObject | null = null;
  try {
    parsed = (await res.json()) as JSONObject;
  } catch {
    // No body (204), or not the server's JSON: a proxy's page, say.
  }
  return { status: res.status, body: parsed };
}

/** A reason code from an answer that is not the one hoped for. */
export function reasonOf(a: Answer): string {
  if (a.status === 0) {
    return 'offline';
  }
  return typeof a.body?.error === 'string' ? a.body.error : 'unavailable';
}

/** The ways a ceremony with the prompt ends. */
export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string }
  /** The player closed the prompt, or it was aborted: nothing to say. */
  | { ok: false; reason: 'cancelled' };

/** A prompt's failure: cancelled when the player closed it, or why it failed. */
export function promptFailure(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'AbortError':
      return 'cancelled';
    case 'InvalidStateError':
      // The device already holds a passkey of this account.
      return 'passkey-here';
    case 'SecurityError':
      return 'passkey-domain';
    case 'NotSupportedError':
      return 'no-passkeys';
  }
  return 'passkey-failed';
}

/** The Signal API's argument for a passkey the server knows of no account for. */
export interface Unknown {
  rpId: string;
  credentialId: string;
}

/** The Signal API's argument listing an account's passkeys. */
export interface Accepted {
  rpId: string;
  userId: string;
  allAcceptedCredentialIds: string[];
}

/** Tells the browser to forget a passkey, where it can be told. */
export async function signalUnknown(u: unknown, pkc = publicKeyCredential()): Promise<void> {
  const v = u as Partial<Unknown> | null;
  if (pkc?.signalUnknownCredential && v?.rpId && v.credentialId) {
    try {
      await pkc.signalUnknownCredential({ rpId: v.rpId, credentialId: v.credentialId });
    } catch {
      // Advisory: the game works without it.
    }
  }
}

/** Tells the browser which of the account's passkeys stand, where it can be told. */
export async function signalAccepted(a: unknown, pkc = publicKeyCredential()): Promise<void> {
  const v = a as Partial<Accepted> | null;
  if (pkc?.signalAllAcceptedCredentials && v?.rpId && v.userId && v.allAcceptedCredentialIds) {
    try {
      await pkc.signalAllAcceptedCredentials({
        rpId: v.rpId,
        userId: v.userId,
        allAcceptedCredentialIds: v.allAcceptedCredentialIds,
      });
    } catch {
      // Advisory.
    }
  }
}

function meOf(body: JSONObject | null): Me {
  return {
    name: String(body?.name ?? ''),
    look: String(body?.look ?? ''),
    kind: 'human',
    noticesOff: [],
  };
}

/** A new sailor made: who, and the recovery code, shown once. */
export interface Made {
  me: Me;
  recoveryCode: string;
}

/**
 * Makes a sailor: the name and look checked by the server, the passkey made
 * by the browser's prompt, and the account made with it.
 */
export async function makeSailor(
  name: string,
  look: string,
  reach: Reach = browserReach(),
): Promise<Outcome<Made>> {
  const begun = await call(reach.fetch, '/account/begin', { name, look });
  if (begun.status !== 200 || begun.body === null) {
    return { ok: false, reason: reasonOf(begun) };
  }
  let cred: unknown;
  try {
    cred = await reach.prompt.create({ publicKey: creationOptions(begun.body, reach.pkc) });
  } catch (err) {
    return { ok: false, reason: promptFailure(err) };
  }
  const done = await call(reach.fetch, '/account/finish', answerJSON(cred as Answered));
  if (done.status !== 201) {
    if (done.body?.unknown !== undefined) {
      // The name was taken while the prompt was open: the passkey just
      // made names no account.
      void signalUnknown(done.body.unknown, reach.pkc);
    }
    return { ok: false, reason: reasonOf(done) };
  }
  return {
    ok: true,
    value: { me: meOf(done.body), recoveryCode: String(done.body?.recoveryCode) },
  };
}

/** A sailor signed in, and when its recovery code was used since the last sign-in, ms, or 0. */
export interface SignedIn {
  me: Me;
  recovered: number;
}

/**
 * Signs in with a passkey: on the browser's own prompt, which also reaches
 * another device by its QR code, or, conditional, offered as the name field
 * is touched (autofill), until signal aborts it.
 */
export async function signIn(
  conditional: boolean,
  signal?: AbortSignal,
  reach: Reach = browserReach(),
): Promise<Outcome<SignedIn>> {
  const q = conditional ? '?mediation=conditional' : '';
  const begun = await call(reach.fetch, `/signin/begin${q}`);
  if (begun.status !== 200 || begun.body === null) {
    return { ok: false, reason: reasonOf(begun) };
  }
  let cred: unknown;
  try {
    cred = await reach.prompt.get({
      publicKey: requestOptions(begun.body, reach.pkc),
      ...(conditional ? { mediation: 'conditional' } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (err) {
    return { ok: false, reason: promptFailure(err) };
  }
  if (cred === null) {
    return { ok: false, reason: 'cancelled' };
  }
  const done = await call(reach.fetch, `/signin/finish${q}`, answerJSON(cred as Answered));
  if (done.status !== 200) {
    if (done.body?.unknown !== undefined) {
      // A passkey of a deleted account, or one removed.
      void signalUnknown(done.body.unknown, reach.pkc);
    }
    return { ok: false, reason: reasonOf(done) };
  }
  void signalAccepted(done.body?.accepted, reach.pkc);
  return {
    ok: true,
    value: { me: meOf(done.body), recovered: Number(done.body?.recovered ?? 0) },
  };
}

/** Signs in with the recovery code: the session made may only add a passkey. */
export async function useRecoveryCode(
  code: string,
  reach: Reach = browserReach(),
): Promise<Outcome<Me>> {
  const a = await call(reach.fetch, '/recovery', { code });
  if (a.status !== 200) {
    return { ok: false, reason: reasonOf(a) };
  }
  return { ok: true, value: meOf(a.body) };
}

/** A passkey as the account page lists it. */
export interface PasskeyItem {
  id: string;
  madeOn: string;
  created: number;
  lastUsed: number;
  synced: boolean;
}

/** Adds a passkey to the account: after the recovery code, a new code comes with it. */
export async function addPasskey(
  reach: Reach = browserReach(),
): Promise<Outcome<{ passkeys: PasskeyItem[]; recoveryCode: string }>> {
  const begun = await call(reach.fetch, '/api/account/passkeys/begin');
  if (begun.status !== 200 || begun.body === null) {
    return { ok: false, reason: reasonOf(begun) };
  }
  let cred: unknown;
  try {
    cred = await reach.prompt.create({ publicKey: creationOptions(begun.body, reach.pkc) });
  } catch (err) {
    return { ok: false, reason: promptFailure(err) };
  }
  const done = await call(
    reach.fetch,
    '/api/account/passkeys/finish',
    answerJSON(cred as Answered),
  );
  if (done.status !== 201) {
    return { ok: false, reason: reasonOf(done) };
  }
  return {
    ok: true,
    value: {
      passkeys: (done.body?.passkeys as PasskeyItem[]) ?? [],
      recoveryCode: typeof done.body?.recoveryCode === 'string' ? done.body.recoveryCode : '',
    },
  };
}

/**
 * Confirms one of the account's own passkeys, the player verified by their
 * device, before what cannot be undone; resolves with when the
 * confirmation lapses, ms.
 */
export async function confirmPasskey(reach: Reach = browserReach()): Promise<Outcome<number>> {
  const begun = await call(reach.fetch, '/api/account/confirm/begin');
  if (begun.status !== 200 || begun.body === null) {
    return { ok: false, reason: reasonOf(begun) };
  }
  let cred: unknown;
  try {
    cred = await reach.prompt.get({ publicKey: requestOptions(begun.body, reach.pkc) });
  } catch (err) {
    return { ok: false, reason: promptFailure(err) };
  }
  if (cred === null) {
    return { ok: false, reason: 'cancelled' };
  }
  const done = await call(reach.fetch, '/api/account/confirm/finish', answerJSON(cred as Answered));
  if (done.status !== 200) {
    return { ok: false, reason: reasonOf(done) };
  }
  return { ok: true, value: Number(done.body?.confirmedUntil ?? 0) };
}

/** The account page's data, GET /api/account. */
export interface AccountData {
  name: string;
  look: string;
  created: number;
  recoveryMade: number;
  passkeys: PasskeyItem[];
  confirmedUntil: number;
}

export async function readAccount(f: Fetch = fetch): Promise<Outcome<AccountData>> {
  try {
    const res = await f('/api/account', { cache: 'no-store', credentials: 'same-origin' });
    const body = (await res.json()) as JSONObject;
    if (res.status !== 200) {
      return { ok: false, reason: typeof body.error === 'string' ? body.error : 'unavailable' };
    }
    return { ok: true, value: body as unknown as AccountData };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

/** Removes one of the account's passkeys; the browser is told which stand. */
export async function removePasskey(
  id: string,
  reach: Reach = browserReach(),
): Promise<Outcome<PasskeyItem[]>> {
  const a = await call(reach.fetch, '/api/account/passkeys/remove', { id });
  if (a.status !== 200) {
    return { ok: false, reason: reasonOf(a) };
  }
  void signalAccepted(a.body?.accepted, reach.pkc);
  return { ok: true, value: (a.body?.passkeys as PasskeyItem[]) ?? [] };
}

/** A new recovery code in place of the old. */
export async function newRecoveryCode(reach: Reach = browserReach()): Promise<Outcome<string>> {
  const a = await call(reach.fetch, '/api/account/recovery');
  if (a.status !== 200) {
    return { ok: false, reason: reasonOf(a) };
  }
  return { ok: true, value: String(a.body?.recoveryCode) };
}

/** Signs this browser out. */
export async function signOut(reach: Reach = browserReach()): Promise<Outcome<null>> {
  const a = await call(reach.fetch, '/logout');
  return a.status === 204 ? { ok: true, value: null } : { ok: false, reason: reasonOf(a) };
}

/** Signs out every other browser of the account: how many were. */
export async function signOutOthers(reach: Reach = browserReach()): Promise<Outcome<number>> {
  const a = await call(reach.fetch, '/api/account/logout-others');
  return a.status === 200
    ? { ok: true, value: Number(a.body?.ended ?? 0) }
    : { ok: false, reason: reasonOf(a) };
}

/** Deletes the account, its name typed again; the browser is told to forget its passkeys. */
export async function deleteSailor(
  name: string,
  reach: Reach = browserReach(),
): Promise<Outcome<null>> {
  const a = await call(reach.fetch, '/api/account/delete', { name });
  if (a.status !== 200) {
    return { ok: false, reason: reasonOf(a) };
  }
  const unknown = Array.isArray(a.body?.unknown) ? (a.body.unknown as unknown[]) : [];
  await Promise.all(unknown.map((u) => signalUnknown(u, reach.pkc)));
  return { ok: true, value: null };
}

/**
 * A recovery code as the player types it, written as the server reads it:
 * capitals, I and L as 1, O as 0, in groups of four. Anything that cannot
 * be in a code is left out.
 */
export function codeForm(typed: string): string {
  const plain = typed
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, '')
    .slice(0, 26);
  return plain.replace(/(.{4})(?=.)/g, '$1-');
}
