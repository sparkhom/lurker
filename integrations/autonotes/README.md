# Lurker Auto-notes — sample MCP integration

A small standalone web app that uses Lurker's MCP API to propose updates to
your nick-notes from recent channel backlog. The operator picks a channel and
depth; Claude reads the backlog, looks up existing notes, and proposes
per-nick merges with evidence linked to the source messages. You review,
edit, and apply.

This app also doubles as the **canonical example of consuming Lurker's MCP
API from an external program**. If you're building your own Lurker
integration, start by reading:

- [`lib/mcpClient.js`](lib/mcpClient.js) — the entire MCP wire protocol in
  ~70 lines (hand-rolled JSON-RPC over `fetch`, no SDK dependency)
- [`lib/agent.js`](lib/agent.js) — how to expose MCP verbs to Claude as
  Anthropic tools and run an agentic tool-use loop

The app lives outside the Lurker server process. It talks to Lurker over
the public MCP endpoint and to Anthropic for the agentic workflow.

## Setup

```sh
cd integrations/autonotes
npm install
cp .env.example .env
# edit .env, set ANTHROPIC_API_KEY
```

## Run

```sh
npm start
```

Then open <http://localhost:5173>.

1. **Config** — paste your Lurker **MCP** URL and an API token. The URL is
   your Lurker base URL with `/mcp` appended (e.g. `http://localhost:8010/mcp`
   or `https://lurker.example.com/mcp`). Mint a token at
   `/settings/api-tokens` in Lurker; pick **read-write** if you want to
   actually apply the proposals. The app will hit `tools/list` to verify
   and tell you the token's scope.
2. **Scan** — pick a network, a buffer, and a backlog depth (default 200).
   Click Scan.
3. **Review** — one card per proposed update. Each card shows the current
   note, the proposed merge (editable), Claude's rationale, and the source
   messages it cited as evidence. Edit, accept, or reject per card; or
   "Apply all remaining" at the bottom.

## How the agent works

The app gives Claude the **read** MCP verbs as tools:

- `recent_messages` — to pull the backlog
- `search_messages` — to fetch extra context on a specific nick
- `get_nick_note` — to read each speaker's existing note
- `list_buffers`, `list_networks` — included but rarely used during a scan

Claude calls these autonomously, decides which speakers need updates, and
emits a final JSON block with proposed merges plus message-id evidence. The
write verbs (`set_nick_note`, `send_message`, `send_action`) are **not**
exposed to Claude — writes only happen when the operator clicks Apply, and
go through the app's own MCP client.

## Things this sample deliberately doesn't do

- Persist scans across restarts. In-memory only.
- Stream Claude's tokens to the browser. The UI polls every 2s.
- Guard against concurrent scans. Nothing rejects a second `POST /api/scan`
  while one is running — the app just assumes a single operator runs one
  scan at a time.
- Automated tests. The agent is non-deterministic; verify by hand against
  a low-traffic channel.

## License

Same as the rest of Lurker — see `../../LICENSE`.
