import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { basename } from "path";

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string;
  env: string;
  enabled: boolean;
  timeoutMs: number;
}

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface McpToolListItem {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpDiscoveredTool {
  serverId: string;
  serverName: string;
  toolName: string;
  callName: string;
  description: string;
}

interface PreparedTool {
  callName: string;
  toolName: string;
  serverId: string;
  timeoutMs: number;
  client: McpStdioClient;
}

interface PrepareOptions {
  signal?: AbortSignal;
}

const HEADER_DELIMITER = Buffer.from("\r\n\r\n");
const HEADER_DELIMITER_LF = Buffer.from("\n\n");
const MCP_PROTOCOL_VERSION = "2024-11-05";
const ALLOWED_MCP_COMMANDS = new Set([
  "npx",
  "node",
  "bunx",
  "uvx",
  "python",
  "python3",
  "deno",
  "cmd",
  "powershell",
  "pwsh"
]);

export function isAllowedMcpCommand(raw: unknown): boolean {
  const command = String(raw || "").trim();
  if (!command) return false;
  const base = basename(command).toLowerCase().replace(/\.exe$/i, "");
  return ALLOWED_MCP_COMMANDS.has(base);
}

function detectStdioWireFormat(config: McpServerConfig): "content-length" | "jsonl" {
  const signature = `${String(config.command || "")} ${String(config.args || "")}`.toLowerCase();
  if (/\bmcp-remote\b/.test(signature)) return "jsonl";
  return "content-length";
}

function parseArgs(raw: string): string[] {
  const text = String(raw || "").trim();
  if (!text) return [];
  const matches = text.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return matches
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      if ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) {
        return token.slice(1, -1);
      }
      return token;
    });
}

function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = String(raw || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1);
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

function normalizeSchema(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { type: "object", properties: {}, additionalProperties: true };
}

function sanitizeNamePart(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "tool";
}

function buildCallName(serverId: string, toolName: string, used: Set<string>): string {
  const base = `mcp_${sanitizeNamePart(serverId)}__${sanitizeNamePart(toolName)}`;
  let candidate = base.slice(0, 64);
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = `_${suffix}`;
    candidate = `${base.slice(0, Math.max(1, 64 - tail.length))}${tail}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function toToolText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return String(result ?? "");
  }
  const payload = result as { content?: unknown; isError?: unknown };
  const content = Array.isArray(payload.content) ? payload.content : [];
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const row = item as { type?: unknown; text?: unknown };
    if (row.type === "text") {
      parts.push(String(row.text ?? ""));
    } else if (typeof row.type === "string") {
      parts.push(`[${row.type} result]`);
    }
  }
  const text = parts.join("\n").trim();
  if (text) {
    if (payload.isError === true) return `Tool error:\n${text}`;
    return text;
  }
  const serialized = JSON.stringify(result);
  if (payload.isError === true) return `Tool error:\n${serialized}`;
  return serialized;
}

class McpStdioClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly wireFormat: "content-length" | "jsonl";
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timeout: NodeJS.Timeout;
  }>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private stderrTail = "";

  constructor(private readonly config: McpServerConfig) {
    if (!isAllowedMcpCommand(config.command)) {
      throw new Error(`MCP command is not allowed: ${config.command}`);
    }
    this.wireFormat = detectStdioWireFormat(config);
    const args = parseArgs(config.args);
    const envPatch = parseEnv(config.env);
    this.proc = spawn(config.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...envPatch }
    });

    this.proc.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      // Keep stderr consumed to avoid process backpressure and keep a short tail for diagnostics.
      const text = chunk.toString("utf8");
      if (text) {
        this.stderrTail = `${this.stderrTail}${text}`.slice(-1200);
      }
    });
    this.proc.on("error", (err) => this.rejectAll(err));
    this.proc.on("exit", () => {
      const suffix = this.stderrTail.trim() ? ` | stderr: ${this.stderrTail.trim()}` : "";
      this.rejectAll(new Error(`MCP server exited: ${this.config.name || this.config.id}${suffix}`));
    });
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    const timeout = this.normalizeTimeout();
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "vellium", version: "0.2.0" }
    }, timeout, signal);
    this.notify("notifications/initialized", {});
  }

  async listTools(signal?: AbortSignal): Promise<McpToolListItem[]> {
    const timeout = this.normalizeTimeout();
    const result = await this.request("tools/list", {}, timeout, signal) as { tools?: unknown };
    return Array.isArray(result?.tools) ? (result.tools as McpToolListItem[]) : [];
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, timeoutMs, signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("MCP client closed"));
    if (!this.proc.killed) {
      this.proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!this.proc.killed) this.proc.kill("SIGKILL");
          resolve();
        }, 600);
        this.proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private normalizeTimeout(): number {
    const raw = Number(this.config.timeoutMs);
    const isRemoteBridge = /\bmcp-remote\b/i.test(`${this.config.command} ${this.config.args}`);
    const fallback = isRemoteBridge ? 45000 : 15000;
    if (!Number.isFinite(raw) || raw <= 0) return fallback;
    const normalized = Math.max(1000, Math.min(120000, Math.floor(raw)));
    return isRemoteBridge ? Math.max(45000, normalized) : normalized;
  }

  private notify(method: string, params: Record<string, unknown>) {
    this.sendFrame({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("MCP client already closed"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Aborted"));
        return;
      }
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const suffix = this.stderrTail.trim() ? ` | stderr: ${this.stderrTail.trim()}` : "";
        reject(new Error(`MCP timeout on ${method}${suffix}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      if (signal) {
        const onAbort = () => {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(new Error("Aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.sendFrame({ jsonrpc: "2.0", id, method, params });
    });
  }

  private sendFrame(payload: Record<string, unknown>) {
    if (this.wireFormat === "jsonl") {
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
      return;
    }
    const json = Buffer.from(JSON.stringify(payload), "utf8");
    const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "utf8");
    this.proc.stdin.write(Buffer.concat([header, json]));
  }

  private handleStdout(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.wireFormat === "jsonl") {
      this.processJsonlBuffer();
      return;
    }
    this.processContentLengthBuffer();
  }

  private processJsonlBuffer() {
    while (true) {
      const lineEnd = this.buffer.indexOf(0x0a); // \n
      if (lineEnd === -1) return;

      const rawLine = this.buffer.slice(0, lineEnd).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.slice(lineEnd + 1);
      const line = rawLine.trim();
      if (!line) continue;

      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        this.resolvePending(message);
      } catch {
        // Ignore non-JSON lines/noise from stdout.
      }
    }
  }

  private processContentLengthBuffer() {
    while (true) {
      const crlfHeaderEnd = this.buffer.indexOf(HEADER_DELIMITER);
      const lfHeaderEnd = this.buffer.indexOf(HEADER_DELIMITER_LF);
      let headerEnd = -1;
      let delimiterLength = 0;
      if (crlfHeaderEnd !== -1 && (lfHeaderEnd === -1 || crlfHeaderEnd <= lfHeaderEnd)) {
        headerEnd = crlfHeaderEnd;
        delimiterLength = HEADER_DELIMITER.length;
      } else if (lfHeaderEnd !== -1) {
        headerEnd = lfHeaderEnd;
        delimiterLength = HEADER_DELIMITER_LF.length;
      }
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + delimiterLength);
        continue;
      }
      const contentLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + delimiterLength;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) return;

      const raw = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.slice(bodyEnd);

      try {
        const message = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message?: string } };
        this.resolvePending(message);
      } catch {
        // Ignore malformed chunks and continue parsing stream.
      }
    }
  }

  private resolvePending(message: { id?: number; result?: unknown; error?: { message?: string } }) {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(String(message.error.message || "MCP error")));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAll(reason: unknown) {
    if (this.pending.size === 0) return;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
      this.pending.delete(id);
    }
  }
}

export interface PreparedMcpTools {
  tools: OpenAIToolDefinition[];
  executeToolCall: (callName: string, rawArgs: string | undefined, signal?: AbortSignal) => Promise<string>;
  close: () => Promise<void>;
}

export async function prepareMcpTools(servers: McpServerConfig[], options?: PrepareOptions): Promise<PreparedMcpTools> {
  const clients: McpStdioClient[] = [];
  const registry = new Map<string, PreparedTool>();
  const tools: OpenAIToolDefinition[] = [];
  const usedNames = new Set<string>();

  for (const server of servers) {
    if (!server?.enabled) continue;
    if (!String(server.command || "").trim()) continue;
    const client = new McpStdioClient(server);
    try {
      await client.initialize(options?.signal);
      const listed = await client.listTools(options?.signal);
      clients.push(client);
      for (const item of listed) {
        const toolName = String(item?.name || "").trim();
        if (!toolName) continue;
        const callName = buildCallName(server.id || server.name || "server", toolName, usedNames);
        const description = String(item?.description || `${server.name || server.id}: ${toolName}`);
        const timeoutMs = Number(server.timeoutMs) > 0 ? Number(server.timeoutMs) : 15000;
        registry.set(callName, {
          callName,
          toolName,
          serverId: server.id,
          timeoutMs,
          client
        });
        tools.push({
          type: "function",
          function: {
            name: callName,
            description: description.slice(0, 512),
            parameters: normalizeSchema(item?.inputSchema)
          }
        });
      }
    } catch {
      await client.close();
    }
  }

  return {
    tools,
    executeToolCall: async (callName: string, rawArgs: string | undefined, signal?: AbortSignal) => {
      const selected = registry.get(callName);
      if (!selected) {
        return `Tool not found: ${callName}`;
      }
      let parsedArgs: Record<string, unknown> = {};
      if (rawArgs && rawArgs.trim()) {
        try {
          const decoded = JSON.parse(rawArgs);
          if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
            parsedArgs = decoded as Record<string, unknown>;
          }
        } catch {
          return `Tool argument parsing error for ${callName}`;
        }
      }
      try {
        const result = await selected.client.callTool(selected.toolName, parsedArgs, selected.timeoutMs, signal);
        return toToolText(result).slice(0, 24000);
      } catch (err) {
        return `Tool execution failed (${callName}): ${err instanceof Error ? err.message : "Unknown error"}`;
      }
    },
    close: async () => {
      await Promise.all(clients.map((client) => client.close()));
    }
  };
}

export async function discoverMcpToolCatalog(
  servers: McpServerConfig[],
  options?: PrepareOptions
): Promise<McpDiscoveredTool[]> {
  const usedNames = new Set<string>();
  const discovered: McpDiscoveredTool[] = [];

  for (const server of servers) {
    if (!server?.enabled) continue;
    if (!String(server.command || "").trim()) continue;
    const client = new McpStdioClient(server);
    try {
      await client.initialize(options?.signal);
      const listed = await client.listTools(options?.signal);
      for (const item of listed) {
        const toolName = String(item?.name || "").trim();
        if (!toolName) continue;
        const callName = buildCallName(server.id || server.name || "server", toolName, usedNames);
        discovered.push({
          serverId: String(server.id || "").trim(),
          serverName: String(server.name || server.id || "").trim(),
          toolName,
          callName,
          description: String(item?.description || `${server.name || server.id}: ${toolName}`).slice(0, 512)
        });
      }
    } catch {
      // Ignore failing servers to keep discovery best-effort.
    } finally {
      await client.close();
    }
  }

  return discovered;
}

export async function testMcpServerConnection(server: McpServerConfig, signal?: AbortSignal): Promise<{
  ok: boolean;
  tools: McpToolInfo[];
  error?: string;
}> {
  if (!server || !String(server.command || "").trim()) {
    return { ok: false, tools: [], error: "Command is required" };
  }

  const client = new McpStdioClient(server);
  try {
    await client.initialize(signal);
    const list = await client.listTools(signal);
    const tools = list
      .map((item) => ({
        name: String(item.name || "").trim(),
        description: String(item.description || "").trim()
      }))
      .filter((item) => item.name.length > 0);
    return { ok: true, tools };
  } catch (err) {
    return {
      ok: false,
      tools: [],
      error: err instanceof Error ? err.message : "Unknown MCP error"
    };
  } finally {
    await client.close();
  }
}
