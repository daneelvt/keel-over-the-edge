// SPDX-License-Identifier: AGPL-3.0-only

// The player's own sailor, shown before every voyage: its name, whether its
// boat is in the water, the boat it sails (chosen from the fleet, its look
// set, ashore), whether others may watch it sail, Set sail as it, Watch
// another sailor, and Make a race. It is the screen's only gold button, as setting
// sail is the only thing there the player does as themselves; their machine
// sailors, when they have any, stand apart beside it. In the game's first
// download, so the screen shows it at once, alone or while the machine
// sailors' module loads. Set sail answers its tap at once: pressed, it says
// it is setting sail until the page's cover takes over. With the boat still
// in the water, Set sail sails it on where it lies; under it, Start again
// at Port Royal takes it out and sets sail at the start; and every way off
// the screen that would take it out asks first (takeout.tsx).
//
// The name is shown, never asked for or changed here: every account is
// made with its named sailor on the first form, so none reaches this
// screen without one.

import { sailFullScreen } from '../boot/fullscreen';
import { MAKE_A_RACE } from '../ui/racewords';
import { START_AGAIN, STILL_AT_SEA, WATCH_ANOTHER_SAILOR } from '../ui/watchwords';
import type { BoatChooser } from './boatchooser';
import { BoatLookChooser, ChangeBoat, YourBoat } from './boats';
import type { LookChooser } from './chooser';
import { LetWatch, type Voyage } from './letwatch';
import type { Me } from './me';
import { Picker } from './picker';
import { Portrait } from './portraits';
import { type TakeOut, TakeOutQuestion } from './takeout';
import { LinkRefused, YourLink } from './yourlink';

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

/** Does act at once: no boat in the water to ask about. */
const now = (act: () => void, tap?: () => void): void => {
  tap?.();
  act();
};

/**
 * The player's panel: sail sets their own sailor to sea, once voyage has
 * sent the box's choice; watch opens the list of sailors to watch, null
 * while it cannot yet. With out, a boat still in the water: the question
 * before it is taken out, in the panel's place while it is asked. At its head, a link to watch the page was opened at
 * that opened no watch, and why; watchName watches a sailor followed from
 * it once it may be watched. Under Set sail, the player's own link to
 * watch them, to share: below it, so that Set sail stays in view. With a chooser, their portrait beside their name
 * and, ashore, Change your look; or the picker, as the chooser has it.
 * With boats, the boat they sail and, ashore, Your boat and Change boat;
 * or the boat's look chosen, or the fleet's boats, as boats has it.
 */
export function YourSailor({
  me,
  voyage,
  sail,
  watch,
  watchName,
  chooser,
  boats,
  race,
  out,
}: {
  me: Me;
  voyage: Voyage;
  sail: () => void;
  watch: (() => void) | null;
  watchName?: (name: string) => void;
  chooser?: LookChooser;
  boats?: BoatChooser | undefined;
  /** Make a race, before setting sail; none for no key. */
  race?: () => void;
  /** The boat still in the water, and the question before it is taken out; none for none. */
  out?: TakeOut | undefined;
}) {
  const atSea = out?.atSea.value ?? me.atSea === true;
  const guard = out?.guard ?? now;
  if (out !== undefined && out.asking.value !== null) {
    return <TakeOutQuestion out={out} />;
  }
  const mode = chooser?.mode.value ?? 'shown';
  if (chooser !== undefined && mode !== 'shown') {
    return <ChooseLook chooser={chooser} name={me.name} first={mode === 'once'} guard={guard} />;
  }
  const boat = boats?.mode.value ?? 'shown';
  if (boats !== undefined && boat === 'look') {
    return <BoatLookChooser chooser={boats} className="start-panel" guard={guard} />;
  }
  if (boats !== undefined && boat === 'boats') {
    return <ChangeBoat chooser={boats} className="start-panel" guard={guard} />;
  }
  return (
    <section class="start-panel your-sailor" aria-labelledby="start-title">
      <h1 id="start-title">Keel Over the Edge</h1>
      {me.linkNote !== undefined ? (
        <LinkRefused note={me.linkNote} watch={(name) => watchName?.(name)} />
      ) : null}
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
            {chooser !== undefined ? (
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
        {boats === undefined ? null : <YourBoat chooser={boats} changes={true} />}
      </div>
      {atSea ? (
        <p class="start-warning" role="note">
          {STILL_AT_SEA}
        </p>
      ) : null}
      <LetWatch voyage={voyage} />
      <SetSail name={me.name} voyage={voyage} sail={sail} />
      {atSea && out !== undefined ? (
        <button
          type="button"
          class="start-link your-sailor-again"
          disabled={voyage.going.value}
          onClick={() => guard(() => void voyage.sail(sail), sailFullScreen)}
        >
          {START_AGAIN}
        </button>
      ) : null}
      <YourLink me={me} ticked={voyage.on.value} />
      <button
        type="button"
        class="start-sign-in"
        disabled={watch === null}
        onClick={watch === null ? undefined : () => guard(watch)}
      >
        {WATCH_ANOTHER_SAILOR}
      </button>
      {race !== undefined ? (
        <button type="button" class="start-sign-in" onClick={race}>
          {MAKE_A_RACE}
        </button>
      ) : null}
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
  guard = now,
}: {
  chooser: LookChooser;
  name: string;
  first: boolean;
  /** Asks first, with the boat still in the water, before the look is saved. */
  guard?: (act: () => void) => void;
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
              onClick={() => guard(() => void c.save(c.look.value))}
            >
              Keep
            </button>
            <button
              type="button"
              class="start-go"
              disabled={busy}
              onClick={() => guard(() => void c.save())}
            >
              Choose
            </button>
          </>
        ) : (
          <>
            <button type="button" class="start-sign-in" disabled={busy} onClick={() => c.cancel()}>
              Cancel
            </button>
            <button
              type="button"
              class="start-go"
              disabled={busy}
              onClick={() => guard(() => void c.save())}
            >
              Save
            </button>
          </>
        )}
      </div>
    </section>
  );
}
