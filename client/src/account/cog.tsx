// SPDX-License-Identifier: AGPL-3.0-only

// The machine mark as a small icon, in the text's colour: the cog the AI
// boats wear on their sails, drawn from the same outline, so a player
// learns one sign for AI on the sea and on the page.

import { COG_HOLE, cogOutline } from '../render/machinemark';

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The cog's path in a box from -1 to 1, up the page: the teeth and ring, and the hole cut out of them. */
function cogPath(): string {
  const o = cogOutline();
  const parts: string[] = [];
  for (let i = 0; i < o.length; i += 2) {
    parts.push(`${i === 0 ? 'M' : 'L'}${round(o[i] ?? 0)} ${round(-(o[i + 1] ?? 0))}`);
  }
  const h = COG_HOLE;
  parts.push(`ZM${h} 0A${h} ${h} 0 1 0 ${-h} 0A${h} ${h} 0 1 0 ${h} 0Z`);
  return parts.join('');
}

const PATH = cogPath();

export function Cog({ size = 20 }: { size?: number }) {
  return (
    <svg class="cog" width={size} height={size} viewBox="-1 -1 2 2" aria-hidden="true">
      <path d={PATH} fill="currentColor" fill-rule="evenodd" />
    </svg>
  );
}
