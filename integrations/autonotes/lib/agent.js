import Anthropic from "@anthropic-ai/sdk";
import { McpToolError } from "./mcpClient.js";

// Sonnet 4.6 is well-matched to this workload (structured analysis with
// tools, not intelligence-demanding). Opus 4.7 works but burns ~3x the cost
// for marginal quality gains. If you bump the model, update PRICING in
// public/app.js so the trace's cost estimate stays accurate.
const MODEL = "claude-sonnet-4-6";
const MAX_TOOL_CALLS = 20;
const MAX_TOKENS = 16000;

// Read-only MCP verbs exposed to Claude. Shapes copied from Lurker's
// tools/list (server/services/verbs/*.js). Hardcoded rather than fetched at
// runtime so the prompt prefix stays byte-identical across scans — that's
// what makes prompt caching on the system block actually pay off.
const TOOLS = [
  {
    name: "recent_messages",
    description:
      "Fetch a window of recent messages for one buffer (channel or DM) on a network. Returns { messages: [...], hasOlder: boolean }. Each message has id, time (Unix ms), nick, text, type, self, dm. Paginate backwards with `before`. Use this first to pull the backlog.",
    input_schema: {
      type: "object",
      properties: {
        networkId: { type: "integer", description: "Network id (from list_networks)" },
        target: { type: "string", description: "Channel name (e.g. '#lurker') or peer nick" },
        limit: { type: "integer", description: "Default 100, max 500" },
        before: { type: "integer", description: "Lowest id from prior page, for older messages" },
      },
      required: ["networkId", "target"],
    },
  },
  {
    name: "search_messages",
    description:
      "Full-text search across message history. Use after recent_messages when you need extra context on a specific nick (e.g. pass nick + a topic keyword). Returns same message shape as recent_messages.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query (SQLite FTS5; multiple terms ANDed)" },
        networkId: { type: "integer" },
        target: { type: "string" },
        nick: { type: "string", description: "Restrict to messages from this nick" },
        limit: { type: "integer", description: "Default 50, max 100" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_nick_note",
    description:
      "Read the operator's existing free-form note about a nick on a network. Returns { networkId, nick, note, updatedAt }. note is empty string when none exists.",
    input_schema: {
      type: "object",
      properties: {
        networkId: { type: "integer" },
        nick: { type: "string" },
      },
      required: ["networkId", "nick"],
    },
  },
  {
    name: "list_buffers",
    description:
      "List channels and DMs with history on the operator's account, optionally filtered by networkId. Rarely needed during a scan — the buffer is already chosen.",
    input_schema: {
      type: "object",
      properties: {
        networkId: { type: "integer" },
      },
    },
  },
  {
    name: "list_networks",
    description:
      "List networks with connection state and the operator's current nick. Useful only if you need the operator's own nick to filter (you can already use message.self).",
    input_schema: { type: "object", properties: {} },
  },
];

const SYSTEM_PROMPT = `You are an assistant that proposes refined nick-notes for an IRC operator based on recent channel chatter.

The operator keeps short free-form notes about individual nicks — facts and observations like "lives in oslo, runs lurker dev, uses neovim". A good nick-note is terse, factual, and mergeable across many small additions over time. It is NOT a summary of what someone said today.

Your job for each scan:

1. Call recent_messages on the chosen buffer to pull the backlog at the requested depth.
2. Identify the speakers. Skip any message where self is true (those are the operator). Skip nicks with fewer than 3 substantive messages — small samples lead to bad notes.
3. For each remaining nick, call get_nick_note to read the existing note.
4. Optionally call search_messages with the nick (and a topic keyword) when you need more context to justify or merge an update.
5. Propose an updated note ONLY when the new backlog reveals something useful that isn't already captured. Skip nicks where the existing note is already accurate and the backlog adds nothing.

Hard rules:
- Cite specific message ids as evidence for every proposed change. Never propose without evidence.
- Preserve existing facts in the proposed note unless they contradict newer evidence — additions should read as merges.
- Keep proposed notes terse. One line. Comma-separated facts, lower-case, no first-person.
- Do not invent biographical details. If a fact isn't in the cited messages, do not include it.
- You have a budget of about ${MAX_TOOL_CALLS} tool calls per scan. Spend them on backlog ingest and a small number of targeted searches.

When you have finished investigating, stop calling tools and emit exactly one final message containing a single \`\`\`json fenced code block with this shape:

\`\`\`json
{
  "proposals": [
    {
      "nick": "string",
      "currentNote": "string (empty if none)",
      "proposedNote": "string",
      "rationale": "one short sentence explaining the merge",
      "evidence": [<messageId>, <messageId>, ...]
    }
  ]
}
\`\`\`

If you have nothing useful to propose for this scan, emit \`{ "proposals": [] }\` — that is a valid outcome.`;

export async function runScan({ scan, mcpClient, onProgress, onEvent }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in the integration's environment");
  }
  const client = new Anthropic();
  const emit = (ev) => onEvent?.(ev);

  // Track every message Claude sees, keyed by id, so the review UI can render
  // the evidence linked to each proposal without re-fetching.
  const messageCache = new Map();

  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  const messages = [
    {
      role: "user",
      content: `Analyze the buffer \`${scan.target}\` on network ${scan.networkId} at depth ${scan.depth}. Start with recent_messages.`,
    },
  ];

  for (let turn = 0; turn < MAX_TOOL_CALLS + 2; turn++) {
    const turnStartedAt = Date.now();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: TOOLS,
      messages,
    });

    accumulateUsage(totals, response.usage);
    emit({
      type: "turn",
      turn,
      stopReason: response.stop_reason,
      durationMs: Date.now() - turnStartedAt,
      usage: pickUsage(response.usage),
      totals: { ...totals },
    });

    // Walk content blocks in order so the trace reads top-to-bottom: thinking,
    // any narration text, then tool calls — matching what Claude actually did
    // during this turn.
    for (const block of response.content) {
      if (block.type === "thinking" && block.thinking) {
        emit({ type: "thinking", turn, text: block.thinking });
      } else if (block.type === "text" && block.text) {
        emit({ type: "text", turn, text: block.text });
      } else if (block.type === "tool_use") {
        emit({
          type: "tool_use",
          turn,
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        });
      }
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const proposals = extractProposals(response.content);
      return { proposals, messages: messageCacheToObject(messageCache) };
    }

    if (response.stop_reason !== "tool_use") {
      throw new Error(`Unexpected stop_reason from agent: ${response.stop_reason}`);
    }

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      throw new Error("Agent stopped on tool_use with no tool blocks");
    }

    if (scan.toolCallCount + toolUses.length > MAX_TOOL_CALLS) {
      throw new Error(
        `Agent exceeded tool-call budget (${MAX_TOOL_CALLS}). Try a smaller depth.`,
      );
    }

    const toolResults = [];
    for (const tu of toolUses) {
      const { resultBlock, summary, isError } = await invokeTool(
        mcpClient,
        tu,
        messageCache,
      );
      toolResults.push(resultBlock);
      scan.toolCallCount += 1;
      emit({
        type: "tool_result",
        turn,
        toolUseId: tu.id,
        name: tu.name,
        summary,
        isError,
      });
      onProgress?.(scan);
    }

    messages.push({ role: "user", content: toolResults });
  }

  throw new Error("Agent loop ran past safety bound without producing proposals");
}

async function invokeTool(mcpClient, toolUse, messageCache) {
  try {
    const payload = await mcpClient.toolCall(toolUse.name, toolUse.input ?? {});
    cacheMessagesFromPayload(toolUse.name, payload, messageCache);
    return {
      resultBlock: {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(payload),
      },
      summary: summarizeToolResult(toolUse.name, payload),
      isError: false,
    };
  } catch (err) {
    const payload = err instanceof McpToolError ? err.payload : { error: err.message };
    return {
      resultBlock: {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(payload ?? { error: err.message }),
        is_error: true,
      },
      summary: `error: ${err.message}`,
      isError: true,
    };
  }
}

function summarizeToolResult(name, payload) {
  if (!payload || typeof payload !== "object") return String(payload).slice(0, 120);

  if (name === "recent_messages" || name === "search_messages") {
    const msgs = Array.isArray(payload.messages) ? payload.messages : [];
    if (msgs.length === 0) return "0 messages";
    const nicks = new Set(msgs.map((m) => m.nick).filter(Boolean));
    const oldest = formatTs(msgs[0]?.time);
    const newest = formatTs(msgs[msgs.length - 1]?.time);
    const more =
      "hasOlder" in payload
        ? `hasOlder=${payload.hasOlder}`
        : "hasMore" in payload
          ? `hasMore=${payload.hasMore}`
          : "";
    return `${msgs.length} msgs from ${nicks.size} nicks (${oldest} → ${newest})${more ? `, ${more}` : ""}`;
  }

  if (name === "get_nick_note") {
    const note = String(payload.note ?? "");
    return note ? `note: ${truncate(note, 100)}` : "(no existing note)";
  }

  if (Array.isArray(payload)) return `${payload.length} item${payload.length === 1 ? "" : "s"}`;

  return truncate(JSON.stringify(payload), 120);
}

function formatTs(t) {
  if (typeof t !== "number") return "?";
  return new Date(t).toISOString().slice(0, 16).replace("T", " ");
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function accumulateUsage(totals, usage) {
  if (!usage) return;
  for (const k of Object.keys(totals)) {
    totals[k] += usage[k] || 0;
  }
}

function pickUsage(usage) {
  if (!usage) return null;
  const { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } =
    usage;
  return {
    input_tokens: input_tokens || 0,
    output_tokens: output_tokens || 0,
    cache_creation_input_tokens: cache_creation_input_tokens || 0,
    cache_read_input_tokens: cache_read_input_tokens || 0,
  };
}

function cacheMessagesFromPayload(toolName, payload, messageCache) {
  if (toolName !== "recent_messages" && toolName !== "search_messages") return;
  const list = Array.isArray(payload?.messages) ? payload.messages : [];
  for (const m of list) {
    if (typeof m?.id === "number") messageCache.set(m.id, m);
  }
}

function messageCacheToObject(messageCache) {
  const out = {};
  for (const [id, msg] of messageCache) out[id] = msg;
  return out;
}

function extractProposals(content) {
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const fence = text.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = fence ? fence[1].trim() : text.trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Agent did not return parseable JSON: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.proposals)) {
    throw new Error("Agent JSON missing 'proposals' array");
  }
  return parsed.proposals
    .map((p) => ({
      nick: String(p.nick ?? "").trim(),
      currentNote: String(p.currentNote ?? ""),
      proposedNote: String(p.proposedNote ?? "").trim(),
      rationale: String(p.rationale ?? ""),
      evidence: Array.isArray(p.evidence)
        ? p.evidence.filter((id) => typeof id === "number")
        : [],
    }))
    // Drop malformed proposals — an empty nick or note would render a broken
    // review card and make /api/apply call set_nick_note with junk.
    .filter((p) => p.nick && p.proposedNote);
}
