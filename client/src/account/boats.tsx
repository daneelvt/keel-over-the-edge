// SPDX-License-Identifier: AGPL-3.0-only

// The player's boat on their own panel and on a port's harbour board: its
// kind, name and sail number, how many it takes, and a small picture of it
// side on, its hull in its paint and its sails in their cloth, drawn from
// the kind's own rig; "Your boat" opens the look's chooser (radio groups
// of named swatches for the paint and the cloth, the sail number and the
// name), "Change boat" the fleet's boats to choose from. They hold no
// state of their own: the chooser keeps it, so they are drawn by a test
// as plain functions.

import './boats.css';
import { boatNamed } from '../catalog/boatlooks';
import type { Boat } from '../catalog/types.gen';
import type { BoatChooser } from './boatchooser';
import { Choices } from './choices';
import {
  aboardWords,
  type BoatCatalog,
  boatTitle,
  type FleetBoat,
  inOrder,
  kindOf,
  standingWords,
  taken,
} from './fleet';
import { displayForm } from './reasons';

/** What the look's chooser says of the way a boat's look is changed. */
export const BOAT_NOTE = 'Changed in port. Looks only; never how a boat sails.';

/** The buttons that open the look's chooser and the fleet's boats. */
export const YOUR_BOAT = 'Your boat';
export const CHANGE_BOAT = 'Change boat';

/** While the fleet is read. */
export const READING_FLEET = 'Reading your fleet…';

/** The room the pictures are drawn in, m, the same for every kind so that a larger boat is drawn larger. */
function room(cat: BoatCatalog): { width: number; top: number } {
  let width = 1;
  let top = 1;
  for (const b of cat.boats) {
    width = Math.max(width, b.lengthOverall * 1.08);
    top = Math.max(top, sailsOf(b).top);
  }
  return { width, top: top * 1.04 };
}

type Point = [number, number];

/** A kind's sails side on, m ahead of its middle and up from the water, its masts, and their top. */
function sailsOf(b: Boat): { sails: Point[][]; masts: [number, number][]; top: number } {
  const r = b.physics.rig;
  const h = b.physics.headsails;
  const s = b.physics.square;
  const sails: Point[][] = [];
  const masts: [number, number][] = [];
  if (r.luff > 0) {
    const m = r.mastPosition;
    sails.push([
      [m, r.boomHeight],
      [m, r.boomHeight + r.luff],
      [m - r.foot, r.boomHeight],
    ]);
    masts.push([m, r.boomHeight + r.luff * 1.02]);
    if (h.headsailArea > 0) {
      const run = h.headsailTack - m;
      const up = Math.sqrt(Math.max(h.headsailLuff ** 2 - run ** 2, 0));
      sails.push([
        [h.headsailTack, h.headsailTackHeight],
        [m + 0.04, h.headsailTackHeight + up],
        [h.headsailTack - h.headsailFoot * 0.97, h.headsailTackHeight + 0.2],
      ]);
    }
  }
  for (const [area, at] of [
    [s.squareForeArea, s.squareForeMast],
    [s.squareAfterArea, s.squareAfterMast],
  ] as const) {
    if (area > 0 && s.squareLuff > 0) {
      const half = area / s.squareLuff / 2;
      const foot = s.squareFootHeight;
      sails.push([
        [at - half, foot],
        [at - half * 0.8, foot + s.squareLuff],
        [at + half * 0.8, foot + s.squareLuff],
        [at + half, foot],
      ]);
      masts.push([at, foot + s.squareLuff * 1.06]);
    }
  }
  const top = Math.max(0, ...masts.map(([, t]) => t), ...sails.flat().map(([, y]) => y));
  return { sails, masts, top };
}

/** Each picture's own clip, by a number of its own. */
let pictures = 0;

/** SVG points from (ahead, up) in m. */
const pts = (ps: Point[]) => ps.map(([x, y]) => `${x.toFixed(2)},${(-y).toFixed(2)}`).join(' ');

/**
 * A boat side on, its bow to the right: its hull in its paint (its grain
 * showing through a varnish), its sails in their cloth (banded for a
 * stripe), its sail number on the mainsail in the cloth's ink. Hidden
 * from a screen reader: the words beside it say the boat.
 */
export function BoatPicture({
  cat,
  kind,
  paint,
  cloth,
  number,
  width,
}: {
  cat: BoatCatalog;
  kind: string;
  paint: string;
  cloth: string;
  number: number;
  /** Its width, CSS px. */
  width: number;
}) {
  const b = kindOf(cat, kind) ?? cat.boats[0];
  if (b === undefined) {
    return null;
  }
  const p = cat.boatLooks.paints.find((x) => x.id === paint) ?? cat.boatLooks.paints[0];
  const c = cat.boatLooks.cloths.find((x) => x.id === cloth) ?? cat.boatLooks.cloths[0];
  const { width: w, top } = room(cat);
  const below = w * 0.06;
  const L = b.lengthOverall;
  const f = 0.09 * L + 0.18;
  const stern = -0.48 * L;
  const bow = 0.5 * L;
  const hull = `M ${stern} ${-f} L ${bow} ${-1.15 * f} Q ${0.42 * L} ${0.2 * f} ${0.28 * L} ${0.32 * f} L ${-0.4 * L} ${0.32 * f} Q ${stern} ${0.2 * f} ${stern} ${-f} Z`;
  const { sails, masts } = sailsOf(b);
  const main = sails[0];
  const id = `boat-clip-${++pictures}`;
  const r = b.physics.rig;
  const bandAt = r.luff > 0 ? r.boomHeight + r.luff * 0.38 : top * 0.45;
  const bandTall = Math.max(r.luff, top * 0.5) * 0.12;
  return (
    <svg
      class="boat-picture"
      viewBox={`${(-w / 2).toFixed(2)} ${(-top).toFixed(2)} ${w.toFixed(2)} ${(top + below).toFixed(2)}`}
      width={width}
      height={Math.round((width * (top + below)) / w)}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={id}>
          {sails.map((s) => (
            <polygon key={pts(s)} points={pts(s)} />
          ))}
        </clipPath>
      </defs>
      <line
        class="boat-picture-water"
        x1={-w / 2}
        x2={w / 2}
        y1={0}
        y2={0}
        stroke-width={w * 0.012}
      />
      {masts.map(([x, t]) => (
        <line
          key={x}
          class="boat-picture-mast"
          x1={x}
          x2={x}
          y1={-f}
          y2={-t}
          stroke-width={w * 0.012}
        />
      ))}
      {sails.map((s) => (
        <polygon
          key={pts(s)}
          points={pts(s)}
          fill={c?.colour}
          class="boat-picture-sail"
          stroke-width={w * 0.006}
        />
      ))}
      {c?.band === undefined ? null : (
        <rect
          clip-path={`url(#${id})`}
          x={-w / 2}
          width={w}
          y={-(bandAt + bandTall)}
          height={bandTall}
          fill={c.band}
        />
      )}
      {number > 0 && main !== undefined && r.luff > 0 ? (
        <text
          x={(r.mastPosition - r.foot * 0.38).toFixed(2)}
          y={(-(r.boomHeight + r.luff * 0.2)).toFixed(2)}
          font-size={(r.luff * 0.16).toFixed(2)}
          text-anchor="middle"
          fill={c?.ink}
          class="boat-picture-number"
        >
          {number}
        </text>
      ) : null}
      <path d={hull} fill={p?.colour} class="boat-picture-hull" stroke-width={w * 0.006} />
      {p?.grain === true ? (
        <g class="boat-picture-grain" stroke-width={w * 0.004}>
          <line x1={stern + 0.1 * L} x2={bow - 0.12 * L} y1={-0.62 * f} y2={-0.7 * f} />
          <line x1={stern + 0.12 * L} x2={bow - 0.2 * L} y1={-0.22 * f} y2={-0.28 * f} />
        </g>
      ) : null}
    </svg>
  );
}

/** A boat's picture by its look. */
function Picture({ cat, b, width }: { cat: BoatCatalog; b: FleetBoat; width: number }) {
  return (
    <BoatPicture
      cat={cat}
      kind={b.kind}
      paint={b.paint}
      cloth={b.cloth}
      number={b.number}
      width={width}
    />
  );
}

/**
 * The player's boat on their panel: its picture, kind, name and number,
 * how many it takes; with Your boat and Change boat where they may be
 * changed. While the fleet is read, or when it cannot be, says so.
 */
export function YourBoat({ chooser: c, changes }: { chooser: BoatChooser; changes: boolean }) {
  const f = c.fleet.value;
  const b = c.yours;
  if (f === null || b === null) {
    return (
      <p class="start-text start-faint your-boat-reading" aria-live="polite">
        {f === null ? c.unread.value || READING_FLEET : ''}
      </p>
    );
  }
  const kind = kindOf(c.cat, b.kind);
  return (
    <div class={changes ? 'your-boat' : 'your-boat your-boat-afloat'}>
      <Picture cat={c.cat} b={b} width={72} />
      <div class="your-boat-words">
        <p class="your-boat-name" data-readout="boat">
          <bdi>{boatTitle(c.cat, b)}</bdi>
        </p>
        <p class="start-text start-faint">{aboardWords(kind)}</p>
        {changes ? (
          <div class="your-boat-actions">
            <button type="button" class="start-link" onClick={() => c.openLook()}>
              {YOUR_BOAT}
            </button>
            {f.boats.length > 1 ? (
              <button type="button" class="start-link" onClick={() => c.openBoats()}>
                {CHANGE_BOAT}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A heading of the level the screen's own are. */
function Heading({ level, id, text }: { level: 1 | 2; id: string; text: string }) {
  return level === 1 ? <h1 id={id}>{text}</h1> : <h2 id={id}>{text}</h2>;
}

/** The classes of the parts the start screen and the board each style their own way. */
function partsFor(board: boolean) {
  return board
    ? {
        field: '',
        cancel: '',
        save: 'key-main',
        faint: 'boat-faint',
      }
    : {
        field: 'start-name',
        cancel: 'start-sign-in',
        save: 'start-go',
        faint: 'start-text start-faint',
      };
}

/**
 * The boat's look chosen: its picture as chosen, the paint's and the
 * cloth's swatches, the sail number and the name; Cancel and Save. On the
 * start screen its heading is the screen's h1; on the board, in the
 * board's place over the sea, an h2.
 */
export function BoatLookChooser({
  chooser: c,
  board = false,
  className = '',
}: {
  chooser: BoatChooser;
  board?: boolean;
  className?: string;
}) {
  const b = c.yours;
  if (b === null) {
    return null;
  }
  const d = c.draft.value;
  const busy = c.busy.value;
  const field = c.field.value;
  const typed = Number(d.number.trim());
  const shown = Number.isInteger(typed) && typed > 0 ? typed : 0;
  const cat = c.cat;
  const kind = kindOf(cat, b.kind);
  const k = partsFor(board);
  return (
    <section
      key="boat-look"
      class={`boat-look${className === '' ? '' : ` ${className}`}`}
      aria-labelledby="boat-look-title"
    >
      <Heading level={board ? 2 : 1} id="boat-look-title" text={YOUR_BOAT} />
      <div class="boat-look-top">
        <BoatPicture
          cat={cat}
          kind={b.kind}
          paint={d.paint}
          cloth={d.cloth}
          number={shown}
          width={96}
        />
        <p class="boat-look-name" aria-live="polite">
          <bdi>{boatNamed(kind?.name ?? b.kind, displayForm(d.name), shown)}</bdi>
        </p>
      </div>
      <Choices
        label="Paint"
        id="boat-paint"
        choices={cat.boatLooks.paints}
        chosen={d.paint}
        choose={(id) => c.set('paint', id)}
      />
      <Choices
        label="Cloth"
        id="boat-cloth"
        choices={cat.boatLooks.cloths}
        chosen={d.cloth}
        choose={(id) => c.set('cloth', id)}
      />
      <div class="boat-look-fields">
        <label class="boat-look-field boat-look-number">
          <span class="start-label">Sail number</span>
          <input
            class={k.field}
            name="boat-number"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autocomplete="off"
            maxLength={5}
            value={d.number}
            aria-invalid={field === 'number'}
            aria-describedby="boat-look-problem"
            onInput={(e) => c.set('number', e.currentTarget.value)}
          />
        </label>
        <label class="boat-look-field boat-look-boat-name">
          <span class="start-label">Name</span>
          <input
            class={k.field}
            name="boat-name"
            type="text"
            autocomplete="off"
            autocapitalize="words"
            spellcheck={false}
            maxLength={40}
            placeholder="None"
            value={d.name}
            aria-invalid={field === 'name'}
            aria-describedby="boat-look-problem"
            onInput={(e) => c.set('name', e.currentTarget.value)}
          />
        </label>
      </div>
      <p class="picker-note">{BOAT_NOTE}</p>
      <div class="boat-look-foot">
        <p id="boat-look-problem" class="boat-look-problem" aria-live="polite">
          {c.problem.value}
        </p>
        <div class="boat-look-actions">
          <button type="button" class={k.cancel} disabled={busy} onClick={() => c.cancel()}>
            Cancel
          </button>
          <button type="button" class={k.save} disabled={busy} onClick={() => void c.save()}>
            Save
          </button>
        </div>
      </div>
    </section>
  );
}

/** What Change boat says of a boat chosen: ashore, for the next voyage; at sea, here. */
export const CHANGE_ASHORE = 'The boat you choose is yours for your next voyage.';
export const CHANGE_AT_SEA = 'The boat you choose takes your boat’s place here, at rest.';
export const NONE_FREE = 'No other boat of your fleet is free.';

/**
 * The fleet's boats to choose from: each with its picture, kind, name and
 * number, how many it takes and where it is; the player's marked, one
 * taken shown by whom and not chosen. At sea, only the free ones.
 */
export function ChangeBoat({
  chooser: c,
  board = false,
  className = '',
}: {
  chooser: BoatChooser;
  /** On the board, at sea in a port: only the free boats, and one chosen takes the place of the one sailed. */
  board?: boolean;
  className?: string;
}) {
  const f = c.fleet.value;
  if (f === null) {
    return null;
  }
  const k = partsFor(board);
  const atSea = board;
  const busy = c.busy.value;
  const boats = inOrder(c.cat, f.boats).filter((b) => !atSea || !taken(b));
  return (
    <section
      key="change-boat"
      class={`change-boat${className === '' ? '' : ` ${className}`}`}
      aria-labelledby="change-boat-title"
    >
      <Heading level={board ? 2 : 1} id="change-boat-title" text={CHANGE_BOAT} />
      <p class={k.faint}>{atSea ? CHANGE_AT_SEA : CHANGE_ASHORE}</p>
      <ul class="change-boat-list">
        {boats.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              class="change-boat-choice"
              aria-current={b.id === f.boat ? 'true' : undefined}
              disabled={busy || taken(b)}
              onClick={() => void c.choose(b.id)}
            >
              <Picture cat={c.cat} b={b} width={56} />
              <span class="change-boat-words">
                <span class="change-boat-name">
                  <bdi>{boatTitle(c.cat, b)}</bdi>
                </span>
                <span class="change-boat-faint">
                  {aboardWords(kindOf(c.cat, b.kind))} · {standingWords(f, b)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {boats.every((b) => b.id === f.boat) ? <p class={k.faint}>{NONE_FREE}</p> : null}
      <div class="boat-look-foot">
        <p class="boat-look-problem" aria-live="polite">
          {c.problem.value}
        </p>
        <div class="boat-look-actions">
          <button type="button" class={k.cancel} disabled={busy} onClick={() => c.cancel()}>
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}
