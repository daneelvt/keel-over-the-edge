// SPDX-License-Identifier: AGPL-3.0-only

// Machine sailors as the pages show them, and the fields that make one: a
// name, by the rules of every sailor's name, and a machine look (a version,
// a metal finish and a main colour), all three drawn at random first and
// drawn again on asking, or chosen one by one, its portrait beside them.
// The choices are the catalog's, handed in (the game reads its own
// catalog, the approval page the server's answer), never named in code;
// and so is the portrait, which each page draws from its own pictures.
// Used by the game and by the approval page, so it imports nothing of the
// game's.

import './machines.css';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Choices } from './choices';
import { drawLook } from './looks';
import { MAX_NAME } from './reasons';
import { dayOf } from './recovery';

/** One choice of a machine sailor's look: its id, its name in words, and its colour where it has one. */
export interface LookOption {
  id: string;
  name: string;
  colour?: string;
}

/** The choices of a machine sailor's look. */
export interface MachineLooks {
  versions: readonly LookOption[];
  finishes: readonly LookOption[];
  colours: readonly LookOption[];
}

/** A machine sailor's look as the server lists it: its choices, in words, and its main colour. */
export interface MachineLook {
  version: string;
  finish: string;
  colour: string;
  words: string;
  srgb: string;
}

/** An AI app approved for a machine sailor. Times are ms, 0 for never. */
export interface AppItem {
  id: string;
  name: string;
  returnHost: string;
  loopback?: boolean;
  approved: number;
  lastUsed: number;
  ends: number;
  ended?: boolean;
  endedHow?: string;
}

/** A machine sailor's connection token. */
export interface TokenItem {
  id: string;
  made: number;
  lastUsed: number;
  ends: number;
  ended?: boolean;
}

/** A machine sailor as the server lists it. */
export interface MachineItem {
  id: string;
  name: string;
  look: MachineLook;
  atSea: boolean;
  apps: AppItem[];
  token: TokenItem | null;
}

/** A machine sailor being made: its name as typed, and its look. */
export interface Draft {
  name: string;
  version: LookOption;
  finish: LookOption;
  colour: LookOption;
}

export type LookPart = 'version' | 'finish' | 'colour';

const SETS: Record<LookPart, keyof MachineLooks> = {
  version: 'versions',
  finish: 'finishes',
  colour: 'colours',
};

/** A look drawn at random, each part another than the current one's where there is a choice. */
export function drawMachine(
  looks: MachineLooks,
  current: Draft | null = null,
  random: () => number = Math.random,
): Draft {
  return {
    name: current?.name ?? '',
    version: drawLook(looks.versions, current?.version ?? null, random),
    finish: drawLook(looks.finishes, current?.finish ?? null, random),
    colour: drawLook(looks.colours, current?.colour ?? null, random),
  };
}

/** The draft with one part of its look chosen, by its id. */
export function withPart(looks: MachineLooks, d: Draft, part: LookPart, id: string): Draft {
  const o = looks[SETS[part]].find((x) => x.id === id);
  return o === undefined ? d : { ...d, [part]: o };
}

/** A look in words, as the server and the game write them: Machine, female, brass, madder red. */
export function lookWords(d: Pick<Draft, LookPart>): string {
  return `Machine, ${d.version.name}, ${d.finish.name}, ${d.colour.name}`;
}

/** A machine look by its choices' ids, as a portrait is drawn from. */
export type MachineIds = Pick<MachineLook, LookPart>;

/** A draft's look by its choices' ids. */
export function idsOf(d: Pick<Draft, LookPart>): MachineIds {
  return { version: d.version.id, finish: d.finish.id, colour: d.colour.id };
}

/**
 * A machine look's portrait at a size, decorative (its words are always
 * beside it): the game's drawn from its catalog, the approval page's from
 * the server's choices and its own pictures.
 */
export type MachinePicture = (look: MachineIds, size: 40 | 72) => ComponentChildren;

/** What the server's routes take to make one. */
export function draftBody(d: Draft) {
  return { name: d.name, version: d.version.id, finish: d.finish.id, colour: d.colour.id };
}

/** The live apps of a machine sailor: those whose approval has not ended. */
export function liveApps(m: MachineItem): AppItem[] {
  return m.apps.filter((a) => a.ended !== true);
}

const DAY = 86_400_000;

/**
 * When an approval or a token ends, as the player reads it: "ends on 22
 * January", or, within a week, "ends in 5 days", which is shown amber.
 */
export function endsWords(ends: number, now = Date.now()): { text: string; soon: boolean } {
  const left = ends - now;
  if (left <= 0) {
    return { text: `ended on ${dayOf(ends, now)}`, soon: false };
  }
  const days = Math.ceil(left / DAY);
  if (days <= 7) {
    return { text: days === 1 ? 'ends within a day' : `ends in ${days} days`, soon: true };
  }
  return { text: `ends on ${dayOf(ends, now)}`, soon: false };
}

/** A colour's swatch, its colour set by script (the approval page allows no inline style). */
export function Swatch({ colour }: { colour: string }) {
  return (
    <span
      class="machine-swatch"
      aria-hidden="true"
      ref={(el) => {
        if (el !== null) {
          el.style.backgroundColor = colour;
        }
      }}
    />
  );
}

/**
 * A machine sailor's name, look and whether it is at sea; the boat it
 * has, when the fleet is known; its apps, when apps is set; beside its
 * portrait, when the page gives one.
 */
export function MachineSummary({
  m,
  apps = true,
  picture,
  boat = '',
}: {
  m: MachineItem;
  apps?: boolean;
  picture?: MachinePicture;
  /** Its boat, as it is named: "Jolly boat «Gull» 12"; "" for none known. */
  boat?: string;
}) {
  const live = liveApps(m);
  const summary = (
    <span class="machine-summary">
      <strong class="machine-name">
        <bdi>{m.name}</bdi>
      </strong>
      <span class="machine-look">
        <Swatch colour={m.look.srgb} />
        {m.look.words}
      </span>
      <span class="machine-faint">{m.atSea ? 'at sea' : 'not at sea'}</span>
      {boat === '' ? null : (
        <span class="machine-faint machine-boat" data-readout="boat">
          <bdi>{boat}</bdi>
        </span>
      )}
      {apps ? (
        <span class="machine-faint">
          {live.length === 0
            ? 'No AI app approved yet'
            : `Approved: ${live.map((a) => a.name).join(', ')}`}
        </span>
      ) : null}
    </span>
  );
  return picture === undefined ? (
    summary
  ) : (
    <span class="machine-who">
      {picture(m.look, 40)}
      {summary}
    </span>
  );
}

export interface FieldsProps {
  looks: MachineLooks;
  draft: Draft;
  problem: string;
  /** Prefixes the fields' ids: two forms may share a page. */
  id: string;
  setName: (name: string) => void;
  pick: (part: LookPart, id: string) => void;
  draw: () => void;
  picture?: MachinePicture;
}

/** The parts of a machine look as the picker names them, in its order. */
export const PARTS: readonly { part: LookPart; label: string }[] = [
  { part: 'version', label: 'Version' },
  { part: 'finish', label: 'Metal finish' },
  { part: 'colour', label: 'Main colour' },
];

/**
 * The fields of a machine sailor to make, inside a form of the page's: its
 * name; then its portrait, the look in words (said again as it changes),
 * Draw another, and each part of the look to choose: the version in words,
 * the finish and the main colour as swatches.
 */
export function MachineFields({
  looks,
  draft,
  problem,
  id,
  setName,
  pick,
  draw,
  picture,
}: FieldsProps) {
  return (
    <div class="machine-fields">
      <label class="start-label" for={`${id}-name`}>
        Its name
      </label>
      <input
        id={`${id}-name`}
        class="start-name"
        name="machine-name"
        type="text"
        autocomplete="off"
        autocapitalize="words"
        spellcheck={false}
        maxLength={MAX_NAME}
        value={draft.name}
        aria-invalid={problem !== ''}
        aria-describedby={`${id}-problem`}
        onInput={(e) => setName(e.currentTarget.value)}
      />
      <p id={`${id}-problem`} class="start-problem" aria-live="polite">
        {problem}
      </p>
      <div class="machine-picker">
        {picture?.(idsOf(draft), 72) ?? null}
        <div class="machine-look-row">
          <span class="machine-look" aria-live="polite">
            {lookWords(draft)}
          </span>
          <button type="button" class="start-sign-in machine-draw" onClick={draw}>
            Draw another
          </button>
        </div>
      </div>
      {PARTS.map(({ part, label }) => (
        <Choices
          key={part}
          label={label}
          id={`${id}-${part}`}
          choices={looks[SETS[part]]}
          chosen={draft[part].id}
          choose={(c) => pick(part, c)}
        />
      ))}
    </div>
  );
}

/** A machine sailor being made, drawn at random first. */
export function useDraft(looks: MachineLooks, random?: () => number) {
  const [draft, setDraft] = useState(() => drawMachine(looks, null, random));
  return {
    draft,
    setName: (name: string) => setDraft((d) => ({ ...d, name })),
    pick: (part: LookPart, id: string) => setDraft((d) => withPart(looks, d, part, id)),
    draw: () => setDraft((d) => drawMachine(looks, d, random)),
  };
}
