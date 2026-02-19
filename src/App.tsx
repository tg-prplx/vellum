import { useEffect, useMemo, useState } from "react";
import { ChatScreen } from "./features/chat/ChatScreen";
import { WritingScreen } from "./features/writer/WritingScreen";
import { CharactersScreen } from "./features/characters/CharactersScreen";
import { LorebooksScreen } from "./features/lorebooks/LorebooksScreen";
import { SettingsScreen } from "./features/settings/SettingsScreen";
import { WelcomeScreen } from "./features/welcome/WelcomeScreen";
import { I18nContext, translations, useI18n, type Locale } from "./shared/i18n";
import { api } from "./shared/api";
import { TitleBar } from "./components/TitleBar";
import type { AppSettings } from "./shared/types/contracts";

type TabId = "chat" | "writing" | "characters" | "lorebooks" | "settings";

function TabIcon({ path }: { path: string }) {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

function AppContent() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<TabId>("chat");

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: "chat", label: t("tab.chat"), icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" },
    { id: "writing", label: t("tab.writing"), icon: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" },
    { id: "characters", label: t("tab.characters"), icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" },
    { id: "lorebooks", label: t("tab.lorebooks"), icon: "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5A4.5 4.5 0 003 9.5v9A4.5 4.5 0 017.5 14c1.746 0 3.332.477 4.5 1.253m0-9c1.168-.776 2.754-1.253 4.5-1.253A4.5 4.5 0 0121 9.5v9a4.5 4.5 0 00-4.5-4.5c-1.746 0-3.332.477-4.5 1.253" },
    { id: "settings", label: t("tab.settings"), icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" }
  ];

  const content = useMemo(() => {
    if (activeTab === "chat") return <ChatScreen />;
    if (activeTab === "writing") return <WritingScreen />;
    if (activeTab === "characters") return <CharactersScreen />;
    if (activeTab === "lorebooks") return <LorebooksScreen />;
    return <SettingsScreen />;
  }, [activeTab]);

  const isElectron = !!window.electronAPI;

  const noDrag = isElectron
    ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
    : undefined;

  const brandNode = (
    <div className="flex items-center gap-2.5">
      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent">
        <svg className="h-4 w-4 text-text-inverse" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
      </div>
      <span className="text-sm font-semibold text-text-primary">{t("app.name")}</span>
    </div>
  );

  const tabsNode = (
    <nav
      className="app-nav my-1.5 flex items-center gap-1 rounded-lg border border-border-subtle bg-bg-secondary p-1"
      style={noDrag}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={`app-tab-button flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            activeTab === tab.id
              ? "is-active bg-bg-hover text-text-primary"
              : "text-text-tertiary hover:text-text-secondary"
          }`}
        >
          <TabIcon path={tab.icon} />
          {tab.label}
        </button>
      ))}
    </nav>
  );

  return (
    <div className="app-shell flex h-screen w-screen flex-col overflow-hidden bg-bg-primary">
      {isElectron ? (
        <TitleBar>
          <div className="mx-auto flex w-full max-w-[1600px] items-center px-7 py-1.5">
            <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-3">
              <div className="justify-self-start" style={noDrag}>
                {brandNode}
              </div>
              <div className="justify-self-center">
                {tabsNode}
              </div>
              <div className="pointer-events-none justify-self-end opacity-0" style={noDrag}>
                {brandNode}
              </div>
            </div>
          </div>
        </TitleBar>
      ) : (
        <header className="flex-shrink-0 border-b border-border">
          <div className="mx-auto flex w-full max-w-[1600px] items-center px-7 py-4">
            <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-3">
              <div className="justify-self-start">{brandNode}</div>
              <div className="justify-self-center">{tabsNode}</div>
              <div className="pointer-events-none justify-self-end opacity-0">{brandNode}</div>
            </div>
          </div>
        </header>
      )}

      <main className="mx-auto w-full max-w-[1600px] flex-1 overflow-hidden p-4">
        <div key={activeTab} className="tab-content-enter h-full">
          {content}
        </div>
      </main>
    </div>
  );
}

function applyTheme(theme: string) {
  const root = document.documentElement;
  root.classList.remove("theme-light");
  if (theme === "light") {
    root.classList.add("theme-light");
  }
}

function isSupportedLocale(value: unknown): value is Locale {
  return value === "en" || value === "ru" || value === "zh" || value === "ja";
}

export function App() {
  const [locale, setLocale] = useState<Locale>("en");
  const [initialSettings, setInitialSettings] = useState<AppSettings | null>(null);
  const [isBooting, setIsBooting] = useState(true);
  const isElectron = !!window.electronAPI;

  useEffect(() => {
    api.settingsGet().then((s) => {
      setInitialSettings(s);
      applyTheme(s.theme ?? "dark");
      if (isSupportedLocale(s.interfaceLanguage)) {
        setLocale(s.interfaceLanguage);
      }
    }).catch(() => {}).finally(() => setIsBooting(false));

    const handler = (e: Event) => {
      setLocale((e as CustomEvent).detail as Locale);
    };
    const themeHandler = (e: Event) => {
      applyTheme((e as CustomEvent<string>).detail);
    };
    const onboardingResetHandler = (e: Event) => {
      const next = (e as CustomEvent<AppSettings>).detail;
      if (!next) return;
      setInitialSettings(next);
      applyTheme(next.theme ?? "dark");
      if (isSupportedLocale(next.interfaceLanguage)) {
        setLocale(next.interfaceLanguage);
      }
    };
    window.addEventListener("locale-change", handler);
    window.addEventListener("theme-change", themeHandler);
    window.addEventListener("onboarding-reset", onboardingResetHandler);
    return () => {
      window.removeEventListener("locale-change", handler);
      window.removeEventListener("theme-change", themeHandler);
      window.removeEventListener("onboarding-reset", onboardingResetHandler);
    };
  }, []);

  async function completeOnboarding(patch: Partial<AppSettings>) {
    const updated = await api.settingsUpdate({ ...patch, onboardingCompleted: true });
    setInitialSettings(updated);
    applyTheme(updated.theme ?? "dark");
    if (isSupportedLocale(updated.interfaceLanguage)) {
      setLocale(updated.interfaceLanguage);
    }
  }

  return (
    <I18nContext.Provider value={locale}>
      {isBooting ? (
        <div className="flex h-screen w-screen items-center justify-center bg-bg-primary">
          <div className="text-sm text-text-tertiary">Loading...</div>
        </div>
      ) : initialSettings && !initialSettings.onboardingCompleted ? (
        <div className="app-shell flex h-screen w-screen flex-col overflow-hidden bg-bg-primary">
          {isElectron ? (
            <TitleBar>
              <div className="mx-auto flex w-full max-w-[1300px] items-center px-5 py-1">
                <div className="flex items-center gap-2.5" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent">
                    <svg className="h-4 w-4 text-text-inverse" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                    </svg>
                  </div>
                  <span className="text-sm font-semibold text-text-primary">{translations[locale]["app.name"]}</span>
                  <span className="rounded-md border border-border-subtle bg-bg-secondary px-2 py-1 text-[10px] text-text-secondary">
                    {translations[locale]["welcome.setupBadge"]}
                  </span>
                </div>
              </div>
            </TitleBar>
          ) : null}
          <main className="flex-1 overflow-hidden">
            <WelcomeScreen
              initialSettings={initialSettings}
              onPreviewLocale={setLocale}
              onComplete={completeOnboarding}
            />
          </main>
        </div>
      ) : (
        <AppContent />
      )}
    </I18nContext.Provider>
  );
}
