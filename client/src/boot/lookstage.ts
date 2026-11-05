// SPDX-License-Identifier: AGPL-3.0-only

// The picker's stage in the game's page: the sailor a look is chosen for,
// drawn by the game's renderer in place of the sea while the start screen
// or the player's own panel chooses it, the cover standing aside; the cover
// back once the choice is made.

import { signal } from '@preact/signals';
import type { LookStage } from '../account/lookstage';
import { catalog } from '../catalog';
import { codeOf, type Look } from '../catalog/looks';
import { lazyArtUrl } from '../render/boat';
import { PickerStage } from '../render/pickerstage';
import { type SeaScene, sailorLookOf } from '../render/scene';
import type { Cover } from './cover';

/** How often a stage asked for before the renderer is ready asks again, ms. */
const RETRY = 100;

export function lookStage(world: SeaScene, cover: Cover): LookStage {
  const stage = new PickerStage(lazyArtUrl, () => world.stage.renderer);
  const figure = signal(false);
  stage.onShown = (shown) => {
    figure.value = shown;
  };
  let on = false;
  let wanted: Look | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const show = () => {
    retry = null;
    if (wanted === null) {
      return;
    }
    if (world.stage.renderer === null) {
      // The renderer is still being made: the portrait stands in.
      retry = setTimeout(show, RETRY);
      return;
    }
    if (!on) {
      on = true;
      stage.open = true;
      world.cover = stage;
      world.stage.loopDraws = true;
      cover.aside(true);
    }
    void stage.setLook(sailorLookOf(catalog, codeOf(catalog, wanted)));
  };
  return {
    figure,
    show(look) {
      wanted = look;
      if (retry === null) {
        show();
      }
    },
    hide() {
      wanted = null;
      if (retry !== null) {
        clearTimeout(retry);
        retry = null;
      }
      if (!on) {
        return;
      }
      on = false;
      stage.open = false;
      world.cover = null;
      world.stage.loopDraws = false;
      cover.aside(false);
    },
    view(v) {
      stage.view = v;
    },
    turn(dx, width) {
      stage.turn(dx, width);
    },
  };
}
