import { useEffect, useMemo, useState } from "react";
import { ThreePanelLayout, PanelTitle, EmptyState } from "../../components/Panels";
import { api } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import type { LoreBook, LoreBookEntry } from "../../shared/types/contracts";

const POSITION_OPTIONS = [
  "after_char",
  "before_char",
  "after_scene",
  "before_scene",
  "after_system",
  "before_system",
  "after_jailbreak",
  "before_jailbreak"
] as const;

function splitKeys(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinKeys(keys: string[]): string {
  return keys.join(", ");
}

function newEntry(index: number): LoreBookEntry {
  return {
    id: `entry-${Date.now()}-${index}`,
    name: "",
    keys: [],
    content: "",
    enabled: true,
    constant: false,
    position: "after_char",
    insertionOrder: (index + 1) * 100
  };
}

export function LorebooksScreen() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [lorebooks, setLorebooks] = useState<LoreBook[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<LoreBook | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const list = await api.lorebookList();
        setLorebooks(list);
        if (list[0]) {
          setSelectedId(list[0].id);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDraft(null);
      return;
    }
    const current = lorebooks.find((item) => item.id === selectedId) || null;
    setDraft(current ? {
      ...current,
      entries: (current.entries || []).map((entry) => ({ ...entry, keys: [...entry.keys] }))
    } : null);
  }, [selectedId, lorebooks]);

  const selected = useMemo(
    () => lorebooks.find((item) => item.id === selectedId) || null,
    [lorebooks, selectedId]
  );

  async function refreshLorebooks(nextSelectedId?: string | null) {
    const list = await api.lorebookList();
    setLorebooks(list);
    if (nextSelectedId) {
      setSelectedId(nextSelectedId);
      return;
    }
    if (!selectedId && list[0]) {
      setSelectedId(list[0].id);
    }
    if (selectedId && !list.find((item) => item.id === selectedId)) {
      setSelectedId(list[0]?.id || null);
    }
  }

  async function createLorebook() {
    const created = await api.lorebookCreate({
      name: t("lore.newBookName"),
      description: "",
      entries: [newEntry(0)]
    });
    await refreshLorebooks(created.id);
    setStatus(t("lore.statusCreated"));
  }

  async function saveLorebook() {
    if (!draft) return;
    setSaving(true);
    try {
      const payload: Partial<LoreBook> = {
        name: draft.name,
        description: draft.description,
        entries: (draft.entries || []).map((entry) => ({
          ...entry,
          position: entry.position || "after_char",
          insertionOrder: Number.isFinite(entry.insertionOrder) ? Math.floor(entry.insertionOrder) : 100
        }))
      };
      const updated = await api.lorebookUpdate(draft.id, payload);
      setLorebooks((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setDraft(updated);
      setStatus(t("lore.statusSaved"));
    } finally {
      setSaving(false);
    }
  }

  async function deleteLorebook(id: string) {
    await api.lorebookDelete(id);
    await refreshLorebooks(null);
    setStatus(t("lore.statusDeleted"));
  }

  function updateEntry(entryId: string, patch: Partial<LoreBookEntry>) {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        entries: prev.entries.map((entry) => (entry.id === entryId ? { ...entry, ...patch } : entry))
      };
    });
  }

  function addEntry() {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        entries: [...prev.entries, newEntry(prev.entries.length)]
      };
    });
  }

  function removeEntry(entryId: string) {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        entries: prev.entries.filter((entry) => entry.id !== entryId)
      };
    });
  }

  return (
    <ThreePanelLayout
      left={
        <>
          <PanelTitle
            action={
              <button
                onClick={() => { void createLorebook(); }}
                className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-text-inverse hover:bg-accent-hover"
              >
                + {t("chat.new")}
              </button>
            }
          >
            {t("tab.lorebooks")}
          </PanelTitle>

          {loading ? (
            <div className="text-xs text-text-tertiary">{t("lore.loading")}</div>
          ) : lorebooks.length === 0 ? (
            <EmptyState title={t("lore.emptyTitle")} description={t("lore.emptyDesc")} />
          ) : (
            <div className="space-y-1">
              {lorebooks.map((book) => (
                <button
                  key={book.id}
                  onClick={() => setSelectedId(book.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    selectedId === book.id
                      ? "border-accent-border bg-accent-subtle"
                      : "border-border-subtle bg-bg-primary hover:bg-bg-hover"
                  }`}
                >
                  <div className="truncate text-sm font-medium text-text-primary">{book.name}</div>
                  <div className="mt-0.5 text-[11px] text-text-tertiary">{book.entries.length} {t("lore.entriesCount")}</div>
                </button>
              ))}
            </div>
          )}
        </>
      }
      center={
        draft ? (
          <div className="flex h-full flex-col gap-3 overflow-y-auto">
            <div className="rounded-lg border border-border-subtle bg-bg-primary p-3">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{t("lore.name")}</label>
              <input
                value={draft.name}
                onChange={(e) => setDraft((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
                className="w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
              />

              <label className="mb-1 mt-3 block text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{t("lore.description")}</label>
              <textarea
                value={draft.description}
                onChange={(e) => setDraft((prev) => (prev ? { ...prev, description: e.target.value } : prev))}
                className="h-20 w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
              />
            </div>

            <div className="rounded-lg border border-border-subtle bg-bg-primary p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{t("lore.entries")}</div>
                <button
                  onClick={addEntry}
                  className="rounded-md border border-border px-2 py-1 text-[11px] text-text-secondary hover:bg-bg-hover"
                >
                  + {t("lore.entry")}
                </button>
              </div>

              <div className="space-y-2">
                {draft.entries.map((entry, index) => (
                  <div key={entry.id} className="rounded-lg border border-border bg-bg-secondary p-2">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="text-xs font-medium text-text-primary">{t("lore.entry")} {index + 1}</div>
                      <button
                        onClick={() => removeEntry(entry.id)}
                        className="rounded-md px-2 py-1 text-[11px] text-danger/70 hover:bg-danger-subtle hover:text-danger"
                      >
                        {t("chat.delete")}
                      </button>
                    </div>

                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-[10px] text-text-tertiary">{t("lore.keys")}</label>
                        <input
                          value={joinKeys(entry.keys)}
                          onChange={(e) => updateEntry(entry.id, { keys: splitKeys(e.target.value) })}
                          className="w-full rounded-md border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-[10px] text-text-tertiary">{t("lore.position")}</label>
                        <select
                          value={entry.position || "after_char"}
                          onChange={(e) => updateEntry(entry.id, { position: e.target.value })}
                          className="w-full rounded-md border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary"
                        >
                          {POSITION_OPTIONS.map((option) => (
                            <option key={option} value={option}>{option}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block text-[10px] text-text-tertiary">{t("lore.insertionOrder")}</label>
                        <input
                          type="number"
                          value={entry.insertionOrder}
                          onChange={(e) => updateEntry(entry.id, { insertionOrder: Number(e.target.value) || 0 })}
                          className="w-full rounded-md border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary"
                        />
                      </div>

                      <label className="flex items-center justify-between rounded-md border border-border bg-bg-primary px-2 py-1.5">
                        <span className="text-[10px] text-text-secondary">{t("lore.enabled")}</span>
                        <input
                          type="checkbox"
                          checked={entry.enabled}
                          onChange={(e) => updateEntry(entry.id, { enabled: e.target.checked })}
                        />
                      </label>

                      <label className="flex items-center justify-between rounded-md border border-border bg-bg-primary px-2 py-1.5 md:col-span-2">
                        <span className="text-[10px] text-text-secondary">{t("lore.constant")}</span>
                        <input
                          type="checkbox"
                          checked={entry.constant}
                          onChange={(e) => updateEntry(entry.id, { constant: e.target.checked })}
                        />
                      </label>
                    </div>

                    <div className="mt-2">
                      <label className="mb-1 block text-[10px] text-text-tertiary">{t("lore.content")}</label>
                      <textarea
                        value={entry.content}
                        onChange={(e) => updateEntry(entry.id, { content: e.target.value })}
                        className="h-28 w-full rounded-md border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => { void saveLorebook(); }}
                disabled={saving}
                className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-text-inverse hover:bg-accent-hover disabled:opacity-60"
              >
                {saving ? t("lore.saving") : t("lore.save")}
              </button>
              {selected && (
                <button
                  onClick={() => { void deleteLorebook(selected.id); }}
                  className="rounded-lg border border-danger-border px-3 py-2 text-xs font-medium text-danger hover:bg-danger-subtle"
                >
                  {t("lore.deleteBook")}
                </button>
              )}
              {status && <span className="text-xs text-text-tertiary">{status}</span>}
            </div>
          </div>
        ) : (
          <EmptyState title={t("lore.selectTitle")} description={t("lore.selectDesc")} />
        )
      }
      right={
        <div className="space-y-3 text-xs text-text-secondary">
          <PanelTitle>{t("lore.howItWorks")}</PanelTitle>
          <div className="rounded-lg border border-border-subtle bg-bg-primary p-3 leading-relaxed">
            <div className="font-medium text-text-primary">{t("lore.supportedFields")}</div>
            <div className="mt-1">{t("lore.supportedFieldsDesc")}</div>
          </div>
          <div className="rounded-lg border border-border-subtle bg-bg-primary p-3 leading-relaxed">
            <div className="font-medium text-text-primary">{t("lore.triggerLogic")}</div>
            <div className="mt-1">{t("lore.triggerLogicDesc")}</div>
          </div>
          <div className="rounded-lg border border-border-subtle bg-bg-primary p-3 leading-relaxed">
            <div className="font-medium text-text-primary">{t("lore.importSource")}</div>
            <div className="mt-1">{t("lore.importSourceDesc")} <code>character_book</code>.</div>
          </div>
        </div>
      }
    />
  );
}
