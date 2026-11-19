// SPDX-License-Identifier: AGPL-3.0-only

// Text a player wrote, shown to players: always as text, never as markup,
// and isolated in a <bdi> so a name in a right-to-left script cannot
// reorder the words around it. And the mark a machine sailor's name
// carries.

export function PlayerText({ text }: { text: string }) {
  return <bdi class="player-text">{text}</bdi>;
}

/** The words a machine sailor's mark is read as. */
export const MACHINE_MARK = 'machine sailor';

/** The mark beside a machine sailor's name: ⚙, read as "machine sailor". */
export function MachineMark({ class: cls = '' }: { class?: string }) {
  return (
    <span
      class={`machine-mark${cls === '' ? '' : ` ${cls}`}`}
      role="img"
      aria-label={MACHINE_MARK}
      title={MACHINE_MARK}
    >
      ⚙
    </span>
  );
}
