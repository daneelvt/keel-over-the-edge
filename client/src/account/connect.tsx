// SPDX-License-Identifier: AGPL-3.0-only

// How to connect an AI app to a machine sailor: the game's MCP address,
// to copy, and a short recipe for each app. The app opens the approval
// page, where the player chooses which machine sailor it sails.

import { useState } from 'preact/hooks';
import { type Part, recipes, STARTER, sailing } from './recipes';

function Parts({ parts }: { parts: Part[] }) {
  return (
    <p>
      {parts.map((p, i) =>
        typeof p === 'string' ? <span key={i}>{p}</span> : <code key={i}>{p.code}</code>,
      )}
    </p>
  );
}

/** The MCP address, with Copy. */
export function Address({ mcp }: { mcp: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mcp);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <span class="start-label">MCP address</span>
      <p class="machine-address" data-mcp={mcp}>
        {mcp}
      </p>
      <button type="button" class="start-sign-in" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </>
  );
}

/** The recipes, one paragraph an app. */
export function Recipes({ mcp }: { mcp: string }) {
  return (
    <ul class="connect-recipes">
      {recipes(mcp).map((r) => (
        <li key={r.app}>
          <h3>{r.app}</h3>
          <Parts parts={r.parts} />
        </li>
      ))}
    </ul>
  );
}

/** How to let each app sail, once connected, and what to tell it first. */
export function Sailing() {
  return (
    <>
      <p class="start-text">
        Then tell it: <q>{STARTER}</q> It sails by calling the game’s tools in a loop; each app
        needs letting do that.
      </p>
      <ul class="connect-recipes connect-sailing">
        {sailing().map((r) => (
          <li key={r.app}>
            <h3>{r.app}</h3>
            <Parts parts={r.parts} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** How to connect: for the machine sailor named, or any when name is empty. */
export function Connect({ mcp, name }: { mcp: string; name: string }) {
  return (
    <>
      <p class="start-text">
        Add the game to your AI app with this address. The app opens a page of the game’s, where you
        approve it with your passkey
        {name !== '' ? (
          <>
            {' '}
            and choose <bdi>{name}</bdi>
          </>
        ) : null}
        .
      </p>
      <Address mcp={mcp} />
      <Recipes mcp={mcp} />
      <Sailing />
    </>
  );
}
