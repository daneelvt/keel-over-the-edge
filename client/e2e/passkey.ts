// SPDX-License-Identifier: AGPL-3.0-only

// A software authenticator for the browser tests, as internal/auth/softkey
// is for Go's: an ES256 (P-256) passkey in memory, with the "none"
// attestation, answering with the user present and verified. A spec makes
// its sailor through the server's own routes with it, and can hand the same
// key to Playwright's virtual authenticator (context.credentials), so the
// page signs in with the passkey the account was made with.

import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/** A passkey, its bytes in base64url as Playwright's credentials take them. */
export interface Passkey {
  rpId: string;
  /** The page's origin it answers from. */
  origin: string;
  id: string;
  userHandle: string;
  /** PKCS #8, DER. */
  privateKey: string;
  /** SPKI, DER. */
  publicKey: string;
  signCount: number;
}

const b64 = (b: Uint8Array | Buffer): string => Buffer.from(b).toString('base64url');
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64url');

// CBOR (RFC 8949), the little WebAuthn's attestation needs: unsigned and
// negative integers, byte and text strings, and maps.
function head(major: number, n: number): Buffer {
  if (n < 24) {
    return Buffer.from([(major << 5) | n]);
  }
  if (n < 0x100) {
    return Buffer.from([(major << 5) | 24, n]);
  }
  if (n < 0x10000) {
    return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

type CBOR = number | string | Uint8Array | Map<number | string, CBOR>;

function cbor(v: CBOR): Buffer {
  if (typeof v === 'number') {
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  }
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) {
    return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  }
  const parts = [head(5, v.size)];
  for (const [k, x] of v) {
    parts.push(cbor(k), cbor(x));
  }
  return Buffer.concat(parts);
}

// The authenticator data's flags (WebAuthn Level 3, 6.1): the user present
// and verified, and attested credential data after them.
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

function authData(p: Passkey, flags: number, rest: Buffer = Buffer.alloc(0)): Buffer {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(p.signCount);
  return Buffer.concat([
    createHash('sha256').update(p.rpId).digest(),
    Buffer.from([flags]),
    count,
    rest,
  ]);
}

function clientData(kind: string, challenge: string, origin: string): Buffer {
  return Buffer.from(JSON.stringify({ type: kind, challenge, origin, crossOrigin: false }));
}

interface CreationJSON {
  publicKey: { rp: { id: string }; user: { id: string }; challenge: string };
}

interface RequestJSON {
  publicKey: { rpId: string; challenge: string; allowCredentials?: { id: string }[] };
}

/**
 * Makes a passkey for the creation options the server sent, answering from
 * origin: the passkey, and the answer as the browser's toJSON() writes it.
 */
export function createPasskey(
  options: unknown,
  origin: string,
): { passkey: Passkey; answer: object } {
  const o = (options as CreationJSON).publicKey;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const id = randomBytes(16);
  const passkey: Passkey = {
    rpId: o.rp.id,
    origin,
    id: b64(id),
    userHandle: o.user.id,
    privateKey: b64(privateKey.export({ format: 'der', type: 'pkcs8' })),
    publicKey: b64(publicKey.export({ format: 'der', type: 'spki' })),
    signCount: 0,
  };
  // The public key as COSE writes it (RFC 9053): EC2, ES256, P-256.
  const cose = cbor(
    new Map<number, CBOR>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, unb64(jwk.x ?? '')],
      [-3, unb64(jwk.y ?? '')],
    ]),
  );
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(id.length);
  const auth = authData(
    passkey,
    UP | UV | AT,
    Buffer.concat([Buffer.alloc(16), idLength, id, cose]),
  );
  const attestation = cbor(
    new Map<string, CBOR>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', auth],
    ]),
  );
  return {
    passkey,
    answer: {
      id: passkey.id,
      rawId: passkey.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64(clientData('webauthn.create', o.challenge, origin)),
        attestationObject: b64(attestation),
        authenticatorData: b64(auth),
        publicKey: passkey.publicKey,
        publicKeyAlgorithm: -7,
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: { credProps: { rk: true } },
    },
  };
}

/** Answers the request options the server sent: signing in, or confirming. */
export function assertPasskey(p: Passkey, options: unknown): object {
  const o = (options as RequestJSON).publicKey;
  if (o.rpId !== p.rpId) {
    throw new Error(`a request for ${o.rpId}, not ${p.rpId}`);
  }
  if (o.allowCredentials !== undefined && !o.allowCredentials.some((c) => c.id === p.id)) {
    throw new Error('the request does not allow this passkey');
  }
  const auth = authData(p, UP | UV);
  const cd = clientData('webauthn.get', o.challenge, p.origin);
  const signed = Buffer.concat([auth, createHash('sha256').update(cd).digest()]);
  const key = createPrivateKey({ key: unb64(p.privateKey), format: 'der', type: 'pkcs8' });
  const signature = sign('sha256', signed, { key, dsaEncoding: 'der' });
  return {
    id: p.id,
    rawId: p.id,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: b64(cd),
      authenticatorData: b64(auth),
      signature: b64(signature),
      userHandle: p.userHandle,
    },
    clientExtensionResults: {},
  };
}
