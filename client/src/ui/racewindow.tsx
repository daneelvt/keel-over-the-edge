// SPDX-License-Identifier: AGPL-3.0-only

// The race's windows' frame. At sea (side) it stands beside the boat, in
// the menu's place, never over it, with no scrim: the helm, the sheet and
// the autopilot still answer while it is open, and only its keys or
// Escape close it. Elsewhere (the chart's replay) it stands centred over
// a scrim, a tap beside it closing it. Its first key takes the focus,
// given back as it closes.

import { useModal } from './modal';

/** A race's window: beside the boat at sea, or centred over a scrim. */
export function Window({
  name,
  title,
  close,
  side = false,
  children,
}: {
  name: string;
  title: preact.ComponentChildren;
  close: () => void;
  /** At sea: beside the boat, with no scrim. */
  side?: boolean;
  children: preact.ComponentChildren;
}) {
  const ref = useModal(close);
  return (
    <>
      {side ? null : <div class="rl-scrim" aria-hidden="true" onClick={close} />}
      <section
        class={`panel rl-window${side ? ' at-side' : ''}`}
        role="dialog"
        aria-modal={!side}
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        ref={ref}
        data-panel={name}
      >
        <h2>{title}</h2>
        {children}
      </section>
    </>
  );
}
