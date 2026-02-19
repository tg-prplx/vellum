import { Router } from "express";
import { writeFileSync } from "fs";
import { join } from "path";
import { db, newId, now, DATA_DIR, DEFAULT_SETTINGS } from "../db.js";
import { runConsistency } from "../domain/writerEngine.js";
import { buildKoboldGenerateBody, extractKoboldGeneratedText, normalizeProviderType, requestKoboldGenerate } from "../services/providerApi.js";

const router = Router();
const KOBOLD_TAGS = {
  systemOpen: "{{[SYSTEM]}}",
  systemClose: "{{[SYSTEM_END]}}",
  inputOpen: "{{[INPUT]}}",
  inputClose: "{{[INPUT_END]}}",
  outputOpen: "{{[OUTPUT]}}"
};

interface ProviderRow {
  id: string;
  base_url: string;
  api_key_cipher: string;
  full_local_only: number;
  provider_type: string;
}

interface CharacterRow {
  id: string;
  name: string;
  card_json: string;
  lorebook_id: string | null;
  avatar_path: string | null;
  tags: string | null;
  greeting: string | null;
  system_prompt: string | null;
  description: string | null;
  personality: string | null;
  scenario: string | null;
  mes_example: string | null;
  creator_notes: string | null;
  created_at: string;
}

interface WriterChapterSettings {
  tone: string;
  pacing: "slow" | "balanced" | "fast";
  pov: "first_person" | "third_limited" | "third_omniscient";
  creativity: number;
  tension: number;
  detail: number;
  dialogue: number;
}

interface WriterSampler {
  temperature: number;
  maxTokens: number;
}

interface WriterCharacterAdvancedInput {
  name?: unknown;
  role?: unknown;
  personality?: unknown;
  scenario?: unknown;
  greetingStyle?: unknown;
  systemPrompt?: unknown;
  tags?: unknown;
  notes?: unknown;
}

interface WriterCharacterDraft {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  greeting: string;
  systemPrompt: string;
  mesExample: string;
  creatorNotes: string;
  tags: string[];
}

type WriterCharacterPatchField =
  | "name"
  | "description"
  | "personality"
  | "scenario"
  | "greeting"
  | "systemPrompt"
  | "mesExample"
  | "creatorNotes"
  | "tags";

interface WriterCharacterPatch {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  greeting?: string;
  systemPrompt?: string;
  mesExample?: string;
  creatorNotes?: string;
  tags?: string[];
}

const WRITER_CHARACTER_PATCH_FIELDS: readonly WriterCharacterPatchField[] = [
  "name",
  "description",
  "personality",
  "scenario",
  "greeting",
  "systemPrompt",
  "mesExample",
  "creatorNotes",
  "tags"
];

const WRITER_CHARACTER_PATCH_FIELD_SET = new Set<string>(WRITER_CHARACTER_PATCH_FIELDS);

const DEFAULT_CHAPTER_SETTINGS: WriterChapterSettings = {
  tone: "cinematic",
  pacing: "balanced",
  pov: "third_limited",
  creativity: 0.7,
  tension: 0.55,
  detail: 0.65,
  dialogue: 0.5
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function characterToJson(row: CharacterRow) {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags || "[]");
    if (Array.isArray(parsed)) tags = parsed.map((x) => String(x || "").trim()).filter(Boolean);
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    name: row.name,
    avatarUrl: row.avatar_path ? (row.avatar_path.startsWith("http") ? row.avatar_path : `/api/avatars/${row.avatar_path}`) : null,
    lorebookId: row.lorebook_id || null,
    tags,
    greeting: row.greeting || "",
    systemPrompt: row.system_prompt || "",
    description: row.description || "",
    personality: row.personality || "",
    scenario: row.scenario || "",
    mesExample: row.mes_example || "",
    creatorNotes: row.creator_notes || "",
    cardJson: row.card_json,
    createdAt: row.created_at
  };
}

function toCleanText(value: unknown, maxLen: number): string {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, maxLen);
}

function parseTagList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 16);
  }
  if (typeof value === "string") {
    return [...new Set(value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean))].slice(0, 16);
  }
  return [];
}

function extractFirstJsonObject(raw: string): Record<string, unknown> | null {
  const direct = raw.trim();
  if (direct.startsWith("{") && direct.endsWith("}")) {
    try {
      const parsed = JSON.parse(direct);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue with substring scanning.
    }
  }

  for (let start = raw.indexOf("{"); start >= 0; start = raw.indexOf("{", start + 1)) {
    let depth = 0;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = raw.slice(start, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            // Continue scanning.
          }
          break;
        }
      }
    }
  }

  return null;
}

function buildCharacterDraft(
  parsed: Record<string, unknown> | null,
  descriptionPrompt: string,
  advanced: WriterCharacterAdvancedInput | undefined
): WriterCharacterDraft {
  const data = parsed || {};
  const name = toCleanText(
    data.name ?? advanced?.name ?? "New Character",
    80
  ) || "New Character";
  const description = toCleanText(
    data.description ?? descriptionPrompt,
    2000
  ) || descriptionPrompt.slice(0, 2000);
  const personality = toCleanText(
    data.personality ?? advanced?.personality ?? "Expressive, consistent, and grounded in their own motives.",
    2000
  );
  const scenario = toCleanText(
    data.scenario ?? advanced?.scenario ?? advanced?.role ?? descriptionPrompt,
    2000
  );
  const greeting = toCleanText(
    data.greeting ?? data.first_mes ?? `${name} glances up with a faint, curious smile. "So, where do we begin?"`,
    1200
  );
  const systemPrompt = toCleanText(
    data.systemPrompt ?? data.system_prompt ?? advanced?.systemPrompt ?? `Stay in character as ${name}. Keep voice consistent and reactive to context.`,
    1600
  );
  const mesExample = toCleanText(
    data.mesExample ?? data.mes_example ?? `<START>\n{{user}}: Tell me about yourself.\n${name}: ${greeting}`,
    2000
  );
  const creatorNotes = toCleanText(
    data.creatorNotes ?? data.creator_notes ?? advanced?.notes ?? "Generated from Writing character builder.",
    2000
  );

  const tagsFromModel = parseTagList(data.tags);
  const tagsFromAdvanced = parseTagList(advanced?.tags);
  const tags = [...new Set([...tagsFromModel, ...tagsFromAdvanced])].slice(0, 16);

  return {
    name,
    description,
    personality,
    scenario,
    greeting,
    systemPrompt,
    mesExample,
    creatorNotes,
    tags
  };
}

function parseCharacterTagsJson(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return parseTagList(parsed);
  } catch {
    return [];
  }
}

function parseWriterCharacterPatchFields(raw: unknown): WriterCharacterPatchField[] {
  if (!Array.isArray(raw)) return [];
  const values = raw
    .map((item) => String(item || "").trim())
    .filter((item) => WRITER_CHARACTER_PATCH_FIELD_SET.has(item)) as WriterCharacterPatchField[];
  return [...new Set(values)];
}

function buildWriterCharacterPatch(parsed: Record<string, unknown> | null): WriterCharacterPatch {
  if (!parsed) return {};
  const patch: WriterCharacterPatch = {};

  if ("name" in parsed) patch.name = toCleanText(parsed.name, 80);
  if ("description" in parsed) patch.description = toCleanText(parsed.description, 2000);
  if ("personality" in parsed) patch.personality = toCleanText(parsed.personality, 2000);
  if ("scenario" in parsed) patch.scenario = toCleanText(parsed.scenario, 2000);
  if ("greeting" in parsed || "first_mes" in parsed) patch.greeting = toCleanText(parsed.greeting ?? parsed.first_mes, 1200);
  if ("systemPrompt" in parsed || "system_prompt" in parsed) patch.systemPrompt = toCleanText(parsed.systemPrompt ?? parsed.system_prompt, 1600);
  if ("mesExample" in parsed || "mes_example" in parsed) patch.mesExample = toCleanText(parsed.mesExample ?? parsed.mes_example, 2000);
  if ("creatorNotes" in parsed || "creator_notes" in parsed) patch.creatorNotes = toCleanText(parsed.creatorNotes ?? parsed.creator_notes, 2000);
  if ("tags" in parsed) patch.tags = parseTagList(parsed.tags);

  return patch;
}

function filterWriterCharacterPatch(patch: WriterCharacterPatch, fields: WriterCharacterPatchField[]): WriterCharacterPatch {
  if (fields.length === 0) return patch;
  const allowed = new Set(fields);
  const filtered: WriterCharacterPatch = {};
  for (const key of WRITER_CHARACTER_PATCH_FIELDS) {
    if (allowed.has(key) && patch[key] !== undefined) {
      filtered[key] = patch[key];
    }
  }
  return filtered;
}

function updateCharacterWithPatch(existing: CharacterRow, patch: WriterCharacterPatch): CharacterRow {
  const tags = patch.tags ?? parseCharacterTagsJson(existing.tags);
  const name = patch.name !== undefined ? (toCleanText(patch.name, 80) || existing.name || "New Character") : existing.name;
  const description = patch.description ?? (existing.description || "");
  const personality = patch.personality ?? (existing.personality || "");
  const scenario = patch.scenario ?? (existing.scenario || "");
  const greeting = patch.greeting ?? (existing.greeting || "");
  const systemPrompt = patch.systemPrompt ?? (existing.system_prompt || "");
  const mesExample = patch.mesExample ?? (existing.mes_example || "");
  const creatorNotes = patch.creatorNotes ?? (existing.creator_notes || "");

  let cardData: Record<string, unknown>;
  try {
    const parsed = JSON.parse(existing.card_json) as { data?: Record<string, unknown> };
    cardData = (parsed && parsed.data && typeof parsed.data === "object") ? { ...parsed.data } : {};
  } catch {
    cardData = {};
  }

  cardData.name = name;
  cardData.description = description;
  cardData.personality = personality;
  cardData.scenario = scenario;
  cardData.first_mes = greeting;
  cardData.system_prompt = systemPrompt;
  cardData.mes_example = mesExample;
  cardData.creator_notes = creatorNotes;
  cardData.tags = tags;

  const cardJson = JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: cardData }, null, 2);

  db.prepare(
    `UPDATE characters SET name = ?, description = ?, personality = ?, scenario = ?, greeting = ?,
     system_prompt = ?, tags = ?, mes_example = ?, creator_notes = ?, card_json = ? WHERE id = ?`
  ).run(
    name,
    description,
    personality,
    scenario,
    greeting,
    systemPrompt,
    JSON.stringify(tags),
    mesExample,
    creatorNotes,
    cardJson,
    existing.id
  );

  return db.prepare("SELECT * FROM characters WHERE id = ?").get(existing.id) as CharacterRow;
}

function parseIdArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.map((x) => String(x || "").trim()).filter(Boolean);
  return [...new Set(ids)];
}

function parseJsonIdArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    return parseIdArray(JSON.parse(raw));
  } catch {
    return [];
  }
}

function normalizeProjectName(input: unknown, fallback = "Untitled Book"): string {
  const value = String(input ?? "").trim();
  return value || fallback;
}

function normalizeChapterSettings(input: unknown): WriterChapterSettings {
  if (!input || typeof input !== "object") return { ...DEFAULT_CHAPTER_SETTINGS };
  const row = input as Partial<WriterChapterSettings>;
  const pacing = row.pacing === "slow" || row.pacing === "fast" ? row.pacing : "balanced";
  const pov = row.pov === "first_person" || row.pov === "third_omniscient" ? row.pov : "third_limited";
  return {
    tone: String(row.tone || DEFAULT_CHAPTER_SETTINGS.tone),
    pacing,
    pov,
    creativity: clamp01(Number(row.creativity ?? DEFAULT_CHAPTER_SETTINGS.creativity)),
    tension: clamp01(Number(row.tension ?? DEFAULT_CHAPTER_SETTINGS.tension)),
    detail: clamp01(Number(row.detail ?? DEFAULT_CHAPTER_SETTINGS.detail)),
    dialogue: clamp01(Number(row.dialogue ?? DEFAULT_CHAPTER_SETTINGS.dialogue))
  };
}

function parseChapterSettings(raw: string | null | undefined): WriterChapterSettings {
  if (!raw) return { ...DEFAULT_CHAPTER_SETTINGS };
  try {
    return normalizeChapterSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CHAPTER_SETTINGS };
  }
}

function createWriterSampler(base: { temperature?: number; maxTokens?: number }, chapter: WriterChapterSettings): WriterSampler {
  const baseTemperature = Number(base.temperature ?? 0.9);
  const baseMaxTokens = Number(base.maxTokens ?? 2048);
  const temperature = Math.max(0, Math.min(2, baseTemperature * (0.75 + chapter.creativity * 0.9)));
  const maxTokens = Math.max(256, Math.min(4096, Math.round(baseMaxTokens * (0.75 + chapter.detail * 0.7))));
  return { temperature, maxTokens };
}

function buildChapterDirective(chapter: WriterChapterSettings): string {
  const tone = chapter.tone.trim() || DEFAULT_CHAPTER_SETTINGS.tone;
  const pacing = chapter.pacing;
  const pov = chapter.pov;
  const creativityPercent = Math.round(chapter.creativity * 100);
  const dialoguePercent = Math.round(chapter.dialogue * 100);
  const detailPercent = Math.round(chapter.detail * 100);
  const tensionPercent = Math.round(chapter.tension * 100);

  return [
    "[Chapter Settings]",
    `Tone: ${tone}`,
    `Pacing: ${pacing}`,
    `POV: ${pov}`,
    `Creativity: ${creativityPercent}%`,
    `Detail richness: ${detailPercent}%`,
    `Dialogue share: ${dialoguePercent}%`,
    `Narrative tension: ${tensionPercent}%`,
    "Apply these settings consistently in the output."
  ].join("\n");
}

function buildCharacterContext(characterIds: string[]): string {
  if (characterIds.length === 0) return "";
  const rows = db.prepare(
    "SELECT id, name, description, personality, scenario, system_prompt FROM characters WHERE id IN (" +
      characterIds.map(() => "?").join(",") +
      ")"
  ).all(...characterIds) as {
    id: string;
    name: string;
    description: string;
    personality: string;
    scenario: string;
    system_prompt: string;
  }[];
  if (rows.length === 0) return "";

  const blocks = rows.map((row) => {
    return [
      `- ${row.name}`,
      row.description ? `  Description: ${row.description}` : "",
      row.personality ? `  Personality: ${row.personality}` : "",
      row.scenario ? `  Scenario role: ${row.scenario}` : "",
      row.system_prompt ? `  Voice notes: ${row.system_prompt}` : ""
    ].filter(Boolean).join("\n");
  });

  return ["[Creative Writing Cast]", ...blocks].join("\n");
}

function getSettings() {
  const row = db.prepare("SELECT payload FROM settings WHERE id = 1").get() as { payload: string };
  const stored = JSON.parse(row.payload);
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    samplerConfig: { ...DEFAULT_SETTINGS.samplerConfig, ...(stored.samplerConfig ?? {}) },
    promptTemplates: { ...DEFAULT_SETTINGS.promptTemplates, ...(stored.promptTemplates ?? {}) }
  };
}

async function callLlm(systemPrompt: string, userPrompt: string, sampler?: WriterSampler): Promise<string> {
  const settings = getSettings();
  const providerId = settings.activeProviderId;
  const modelId = settings.activeModel;

  if (!providerId || !modelId) {
    return `[No LLM configured] Placeholder for: ${userPrompt.slice(0, 100)}`;
  }

  const provider = db.prepare("SELECT * FROM providers WHERE id = ?").get(providerId) as ProviderRow | undefined;
  if (!provider) return "[Provider not found]";

  try {
    const providerType = normalizeProviderType(provider.provider_type);
    if (providerType === "koboldcpp") {
      const customMemory = String(settings.samplerConfig.koboldMemory || "").trim();
      const memory = [
        customMemory,
        systemPrompt
          ? `${KOBOLD_TAGS.systemOpen}\n${systemPrompt}\n${KOBOLD_TAGS.systemClose}`
          : ""
      ].filter(Boolean).join("\n\n");
      const body = buildKoboldGenerateBody({
        prompt: `${KOBOLD_TAGS.inputOpen}\n${userPrompt}\n${KOBOLD_TAGS.inputClose}\n\n${KOBOLD_TAGS.outputOpen}`,
        memory,
        samplerConfig: {
          temperature: sampler?.temperature ?? settings.samplerConfig.temperature ?? 0.9,
          maxTokens: sampler?.maxTokens ?? settings.samplerConfig.maxTokens ?? 2048,
          topP: settings.samplerConfig.topP,
          stop: settings.samplerConfig.stop,
          topK: settings.samplerConfig.topK,
          topA: settings.samplerConfig.topA,
          minP: settings.samplerConfig.minP,
          typical: settings.samplerConfig.typical,
          tfs: settings.samplerConfig.tfs,
          nSigma: settings.samplerConfig.nSigma,
          repetitionPenalty: settings.samplerConfig.repetitionPenalty,
          repetitionPenaltyRange: settings.samplerConfig.repetitionPenaltyRange,
          repetitionPenaltySlope: settings.samplerConfig.repetitionPenaltySlope,
          samplerOrder: settings.samplerConfig.samplerOrder,
          koboldMemory: settings.samplerConfig.koboldMemory,
          koboldUseDefaultBadwords: settings.samplerConfig.koboldUseDefaultBadwords,
          koboldBannedPhrases: settings.samplerConfig.koboldBannedPhrases
        }
      });
      const response = await requestKoboldGenerate(provider, body);
      if (!response.ok) {
        const errText = await response.text().catch(() => "KoboldCpp error");
        return `[KoboldCpp Error] ${errText.slice(0, 500)}`;
      }
      const payload = await response.json().catch(() => ({}));
      return extractKoboldGeneratedText(payload) || "[Empty response]";
    }

    const response = await fetch(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.api_key_cipher}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: sampler?.temperature ?? settings.samplerConfig.temperature ?? 0.9,
        max_tokens: sampler?.maxTokens ?? settings.samplerConfig.maxTokens ?? 2048
      })
    });

    const body = await response.json() as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? "[Empty response]";
  } catch (err) {
    return `[LLM Error] ${err instanceof Error ? err.message : "Unknown error"}`;
  }
}

router.post("/characters/generate", async (req, res) => {
  const description = typeof req.body?.description === "string"
    ? toCleanText(req.body.description, 5000)
    : "";
  if (!description) {
    res.status(400).json({ error: "Description is required" });
    return;
  }

  const mode = req.body?.mode === "advanced" ? "advanced" : "basic";
  const advanced = (req.body?.advanced && typeof req.body.advanced === "object")
    ? req.body.advanced as WriterCharacterAdvancedInput
    : undefined;

  const systemPrompt = [
    "You are a character designer for roleplay character cards.",
    "Return ONLY valid JSON without markdown.",
    "Required JSON keys: name, description, personality, scenario, greeting, systemPrompt, mesExample, creatorNotes, tags.",
    "tags must be an array of short strings."
  ].join("\n");

  const advancedHints = advanced ? [
    toCleanText(advanced.name, 120) ? `Name hint: ${toCleanText(advanced.name, 120)}` : "",
    toCleanText(advanced.role, 400) ? `Role/archetype: ${toCleanText(advanced.role, 400)}` : "",
    toCleanText(advanced.personality, 600) ? `Personality hints: ${toCleanText(advanced.personality, 600)}` : "",
    toCleanText(advanced.scenario, 1000) ? `Scenario hints: ${toCleanText(advanced.scenario, 1000)}` : "",
    toCleanText(advanced.greetingStyle, 300) ? `Greeting style: ${toCleanText(advanced.greetingStyle, 300)}` : "",
    toCleanText(advanced.systemPrompt, 600) ? `System prompt style: ${toCleanText(advanced.systemPrompt, 600)}` : "",
    toCleanText(advanced.tags, 400) ? `Tag hints: ${toCleanText(advanced.tags, 400)}` : "",
    toCleanText(advanced.notes, 800) ? `Extra notes: ${toCleanText(advanced.notes, 800)}` : ""
  ].filter(Boolean).join("\n") : "";

  const userPrompt = [
    `Create a roleplay character from this description:\n${description}`,
    mode === "advanced" ? "Use advanced constraints below when possible." : "Keep output concise and practical.",
    advancedHints
  ].filter(Boolean).join("\n\n");

  const raw = await callLlm(systemPrompt, userPrompt, {
    temperature: mode === "advanced" ? 1 : 0.85,
    maxTokens: 1400
  });

  const parsed = extractFirstJsonObject(raw);
  const draft = buildCharacterDraft(parsed, description, advanced);

  const id = newId();
  const ts = now();
  const cardJson = JSON.stringify({
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: draft.name,
      description: draft.description,
      personality: draft.personality,
      scenario: draft.scenario,
      first_mes: draft.greeting,
      system_prompt: draft.systemPrompt,
      mes_example: draft.mesExample,
      creator_notes: draft.creatorNotes,
      tags: draft.tags
    }
  }, null, 2);

  db.prepare(
    `INSERT INTO characters (id, name, card_json, lorebook_id, avatar_path, tags, greeting, system_prompt, description, personality, scenario, mes_example, creator_notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    draft.name,
    cardJson,
    null,
    null,
    JSON.stringify(draft.tags),
    draft.greeting,
    draft.systemPrompt,
    draft.description,
    draft.personality,
    draft.scenario,
    draft.mesExample,
    draft.creatorNotes,
    ts
  );

  const row = db.prepare("SELECT * FROM characters WHERE id = ?").get(id) as CharacterRow | undefined;
  if (!row) {
    res.status(500).json({ error: "Failed to create character" });
    return;
  }
  res.json(characterToJson(row));
});

router.post("/characters/:id/edit", async (req, res) => {
  const id = String(req.params.id || "").trim();
  const instruction = toCleanText(req.body?.instruction, 5000);
  if (!id) {
    res.status(400).json({ error: "Character id is required" });
    return;
  }
  if (!instruction) {
    res.status(400).json({ error: "Instruction is required" });
    return;
  }

  const existing = db.prepare("SELECT * FROM characters WHERE id = ?").get(id) as CharacterRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "Character not found" });
    return;
  }

  const selectedFields = parseWriterCharacterPatchFields(req.body?.fields);
  const currentCharacter = {
    name: existing.name || "",
    description: existing.description || "",
    personality: existing.personality || "",
    scenario: existing.scenario || "",
    greeting: existing.greeting || "",
    systemPrompt: existing.system_prompt || "",
    mesExample: existing.mes_example || "",
    creatorNotes: existing.creator_notes || "",
    tags: parseCharacterTagsJson(existing.tags)
  };

  const allowedText = selectedFields.length > 0
    ? selectedFields.join(", ")
    : WRITER_CHARACTER_PATCH_FIELDS.join(", ");

  const systemPrompt = [
    "You edit roleplay character cards using user instructions.",
    "Return ONLY valid JSON without markdown.",
    "Include ONLY fields that should be changed.",
    "Allowed keys: name, description, personality, scenario, greeting, systemPrompt, mesExample, creatorNotes, tags.",
    "If tags is provided, it must be an array of short strings.",
    "Do not include keys for unchanged values."
  ].join("\n");

  const userPrompt = [
    `Current character JSON:\n${JSON.stringify(currentCharacter, null, 2)}`,
    `Instruction:\n${instruction}`,
    `Allowed fields for this request: ${allowedText}`,
    "Apply only what the instruction asks for. If no changes are needed, return {}."
  ].join("\n\n");

  const raw = await callLlm(systemPrompt, userPrompt, {
    temperature: 0.7,
    maxTokens: 1400
  });

  const parsed = extractFirstJsonObject(raw);
  const patch = filterWriterCharacterPatch(buildWriterCharacterPatch(parsed), selectedFields);
  const changedFields = Object.keys(patch) as WriterCharacterPatchField[];

  if (changedFields.length === 0) {
    res.json({ character: characterToJson(existing), changedFields });
    return;
  }

  const updated = updateCharacterWithPatch(existing, patch);
  res.json({ character: characterToJson(updated), changedFields });
});

// --- Projects ---

router.post("/projects", (req, res) => {
  const { name, description, characterIds } = req.body as { name: string; description: string; characterIds?: unknown };
  const id = newId();
  const ts = now();
  const normalizedName = normalizeProjectName(name, `Book ${new Date().toLocaleDateString()}`);
  const normalizedDescription = String(description || "").trim() || "New writing project";
  const normalizedCharacterIds = parseIdArray(characterIds);
  db.prepare("INSERT INTO writer_projects (id, name, description, character_ids, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, normalizedName, normalizedDescription, JSON.stringify(normalizedCharacterIds), ts);
  res.json({ id, name: normalizedName, description: normalizedDescription, characterIds: normalizedCharacterIds, createdAt: ts });
});

router.get("/projects", (_req, res) => {
  const rows = db.prepare("SELECT * FROM writer_projects ORDER BY created_at DESC").all() as {
    id: string; name: string; description: string; character_ids: string | null; created_at: string;
  }[];
  res.json(rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    characterIds: parseJsonIdArray(r.character_ids),
    createdAt: r.created_at
  })));
});

router.get("/projects/:id", (req, res) => {
  const projectId = req.params.id;
  const project = db.prepare("SELECT * FROM writer_projects WHERE id = ?").get(projectId) as {
    id: string; name: string; description: string; character_ids: string | null; created_at: string;
  } | undefined;

  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const chapters = db.prepare("SELECT * FROM writer_chapters WHERE project_id = ? ORDER BY position ASC").all(projectId) as {
    id: string; project_id: string; title: string; position: number; settings_json: string | null; created_at: string;
  }[];

  const chapterIds = chapters.map((c) => c.id);
  let scenes: {
    id: string; chapter_id: string; title: string; content: string;
    goals: string; conflicts: string; outcomes: string; created_at: string;
  }[] = [];

  if (chapterIds.length > 0) {
    const placeholders = chapterIds.map(() => "?").join(",");
    scenes = db.prepare(`SELECT * FROM writer_scenes WHERE chapter_id IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...chapterIds) as typeof scenes;
  }

  res.json({
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      characterIds: parseJsonIdArray(project.character_ids),
      createdAt: project.created_at
    },
    chapters: chapters.map((c) => ({
      id: c.id,
      projectId: c.project_id,
      title: c.title,
      position: c.position,
      settings: parseChapterSettings(c.settings_json),
      createdAt: c.created_at
    })),
    scenes: scenes.map((s) => ({
      id: s.id, chapterId: s.chapter_id, title: s.title, content: s.content,
      goals: s.goals, conflicts: s.conflicts, outcomes: s.outcomes, createdAt: s.created_at
    }))
  });
});

router.patch("/projects/:id/characters", (req, res) => {
  const projectId = req.params.id;
  const characterIds = parseIdArray((req.body as { characterIds?: unknown })?.characterIds);
  const row = db.prepare("SELECT id, name, description, created_at FROM writer_projects WHERE id = ?")
    .get(projectId) as { id: string; name: string; description: string; created_at: string } | undefined;
  if (!row) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  db.prepare("UPDATE writer_projects SET character_ids = ? WHERE id = ?")
    .run(JSON.stringify(characterIds), projectId);

  res.json({
    id: row.id,
    name: row.name,
    description: row.description,
    characterIds,
    createdAt: row.created_at
  });
});

router.patch("/projects/:id", (req, res) => {
  const projectId = req.params.id;
  const row = db.prepare("SELECT id, name, description, character_ids, created_at FROM writer_projects WHERE id = ?")
    .get(projectId) as {
      id: string;
      name: string;
      description: string;
      character_ids: string | null;
      created_at: string;
    } | undefined;
  if (!row) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const body = req.body as { name?: unknown; description?: unknown };
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasDescription = Object.prototype.hasOwnProperty.call(body, "description");
  const nextName = hasName ? normalizeProjectName(body.name, row.name) : row.name;
  const nextDescription = hasDescription ? String(body.description ?? "").trim() : row.description;

  db.prepare("UPDATE writer_projects SET name = ?, description = ? WHERE id = ?")
    .run(nextName, nextDescription, projectId);

  res.json({
    id: row.id,
    name: nextName,
    description: nextDescription,
    characterIds: parseJsonIdArray(row.character_ids),
    createdAt: row.created_at
  });
});

// --- Chapters ---

router.post("/chapters", (req, res) => {
  const { projectId, title } = req.body;
  const id = newId();
  const ts = now();

  const posRow = db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM writer_chapters WHERE project_id = ?")
    .get(projectId) as { next_pos: number };

  const chapterSettings = { ...DEFAULT_CHAPTER_SETTINGS };
  db.prepare("INSERT INTO writer_chapters (id, project_id, title, position, settings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, projectId, title, posRow.next_pos, JSON.stringify(chapterSettings), ts);

  res.json({ id, projectId, title, position: posRow.next_pos, settings: chapterSettings, createdAt: ts });
});

router.post("/chapters/reorder", (req, res) => {
  const { projectId, orderedIds } = req.body as { projectId: string; orderedIds: string[] };
  const stmt = db.prepare("UPDATE writer_chapters SET position = ? WHERE id = ? AND project_id = ?");
  const txn = db.transaction(() => {
    orderedIds.forEach((id, idx) => stmt.run(idx + 1, id, projectId));
  });
  txn();
  res.json({ ok: true });
});

router.patch("/chapters/:id/settings", (req, res) => {
  const chapterId = req.params.id;
  const row = db.prepare("SELECT id, project_id, title, position, settings_json, created_at FROM writer_chapters WHERE id = ?")
    .get(chapterId) as {
      id: string;
      project_id: string;
      title: string;
      position: number;
      settings_json: string | null;
      created_at: string;
    } | undefined;
  if (!row) {
    res.status(404).json({ error: "Chapter not found" });
    return;
  }

  const current = parseChapterSettings(row.settings_json);
  const patchInput = (req.body as { settings?: unknown })?.settings;
  const patchObject =
    patchInput && typeof patchInput === "object"
      ? patchInput as Record<string, unknown>
      : {};
  const patch = normalizeChapterSettings({ ...current, ...patchObject });
  db.prepare("UPDATE writer_chapters SET settings_json = ? WHERE id = ?")
    .run(JSON.stringify(patch), chapterId);

  res.json({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    position: row.position,
    settings: patch,
    createdAt: row.created_at
  });
});

// --- Scenes / Generation (LLM-backed) ---

router.post("/chapters/:id/generate-draft", async (req, res) => {
  const chapterId = req.params.id;
  const { prompt } = req.body;
  const chapter = db.prepare("SELECT project_id, settings_json FROM writer_chapters WHERE id = ?")
    .get(chapterId) as { project_id: string; settings_json: string | null } | undefined;
  if (!chapter) {
    res.status(404).json({ error: "Chapter not found" });
    return;
  }
  const project = db.prepare("SELECT character_ids FROM writer_projects WHERE id = ?")
    .get(chapter.project_id) as { character_ids: string | null } | undefined;

  const chapterSettings = parseChapterSettings(chapter.settings_json);
  const id = newId();
  const ts = now();

  const settings = getSettings();
  const systemPrompt = [
    settings.promptTemplates.writerGenerate,
    buildChapterDirective(chapterSettings),
    buildCharacterContext(parseJsonIdArray(project?.character_ids))
  ].filter(Boolean).join("\n\n");
  const sampler = createWriterSampler(settings.samplerConfig, chapterSettings);
  const content = await callLlm(systemPrompt, prompt, sampler);
  const titleMatch = content.match(/^#\s*(.+)/m);
  const title = titleMatch ? titleMatch[1].slice(0, 60) : "Generated Scene";

  db.prepare(
    "INSERT INTO writer_scenes (id, chapter_id, title, content, goals, conflicts, outcomes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, chapterId, title, content, "Advance plot", "Internal conflict", "Open ending", ts);

  res.json({
    id, chapterId, title, content,
    goals: "Advance plot", conflicts: "Internal conflict", outcomes: "Open ending", createdAt: ts
  });
});

router.post("/scenes/:id/expand", async (req, res) => {
  const sceneId = req.params.id;
  const row = db.prepare("SELECT * FROM writer_scenes WHERE id = ?").get(sceneId) as {
    id: string; chapter_id: string; title: string; content: string;
    goals: string; conflicts: string; outcomes: string; created_at: string;
  } | undefined;

  if (!row) { res.status(404).json({ error: "Scene not found" }); return; }

  const settings = getSettings();
  const chapter = db.prepare("SELECT project_id, settings_json FROM writer_chapters WHERE id = ?")
    .get(row.chapter_id) as { project_id: string; settings_json: string | null } | undefined;
  const project = chapter
    ? db.prepare("SELECT character_ids FROM writer_projects WHERE id = ?").get(chapter.project_id) as { character_ids: string | null } | undefined
    : undefined;
  const chapterSettings = parseChapterSettings(chapter?.settings_json);
  const systemPrompt = [
    settings.promptTemplates.writerExpand,
    buildChapterDirective(chapterSettings),
    buildCharacterContext(parseJsonIdArray(project?.character_ids))
  ].filter(Boolean).join("\n\n");
  const sampler = createWriterSampler(settings.samplerConfig, chapterSettings);
  const expanded = await callLlm(systemPrompt, row.content, sampler);

  db.prepare("UPDATE writer_scenes SET content = ? WHERE id = ?").run(expanded, sceneId);

  res.json({
    id: row.id, chapterId: row.chapter_id, title: row.title, content: expanded,
    goals: row.goals, conflicts: row.conflicts, outcomes: row.outcomes, createdAt: row.created_at
  });
});

router.post("/scenes/:id/rewrite", async (req, res) => {
  const sceneId = req.params.id;
  const toneRaw = typeof req.body?.tone === "string" ? req.body.tone : "";
  const row = db.prepare("SELECT * FROM writer_scenes WHERE id = ?").get(sceneId) as {
    id: string; chapter_id: string; title: string; content: string;
    goals: string; conflicts: string; outcomes: string; created_at: string;
  } | undefined;

  if (!row) { res.status(404).json({ error: "Scene not found" }); return; }

  const settings = getSettings();
  const chapter = db.prepare("SELECT project_id, settings_json FROM writer_chapters WHERE id = ?")
    .get(row.chapter_id) as { project_id: string; settings_json: string | null } | undefined;
  const project = chapter
    ? db.prepare("SELECT character_ids FROM writer_projects WHERE id = ?").get(chapter.project_id) as { character_ids: string | null } | undefined
    : undefined;
  const chapterSettings = parseChapterSettings(chapter?.settings_json);
  const mergedToneSettings = normalizeChapterSettings({
    ...chapterSettings,
    tone: toneRaw.trim() || chapterSettings.tone
  });
  const systemPrompt = [
    (settings.promptTemplates.writerRewrite || "").replace("{{tone}}", mergedToneSettings.tone),
    buildChapterDirective(mergedToneSettings),
    buildCharacterContext(parseJsonIdArray(project?.character_ids))
  ].filter(Boolean).join("\n\n");
  const sampler = createWriterSampler(settings.samplerConfig, mergedToneSettings);
  const rewritten = await callLlm(systemPrompt, row.content, sampler);

  db.prepare("UPDATE writer_scenes SET content = ? WHERE id = ?").run(rewritten, sceneId);

  res.json({
    id: row.id, chapterId: row.chapter_id, title: row.title, content: rewritten,
    goals: row.goals, conflicts: row.conflicts, outcomes: row.outcomes, createdAt: row.created_at
  });
});

router.get("/scenes/:id/summarize", async (req, res) => {
  const row = db.prepare("SELECT chapter_id, content FROM writer_scenes WHERE id = ?")
    .get(req.params.id) as { chapter_id: string; content: string } | undefined;

  if (!row) { res.status(404).json({ error: "Scene not found" }); return; }

  const settings = getSettings();
  const chapter = db.prepare("SELECT project_id, settings_json FROM writer_chapters WHERE id = ?")
    .get(row.chapter_id) as { project_id: string; settings_json: string | null } | undefined;
  const project = chapter
    ? db.prepare("SELECT character_ids FROM writer_projects WHERE id = ?").get(chapter.project_id) as { character_ids: string | null } | undefined
    : undefined;
  const chapterSettings = parseChapterSettings(chapter?.settings_json);
  const systemPrompt = [
    settings.promptTemplates.writerSummarize,
    buildChapterDirective(chapterSettings),
    buildCharacterContext(parseJsonIdArray(project?.character_ids))
  ].filter(Boolean).join("\n\n");
  const summary = await callLlm(systemPrompt, row.content, createWriterSampler(settings.samplerConfig, chapterSettings));

  res.json(summary);
});

// Scene content update (direct editing)
router.patch("/scenes/:id", (req, res) => {
  const sceneId = req.params.id;
  const { content, title, goals, conflicts, outcomes } = req.body;
  const row = db.prepare("SELECT * FROM writer_scenes WHERE id = ?").get(sceneId) as {
    id: string; chapter_id: string; title: string; content: string;
    goals: string; conflicts: string; outcomes: string; created_at: string;
  } | undefined;
  if (!row) { res.status(404).json({ error: "Scene not found" }); return; }

  const newContent = content ?? row.content;
  const newTitle = title ?? row.title;
  const newGoals = goals ?? row.goals;
  const newConflicts = conflicts ?? row.conflicts;
  const newOutcomes = outcomes ?? row.outcomes;

  db.prepare("UPDATE writer_scenes SET content = ?, title = ?, goals = ?, conflicts = ?, outcomes = ? WHERE id = ?")
    .run(newContent, newTitle, newGoals, newConflicts, newOutcomes, sceneId);

  res.json({
    id: row.id, chapterId: row.chapter_id, title: newTitle, content: newContent,
    goals: newGoals, conflicts: newConflicts, outcomes: newOutcomes, createdAt: row.created_at
  });
});

// --- Consistency ---

router.post("/projects/:id/consistency", (req, res) => {
  const projectId = req.params.id;

  const chapters = db.prepare("SELECT id FROM writer_chapters WHERE project_id = ?")
    .all(projectId) as { id: string }[];
  const chapterIds = chapters.map((c) => c.id);

  let scenes: { id: string; title: string; content: string }[] = [];
  if (chapterIds.length > 0) {
    const placeholders = chapterIds.map(() => "?").join(",");
    scenes = db.prepare(`SELECT id, title, content FROM writer_scenes WHERE chapter_id IN (${placeholders})`)
      .all(...chapterIds) as typeof scenes;
  }

  const issues = runConsistency(projectId, scenes);

  db.prepare("INSERT INTO writer_consistency_reports (id, project_id, payload, created_at) VALUES (?, ?, ?, ?)")
    .run(newId(), projectId, JSON.stringify(issues), now());

  res.json(issues);
});

// --- Export ---

router.post("/projects/:id/export/markdown", (req, res) => {
  const projectId = req.params.id;
  const project = db.prepare("SELECT name FROM writer_projects WHERE id = ?").get(projectId) as { name: string } | undefined;
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const chapters = db.prepare("SELECT * FROM writer_chapters WHERE project_id = ? ORDER BY position ASC")
    .all(projectId) as { id: string; title: string }[];

  let markdown = `# ${project.name}\n\n`;
  for (const ch of chapters) {
    markdown += `## ${ch.title}\n\n`;
    const scenes = db.prepare("SELECT title, content FROM writer_scenes WHERE chapter_id = ? ORDER BY created_at ASC")
      .all(ch.id) as { title: string; content: string }[];
    for (const sc of scenes) {
      markdown += `### ${sc.title}\n\n${sc.content}\n\n`;
    }
  }

  const outputPath = join(DATA_DIR, `book-${projectId}.md`);
  writeFileSync(outputPath, markdown);

  db.prepare("INSERT INTO writer_exports (id, project_id, export_type, output_path, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(newId(), projectId, "markdown", outputPath, now());

  res.json(outputPath);
});

router.post("/projects/:id/export/docx", (req, res) => {
  const projectId = req.params.id;
  const project = db.prepare("SELECT name FROM writer_projects WHERE id = ?").get(projectId) as { name: string } | undefined;
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const chapters = db.prepare("SELECT * FROM writer_chapters WHERE project_id = ? ORDER BY position ASC")
    .all(projectId) as { id: string; title: string }[];

  let text = `${project.name}\n\n`;
  for (const ch of chapters) {
    text += `${ch.title}\n\n`;
    const scenes = db.prepare("SELECT title, content FROM writer_scenes WHERE chapter_id = ? ORDER BY created_at ASC")
      .all(ch.id) as { title: string; content: string }[];
    for (const sc of scenes) {
      text += `${sc.title}\n${sc.content}\n\n`;
    }
  }

  const outputPath = join(DATA_DIR, `book-${projectId}.docx`);
  writeFileSync(outputPath, text);

  db.prepare("INSERT INTO writer_exports (id, project_id, export_type, output_path, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(newId(), projectId, "docx", outputPath, now());

  res.json(outputPath);
});

export default router;
