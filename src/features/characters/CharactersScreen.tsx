import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, resolveApiAssetUrl } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import { Badge, EmptyState, PanelTitle, ThreePanelLayout } from "../../components/Panels";
import type { CharacterDetail } from "../../shared/types/contracts";

export function CharactersScreen() {
  const { t } = useI18n();
  const [characters, setCharacters] = useState<CharacterDetail[]>([]);
  const [selected, setSelected] = useState<CharacterDetail | null>(null);
  const [loading, setLoading] = useState(true);

  // GUI editor fields
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [personality, setPersonality] = useState("");
  const [scenario, setScenario] = useState("");
  const [greeting, setGreeting] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [mesExample, setMesExample] = useState("");
  const [creatorNotes, setCreatorNotes] = useState("");
  const [tags, setTags] = useState("");

  // Raw JSON panel
  const [rawJson, setRawJson] = useState("{}");
  const [jsonSyncDirection, setJsonSyncDirection] = useState<"gui" | "json">("gui");

  // Import
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState("");
  const [importSuccess, setImportSuccess] = useState("");

  // Avatar
  const [avatarUploading, setAvatarUploading] = useState(false);

  // File import
  const jsonFileRef = useRef<HTMLInputElement>(null);

  // Status
  const [saveStatus, setSaveStatus] = useState("");
  const [saveStatusType, setSaveStatusType] = useState<"success" | "error" | null>(null);

  const loadCharacters = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.characterList();
      setCharacters(list);
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadCharacters();
  }, [loadCharacters]);

  // When a character is selected, populate GUI fields
  useEffect(() => {
    if (!selected) {
      setName("");
      setDescription("");
      setPersonality("");
      setScenario("");
      setGreeting("");
      setSystemPrompt("");
      setMesExample("");
      setCreatorNotes("");
      setTags("");
      setRawJson("{}");
      return;
    }
    setName(selected.name);
    setDescription(selected.description || "");
    setPersonality(selected.personality || "");
    setScenario(selected.scenario || "");
    setGreeting(selected.greeting || "");
    setSystemPrompt(selected.systemPrompt || "");
    setMesExample(selected.mesExample || "");
    setCreatorNotes(selected.creatorNotes || "");
    setTags((selected.tags || []).join(", "));
    setRawJson(selected.cardJson || "{}");
    setJsonSyncDirection("gui");
  }, [selected]);

  // Sync GUI → JSON
  useEffect(() => {
    if (jsonSyncDirection !== "gui" || !selected) return;
    try {
      const parsed = JSON.parse(selected.cardJson || "{}");
      const data = (parsed.data || {}) as Record<string, unknown>;
      data.name = name;
      data.description = description;
      data.personality = personality;
      data.scenario = scenario;
      data.first_mes = greeting;
      data.system_prompt = systemPrompt;
      data.mes_example = mesExample;
      data.creator_notes = creatorNotes;
      data.tags = tags.split(",").map((t: string) => t.trim()).filter(Boolean);
      setRawJson(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data }, null, 2));
    } catch {
      // ignore sync error
    }
  }, [name, description, personality, scenario, greeting, systemPrompt, mesExample, creatorNotes, tags, jsonSyncDirection, selected]);

  // Sync JSON → GUI
  function applyJsonToGui() {
    try {
      const parsed = JSON.parse(rawJson);
      const data = (parsed.data || {}) as Record<string, string>;
      setName(data.name || "");
      setDescription(data.description || "");
      setPersonality(data.personality || "");
      setScenario(data.scenario || "");
      setGreeting(data.first_mes || "");
      setSystemPrompt(data.system_prompt || "");
      setMesExample(data.mes_example || "");
      setCreatorNotes(data.creator_notes || "");
      const parsedTags = parsed.data?.tags;
      setTags(Array.isArray(parsedTags) ? parsedTags.join(", ") : "");
      setJsonSyncDirection("gui");
    } catch {
      // ignore
    }
  }

  async function handleSave() {
    if (!selected) return;
    setSaveStatus("");
    setSaveStatusType(null);
    try {
      const tagsArr = tags.split(",").map((t) => t.trim()).filter(Boolean);
      const updated = await api.characterUpdate(selected.id, {
        name,
        description,
        personality,
        scenario,
        greeting,
        systemPrompt,
        mesExample,
        creatorNotes,
        tags: tagsArr
      });
      setSelected(updated);
      setCharacters((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setSaveStatus(t("chars.saved"));
      setSaveStatusType("success");
      setTimeout(() => {
        setSaveStatus("");
        setSaveStatusType(null);
      }, 2000);
    } catch (error) {
      setSaveStatus(`${t("chars.errorPrefix")}: ${String(error)}`);
      setSaveStatusType("error");
    }
  }

  async function handleDelete() {
    if (!selected) return;
    await api.characterDelete(selected.id);
    setCharacters((prev) => prev.filter((c) => c.id !== selected.id));
    setSelected(null);
  }

  async function handleImport() {
    setImportError("");
    setImportSuccess("");
    if (!importJson.trim()) {
      setImportError(t("chars.pasteJsonRequired"));
      return;
    }
    try {
      const result = await api.characterImportV2(importJson);
      setCharacters((prev) => [result, ...prev]);
      setSelected(result);
      setImportJson("");
      setImportSuccess(`${t("chars.imported")}: ${result.name}`);
      setTimeout(() => setImportSuccess(""), 3000);
    } catch (error) {
      setImportError(String(error));
    }
  }

  async function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.[0]) return;
    setImportError("");
    setImportSuccess("");
    try {
      const file = e.target.files[0];
      const text = await file.text();
      const result = await api.characterImportV2(text);
      setCharacters((prev) => [result, ...prev]);
      setSelected(result);
      setImportSuccess(`${t("chars.importedFromFile")}: ${result.name}`);
      setTimeout(() => setImportSuccess(""), 3000);
    } catch (error) {
      setImportError(String(error));
    }
    if (jsonFileRef.current) jsonFileRef.current.value = "";
  }

  async function handleCreateBlank() {
    setImportError("");
    setImportSuccess("");
    try {
      const blankCard = JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: t("chars.newCharacterName"),
          description: "",
          personality: "",
          scenario: "",
          first_mes: "",
          tags: [],
          system_prompt: "",
          mes_example: "",
          creator_notes: ""
        }
      });
      const result = await api.characterImportV2(blankCard);
      setCharacters((prev) => [result, ...prev]);
      setSelected(result);
      setImportSuccess(t("chars.blankCreated"));
      setTimeout(() => setImportSuccess(""), 3000);
    } catch (error) {
      setImportError(String(error));
    }
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!selected || !e.target.files?.[0]) return;
    setAvatarUploading(true);
    try {
      const file = e.target.files[0];
      const base64 = await fileToBase64(file);
      const result = await api.characterUploadAvatar(selected.id, base64, file.name);
      const updated = { ...selected, avatarUrl: result.avatarUrl };
      setSelected(updated);
      setCharacters((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    } catch {
      // ignore
    }
    setAvatarUploading(false);
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(",")[1] || result;
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function loadSample() {
    setImportJson(JSON.stringify({
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: t("chars.sampleName"),
        description: t("chars.sampleDescription"),
        personality: t("chars.samplePersonality"),
        scenario: t("chars.sampleScenario"),
        first_mes: t("chars.sampleGreeting"),
        tags: ["fantasy", "mystery"],
        system_prompt: "",
        mes_example: "",
        creator_notes: t("chars.sampleCreatorNotes")
      }
    }, null, 2));
    setImportError("");
    setImportSuccess("");
  }

  const jsonValid = useMemo(() => {
    try {
      JSON.parse(rawJson);
      return true;
    } catch {
      return false;
    }
  }, [rawJson]);

  function avatarSrc(url: string | null) {
    return resolveApiAssetUrl(url);
  }

  return (
    <ThreePanelLayout
      left={
        <>
          <PanelTitle
            action={
              <span className="text-[11px] text-text-tertiary">
                {characters.length} {t("chars.countSuffix")}
              </span>
            }
          >
            {t("chars.characters")}
          </PanelTitle>

          {/* Import section */}
          <div className="float-card mb-3 space-y-2 rounded-lg border border-border-subtle bg-bg-primary p-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{t("chars.import")}</span>
              <button onClick={loadSample} className="text-[10px] text-accent hover:underline">
                {t("chars.loadSample")}
              </button>
            </div>
            <textarea
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
              placeholder={t("chars.importJsonPlaceholder")}
              className="h-20 w-full rounded-md border border-border bg-bg-secondary p-2 font-mono text-[10px] text-text-primary placeholder:text-text-tertiary"
              spellCheck={false}
            />
            <div className="flex gap-1.5">
              <button
                onClick={handleImport}
                className="flex-1 rounded-md bg-accent px-2 py-1.5 text-[11px] font-semibold text-text-inverse hover:bg-accent-hover"
              >
                {t("chars.importJSON")}
              </button>
              <button
                onClick={() => jsonFileRef.current?.click()}
                className="rounded-md border border-border px-2 py-1.5 text-[11px] font-medium text-text-secondary hover:bg-bg-hover"
                title={t("chars.importFromFile")}
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </button>
              <button
                onClick={handleCreateBlank}
                className="rounded-md border border-border px-2 py-1.5 text-[11px] font-medium text-text-secondary hover:bg-bg-hover"
                title={t("chars.createBlank")}
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
              </button>
            </div>
            <input ref={jsonFileRef} type="file" accept=".json" onChange={handleFileImport} className="hidden" />
            {importError && (
              <div className="rounded-md border border-danger-border bg-danger-subtle px-2 py-1 text-[10px] text-danger">{importError}</div>
            )}
            {importSuccess && (
              <div className="rounded-md border border-success-border bg-success-subtle px-2 py-1 text-[10px] text-success">{importSuccess}</div>
            )}
          </div>

          {/* Character list */}
          <div className="list-animate flex-1 space-y-1.5 overflow-y-auto">
            {loading ? (
              <div className="py-8 text-center text-xs text-text-tertiary">{t("chars.loading")}</div>
            ) : characters.length === 0 ? (
              <EmptyState title={t("chars.noChars")} description={t("chars.noCharsDesc")} />
            ) : (
              characters.map((char) => (
                <button
                  key={char.id}
                  onClick={() => setSelected(char)}
                  className={`float-card flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
                    selected?.id === char.id
                      ? "bg-accent-subtle text-text-primary"
                      : "text-text-secondary hover:bg-bg-hover"
                  }`}
                >
                  {char.avatarUrl ? (
                    <img src={avatarSrc(char.avatarUrl)!} alt="" className="h-8 w-8 flex-shrink-0 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent-subtle text-xs font-bold text-accent">
                      {char.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{char.name}</div>
                    {char.tags.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {char.tags.slice(0, 3).map((tag) => (
                          <Badge key={tag}>{tag}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </>
      }
      center={
        selected ? (
          <div className="flex h-full flex-col">
            {/* Header with avatar */}
            <div className="mb-4 flex items-center gap-3">
              <label className="group relative cursor-pointer">
                {selected.avatarUrl ? (
                  <img src={avatarSrc(selected.avatarUrl)!} alt="" className="h-14 w-14 rounded-full object-cover ring-2 ring-border" />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-subtle text-lg font-bold text-accent ring-2 ring-border">
                    {name.charAt(0).toUpperCase() || "?"}
                  </div>
                )}
                <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                  <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <input type="file" accept="image/*" onChange={handleAvatarUpload} className="hidden" disabled={avatarUploading} />
              </label>
              <div className="flex-1">
                <PanelTitle>{t("chars.editor")}</PanelTitle>
                {saveStatus && (
                  <span className={`text-[11px] ${saveStatusType === "error" ? "text-danger" : "text-success"}`}>{saveStatus}</span>
                )}
              </div>
              <div className="flex gap-1.5">
                <button onClick={handleSave} className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-text-inverse hover:bg-accent-hover">{t("chat.save")}</button>
                <button onClick={handleDelete} className="rounded-md border border-danger-border px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger-subtle">{t("chat.delete")}</button>
              </div>
            </div>

            {/* GUI editor fields */}
            <div className="flex-1 space-y-3 overflow-y-auto">
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{t("chars.name")}</label>
                <input value={name} onChange={(e) => { setName(e.target.value); setJsonSyncDirection("gui"); }}
                  className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{t("chars.description")}</label>
                <textarea value={description} onChange={(e) => { setDescription(e.target.value); setJsonSyncDirection("gui"); }}
                  className="h-24 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary" />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{t("chars.personality")}</label>
                <textarea value={personality} onChange={(e) => { setPersonality(e.target.value); setJsonSyncDirection("gui"); }}
                  className="h-16 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary" />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{t("chars.scenario")}</label>
                <textarea value={scenario} onChange={(e) => { setScenario(e.target.value); setJsonSyncDirection("gui"); }}
                  className="h-16 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary" />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{t("chars.firstMessage")}</label>
                <textarea value={greeting} onChange={(e) => { setGreeting(e.target.value); setJsonSyncDirection("gui"); }}
                  className="h-20 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary" />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{t("chars.systemPrompt")}</label>
                <textarea value={systemPrompt} onChange={(e) => { setSystemPrompt(e.target.value); setJsonSyncDirection("gui"); }}
                  className="h-16 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary" />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{t("chars.exampleMessages")}</label>
                <textarea value={mesExample} onChange={(e) => { setMesExample(e.target.value); setJsonSyncDirection("gui"); }}
                  className="h-16 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary"
                  placeholder={t("chars.exampleMessagesPlaceholder")} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{t("chars.creatorNotes")}</label>
                <textarea value={creatorNotes} onChange={(e) => { setCreatorNotes(e.target.value); setJsonSyncDirection("gui"); }}
                  className="h-14 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary" />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{t("chars.tags")}</label>
                <input value={tags} onChange={(e) => { setTags(e.target.value); setJsonSyncDirection("gui"); }}
                  className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary"
                  placeholder={t("chars.tagsPlaceholder")} />
              </div>
            </div>
          </div>
        ) : (
          <EmptyState title={t("chars.selectCharacter")} description={t("chars.selectCharacterDesc")} />
        )
      }
      right={
        <div className="flex h-full flex-col">
          <div className="mb-3 flex items-center justify-between">
            <PanelTitle>{t("chars.rawJson")}</PanelTitle>
            <div className="flex items-center gap-2">
              {!jsonValid && rawJson !== "{}" && <Badge variant="danger">{t("chars.invalid")}</Badge>}
              {jsonValid && rawJson !== "{}" && <Badge variant="success">{t("chars.valid")}</Badge>}
            </div>
          </div>

          <textarea
            value={rawJson}
            onChange={(e) => { setRawJson(e.target.value); setJsonSyncDirection("json"); }}
            className="flex-1 rounded-lg border border-border bg-bg-primary p-3 font-mono text-[10px] leading-relaxed text-text-primary placeholder:text-text-tertiary"
            placeholder={t("chars.rawJsonPlaceholder")}
            spellCheck={false}
          />

          <div className="mt-3 flex gap-2">
            <button onClick={applyJsonToGui} disabled={!jsonValid || !selected}
              className="flex-1 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-40">
              {t("chars.jsonToGui")}
            </button>
            <button onClick={() => setJsonSyncDirection("gui")} disabled={!selected}
              className="flex-1 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-40">
              {t("chars.guiToJson")}
            </button>
          </div>

          {selected && (
            <div className="float-card mt-3 rounded-lg border border-border-subtle bg-bg-primary p-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{t("chars.preview")}</div>
              <div className="flex items-center gap-2">
                {selected.avatarUrl ? (
                  <img src={avatarSrc(selected.avatarUrl)!} alt="" className="h-8 w-8 rounded-full object-cover" />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-subtle text-xs font-bold text-accent">
                    {name.charAt(0).toUpperCase() || "?"}
                  </div>
                )}
                <div>
                  <div className="text-sm font-medium text-text-primary">{name || t("chars.unnamed")}</div>
                  {tags && (
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {tags.split(",").filter(Boolean).slice(0, 5).map((t) => (
                        <Badge key={t.trim()}>{t.trim()}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {greeting && (
                <div className="mt-2 rounded-md border border-border-subtle bg-bg-secondary p-2 text-[11px] italic text-text-secondary">
                  {greeting.slice(0, 200)}{greeting.length > 200 ? "..." : ""}
                </div>
              )}
            </div>
          )}
        </div>
      }
    />
  );
}
