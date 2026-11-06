// SPDX-License-Identifier: AGPL-3.0-only

// A choice among a few, as a radio group: swatches of colour, or chips of
// words. Each is named; the chosen one is ringed and its name is shown
// under the group. The arrow keys move the choice, as a radio group's do;
// Tab reaches the group once. A swatch's colour is set by script: the
// approval page, which shows them too, allows no inline style.

import './choices.css';

/** One of a group's choices: its id, its name in words, and its colour (#rrggbb) for a swatch. */
export interface Choice {
  id: string;
  name: string;
  colour?: string;
}

/** Moves a choice by the arrow keys within a radio group: the next or the previous, round. */
function step(
  e: KeyboardEvent & { currentTarget: HTMLElement },
  choices: readonly Choice[],
  at: number,
) {
  const by = (
    { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>
  )[e.key];
  if (by === undefined || choices.length === 0) {
    return null;
  }
  e.preventDefault();
  const next = (at + by + choices.length) % choices.length;
  const group = e.currentTarget.closest('[role="radiogroup"]');
  (group?.querySelectorAll<HTMLElement>('[role="radio"]')[next] ?? null)?.focus();
  return choices[next] ?? null;
}

/** A swatch's disc of colour. */
function SwatchColour({ colour }: { colour: string }) {
  return (
    <span
      class="swatch-colour"
      ref={(el) => {
        if (el !== null) {
          el.style.backgroundColor = colour;
        }
      }}
    />
  );
}

/**
 * A radio group of choices, named label: swatches where the choices have
 * colours, else chips of words; the chosen one's name shown under them.
 */
export function Choices({
  label,
  choices,
  chosen,
  choose,
  name,
  id: given,
}: {
  label: string;
  choices: readonly Choice[];
  chosen: string;
  choose: (id: string) => void;
  /** A class for the group, to lay it out. */
  name?: string;
  /** Its label's id, where two groups of the same label may share a page. */
  id?: string;
}) {
  const at = Math.max(
    0,
    choices.findIndex((c) => c.id === chosen),
  );
  const current = choices[at];
  const id = given ?? `choices-${label.toLowerCase().replace(/\W+/g, '-')}`;
  const swatches = choices.every((c) => c.colour !== undefined);
  return (
    <div class={`choices${name === undefined ? '' : ` ${name}`}`}>
      <span class="choices-label" id={id}>
        {label}
      </span>
      <div
        class={swatches ? 'choices-row swatches' : 'choices-row chips'}
        role="radiogroup"
        aria-labelledby={id}
      >
        {choices.map((c, i) => (
          // biome-ignore lint/a11y/useSemanticElements: a swatch is drawn as no native radio can be, so a button takes the radio's role and keys
          <button
            key={c.id}
            type="button"
            role="radio"
            class={swatches ? 'swatch' : 'chip'}
            aria-checked={i === at}
            aria-label={c.name}
            tabIndex={i === at ? 0 : -1}
            onClick={() => choose(c.id)}
            onKeyDown={(e) => {
              const next = step(e, choices, at);
              if (next !== null) {
                choose(next.id);
              }
            }}
          >
            {swatches ? <SwatchColour colour={c.colour ?? ''} /> : c.name}
          </button>
        ))}
      </div>
      {swatches ? <span class="choices-name">{current?.name ?? ''}</span> : null}
    </div>
  );
}
