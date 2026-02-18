import { Router } from "express";
import { db, newId, now, roughTokenCount, isLocalhostUrl, DEFAULT_SETTINGS, nextSortOrder } from "../db.js";
import { buildSystemPrompt, buildMessageArray, buildMultiCharSystemPrompt, buildMultiCharMessageArray, mergeConsecutiveRoles, DEFAULT_PROMPT_BLOCKS } from "../domain/rpEngine.js";
import type { PromptBlock, CharacterCardData, ChatAttachment } from "../domain/rpEngine.js";
import type { Response } from "express";
import { prepareMcpTools, type McpServerConfig } from "../services/mcp.js";
import { getTriggeredLoreEntries, injectLoreBlocks, normalizeLoreBookEntries, type LoreBookEntryData } from "../domain/lorebooks.js";
import {
  buildKoboldGenerateBody,
  countKoboldTokens,
  extractKoboldGeneratedText,
  extractKoboldStreamDelta,
  normalizeProviderType,
  requestKoboldGenerate,
  requestKoboldGenerateStream
} from "../services/providerApi.js";

const router = Router();

// Active abort controllers per chat — for stream interruption
const activeAbortControllers = new Map<string, AbortController>();

interface MessageRow {
  id: string;
  chat_id: string;
  branch_id: string;
  role: string;
  content: string;
  attachments: string | null;
  token_count: number;
  parent_id: string | null;
  deleted: number;
  created_at: string;
  character_name: string | null;
  sort_order: number;
}

interface MessageAttachmentPayload {
  id?: string;
  filename?: string;
  type?: string;
  url?: string;
  mimeType?: string;
  dataUrl?: string;
  content?: string;
}

interface ProviderRow {
  id: string;
  base_url: string;
  api_key_cipher: string;
  full_local_only: number;
  provider_type: string;
}

interface LoreBookRow {
  id: string;
  name: string;
  entries_json: string;
}

interface UserPersonaPayload {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
}

function messageToJson(row: MessageRow) {
  let attachments: MessageAttachmentPayload[] = [];
  try {
    const parsed = JSON.parse(row.attachments || "[]");
    if (Array.isArray(parsed)) attachments = parsed as MessageAttachmentPayload[];
  } catch {
    attachments = [];
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    branchId: row.branch_id,
    role: row.role,
    content: row.content,
    attachments,
    tokenCount: row.token_count,
    createdAt: row.created_at,
    parentId: row.parent_id,
    characterName: row.character_name || undefined
  };
}

function resolveBranch(chatId: string, branchId?: string): string {
  if (branchId) return branchId;
  const row = db.prepare("SELECT id FROM branches WHERE chat_id = ? ORDER BY created_at ASC LIMIT 1")
    .get(chatId) as { id: string } | undefined;
  if (row) return row.id;
  const id = newId();
  db.prepare("INSERT INTO branches (id, chat_id, name, parent_message_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, chatId, "main", null, now());
  return id;
}

function getTimeline(chatId: string, branchId: string) {
  const rows = db.prepare(
    "SELECT * FROM messages WHERE chat_id = ? AND branch_id = ? AND deleted = 0 ORDER BY sort_order ASC, created_at ASC"
  ).all(chatId, branchId) as MessageRow[];
  return rows.map(messageToJson);
}

function getSettings() {
  const row = db.prepare("SELECT payload FROM settings WHERE id = 1").get() as { payload: string };
  const stored = JSON.parse(row.payload);
  const mcpServers = Array.isArray(stored.mcpServers) ? stored.mcpServers : DEFAULT_SETTINGS.mcpServers;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    samplerConfig: { ...DEFAULT_SETTINGS.samplerConfig, ...(stored.samplerConfig ?? {}) },
    promptTemplates: { ...DEFAULT_SETTINGS.promptTemplates, ...(stored.promptTemplates ?? {}) },
    mcpServers
  };
}

function getPromptBlocks(chatId: string): PromptBlock[] {
  const rows = db.prepare(
    "SELECT * FROM prompt_blocks WHERE chat_id = ? ORDER BY ordering ASC"
  ).all(chatId) as { id: string; kind: string; enabled: number; ordering: number; content: string }[];

  if (rows.length === 0) return DEFAULT_PROMPT_BLOCKS;

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    enabled: r.enabled === 1,
    order: r.ordering,
    content: r.content
  }));
}

function getCharacterCard(characterId: string | null): CharacterCardData | null {
  if (!characterId) return null;
  const row = db.prepare("SELECT * FROM characters WHERE id = ?").get(characterId) as {
    name: string; description: string; personality: string; scenario: string;
    system_prompt: string; mes_example: string; greeting: string;
  } | undefined;
  if (!row) return null;
  return {
    name: row.name,
    description: row.description || "",
    personality: row.personality || "",
    scenario: row.scenario || "",
    systemPrompt: row.system_prompt || "",
    mesExample: row.mes_example || "",
    greeting: row.greeting || ""
  };
}

function getLorebookEntries(lorebookId: string | null): LoreBookEntryData[] {
  if (!lorebookId) return [];
  const row = db.prepare("SELECT id, name, entries_json FROM lorebooks WHERE id = ?").get(lorebookId) as LoreBookRow | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.entries_json || "[]");
    return normalizeLoreBookEntries(parsed);
  } catch {
    return [];
  }
}

function getSceneState(chatId: string): { mood: string; pacing: string; variables: Record<string, string>; intensity: number } | null {
  const row = db.prepare("SELECT payload FROM rp_scene_state WHERE chat_id = ?").get(chatId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload);
    const intensity = typeof parsed.intensity === "number" ? parsed.intensity : 0.5;
    return {
      mood: parsed.mood || "neutral",
      pacing: parsed.pacing || "balanced",
      variables: parsed.variables || {},
      intensity: Math.max(0, Math.min(1, intensity))
    };
  } catch { return null; }
}

function getAuthorNote(chatId: string): string {
  const chat = db.prepare("SELECT author_note FROM chats WHERE id = ?").get(chatId) as { author_note: string | null } | undefined;
  if (chat?.author_note) return chat.author_note;
  const row = db.prepare(
    "SELECT content FROM rp_memory_entries WHERE chat_id = ? AND role = 'author_note' ORDER BY created_at DESC LIMIT 1"
  ).get(chatId) as { content: string } | undefined;
  return row?.content || "";
}

function getChatSamplerConfig(chatId: string, globalConfig: Record<string, unknown>): Record<string, unknown> {
  const chat = db.prepare("SELECT sampler_config FROM chats WHERE id = ?").get(chatId) as { sampler_config: string | null } | undefined;
  if (chat?.sampler_config) {
    try {
      return { ...globalConfig, ...JSON.parse(chat.sampler_config) };
    } catch { /* use global */ }
  }
  return globalConfig;
}

function sanitizeAttachments(input: unknown): MessageAttachmentPayload[] {
  if (!Array.isArray(input)) return [];
  const out: MessageAttachmentPayload[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const raw = item as MessageAttachmentPayload;
    const type = raw.type === "image" ? "image" : (raw.type === "text" ? "text" : null);
    if (!type) continue;

    const base: MessageAttachmentPayload = {
      id: String(raw.id || ""),
      filename: String(raw.filename || ""),
      type,
      url: String(raw.url || ""),
      mimeType: String(raw.mimeType || "")
    };

    if (type === "image") {
      const dataUrl = String(raw.dataUrl || "");
      // Keep only data:image/* URLs to avoid arbitrary payload injection.
      if (dataUrl.startsWith("data:image/")) {
        // Rough cap at ~15MB per attachment payload.
        base.dataUrl = dataUrl.slice(0, 15 * 1024 * 1024);
      }
      out.push(base);
      continue;
    }

    if (type === "text") {
      const content = String(raw.content || "");
      if (content) base.content = content.slice(0, 20000);
      out.push(base);
    }
  }
  return out.slice(0, 12);
}

function toChatAttachments(input: MessageAttachmentPayload[] | null | undefined): ChatAttachment[] {
  if (!Array.isArray(input)) return [];
  const out: ChatAttachment[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "image") {
      out.push({
        type: "image",
        dataUrl: String(item.dataUrl || ""),
        filename: String(item.filename || "")
      });
      continue;
    }
    if (item.type === "text") {
      out.push({
        type: "text",
        filename: String(item.filename || "")
      });
    }
  }
  return out;
}

function getContextWindowBudget(settings: Record<string, unknown>): number {
  const raw = Number(settings.contextWindowSize);
  if (!Number.isFinite(raw) || raw <= 0) return 8192;
  return Math.max(512, Math.min(32768, Math.floor(raw)));
}

function getTailBudgetPercent(
  settings: Record<string, unknown>,
  key: "contextTailBudgetWithSummaryPercent" | "contextTailBudgetWithoutSummaryPercent",
  fallback: number
): number {
  const raw = Number(settings[key]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(5, Math.min(95, raw));
}

function selectTimelineForPrompt(
  timeline: ReturnType<typeof getTimeline>,
  contextSummary: string,
  contextWindowBudget: number,
  withSummaryPercent: number,
  withoutSummaryPercent: number
) {
  const hasSummary = Boolean(contextSummary.trim());
  // Leave headroom for system prompt, summary block, and model overhead.
  const historyTokenBudget = hasSummary
    ? Math.max(256, Math.floor(contextWindowBudget * (withSummaryPercent / 100)))
    : Math.max(512, Math.floor(contextWindowBudget * (withoutSummaryPercent / 100)));

  const selected = [] as ReturnType<typeof getTimeline>;
  let used = 0;
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const msg = timeline[i];
    const msgTokens = Math.max(1, Number(msg.tokenCount) || roughTokenCount(msg.content));
    if (selected.length > 0 && used + msgTokens > historyTokenBudget) break;
    selected.unshift(msg);
    used += msgTokens;
  }
  return selected;
}

interface OpenAICompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ToolCallTrace {
  callId: string;
  name: string;
  args: string;
  result: string;
}

interface ToolCallStreamEvent {
  phase: "start" | "done";
  callId: string;
  name: string;
  args: string;
  result?: string;
}

function clampToolIterationLimit(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 4;
  return Math.max(1, Math.min(12, Math.floor(value)));
}

function parseToolCallingPolicy(raw: unknown): "conservative" | "balanced" | "aggressive" {
  if (raw === "conservative" || raw === "balanced" || raw === "aggressive") {
    return raw;
  }
  return "balanced";
}

function normalizeAssistantContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const row = item as { type?: unknown; text?: unknown };
        if (row.type === "text") return String(row.text ?? "");
        return "";
      })
      .filter(Boolean);
    return parts.join("\n").trim();
  }
  if (content === null || content === undefined) return "";
  return String(content);
}

function flattenContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const row = item as { type?: unknown; text?: unknown };
    if (row.type === "text") parts.push(String(row.text ?? ""));
    if (row.type === "image_url") parts.push("[Image attachment]");
  }
  return parts.join("\n").trim();
}

const KOBOLD_TAGS = {
  systemOpen: "{{[SYSTEM]}}",
  systemClose: "{{[SYSTEM_END]}}",
  inputOpen: "{{[INPUT]}}",
  inputClose: "{{[INPUT_END]}}",
  outputOpen: "{{[OUTPUT]}}",
  outputClose: "{{[OUTPUT_END]}}"
};

function buildKoboldPromptFromMessages(
  messages: Array<{ role: string; content: unknown }>,
  samplerConfig: Record<string, unknown>
): { prompt: string; memory: string } {
  const systemParts: string[] = [];
  const convoParts: string[] = [];
  for (const msg of messages) {
    const role = String(msg.role || "user");
    const text = flattenContentToText(msg.content).trim();
    if (!text) continue;
    if (role === "system") {
      systemParts.push(text);
      continue;
    }
    if (role === "assistant") {
      convoParts.push(`${KOBOLD_TAGS.outputOpen}\n${text}\n${KOBOLD_TAGS.outputClose}`);
      continue;
    }
    if (role === "tool") {
      convoParts.push(`${KOBOLD_TAGS.inputOpen}\n[Tool]\n${text}\n${KOBOLD_TAGS.inputClose}`);
      continue;
    }
    convoParts.push(`${KOBOLD_TAGS.inputOpen}\n${text}\n${KOBOLD_TAGS.inputClose}`);
  }

  const customMemory = String(samplerConfig.koboldMemory || "").trim();
  const memoryBlocks = [
    customMemory,
    ...systemParts.map((part) => `${KOBOLD_TAGS.systemOpen}\n${part}\n${KOBOLD_TAGS.systemClose}`)
  ].filter(Boolean);
  const memory = memoryBlocks.join("\n\n");
  const prompt = [...convoParts, KOBOLD_TAGS.outputOpen].join("\n\n");
  return { prompt, memory };
}

async function countProviderTokens(provider: ProviderRow | null | undefined, content: string): Promise<number> {
  const text = String(content || "");
  if (!text) return 0;
  if (!provider || normalizeProviderType(provider.provider_type) !== "koboldcpp") {
    return roughTokenCount(text);
  }
  const counted = await countKoboldTokens(provider, text);
  return counted ?? roughTokenCount(text);
}

async function sendSseText(res: Response, chatId: string, text: string, paceMs = 0) {
  const chunks = text.match(/[\s\S]{1,140}/g) ?? [];
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify({ type: "delta", chatId, delta: chunk })}\n\n`);
    if (paceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, paceMs));
    }
  }
}

function parseToolServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Partial<McpServerConfig>;
      const id = String(row.id || "").trim();
      const command = String(row.command || "").trim();
      if (!id || !command) return null;
      const timeoutMs = Number(row.timeoutMs);
      return {
        id,
        name: String(row.name || id),
        command,
        args: String(row.args || ""),
        env: String(row.env || ""),
        enabled: row.enabled !== false,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 15000
      } as McpServerConfig;
    })
    .filter((item): item is McpServerConfig => item !== null);
}

function parseToolNameList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);
}

function parseToolStates(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(key || "").trim();
    if (!name) continue;
    if (typeof value === "boolean") out[name] = value;
  }
  return out;
}

function matchToolPattern(toolName: string, pattern: string): boolean {
  const t = toolName.toLowerCase();
  const p = pattern.toLowerCase();
  if (!p) return false;
  if (!p.includes("*")) return t === p;
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  try {
    return new RegExp(`^${escaped}$`, "i").test(t);
  } catch {
    return t === p;
  }
}

function filterToolsForModel(
  tools: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
  allowlistRaw: unknown,
  denylistRaw: unknown,
  statesRaw: unknown
) {
  const allowlist = parseToolNameList(allowlistRaw);
  const denylist = parseToolNameList(denylistRaw);
  const states = parseToolStates(statesRaw);
  return tools.filter((tool) => {
    const name = String(tool?.function?.name || "").trim();
    if (!name) return false;
    if (states[name] === false) return false;
    const allowed = allowlist.length === 0 || allowlist.some((pattern) => matchToolPattern(name, pattern));
    if (!allowed) return false;
    const denied = denylist.some((pattern) => matchToolPattern(name, pattern));
    return !denied;
  });
}

async function requestChatCompletion(
  provider: ProviderRow,
  modelId: string,
  body: Record<string, unknown>,
  signal: AbortSignal
) {
  const baseUrl = String(provider.base_url || "").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.api_key_cipher}`
    },
    body: JSON.stringify({ model: modelId, ...body }),
    signal
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown error");
    throw new Error(`[API Error: ${response.status}] ${errText.slice(0, 500)}`);
  }
  return response.json() as Promise<{
    choices?: Array<{
      message?: {
        content?: unknown;
        tool_calls?: OpenAIToolCall[];
      };
    }>;
  }>;
}

async function runToolCallingCompletion(params: {
  provider: ProviderRow;
  modelId: string;
  samplerConfig: Record<string, unknown>;
  apiMessages: OpenAICompletionMessage[];
  settings: Record<string, unknown>;
  signal: AbortSignal;
  onToolEvent?: (event: ToolCallStreamEvent) => void;
}): Promise<{ content: string; toolCalls: ToolCallTrace[]; streamMessages?: Array<Record<string, unknown>> } | null> {
  const autoAttach = params.settings.mcpAutoAttachTools !== false;
  if (!autoAttach) return null;

  const servers = parseToolServers(params.settings.mcpServers);
  if (!servers.length) return null;

  const mcp = await prepareMcpTools(servers, { signal: params.signal });
  try {
    const exposedTools = filterToolsForModel(
      mcp.tools,
      params.settings.mcpToolAllowlist,
      params.settings.mcpToolDenylist,
      params.settings.mcpToolStates
    );
    if (!exposedTools.length) return null;

    const policy = parseToolCallingPolicy(params.settings.toolCallingPolicy);
    const maxToolCallsRaw = clampToolIterationLimit(params.settings.maxToolCallsPerTurn);
    const maxToolCalls = policy === "conservative" ? Math.min(2, maxToolCallsRaw) : maxToolCallsRaw;
    const policyInstruction = policy === "conservative"
      ? "Use tools only when strictly necessary. If a direct answer is sufficient, do not call tools."
      : policy === "aggressive"
        ? "Prefer using tools when they can improve accuracy, freshness, or completeness of the answer."
        : "Use tools only when they clearly help produce a better answer.";
    const workingMessages = [
      ...params.apiMessages,
      {
        role: "system",
        content: policyInstruction
      }
    ] as Array<Record<string, unknown>>;
    const sc = params.samplerConfig;
    const toolTraces: ToolCallTrace[] = [];
    let executedTools = 0;

    while (executedTools < maxToolCalls) {
      const body = await requestChatCompletion(params.provider, params.modelId, {
        messages: workingMessages,
        stream: false,
        temperature: sc.temperature ?? 0.9,
        top_p: sc.topP ?? 1,
        frequency_penalty: sc.frequencyPenalty ?? 0,
        presence_penalty: sc.presencePenalty ?? 0,
        max_tokens: sc.maxTokens ?? 2048,
        ...(Array.isArray(sc.stop) && (sc.stop as string[]).length > 0 ? { stop: sc.stop } : {}),
        tools: exposedTools,
        ...(policy === "aggressive" ? { tool_choice: "auto" } : {})
      }, params.signal);

      const assistant = body.choices?.[0]?.message;
      const assistantContent = normalizeAssistantContent(assistant?.content);
      const toolCalls = Array.isArray(assistant?.tool_calls) ? assistant.tool_calls : [];

      if (toolCalls.length === 0) {
        // No tool calls on first pass: fallback to standard streaming path.
        if (executedTools === 0) {
          return null;
        }
        // Tools were used already: run a final streamed assistant pass in caller.
        return { content: assistantContent, toolCalls: toolTraces, streamMessages: workingMessages };
      }

      workingMessages.push({
        role: "assistant",
        content: assistantContent,
        tool_calls: toolCalls
      });

      for (const call of toolCalls) {
        if (executedTools >= maxToolCalls) break;
        const toolName = String(call.function?.name || "");
        const fallbackId = `${toolName || "tool"}_${executedTools + 1}`;
        const toolCallId = String(call.id || fallbackId);
        const toolArgs = String(call.function?.arguments || "");
        params.onToolEvent?.({
          phase: "start",
          callId: toolCallId,
          name: toolName,
          args: toolArgs
        });
        const toolResult = await mcp.executeToolCall(toolName, toolArgs, params.signal);
        params.onToolEvent?.({
          phase: "done",
          callId: toolCallId,
          name: toolName,
          args: toolArgs,
          result: toolResult
        });
        toolTraces.push({
          callId: toolCallId,
          name: toolName,
          args: toolArgs,
          result: toolResult
        });
        workingMessages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: toolResult
        });
        executedTools += 1;
      }
    }

    // Tool-call budget reached: perform final streamed assistant pass in caller.
    return { content: "", toolCalls: toolTraces, streamMessages: workingMessages };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    // If provider doesn't support tools/function calling, fallback to regular streaming flow.
    if (/tool|function.?call|tool_choice|unsupported/i.test(message)) {
      return null;
    }
    throw err;
  } finally {
    await mcp.close();
  }
}

function serializeToolTrace(trace: ToolCallTrace): string {
  const name = String(trace.name || "unknown_tool").trim();
  const args = String(trace.args || "").trim();
  const result = String(trace.result || "").trim();
  const safeArgs = args ? args.slice(0, 5000) : "{}";
  const safeResult = result ? result.slice(0, 12000) : "(empty)";
  return JSON.stringify({
    kind: "tool_call",
    callId: String(trace.callId || "").trim(),
    name,
    args: safeArgs,
    result: safeResult
  });
}

function deleteMessageTree(chatId: string, branchId: string, messageId: string) {
  db.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id
      FROM messages
      WHERE id = ? AND chat_id = ? AND branch_id = ? AND deleted = 0
      UNION ALL
      SELECT m.id
      FROM messages m
      JOIN descendants d ON m.parent_id = d.id
      WHERE m.chat_id = ? AND m.branch_id = ? AND m.deleted = 0
    )
    UPDATE messages
    SET deleted = 1
    WHERE id IN (SELECT id FROM descendants)
  `).run(messageId, chatId, branchId, chatId, branchId);
}

async function streamProviderCompletion(params: {
  provider: ProviderRow;
  modelId: string;
  messages: Array<{ role: string; content: unknown }>;
  samplerConfig: Record<string, unknown>;
  chatId: string;
  res: Response;
  signal: AbortSignal;
}) {
  const providerType = normalizeProviderType(params.provider.provider_type);
  const sc = params.samplerConfig;
  if (providerType === "koboldcpp") {
    const { prompt, memory } = buildKoboldPromptFromMessages(params.messages, sc);
    const body = buildKoboldGenerateBody({
      prompt,
      memory,
      samplerConfig: sc
    });

    const streamResponse = await requestKoboldGenerateStream(params.provider, body, params.signal);
    if (streamResponse.ok && streamResponse.body) {
      let fullContent = "";
      const reader = streamResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (params.signal.aborted) {
            await reader.cancel();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith("event:")) continue;
            const data = trimmed.startsWith("data: ")
              ? trimmed.slice(6).trim()
              : trimmed;
            if (!data || data === "[DONE]") continue;

            let delta = "";
            try {
              delta = extractKoboldStreamDelta(JSON.parse(data));
            } catch {
              delta = data;
            }
            if (!delta) continue;
            fullContent += delta;
            params.res.write(`data: ${JSON.stringify({ type: "delta", chatId: params.chatId, delta })}\n\n`);
          }
        }
      } catch (readErr) {
        if (!(readErr instanceof Error && readErr.name === "AbortError")) {
          throw readErr;
        }
      }

      if (fullContent.trim()) return fullContent;
    }

    const fallbackResponse = await requestKoboldGenerate(params.provider, body, params.signal);
    if (!fallbackResponse.ok) {
      const errText = await fallbackResponse.text().catch(() => "Unknown error");
      throw new Error(`[KoboldCpp API Error: ${fallbackResponse.status}] ${errText.slice(0, 200)}`);
    }
    const fallbackBody = await fallbackResponse.json().catch(() => ({}));
    const generated = extractKoboldGeneratedText(fallbackBody);
    if (generated) {
      await sendSseText(params.res, params.chatId, generated, 8);
    }
    return generated;
  }

  const baseUrl = String(params.provider.base_url || "").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.provider.api_key_cipher}`
    },
    body: JSON.stringify({
      model: params.modelId,
      messages: params.messages,
      stream: true,
      temperature: sc.temperature ?? 0.9,
      top_p: sc.topP ?? 1,
      frequency_penalty: sc.frequencyPenalty ?? 0,
      presence_penalty: sc.presencePenalty ?? 0,
      max_tokens: sc.maxTokens ?? 2048,
      ...(Array.isArray(sc.stop) && (sc.stop as string[]).length > 0 ? { stop: sc.stop } : {})
    }),
    signal: params.signal
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => "Unknown error");
    throw new Error(`[API Error: ${response.status}] ${errText.slice(0, 200)}`);
  }

  let fullContent = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (params.signal.aborted) {
        await reader.cancel();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            params.res.write(`data: ${JSON.stringify({ type: "delta", chatId: params.chatId, delta })}\n\n`);
          }
        } catch {
          // Ignore malformed stream chunks.
        }
      }
    }
  } catch (readErr) {
    if (!(readErr instanceof Error && readErr.name === "AbortError")) {
      throw readErr;
    }
  }

  return fullContent;
}

async function completeProviderOnce(params: {
  provider: ProviderRow;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  samplerConfig?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<string> {
  const providerType = normalizeProviderType(params.provider.provider_type);
  const sc = params.samplerConfig || {};

  if (providerType === "koboldcpp") {
    const customMemory = String(sc.koboldMemory || "").trim();
    const memory = [
      customMemory,
      params.systemPrompt
        ? `${KOBOLD_TAGS.systemOpen}\n${params.systemPrompt}\n${KOBOLD_TAGS.systemClose}`
        : ""
    ].filter(Boolean).join("\n\n");
    const body = buildKoboldGenerateBody({
      prompt: `${KOBOLD_TAGS.inputOpen}\n${params.userPrompt}\n${KOBOLD_TAGS.inputClose}\n\n${KOBOLD_TAGS.outputOpen}`,
      memory,
      samplerConfig: {
        ...sc,
        maxTokens: sc.maxTokens ?? 1024
      }
    });
    const response = await requestKoboldGenerate(params.provider, body, params.signal);
    if (!response.ok) return "";
    const parsed = await response.json().catch(() => ({}));
    return extractKoboldGeneratedText(parsed).trim();
  }

  const baseUrl = String(params.provider.base_url || "").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.provider.api_key_cipher}`
    },
    body: JSON.stringify({
      model: params.modelId,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt }
      ],
      temperature: sc.temperature ?? 0.3,
      max_tokens: sc.maxTokens ?? 1024
    }),
    signal: params.signal
  });
  if (!response.ok) return "";
  const body = await response.json() as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content?.trim() ?? "";
}

// Core LLM streaming function — used by send, regenerate, auto-conversation
async function streamLlmResponse(
  chatId: string,
  branchId: string,
  res: Response,
  parentMsgId: string | null,
  overrideCharacterName?: string,
  isAutoConvo?: boolean,
  userPersona?: UserPersonaPayload
) {
  const settings = getSettings();
  const providerId = settings.activeProviderId;
  const modelId = settings.activeModel;

  const chat = db.prepare("SELECT character_id, character_ids, lorebook_id, context_summary FROM chats WHERE id = ?").get(chatId) as {
    character_id: string | null; character_ids: string | null; lorebook_id: string | null; context_summary: string | null;
  } | undefined;

  // Build prompt
  const blocks = getPromptBlocks(chatId);
  const sceneState = getSceneState(chatId);
  const authorNote = getAuthorNote(chatId);
  const samplerConfig = getChatSamplerConfig(chatId, settings.samplerConfig);

  // Resolve user persona name for {{user}} placeholder
  const resolvedUserName = (userPersona?.name || "").trim() || "User";
  const personaInstruction = [
    userPersona?.description ? `Description: ${userPersona.description}` : "",
    userPersona?.personality ? `Personality: ${userPersona.personality}` : "",
    userPersona?.scenario ? `Scenario: ${userPersona.scenario}` : ""
  ].filter(Boolean).join("\n");

  // Multi-character support
  let characterIds: string[] = [];
  try {
    characterIds = JSON.parse(chat?.character_ids || "[]");
  } catch { /* empty */ }
  if (characterIds.length === 0 && chat?.character_id) {
    characterIds = [chat.character_id];
  }

  const characterCards: CharacterCardData[] = characterIds
    .map((id) => getCharacterCard(id))
    .filter((c): c is CharacterCardData => c !== null);

  const currentCharCard = overrideCharacterName
    ? characterCards.find((c) => c.name === overrideCharacterName) ?? characterCards[0] ?? null
    : characterCards[0] ?? getCharacterCard(chat?.character_id ?? null);

  const timeline = getTimeline(chatId, branchId).filter((m) => m.role === "user" || m.role === "assistant");
  const contextSummary = chat?.context_summary || "";
  const contextWindowBudget = getContextWindowBudget(settings as Record<string, unknown>);
  const withSummaryPercent = getTailBudgetPercent(settings as Record<string, unknown>, "contextTailBudgetWithSummaryPercent", 35);
  const withoutSummaryPercent = getTailBudgetPercent(settings as Record<string, unknown>, "contextTailBudgetWithoutSummaryPercent", 75);
  const promptTimeline = selectTimelineForPrompt(
    timeline,
    contextSummary,
    contextWindowBudget,
    withSummaryPercent,
    withoutSummaryPercent
  );

  const lorebookEntries = getLorebookEntries(chat?.lorebook_id || null);
  const loreBlockEnabled = blocks.some((block) => block.kind === "lore" && block.enabled);
  const triggeredLoreEntries = loreBlockEnabled
    ? getTriggeredLoreEntries(lorebookEntries, promptTimeline.map((item) => String(item.content || "")))
    : [];
  const effectiveBlocks = triggeredLoreEntries.length > 0
    ? injectLoreBlocks(blocks, triggeredLoreEntries)
    : blocks;
  const promptTimelineForModel = promptTimeline.map((item) => ({
    role: item.role,
    content: String(item.content || ""),
    characterName: item.characterName,
    attachments: toChatAttachments(item.attachments as MessageAttachmentPayload[] | undefined)
  }));

  let systemPrompt: string;
  if (characterCards.length > 1 && overrideCharacterName) {
    systemPrompt = buildMultiCharSystemPrompt(
      {
        blocks: effectiveBlocks,
        characterCard: currentCharCard,
        sceneState,
        authorNote,
        intensity: sceneState?.intensity ?? 0.5,
        responseLanguage: settings.responseLanguage,
        censorshipMode: settings.censorshipMode,
        contextSummary: chat?.context_summary || "",
        defaultSystemPrompt: settings.defaultSystemPrompt,
        userName: resolvedUserName
      },
      characterCards,
      overrideCharacterName
    );
    if (personaInstruction) {
      systemPrompt += `\n\n[User Persona]\nName: ${resolvedUserName}\n${personaInstruction}`;
    }
    // Auto-conversation instruction — tell the bot there's no user, just act between characters
    if (isAutoConvo) {
      systemPrompt += "\n\n[IMPORTANT: This is an autonomous conversation between characters. There is NO human user participating. Do NOT wait for user input, do NOT address the user, do NOT ask questions to the user. Act naturally and continue the roleplay conversation with the other character(s). Advance the plot, respond to what the other character said, and keep the story flowing. Be proactive — take actions, express emotions, move the scene forward.]";
    }
  } else {
    systemPrompt = buildSystemPrompt({
      blocks: effectiveBlocks, characterCard: currentCharCard, sceneState, authorNote,
      intensity: sceneState?.intensity ?? 0.5,
      responseLanguage: settings.responseLanguage,
      censorshipMode: settings.censorshipMode,
      contextSummary: chat?.context_summary || "",
      defaultSystemPrompt: settings.defaultSystemPrompt,
      userName: resolvedUserName
    });
    if (personaInstruction) {
      systemPrompt += `\n\n[User Persona]\nName: ${resolvedUserName}\n${personaInstruction}`;
    }
  }

  let apiMessages;

  if (characterCards.length > 1 && overrideCharacterName) {
    apiMessages = buildMultiCharMessageArray(
      systemPrompt,
      promptTimelineForModel,
      overrideCharacterName,
      authorNote,
      contextSummary,
      resolvedUserName
    );
  } else {
    apiMessages = buildMessageArray(
      systemPrompt,
      promptTimelineForModel,
      authorNote,
      contextSummary,
      currentCharCard?.name,
      resolvedUserName
    );
  }

  // Merge consecutive roles if enabled
  if (settings.mergeConsecutiveRoles) {
    apiMessages = mergeConsecutiveRoles(apiMessages);
  }

  if (!providerId || !modelId) {
    const lastUser = timeline.filter((m) => m.role === "user").pop();
    const assistantText = `[No provider configured] Echo: ${lastUser?.content || "..."}`;
    const assistantId = newId();
    db.prepare(
      "INSERT INTO messages (id, chat_id, branch_id, role, content, token_count, parent_id, deleted, created_at, character_name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)"
    ).run(assistantId, chatId, branchId, "assistant", assistantText, roughTokenCount(assistantText), parentMsgId, now(), overrideCharacterName || null, nextSortOrder(chatId, branchId));
    res.json(getTimeline(chatId, branchId));
    return;
  }

  const provider = db.prepare("SELECT * FROM providers WHERE id = ?").get(providerId) as ProviderRow | undefined;
  if (!provider) {
    const assistantText = `[Provider not found] Configure a provider in Settings.`;
    const assistantId = newId();
    db.prepare(
      "INSERT INTO messages (id, chat_id, branch_id, role, content, token_count, parent_id, deleted, created_at, character_name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)"
    ).run(assistantId, chatId, branchId, "assistant", assistantText, roughTokenCount(assistantText), parentMsgId, now(), overrideCharacterName || null, nextSortOrder(chatId, branchId));
    res.json(getTimeline(chatId, branchId));
    return;
  }

  if (settings.fullLocalMode && !isLocalhostUrl(provider.base_url)) {
    res.status(400).json({ error: "Provider blocked by Full Local Mode" });
    return;
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  // Set up abort controller for this chat
  const abortController = new AbortController();
  activeAbortControllers.set(chatId, abortController);

  // Clean up on client disconnect
  res.on("close", () => {
    abortController.abort();
    activeAbortControllers.delete(chatId);
  });

  try {
    const sc = samplerConfig as Record<string, unknown>;
    const toolCallingEnabled = settings.toolCallingEnabled === true
      && normalizeProviderType(provider.provider_type) === "openai";
    if (toolCallingEnabled) {
      const toolResult = await runToolCallingCompletion({
        provider,
        modelId,
        samplerConfig: sc,
        apiMessages: apiMessages as unknown as OpenAICompletionMessage[],
        settings: settings as Record<string, unknown>,
        signal: abortController.signal,
        onToolEvent: (event) => {
          const safeArgs = String(event.args || "").slice(0, 2000);
          const safeResult = typeof event.result === "string" ? event.result.slice(0, 4000) : undefined;
          res.write(`data: ${JSON.stringify({
            type: "tool",
            chatId,
            phase: event.phase,
            callId: event.callId,
            name: event.name,
            args: safeArgs,
            result: safeResult
          })}\n\n`);
        }
      });
      if (toolResult) {
        let fullContent = toolResult.content || "";
        if (Array.isArray(toolResult.streamMessages) && toolResult.streamMessages.length > 0) {
          fullContent = await streamProviderCompletion({
            provider,
            modelId,
            messages: toolResult.streamMessages as Array<{ role: string; content: unknown }>,
            samplerConfig: sc,
            chatId,
            res,
            signal: abortController.signal
          });
        } else if (fullContent) {
          await sendSseText(res, chatId, fullContent, 12);
        }

        if (fullContent || toolResult.toolCalls.length > 0) {
          const assistantId = newId();
          db.prepare(
            "INSERT INTO messages (id, chat_id, branch_id, role, content, token_count, parent_id, deleted, created_at, character_name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)"
          ).run(
            assistantId,
              chatId,
              branchId,
              "assistant",
              fullContent,
              await countProviderTokens(provider, fullContent),
              parentMsgId,
              now(),
              overrideCharacterName || null,
            nextSortOrder(chatId, branchId)
          );
          for (const toolCall of toolResult.toolCalls) {
            const toolText = serializeToolTrace(toolCall);
            db.prepare(
              "INSERT INTO messages (id, chat_id, branch_id, role, content, token_count, parent_id, deleted, created_at, character_name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)"
            ).run(
              newId(),
              chatId,
              branchId,
              "tool",
              toolText,
              roughTokenCount(toolText),
              assistantId,
              now(),
              null,
              nextSortOrder(chatId, branchId)
            );
          }
        }
        res.write(`data: ${JSON.stringify({ type: "done", chatId })}\n\n`);
        res.end();
        return;
      }
    }

    const fullContent = await streamProviderCompletion({
      provider,
      modelId,
      messages: apiMessages,
      samplerConfig: sc,
      chatId,
      res,
      signal: abortController.signal
    });

    // Insert assistant message (even partial if interrupted)
    if (fullContent) {
      const assistantId = newId();
      db.prepare(
        "INSERT INTO messages (id, chat_id, branch_id, role, content, token_count, parent_id, deleted, created_at, character_name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)"
      ).run(
        assistantId,
        chatId,
        branchId,
        "assistant",
        fullContent,
        await countProviderTokens(provider, fullContent),
        parentMsgId,
        now(),
        overrideCharacterName || null,
        nextSortOrder(chatId, branchId)
      );
    }

    res.write(`data: ${JSON.stringify({ type: "done", chatId })}\n\n`);
    res.end();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // Interrupted by user — save what we have
      res.write(`data: ${JSON.stringify({ type: "done", chatId, interrupted: true })}\n\n`);
      res.end();
    } else {
      const errMsg = err instanceof Error ? err.message : "Network error";
      const assistantText = `[Error] ${errMsg}`;
      const assistantId = newId();
      db.prepare(
        "INSERT INTO messages (id, chat_id, branch_id, role, content, token_count, parent_id, deleted, created_at, character_name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)"
      ).run(assistantId, chatId, branchId, "assistant", assistantText, roughTokenCount(assistantText), parentMsgId, now(), overrideCharacterName || null, nextSortOrder(chatId, branchId));
      res.write(`data: ${JSON.stringify({ type: "done", chatId })}\n\n`);
      res.end();
    }
  } finally {
    activeAbortControllers.delete(chatId);
  }
}

// --- Routes ---

// Abort/interrupt stream
router.post("/:id/abort", (req, res) => {
  const chatId = req.params.id;
  const controller = activeAbortControllers.get(chatId);
  if (controller) {
    controller.abort();
    activeAbortControllers.delete(chatId);
    res.json({ ok: true, interrupted: true });
  } else {
    res.json({ ok: true, interrupted: false });
  }
});

router.post("/", (req, res) => {
  const { title, characterId, characterIds } = req.body;
  const chatId = newId();
  const ts = now();

  const allCharIds: string[] = characterIds?.length ? characterIds : (characterId ? [characterId] : []);
  const charIdsJson = JSON.stringify(allCharIds);
  let lorebookId: string | null = req.body?.lorebookId ? String(req.body.lorebookId) : null;
  if (!lorebookId && allCharIds[0]) {
    const row = db.prepare("SELECT lorebook_id FROM characters WHERE id = ?").get(allCharIds[0]) as { lorebook_id: string | null } | undefined;
    lorebookId = row?.lorebook_id || null;
  }

  db.prepare("INSERT INTO chats (id, title, character_id, character_ids, lorebook_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(chatId, title, characterId || null, charIdsJson, lorebookId, ts);

  // Auto-create root branch
  const branchId = newId();
  db.prepare("INSERT INTO branches (id, chat_id, name, parent_message_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(branchId, chatId, "main", null, ts);

  // If character has a greeting, insert it as first message
  if (allCharIds.length > 0) {
    // Insert greeting from first character
    const firstChar = db.prepare("SELECT name, greeting FROM characters WHERE id = ?").get(allCharIds[0]) as { name: string; greeting: string } | undefined;
    if (firstChar?.greeting) {
      db.prepare(
        "INSERT INTO messages (id, chat_id, branch_id, role, content, token_count, parent_id, deleted, created_at, character_name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)"
      ).run(newId(), chatId, branchId, "assistant", firstChar.greeting, roughTokenCount(firstChar.greeting), null, ts, firstChar.name, 1);
    }
  }

  res.json({ id: chatId, title, characterId: characterId || null, characterIds: allCharIds, lorebookId, createdAt: ts });
});

router.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM chats ORDER BY created_at DESC").all() as {
    id: string; title: string; character_id: string | null; character_ids: string | null; lorebook_id: string | null; auto_conversation: number; created_at: string;
  }[];
  res.json(rows.map((r) => {
    let characterIds: string[] = [];
    try { characterIds = JSON.parse(r.character_ids || "[]"); } catch { /* empty */ }
    return {
      id: r.id, title: r.title, characterId: r.character_id,
      characterIds,
      lorebookId: r.lorebook_id || null,
      autoConversation: r.auto_conversation === 1,
      createdAt: r.created_at
    };
  }));
});

// Delete chat
router.delete("/:id", (req, res) => {
  const chatId = req.params.id;
  db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
  db.prepare("DELETE FROM branches WHERE chat_id = ?").run(chatId);
  db.prepare("DELETE FROM prompt_blocks WHERE chat_id = ?").run(chatId);
  try { db.prepare("DELETE FROM rp_scene_state WHERE chat_id = ?").run(chatId); } catch { /* table might not exist */ }
  try { db.prepare("DELETE FROM rp_memory_entries WHERE chat_id = ?").run(chatId); } catch { /* table might not exist */ }
  db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
  res.json({ ok: true });
});

// Update chat character list
router.patch("/:id/characters", (req, res) => {
  const chatId = req.params.id;
  const { characterIds } = req.body;
  db.prepare("UPDATE chats SET character_ids = ? WHERE id = ?").run(JSON.stringify(characterIds || []), chatId);
  res.json({ ok: true, characterIds });
});

router.patch("/:id/lorebook", (req, res) => {
  const chatId = req.params.id;
  const lorebookId = req.body?.lorebookId ? String(req.body.lorebookId) : null;
  db.prepare("UPDATE chats SET lorebook_id = ? WHERE id = ?").run(lorebookId, chatId);
  res.json({ ok: true, lorebookId });
});

router.get("/:id/lorebook", (req, res) => {
  const chatId = req.params.id;
  const row = db.prepare("SELECT lorebook_id FROM chats WHERE id = ?").get(chatId) as { lorebook_id: string | null } | undefined;
  res.json({ lorebookId: row?.lorebook_id || null });
});

router.get("/:id/branches", (req, res) => {
  const chatId = req.params.id;
  const rows = db.prepare(
    "SELECT id, chat_id, name, parent_message_id, created_at FROM branches WHERE chat_id = ? ORDER BY created_at ASC"
  ).all(chatId) as {
    id: string;
    chat_id: string;
    name: string;
    parent_message_id: string | null;
    created_at: string;
  }[];

  if (rows.length === 0) {
    const id = resolveBranch(chatId);
    const fallback = db.prepare(
      "SELECT id, chat_id, name, parent_message_id, created_at FROM branches WHERE id = ?"
    ).get(id) as {
      id: string;
      chat_id: string;
      name: string;
      parent_message_id: string | null;
      created_at: string;
    } | undefined;
    if (!fallback) {
      res.json([]);
      return;
    }
    res.json([{
      id: fallback.id,
      chatId: fallback.chat_id,
      name: fallback.name,
      parentMessageId: fallback.parent_message_id,
      createdAt: fallback.created_at
    }]);
    return;
  }

  res.json(rows.map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    name: row.name,
    parentMessageId: row.parent_message_id,
    createdAt: row.created_at
  })));
});

router.get("/:id/timeline", (req, res) => {
  const branchId = resolveBranch(req.params.id, req.query.branchId as string | undefined);
  res.json(getTimeline(req.params.id, branchId));
});

router.post("/:id/send", async (req, res: Response) => {
  const chatId = req.params.id;
  const { content, branchId: reqBranchId, userName, userPersona, attachments: rawAttachments } = req.body;
  const branchId = resolveBranch(chatId, reqBranchId);
  const persona: UserPersonaPayload = {
    name: String(userPersona?.name || userName || "User"),
    description: String(userPersona?.description || ""),
    personality: String(userPersona?.personality || ""),
    scenario: String(userPersona?.scenario || "")
  };
  const attachments = sanitizeAttachments(rawAttachments);

  // In multi-char mode, store who sent the message (user persona name)
  const chat = db.prepare("SELECT character_ids FROM chats WHERE id = ?").get(chatId) as { character_ids: string | null } | undefined;
  let charIds: string[] = [];
  try { charIds = JSON.parse(chat?.character_ids || "[]"); } catch { /* empty */ }
  const isMultiChar = charIds.length > 1;
  const senderName = (persona.name || "").trim() || "User";
  const settings = getSettings();
  const activeProviderId = String(settings.activeProviderId || "").trim();
  const activeProvider = activeProviderId
    ? db.prepare("SELECT * FROM providers WHERE id = ?").get(activeProviderId) as ProviderRow | undefined
    : undefined;
  const userTokenCount = await countProviderTokens(activeProvider, String(content || ""));

  // Insert user message — with character_name set to user persona name in multi-char mode
  const userId = newId();
  const userTs = now();
  db.prepare(
    "INSERT INTO messages (id, chat_id, branch_id, role, content, attachments, token_count, parent_id, deleted, created_at, character_name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)"
  ).run(
    userId,
    chatId,
    branchId,
    "user",
    String(content || ""),
    JSON.stringify(attachments),
    userTokenCount,
    null,
    userTs,
    isMultiChar ? senderName : "",
    nextSortOrder(chatId, branchId)
  );

  // In multi-char mode, the first character responds by default after user message
  if (isMultiChar && charIds.length > 0) {
    const firstChar = db.prepare("SELECT name FROM characters WHERE id = ?").get(charIds[0]) as { name: string } | undefined;
    await streamLlmResponse(chatId, branchId, res, userId, firstChar?.name, false, persona);
  } else {
    await streamLlmResponse(chatId, branchId, res, userId, undefined, false, persona);
  }
});

router.post("/:id/fork", (req, res) => {
  const chatId = req.params.id;
  const { parentMessageId, name } = req.body;
  if (!parentMessageId) {
    res.status(400).json({ error: "parentMessageId is required" });
    return;
  }

  const parent = db.prepare(
    "SELECT * FROM messages WHERE id = ? AND chat_id = ? AND deleted = 0"
  ).get(parentMessageId, chatId) as MessageRow | undefined;
  if (!parent) {
    res.status(404).json({ error: "Parent message not found" });
    return;
  }

  const branchId = newId();
  const ts = now();
  const branchName = String(name || "").trim() || `Branch ${parentMessageId.slice(0, 6)}`;
  const sourceRows = db.prepare(
    "SELECT * FROM messages WHERE chat_id = ? AND branch_id = ? AND deleted = 0 AND sort_order <= ? ORDER BY sort_order ASC, created_at ASC, id ASC"
  ).all(chatId, parent.branch_id, parent.sort_order) as MessageRow[];

  const insertBranch = db.prepare(
    "INSERT INTO branches (id, chat_id, name, parent_message_id, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const insertMessage = db.prepare(
    "INSERT INTO messages (id, chat_id, branch_id, role, content, attachments, token_count, parent_id, deleted, created_at, character_name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)"
  );

  const forkTx = db.transaction(() => {
    insertBranch.run(branchId, chatId, branchName, parentMessageId, ts);
    const idMap = new Map<string, string>();
    sourceRows.forEach((row, index) => {
      const copiedId = newId();
      idMap.set(row.id, copiedId);
      const mappedParentId = row.parent_id ? (idMap.get(row.parent_id) ?? null) : null;
      insertMessage.run(
        copiedId,
        chatId,
        branchId,
        row.role,
        row.content,
        row.attachments || "[]",
        row.token_count,
        mappedParentId,
        row.created_at,
        row.character_name || null,
        index + 1
      );
    });
  });

  forkTx();
  res.json({ id: branchId, chatId, name: branchName, parentMessageId, createdAt: ts });
});

router.post("/:id/regenerate", async (req, res: Response) => {
  const chatId = req.params.id;
  const { branchId: reqBranchId } = req.body ?? {};
  const branchId = resolveBranch(chatId, reqBranchId);

  const lastAssistant = db.prepare(
    "SELECT * FROM messages WHERE chat_id = ? AND branch_id = ? AND role = 'assistant' AND deleted = 0 ORDER BY created_at DESC LIMIT 1"
  ).get(chatId, branchId) as MessageRow | undefined;

  if (lastAssistant) {
    deleteMessageTree(chatId, branchId, lastAssistant.id);
  }

  const lastUser = db.prepare(
    "SELECT id FROM messages WHERE chat_id = ? AND branch_id = ? AND role = 'user' AND deleted = 0 ORDER BY created_at DESC LIMIT 1"
  ).get(chatId, branchId) as { id: string } | undefined;

  await streamLlmResponse(chatId, branchId, res, lastUser?.id ?? null);
});

// Multi-character: generate next turn for a specific character
router.post("/:id/next-turn", async (req, res: Response) => {
  const chatId = req.params.id;
  const { characterName, branchId: reqBranchId, isAutoConvo, userName, userPersona } = req.body;
  const branchId = resolveBranch(chatId, reqBranchId);
  const persona: UserPersonaPayload = {
    name: String(userPersona?.name || userName || "User"),
    description: String(userPersona?.description || ""),
    personality: String(userPersona?.personality || ""),
    scenario: String(userPersona?.scenario || "")
  };

  await streamLlmResponse(chatId, branchId, res, null, characterName, isAutoConvo, persona);
});

router.post("/:id/compress", async (req, res: Response) => {
  const chatId = req.params.id;
  const { branchId: reqBranchId } = req.body ?? {};
  const branchId = resolveBranch(chatId, reqBranchId);

  const settings = getSettings();
  const providerId = settings.compressProviderId || settings.activeProviderId;
  const modelId = settings.compressModel || settings.activeModel;
  const timeline = getTimeline(chatId, branchId);

  if (!providerId || !modelId || timeline.length === 0) {
    const summary = timeline.slice(-8).map((m) => `${m.role}: ${m.content.split("\n")[0].slice(0, 80)}`).join("\n");
    db.prepare("UPDATE chats SET context_summary = ? WHERE id = ?").run(summary, chatId);
    res.json({ summary });
    return;
  }

  const provider = db.prepare("SELECT * FROM providers WHERE id = ?").get(providerId) as ProviderRow | undefined;
  if (!provider) {
    res.json({ summary: "" });
    return;
  }

  const messagesToSummarize = timeline.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
  const compressTemplate = settings.promptTemplates?.compressSummary || "Summarize the following roleplay conversation. Preserve key plot points, character details, relationships, and important events. Be concise but thorough.";

  try {
    const summary = await completeProviderOnce({
      provider,
      modelId,
      systemPrompt: compressTemplate,
      userPrompt: messagesToSummarize,
      samplerConfig: { temperature: 0.3, maxTokens: 1024 }
    });

    db.prepare("UPDATE chats SET context_summary = ? WHERE id = ?").run(summary, chatId);
    res.json({ summary });
  } catch {
    res.json({ summary: "" });
  }
});

// --- Translate message ---
router.post("/messages/:id/translate", async (req, res: Response) => {
  const messageId = req.params.id;
  const { targetLanguage } = req.body ?? {};

  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow | undefined;
  if (!message) { res.status(404).json({ error: "Message not found" }); return; }

  const settings = getSettings();
  const providerId = settings.activeProviderId;
  const modelId = settings.activeModel;

  if (!providerId || !modelId) {
    res.json({ translation: `[No model configured] ${message.content}` });
    return;
  }

  const provider = db.prepare("SELECT * FROM providers WHERE id = ?").get(providerId) as ProviderRow | undefined;
  if (!provider) { res.json({ translation: message.content }); return; }

  const lang = targetLanguage || settings.responseLanguage || "English";

  try {
    const translation = await completeProviderOnce({
      provider,
      modelId,
      systemPrompt: `Translate the following message to ${lang}. Output ONLY the translation, nothing else. Preserve formatting, line breaks, and markdown.`,
      userPrompt: message.content,
      samplerConfig: { temperature: 0.2, maxTokens: 2048 }
    });
    res.json({ translation });
  } catch {
    res.json({ translation: message.content });
  }
});

// --- Per-chat sampler config ---
router.patch("/:id/sampler", (req, res) => {
  const chatId = req.params.id;
  const { samplerConfig } = req.body;
  db.prepare("UPDATE chats SET sampler_config = ? WHERE id = ?").run(JSON.stringify(samplerConfig), chatId);
  res.json({ ok: true });
});

router.get("/:id/sampler", (req, res) => {
  const chatId = req.params.id;
  const row = db.prepare("SELECT sampler_config FROM chats WHERE id = ?").get(chatId) as { sampler_config: string | null } | undefined;
  if (row?.sampler_config) {
    try {
      res.json(JSON.parse(row.sampler_config));
      return;
    } catch { /* fallback */ }
  }
  res.json(null);
});

// --- Per-chat active preset ---
router.patch("/:id/preset", (req, res) => {
  const chatId = req.params.id;
  const { presetId } = req.body;
  db.prepare("UPDATE chats SET active_preset = ? WHERE id = ?").run(presetId || null, chatId);
  res.json({ ok: true });
});

router.get("/:id/preset", (req, res) => {
  const chatId = req.params.id;
  const row = db.prepare("SELECT active_preset FROM chats WHERE id = ?").get(chatId) as { active_preset: string | null } | undefined;
  res.json({ presetId: row?.active_preset || null });
});

export default router;
