import { useEffect, useMemo, useRef, useState } from "react";
import { ThreePanelLayout, PanelTitle, Badge, EmptyState } from "../../components/Panels";
import { api } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import type {
  BookProject,
  Chapter,
  CharacterDetail,
  ConsistencyIssue,
  ProviderModel,
  ProviderProfile,
  Scene,
  WriterChapterSettings,
  WriterCharacterAdvancedOptions,
  WriterCharacterEditField
} from "../../shared/types/contracts";

const SEVERITY_STYLES: Record<string, { badge: "warning" | "danger" | "default"; border: string }> = {
  low: { badge: "default", border: "border-border-subtle" },
  medium: { badge: "warning", border: "border-warning-border" },
  high: { badge: "danger", border: "border-danger-border" }
};

const DEFAULT_CHAPTER_SETTINGS: WriterChapterSettings = {
  tone: "cinematic",
  pacing: "balanced",
  pov: "third_limited",
  creativity: 0.7,
  tension: 0.55,
  detail: 0.65,
  dialogue: 0.5
};

const DEFAULT_WRITER_CHARACTER_ADVANCED: WriterCharacterAdvancedOptions = {
  name: "",
  role: "",
  personality: "",
  scenario: "",
  greetingStyle: "",
  systemPrompt: "",
  tags: "",
  notes: ""
};

type WritingWorkspaceMode = "books" | "characters";

interface CharacterEditDraft {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  greeting: string;
  systemPrompt: string;
  mesExample: string;
  creatorNotes: string;
  tagsText: string;
}

interface CharacterEditStatus {
  tone: "success" | "error";
  text: string;
}

const CHARACTER_AI_EDIT_FIELDS: WriterCharacterEditField[] = [
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

const EMPTY_CHARACTER_EDIT_DRAFT: CharacterEditDraft = {
  name: "",
  description: "",
  personality: "",
  scenario: "",
  greeting: "",
  systemPrompt: "",
  mesExample: "",
  creatorNotes: "",
  tagsText: ""
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// Background task tracking — persists across mounts
interface BackgroundTask {
  id: string;
  type: "generate" | "expand" | "rewrite" | "summarize" | "consistency" | "character";
  label: string;
  startedAt: number;
  status: "running" | "done" | "error";
  result?: string;
}

const _backgroundTasks: BackgroundTask[] = [];

function getBackgroundTasks(): BackgroundTask[] {
  return _backgroundTasks;
}

function addBackgroundTask(task: BackgroundTask) {
  _backgroundTasks.unshift(task);
  if (_backgroundTasks.length > 20) _backgroundTasks.pop();
}

function updateBackgroundTask(id: string, update: Partial<BackgroundTask>) {
  const task = _backgroundTasks.find((t) => t.id === id);
  if (task) Object.assign(task, update);
}

export function WritingScreen() {
  const { t } = useI18n();
  const [projects, setProjects] = useState<BookProject[]>([]);
  const [activeProject, setActiveProject] = useState<BookProject | null>(null);
  const [characters, setCharacters] = useState<CharacterDetail[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [issues, setIssues] = useState<ConsistencyIssue[]>([]);
  const [chapterPrompt, setChapterPrompt] = useState("");
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [generationLog, setGenerationLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [editingContent, setEditingContent] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [bgTasks, setBgTasks] = useState<BackgroundTask[]>(getBackgroundTasks());
  const [chapterSettings, setChapterSettings] = useState<WriterChapterSettings>({ ...DEFAULT_CHAPTER_SETTINGS });
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [writerProviderId, setWriterProviderId] = useState("");
  const [writerModelId, setWriterModelId] = useState("");
  const [activeModelLabel, setActiveModelLabel] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [characterPrompt, setCharacterPrompt] = useState("");
  const [characterAdvancedMode, setCharacterAdvancedMode] = useState(false);
  const [characterAdvanced, setCharacterAdvanced] = useState<WriterCharacterAdvancedOptions>({ ...DEFAULT_WRITER_CHARACTER_ADVANCED });
  const [characterBusy, setCharacterBusy] = useState(false);
  const [characterError, setCharacterError] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<WritingWorkspaceMode>("books");
  const [characterEditorId, setCharacterEditorId] = useState<string | null>(null);
  const [characterEditDraft, setCharacterEditDraft] = useState<CharacterEditDraft>({ ...EMPTY_CHARACTER_EDIT_DRAFT });
  const [characterEditBusy, setCharacterEditBusy] = useState(false);
  const [characterEditStatus, setCharacterEditStatus] = useState<CharacterEditStatus | null>(null);
  const [characterAiInstruction, setCharacterAiInstruction] = useState("");
  const [characterAiFields, setCharacterAiFields] = useState<WriterCharacterEditField[]>([]);
  const [characterAiBusy, setCharacterAiBusy] = useState(false);
  const chapterSettingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.writerProjectList().then(setProjects);
    api.characterList().then(setCharacters).catch(() => {});
    api.providerList().then(setProviders).catch(() => {});
    api.settingsGet().then((settings) => {
      if (settings.activeProviderId) setWriterProviderId(settings.activeProviderId);
      if (settings.activeModel) {
        setWriterModelId(settings.activeModel);
        setActiveModelLabel(settings.activeModel);
      }
    }).catch(() => {});
    // Show any running/completed background tasks from previous visits
    setBgTasks([...getBackgroundTasks()]);
  }, []);

  useEffect(() => {
    if (!writerProviderId) {
      setModels([]);
      setWriterModelId("");
      return;
    }
    setLoadingModels(true);
    api.providerFetchModels(writerProviderId)
      .then((list) => {
        setModels(list);
        setWriterModelId((prev) => {
          if (list.length === 0) return "";
          return list.some((m) => m.id === prev) ? prev : list[0].id;
        });
      })
      .catch(() => {
        setModels([]);
        setWriterModelId("");
      })
      .finally(() => setLoadingModels(false));
  }, [writerProviderId]);

  function log(msg: string) {
    setGenerationLog((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);
  }

  function startBgTask(type: BackgroundTask["type"], label: string): string {
    const id = `task-${Date.now()}`;
    const task: BackgroundTask = { id, type, label, startedAt: Date.now(), status: "running" };
    addBackgroundTask(task);
    setBgTasks([...getBackgroundTasks()]);
    return id;
  }

  function finishBgTask(id: string, status: "done" | "error", result?: string) {
    updateBackgroundTask(id, { status, result });
    setBgTasks([...getBackgroundTasks()]);
  }

  async function createProject() {
    const defaultName = `${t("writing.defaultBookPrefix")} ${projects.length + 1}`;
    const name = newProjectName.trim() || defaultName;
    const project = await api.writerProjectCreate(name, t("writing.defaultProjectDescription"), []);
    setProjects((prev) => [project, ...prev]);
    setActiveProject(project);
    setNewProjectName("");
    setRenameDraft(project.name || "");
    setChapters([]);
    setScenes([]);
    setSelectedChapterId(null);
    setSelectedSceneId(null);
    setChapterSettings({ ...DEFAULT_CHAPTER_SETTINGS });
  }

  async function renameActiveProject() {
    if (!activeProject) return;
    const nextName = renameDraft.trim();
    if (!nextName || nextName === activeProject.name) return;
    try {
      const updated = await api.writerProjectUpdate(activeProject.id, { name: nextName });
      setActiveProject(updated);
      setRenameDraft(updated.name || "");
      setProjects((prev) => prev.map((project) => (project.id === updated.id ? updated : project)));
      log(`${t("writing.logBookRenamed")}: ${updated.name}`);
    } catch (err) {
      log(`${t("writing.logError")}: ${String(err)}`);
    }
  }

  async function applyWriterModel() {
    if (!writerProviderId || !writerModelId) return;
    try {
      const updated = await api.providerSetActive(writerProviderId, writerModelId);
      if (updated.activeProviderId) setWriterProviderId(updated.activeProviderId);
      if (updated.activeModel) {
        setWriterModelId(updated.activeModel);
        setActiveModelLabel(updated.activeModel);
      } else {
        setActiveModelLabel(writerModelId);
      }
      log(`${t("writing.modelSet")}: ${updated.activeModel || writerModelId}`);
    } catch (err) {
      log(`${t("writing.logError")}: ${String(err)}`);
    }
  }

  async function openProject(project: BookProject) {
    const loaded = await api.writerProjectOpen(project.id);
    setActiveProject(loaded.project);
    setChapters(loaded.chapters);
    setScenes(loaded.scenes);
    setSelectedChapterId(loaded.chapters[0]?.id ?? null);
    setSelectedSceneId(loaded.scenes[0]?.id ?? null);
    setChapterSettings(loaded.chapters[0]?.settings ?? { ...DEFAULT_CHAPTER_SETTINGS });
  }

  async function createChapter() {
    if (!activeProject) return;
    const chapter = await api.writerChapterCreate(activeProject.id, `${t("writing.defaultChapterPrefix")} ${chapters.length + 1}`);
    setChapters((prev) => [...prev, chapter]);
    setSelectedChapterId(chapter.id);
    setChapterSettings(chapter.settings ?? { ...DEFAULT_CHAPTER_SETTINGS });
    log(`${t("writing.logChapterCreated")}: ${chapter.title}`);
  }

  async function generateDraft() {
    if (!selectedChapterId || busy) return;
    setBusy(true);
    const taskId = startBgTask("generate", `${t("writing.taskGenerate")}: "${chapterPrompt.slice(0, 30)}..."`);
    log(t("writing.working"));
    try {
      const scene = await api.writerGenerateDraft(selectedChapterId, chapterPrompt);
      setScenes((prev) => [...prev, scene]);
      setSelectedSceneId(scene.id);
      log(`${t("writing.logDraftGenerated")}: ${scene.title}`);
      finishBgTask(taskId, "done", scene.title);
    } catch (err) {
      log(`${t("writing.logError")}: ${String(err)}`);
      finishBgTask(taskId, "error", String(err));
    }
    setBusy(false);
  }

  async function runConsistency() {
    if (!activeProject) return;
    const taskId = startBgTask("consistency", t("writing.taskConsistency"));
    const report = await api.writerConsistencyRun(activeProject.id);
    setIssues(report);
    log(`${t("writing.logConsistencyFound")}: ${report.length}`);
    finishBgTask(taskId, "done", `${report.length} ${t("writing.issuesCount")}`);
  }

  async function expandScene() {
    if (!selectedSceneId || busy) return;
    setBusy(true);
    const taskId = startBgTask("expand", t("writing.taskExpand"));
    log(t("writing.working"));
    try {
      const scene = await api.writerSceneExpand(selectedSceneId);
      setScenes((prev) => prev.map((s) => (s.id === scene.id ? scene : s)));
      log(t("writing.logSceneExpanded"));
      finishBgTask(taskId, "done");
    } catch (err) {
      log(`${t("writing.logError")}: ${String(err)}`);
      finishBgTask(taskId, "error", String(err));
    }
    setBusy(false);
  }

  async function rewriteScene() {
    if (!selectedSceneId || busy) return;
    setBusy(true);
    const tone = (chapterSettings.tone || DEFAULT_CHAPTER_SETTINGS.tone).trim();
    const taskId = startBgTask("rewrite", `${t("writing.taskRewrite")} (${tone})`);
    log(`${t("writing.rewrite")} (${tone})...`);
    try {
      const scene = await api.writerSceneRewrite(selectedSceneId);
      setScenes((prev) => prev.map((s) => (s.id === scene.id ? scene : s)));
      log(t("writing.logSceneRewritten"));
      finishBgTask(taskId, "done");
    } catch (err) {
      log(`${t("writing.logError")}: ${String(err)}`);
      finishBgTask(taskId, "error", String(err));
    }
    setBusy(false);
  }

  async function summarizeScene() {
    if (!selectedSceneId || busy) return;
    setBusy(true);
    const taskId = startBgTask("summarize", t("writing.taskSummarize"));
    log(t("writing.working"));
    try {
      const summary = await api.writerSceneSummarize(selectedSceneId);
      log(`${t("writing.logSummary")}: ${summary}`);
      finishBgTask(taskId, "done", String(summary).slice(0, 100));
    } catch (err) {
      log(`${t("writing.logError")}: ${String(err)}`);
      finishBgTask(taskId, "error", String(err));
    }
    setBusy(false);
  }

  async function saveSceneContent() {
    if (!selectedSceneId) return;
    try {
      const updated = await api.writerSceneUpdate(selectedSceneId, { content: editingContent });
      setScenes((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setIsEditing(false);
      log(t("writing.logSceneSaved"));
    } catch (err) {
      log(`${t("writing.logError")}: ${String(err)}`);
    }
  }

  async function exportMarkdown() {
    if (!activeProject) return;
    const path = await api.writerExportMarkdown(activeProject.id);
    log(`${t("writing.logMarkdownExported")}: ${path}`);
  }

  async function exportDocx() {
    if (!activeProject) return;
    const path = await api.writerExportDocx(activeProject.id);
    log(`${t("writing.logDocxExported")}: ${path}`);
  }

  async function toggleProjectCharacter(characterId: string) {
    if (!activeProject) return;
    const currentIds = activeProject.characterIds || [];
    const nextIds = currentIds.includes(characterId)
      ? currentIds.filter((id) => id !== characterId)
      : [...currentIds, characterId];
    try {
      const updated = await api.writerProjectSetCharacters(activeProject.id, nextIds);
      setActiveProject(updated);
      setProjects((prev) => prev.map((project) => (project.id === updated.id ? updated : project)));
      log(`${t("writing.logCastUpdated")} (${updated.characterIds.length} ${t("writing.charactersCountSuffix")})`);
    } catch (err) {
      log(`${t("writing.logError")}: ${String(err)}`);
    }
  }

  function updateCharacterAdvanced<K extends keyof WriterCharacterAdvancedOptions>(key: K, value: string) {
    setCharacterAdvanced((prev) => ({ ...prev, [key]: value }));
  }

  async function generateCharacterFromDescription() {
    const description = characterPrompt.trim();
    if (!description || characterBusy) {
      if (!description) setCharacterError(t("writing.characterRequired"));
      return;
    }
    setCharacterBusy(true);
    setCharacterError("");
    const taskId = startBgTask("character", t("writing.taskCharacterGenerate"));
    try {
      const created = await api.writerGenerateCharacter({
        description,
        mode: characterAdvancedMode ? "advanced" : "basic",
        advanced: characterAdvancedMode ? characterAdvanced : undefined
      });
      setCharacters((prev) => [created, ...prev.filter((item) => item.id !== created.id)]);
      setCharacterEditorId(created.id);
      log(`${t("writing.logCharacterGenerated")}: ${created.name}`);
      finishBgTask(taskId, "done", created.name);
      setCharacterPrompt("");

      if (activeProject && !(activeProject.characterIds || []).includes(created.id)) {
        const updated = await api.writerProjectSetCharacters(activeProject.id, [...(activeProject.characterIds || []), created.id]);
        setActiveProject(updated);
        setProjects((prev) => prev.map((project) => (project.id === updated.id ? updated : project)));
        log(`${t("writing.logCharacterAddedToCast")}: ${created.name}`);
      }
    } catch (err) {
      const errorText = String(err);
      setCharacterError(errorText);
      log(`${t("writing.logError")}: ${errorText}`);
      finishBgTask(taskId, "error", errorText);
    } finally {
      setCharacterBusy(false);
    }
  }

  function parseCharacterTags(raw: string): string[] {
    return raw
      .split(/[,;\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function toggleCharacterAiField(field: WriterCharacterEditField) {
    setCharacterAiFields((prev) => (
      prev.includes(field)
        ? prev.filter((item) => item !== field)
        : [...prev, field]
    ));
  }

  function characterFieldLabel(field: WriterCharacterEditField): string {
    switch (field) {
      case "name": return t("chars.name");
      case "description": return t("chars.description");
      case "personality": return t("chars.personality");
      case "scenario": return t("chars.scenario");
      case "greeting": return t("chars.firstMessage");
      case "systemPrompt": return t("chars.systemPrompt");
      case "mesExample": return t("chars.exampleMessages");
      case "creatorNotes": return t("chars.creatorNotes");
      case "tags": return t("chars.tags");
      default: return field;
    }
  }

  const selectedCharacterToEdit = useMemo(
    () => characters.find((character) => character.id === characterEditorId) ?? null,
    [characters, characterEditorId]
  );

  useEffect(() => {
    if (characters.length === 0) {
      setCharacterEditorId(null);
      setCharacterEditDraft({ ...EMPTY_CHARACTER_EDIT_DRAFT });
      return;
    }
    if (!characterEditorId || !characters.some((character) => character.id === characterEditorId)) {
      setCharacterEditorId(characters[0].id);
    }
  }, [characters, characterEditorId]);

  useEffect(() => {
    if (!selectedCharacterToEdit) {
      setCharacterEditDraft({ ...EMPTY_CHARACTER_EDIT_DRAFT });
      setCharacterEditStatus(null);
      return;
    }
    setCharacterEditDraft({
      name: selectedCharacterToEdit.name || "",
      description: selectedCharacterToEdit.description || "",
      personality: selectedCharacterToEdit.personality || "",
      scenario: selectedCharacterToEdit.scenario || "",
      greeting: selectedCharacterToEdit.greeting || "",
      systemPrompt: selectedCharacterToEdit.systemPrompt || "",
      mesExample: selectedCharacterToEdit.mesExample || "",
      creatorNotes: selectedCharacterToEdit.creatorNotes || "",
      tagsText: (selectedCharacterToEdit.tags || []).join(", ")
    });
    setCharacterEditStatus(null);
    setCharacterAiInstruction("");
    setCharacterAiFields([]);
  }, [selectedCharacterToEdit?.id, selectedCharacterToEdit]);

  async function saveCharacterEditor() {
    if (!selectedCharacterToEdit || characterEditBusy || characterAiBusy) return;
    setCharacterEditBusy(true);
    setCharacterEditStatus(null);
    try {
      const updated = await api.characterUpdate(selectedCharacterToEdit.id, {
        name: characterEditDraft.name,
        description: characterEditDraft.description,
        personality: characterEditDraft.personality,
        scenario: characterEditDraft.scenario,
        greeting: characterEditDraft.greeting,
        systemPrompt: characterEditDraft.systemPrompt,
        mesExample: characterEditDraft.mesExample,
        creatorNotes: characterEditDraft.creatorNotes,
        tags: parseCharacterTags(characterEditDraft.tagsText)
      });
      setCharacters((prev) => prev.map((character) => (character.id === updated.id ? updated : character)));
      setCharacterEditStatus({ tone: "success", text: t("chars.saved") });
      log(`${t("chars.saved")}: ${updated.name}`);
    } catch (err) {
      const text = String(err);
      setCharacterEditStatus({ tone: "error", text });
      log(`${t("writing.logError")}: ${text}`);
    } finally {
      setCharacterEditBusy(false);
    }
  }

  async function applyCharacterAiEdit() {
    if (!selectedCharacterToEdit || characterEditBusy || characterAiBusy) return;
    const instruction = characterAiInstruction.trim();
    if (!instruction) {
      setCharacterEditStatus({ tone: "error", text: t("writing.characterAiInstructionRequired") });
      return;
    }
    setCharacterAiBusy(true);
    setCharacterEditStatus(null);
    try {
      const result = await api.writerEditCharacter(selectedCharacterToEdit.id, {
        instruction,
        fields: characterAiFields.length > 0 ? characterAiFields : undefined
      });
      const updated = result.character;
      setCharacters((prev) => prev.map((character) => (character.id === updated.id ? updated : character)));
      if (result.changedFields.length === 0) {
        setCharacterEditStatus({ tone: "success", text: t("writing.characterAiNoChanges") });
        log(`${t("writing.characterAiNoChanges")}: ${updated.name}`);
      } else {
        const labels = result.changedFields.map((field) => characterFieldLabel(field)).join(", ");
        const status = `${t("writing.characterAiChanged")}: ${labels}`;
        setCharacterEditStatus({ tone: "success", text: status });
        log(`${status} (${updated.name})`);
      }
    } catch (err) {
      const text = String(err);
      setCharacterEditStatus({ tone: "error", text });
      log(`${t("writing.logError")}: ${text}`);
    } finally {
      setCharacterAiBusy(false);
    }
  }

  const selectedChapter = useMemo(
    () => chapters.find((chapter) => chapter.id === selectedChapterId) ?? null,
    [chapters, selectedChapterId]
  );

  useEffect(() => {
    setChapterSettings(selectedChapter?.settings ?? { ...DEFAULT_CHAPTER_SETTINGS });
  }, [selectedChapterId, selectedChapter]);

  useEffect(() => {
    setRenameDraft(activeProject?.name || "");
  }, [activeProject?.id, activeProject?.name]);

  useEffect(() => {
    return () => {
      if (chapterSettingsTimerRef.current) clearTimeout(chapterSettingsTimerRef.current);
    };
  }, []);

  function updateSelectedChapterSettings(patch: Partial<WriterChapterSettings>) {
    if (!selectedChapterId) return;
    const merged: WriterChapterSettings = {
      ...chapterSettings,
      ...patch,
      creativity: clamp01(Number((patch.creativity ?? chapterSettings.creativity))),
      tension: clamp01(Number((patch.tension ?? chapterSettings.tension))),
      detail: clamp01(Number((patch.detail ?? chapterSettings.detail))),
      dialogue: clamp01(Number((patch.dialogue ?? chapterSettings.dialogue)))
    };
    setChapterSettings(merged);
    setChapters((prev) => prev.map((chapter) => (
      chapter.id === selectedChapterId ? { ...chapter, settings: merged } : chapter
    )));

    if (chapterSettingsTimerRef.current) clearTimeout(chapterSettingsTimerRef.current);
    chapterSettingsTimerRef.current = setTimeout(() => {
      api.writerChapterUpdateSettings(selectedChapterId, merged)
        .then((updatedChapter) => {
          setChapters((prev) => prev.map((chapter) => (
            chapter.id === updatedChapter.id ? updatedChapter : chapter
          )));
        })
        .catch((err) => log(`Error: ${String(err)}`));
    }, 250);
  }

  const selectedScene = useMemo(() => scenes.find((s) => s.id === selectedSceneId) ?? null, [scenes, selectedSceneId]);

  function startEditing() {
    if (!selectedScene) return;
    setEditingContent(selectedScene.content);
    setIsEditing(true);
  }

  const runningTasks = bgTasks.filter((t) => t.status === "running");

  return (
    <div className="flex h-full flex-col gap-1.5">
      <div className="flex justify-center">
        <div className="inline-flex items-center rounded-md border border-border-subtle bg-bg-primary p-[2px]">
          <button
            onClick={() => setWorkspaceMode("books")}
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-4 transition-colors ${
              workspaceMode === "books"
                ? "bg-accent text-text-inverse"
                : "text-text-secondary hover:bg-bg-hover"
            }`}
          >
            {t("writing.modeBooks")}
          </button>
          <button
            onClick={() => setWorkspaceMode("characters")}
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-4 transition-colors ${
              workspaceMode === "characters"
                ? "bg-accent text-text-inverse"
                : "text-text-secondary hover:bg-bg-hover"
            }`}
          >
            {t("writing.modeCharacters")}
          </button>
        </div>
      </div>

      {workspaceMode === "books" ? (
        <ThreePanelLayout
      left={
        <>
          <PanelTitle
            action={
              <div className="flex items-center gap-1">
                <input
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void createProject();
                    }
                  }}
                  placeholder={t("writing.bookTitle")}
                  className="w-28 rounded-md border border-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary placeholder:text-text-tertiary"
                />
                <button
                  onClick={createProject}
                  className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-[11px] font-semibold text-text-inverse hover:bg-accent-hover"
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  {t("chat.new")}
                </button>
              </div>
            }
          >
            {t("writing.projects")}
          </PanelTitle>

          <div className="mb-2 flex items-center gap-1">
            <input
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void renameActiveProject();
                }
              }}
              disabled={!activeProject}
              placeholder={t("writing.renameSelectedBook")}
              className="min-w-0 flex-1 rounded-md border border-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary placeholder:text-text-tertiary disabled:opacity-40"
            />
            <button
              onClick={renameActiveProject}
              disabled={!activeProject}
              className="rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-text-secondary hover:bg-bg-hover disabled:opacity-40"
            >
              {t("writing.rename")}
            </button>
          </div>

          <div className="list-animate flex-1 space-y-1.5 overflow-y-auto">
            {projects.length === 0 ? (
              <EmptyState title={t("writing.noProjects")} description={t("writing.noProjectsDesc")} />
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  onClick={() => openProject(project)}
                  className={`float-card block w-full rounded-lg px-3 py-2 text-left transition-colors ${
                    activeProject?.id === project.id
                      ? "bg-accent-subtle text-text-primary"
                      : "text-text-secondary hover:bg-bg-hover"
                  }`}
                >
                  <div className="truncate text-sm font-medium">{project.name || t("writing.untitledBook")}</div>
                  <div className="mt-0.5 text-[11px] text-text-tertiary">{project.description}</div>
                </button>
              ))
            )}
          </div>

          <div className="float-card mt-3 rounded-lg border border-border-subtle bg-bg-primary p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{t("writing.chapters")}</div>
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {chapters.map((ch) => (
                <button
                  key={ch.id}
                  onClick={() => setSelectedChapterId(ch.id)}
                  className={`block w-full rounded-md px-2 py-1 text-left text-xs ${
                    selectedChapterId === ch.id ? "bg-accent-subtle text-text-primary font-medium" : "text-text-secondary hover:bg-bg-hover"
                  }`}
                >
                  {ch.title}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-text-tertiary">
              <span><span className="font-medium text-text-secondary">{chapters.length}</span> {t("writing.chShort")}</span>
              <span className="text-border">|</span>
              <span><span className="font-medium text-text-secondary">{scenes.length}</span> {t("writing.scenesShort")}</span>
            </div>
          </div>

          <div className="float-card mt-3 rounded-lg border border-border-subtle bg-bg-primary p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{t("writing.cast")}</div>
              <Badge>{activeProject?.characterIds?.length ?? 0}</Badge>
            </div>
            {characters.length === 0 ? (
              <div className="rounded-md border border-border-subtle bg-bg-secondary px-2 py-2 text-[11px] text-text-tertiary">
                {t("writing.castImportHint")}
              </div>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {characters.map((character) => {
                  const selected = Boolean(activeProject?.characterIds?.includes(character.id));
                  return (
                    <button
                      key={character.id}
                      onClick={() => toggleProjectCharacter(character.id)}
                      disabled={!activeProject}
                      className={`flex w-full items-center gap-2 overflow-hidden rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
                        selected
                          ? "border-accent-border bg-accent-subtle text-text-primary"
                          : "border-border-subtle text-text-secondary hover:bg-bg-hover"
                      } disabled:opacity-40`}
                    >
                      <span className="min-w-0 flex-1 truncate">{character.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Background tasks indicator */}
          {runningTasks.length > 0 && (
            <div className="float-card mt-3 rounded-lg border border-accent-border bg-accent-subtle p-3">
              <div className="mb-1.5 flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5 animate-spin text-accent" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-[11px] font-semibold text-accent">{t("writing.working")}</span>
              </div>
              {runningTasks.map((task) => (
                <div key={task.id} className="text-[10px] text-text-secondary">{task.label}</div>
              ))}
            </div>
          )}
        </>
      }
      center={
        <>
          <div className="mb-2 flex items-center justify-between">
            <PanelTitle>
              {activeProject ? activeProject.name : t("writing.creativeWriting")}
            </PanelTitle>
            {busy && (
              <div className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5 animate-spin text-accent" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-[11px] text-accent">{t("writing.working")}</span>
              </div>
            )}
          </div>

          <div className="float-card mb-2 rounded-lg border border-border-subtle bg-bg-primary p-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{t("chat.model")}</span>
              <span className="truncate text-xs text-text-secondary">{activeModelLabel || t("chat.noModel")}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                value={writerProviderId}
                onChange={(e) => setWriterProviderId(e.target.value)}
                className="min-w-[170px] flex-1 rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary"
              >
                <option value="">({t("settings.selectProvider")})</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>
                ))}
              </select>
              <select
                value={writerModelId}
                onChange={(e) => setWriterModelId(e.target.value)}
                disabled={!writerProviderId || loadingModels}
                className="min-w-[170px] flex-1 rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary disabled:opacity-40"
              >
                <option value="">
                  {loadingModels ? `${t("settings.loadModels")}...` : `(${t("settings.selectModel")})`}
                </option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>{model.id}</option>
                ))}
              </select>
              <button
                onClick={applyWriterModel}
                disabled={!writerProviderId || !writerModelId}
                className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-40"
              >
                {t("writing.useModel")}
              </button>
            </div>
          </div>

          <div className="mb-2 flex flex-wrap gap-1">
            <button onClick={createChapter} disabled={!activeProject}
              className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-40">
              {t("writing.chapter")}
            </button>
            <button onClick={runConsistency} disabled={!activeProject}
              className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-40">
              {t("writing.consistency")}
            </button>
            <button onClick={expandScene} disabled={!selectedSceneId || busy}
              className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-40">
              {t("writing.expand")}
            </button>
            <button onClick={rewriteScene} disabled={!selectedSceneId || busy}
              className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-40">
              {t("writing.rewrite")}
            </button>
            <button onClick={summarizeScene} disabled={!selectedSceneId || busy}
              className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-40">
              {t("writing.summarize")}
            </button>
          </div>

          <div className="mb-2 flex gap-1.5">
            <textarea
              value={chapterPrompt}
              onChange={(e) => setChapterPrompt(e.target.value)}
              className="h-16 flex-1 resize-none rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary"
              placeholder={t("writing.prompt")}
            />
            <button
              onClick={generateDraft}
              disabled={!selectedChapterId || busy}
              className="flex-shrink-0 rounded-lg bg-accent px-3 py-2 text-[11px] font-semibold text-text-inverse hover:bg-accent-hover disabled:opacity-40"
            >
              {t("writing.generate")}
            </button>
          </div>

          <div className="float-card mb-2 rounded-lg border border-border-subtle bg-bg-primary p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                {t("writing.chapterDynamics")}
              </div>
              <span className="text-[11px] text-text-secondary">
                {selectedChapter ? selectedChapter.title : t("writing.selectChapter")}
              </span>
            </div>
            {selectedChapter ? (
              <div className="space-y-2">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                  <label className="text-[10px] text-text-tertiary">
                    {t("writing.tone")}
                    <input
                      value={chapterSettings.tone}
                      onChange={(e) => updateSelectedChapterSettings({ tone: e.target.value })}
                      className="mt-1 w-full rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary"
                    />
                  </label>
                  <label className="text-[10px] text-text-tertiary">
                    {t("inspector.pacing")}
                    <select
                      value={chapterSettings.pacing}
                      onChange={(e) => updateSelectedChapterSettings({ pacing: e.target.value as WriterChapterSettings["pacing"] })}
                      className="mt-1 w-full rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary"
                    >
                      <option value="slow">{t("inspector.slow")}</option>
                      <option value="balanced">{t("inspector.balanced")}</option>
                      <option value="fast">{t("inspector.fast")}</option>
                    </select>
                  </label>
                  <label className="text-[10px] text-text-tertiary">
                    {t("writing.pov")}
                    <select
                      value={chapterSettings.pov}
                      onChange={(e) => updateSelectedChapterSettings({ pov: e.target.value as WriterChapterSettings["pov"] })}
                      className="mt-1 w-full rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary"
                    >
                      <option value="first_person">{t("writing.povFirstPerson")}</option>
                      <option value="third_limited">{t("writing.povThirdLimited")}</option>
                      <option value="third_omniscient">{t("writing.povThirdOmniscient")}</option>
                    </select>
                  </label>
                </div>
                {[
                  { key: "creativity", label: t("writing.creativity") },
                  { key: "tension", label: t("writing.tension") },
                  { key: "detail", label: t("writing.detail") },
                  { key: "dialogue", label: t("writing.dialogueShare") }
                ].map((item) => {
                  const key = item.key as "creativity" | "tension" | "detail" | "dialogue";
                  const value = chapterSettings[key];
                  return (
                    <div key={item.key}>
                      <div className="mb-1 flex items-center justify-between text-[10px] text-text-tertiary">
                        <span>{item.label}</span>
                        <span className="font-medium text-text-secondary">{Math.round(value * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={value}
                        onChange={(e) => updateSelectedChapterSettings({ [key]: Number(e.target.value) } as Partial<WriterChapterSettings>)}
                        className="w-full"
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-md border border-border-subtle bg-bg-secondary px-2 py-2 text-[11px] text-text-tertiary">
                {t("writing.dynamicSettingsHint")}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {chapters.length === 0 ? (
              <EmptyState
                title={t("writing.noChapters")}
                description={activeProject ? t("writing.noChaptersDesc") : t("writing.selectProject")}
              />
            ) : (
              <div className="list-animate space-y-3">
                {chapters.map((chapter) => (
                  <div
                    key={chapter.id}
                    className={`float-card rounded-lg border p-2.5 transition-colors ${
                      selectedChapterId === chapter.id
                        ? "border-accent-border bg-accent-subtle/50"
                        : "border-border bg-bg-primary"
                    }`}
                  >
                    <button
                      className="mb-1.5 text-left text-xs font-semibold text-text-primary hover:text-accent"
                      onClick={() => setSelectedChapterId(chapter.id)}
                    >
                      {chapter.title}
                    </button>
                    <div className="mb-1.5 flex flex-wrap gap-1 text-[10px] text-text-tertiary">
                      <Badge>{chapter.settings.tone}</Badge>
                      <Badge>{chapter.settings.pacing}</Badge>
                      <Badge>{chapter.settings.pov.replace("_", " ")}</Badge>
                    </div>
                    {scenes
                      .filter((scene) => scene.chapterId === chapter.id)
                      .map((scene) => (
                        <article
                          key={scene.id}
                          onClick={() => setSelectedSceneId(scene.id)}
                          className={`float-card mb-1 cursor-pointer rounded-md border p-2 text-xs transition-colors ${
                            selectedSceneId === scene.id
                              ? "border-accent-border bg-accent-subtle"
                              : "border-border-subtle hover:bg-bg-hover"
                          }`}
                        >
                          <div className="font-semibold text-text-primary">{scene.title}</div>
                          <p className="mt-0.5 line-clamp-2 text-text-tertiary">{scene.content}</p>
                        </article>
                      ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {selectedScene && (
            <div className="float-card mt-2 rounded-lg border border-border-subtle bg-bg-primary p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-semibold text-text-primary">{selectedScene.title}</span>
                <div className="flex gap-1">
                  {isEditing ? (
                    <>
                      <button onClick={saveSceneContent} className="rounded-md bg-accent px-2 py-0.5 text-[10px] font-semibold text-text-inverse hover:bg-accent-hover">{t("chat.save")}</button>
                      <button onClick={() => setIsEditing(false)} className="rounded-md border border-border px-2 py-0.5 text-[10px] text-text-secondary hover:bg-bg-hover">{t("chat.cancel")}</button>
                    </>
                  ) : (
                    <button onClick={startEditing} className="rounded-md border border-border px-2 py-0.5 text-[10px] text-text-secondary hover:bg-bg-hover">{t("chat.edit")}</button>
                  )}
                </div>
              </div>
              {isEditing ? (
                <textarea
                  value={editingContent}
                  onChange={(e) => setEditingContent(e.target.value)}
                  className="h-40 w-full resize-y rounded-md border border-border bg-bg-secondary p-2 text-xs leading-relaxed text-text-primary"
                />
              ) : (
                <p className="max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-text-secondary">
                  {selectedScene.content}
                </p>
              )}
            </div>
          )}
        </>
      }
      right={
        <div className="flex h-full flex-col overflow-y-auto">
          <PanelTitle>{t("writing.outline")}</PanelTitle>

          <div className="mb-3 flex gap-1.5">
            <button onClick={exportMarkdown} className="flex-1 rounded-md border border-border px-2 py-1.5 text-[11px] font-medium text-text-secondary hover:bg-bg-hover">
              {t("writing.exportMD")}
            </button>
            <button onClick={exportDocx} className="flex-1 rounded-md border border-border px-2 py-1.5 text-[11px] font-medium text-text-secondary hover:bg-bg-hover">
              {t("writing.exportDOCX")}
            </button>
          </div>

          {/* Background tasks history */}
          {bgTasks.length > 0 && (
            <div className="mb-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                {t("writing.tasks")}
              </div>
              <div className="list-animate max-h-32 space-y-1 overflow-y-auto">
                {bgTasks.slice(0, 10).map((task) => (
                  <div key={task.id} className={`float-card flex items-center gap-2 rounded-md border px-2 py-1 text-[10px] ${
                    task.status === "running" ? "border-accent-border bg-accent-subtle" :
                    task.status === "error" ? "border-danger-border bg-danger-subtle" :
                    "border-border-subtle bg-bg-primary"
                  }`}>
                    {task.status === "running" ? (
                      <svg className="h-2.5 w-2.5 animate-spin text-accent" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    ) : task.status === "error" ? (
                      <div className="h-2 w-2 rounded-full bg-danger" />
                    ) : (
                      <div className="h-2 w-2 rounded-full bg-success" />
                    )}
                    <span className={`flex-1 truncate ${task.status === "error" ? "text-danger" : "text-text-secondary"}`}>
                      {task.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mb-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
              {t("writing.consistencyIssues")}
            </div>
            {issues.length === 0 ? (
              <div className="rounded-lg border border-border-subtle bg-bg-primary px-3 py-3 text-center text-xs text-text-tertiary">
                {t("writing.noIssues")}
              </div>
            ) : (
              <div className="space-y-1.5">
                {issues.map((issue) => {
                  const style = SEVERITY_STYLES[issue.severity] ?? SEVERITY_STYLES.low;
                  return (
                    <article key={issue.id} className={`rounded-lg border ${style.border} bg-bg-primary p-2`}>
                      <div className="mb-0.5 flex items-center gap-2">
                        <Badge variant={style.badge}>{issue.severity}</Badge>
                        <span className="text-[10px] font-semibold uppercase text-text-tertiary">{issue.category}</span>
                      </div>
                      <p className="text-xs text-text-secondary">{issue.message}</p>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-auto">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{t("writing.generationLog")}</div>
            <div className="max-h-48 overflow-auto rounded-lg border border-border-subtle bg-bg-primary p-2">
              {generationLog.length === 0 ? (
                <div className="py-2 text-center text-[11px] text-text-tertiary">{t("writing.noActivity")}</div>
              ) : (
                <div className="space-y-0.5 font-mono text-[10px] text-text-tertiary">
                  {generationLog.map((line, idx) => (
                    <div key={`${line}-${idx}`}>{line}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      }
    />
      ) : (
        <section className="mx-auto flex h-full w-full max-w-[1500px] flex-col rounded-xl border border-border bg-bg-secondary p-4">
          <div className="flex w-full flex-1 flex-col gap-3 overflow-y-auto">
            <div className="float-card rounded-lg border border-border-subtle bg-bg-primary p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-semibold text-text-primary">{t("writing.characterForge")}</div>
                <button
                  onClick={() => setCharacterAdvancedMode((prev) => !prev)}
                  className="rounded-md border border-border px-2 py-0.5 text-[10px] text-text-secondary hover:bg-bg-hover"
                >
                  {characterAdvancedMode ? t("writing.characterBasic") : t("writing.characterAdvanced")}
                </button>
              </div>
              <textarea
                value={characterPrompt}
                onChange={(e) => {
                  setCharacterPrompt(e.target.value);
                  if (characterError) setCharacterError("");
                }}
                placeholder={t("writing.characterPromptPlaceholder")}
                className="h-20 w-full rounded-md border border-border bg-bg-secondary px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary"
              />
              {characterAdvancedMode && (
                <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  <input value={characterAdvanced.name || ""} onChange={(e) => updateCharacterAdvanced("name", e.target.value)}
                    placeholder={t("writing.characterNameHint")}
                    className="rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                  <input value={characterAdvanced.role || ""} onChange={(e) => updateCharacterAdvanced("role", e.target.value)}
                    placeholder={t("writing.characterRoleHint")}
                    className="rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                  <input value={characterAdvanced.personality || ""} onChange={(e) => updateCharacterAdvanced("personality", e.target.value)}
                    placeholder={t("writing.characterPersonalityHint")}
                    className="rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                  <input value={characterAdvanced.scenario || ""} onChange={(e) => updateCharacterAdvanced("scenario", e.target.value)}
                    placeholder={t("writing.characterScenarioHint")}
                    className="rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                  <input value={characterAdvanced.greetingStyle || ""} onChange={(e) => updateCharacterAdvanced("greetingStyle", e.target.value)}
                    placeholder={t("writing.characterGreetingHint")}
                    className="rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                  <input value={characterAdvanced.systemPrompt || ""} onChange={(e) => updateCharacterAdvanced("systemPrompt", e.target.value)}
                    placeholder={t("writing.characterSystemHint")}
                    className="rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                  <input value={characterAdvanced.tags || ""} onChange={(e) => updateCharacterAdvanced("tags", e.target.value)}
                    placeholder={t("writing.characterTagsHint")}
                    className="rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary sm:col-span-2" />
                  <textarea value={characterAdvanced.notes || ""} onChange={(e) => updateCharacterAdvanced("notes", e.target.value)}
                    placeholder={t("writing.characterNotesHint")}
                    className="h-16 rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary sm:col-span-2" />
                </div>
              )}
              <div className="mt-2 flex items-center gap-1.5">
                <button onClick={generateCharacterFromDescription} disabled={characterBusy}
                  className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-text-inverse hover:bg-accent-hover disabled:opacity-40">
                  {characterBusy ? t("writing.characterGenerating") : t("writing.characterGenerate")}
                </button>
                <button onClick={() => setCharacterAdvanced({ ...DEFAULT_WRITER_CHARACTER_ADVANCED })}
                  className="rounded-md border border-border px-3 py-1 text-xs text-text-secondary hover:bg-bg-hover">
                  {t("writing.characterReset")}
                </button>
              </div>
              {characterError && (
                <div className="mt-2 rounded-md border border-danger-border bg-danger-subtle px-2 py-1 text-[10px] text-danger">
                  {characterError}
                </div>
              )}
            </div>

            <div className="grid flex-1 min-h-0 grid-cols-1 gap-3 md:grid-cols-[340px_minmax(0,1fr)]">
              <div className="float-card min-h-0 rounded-lg border border-border-subtle bg-bg-primary p-2">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{t("chars.characters")}</div>
                {characters.length === 0 ? (
                  <EmptyState title={t("chars.noChars")} description={t("chars.noCharsDesc")} />
                ) : (
                  <div className="max-h-full space-y-1 overflow-y-auto">
                    {characters.map((character) => (
                      <button
                        key={character.id}
                        onClick={() => setCharacterEditorId(character.id)}
                        className={`w-full rounded-md border px-2 py-1.5 text-left text-xs ${
                          characterEditorId === character.id
                            ? "border-accent-border bg-accent-subtle text-text-primary"
                            : "border-border-subtle text-text-secondary hover:bg-bg-hover"
                        }`}
                      >
                        <div className="truncate font-medium">{character.name}</div>
                        <div className="truncate text-[10px] text-text-tertiary">{(character.tags || []).join(", ")}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="float-card min-h-0 rounded-lg border border-border-subtle bg-bg-primary p-3">
                {selectedCharacterToEdit ? (
                  <div className="flex h-full flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-semibold text-text-primary">{selectedCharacterToEdit.name}</div>
                      <button onClick={saveCharacterEditor} disabled={characterEditBusy || characterAiBusy}
                        className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-text-inverse hover:bg-accent-hover disabled:opacity-40">
                        {characterEditBusy ? t("writing.working") : t("chat.save")}
                      </button>
                    </div>
                    <div className="rounded-md border border-border-subtle bg-bg-secondary p-2">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{t("writing.characterAiEdit")}</div>
                        <div className="text-[10px] text-text-tertiary">
                          {characterAiFields.length > 0
                            ? `${t("writing.characterAiScope")}: ${characterAiFields.length}`
                            : t("writing.characterAiScopeAuto")}
                        </div>
                      </div>
                      <textarea
                        value={characterAiInstruction}
                        onChange={(e) => setCharacterAiInstruction(e.target.value)}
                        placeholder={t("writing.characterAiInstructionPlaceholder")}
                        className="h-16 w-full rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary"
                      />
                      <div className="mt-1 flex flex-wrap gap-1">
                        {CHARACTER_AI_EDIT_FIELDS.map((field) => {
                          const active = characterAiFields.includes(field);
                          return (
                            <button
                              key={field}
                              type="button"
                              onClick={() => toggleCharacterAiField(field)}
                              className={`rounded-md border px-2 py-0.5 text-[10px] transition-colors ${
                                active
                                  ? "border-accent-border bg-accent-subtle text-text-primary"
                                  : "border-border-subtle text-text-tertiary hover:bg-bg-hover"
                              }`}
                            >
                              {characterFieldLabel(field)}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-2 flex items-center gap-1.5">
                        <button
                          onClick={applyCharacterAiEdit}
                          disabled={characterAiBusy || characterEditBusy}
                          className="rounded-md border border-border px-2.5 py-1 text-[11px] font-semibold text-text-primary hover:bg-bg-hover disabled:opacity-40"
                        >
                          {characterAiBusy ? t("writing.characterAiEditing") : t("writing.characterAiApply")}
                        </button>
                        <button
                          onClick={() => {
                            setCharacterAiInstruction("");
                            setCharacterAiFields([]);
                          }}
                          className="rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-tertiary hover:bg-bg-hover"
                        >
                          {t("writing.characterAiClear")}
                        </button>
                      </div>
                    </div>
                    <div className="grid flex-1 min-h-0 grid-cols-1 gap-2 overflow-y-auto pr-1">
                      <input value={characterEditDraft.name} onChange={(e) => setCharacterEditDraft((prev) => ({ ...prev, name: e.target.value }))}
                        placeholder={t("chars.name")}
                        className="rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                      <textarea value={characterEditDraft.description} onChange={(e) => setCharacterEditDraft((prev) => ({ ...prev, description: e.target.value }))}
                        placeholder={t("chars.description")}
                        className="h-16 rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                      <textarea value={characterEditDraft.personality} onChange={(e) => setCharacterEditDraft((prev) => ({ ...prev, personality: e.target.value }))}
                        placeholder={t("chars.personality")}
                        className="h-16 rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                      <textarea value={characterEditDraft.scenario} onChange={(e) => setCharacterEditDraft((prev) => ({ ...prev, scenario: e.target.value }))}
                        placeholder={t("chars.scenario")}
                        className="h-16 rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                      <textarea value={characterEditDraft.greeting} onChange={(e) => setCharacterEditDraft((prev) => ({ ...prev, greeting: e.target.value }))}
                        placeholder={t("chars.firstMessage")}
                        className="h-16 rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                      <textarea value={characterEditDraft.systemPrompt} onChange={(e) => setCharacterEditDraft((prev) => ({ ...prev, systemPrompt: e.target.value }))}
                        placeholder={t("chars.systemPrompt")}
                        className="h-16 rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                      <textarea value={characterEditDraft.mesExample} onChange={(e) => setCharacterEditDraft((prev) => ({ ...prev, mesExample: e.target.value }))}
                        placeholder={t("chars.exampleMessages")}
                        className="h-16 rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                      <textarea value={characterEditDraft.creatorNotes} onChange={(e) => setCharacterEditDraft((prev) => ({ ...prev, creatorNotes: e.target.value }))}
                        placeholder={t("chars.creatorNotes")}
                        className="h-16 rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                      <input value={characterEditDraft.tagsText} onChange={(e) => setCharacterEditDraft((prev) => ({ ...prev, tagsText: e.target.value }))}
                        placeholder={t("chars.tagsPlaceholder")}
                        className="rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary" />
                    </div>
                    {characterEditStatus && (
                      <div className={`rounded-md border px-2 py-1 text-[10px] ${
                        characterEditStatus.tone === "success"
                          ? "border-success-border bg-success-subtle text-success"
                          : "border-danger-border bg-danger-subtle text-danger"
                      }`}>
                        {characterEditStatus.text}
                      </div>
                    )}
                  </div>
                ) : (
                  <EmptyState title={t("chars.selectCharacter")} description={t("chars.selectCharacterDesc")} />
                )}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
