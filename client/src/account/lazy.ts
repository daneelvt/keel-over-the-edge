// SPDX-License-Identifier: AGPL-3.0-only

// The machine sailors' screens, loaded the first time one is shown: the
// game's first download holds none of them.

import { useEffect, useState } from 'preact/hooks';

type Machines = typeof import('./machines');

let loading: Promise<Machines> | null = null;

/** The machine sailors' module, loaded once; tried again after a failure. */
export function loadMachines(): Promise<Machines> {
  if (loading === null) {
    loading = import('./machines').catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** The machine sailors' module once loaded, or null until then; nothing is loaded until need. */
export function useMachines(need = true): Machines | null {
  const [m, setM] = useState<Machines | null>(null);
  useEffect(() => {
    if (!need) {
      return;
    }
    let live = true;
    loadMachines().then(
      (mod) => {
        if (live) {
          setM(mod);
        }
      },
      () => {
        // Shown as still loading: the menu can be opened again.
      },
    );
    return () => {
      live = false;
    };
  }, [need]);
  return m;
}
