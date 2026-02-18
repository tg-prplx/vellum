import { useMemo, useState } from "react";
import { api } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import { PROVIDER_PRESETS } from "../../shared/providerPresets";
import type { AppSettings } from "../../shared/types/contracts";

type WelcomeScreenProps = {
  initialSettings: AppSettings;
  onComplete: (patch: Partial<AppSettings>) => Promise<void>;
  onPreviewLocale: (locale: "en" | "ru" | "zh" | "ja") => void;
};

export function WelcomeScreen({ initialSettings, onComplete, onPreviewLocale }: WelcomeScreenProps) {
  const { t } = useI18n();
  const [interfaceLanguage, setInterfaceLanguage] = useState<"en" | "ru" | "zh" | "ja">(initialSettings.interfaceLanguage || "en");
  const [responseLanguage, setResponseLanguage] = useState(initialSettings.responseLanguage || "English");
  const [theme, setTheme] = useState<AppSettings["theme"]>(initialSettings.theme || "dark");
  const [censorshipMode, setCensorshipMode] = useState<AppSettings["censorshipMode"]>(initialSettings.censorshipMode || "Unfiltered");
  const [fullLocalMode, setFullLocalMode] = useState<boolean>(Boolean(initialSettings.fullLocalMode));
  const [selectedPresetKey, setSelectedPresetKey] = useState("openai");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [setupError, setSetupError] = useState("");
  const selectedPreset = useMemo(
    () => PROVIDER_PRESETS.find((preset) => preset.key === selectedPresetKey) ?? null,
    [selectedPresetKey]
  );

  const guideItems = [
    t("welcome.guideLanguage"),
    t("welcome.guideResponse"),
    t("welcome.guideSafety"),
    t("welcome.guideDone")
  ];
  const completedSteps = [
    Boolean(interfaceLanguage),
    responseLanguage.trim().length > 0,
    Boolean(censorshipMode),
    true
  ].filter(Boolean).length;
  const progressPercent = Math.round((completedSteps / guideItems.length) * 100);

  async function handleFinish() {
    if (isSaving) return;
    setIsSaving(true);
    setSetupError("");
    try {
      const providerPatch: Partial<AppSettings> = {};
      if (selectedPreset) {
        await api.providerUpsert({
          id: selectedPreset.defaultId,
          name: selectedPreset.defaultName,
          baseUrl: selectedPreset.baseUrl,
          apiKey: providerApiKey.trim() || (selectedPreset.localOnly ? "local-key" : ""),
          proxyUrl: null,
          fullLocalOnly: selectedPreset.localOnly
        });
        providerPatch.activeProviderId = selectedPreset.defaultId;
        providerPatch.activeModel = null;
      }

      await onComplete({
        interfaceLanguage,
        responseLanguage,
        theme,
        censorshipMode,
        fullLocalMode,
        ...providerPatch,
        onboardingCompleted: true
      });
      window.dispatchEvent(new CustomEvent("locale-change", { detail: interfaceLanguage }));
    } catch (error) {
      setSetupError(`${t("welcome.presetSetupFailed")}: ${String(error)}`);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="mx-auto h-full w-full max-w-[1300px] overflow-y-auto p-4 md:p-6">
      <div className="grid h-full min-h-[560px] grid-cols-1 gap-4 lg:grid-cols-[1.05fr,1.35fr]">
        <section className="panel-shell float-card flex flex-col rounded-2xl border border-border bg-bg-secondary p-5">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{t("welcome.stepLabel")}</p>
            <span className="rounded-md border border-border-subtle bg-bg-primary px-2 py-1 text-[10px] text-text-secondary">
              {progressPercent}%
            </span>
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-text-primary">{t("welcome.title")}</h1>
          <p className="mt-2 text-sm text-text-secondary">{t("welcome.subtitle")}</p>

          <div className="mt-4 overflow-hidden rounded-xl border border-border-subtle bg-bg-primary p-4">
            <div className="mb-3 h-1.5 rounded-full bg-bg-hover">
              <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${progressPercent}%` }} />
            </div>
            <ul className="space-y-2">
              {guideItems.map((item, index) => (
                <li key={item} className="flex items-start gap-2 text-sm text-text-secondary">
                  <span className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[10px] ${
                    index < completedSteps ? "bg-accent text-text-inverse" : "border border-border-subtle text-text-tertiary"
                  }`}>
                    {index < completedSteps ? "✓" : index + 1}
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-4 rounded-xl border border-border-subtle bg-bg-primary p-4">
            <p className="mb-2 text-xs font-medium text-text-secondary">{t("welcome.previewTitle")}</p>
            <svg className="h-24 w-full text-text-tertiary" viewBox="0 0 320 100" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="1" y="1" width="318" height="98" rx="12" stroke="currentColor" opacity="0.25" />
              <rect x="14" y="14" width="92" height="72" rx="8" fill="currentColor" opacity="0.12" />
              <rect x="118" y="20" width="188" height="10" rx="5" fill="currentColor" opacity="0.2" />
              <rect x="118" y="38" width="152" height="8" rx="4" fill="currentColor" opacity="0.15" />
              <rect x="118" y="52" width="170" height="8" rx="4" fill="currentColor" opacity="0.15" />
              <rect x="118" y="70" width="90" height="10" rx="5" fill="currentColor" opacity="0.25" />
            </svg>
            <p className="mt-2 text-xs text-text-tertiary">{t("welcome.previewHint")}</p>
          </div>
        </section>

        <section className="panel-shell float-card flex flex-col rounded-2xl border border-border bg-bg-secondary p-5">
          <h2 className="text-lg font-semibold text-text-primary">{t("welcome.setupTitle")}</h2>
          <p className="mt-1 text-sm text-text-secondary">{t("welcome.setupHint")}</p>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t("welcome.interfaceLanguage")}</label>
              <select
                value={interfaceLanguage}
                onChange={(e) => {
                  const next = e.target.value as "en" | "ru" | "zh" | "ja";
                  setInterfaceLanguage(next);
                  onPreviewLocale(next);
                }}
                className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
              >
                <option value="en">English</option>
                <option value="ru">Русский</option>
                <option value="zh">简体中文</option>
                <option value="ja">日本語</option>
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t("welcome.responseLanguage")}</label>
              <input
                value={responseLanguage}
                onChange={(e) => setResponseLanguage(e.target.value)}
                className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t("welcome.theme")}</label>
              <select
                value={theme}
                onChange={(e) => setTheme(e.target.value as AppSettings["theme"])}
                className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
              >
                <option value="dark">{t("settings.dark")}</option>
                <option value="light">{t("settings.light")}</option>
                <option value="custom">{t("settings.custom")}</option>
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t("welcome.censorship")}</label>
              <select
                value={censorshipMode}
                onChange={(e) => setCensorshipMode(e.target.value as AppSettings["censorshipMode"])}
                className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
              >
                <option value="Unfiltered">{t("settings.unfiltered")}</option>
                <option value="Filtered">{t("settings.filtered")}</option>
              </select>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between rounded-lg border border-border-subtle bg-bg-primary px-3 py-2.5">
            <div>
              <div className="text-sm font-medium text-text-primary">{t("welcome.localMode")}</div>
              <div className="mt-0.5 text-[11px] text-text-tertiary">{t("welcome.localModeDesc")}</div>
            </div>
            <input type="checkbox" checked={fullLocalMode} onChange={(e) => setFullLocalMode(e.target.checked)} />
          </div>

          <div className="mt-4 rounded-lg border border-border-subtle bg-bg-primary p-3">
            <div className="mb-2">
              <div className="text-sm font-medium text-text-primary">{t("welcome.quickPresets")}</div>
              <div className="text-[11px] text-text-tertiary">{t("welcome.quickPresetsDesc")}</div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t("welcome.selectPreset")}</label>
                <select
                  value={selectedPresetKey}
                  onChange={(e) => setSelectedPresetKey(e.target.value)}
                  className="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
                >
                  <option value="">{t("welcome.noPreset")}</option>
                  {PROVIDER_PRESETS.map((preset) => (
                    <option key={preset.key} value={preset.key}>{preset.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t("welcome.presetApiKey")}</label>
                <input
                  value={providerApiKey}
                  onChange={(e) => setProviderApiKey(e.target.value)}
                  disabled={!selectedPreset}
                  placeholder={selectedPreset?.apiKeyHint ?? "-"}
                  className="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary disabled:opacity-60"
                />
              </div>
            </div>

            {selectedPreset ? (
              <p className="mt-2 text-[11px] text-text-tertiary">
                {selectedPreset.description}. {t("welcome.presetSaveHint")}
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-text-tertiary">{t("welcome.presetSkipHint")}</p>
            )}
          </div>

          {setupError ? (
            <div className="mt-3 rounded-lg border border-danger-border bg-danger-subtle px-3 py-2 text-xs text-danger">
              {setupError}
            </div>
          ) : null}

          <div className="mt-auto pt-5">
            <button
              onClick={() => void handleFinish()}
              disabled={isSaving}
              className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-text-inverse hover:bg-accent-hover disabled:opacity-70"
            >
              {isSaving ? t("welcome.saving") : t("welcome.finish")}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
