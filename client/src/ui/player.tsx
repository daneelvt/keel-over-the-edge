// SPDX-License-Identifier: AGPL-3.0-only

// Text a player wrote, shown to players: always as text, never as markup,
// and isolated in a <bdi> so a name in a right-to-left script cannot
// reorder the words around it.

export function PlayerText({ text }: { text: string }) {
  return <bdi class="player-text">{text}</bdi>;
}
