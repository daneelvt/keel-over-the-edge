// SPDX-License-Identifier: AGPL-3.0-only

// The menu: this device's settings. The frame rate (60, or 30 to save
// battery), sound, the beginners' overlays, and whether the helm returns to
// the centre when let go.

import type { SettingsSignal } from './settings';

function Toggle({
  label,
  on,
  set,
  name,
}: {
  label: string;
  on: boolean;
  set: (on: boolean) => void;
  name: string;
}) {
  return (
    <label class="menu-row">
      <span>{label}</span>
      <input
        type="checkbox"
        name={name}
        checked={on}
        onChange={(e) => set(e.currentTarget.checked)}
      />
    </label>
  );
}

export function Menu({ settings, close }: { settings: SettingsSignal; close: () => void }) {
  const s = settings.value.value;
  return (
    <section class="panel menu" aria-label="Settings">
      <h2>Settings</h2>
      <Toggle
        name="battery"
        label="Save battery (30 frames a second)"
        on={s.frameRate === 30}
        set={(on) => settings.set({ frameRate: on ? 30 : 60 })}
      />
      <Toggle name="sound" label="Sound" on={s.sound} set={(sound) => settings.set({ sound })} />
      <Toggle
        name="wind-overlay"
        label="Show the wind"
        on={s.windOverlay}
        set={(windOverlay) => settings.set({ windOverlay })}
      />
      <Toggle
        name="forces-overlay"
        label="Show the sail’s forces"
        on={s.forcesOverlay}
        set={(forcesOverlay) => settings.set({ forcesOverlay })}
      />
      <Toggle
        name="centre-helm"
        label="Centre the helm when let go"
        on={s.centreHelm}
        set={(centreHelm) => settings.set({ centreHelm })}
      />
      <button type="button" class="menu-close" onClick={close}>
        Close
      </button>
    </section>
  );
}
