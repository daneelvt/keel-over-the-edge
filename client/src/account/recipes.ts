// SPDX-License-Identifier: AGPL-3.0-only

// How each AI app connects to the game's MCP address: one short paragraph
// each, in the app's own words for its menus. Each was checked against the
// app's own documentation, named above it with the day it was read; the
// apps move their menus, so these are read again from time to time. Plain
// data, so a page other than the game's can show them too.

/** A recipe's text: words, and what is typed or pasted as it is. */
export type Part = string | { code: string };

export interface Recipe {
  app: string;
  parts: Part[];
}

/** The name a program that takes one gives the game's MCP server. */
export const SERVER_NAME = 'keel';

/** The recipes, for the MCP address given. */
export function recipes(address: string): Recipe[] {
  const n = SERVER_NAME;
  return [
    // https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp
    // https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities
    // Read 2026-10-25.
    {
      app: 'Claude',
      parts: [
        'On claude.ai or in Claude Desktop, open Customize, then Connectors, choose + Add and Add custom connector. Name it, paste the MCP address, choose Continue, then Add, and approve on the page that opens. A connector added there is in the Claude app on your phone the next time you sign in. The free plan allows one custom connector.',
      ],
    },
    // https://code.claude.com/docs/en/mcp
    // Read 2026-10-25.
    {
      app: 'Claude Code',
      parts: [
        'Run ',
        { code: `claude mcp add --transport http ${n} ${address}` },
        ', then type ',
        { code: '/mcp' },
        ` in Claude Code and choose ${n} to sign in: your browser opens the approval page.`,
      ],
    },
    // https://developers.openai.com/api/docs/guides/custom-mcp-server
    // https://developers.openai.com/plugins/deploy/connect-chatgpt
    // https://help.openai.com/en/articles/12584461-creating-custom-mcp-apps-in-chatgpt
    // Read 2026-10-25.
    {
      app: 'ChatGPT',
      parts: [
        'On chatgpt.com, go to chatgpt.com/plugins, choose + and Add custom MCP server. Paste the MCP address as the server URL, choose OAuth, then Create as a plugin, and install it. Only some plans can add one: OpenAI’s help centre names them.',
      ],
    },
    // https://support.google.com/gemini/answer/17209137?hl=en&co=GENIE.Platform%3DDesktop
    // https://geminicli.com/docs/tools/mcp-server/
    // Read 2026-10-25.
    {
      app: 'Gemini',
      parts: [
        'In the Gemini web app on a computer, open Settings, then Connected Apps, choose Add a custom app, paste the MCP address and choose Next; it then works on your phone too. It is for adults in the US with a personal Google Account. Elsewhere, Gemini CLI: run ',
        { code: `gemini mcp add --transport http ${n} ${address}` },
        ', then ',
        { code: `/mcp auth ${n}` },
        '.',
      ],
    },
    // https://learn.chatgpt.com/docs/extend/mcp?surface=cli (developers.openai.com/codex/mcp)
    // Read 2026-10-25.
    {
      app: 'Codex',
      parts: [
        'Run ',
        { code: `codex mcp add ${n} --url ${address}` },
        ', then ',
        { code: `codex mcp login ${n}` },
        ' to sign in. The Codex CLI, its IDE extension and the ChatGPT desktop app share it.',
      ],
    },
    // https://code.visualstudio.com/docs/copilot/customization/mcp-servers
    // https://code.visualstudio.com/docs/copilot/reference/mcp-configuration
    // Read 2026-10-25.
    {
      app: 'VS Code',
      parts: [
        `In the Command Palette, run MCP: Add Server, choose HTTP, paste the MCP address and name it ${n}. On its first connection a browser window opens for the approval.`,
      ],
    },
    // No app's documentation: the game's own connection token, made on the
    // account page and sent as an OAuth bearer token is (RFC 6750).
    {
      app: 'Other programs',
      parts: [
        'A program that can only send a header: make a connection token for the machine sailor on the account page, and have the program send ',
        { code: 'Authorization: Bearer <token>' },
        ' to the MCP address.',
      ],
    },
  ];
}

/** What to tell an AI app first, to see it sail. */
export const STARTER = 'Sail to the nearest charted island and tell me what you see.';

/**
 * How to let each app sail, once connected: an agent sails by calling the
 * game's tools in a loop, observe with a wait, then steer and trim, so an
 * app must be let call them without asking each time, and must hold a
 * call for the wait (up to 50 s; 25 is safe in every app).
 */
export function sailing(): Recipe[] {
  const n = SERVER_NAME;
  return [
    // https://code.claude.com/docs/en/cli-reference
    // https://code.claude.com/docs/en/mcp
    // Read 2026-10-25.
    {
      app: 'Claude Code',
      parts: [
        'Let it call the game’s tools without asking, and give it the first instruction: ',
        { code: `claude -p "${STARTER}" --allowedTools "mcp__${n}__*"` },
        '. In a session of your own, ',
        { code: '/loop' },
        ' keeps it sailing. A wait longer than its tool timeout needs ',
        { code: 'MCP_TOOL_TIMEOUT=60000' },
        '.',
      ],
    },
    // https://openai.github.io/openai-agents-python/mcp/
    // https://openai.github.io/openai-agents-python/running_agents/
    // Read 2026-10-25.
    {
      app: 'OpenAI Agents SDK',
      parts: [
        'Raise the MCP session’s read timeout above the wait, ',
        { code: 'client_session_timeout_seconds=60' },
        ' on ',
        { code: 'MCPServerStreamableHttp' },
        ', and the run’s turns, ',
        { code: 'max_turns' },
        ': a passage takes hundreds of calls.',
      ],
    },
    // https://learn.chatgpt.com/docs/extend/mcp?surface=cli
    // Read 2026-10-25.
    {
      app: 'Codex',
      parts: [
        `Under [mcp_servers.${n}] in its config.toml, set `,
        { code: 'tool_timeout_sec = 80' },
        ' so a wait fits, and a ',
        { code: 'default_tools_approval_mode' },
        ' that runs the game’s tools without asking; then ',
        { code: `codex exec "${STARTER}"` },
        '.',
      ],
    },
    // https://geminicli.com/docs/tools/mcp-server/
    // Read 2026-10-25.
    {
      app: 'Gemini CLI',
      parts: [
        'Give it a timeout above the wait in its settings, ',
        { code: '"timeout": 60000' },
        ` under mcpServers.${n}, and run `,
        { code: `gemini --yolo -p "${STARTER}"` },
        '.',
      ],
    },
    {
      app: 'Chat apps',
      parts: [
        'Claude, ChatGPT and the Gemini app stop after a number of steps: say Continue to sail on. Ask it to observe with a wait of 25, which every app holds. Your boat stays at sea only while it keeps calling.',
      ],
    },
    {
      app: 'A program',
      parts: [
        'With a connection token: call observe with wait 25 in a loop, then steer and trim as it says. The game’s handbook tool teaches the rest.',
      ],
    },
  ];
}

/** A recipe as plain text. */
export function recipeText(r: Recipe): string {
  return r.parts.map((p) => (typeof p === 'string' ? p : p.code)).join('');
}
