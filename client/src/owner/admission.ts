// SPDX-License-Identifier: AGPL-3.0-only

// Admission by kind on the world page, in words: the machine sailors at sea
// against their cap and the places kept for them, the rules their agents
// are held to, what a machine boat's agent last did, and the spectators
// watching boats against their limit.

import type { Admission, Agent, Spectators } from './api';

/** How long ago, in its largest unit: "12 s ago", "3 min ago", "2 h ago"; null is no call yet. */
export function ago(s: number | null): string {
  if (s === null) {
    return 'no call yet';
  }
  if (s < 60) {
    return `${Math.round(s)} s ago`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)} min ago`;
  }
  return `${Math.floor(s / 3600)} h ago`;
}

/** A span in minutes when it is whole minutes, else in seconds: "3 min", "90 s". */
function span(s: number): string {
  return s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${Math.round(s)} s`;
}

/** A machine boat's agent in a few words: its app, its last call, its wait, its refusals. */
export function agentWords(a: Agent | undefined): string {
  if (a === undefined) {
    return 'no agent known';
  }
  const words = [a.app || 'an unnamed app', `called ${ago(a.sinceCall)}`];
  if (a.waiting > 0) {
    words.push(`waiting ${span(a.waiting)}`);
  }
  if (a.refusals > 0) {
    words.push(`${a.refusals} refused`);
  }
  return words.join(', ');
}

/** The machine sailors at sea against their cap: "Machine sailors: 3 at sea of a cap of 500, 250 kept for them". */
export function machinesLine(a: Admission): string {
  return `Machine sailors: ${a.machines} at sea of a cap of ${a.aiCap}, ${a.aiReserve} kept for them`;
}

/** The rules machine sailors' agents are held to, as keel is configured; empty when the page is not told. */
export function rulesLine(a: Admission): string {
  const words: string[] = [];
  if (a.aiSilence > 0) {
    words.push(`an agent silent ${span(a.aiSilence)} sends its boat into its grace`);
  }
  if (a.aiOrders) {
    words.push(`orders: ${a.aiOrders}`);
  }
  if (a.aiLooks) {
    words.push(`looks: ${a.aiLooks}`);
  }
  if (words.length === 0) {
    return '';
  }
  const line = words.join('; ');
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

/** The spectators against their limit: "Spectators: 3 watching, 0 waiting, of a limit of 1000". */
export function spectatorsLine(s: Spectators): string {
  return `Spectators: ${s.watching} watching, ${s.waiting} waiting, of a limit of ${s.limit}`;
}

/** How many watch a boat: "3 watching"; "" when none do. */
export function watchersWords(n: number): string {
  return n > 0 ? `${n} watching` : '';
}
