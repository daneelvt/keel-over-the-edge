// SPDX-License-Identifier: AGPL-3.0-only

// What a screen that chooses a look asks of the picker's stage, the game's
// renderer drawing the sailor behind it (render/pickerstage.ts): the look
// to stand there, the camera's view, a drag's turn, and whether the figure
// is drawn yet, the portrait standing in its place until it is. A page that
// draws nothing has none.

import type { ReadonlySignal } from '@preact/signals';
import type { Look } from '../catalog/looks';

export type StageView = 'front' | 'behind' | 'face';

export interface LookStage {
  /** Stands a look on the stage, the stage shown behind the screen. */
  show(look: Look): void;
  /** Takes the stage away: the cover comes back over the page. */
  hide(): void;
  view(v: StageView): void;
  /** Turns the figure by a drag of dx CSS pixels across a screen width wide. */
  turn(dx: number, width: number): void;
  /** Whether the figure is drawn. */
  readonly figure: ReadonlySignal<boolean>;
}
