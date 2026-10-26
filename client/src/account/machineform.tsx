// SPDX-License-Identifier: AGPL-3.0-only

// Machine sailors as the pages show them, and the fields that make one: a
// name, by the rules of every sailor's name, and a machine look (a version,
// a metal finish and a main colour), all three drawn at random first and
// drawn again on asking, or chosen one by one. The choices are the
// catalog's, handed in (the game reads its own catalog, the approval page
// the server's answer), never named in code. Used by the game and by the
// approval page, so it imports nothing of the game's.

import './machines.css';
import { useState } from 'preact/hooks';
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

/** A look in words, as the server writes them: Brass · female · deep red. */
export function lookWords(d: Pick<Draft, LookPart>): string {
  return `${d.finish.name} · ${d.version.name} · ${d.colour.name}`;
}

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

/** A machine sailor's name, look and whether it is at sea; its apps, when apps is set. */
export function MachineSummary({ m, apps = true }: { m: MachineItem; apps?: boolean }) {
  const live = liveApps(m);
  return (
    <span class="machine-summary">
      <strong class="machine-name">
        <bdi>{m.name}</bdi>
      </strong>
      <span class="machine-look">
        <Swatch colour={m.look.srgb} />
        {m.look.words}
      </span>
      <span class="machine-faint">{m.atSea ? 'at sea' : 'not at sea'}</span>
      {apps ? (
        <span class="machine-faint">
          {live.length === 0
            ? 'No AI app approved yet'
            : `Approved: ${live.map((a) => a.name).join(', ')}`}
        </span>
      ) : null}
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
}

const LABELS: Record<LookPart, string> = { version: 'Version', finish: 'Finish', colour: 'Colour' };

/** The fields of a machine sailor to make, inside a form of the page's. */
export function MachineFields({ looks, draft, problem, id, setName, pick, draw }: FieldsProps) {
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
      <div class="machine-look-row">
        <span class="machine-look">
          <Swatch colour={draft.colour.colour ?? ''} />
          {lookWords(draft)}
        </span>
        <button type="button" class="start-sign-in machine-draw" onClick={draw}>
          Draw another
        </button>
      </div>
      <div class="machine-parts">
        {(Object.keys(SETS) as LookPart[]).map((part) => (
          <label key={part} class="machine-part">
            <span class="start-label">{LABELS[part]}</span>
            <select
              name={`machine-${part}`}
              value={draft[part].id}
              onChange={(e) => pick(part, e.currentTarget.value)}
            >
              {looks[SETS[part]].map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
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
