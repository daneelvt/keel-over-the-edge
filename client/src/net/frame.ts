// SPDX-License-Identifier: AGPL-3.0-only

// The envelopes of the game connection: a message of kind 1 is a
// ClientMessage or a ServerMessage in Protocol Buffers, generated from
// shared/protocol/keel/v1/game.proto by go run ./tools/protocol. Only the
// net worker encodes and decodes them; 64-bit fields arrive as bigint, and
// are made numbers once, there.

import { create, fromBinary, type MessageInitShape, toBinary } from '@bufbuild/protobuf';
import {
  type ClientMessage,
  ClientMessageSchema,
  type ServerMessage,
  ServerMessageSchema,
} from './gen/keel/v1/game_pb';
import { KIND_MESSAGE } from './snapshot';

function framed(body: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(body.length + 1);
  out[0] = KIND_MESSAGE;
  out.set(body, 1);
  return out;
}

/** Encodes a client's message, its kind byte first. */
export function encodeClient(
  m: MessageInitShape<typeof ClientMessageSchema>,
): Uint8Array<ArrayBuffer> {
  return framed(toBinary(ClientMessageSchema, create(ClientMessageSchema, m)));
}

/** Encodes a server's message, its kind byte first (tests, traces). */
export function encodeServer(
  m: MessageInitShape<typeof ServerMessageSchema>,
): Uint8Array<ArrayBuffer> {
  return framed(toBinary(ServerMessageSchema, create(ServerMessageSchema, m)));
}

/** Decodes a server's message of kind 1; throws on anything else. */
export function decodeServer(b: Uint8Array): ServerMessage {
  if (b.length === 0 || b[0] !== KIND_MESSAGE) {
    throw new Error('not a message of kind 1');
  }
  const m = fromBinary(ServerMessageSchema, b.subarray(1));
  if (m.body.case === undefined) {
    throw new Error('a message with no body');
  }
  return m;
}

/** Decodes a client's message of kind 1; throws on anything else (tests, traces). */
export function decodeClient(b: Uint8Array): ClientMessage {
  if (b.length === 0 || b[0] !== KIND_MESSAGE) {
    throw new Error('not a message of kind 1');
  }
  const m = fromBinary(ClientMessageSchema, b.subarray(1));
  if (m.body.case === undefined) {
    throw new Error('a message with no body');
  }
  return m;
}
