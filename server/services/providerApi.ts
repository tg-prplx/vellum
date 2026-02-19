export type ProviderType = "openai" | "koboldcpp";

export interface ProviderLike {
  base_url: string;
  api_key_cipher?: string;
  provider_type?: string | null;
}

function normalizeUrl(url: string): string {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function normalizeProviderType(raw: unknown): ProviderType {
  return raw === "koboldcpp" ? "koboldcpp" : "openai";
}

export function normalizeKoboldBaseUrl(baseUrl: string): string {
  let base = normalizeUrl(baseUrl);
  if (base.endsWith("/api/v1")) base = base.slice(0, -7);
  else if (base.endsWith("/v1")) base = base.slice(0, -3);
  else if (base.endsWith("/api")) base = base.slice(0, -4);
  return base || "http://localhost:5001";
}

function parseNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function parseStopSequences(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 32);
}

function parsePhraseBans(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 128);
  }
  if (typeof raw !== "string") return [];
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 128);
}

function parseSamplerOrder(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0)
    .slice(0, 16);
}

export function buildKoboldGenerateBody(params: {
  prompt: string;
  memory: string;
  samplerConfig: Record<string, unknown>;
}): Record<string, unknown> {
  const sc = params.samplerConfig || {};
  const stop = parseStopSequences(sc.stop);
  const bannedStrings = parsePhraseBans(sc.koboldBannedPhrases);
  const samplerOrder = parseSamplerOrder(sc.samplerOrder);
  const useDefaultBadwords = sc.koboldUseDefaultBadwords === true;
  const nSigma = parseNumber(sc.nSigma, 0, 0, 1);

  return {
    prompt: params.prompt,
    memory: params.memory,
    max_length: Math.floor(parseNumber(sc.maxTokens, 2048, 16, 8192)),
    temperature: parseNumber(sc.temperature, 0.9, 0, 5),
    top_p: parseNumber(sc.topP, 1, 0, 1),
    top_k: Math.floor(parseNumber(sc.topK, 100, 0, 1000)),
    top_a: parseNumber(sc.topA, 0, 0, 1),
    min_p: parseNumber(sc.minP, 0, 0, 1),
    typical: parseNumber(sc.typical, 1, 0, 1),
    tfs: parseNumber(sc.tfs, 1, 0, 1),
    rep_pen: parseNumber(sc.repetitionPenalty, 1.1, 0, 3),
    rep_pen_range: Math.floor(parseNumber(sc.repetitionPenaltyRange, 0, 0, 4096)),
    rep_pen_slope: parseNumber(sc.repetitionPenaltySlope, 1, 0, 10),
    use_default_badwordsids: useDefaultBadwords,
    trim_stop: true,
    replace_instruct_placeholders: true,
    ...(stop.length > 0 ? { stop_sequence: stop } : {}),
    ...(bannedStrings.length > 0 ? { banned_strings: bannedStrings, banned_tokens: bannedStrings } : {}),
    ...(samplerOrder.length > 0 ? { sampler_order: samplerOrder } : {}),
    ...(nSigma > 0 ? { nsigma: nSigma, n_sigma: nSigma, smoothing_factor: nSigma } : {})
  };
}

export async function requestKoboldGenerate(
  provider: ProviderLike,
  body: Record<string, unknown>,
  signal?: AbortSignal
) {
  const base = normalizeKoboldBaseUrl(provider.base_url);
  return fetch(`${base}/api/v1/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
}

export async function requestKoboldGenerateStream(
  provider: ProviderLike,
  body: Record<string, unknown>,
  signal?: AbortSignal
) {
  const base = normalizeKoboldBaseUrl(provider.base_url);
  return fetch(`${base}/api/extra/generate/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
}

export function extractKoboldGeneratedText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const row = raw as {
    text?: unknown;
    content?: unknown;
    result?: unknown;
    results?: Array<{ text?: unknown; content?: unknown }>;
  };
  if (typeof row.text === "string") return row.text;
  if (typeof row.content === "string") return row.content;
  if (typeof row.result === "string") return row.result;
  if (Array.isArray(row.results) && row.results[0]) {
    if (typeof row.results[0].text === "string") return row.results[0].text;
    if (typeof row.results[0].content === "string") return row.results[0].content;
  }
  return "";
}

export function extractKoboldStreamDelta(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const row = raw as {
    token?: unknown;
    text?: unknown;
    content?: unknown;
    delta?: unknown;
    results?: Array<{ token?: unknown; text?: unknown; content?: unknown }>;
  };
  if (typeof row.token === "string") return row.token;
  if (typeof row.delta === "string") return row.delta;
  if (typeof row.content === "string") return row.content;
  if (typeof row.text === "string") return row.text;
  if (Array.isArray(row.results) && row.results[0]) {
    if (typeof row.results[0].token === "string") return row.results[0].token;
    if (typeof row.results[0].content === "string") return row.results[0].content;
    if (typeof row.results[0].text === "string") return row.results[0].text;
  }
  return "";
}

function parseModelIds(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const row = raw as {
    id?: unknown;
    name?: unknown;
    model?: unknown;
    result?: unknown;
    data?: Array<{ id?: unknown; name?: unknown }>;
    models?: Array<{ id?: unknown; name?: unknown } | string>;
    results?: Array<{ id?: unknown; name?: unknown } | string>;
  };
  const out: string[] = [];
  if (typeof row.id === "string") out.push(row.id);
  if (typeof row.model === "string") out.push(row.model);
  if (typeof row.result === "string") out.push(row.result);
  if (typeof row.name === "string") out.push(row.name);
  if (Array.isArray(row.data)) {
    for (const item of row.data) {
      const id = String(item?.id || item?.name || "").trim();
      if (id) out.push(id);
    }
  }
  if (Array.isArray(row.models)) {
    for (const item of row.models) {
      const id = typeof item === "string"
        ? item
        : String(item?.id || item?.name || "").trim();
      if (id) out.push(id);
    }
  }
  if (Array.isArray(row.results)) {
    for (const item of row.results) {
      const id = typeof item === "string"
        ? item
        : String(item?.id || item?.name || "").trim();
      if (id) out.push(id);
    }
  }
  return [...new Set(out.map((item) => item.trim()).filter(Boolean))];
}

export async function fetchKoboldModels(provider: ProviderLike): Promise<string[]> {
  const base = normalizeKoboldBaseUrl(provider.base_url);
  const candidates = [
    `${base}/api/v1/models`,
    `${base}/api/extra/models`,
    `${base}/api/v1/model`,
    `${base}/api/extra/model`,
    `${base}/api/v1/info/model`,
    `${base}/v1/models`,
    `${base}/models`
  ];
  for (const url of candidates) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) continue;
      const raw = await response.text();
      let ids: string[] = [];
      try {
        ids = parseModelIds(JSON.parse(raw));
      } catch {
        const text = raw.trim();
        if (text && !text.startsWith("<")) {
          ids = [text];
        }
      }
      if (ids.length > 0) return ids;
    } catch {
      // Try next endpoint.
    }
  }
  return [];
}

export async function testKoboldConnection(provider: ProviderLike): Promise<boolean> {
  const base = normalizeKoboldBaseUrl(provider.base_url);
  const candidates = [
    `${base}/api/v1/model`,
    `${base}/api/v1/info/version`,
    `${base}/api/extra/version`
  ];
  for (const url of candidates) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return true;
    } catch {
      // Try next endpoint.
    }
  }
  return false;
}

export async function countKoboldTokens(
  provider: ProviderLike,
  prompt: string
): Promise<number | null> {
  const text = String(prompt || "");
  if (!text.trim()) return 0;
  const base = normalizeKoboldBaseUrl(provider.base_url);
  try {
    const response = await fetch(`${base}/api/extra/tokencount`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: text })
    });
    if (!response.ok) return null;
    const body = await response.json() as { value?: unknown; tokens?: unknown; count?: unknown };
    const value = Number(body.value ?? body.tokens ?? body.count);
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.floor(value);
  } catch {
    return null;
  }
}
