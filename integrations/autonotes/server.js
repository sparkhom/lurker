import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { loadConfig, saveConfig, maskToken } from "./lib/config.js";
import { McpClient, McpError } from "./lib/mcpClient.js";
import { runScan } from "./lib/agent.js";
import {
  createScan,
  getScan,
  updateScan,
  finishScan,
  errorScan,
  appendEvent,
} from "./lib/scans.js";

const PORT = Number(process.env.PORT) || 5173;
const here = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(resolve(here, "public")));

async function buildMcpClient() {
  const cfg = await loadConfig();
  if (!cfg.lurkerUrl || !cfg.lurkerToken) {
    const err = new Error("Lurker URL and token are not configured");
    err.statusCode = 400;
    throw err;
  }
  return new McpClient({ url: cfg.lurkerUrl, token: cfg.lurkerToken });
}

app.get("/api/config", async (_req, res, next) => {
  try {
    const cfg = await loadConfig();
    res.json({
      lurkerUrl: cfg.lurkerUrl,
      lurkerToken: cfg.lurkerToken ? maskToken(cfg.lurkerToken) : "",
      hasToken: Boolean(cfg.lurkerToken),
      anthropicKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
      lastNetworkId: cfg.lastNetworkId,
      lastTarget: cfg.lastTarget,
      lastDepth: cfg.lastDepth,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/config", async (req, res, next) => {
  try {
    // Trim — pasted URLs and tokens routinely carry a trailing newline, which
    // saves a "valid-looking" config that then fails auth later.
    const lurkerUrl = typeof req.body?.lurkerUrl === "string" ? req.body.lurkerUrl.trim() : "";
    const lurkerToken =
      typeof req.body?.lurkerToken === "string" ? req.body.lurkerToken.trim() : "";
    if (!lurkerUrl || !lurkerToken) {
      return res.status(400).json({ error: "lurkerUrl and lurkerToken are required" });
    }
    const probe = new McpClient({ url: lurkerUrl, token: lurkerToken });
    const tools = await probe.toolsList();
    const toolNames = (tools?.tools ?? []).map((t) => t.name);
    const scope = toolNames.includes("set_nick_note") ? "read-write" : "read";

    await saveConfig({ lurkerUrl, lurkerToken });
    res.json({ ok: true, scope, toolNames });
  } catch (err) {
    if (err instanceof McpError) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

app.get("/api/networks", async (_req, res, next) => {
  try {
    const mcp = await buildMcpClient();
    const result = await mcp.toolCall("list_networks", {});
    res.json(Array.isArray(result) ? result : result?.networks ?? []);
  } catch (err) {
    next(err);
  }
});

app.get("/api/buffers", async (req, res, next) => {
  try {
    const mcp = await buildMcpClient();
    const networkId = req.query.networkId ? Number(req.query.networkId) : undefined;
    const args = networkId ? { networkId } : {};
    const result = await mcp.toolCall("list_buffers", args);
    res.json(Array.isArray(result) ? result : result?.buffers ?? []);
  } catch (err) {
    next(err);
  }
});

app.post("/api/scan", async (req, res, next) => {
  try {
    const { networkId, target, depth } = req.body ?? {};
    if (typeof networkId !== "number" || !target) {
      return res.status(400).json({ error: "networkId (number) and target (string) are required" });
    }
    const cleanDepth = Math.max(1, Math.min(500, Number(depth) || 200));

    const scan = createScan({ networkId, target, depth: cleanDepth });
    await saveConfig({ lastNetworkId: networkId, lastTarget: target, lastDepth: cleanDepth });
    res.json({ scanId: scan.id });

    // Fire-and-forget: agent runs while the HTTP response has already returned.
    // The UI polls /api/scan/:id for progress.
    (async () => {
      try {
        const mcp = await buildMcpClient();
        const { proposals, messages } = await runScan({
          scan,
          mcpClient: mcp,
          onProgress: (s) => updateScan(s.id, { toolCallCount: s.toolCallCount }),
          onEvent: (ev) => appendEvent(scan.id, ev),
        });
        finishScan(scan.id, { proposals, messages });
      } catch (err) {
        console.error(`[scan ${scan.id}] failed:`, err);
        errorScan(scan.id, err);
      }
    })();
  } catch (err) {
    next(err);
  }
});

app.get("/api/scan/:id", (req, res) => {
  const scan = getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: "scan not found" });
  res.json({
    id: scan.id,
    status: scan.status,
    networkId: scan.networkId,
    target: scan.target,
    depth: scan.depth,
    toolCallCount: scan.toolCallCount,
    proposals: scan.proposals,
    messages: scan.messages,
    events: scan.events,
    error: scan.error,
    startedAt: scan.startedAt,
    finishedAt: scan.finishedAt,
  });
});

app.post("/api/apply", async (req, res, next) => {
  try {
    const { scanId, items } = req.body ?? {};
    const scan = getScan(scanId);
    if (!scan) return res.status(404).json({ error: "scan not found" });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items must be a non-empty array" });
    }

    const mcp = await buildMcpClient();
    const results = [];
    for (const item of items) {
      if (typeof item?.nick !== "string" || typeof item?.note !== "string") {
        results.push({ nick: item?.nick, ok: false, error: "invalid item" });
        continue;
      }
      try {
        const written = await mcp.toolCall("set_nick_note", {
          networkId: scan.networkId,
          nick: item.nick,
          note: item.note,
        });
        results.push({ nick: item.nick, ok: true, note: written?.note ?? item.note });
      } catch (err) {
        results.push({ nick: item.nick, ok: false, error: err.message });
      }
    }
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.statusCode ?? 500;
  res.status(status).json({ error: err.message ?? "internal error" });
});

app.listen(PORT, () => {
  console.log(`autonotes listening on http://localhost:${PORT}`);
});
