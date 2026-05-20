import "dotenv/config";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { resolve } from "node:path";

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

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(resolve(import.meta.dirname, "public")));

async function buildMcpClient(): Promise<McpClient> {
  const cfg = await loadConfig();
  if (!cfg.lurkerUrl || !cfg.lurkerToken) {
    const err = Object.assign(new Error("Lurker URL and token are not configured"), {
      statusCode: 400,
    });
    throw err;
  }
  return new McpClient({ url: cfg.lurkerUrl, token: cfg.lurkerToken });
}

app.get("/api/config", async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
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

app.post("/api/config", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Trim — pasted URLs and tokens routinely carry a trailing newline, which
    // saves a "valid-looking" config that then fails auth later.
    const lurkerUrl = typeof req.body?.lurkerUrl === "string" ? req.body.lurkerUrl.trim() : "";
    const lurkerToken =
      typeof req.body?.lurkerToken === "string" ? req.body.lurkerToken.trim() : "";
    if (!lurkerUrl || !lurkerToken) {
      res.status(400).json({ error: "lurkerUrl and lurkerToken are required" });
      return;
    }
    const probe = new McpClient({ url: lurkerUrl, token: lurkerToken });
    const tools = await probe.toolsList();
    const toolNames = (tools?.tools ?? []).map((t) => t.name);
    const scope = toolNames.includes("set_nick_note") ? "read-write" : "read";

    await saveConfig({ lurkerUrl, lurkerToken });
    res.json({ ok: true, scope, toolNames });
  } catch (err) {
    if (err instanceof McpError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

app.get("/api/networks", async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const mcp = await buildMcpClient();
    const result = await mcp.toolCall("list_networks", {});
    const r = result as { networks?: unknown[] } | null;
    res.json(Array.isArray(result) ? result : r?.networks ?? []);
  } catch (err) {
    next(err);
  }
});

app.get("/api/buffers", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const mcp = await buildMcpClient();
    const networkId = req.query.networkId ? Number(req.query.networkId) : undefined;
    const args: Record<string, unknown> = networkId ? { networkId } : {};
    const result = await mcp.toolCall("list_buffers", args);
    const r = result as { buffers?: unknown[] } | null;
    res.json(Array.isArray(result) ? result : r?.buffers ?? []);
  } catch (err) {
    next(err);
  }
});

app.post("/api/scan", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { networkId, depth } = (req.body ?? {}) as { networkId?: unknown; depth?: unknown };
    // Number.isFinite rather than typeof — NaN/Infinity are both "number".
    const target = typeof req.body?.target === "string" ? req.body.target.trim() : "";
    if (!Number.isFinite(networkId) || !target) {
      res.status(400).json({ error: "networkId (number) and target (string) are required" });
      return;
    }
    const cleanDepth = Math.max(1, Math.min(500, Number(depth) || 200));

    const scan = createScan({ networkId: networkId as number, target, depth: cleanDepth });
    await saveConfig({ lastNetworkId: networkId as number, lastTarget: target, lastDepth: cleanDepth });
    res.json({ scanId: scan.id });

    // Fire-and-forget: agent runs while the HTTP response has already returned.
    // The UI polls /api/scan/:id for progress.
    void (async () => {
      try {
        const mcp = await buildMcpClient();
        const { proposals, messages } = await runScan({
          scan,
          mcpClient: mcp,
          onProgress: (s) => { updateScan(s.id, { toolCallCount: s.toolCallCount }); },
          onEvent: (ev) => { appendEvent(scan.id, ev); },
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

app.get("/api/scan/:id", (req: Request, res: Response): void => {
  const scan = getScan(req.params.id);
  if (!scan) {
    res.status(404).json({ error: "scan not found" });
    return;
  }
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

app.post("/api/apply", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { scanId, items } = (req.body ?? {}) as { scanId?: unknown; items?: unknown };
    const scan = getScan(scanId as string);
    if (!scan) {
      res.status(404).json({ error: "scan not found" });
      return;
    }
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "items must be a non-empty array" });
      return;
    }

    const mcp = await buildMcpClient();
    const results: Array<{ nick: unknown; ok: boolean; error?: string; note?: unknown }> = [];
    for (const item of items as Array<Record<string, unknown>>) {
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
        const w = written as { note?: unknown } | null;
        results.push({ nick: item.nick, ok: true, note: w?.note ?? item.note });
      } catch (err) {
        results.push({ nick: item.nick, ok: false, error: (err as Error).message });
      }
    }
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

const errorHandler: express.ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  console.error(err);
  const e = err as { statusCode?: number; message?: string };
  const status = e.statusCode ?? 500;
  res.status(status).json({ error: e.message ?? "internal error" });
};
app.use(errorHandler);

// Bind localhost by default — this app has no auth and holds the operator's
// Lurker + Anthropic credentials, so it must not be reachable from the LAN
// unless the operator explicitly opts in via HOST.
const HOST = process.env.HOST || "127.0.0.1";

app.listen(PORT, HOST, () => {
  console.log(`autonotes listening on http://${HOST}:${PORT}`);
});
