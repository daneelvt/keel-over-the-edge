// SPDX-License-Identifier: AGPL-3.0-only

// The developer page: the game's name, the server and client versions, what
// this browser offers, and whether the physics module agrees with the server
// here. Everything is built as nodes and text.

import './styles.css';
import { CATALOG_VERSION } from '../catalog';
import { browserEnv, type Capability, readCapabilities } from './capabilities';
import { catalogsMatch, fetchVersion } from './version';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  if (className !== undefined) {
    node.className = className;
  }
  return node;
}

function row(label: string, value: string, ok: boolean | null): HTMLLIElement {
  const li = el('li', undefined, ok === null ? 'row' : ok ? 'row ok' : 'row bad');
  li.append(el('span', label, 'label'), el('span', value, 'value'));
  return li;
}

async function versionRows(): Promise<HTMLLIElement[]> {
  try {
    const server = await fetchVersion();
    const match = catalogsMatch(server, CATALOG_VERSION);
    return [
      row('Server build', server.build, null),
      row(
        'Catalog',
        match
          ? `${server.catalog}, same as this page`
          : `server ${server.catalog}, page ${CATALOG_VERSION}`,
        match,
      ),
    ];
  } catch (err) {
    return [row('Server', err instanceof Error ? err.message : 'unreachable', false)];
  }
}

function capabilityRows(all: Capability[]): HTMLLIElement[] {
  return all.map((c) => row(c.name, c.detail, c.ok));
}

async function physicsRows(): Promise<HTMLLIElement[]> {
  try {
    const { checkPhysics } = await import('./physics');
    return (await checkPhysics()).map((r) => row(r.name, r.detail, r.ok));
  } catch (err) {
    return [row('Physics module', err instanceof Error ? err.message : 'failed to load', false)];
  }
}

async function start(): Promise<void> {
  const main = el('main');
  main.append(el('h1', 'Keel Over the Edge'));

  const versions = el('ul', undefined, 'rows');
  const browser = el('ul', undefined, 'rows');
  const physics = el('ul', undefined, 'rows');
  physics.append(row('Physics module', 'checking…', null));
  main.append(
    el('h2', 'Versions'),
    versions,
    el('h2', 'This browser'),
    browser,
    el('h2', 'Physics'),
    physics,
  );
  document.body.replaceChildren(main);

  const [v, c] = await Promise.all([versionRows(), readCapabilities(browserEnv())]);
  versions.replaceChildren(...v);
  browser.replaceChildren(...capabilityRows(c));
  // After the rest, since it runs twenty thousand steps.
  physics.replaceChildren(...(await physicsRows()));
}

void start();
