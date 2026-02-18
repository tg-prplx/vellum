import { Router } from "express";
import { writeFileSync } from "fs";
import { join } from "path";
import { db, newId, now, roughTokenCount, DATA_DIR, DEFAULT_SETTINGS } from "../db.js";
import { runConsistency } from "../domain/writerEngine.js";
import { buildKoboldGenerateBody, extractKoboldGeneratedText, normalizeProviderType, requestKoboldGenerate } from "../services/providerApi.js";

const router = Router();

interface ProviderRow {
  id: string;
  base_url: string;
  api_key_cipher: string;
  full_local_only: number;
  provider_type: string;
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
      const body = buildKoboldGenerateBody({
        prompt: `User: ${userPrompt}\n\nAssistant:`,
        memory: systemPrompt,
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
          repetitionPenalty: settings.samplerConfig.repetitionPenalty,
          repetitionPenaltyRange: settings.samplerConfig.repetitionPenaltyRange,
          repetitionPenaltySlope: settings.samplerConfig.repetitionPenaltySlope,
          samplerOrder: settings.samplerConfig.samplerOrder,
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
