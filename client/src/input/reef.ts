// SPDX-License-Identifier: AGPL-3.0-only

// The reef as the player holds it: the level the crew is to take, 0 full
// sail, 1 or 2 reefs, a whole number as the wire carries it. It is a
// target: the crew takes a reef in or shakes it out over the rig's reef
// time, on the phone as on the server, so a reefed boat is predicted like
// any other. The autopilot never reefs.

/** The deepest reef. */
export const MAX_REEF = 2;

/** v as a reef the wire carries: a whole number 0 … MAX_REEF, the nearest; anything else full sail. */
export function reefLevel(v: number): number {
  if (!(v > 0)) {
    return 0;
  }
  return Math.min(Math.round(v), MAX_REEF);
}

export class ReefInput {
  /** The reef the player asks for: 0 full sail, 1 or 2. */
  level = 0;
  /** Called when the player takes a reef in or shakes one out: a key, or the Reef key. */
  onTake: (() => void) | null = null;

  /** Sets the reef the crew is to take, kept to a whole level 0 … MAX_REEF. The screen's Reef key calls it. */
  set(level: number): void {
    this.level = reefLevel(level);
    this.onTake?.();
  }

  /** One reef more, down to the deepest. */
  reef(): void {
    this.set(this.level + 1);
  }

  /** One reef shaken out, up to full sail. */
  shakeOut(): void {
    this.set(this.level - 1);
  }
}
