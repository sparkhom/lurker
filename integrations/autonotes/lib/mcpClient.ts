// Minimal MCP HTTP client for Lurker's /mcp endpoint.
//
// Lurker's MCP surface is JSON-RPC 2.0 over a single POST per request — no
// session state on the server. We hand-roll the wire format here (rather than
// pulling in @modelcontextprotocol/sdk) so the sample stays readable and the
// transport doesn't drift if the upstream SDK rev-locks.

// JSON-RPC 2.0 envelope returned by the server.
export interface McpEnvelope {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// A tool descriptor returned by tools/list.
export interface McpTool {
  name: string;
  description?: string;
  input_schema?: unknown;
}

export interface McpToolsListResult {
  tools: McpTool[];
}

export class McpError extends Error {
  code: number | undefined;
  data: unknown;

  constructor(message: string, { code, data }: { code?: number; data?: unknown } = {}) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.data = data;
  }
}

export class McpToolError extends Error {
  payload: unknown;

  constructor(message: string, { payload }: { payload?: unknown } = {}) {
    super(message);
    this.name = "McpToolError";
    this.payload = payload;
  }
}

export class McpClient {
  private url: string;
  private token: string;
  private rpcId: number;

  constructor({ url, token }: { url: string; token: string }) {
    if (!url) throw new Error("McpClient: url is required");
    if (!token) throw new Error("McpClient: token is required");
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.rpcId = 0;
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.rpcId;
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new McpError(`HTTP ${res.status} from ${this.url}: ${body.slice(0, 400)}`, {
        code: res.status,
      });
    }

    const envelope = (await res.json()) as McpEnvelope;
    if (envelope.error) {
      throw new McpError(envelope.error.message ?? "MCP error", {
        code: envelope.error.code,
        data: envelope.error.data,
      });
    }
    return envelope.result;
  }

  async toolsList(): Promise<McpToolsListResult> {
    return this.call("tools/list", {}) as Promise<McpToolsListResult>;
  }

  // Returns the unwrapped tool payload (parsed JSON from the first text block).
  // Throws McpToolError when the tool replied with isError: true.
  async toolCall(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = await this.call("tools/call", { name, arguments: args });
    const payload = extractToolPayload(result);
    if ((result as { isError?: boolean } | null)?.isError) {
      throw new McpToolError(`MCP tool ${name} returned error`, { payload });
    }
    return payload;
  }
}

function extractToolPayload(result: unknown): unknown {
  const r = result as { content?: unknown[] } | null;
  const block = Array.isArray(r?.content) ? r.content[0] : null;
  if (!block || (block as { type?: string }).type !== "text" || typeof (block as { text?: unknown }).text !== "string") {
    return result;
  }
  try {
    return JSON.parse((block as { text: string }).text);
  } catch {
    return { text: (block as { text: string }).text };
  }
}
