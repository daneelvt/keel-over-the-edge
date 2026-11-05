// SPDX-License-Identifier: AGPL-3.0-only

// The picker: a sailor's look chosen. The look's name and "female · 7 of
// 18", ‹ and › (or a swipe) through every look and version in the
// catalog's order, Shuffle (look, version and options at random) with an
// Undo for one step, and three radio groups of swatches: the skin, the hair
// (the greys for the looks of greying sailors) and the main colour. A
// polite live region says the look in words. The look's portrait stands
// where its figure will, until the picker's stage draws the figure.
//
// It holds no state of its own: the screen it is on keeps the look and the
// one before a shuffle, so it can be drawn by a test as a plain function.

import './picker.css';
import type { ComponentChildren } from 'preact';
import { drawLook, hairsOf, type Look, type Looks, lookWords, partsOf } from '../catalog/looks';
import { Choices } from './choices';
import type { LookStage, StageView } from './lookstage';
import { Portrait } from './portraits';

/** Every person's look and version in the catalog's order: the picker's ‹ and › go through them. */
export function versionsOf(looks: Looks): { look: string; version: string }[] {
  return looks.sailors.flatMap((s) => s.versions.map((v) => ({ look: s.id, version: v.id })));
}

/** Where a look is among them, 0 for one not there. */
export function placeOf(looks: Looks, l: Look): number {
  return Math.max(
    0,
    versionsOf(looks).findIndex((p) => p.look === l.look && p.version === l.version),
  );
}

/**
 * The look by steps of ‹ and ›: the next or previous look and version,
 * round, its options kept; a hair colour the new look does not take
 * becomes the one in its place in the new set, or the set's last.
 */
export function stepLook(looks: Looks, l: Look, by: number): Look {
  const all = versionsOf(looks);
  const at = (placeOf(looks, l) + by + all.length) % all.length;
  const next = all[at] as { look: string; version: string };
  const was = looks.sailors.find((s) => s.id === l.look);
  const now = looks.sailors.find((s) => s.id === next.look);
  let hair = l.hair;
  if (was !== undefined && now !== undefined && was.hair !== now.hair) {
    const from = hairsOf(looks, was);
    const to = hairsOf(looks, now);
    const i = from.findIndex((h) => h.id === l.hair);
    hair = (to[Math.min(Math.max(i, 0), to.length - 1)] ?? to[0])?.id;
  }
  return { ...l, look: next.look, version: next.version, ...(hair === undefined ? {} : { hair }) };
}

/** The look's name, and its version and place: "female · 7 of 18". */
export function placeWords(looks: Looks, l: Look): { name: string; place: string } {
  const p = partsOf(looks, l);
  return {
    name: p.sailor?.name ?? '',
    place: `${p.version?.name ?? ''} · ${placeOf(looks, l) + 1} of ${versionsOf(looks).length}`,
  };
}

/** What the picker says of the way a look is changed, under its groups. */
export const PICKER_NOTE = 'Changed only at Port Royal. Looks only; never how a boat sails.';

/** The ‹ and › buttons' and Shuffle's names, as a screen reader says them. */
export const PREVIOUS_LOOK = 'Previous look';
export const NEXT_LOOK = 'Next look';

export interface PickerProps {
  looks: Looks;
  look: Look;
  /** Chooses a look: from the arrows, the swatches or Shuffle. */
  choose: (l: Look) => void;
  /** Shuffles: a look at random. */
  shuffle: () => void;
  /** Takes back the last shuffle; null when there is none to take back. */
  undo: (() => void) | null;
  /** Whether the stage draws the figure: else the portrait stands in its place. */
  figure?: boolean;
  /** Buttons beside Shuffle: the screen's own, such as Set sail. */
  actions?: ComponentChildren;
}

/** Where a swipe began, by pointer: the picker's look goes on by a swipe across it. */
const swipes = new WeakMap<Element, number>();

export function Picker({
  looks,
  look,
  choose,
  shuffle,
  undo,
  figure = false,
  actions,
}: PickerProps) {
  const p = partsOf(looks, look);
  const { name, place } = placeWords(looks, look);
  const set = (part: 'skin' | 'hair' | 'colour') => (id: string) => choose({ ...look, [part]: id });
  return (
    <div
      class="picker"
      onPointerDown={(e) => swipes.set(e.currentTarget, e.clientX)}
      onPointerUp={(e) => {
        const from = swipes.get(e.currentTarget);
        swipes.delete(e.currentTarget);
        const dx = from === undefined ? 0 : e.clientX - from;
        // A swipe, not a tap: across the picker, clear of a swatch's width.
        if (Math.abs(dx) > 60 && !(e.target as Element).closest('.choices')) {
          choose(stepLook(looks, look, dx < 0 ? 1 : -1));
        }
      }}
    >
      {figure ? null : (
        <div class="picker-portrait">
          <Portrait looks={looks} look={look} size={160} />
        </div>
      )}
      <div class="picker-look">
        <button
          type="button"
          class="picker-step"
          aria-label={PREVIOUS_LOOK}
          onClick={() => choose(stepLook(looks, look, -1))}
        >
          ‹
        </button>
        <p class="picker-name">
          <span class="picker-look-name">{name}</span>
          <span class="picker-place">{place}</span>
        </p>
        <button
          type="button"
          class="picker-step"
          aria-label={NEXT_LOOK}
          onClick={() => choose(stepLook(looks, look, 1))}
        >
          ›
        </button>
      </div>
      <Choices
        label="Skin"
        id="picker-skin"
        choices={looks.sailorOptions.skins}
        chosen={look.skin ?? ''}
        choose={set('skin')}
      />
      <Choices
        label="Hair"
        id="picker-hair"
        choices={p.sailor === null ? [] : hairsOf(looks, p.sailor)}
        chosen={look.hair ?? ''}
        choose={set('hair')}
      />
      <Choices
        label="Main colour"
        id="picker-colour"
        choices={looks.sailorOptions.colours}
        chosen={look.colour}
        choose={set('colour')}
      />
      <p class="picker-words" aria-live="polite">
        {lookWords(looks, look)}
      </p>
      <p class="picker-note">{PICKER_NOTE}</p>
      <div class="picker-actions">
        <button type="button" class="picker-shuffle" onClick={shuffle}>
          Shuffle
        </button>
        {undo === null ? null : (
          <button type="button" class="picker-undo" onClick={undo}>
            Undo
          </button>
        )}
        {actions}
      </div>
    </div>
  );
}

/**
 * A look and the one before its last shuffle, as a screen keeps them for
 * its picker: choosing keeps no undo; a shuffle keeps the look it replaced.
 */
export interface PickerState {
  look: Look;
  before: Look | null;
}

/** The picker's state after a look chosen. */
export function chosen(l: Look): PickerState {
  return { look: l, before: null };
}

/** The picker's state after a shuffle: a look at random, another than the one shown. */
export function shuffled(
  looks: Looks,
  s: PickerState,
  random: () => number = Math.random,
): PickerState {
  let next = drawLook(looks, random);
  for (let i = 0; i < 8 && next.look === s.look.look && next.version === s.look.version; i++) {
    next = drawLook(looks, random);
  }
  return { look: next, before: s.look };
}

/** The picker's state after Undo: the look before the shuffle. */
export function undone(s: PickerState): PickerState {
  return s.before === null ? s : { look: s.before, before: null };
}

/** Where a drag of the stage began, by pointer. */
const drags = new WeakMap<Element, number>();

/** The camera's views of the stage, and their buttons' words. */
const VIEWS: [StageView, string][] = [
  ['front', 'Front'],
  ['behind', 'Behind'],
  ['face', 'Face'],
];

/**
 * The stage's part of the screen: a drag across it turns the figure, Front,
 * Behind and Face move the camera, and until the figure is drawn the
 * look's portrait stands where it will.
 */
export function StageFront({ looks, look, stage }: { looks: Looks; look: Look; stage: LookStage }) {
  return (
    <div
      class="stage-front"
      onPointerDown={(e) => {
        // A press of a button is the button's, not a drag.
        if ((e.target as Element).closest('button') !== null) {
          return;
        }
        drags.set(e.currentTarget, e.clientX);
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const from = drags.get(e.currentTarget);
        if (from !== undefined) {
          stage.turn(e.clientX - from, window.innerWidth);
          drags.set(e.currentTarget, e.clientX);
        }
      }}
      onPointerUp={(e) => drags.delete(e.currentTarget)}
      onPointerCancel={(e) => drags.delete(e.currentTarget)}
    >
      {stage.figure.value ? null : (
        <div class="stage-portrait">
          <Portrait looks={looks} look={look} size={160} />
        </div>
      )}
      <div class="stage-views">
        {VIEWS.map(([v, words]) => (
          <button key={v} type="button" class="stage-view" onClick={() => stage.view(v)}>
            {words}
          </button>
        ))}
      </div>
    </div>
  );
}
