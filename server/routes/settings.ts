import { Router } from "express";
import { db, DEFAULT_SETTINGS } from "../db.js";
import { discoverMcpToolCatalog, isAllowedMcpCommand, testMcpServerConnection, type McpServerConfig } from "../services/mcp.js";

const router = Router();

function getSettings() {
  const row = db.prepare("SELECT payload FROM settings WHERE id = 1").get() as { payload: string };
  const stored = JSON.parse(row.payload);
  const mcpServers = Array.isArray(stored.mcpServers) ? stored.mcpServers : DEFAULT_SETTINGS.mcpServers;
  // Merge with defaults for backward compat (new fields get default values)
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    samplerConfig: { ...DEFAULT_SETTINGS.samplerConfig, ...(stored.samplerConfig ?? {}) },
    promptTemplates: { ...DEFAULT_SETTINGS.promptTemplates, ...(stored.promptTemplates ?? {}) },
    mcpServers
  };
}

function normalizeMcpServer(raw: unknown, fallbackIndex = 1): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<McpServerConfig> & {
    serverId?: unknown;
    displayName?: unknown;
    cmd?: unknown;
    arguments?: unknown;
    url?: unknown;
  };
  const id = String(row.id || row.serverId || "").trim() || `mcp-${Date.now()}-${fallbackIndex}`;
  const name = String(row.name || row.displayName || id).trim() || id;
  const url = String(row.url || "").trim();
  const command = String(row.command || row.cmd || (url ? "npx" : "")).trim();
  if (!command) return null;
  if (!isAllowedMcpCommand(command)) return null;
  const args = String(row.args || row.arguments || (url ? `-y mcp-remote ${url}` : "")).trim();
  const env = String(row.env || "").trim();
  const timeoutMsRaw = Number(row.timeoutMs);
  const defaultTimeout = url ? 45000 : 15000;
  return {
    id,
    name,
    command,
    args,
    env,
    enabled: row.enabled !== false,
    timeoutMs: Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.min(120000, Math.floor(timeoutMsRaw))) : defaultTimeout
  };
}

function parseMcpServersPayload(payload: unknown): McpServerConfig[] {
  if (Array.isArray(payload)) {
    return payload.map((item, idx) => normalizeMcpServer(item, idx + 1)).filter((s): s is McpServerConfig => s !== null);
  }
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      const one = normalizeMcpServer({
        id: new URL(trimmed).hostname || "mcp-http",
        name: new URL(trimmed).hostname || "MCP HTTP",
        url: trimmed
      }, 1);
      return one ? [one] : [];
    }
    return [];
  }
  if (!payload || typeof payload !== "object") return [];
  const row = payload as {
    mcpServers?: unknown;
    servers?: unknown;
    server?: unknown;
  };
  if (row.mcpServers !== undefined) return parseMcpServersPayload(row.mcpServers);
  if (row.servers !== undefined) return parseMcpServersPayload(row.servers);
  if (row.server !== undefined) return parseMcpServersPayload([row.server]);

  // Support dictionary shape: { "name": { ...config } }
  const entries = Object.entries(payload as Record<string, unknown>);
  if (entries.length > 0 && entries.every(([, value]) => value && typeof value === "object")) {
    return entries
      .map(([key, value], idx) => normalizeMcpServer({ ...(value as Record<string, unknown>), id: key, name: key }, idx + 1))
      .filter((s): s is McpServerConfig => s !== null);
  }

  const one = normalizeMcpServer(payload, 1);
  return one ? [one] : [];
}

async function fetchImportSource(source: string): Promise<{ sourceType: "url" | "json"; content: string }> {
  const trimmed = source.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(trimmed, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const content = await response.text();
      return { sourceType: "url", content };
    } finally {
      clearTimeout(timer);
    }
  }
  return { sourceType: "json", content: trimmed };
}

router.get("/", (_req, res) => {
  res.json(getSettings());
});

router.patch("/", (req, res) => {
  const patch = req.body;
  const current = getSettings();
  const updated = { ...current, ...patch };
  db.prepare("UPDATE settings SET payload = ? WHERE id = 1").run(JSON.stringify(updated));
  res.json(updated);
});

router.post("/reset", (_req, res) => {
  db.prepare("UPDATE settings SET payload = ? WHERE id = 1").run(JSON.stringify(DEFAULT_SETTINGS));
  res.json({ ...DEFAULT_SETTINGS });
});

router.post("/mcp/test", async (req, res) => {
  const raw = (req.body as { server?: unknown } | undefined)?.server;
  if (!raw || typeof raw !== "object") {
    res.status(400).json({ ok: false, tools: [], error: "server payload is required" });
    return;
  }
  const row = raw as Partial<McpServerConfig>;
  const timeoutMs = Number(row.timeoutMs);
  const server: McpServerConfig = {
    id: String(row.id || "mcp-test"),
    name: String(row.name || "MCP Test"),
    command: String(row.command || ""),
    args: String(row.args || ""),
    env: String(row.env || ""),
    enabled: row.enabled !== false,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 15000
  };
  const result = await testMcpServerConnection(server);
  res.json(result);
});

router.post("/mcp/import", async (req, res) => {
  const source = String((req.body as { source?: unknown } | undefined)?.source || "").trim();
  if (!source) {
    res.status(400).json({ ok: false, servers: [], sourceType: "json", error: "source is required" });
    return;
  }

  try {
    if (/^https?:\/\//i.test(source)) {
      const directUrlServers = parseMcpServersPayload(source);
      if (directUrlServers.length > 0) {
        res.json({ ok: true, servers: directUrlServers, sourceType: "url" });
        return;
      }
    }

    const loaded = await fetchImportSource(source);
    let parsed: unknown;
    try {
      parsed = JSON.parse(loaded.content);
    } catch {
      res.status(400).json({ ok: false, servers: [], sourceType: loaded.sourceType, error: "Invalid JSON source" });
      return;
    }
    const servers = parseMcpServersPayload(parsed);
    if (servers.length === 0) {
      res.status(400).json({ ok: false, servers: [], sourceType: loaded.sourceType, error: "No MCP servers found in source" });
      return;
    }
    res.json({ ok: true, servers, sourceType: loaded.sourceType });
  } catch (err) {
    res.status(400).json({
      ok: false,
      servers: [],
      sourceType: /^https?:\/\//i.test(source) ? "url" : "json",
      error: err instanceof Error ? err.message : "Import failed"
    });
  }
});

router.post("/mcp/discover", async (req, res) => {
  const serverIdsRaw = (req.body as { serverIds?: unknown } | undefined)?.serverIds;
  const serverIds = Array.isArray(serverIdsRaw)
    ? serverIdsRaw.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  try {
    const current = getSettings();
    let servers = parseMcpServersPayload(current.mcpServers);
    if (serverIds.length > 0) {
      const allowed = new Set(serverIds);
      servers = servers.filter((server) => allowed.has(server.id));
    }
    const tools = await discoverMcpToolCatalog(servers);
    res.json({ ok: true, tools });
  } catch (err) {
    res.status(400).json({
      ok: false,
      tools: [],
      error: err instanceof Error ? err.message : "MCP discovery failed"
    });
  }
});

export default router;
