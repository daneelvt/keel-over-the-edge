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

import type { PointerEventHandler as Handler } from 'preact';
import type { HelmInput } from '../input/helm';
import type { SheetInput } from '../input/sheet';
import { HELM_ARC, type HudModel, type SailState } from './model';

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

/** The sheet's legend for what the sail is doing: its own name while the sail draws. */
const SAIL_LEGENDS: Record<SailState, string> = {
  '': 'Sheet',
  luffing: 'Luffing',
  stalled: 'Stalled',
  aback: 'Aback',
};

export function Sheet({ input, model }: { input: SheetInput; model: HudModel }) {
  const dimmed = model.sailor.value !== '';
  const sail = model.sail.value;
  const trim = sail === 'luffing';
  const ease = sail === 'stalled';
  return (
    <div
      class={`control sheet${dimmed ? ' dimmed' : ''}`}
      role="slider"
      aria-label="Sheet"
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
      <span class={`sheet-end${trim ? ' lit' : ''}`} data-end="trim">
        {trim && (
          <span class="sheet-arrow" aria-hidden="true">
            ▲
          </span>
        )}
        Trim
      </span>
      <div class="sheet-track">
        <div class="sheet-travel actual" ref={(el) => model.sheetActual.attach(el)}>
          <span class="knob" />
        </div>
        <div class="sheet-travel" ref={(el) => model.sheetKnob.attach(el)}>
          <span class="knob" />
        </div>
      </div>
      <span class={`sheet-end${ease ? ' lit' : ''}`} data-end="ease">
        Ease
        {ease && (
          <span class="sheet-arrow" aria-hidden="true">
            ▼
          </span>
        )}
      </span>
      <span class={`control-label${sail === '' ? '' : ' sail'}`}>{SAIL_LEGENDS[sail]}</span>
    </div>
  );
}
