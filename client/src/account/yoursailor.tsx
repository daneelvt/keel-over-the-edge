// SPDX-License-Identifier: AGPL-3.0-only

// The player's own sailor, shown before every voyage: its name, whether its
// boat is in the water, the boat it sails (chosen from the fleet, its look
// set, ashore), whether others may watch it sail, Set sail as it, and
// Watch another sailor. It is the screen's only gold button, as setting
// sail is the only thing there the player does as themselves; their machine
// sailors, when they have any, stand apart beside it. In the game's first
// download, so the screen shows it at once, alone or while the machine
// sailors' module loads. Set sail answers its tap at once: pressed, it says
// it is setting sail until the page's cover takes over.
//
// The name is shown, never asked for or changed here: every account is
// made with its named sailor on the first form, so none reaches this
// screen without one.

import { sailFullScreen } from '../boot/fullscreen';
import { STILL_AT_SEA, WATCH_ANOTHER_SAILOR } from '../ui/watchwords';
import type { BoatChooser } from './boatchooser';
import { BoatLookChooser, ChangeBoat, YourBoat } from './boats';
import type { LookChooser } from './chooser';
import { LetWatch, type Voyage } from './letwatch';
import type { Me } from './me';
import { Picker } from './picker';
import { Portrait } from './portraits';

/** The button that sails the player's own sailor, by its name. */
export function setSailAs(name: string): string {
  return `Set sail as ${name}`;
}

/** What Set sail says once tapped, and the page's cover after it. */
export const SETTING_SAIL = 'Setting sail…';

/** Set sail as a sailor: pressed at once, saying so, while the voyage's choice is sent. */
export function SetSail({
  name,
  voyage,
  sail,
}: {
  name: string;
  voyage: Voyage;
  sail: () => void;
}) {
  const going = voyage.going.value;
  return (
    <button
      type="button"
      class="start-go your-sailor-go"
      disabled={going}
      onClick={() => {
        // In the tap itself: the browser allows the full screen only there.
        sailFullScreen();
        void voyage.sail(sail);
      }}
    >
      {going ? SETTING_SAIL : setSailAs(name)}
    </button>
  );
}

/**
 * The player's panel: sail sets their own sailor to sea, once voyage has
 * sent the box's choice; watch opens the list of sailors to watch, null
 * while it cannot yet. With a chooser, their portrait beside their name
 * and, ashore, Change your look; or the picker, as the chooser has it.
 * With boats, the boat they sail and, ashore, Your boat and Change boat;
 * or the boat's look chosen, or the fleet's boats, as boats has it.
 */
export function YourSailor({
  me,
  voyage,
  sail,
  watch,
  chooser,
  boats,
}: {
  me: Me;
  voyage: Voyage;
  sail: () => void;
  watch: (() => void) | null;
  chooser?: LookChooser;
  boats?: BoatChooser | undefined;
}) {
  const atSea = me.atSea === true;
  const mode = chooser?.mode.value ?? 'shown';
  if (chooser !== undefined && mode !== 'shown') {
    return <ChooseLook chooser={chooser} name={me.name} first={mode === 'once'} />;
  }
  const boat = boats?.mode.value ?? 'shown';
  if (boats !== undefined && boat === 'look') {
    return <BoatLookChooser chooser={boats} className="start-panel" />;
  }
  if (boats !== undefined && boat === 'boats') {
    return <ChangeBoat chooser={boats} className="start-panel" />;
  }
  return (
    <section class="start-panel your-sailor" aria-labelledby="start-title">
      <h1 id="start-title">Keel Over the Edge</h1>
      <h2 id="your-sailor-title">Your sailor</h2>
      <div class="your-sailor-rows">
        <div class="your-sailor-who">
          {chooser === undefined ? null : (
            <Portrait looks={chooser.looks} look={chooser.look.value} size={72} />
          )}
          <div class="your-sailor-words">
            <p class="your-sailor-name">
              <bdi>{me.name}</bdi>
            </p>
            <p class="start-text start-faint" data-readout="at-sea">
              {atSea ? 'at sea' : 'not at sea'}
            </p>
            {chooser !== undefined && !atSea ? (
              <button
                type="button"
                class="start-link your-sailor-change"
                onClick={() => chooser.open()}
              >
                Change your look
              </button>
            ) : null}
          </div>
        </div>
        {boats === undefined ? null : <YourBoat chooser={boats} changes={!atSea} />}
      </div>
      {atSea ? (
        <p class="start-warning" role="note">
          {STILL_AT_SEA}
        </p>
      ) : null}
      <LetWatch voyage={voyage} />
      <SetSail name={me.name} voyage={voyage} sail={sail} />
      <button
        type="button"
        class="start-sign-in"
        disabled={watch === null}
        onClick={watch ?? undefined}
      >
        {WATCH_ANOTHER_SAILOR}
      </button>
    </section>
  );
}

/**
 * The picker on the player's panel: Cancel and Save; or, the first time a
 * sailor made before looks were chosen comes in, Keep (the look drawn for
 * them) and Choose (the look picked).
 */
export function ChooseLook({
  chooser: c,
  name,
  first,
}: {
  chooser: LookChooser;
  name: string;
  first: boolean;
}) {
  const p = c.pick.value;
  const busy = c.busy.value;
  return (
    <section class="start-panel your-sailor choose-look" aria-labelledby="start-title">
      <h1 id="start-title">{first ? 'Choose your look' : 'Change your look'}</h1>
      {first ? (
        <p class="start-text">
          Sailors now choose how they look. We drew one for <bdi>{name}</bdi>: keep it, or choose
          your own.
        </p>
      ) : null}
      <Picker
        looks={c.looks}
        look={p.look}
        choose={(l) => c.choose(l)}
        shuffle={() => c.shuffle()}
        undo={p.before === null ? null : () => c.undo()}
        figure={c.stage !== undefined}
      />
      <p class="start-problem" aria-live="polite">
        {c.problem.value}
      </p>
      <div class="choose-look-actions">
        {first ? (
          <>
            <button
              type="button"
              class="start-sign-in"
              disabled={busy}
              onClick={() => void c.save(c.look.value)}
            >
              Keep
            </button>
            <button type="button" class="start-go" disabled={busy} onClick={() => void c.save()}>
              Choose
            </button>
          </>
        ) : (
          <>
            <button type="button" class="start-sign-in" disabled={busy} onClick={() => c.cancel()}>
              Cancel
            </button>
            <button type="button" class="start-go" disabled={busy} onClick={() => void c.save()}>
              Save
            </button>
          </>
        )}
      </div>
    </section>
  );
}
