// SPDX-License-Identifier: AGPL-3.0-only

// The race's windows' frame: over the sea, centred, a tap beside it or
// Escape closing it; its first key takes the focus, given back as it
// closes.

import { useModal } from './modal';

/** A window over the sea, a tap beside it closing it. */
export function Window({
  name,
  title,
  close,
  children,
}: {
  name: string;
  title: preact.ComponentChildren;
  close: () => void;
  children: preact.ComponentChildren;
}) {
  const ref = useModal(close);
  return (
    <>
      <div class="rl-scrim" aria-hidden="true" onClick={close} />
      <section
        class="panel rl-window"
        role="dialog"
        aria-modal="true"
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
