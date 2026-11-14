// SPDX-License-Identifier: AGPL-3.0-only

// The race's windows' frame: over the sea, centred, a tap beside it or
// Escape closing it.

import { useEffect, useRef } from 'preact/hooks';

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
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <div class="rl-scrim" aria-hidden="true" onClick={close} />
      <section
        class="panel rl-window"
        role="dialog"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        ref={ref}
        data-panel={name}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            close();
          }
        }}
      >
        <h2>{title}</h2>
        {children}
      </section>
    </>
  );
}
