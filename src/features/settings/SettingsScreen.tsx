import { useEffect, useMemo, useState } from "react";
import { api } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import { PROVIDER_PRESETS, type ProviderPreset } from "../../shared/providerPresets";
import type { AppSettings, McpDiscoveredTool, McpServerConfig, McpServerTestResult, PromptTemplates, ProviderModel, ProviderProfile, SamplerConfig } from "../../shared/types/contracts";

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{children}</h2>;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="mb-1.5 block text-xs font-medium text-text-secondary">{children}</label>;
}

function InputField({
  value,
  onChange,
  placeholder,
  type = "text",
  onBlur
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  onBlur?: () => void;
}) {
  return (
    <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} onBlur={onBlur}
      className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary" />
  );
}

function SelectField({ value, onChange, children, disabled = false }: { value: string; onChange: (v: string) => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}
      className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
      {children}
    </select>
  );
}

function StatusMessage({ text, variant = "info" }: { text: string; variant?: "info" | "success" | "error" }) {
  if (!text) return null;
  const styles = { info: "border-border-subtle bg-bg-primary text-text-secondary", success: "border-success-border bg-success-subtle text-success", error: "border-danger-border bg-danger-subtle text-danger" };
  return <div className={`rounded-lg border px-3 py-2 text-xs ${styles[variant]}`}>{text}</div>;
}

function scrollToSettingsSection(id: string) {
  const node = document.getElementById(id);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function SettingsScreen() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [providerResult, setProviderResult] = useState("");
  const [resultVariant, setResultVariant] = useState<"info" | "success" | "error">("info");
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [compressModels, setCompressModels] = useState<ProviderModel[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");

  const [selectedPresetKey, setSelectedPresetKey] = useState("openai");
  const selectedPreset = useMemo(
    () => PROVIDER_PRESETS.find((p) => p.key === selectedPresetKey) ?? PROVIDER_PRESETS[0],
    [selectedPresetKey]
  );

  const [providerId, setProviderId] = useState(selectedPreset.defaultId);
  const [providerName, setProviderName] = useState(selectedPreset.defaultName);
  const [providerBaseUrl, setProviderBaseUrl] = useState(selectedPreset.baseUrl);
  const [providerApiKey, setProviderApiKey] = useState("");
  const [providerProxyUrl, setProviderProxyUrl] = useState("");
  const [providerLocalOnly, setProviderLocalOnly] = useState(selectedPreset.localOnly);
  const [providerType, setProviderType] = useState<"openai" | "koboldcpp">(selectedPreset.providerType);

  const [activeTab, setActiveTab] = useState<"basic" | "advanced" | "prompts">("basic");
  const [mcpServersDraft, setMcpServersDraft] = useState<McpServerConfig[]>([]);
  const [mcpDirty, setMcpDirty] = useState(false);
  const [testingMcpId, setTestingMcpId] = useState<string | null>(null);
  const [mcpTestResults, setMcpTestResults] = useState<Record<string, McpServerTestResult | undefined>>({});
  const [mcpImportSource, setMcpImportSource] = useState("");
  const [mcpImportLoading, setMcpImportLoading] = useState(false);
  const [mcpDiscoveredTools, setMcpDiscoveredTools] = useState<McpDiscoveredTool[]>([]);
  const [mcpDiscoveryLoading, setMcpDiscoveryLoading] = useState(false);
  const [koboldBansInput, setKoboldBansInput] = useState("");

  useEffect(() => {
    void (async () => {
      const s = await api.settingsGet();
      setSettings(s);
      setMcpServersDraft(Array.isArray(s.mcpServers) ? s.mcpServers : []);
      setMcpDiscoveredTools(Array.isArray(s.mcpDiscoveredTools) ? s.mcpDiscoveredTools : []);
      setMcpDirty(false);
      const p = await api.providerList();
      setProviders(p);
      if (s.activeProviderId) setSelectedProviderId(s.activeProviderId);
      if (s.activeModel) setSelectedModelId(s.activeModel);
    })();
  }, []);

  function showResult(text: string, variant: "info" | "success" | "error" = "info") {
    setProviderResult(text);
    setResultVariant(variant);
  }

  function applyPresetToForm(preset: ProviderPreset) {
    setSelectedPresetKey(preset.key);
    setProviderId(preset.defaultId);
    setProviderName(preset.defaultName);
    setProviderBaseUrl(preset.baseUrl);
    setProviderProxyUrl("");
    setProviderLocalOnly(preset.localOnly);
    setProviderType(preset.providerType);
    showResult(`Preset applied: ${preset.label}`, "info");
  }

  async function patch(next: Partial<AppSettings>) {
    const updated = await api.settingsUpdate(next);
    setSettings(updated);
    if (next.theme !== undefined) {
      window.dispatchEvent(new CustomEvent("theme-change", { detail: next.theme }));
    }
  }

  async function reset() {
    const defaults = await api.settingsReset();
    setSettings(defaults);
    window.dispatchEvent(new CustomEvent("onboarding-reset", { detail: defaults }));
    showResult("Settings reset to defaults", "success");
  }

  async function refreshProviders() {
    const p = await api.providerList();
    setProviders(p);
  }

  async function saveProvider() {
    if (!providerId.trim() || !providerName.trim() || !providerBaseUrl.trim()) {
      showResult("Fill Provider ID, Name, and Base URL", "error");
      return;
    }
    const saved = await api.providerUpsert({
      id: providerId.trim(), name: providerName.trim(), baseUrl: providerBaseUrl.trim(),
      apiKey: providerApiKey.trim() || "local-key",
      proxyUrl: providerProxyUrl.trim() || null,
      fullLocalOnly: providerLocalOnly,
      providerType
    });
    showResult(`Saved: ${saved.name}`, "success");
    await refreshProviders();
    setSelectedProviderId(saved.id);
  }

  async function quickAddPreset() {
    applyPresetToForm(selectedPreset);
    await api.providerUpsert({
      id: selectedPreset.defaultId, name: selectedPreset.defaultName, baseUrl: selectedPreset.baseUrl,
      apiKey: providerApiKey.trim() || (selectedPreset.localOnly ? "local-key" : ""),
      proxyUrl: null,
      fullLocalOnly: selectedPreset.localOnly,
      providerType: selectedPreset.providerType
    });
    await refreshProviders();
    setSelectedProviderId(selectedPreset.defaultId);
    showResult(`Preset provider added: ${selectedPreset.label}`, "success");
  }

  async function testProvider() {
    const targetId = selectedProviderId || providerId;
    if (!targetId) { showResult("Select or save a provider first", "error"); return; }
    const ok = await api.providerTestConnection(targetId);
    showResult(ok ? "Connection check: OK" : "Provider blocked or invalid URL", ok ? "success" : "error");
  }

  async function loadModels() {
    if (!selectedProviderId) { showResult("Select a provider first", "error"); return; }
    try {
      const list = await api.providerFetchModels(selectedProviderId);
      setModels(list);
      setSelectedModelId((prev) => {
        if (list.length === 0) return "";
        return list.some((model) => model.id === prev) ? prev : list[0].id;
      });
      showResult(list.length ? `Loaded ${list.length} models` : "No models returned", list.length ? "success" : "info");
    } catch (error) { showResult(`Load models failed: ${String(error)}`, "error"); }
  }

  async function loadCompressModels() {
    const pid = settings?.compressProviderId;
    if (!pid) return;
    try {
      const list = await api.providerFetchModels(pid);
      setCompressModels(list);
    } catch { /* ignore */ }
  }

  async function applyActiveModel() {
    if (!selectedProviderId || !selectedModelId) { showResult("Select provider and model first", "error"); return; }
    const updated = await api.providerSetActive(selectedProviderId, selectedModelId);
    setSettings(updated);
    showResult(`Active: ${selectedProviderId} / ${selectedModelId}`, "success");
  }

  async function patchSampler(samplerPatch: Partial<SamplerConfig>) {
    if (!settings) return;
    const newSampler = { ...settings.samplerConfig, ...samplerPatch };
    await patch({ samplerConfig: newSampler });
  }

  function readToolStates(): Record<string, boolean> {
    const raw = settings?.mcpToolStates;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  }

  async function discoverMcpFunctions() {
    setMcpDiscoveryLoading(true);
    try {
      const discovered = await api.settingsDiscoverMcpTools();
      const currentStates = readToolStates();
      const mergedStates: Record<string, boolean> = { ...currentStates };
      for (const tool of discovered.tools || []) {
        if (!(tool.callName in mergedStates)) {
          mergedStates[tool.callName] = true;
        }
      }
      const updated = await api.settingsUpdate({
        mcpDiscoveredTools: discovered.tools || [],
        mcpToolStates: mergedStates
      });
      setSettings(updated);
      setMcpDiscoveredTools(Array.isArray(updated.mcpDiscoveredTools) ? updated.mcpDiscoveredTools : []);
      showResult(`${t("settings.mcpFunctionsLoaded")}: ${(discovered.tools || []).length}`, "success");
    } catch (err) {
      showResult(`${t("settings.mcpFunctionsLoadFail")}: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setMcpDiscoveryLoading(false);
    }
  }

  async function setToolEnabled(callName: string, enabled: boolean) {
    try {
      const states = readToolStates();
      const updated = await api.settingsUpdate({
        mcpToolStates: { ...states, [callName]: enabled }
      });
      setSettings(updated);
    } catch (err) {
      showResult(`${t("settings.mcpFunctionsLoadFail")}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  function addMcpServer() {
    const id = `mcp-${Date.now()}`;
    setMcpServersDraft((prev) => [
      ...prev,
      {
        id,
        name: `MCP ${prev.length + 1}`,
        command: "",
        args: "",
        env: "",
        enabled: true,
        timeoutMs: 15000
      }
    ]);
    setMcpDirty(true);
  }

  function updateMcpServer(id: string, patchData: Partial<McpServerConfig>) {
    setMcpServersDraft((prev) => prev.map((server) => (server.id === id ? { ...server, ...patchData } : server)));
    setMcpDirty(true);
  }

  function removeMcpServer(id: string) {
    setMcpServersDraft((prev) => prev.filter((server) => server.id !== id));
    setMcpTestResults((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setMcpDirty(true);
  }

  async function saveMcpServers() {
    await patch({ mcpServers: mcpServersDraft });
    setMcpDirty(false);
    showResult(t("settings.mcpSaved"), "success");
    await discoverMcpFunctions();
  }

  async function importMcpServers() {
    const source = mcpImportSource.trim();
    if (!source) {
      showResult(t("settings.mcpImportEmpty"), "error");
      return;
    }
    setMcpImportLoading(true);
    try {
      const result = await api.settingsImportMcpSource(source);
      const incoming = result.servers || [];
      setMcpServersDraft((prev) => {
        const byId = new Map(prev.map((server) => [server.id, server]));
        for (const server of incoming) {
          byId.set(server.id, server);
        }
        return Array.from(byId.values());
      });
      setMcpDirty(true);
      showResult(`${t("settings.mcpImportSuccess")}: ${incoming.length}`, "success");
    } catch (err) {
      showResult(`${t("settings.mcpImportFail")}: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setMcpImportLoading(false);
    }
  }

  async function testMcpServer(server: McpServerConfig, resultKey: string) {
    setTestingMcpId(resultKey);
    try {
      const result = await api.settingsTestMcpServer(server);
      setMcpTestResults((prev) => ({ ...prev, [resultKey]: result }));
    } catch (err) {
      setMcpTestResults((prev) => ({
        ...prev,
        [resultKey]: { ok: false, tools: [], error: err instanceof Error ? err.message : String(err) }
      }));
    } finally {
      setTestingMcpId(null);
    }
  }

  function changeInterfaceLanguage(lang: "en" | "ru" | "zh" | "ja") {
    patch({ interfaceLanguage: lang });
    window.dispatchEvent(new CustomEvent("locale-change", { detail: lang }));
  }

  // Auto-load models when provider selection changes in settings
  useEffect(() => {
    if (!selectedProviderId) { setModels([]); setSelectedModelId(""); return; }
    api.providerFetchModels(selectedProviderId)
      .then((list) => {
        setModels(list);
        setSelectedModelId((prev) => {
          if (list.length === 0) return "";
          return list.some((m) => m.id === prev) ? prev : list[0].id;
        });
      })
      .catch(() => {
        setModels([]);
        setSelectedModelId("");
      });
  }, [selectedProviderId]);

  // Auto-load compress models when compress provider changes
  useEffect(() => {
    if (!settings?.compressProviderId) { setCompressModels([]); return; }
    api.providerFetchModels(settings.compressProviderId)
      .then((list) => setCompressModels(list))
      .catch(() => setCompressModels([]));
  }, [settings?.compressProviderId]);

  useEffect(() => {
    if (!settings) return;
    setMcpServersDraft(Array.isArray(settings.mcpServers) ? settings.mcpServers : []);
    setMcpDiscoveredTools(Array.isArray(settings.mcpDiscoveredTools) ? settings.mcpDiscoveredTools : []);
    setMcpDirty(false);
    setMcpTestResults({});
  }, [settings?.mcpServers, settings?.mcpDiscoveredTools]);

  useEffect(() => {
    const raw = settings?.samplerConfig.koboldBannedPhrases;
    if (Array.isArray(raw)) {
      setKoboldBansInput(raw.join(", "));
      return;
    }
    setKoboldBansInput(typeof raw === "string" ? raw : "");
  }, [settings?.samplerConfig.koboldBannedPhrases]);

  function parsePhraseBansInput(raw: string): string[] {
    return raw
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const toolStates = useMemo(() => {
    const raw = settings?.mcpToolStates;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {} as Record<string, boolean>;
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  }, [settings?.mcpToolStates]);

  const discoveredToolsByServer = useMemo(() => {
    const groups = new Map<string, McpDiscoveredTool[]>();
    for (const tool of mcpDiscoveredTools) {
      const key = tool.serverId || "unknown";
      const list = groups.get(key) || [];
      list.push(tool);
      groups.set(key, list);
    }
    return Array.from(groups.entries()).map(([serverId, tools]) => ({
      serverId,
      serverName: tools[0]?.serverName || serverId,
      tools: [...tools].sort((a, b) => a.toolName.localeCompare(b.toolName))
    }));
  }, [mcpDiscoveredTools]);

  const activeProviderType = useMemo<"openai" | "koboldcpp">(() => {
    const activeId = settings?.activeProviderId;
    if (!activeId) return "openai";
    const row = providers.find((provider) => provider.id === activeId);
    return row?.providerType === "koboldcpp" ? "koboldcpp" : "openai";
  }, [providers, settings?.activeProviderId]);
  const toolCallingLocked = activeProviderType === "koboldcpp";

  const tabMeta: Array<{ id: "basic" | "advanced" | "prompts"; label: string; desc: string }> = [
    { id: "basic", label: t("settings.basic"), desc: t("settings.tabBasicDesc") },
    { id: "advanced", label: t("settings.advanced"), desc: t("settings.tabAdvancedDesc") },
    { id: "prompts", label: t("settings.prompts"), desc: t("settings.tabPromptsDesc") }
  ];

  const quickSections = useMemo(() => {
    if (activeTab === "basic") {
      return [
        { id: "settings-general", label: t("settings.general") },
        { id: "settings-quick-presets", label: t("settings.quickPresets") },
        { id: "settings-manual-provider", label: t("settings.manualConfig") },
        { id: "settings-active-model", label: t("settings.activeModel") },
        { id: "settings-compress-model", label: t("settings.compressModel") }
      ];
    }
    if (activeTab === "advanced") {
      return [
        { id: "settings-sampler-defaults", label: t("settings.samplerDefaults") },
        { id: "settings-default-system-advanced", label: t("settings.defaultSysPrompt") },
        { id: "settings-context-window", label: t("settings.contextWindow") },
        { id: "settings-tools-mcp", label: t("settings.tools") },
        { id: "settings-danger-zone", label: t("settings.dangerZone") }
      ];
    }
    return [
      { id: "settings-prompt-templates", label: t("settings.promptTemplates") },
      { id: "settings-default-system-prompts", label: t("settings.defaultSysPrompt") }
    ];
  }, [activeTab, t]);

  if (!settings) {
    return <div className="flex h-full items-center justify-center"><div className="text-sm text-text-tertiary">Loading settings...</div></div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-3">
        {tabMeta.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`settings-tab rounded-lg border px-4 py-3 text-left transition-colors ${
              activeTab === tab.id
                ? "is-active border-accent-border bg-accent-subtle text-text-primary"
                : "border-border bg-bg-secondary text-text-secondary hover:bg-bg-hover"
            }`}
          >
            <div className="text-xs font-semibold uppercase tracking-[0.08em]">{tab.label}</div>
            <div className="mt-1 text-[11px] text-text-tertiary">{tab.desc}</div>
          </button>
        ))}
      </div>

      <div className="mb-4 rounded-lg border border-border bg-bg-secondary p-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{t("settings.quickJump")}</div>
        <div className="flex flex-wrap gap-1.5">
          {quickSections.map((section) => (
            <button
              key={section.id}
              onClick={() => scrollToSettingsSection(section.id)}
              className="rounded-md border border-border-subtle bg-bg-primary px-2.5 py-1 text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            >
              {section.label}
            </button>
          ))}
        </div>
      </div>

      <div key={activeTab} className="settings-content">
      {activeTab === "prompts" ? (
        <div className="space-y-4">
          <div id="settings-prompt-templates" className="scroll-mt-24 rounded-xl border border-border bg-bg-secondary p-5">
            <SectionTitle>{t("settings.promptTemplates")}</SectionTitle>
            <p className="mb-4 text-[11px] text-text-tertiary">{t("settings.promptTemplatesDesc")}</p>
            <div className="space-y-4">
              {([
                { key: "jailbreak" as const, label: t("prompt.jailbreak"), desc: t("prompt.jailbreakDesc") },
                { key: "compressSummary" as const, label: t("prompt.compress"), desc: t("prompt.compressDesc") },
                { key: "creativeWriting" as const, label: t("prompt.creativeWriting"), desc: t("prompt.creativeWritingDesc") },
                { key: "writerGenerate" as const, label: t("prompt.writerGenerate"), desc: t("prompt.writerGenerateDesc") },
                { key: "writerExpand" as const, label: t("prompt.writerExpand"), desc: t("prompt.writerExpandDesc") },
                { key: "writerRewrite" as const, label: t("prompt.writerRewrite"), desc: t("prompt.writerRewriteDesc") },
                { key: "writerSummarize" as const, label: t("prompt.writerSummarize"), desc: t("prompt.writerSummarizeDesc") }
              ]).map(({ key, label, desc }) => (
                <div key={key}>
                  <div className="mb-1.5 flex items-center justify-between"><FieldLabel>{label}</FieldLabel></div>
                  <p className="mb-1.5 text-[10px] text-text-tertiary">{desc}</p>
                  <textarea value={settings.promptTemplates?.[key] ?? ""}
                    onChange={(e) => {
                      const newTemplates: PromptTemplates = { ...settings.promptTemplates, [key]: e.target.value };
                      patch({ promptTemplates: newTemplates });
                    }}
                    className="h-24 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs leading-relaxed text-text-primary placeholder:text-text-tertiary" />
                </div>
              ))}
            </div>
          </div>

          <div id="settings-default-system-prompts" className="scroll-mt-24 rounded-xl border border-border bg-bg-secondary p-5">
            <SectionTitle>{t("settings.defaultSysPrompt")}</SectionTitle>
            <p className="mb-2 text-[10px] text-text-tertiary">{t("settings.baseSysPromptDesc")}</p>
            <textarea value={settings.defaultSystemPrompt} onChange={(e) => patch({ defaultSystemPrompt: e.target.value })}
              className="h-32 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs leading-relaxed text-text-primary" />
          </div>
        </div>
      ) : activeTab === "basic" ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div id="settings-general" className="scroll-mt-24 rounded-xl border border-border bg-bg-secondary p-5">
            <SectionTitle>{t("settings.general")}</SectionTitle>
            <div className="space-y-4">
              <div>
                <FieldLabel>{t("settings.theme")}</FieldLabel>
                <SelectField value={settings.theme} onChange={(v) => patch({ theme: v as AppSettings["theme"] })}>
                  <option value="dark">{t("settings.dark")}</option>
                  <option value="light">{t("settings.light")}</option>
                  <option value="custom">{t("settings.custom")}</option>
                </SelectField>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <FieldLabel>{t("settings.textSize")}</FieldLabel>
                  <span className="text-xs text-text-tertiary">{Math.round(settings.fontScale * 100)}%</span>
                </div>
                <input type="range" min={0.8} max={1.4} step={0.05} value={settings.fontScale}
                  onChange={(e) => patch({ fontScale: Number(e.target.value) })} className="w-full" />
              </div>

              <div>
                <FieldLabel>{t("settings.interfaceLanguage")}</FieldLabel>
                <SelectField value={settings.interfaceLanguage || "en"} onChange={(v) => changeInterfaceLanguage(v as "en" | "ru" | "zh" | "ja")}>
                  <option value="en">English</option>
                  <option value="ru">Русский</option>
                  <option value="zh">简体中文</option>
                  <option value="ja">日本語</option>
                </SelectField>
              </div>

              <div>
                <FieldLabel>{t("settings.responseLanguage")}</FieldLabel>
                <InputField value={settings.responseLanguage} onChange={(v) => patch({ responseLanguage: v })} />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-bg-primary px-3 py-2.5">
                <div>
                  <div className="text-sm font-medium text-text-primary">{t("settings.fullLocalMode")}</div>
                  <div className="mt-0.5 text-[11px] text-text-tertiary">{t("settings.fullLocalDesc")}</div>
                </div>
                <input type="checkbox" checked={settings.fullLocalMode} onChange={(e) => patch({ fullLocalMode: e.target.checked })} />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-bg-primary px-3 py-2.5">
                <div>
                  <div className="text-sm font-medium text-text-primary">{t("settings.censorship")}</div>
                  <div className="mt-0.5 text-[11px] text-text-tertiary">{t("settings.censorshipDesc")}</div>
                </div>
                <SelectField value={settings.censorshipMode} onChange={(v) => patch({ censorshipMode: v as AppSettings["censorshipMode"] })}>
                  <option value="Unfiltered">{t("settings.unfiltered")}</option>
                  <option value="Filtered">{t("settings.filtered")}</option>
                </SelectField>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-bg-primary px-3 py-2.5">
                <div>
                  <div className="text-sm font-medium text-text-primary">{t("settings.mergeRoles")}</div>
                  <div className="mt-0.5 text-[11px] text-text-tertiary">{t("settings.mergeRolesDesc")}</div>
                </div>
                <input type="checkbox" checked={settings.mergeConsecutiveRoles ?? false}
                  onChange={(e) => patch({ mergeConsecutiveRoles: e.target.checked })} />
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div id="settings-quick-presets" className="scroll-mt-24 rounded-xl border border-border bg-bg-secondary p-5">
              <SectionTitle>{t("settings.quickPresets")}</SectionTitle>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PROVIDER_PRESETS.map((preset) => (
                  <button key={preset.key} onClick={() => applyPresetToForm(preset)}
                    className={`rounded-lg border p-2.5 text-left transition-colors ${
                      selectedPresetKey === preset.key ? "border-accent-border bg-accent-subtle" : "border-border hover:bg-bg-hover"
                    }`}>
                    <div className="text-xs font-semibold text-text-primary">{preset.label}</div>
                    <div className="mt-0.5 text-[10px] text-text-tertiary">{preset.description}</div>
                  </button>
                ))}
              </div>
              <button onClick={quickAddPreset}
                className="mt-3 w-full rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-text-inverse hover:bg-accent-hover">
                {t("settings.quickAdd")}
              </button>
            </div>

            <div id="settings-manual-provider" className="scroll-mt-24 rounded-xl border border-border bg-bg-secondary p-5">
              <SectionTitle>{t("settings.manualConfig")}</SectionTitle>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <FieldLabel>{t("settings.providerId")}</FieldLabel>
                    <InputField value={providerId} onChange={setProviderId} placeholder="Provider ID" />
                  </div>
                  <div>
                    <FieldLabel>{t("settings.providerName")}</FieldLabel>
                    <InputField value={providerName} onChange={setProviderName} placeholder="Display Name" />
                  </div>
                </div>
                <div>
                  <FieldLabel>{t("settings.baseUrl")}</FieldLabel>
                  <InputField value={providerBaseUrl} onChange={setProviderBaseUrl} placeholder="https://api.example.com/v1" />
                </div>
                <div>
                  <FieldLabel>Provider Type</FieldLabel>
                  <SelectField value={providerType} onChange={(v) => setProviderType(v as "openai" | "koboldcpp")}>
                    <option value="openai">OpenAI-compatible</option>
                    <option value="koboldcpp">KoboldCpp (native)</option>
                  </SelectField>
                </div>
                <div>
                  <FieldLabel>{t("settings.apiKey")}</FieldLabel>
                  <InputField value={providerApiKey} onChange={setProviderApiKey} placeholder={selectedPreset.apiKeyHint} />
                </div>
                <div>
                  <FieldLabel>{t("settings.proxyUrl")}</FieldLabel>
                  <InputField value={providerProxyUrl} onChange={setProviderProxyUrl} placeholder="https://proxy.example.com" />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-bg-primary px-3 py-2.5">
                  <span className="text-xs font-medium text-text-secondary">{t("settings.localOnly")}</span>
                  <input type="checkbox" checked={providerLocalOnly} onChange={(e) => setProviderLocalOnly(e.target.checked)} />
                </div>
                <div className="flex gap-2">
                  <button onClick={saveProvider} className="flex-1 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-text-inverse hover:bg-accent-hover">{t("settings.saveProvider")}</button>
                  <button onClick={testProvider} className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-hover">{t("settings.test")}</button>
                  <button onClick={refreshProviders} className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-hover">{t("settings.refresh")}</button>
                </div>
              </div>
            </div>

            <div id="settings-active-model" className="scroll-mt-24 rounded-xl border border-border bg-bg-secondary p-5">
              <SectionTitle>{t("settings.activeModel")}</SectionTitle>
              <div className="space-y-3">
                <div>
                  <FieldLabel>{t("settings.provider")}</FieldLabel>
                  <SelectField value={selectedProviderId} onChange={setSelectedProviderId}>
                    <option value="">{t("settings.selectProvider")}</option>
                    {providers.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                  </SelectField>
                </div>
                <div>
                  <FieldLabel>{t("chat.model")}</FieldLabel>
                  <SelectField value={selectedModelId} onChange={setSelectedModelId}>
                    <option value="">{t("settings.selectModel")}</option>
                    {models.map((model) => (<option key={model.id} value={model.id}>{model.id}</option>))}
                  </SelectField>
                </div>
                <button onClick={applyActiveModel}
                  className="w-full rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-text-inverse hover:bg-accent-hover">
                  {t("settings.useModel")}
                </button>
                <StatusMessage text={providerResult} variant={resultVariant} />
              </div>
            </div>

            {/* Compress Model Settings */}
            <div id="settings-compress-model" className="scroll-mt-24 rounded-xl border border-border bg-bg-secondary p-5">
              <SectionTitle>{t("settings.compressModel")}</SectionTitle>
              <p className="mb-3 text-[10px] text-text-tertiary">{t("settings.compressModelDesc")}</p>
              <div className="space-y-3">
                <div>
                  <FieldLabel>{t("settings.compressProvider")}</FieldLabel>
                  <SelectField value={settings.compressProviderId || ""} onChange={(v) => { patch({ compressProviderId: v || null }); }}>
                    <option value="">({t("settings.activeModel")})</option>
                    {providers.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                  </SelectField>
                </div>
                {settings.compressProviderId && (
                  <>
                    <div>
                      <FieldLabel>{t("chat.model")}</FieldLabel>
                      <SelectField value={settings.compressModel || ""} onChange={(v) => patch({ compressModel: v || null })}>
                        <option value="">({t("settings.activeModel")})</option>
                        {compressModels.map((m) => (<option key={m.id} value={m.id}>{m.id}</option>))}
                      </SelectField>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div id="settings-sampler-defaults" className="scroll-mt-24 rounded-xl border border-border bg-bg-secondary p-5">
            <SectionTitle>{t("settings.samplerDefaults")}</SectionTitle>
            <div className="space-y-4">
              {[
                { key: "temperature" as const, label: t("inspector.temperature"), min: 0, max: 2 },
                { key: "topP" as const, label: t("inspector.topP"), min: 0, max: 1 },
                { key: "frequencyPenalty" as const, label: t("inspector.freqPenalty"), min: 0, max: 2 },
                { key: "presencePenalty" as const, label: t("inspector.presPenalty"), min: 0, max: 2 }
              ].map(({ key, label, min, max }) => (
                <div key={key}>
                  <div className="mb-1.5 flex items-center justify-between">
                    <FieldLabel>{label}</FieldLabel>
                    <span className="text-xs text-text-tertiary">{settings.samplerConfig[key].toFixed(2)}</span>
                  </div>
                  <input type="range" min={min} max={max} step={0.05} value={settings.samplerConfig[key]}
                    onChange={(e) => patchSampler({ [key]: Number(e.target.value) })} className="w-full" />
                </div>
              ))}

              <div>
                <FieldLabel>{t("inspector.maxTokens")}</FieldLabel>
                <input type="number" value={settings.samplerConfig.maxTokens}
                  onChange={(e) => patchSampler({ maxTokens: Number(e.target.value) })}
                  className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
              </div>

              <div>
                <FieldLabel>{t("settings.stopSequences")}</FieldLabel>
                <InputField value={(settings.samplerConfig.stop || []).join(", ")}
                  onChange={(v) => patchSampler({ stop: v.split(",").map((s) => s.trim()).filter(Boolean) })}
                  placeholder="e.g. <|end|>, ###" />
              </div>

              <div className="rounded-lg border border-border-subtle bg-bg-primary p-3">
                <div className="mb-2 text-xs font-semibold text-text-secondary">KoboldCpp</div>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { key: "topK" as const, label: "Top-K", min: 0, max: 300, step: 1, fallback: 100 },
                    { key: "topA" as const, label: "Top-A", min: 0, max: 1, step: 0.01, fallback: 0 },
                    { key: "minP" as const, label: "Min-P", min: 0, max: 1, step: 0.01, fallback: 0 },
                    { key: "typical" as const, label: "Typical", min: 0, max: 1, step: 0.01, fallback: 1 },
                    { key: "tfs" as const, label: "TFS", min: 0, max: 1, step: 0.01, fallback: 1 },
                    { key: "nSigma" as const, label: "N-Sigma", min: 0, max: 1, step: 0.01, fallback: 0 },
                    { key: "repetitionPenalty" as const, label: "Repetition Penalty", min: 0, max: 2, step: 0.01, fallback: 1.1 }
                  ].map(({ key, label, min, max, step, fallback }) => (
                    <div key={key}>
                      <div className="mb-1.5 flex items-center justify-between">
                        <FieldLabel>{label}</FieldLabel>
                        <span className="text-xs text-text-tertiary">{Number(settings.samplerConfig[key] ?? fallback).toFixed(2)}</span>
                      </div>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={step}
                        value={Number(settings.samplerConfig[key] ?? fallback)}
                        onChange={(e) => patchSampler({ [key]: Number(e.target.value) })}
                        className="w-full"
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-3">
                  <FieldLabel>Default Kobold memory</FieldLabel>
                  <textarea
                    value={settings.samplerConfig.koboldMemory || ""}
                    onChange={(e) => patchSampler({ koboldMemory: e.target.value })}
                    className="h-20 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary"
                    placeholder="Persistent memory/context for KoboldCpp chats"
                  />
                </div>
                <div className="mt-3">
                  <FieldLabel>Default phrase bans</FieldLabel>
                  <InputField
                    value={koboldBansInput}
                    onChange={setKoboldBansInput}
                    onBlur={() => patchSampler({ koboldBannedPhrases: parsePhraseBansInput(koboldBansInput) })}
                    placeholder="phrase one, phrase two"
                  />
                </div>
                <div className="mt-3 flex items-center justify-between rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2">
                  <span className="text-xs font-medium text-text-secondary">Use default badwords IDs</span>
                  <input
                    type="checkbox"
                    checked={settings.samplerConfig.koboldUseDefaultBadwords === true}
                    onChange={(e) => patchSampler({ koboldUseDefaultBadwords: e.target.checked })}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div id="settings-default-system-advanced" className="scroll-mt-24 rounded-xl border border-border bg-bg-secondary p-5">
              <SectionTitle>{t("settings.defaultSysPrompt")}</SectionTitle>
              <textarea value={settings.defaultSystemPrompt}
                onChange={(e) => patch({ defaultSystemPrompt: e.target.value })}
                className="h-40 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs leading-relaxed text-text-primary placeholder:text-text-tertiary"
                placeholder="Default system prompt for new chats..." />
              <p className="mt-2 text-[10px] text-text-tertiary">{t("settings.defaultSysPromptDesc")}</p>
            </div>

            <div id="settings-context-window" className="scroll-mt-24 rounded-xl border border-border bg-bg-secondary p-5">
              <SectionTitle>{t("settings.contextWindow")}</SectionTitle>
              <div className="space-y-3">
                <div>
                  <FieldLabel>{t("settings.contextSize")}</FieldLabel>
                  <input type="number" value={settings.contextWindowSize}
                    onChange={(e) => patch({ contextWindowSize: Number(e.target.value) })}
                    className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
                </div>
                <div>
                  <FieldLabel>{t("settings.contextTailWithSummary")}</FieldLabel>
                  <input
                    type="number"
                    min={5}
                    max={95}
                    value={settings.contextTailBudgetWithSummaryPercent ?? 35}
                    onChange={(e) => {
                      const raw = Number(e.target.value);
                      const next = Number.isFinite(raw) ? Math.max(5, Math.min(95, Math.floor(raw))) : 35;
                      patch({ contextTailBudgetWithSummaryPercent: next });
                    }}
                    className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
                </div>
                <div>
                  <FieldLabel>{t("settings.contextTailWithoutSummary")}</FieldLabel>
                  <input
                    type="number"
                    min={5}
                    max={95}
                    value={settings.contextTailBudgetWithoutSummaryPercent ?? 75}
                    onChange={(e) => {
                      const raw = Number(e.target.value);
                      const next = Number.isFinite(raw) ? Math.max(5, Math.min(95, Math.floor(raw))) : 75;
                      patch({ contextTailBudgetWithoutSummaryPercent: next });
                    }}
                    className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
                </div>
                <p className="text-[10px] text-text-tertiary">{t("settings.contextDesc")}</p>
              </div>
            </div>

            <div id="settings-tools-mcp" className="scroll-mt-24 rounded-xl border border-border bg-bg-secondary p-5">
              <SectionTitle>{t("settings.tools")}</SectionTitle>
              <div className="space-y-4">
                {toolCallingLocked && (
                  <div className="rounded-lg border border-warning-border bg-warning-subtle px-3 py-2 text-xs text-warning">
                    {t("settings.toolCallingKoboldDisabled")}
                  </div>
                )}
                <div className={`flex items-center justify-between rounded-lg border border-border-subtle bg-bg-primary px-3 py-2.5 ${toolCallingLocked ? "opacity-60" : ""}`}>
                  <div>
                    <div className="text-sm font-medium text-text-primary">{t("settings.toolCallingEnabled")}</div>
                    <div className="mt-0.5 text-[11px] text-text-tertiary">{t("settings.toolCallingDesc")}</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.toolCallingEnabled ?? false}
                    disabled={toolCallingLocked}
                    onChange={(e) => patch({ toolCallingEnabled: e.target.checked })}
                  />
                </div>

                <div className={toolCallingLocked ? "opacity-60" : ""}>
                  <FieldLabel>{t("settings.toolCallingPolicy")}</FieldLabel>
                  <SelectField
                    value={settings.toolCallingPolicy ?? "balanced"}
                    onChange={(v) => patch({ toolCallingPolicy: v as AppSettings["toolCallingPolicy"] })}
                    disabled={toolCallingLocked}
                  >
                    <option value="conservative">{t("settings.toolPolicyConservative")}</option>
                    <option value="balanced">{t("settings.toolPolicyBalanced")}</option>
                    <option value="aggressive">{t("settings.toolPolicyAggressive")}</option>
                  </SelectField>
                  <p className="mt-1 text-[10px] text-text-tertiary">{t("settings.toolCallingPolicyDesc")}</p>
                </div>

                <div className={toolCallingLocked ? "opacity-60" : ""}>
                  <FieldLabel>{t("settings.maxToolCalls")}</FieldLabel>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={settings.maxToolCallsPerTurn ?? 4}
                    disabled={toolCallingLocked}
                    onChange={(e) => {
                      const raw = Number(e.target.value);
                      const next = Number.isFinite(raw) ? Math.max(1, Math.min(12, Math.floor(raw))) : 4;
                      patch({ maxToolCallsPerTurn: next });
                    }}
                    className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                  />
                </div>

                <div className={`flex items-center justify-between rounded-lg border border-border-subtle bg-bg-primary px-3 py-2.5 ${toolCallingLocked ? "opacity-60" : ""}`}>
                  <div>
                    <div className="text-sm font-medium text-text-primary">{t("settings.mcpAutoAttachTools")}</div>
                    <div className="mt-0.5 text-[11px] text-text-tertiary">{t("settings.mcpAutoAttachToolsDesc")}</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.mcpAutoAttachTools ?? true}
                    disabled={toolCallingLocked}
                    onChange={(e) => patch({ mcpAutoAttachTools: e.target.checked })}
                  />
                </div>

                <div className={`rounded-lg border border-border-subtle bg-bg-primary p-3 ${toolCallingLocked ? "opacity-60" : ""}`}>
                  <div className="mb-2 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-text-primary">{t("settings.mcpFunctions")}</div>
                      <div className="text-[11px] text-text-tertiary">{t("settings.mcpFunctionsDesc")}</div>
                    </div>
                    <button
                      onClick={() => void discoverMcpFunctions()}
                      disabled={mcpDiscoveryLoading || toolCallingLocked}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-60"
                    >
                      {mcpDiscoveryLoading ? t("settings.mcpLoadingFunctions") : t("settings.mcpLoadFunctions")}
                    </button>
                  </div>

                  {discoveredToolsByServer.length === 0 ? (
                    <div className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-xs text-text-tertiary">
                      {t("settings.mcpNoFunctions")}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {discoveredToolsByServer.map((group) => (
                        <div key={group.serverId} className="rounded-lg border border-border-subtle bg-bg-secondary p-2">
                          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-tertiary">
                            {group.serverName}
                          </div>
                          <div className="space-y-1.5">
                            {group.tools.map((tool) => {
                              const enabled = toolStates[tool.callName] !== false;
                              return (
                                <label
                                  key={tool.callName}
                                  className="flex items-center justify-between gap-2 rounded-md border border-border-subtle bg-bg-primary px-2 py-1.5"
                                >
                                  <div className="min-w-0">
                                    <div className="truncate text-xs font-medium text-text-primary">{tool.toolName}</div>
                                    <div className="truncate text-[10px] text-text-tertiary">{tool.callName}</div>
                                  </div>
                                  <input
                                    type="checkbox"
                                    checked={enabled}
                                    disabled={toolCallingLocked}
                                    onChange={(e) => {
                                      void setToolEnabled(tool.callName, e.target.checked);
                                    }}
                                  />
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border-subtle bg-bg-primary p-3">
                  <div className="mb-2">
                    <div className="text-sm font-medium text-text-primary">{t("settings.mcpServers")}</div>
                    <div className="text-[11px] text-text-tertiary">{t("settings.mcpServersDesc")}</div>
                  </div>

                  <div className="mb-3 rounded-lg border border-border-subtle bg-bg-secondary p-3">
                    <FieldLabel>{t("settings.mcpImportSource")}</FieldLabel>
                    <textarea
                      value={mcpImportSource}
                      onChange={(e) => setMcpImportSource(e.target.value)}
                      className="h-20 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs leading-relaxed text-text-primary placeholder:text-text-tertiary"
                      placeholder={t("settings.mcpImportPlaceholder")}
                    />
                    <button
                      onClick={() => void importMcpServers()}
                      disabled={mcpImportLoading}
                      className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-60"
                    >
                      {mcpImportLoading ? t("settings.mcpImporting") : t("settings.mcpImport")}
                    </button>
                  </div>

                  <div className="space-y-3">
                    {mcpServersDraft.map((server, index) => {
                      const rowKey = server.id || `mcp-row-${index}`;
                      const testResult = mcpTestResults[rowKey];
                      return (
                      <div key={rowKey} className="rounded-lg border border-border-subtle bg-bg-secondary p-3">
                        <div className="mb-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                          <div>
                            <FieldLabel>{t("settings.mcpId")}</FieldLabel>
                            <InputField value={server.id} onChange={(v) => updateMcpServer(server.id, { id: v })} />
                          </div>
                          <div>
                            <FieldLabel>{t("settings.mcpName")}</FieldLabel>
                            <InputField value={server.name} onChange={(v) => updateMcpServer(server.id, { name: v })} />
                          </div>
                        </div>

                        <div className="mb-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                          <div>
                            <FieldLabel>{t("settings.mcpCommand")}</FieldLabel>
                            <InputField value={server.command} onChange={(v) => updateMcpServer(server.id, { command: v })} />
                          </div>
                          <div>
                            <FieldLabel>{t("settings.mcpArgs")}</FieldLabel>
                            <InputField value={server.args} onChange={(v) => updateMcpServer(server.id, { args: v })} />
                          </div>
                        </div>

                        <div className="mb-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                          <div>
                            <FieldLabel>{t("settings.mcpTimeout")}</FieldLabel>
                            <input
                              type="number"
                              min={1000}
                              max={120000}
                              value={server.timeoutMs}
                              onChange={(e) => {
                                const raw = Number(e.target.value);
                                const timeoutMs = Number.isFinite(raw) ? Math.max(1000, Math.min(120000, Math.floor(raw))) : 15000;
                                updateMcpServer(server.id, { timeoutMs });
                              }}
                              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                            />
                          </div>
                          <div className="flex items-end">
                            <div className="flex w-full items-center justify-between rounded-lg border border-border-subtle bg-bg-primary px-3 py-2.5">
                              <span className="text-xs font-medium text-text-secondary">{t("settings.mcpEnabled")}</span>
                              <input
                                type="checkbox"
                                checked={server.enabled}
                                onChange={(e) => updateMcpServer(server.id, { enabled: e.target.checked })}
                              />
                            </div>
                          </div>
                        </div>

                        <div>
                          <FieldLabel>{t("settings.mcpEnv")}</FieldLabel>
                          <textarea
                            value={server.env || ""}
                            onChange={(e) => updateMcpServer(server.id, { env: e.target.value })}
                            className="h-20 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs leading-relaxed text-text-primary placeholder:text-text-tertiary"
                          />
                        </div>

                        <button
                          onClick={() => removeMcpServer(server.id)}
                          className="mt-2 rounded-lg border border-danger-border px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger-subtle"
                        >
                          {t("settings.mcpRemove")}
                        </button>

                        <button
                          onClick={() => void testMcpServer(server, rowKey)}
                          disabled={testingMcpId === rowKey}
                          className="mt-2 ml-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-60"
                        >
                          {testingMcpId === rowKey ? t("settings.mcpTesting") : t("settings.mcpTest")}
                        </button>

                        {testResult ? (
                          <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${
                            testResult.ok
                              ? "border-success-border bg-success-subtle text-success"
                              : "border-danger-border bg-danger-subtle text-danger"
                          }`}>
                            <div className="font-medium">
                              {testResult.ok ? t("settings.mcpTestOk") : t("settings.mcpTestFail")}
                            </div>
                            {testResult.ok ? (
                              <div className="mt-1">
                                {t("settings.mcpToolsFound")}: {testResult.tools.length}
                              </div>
                            ) : (
                              <div className="mt-1">{testResult.error || "Unknown error"}</div>
                            )}
                            {testResult.ok ? (
                              <div className="mt-1 text-text-secondary">
                                {testResult.tools.length > 0
                                  ? testResult.tools.map((tool) => tool.name).join(", ")
                                  : t("settings.mcpNoTools")}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      );
                    })}
                  </div>

                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={addMcpServer}
                      className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-hover"
                    >
                      {t("settings.mcpAdd")}
                    </button>
                    <button
                      onClick={saveMcpServers}
                      disabled={!mcpDirty}
                      className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-text-inverse hover:bg-accent-hover disabled:opacity-60"
                    >
                      {t("settings.mcpSave")}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div id="settings-danger-zone" className="scroll-mt-24 rounded-xl border border-danger-border bg-bg-secondary p-5">
              <SectionTitle>{t("settings.dangerZone")}</SectionTitle>
              <p className="mb-3 text-[10px] text-text-tertiary">{t("settings.dangerZoneDesc")}</p>
              <button
                onClick={reset}
                className="w-full rounded-lg border border-danger-border px-3 py-2 text-sm font-medium text-danger hover:bg-danger-subtle"
              >
                {t("settings.resetAll")}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
