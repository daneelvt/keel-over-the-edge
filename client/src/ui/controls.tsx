// SPDX-License-Identifier: AGPL-3.0-only

// The helm and the sheet under the player's thumbs: the helm bottom left,
// an arc with a knob; the sheet bottom right, a slider from Trim (hauled
// in) at the top to Ease (let fly) at the bottom. Each owns its own pointer
// (setPointerCapture), so both thumbs move at once. Each shows its target,
// the knob, and faintly where the rudder and the sheet really are, since
// they follow at the rates a sailor's hands move them. While the sailor is
// out of the boat both are dimmed, and still take the player's setting for
// when the sailor is back.
//
// The sheet's legend says when the sail is luffing, stalled or aback, and
// the end to move it toward lights in gold with an arrow: Trim while it
// luffs, Ease while it stalls. Aback, no sheeting helps, and neither lights.
// Its name and its ends' words are the boat's (the catalog's controls): on
// a boat of square sails it is the braces, from Brace up to Square, and
// aback its legend names them ("Braces · Aback").
//
// The Reef key, brass, stands on the sheet's top: a tap reefs one more,
// its face saying the reef asked for in the boat's words; once reefed a
// second key beside it shakes one out. R and F do the same.

import type { PointerEventHandler as Handler } from 'preact';
import type { HelmInput } from '../input/helm';
import type { SheetInput } from '../input/sheet';
import { HELM_ARC, type HudModel, SHEET_WORDS, sheetLegend } from './model';

/** What the Reef key asks for: the main reefed to a level, 0 (full sail) … 2. */
export interface ReefActions {
  setReef(level: number): void;
}

/** The most reefs a main takes. */
const REEFS = 2;

type PointerHandler = Handler<HTMLDivElement>;

/** Pointer handlers that pass a pointer's place along one axis to a control. */
function handlers(
  control: {
    down(id: number, at: number, t: number): boolean;
    move(id: number, at: number): void;
    up(id: number, t: number): void;
  },
  axis: 'x' | 'y',
): {
  onPointerDown: PointerHandler;
  onPointerMove: PointerHandler;
  onPointerUp: PointerHandler;
  onPointerCancel: PointerHandler;
} {
  const at = (e: PointerEvent): number => (axis === 'x' ? e.clientX : e.clientY);
  const end: PointerHandler = (e) => {
    control.up(e.pointerId, e.timeStamp);
  };
  return {
    onPointerDown: (e) => {
      if (control.down(e.pointerId, at(e), e.timeStamp)) {
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    },
    onPointerMove: (e) => control.move(e.pointerId, at(e)),
    onPointerUp: end,
    onPointerCancel: end,
  };
}

/** An arc of the helm's travel, as an SVG path about (0, 0), radius r. */
function arc(r: number): string {
  const a = (HELM_ARC * Math.PI) / 180;
  const x = r * Math.sin(a);
  const y = -r * Math.cos(a);
  return `M ${-x} ${y} A ${r} ${r} 0 0 1 ${x} ${y}`;
}

export function Helm({ input, model }: { input: HelmInput; model: HudModel }) {
  const dimmed = model.sailor.value !== '';
  return (
    <div
      class={`control helm${dimmed ? ' dimmed' : ''}`}
      role="slider"
      aria-label="Helm"
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={0}
      tabIndex={0}
      ref={(el) => model.helmValue.attach(el)}
      data-control="helm"
      {...handlers(input, 'x')}
    >
      <svg class="helm-arc" viewBox="-60 -56 120 20" aria-hidden="true">
        <path class="slot-rim" d={arc(50)} />
        <path class="slot" d={arc(50)} />
        <line x1="0" y1="-56" x2="0" y2="-44" />
      </svg>
      <div class="helm-swing actual" ref={(el) => model.helmActual.attach(el)}>
        <span class="knob" />
      </div>
      <div class="helm-swing" ref={(el) => model.helmKnob.attach(el)}>
        <span class="knob" />
      </div>
      <span class="control-label">Helm</span>
    </div>
  );
}

/**
 * An end's word long enough ("Brace up") that with its arrow it would not
 * fit the sheet's width, and is set smaller while lit.
 */
function long(word: string): string {
  return word.length > 6 ? ' long' : '';
}

export function Sheet({ input, model }: { input: SheetInput; model: HudModel }) {
  const dimmed = model.sailor.value !== '';
  const sail = model.sail.value;
  const trim = sail === 'luffing';
  const ease = sail === 'stalled';
  const words = model.controls.value?.sheet ?? SHEET_WORDS;
  const legend = sheetLegend(model.controls.value, sail, model.kite.value);
  return (
    <div
      class={`control sheet${dimmed ? ' dimmed' : ''}`}
      role="slider"
      aria-label={words.name}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={0.5}
      tabIndex={0}
      ref={(el) => {
        model.sheetValue.attach(el);
        model.sheetText.attach(el);
      }}
      data-control="sheet"
      data-sail={sail === '' ? undefined : sail}
      {...handlers(input, 'y')}
    >
      <span class={`sheet-end${trim ? ' lit' : ''}${long(words.trim)}`} data-end="trim">
        {trim && (
          <span class="sheet-arrow" aria-hidden="true">
            ▲
          </span>
        )}
        {words.trim}
      </span>
      <div class="sheet-track">
        <div class="sheet-travel actual" ref={(el) => model.sheetActual.attach(el)}>
          <span class="knob" />
        </div>
        <div class="sheet-travel" ref={(el) => model.sheetKnob.attach(el)}>
          <span class="knob" />
        </div>
      </div>
      <span class={`sheet-end${ease ? ' lit' : ''}${long(words.ease)}`} data-end="ease">
        {words.ease}
        {ease && (
          <span class="sheet-arrow" aria-hidden="true">
            ▼
          </span>
        )}
      </span>
      <span
        class={`control-label${sail === '' ? '' : ' sail'}${legend.includes(' · ') ? ' two' : ''}`}
      >
        {legend}
      </span>
    </div>
  );
}

/**
 * The Reef key on the sheet's top, and once reefed the key that shakes a
 * reef out; neither on a boat that does not reef. Dimmed with the sheet
 * while the sailor is out of the boat, and still taking the player's word
 * for when the sailor is back.
 */
export function Reef({ actions, model }: { actions: ReefActions; model: HudModel }) {
  const c = model.controls.value;
  if (c === null || !c.reefs) {
    return null;
  }
  const level = model.reef.value;
  const dimmed = model.sailor.value !== '';
  const words = c.reef[level] ?? '';
  return (
    <div class={`reef-keys${dimmed ? ' dimmed' : ''}`} data-control="reef">
      <button
        type="button"
        class="reef-key"
        aria-label={`Reef: ${words}${level < REEFS ? '; tap to reef' : ''}`}
        data-level={level}
        disabled={level >= REEFS}
        onClick={() => actions.setReef(level + 1)}
      >
        <span class="reef-name">Reef</span>
        <span class="reef-level">{words}</span>
      </button>
      {level > 0 ? (
        <button
          type="button"
          class="reef-key shake"
          aria-label={`Shake out a reef: ${c.reef[level - 1] ?? ''}`}
          onClick={() => actions.setReef(level - 1)}
        >
          <span class="reef-glyph" aria-hidden="true">
            ▲
          </span>
          Shake
        </button>
      ) : null}
    </div>
  );
}
