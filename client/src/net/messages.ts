// SPDX-License-Identifier: AGPL-3.0-only

// The records the page and its net worker send each other: one closed set
// each way. A snapshot crosses as its ArrayBuffer, transferred, not copied.

import type { ClockState } from './clock';

/** What the net worker's Hello carries besides the protocol version. */
export interface HelloVersions {
  catalog: string;
  physicsLayout: number;
  build: string;
}

export type ToWorker =
  /** Connect to url, and keep connecting. */
  | { type: 'start'; url: string; versions: HelloVersions }
  /** The controls stepped for tick seq. */
  | { type: 'input'; seq: number; helm: number; sheet: number }
  /** The page's frame time's 95th percentile, ms, for the server's metrics. */
  | { type: 'frame'; ms: number }
  /** Stop waiting: the network is back, or the page is shown again. */
  | { type: 'wake' }
  /** The player chose to take the boat back from another device. */
  | { type: 'takeover' }
  /** The page is going: close with 1000. */
  | { type: 'stop' };

/** Where the connection stands. */
export type Status =
  /** Opening, or open and waiting for the Welcome. */
  | 'connecting'
  /** Welcomed: snapshots arrive. */
  | 'sailing'
  /** Closed, waiting to try again. */
  | 'waiting'
  /** Another device took the boat. */
  | 'replaced'
  /** The session is gone: the start screen. */
  | 'signed-out'
  /** Client and server differ: reload. */
  | 'version'
  /** The player was removed. */
  | 'removed'
  /** Stopped for good. */
  | 'stopped';

export type FromWorker =
  | { type: 'status'; status: Status; waitMs: number; reason: string }
  | { type: 'welcome'; boat: number; rejoined: boolean; kind: number; tick: number }
  | { type: 'snapshot'; data: ArrayBuffer }
  | { type: 'clock'; clock: ClockState }
  | { type: 'traffic'; bytesIn: number; bytesOut: number; messagesIn: number; messagesOut: number };
