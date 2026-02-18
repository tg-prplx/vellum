import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThreePanelLayout, PanelTitle, Badge, EmptyState } from "../../components/Panels";
import { api } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import { marked } from "marked";
import type {
  ChatMessage,
  ChatSession,
  FileAttachment,
  PromptBlock,
  RpSceneState,
  CharacterDetail,
  SamplerConfig,
  ProviderProfile,
  ProviderModel,
  UserPersona
} from "../../shared/types/contracts";

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true
});

/** Replace {{char}} and {{user}} placeholders in text */
function replacePlaceholders(text: string, charName?: string, userName?: string): string {
  let result = text;
  if (charName) {
    result = result.replace(/\{\{char\}\}/gi, charName);
  }
  if (userName) {
    result = result.replace(/\{\{user\}\}/gi, userName);
  }
  return result;
}

/** Render markdown to sanitized HTML */
function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

/** Combined: replace placeholders + render markdown */
function renderContent(text: string, charName?: string, userName?: string): string {
  const replaced = replacePlaceholders(text, charName, userName);
  return renderMarkdown(replaced);
}

const BLOCK_COLORS: Record<string, string> = {
  system: "border-blue-500/30 bg-blue-500/8",
  jailbreak: "border-red-500/30 bg-red-500/8",
  character: "border-purple-500/30 bg-purple-500/8",
  author_note: "border-amber-500/30 bg-amber-500/8",
  lore: "border-emerald-500/30 bg-emerald-500/8",
  scene: "border-cyan-500/30 bg-cyan-500/8",
  history: "border-slate-500/30 bg-slate-500/8"
};

const RP_PRESETS = ["slowburn", "dominant", "romantic", "action", "mystery", "submissive", "seductive", "gentle_fem", "rough", "passionate"] as const;

export function ChatScreen() {
  const { t } = useI18n();
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [activeChat, setActiveChat] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [authorNote, setAuthorNote] = useState("Stay in character, avoid repetition, keep sensual pacing controlled.");
  const [sceneState, setSceneState] = useState<RpSceneState>({
    chatId: "",
    variables: { location: "Private room", time: "Night" },
    mood: "teasing",
    pacing: "slow",
    intensity: 0.7
  });
  const [blocks, setBlocks] = useState<PromptBlock[]>([]);
  const [contextSummary, setContextSummary] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [streamText, setStreamText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [draggedBlockId, setDraggedBlockId] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string>("");
  const [activeModelLabel, setActiveModelLabel] = useState<string>("");

  // Character state
  const [characters, setCharacters] = useState<CharacterDetail[]>([]);
  const [showCharacterPicker, setShowCharacterPicker] = useState(false);

  // Multi-character state
  const [chatCharacterIds, setChatCharacterIds] = useState<string[]>([]);
  const [showMultiCharPanel, setShowMultiCharPanel] = useState(false);
  const [autoConvoRunning, setAutoConvoRunning] = useState(false);
  const [autoTurnsCount, setAutoTurnsCount] = useState(5);
  const autoConvoRef = useRef(false);

  // Sampler state
  const [samplerConfig, setSamplerConfig] = useState<SamplerConfig>({
    temperature: 0.9, topP: 1.0, frequencyPenalty: 0.0,
    presencePenalty: 0.0, maxTokens: 2048, stop: []
  });

  // File attachments
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [compressing, setCompressing] = useState(false);

  // Model selector in chat — auto-loading
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [chatProviderId, setChatProviderId] = useState("");
  const [chatModelId, setChatModelId] = useState("");
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);

  // Translate state
  const [translatingId, setTranslatingId] = useState<string | null>(null);
  const [translatedTexts, setTranslatedTexts] = useState<Record<string, string>>({});
  const [inPlaceTranslations, setInPlaceTranslations] = useState<Record<string, string>>({});

  // Active preset
  const [activePreset, setActivePreset] = useState<string | null>(null);

  // User persona
  const [personas, setPersonas] = useState<UserPersona[]>([]);
  const [activePersona, setActivePersona] = useState<UserPersona | null>(null);
  const [showPersonaModal, setShowPersonaModal] = useState(false);
  const [editingPersona, setEditingPersona] = useState<UserPersona | null>(null);

  // Per-chat sampler — auto-save debounce
  const [samplerSaved, setSamplerSaved] = useState(false);
  const samplerSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const samplerInitializedRef = useRef(false);

  // Collapsible sections in left sidebar
  const [presetsCollapsed, setPresetsCollapsed] = useState(false);

  // Inspector collapse
  const [inspectorSection, setInspectorSection] = useState<Record<string, boolean>>({
    scene: true, sampler: false, blocks: true, context: false
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const orderedBlocks = useMemo(
    () => [...blocks].sort((a, b) => a.order - b.order),
    [blocks]
  );

  const totalTokens = useMemo(
    () => messages.reduce((sum, m) => sum + (m.tokenCount || 0), 0),
    [messages]
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  // Load chats, settings, characters, providers
  useEffect(() => {
    api.chatList().then((list) => {
      setChats(list);
      if (list[0]) setActiveChat(list[0]);
    });
    api.settingsGet().then((settings) => {
      if (settings.activeProviderId && settings.activeModel) {
        setActiveModelLabel(`${settings.activeModel}`);
        setChatProviderId(settings.activeProviderId);
        setChatModelId(settings.activeModel);
      }
      if (settings.samplerConfig) setSamplerConfig(settings.samplerConfig);
    });
    api.characterList().then(setCharacters).catch(() => {});
    api.providerList().then(setProviders).catch(() => {});
    api.personaList().then((list) => {
      setPersonas(list);
      const def = list.find((p) => p.isDefault);
      if (def) setActivePersona(def);
    }).catch(() => {});
  }, []);

  // Auto-load models when provider changes
  useEffect(() => {
    if (!chatProviderId) { setModels([]); return; }
    setLoadingModels(true);
    api.providerFetchModels(chatProviderId)
      .then((list) => {
        setModels(list);
        if (list.length > 0 && !list.find((m) => m.id === chatModelId)) {
          setChatModelId(list[0].id);
        }
      })
      .catch(() => setModels([]))
      .finally(() => setLoadingModels(false));
  }, [chatProviderId]);

  useEffect(() => {
    if (!activeChat) {
      setMessages([]);
      setBlocks([]);
      setChatCharacterIds([]);
      return;
    }
    api.chatTimeline(activeChat.id).then((timeline) => {
      setMessages(timeline);
      setSceneState((prev) => ({ ...prev, chatId: activeChat.id }));
    });
    api.rpGetBlocks(activeChat.id).then(setBlocks).catch(() => {});
    // Load per-chat sampler config
    samplerInitializedRef.current = false;
    api.chatGetSampler(activeChat.id).then((config) => {
      if (config) setSamplerConfig((prev) => ({ ...prev, ...config }));
      // Mark as initialized after load so auto-save doesn't fire on load
      setTimeout(() => { samplerInitializedRef.current = true; }, 300);
    }).catch(() => {
      setTimeout(() => { samplerInitializedRef.current = true; }, 300);
    });
    // Load multi-char state
    setChatCharacterIds(activeChat.characterIds || (activeChat.characterId ? [activeChat.characterId] : []));
    setSamplerSaved(false);
  }, [activeChat]);

  // Auto-save sampler config when it changes (debounced)
  useEffect(() => {
    if (!activeChat || !samplerInitializedRef.current) return;
    if (samplerSaveTimerRef.current) clearTimeout(samplerSaveTimerRef.current);
    samplerSaveTimerRef.current = setTimeout(() => {
      api.chatSaveSampler(activeChat.id, samplerConfig).then(() => {
        setSamplerSaved(true);
        setTimeout(() => setSamplerSaved(false), 1500);
      }).catch(() => {});
    }, 800);
    return () => { if (samplerSaveTimerRef.current) clearTimeout(samplerSaveTimerRef.current); };
  }, [samplerConfig, activeChat]);

  const refreshActiveTimeline = useCallback(async () => {
    if (!activeChat) return;
    setMessages(await api.chatTimeline(activeChat.id));
  }, [activeChat]);

  const saveBlocksToServer = useCallback(
    (chatId: string, newBlocks: PromptBlock[]) => {
      api.rpSaveBlocks(chatId, newBlocks).catch(() => {});
    }, []
  );

  async function handleCreateChat(characterId?: string, multiCharIds?: string[]) {
    const ids = multiCharIds || (characterId ? [characterId] : []);
    const character = ids[0] ? characters.find((c) => c.id === ids[0]) : null;
    const title = character ? (ids.length > 1 ? `${character.name} & others` : character.name) : `Session ${new Date().toLocaleTimeString()}`;
    const created = await api.chatCreate(title, ids[0] || undefined, ids.length > 1 ? ids : undefined);
    setChats((prev) => [created, ...prev]);
    setActiveChat(created);
    setChatCharacterIds(ids);
    if (ids.length > 0) {
      const timeline = await api.chatTimeline(created.id);
      setMessages(timeline);
    } else {
      setMessages([]);
    }
    setShowCharacterPicker(false);
    setShowMultiCharPanel(false);
    textareaRef.current?.focus();
  }

  async function handleDeleteChat(chatId: string) {
    await api.chatDelete(chatId);
    setChats((prev) => prev.filter((c) => c.id !== chatId));
    if (activeChat?.id === chatId) {
      setActiveChat(null);
      setMessages([]);
    }
  }

  async function handleSend() {
    if (!input.trim()) return;
    setErrorText("");
    try {
      let chatId = activeChat?.id;
      if (!chatId) {
        const title = input.trim().slice(0, 40) + (input.trim().length > 40 ? "..." : "");
        const created = await api.chatCreate(title);
        setChats((prev) => [created, ...prev]);
        setActiveChat(created);
        chatId = created.id;
      }
      await api.rpSetSceneState({ ...sceneState, chatId });
      await api.rpUpdateAuthorNote(chatId, authorNote);

      let outgoing = input;
      const currentAttachments = [...attachments];
      if (currentAttachments.length > 0) {
        const textAttachments = currentAttachments.filter((a) => a.type === "text" && a.content);
        const imageAttachments = currentAttachments.filter((a) => a.type === "image");
        if (textAttachments.length > 0) {
          outgoing += "\n\n---\n[Attached files]\n" +
            textAttachments.map((a) => `[${a.filename}]:\n${a.content!.slice(0, 4000)}`).join("\n\n");
        }
        if (imageAttachments.length > 0) {
          outgoing += "\n\n[Attached images: " + imageAttachments.map((a) => a.filename).join(", ") + "]";
        }
      }
      setInput("");
      setAttachments([]);

      const optimisticMsg: ChatMessage = {
        id: `temp-${Date.now()}`, chatId, branchId: "main",
        role: "user", content: outgoing, tokenCount: 0, createdAt: new Date().toISOString()
      };
      setMessages((prev) => [...prev, optimisticMsg]);
      setStreamText("");
      setStreaming(true);

      const updated = await api.chatSend(chatId, outgoing, undefined, {
        onDelta: (delta) => setStreamText((prev) => prev + delta),
        onDone: () => { setStreaming(false); setStreamText(""); }
      }, activePersona?.name);
      setMessages(updated);
    } catch (error) {
      setStreaming(false);
      setStreamText("");
      setErrorText(String(error));
    }
  }

  async function handleAbort() {
    if (!activeChat) return;
    try {
      await api.chatAbort(activeChat.id);
      setStreaming(false);
      setStreamText("");
      autoConvoRef.current = false;
      setAutoConvoRunning(false);
      await refreshActiveTimeline();
    } catch (error) {
      setErrorText(String(error));
    }
  }

  async function handleRegenerate() {
    if (!activeChat) return;
    setErrorText("");
    try {
      setStreamText("");
      setStreaming(true);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") return prev.slice(0, -1);
        return prev;
      });
      const updated = await api.chatRegenerate(activeChat.id, undefined, {
        onDelta: (delta) => setStreamText((prev) => prev + delta),
        onDone: () => { setStreaming(false); setStreamText(""); }
      });
      setMessages(updated);
    } catch (error) {
      setStreaming(false);
      setStreamText("");
      setErrorText(String(error));
    }
  }

  async function handleCompress() {
    if (!activeChat) return;
    setErrorText("");
    setCompressing(true);
    try {
      const result = await api.chatCompressContext(activeChat.id);
      setContextSummary(result.summary);
      setInspectorSection((prev) => ({ ...prev, context: true }));
    } catch (error) {
      setErrorText(String(error));
    }
    setCompressing(false);
  }

  async function handleTranslate(msgId: string, inPlace?: boolean) {
    if (translatingId) return;
    setTranslatingId(msgId);
    try {
      const result = await api.chatTranslateMessage(msgId);
      if (inPlace) {
        setInPlaceTranslations((prev) => ({ ...prev, [msgId]: result.translation }));
        // Clear side translation if exists
        setTranslatedTexts((prev) => { const n = { ...prev }; delete n[msgId]; return n; });
      } else {
        setTranslatedTexts((prev) => ({ ...prev, [msgId]: result.translation }));
        // Clear in-place if exists
        setInPlaceTranslations((prev) => { const n = { ...prev }; delete n[msgId]; return n; });
      }
    } catch (error) {
      setErrorText(String(error));
    }
    setTranslatingId(null);
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(e.target.files)) {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => { const r = reader.result as string; resolve(r.split(",")[1] || r); };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const attachment = await api.uploadFile(base64, file.name);
        setAttachments((prev) => [...prev, attachment]);
      }
    } catch (error) { setErrorText(String(error)); }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeAttachment(id: string) { setAttachments((prev) => prev.filter((a) => a.id !== id)); }

  async function handleFork(message: ChatMessage) {
    if (!activeChat) return;
    await api.chatFork(activeChat.id, message.id, `Branch ${message.id.slice(0, 6)}`);
  }

  async function handleDelete(messageId: string) {
    const result = await api.chatDeleteMessage(messageId);
    setMessages(result.timeline);
  }

  async function saveEdit(messageId: string) {
    const result = await api.chatEditMessage(messageId, editingValue);
    setEditingId(null);
    setEditingValue("");
    setMessages(result.timeline);
  }

  async function applyPreset(preset: string) {
    if (!activeChat) return;
    try {
      const result = await api.rpApplyStylePreset(activeChat.id, preset);
      const data = result as unknown as { sceneState?: RpSceneState };
      if (data.sceneState) {
        setSceneState(data.sceneState);
      }
      setActivePreset(preset);
      api.rpGetBlocks(activeChat.id).then(setBlocks).catch(() => {});
      api.chatSavePreset(activeChat.id, preset).catch(() => {});
    } catch (error) {
      setErrorText(String(error));
    }
  }

  async function applyModelFromChat() {
    if (!chatProviderId || !chatModelId) return;
    try {
      const updated = await api.providerSetActive(chatProviderId, chatModelId);
      setActiveModelLabel(chatModelId);
      setShowModelSelector(false);
      if (updated.samplerConfig) setSamplerConfig(updated.samplerConfig);
    } catch (error) {
      setErrorText(String(error));
    }
  }

  // Multi-character: add/remove characters from chat
  async function addCharacterToChat(charId: string) {
    if (!activeChat || chatCharacterIds.includes(charId)) return;
    const newIds = [...chatCharacterIds, charId];
    setChatCharacterIds(newIds);
    await api.chatUpdateCharacters(activeChat.id, newIds);
  }

  async function removeCharacterFromChat(charId: string) {
    if (!activeChat) return;
    const newIds = chatCharacterIds.filter((id) => id !== charId);
    setChatCharacterIds(newIds);
    await api.chatUpdateCharacters(activeChat.id, newIds);
  }

  // Next turn for a specific character (multi-char)
  async function handleNextTurn(characterName: string) {
    if (!activeChat || streaming) return;
    setErrorText("");
    setStreamText("");
    setStreaming(true);
    try {
      const updated = await api.chatNextTurn(activeChat.id, characterName, undefined, {
        onDelta: (delta) => setStreamText((prev) => prev + delta),
        onDone: () => { setStreaming(false); setStreamText(""); }
      }, false, activePersona?.name);
      setMessages(updated);
    } catch (error) {
      setStreaming(false);
      setStreamText("");
      setErrorText(String(error));
    }
  }

  // Auto-conversation: characters take turns automatically
  async function startAutoConversation() {
    if (!activeChat || chatCharacterIds.length < 2) return;
    autoConvoRef.current = true;
    setAutoConvoRunning(true);

    const charNames = chatCharacterIds
      .map((id) => characters.find((c) => c.id === id))
      .filter((c): c is CharacterDetail => c !== null)
      .map((c) => c.name);

    if (charNames.length < 2) { setAutoConvoRunning(false); return; }

    for (let turn = 0; turn < autoTurnsCount; turn++) {
      if (!autoConvoRef.current) break;

      const charName = charNames[turn % charNames.length];
      setStreamText("");
      setStreaming(true);

      try {
        const updated = await api.chatNextTurn(activeChat.id, charName, undefined, {
          onDelta: (delta) => setStreamText((prev) => prev + delta),
          onDone: () => { setStreaming(false); setStreamText(""); }
        }, true, activePersona?.name); // isAutoConvo = true
        setMessages(updated);
      } catch (error) {
        setErrorText(String(error));
        break;
      }

      if (autoConvoRef.current && turn < autoTurnsCount - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    autoConvoRef.current = false;
    setAutoConvoRunning(false);
    setStreaming(false);
  }

  function stopAutoConversation() {
    autoConvoRef.current = false;
    setAutoConvoRunning(false);
    if (activeChat) {
      api.chatAbort(activeChat.id).catch(() => {});
    }
  }

  function moveBlock(dragId: string, dropId: string) {
    const next = [...orderedBlocks];
    const from = next.findIndex((b) => b.id === dragId);
    const to = next.findIndex((b) => b.id === dropId);
    if (from < 0 || to < 0 || from === to) return;
    const [removed] = next.splice(from, 1);
    next.splice(to, 0, removed);
    const reordered = next.map((block, index) => ({ ...block, order: index + 1 }));
    setBlocks(reordered);
    if (activeChat) saveBlocksToServer(activeChat.id, reordered);
  }

  function toggleBlock(blockId: string) {
    const updated = blocks.map((b) => b.id === blockId ? { ...b, enabled: !b.enabled } : b);
    setBlocks(updated);
    if (activeChat) saveBlocksToServer(activeChat.id, updated);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  function toggleSection(key: string) {
    setInspectorSection((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // Get character info for message display
  const chatCharacters = useMemo(() => {
    return chatCharacterIds
      .map((id) => characters.find((c) => c.id === id))
      .filter((c): c is CharacterDetail => c !== null);
  }, [chatCharacterIds, characters]);

  const activeChatCharacter = useMemo(() => {
    if (!activeChat?.characterId && chatCharacterIds.length === 0) return null;
    const primaryId = chatCharacterIds[0] || activeChat?.characterId;
    return primaryId ? characters.find((c) => c.id === primaryId) ?? null : null;
  }, [activeChat, chatCharacterIds, characters]);

  function getCharacterForMessage(msg: ChatMessage): CharacterDetail | null {
    if (msg.characterName) {
      return chatCharacters.find((c) => c.name === msg.characterName) ?? null;
    }
    return activeChatCharacter;
  }

  // Persona helpers
  async function savePersona() {
    if (!editingPersona) return;
    if (editingPersona.id) {
      const updated = await api.personaUpdate(editingPersona.id, editingPersona);
      setPersonas((prev) => prev.map((p) => p.id === updated.id ? updated : p));
      if (activePersona?.id === updated.id) setActivePersona(updated);
    } else {
      const created = await api.personaCreate(editingPersona);
      setPersonas((prev) => [...prev, created]);
      setActivePersona(created);
    }
    setEditingPersona(null);
  }

  async function deletePersona(id: string) {
    await api.personaDelete(id);
    setPersonas((prev) => prev.filter((p) => p.id !== id));
    if (activePersona?.id === id) setActivePersona(null);
    setEditingPersona(null);
  }

  return (
    <>
      {/* Persona Modal */}
      {showPersonaModal && (
        <div className="overlay-animate fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => { setShowPersonaModal(false); setEditingPersona(null); }}>
          <div className="modal-pop w-full max-w-lg rounded-xl border border-border bg-bg-secondary p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-text-primary">{t("chat.personas")}</h2>
              <button onClick={() => { setShowPersonaModal(false); setEditingPersona(null); }}
                className="rounded-md p-1 text-text-tertiary hover:bg-bg-hover hover:text-text-primary">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {editingPersona ? (
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">{t("chat.personaName")}</label>
                  <input value={editingPersona.name} onChange={(e) => setEditingPersona({ ...editingPersona, name: e.target.value })}
                    className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">{t("chat.personaDesc")}</label>
                  <textarea value={editingPersona.description} onChange={(e) => setEditingPersona({ ...editingPersona, description: e.target.value })}
                    className="h-20 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">{t("chat.personaPersonality")}</label>
                  <textarea value={editingPersona.personality} onChange={(e) => setEditingPersona({ ...editingPersona, personality: e.target.value })}
                    className="h-20 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
                </div>
                <div className="flex gap-2 pt-2">
                  <button onClick={savePersona}
                    className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-text-inverse hover:bg-accent-hover">
                    {t("chat.save")}
                  </button>
                  <button onClick={() => setEditingPersona(null)}
                    className="rounded-lg border border-border px-4 py-2 text-xs text-text-secondary hover:bg-bg-hover">
                    {t("chat.cancel")}
                  </button>
                  {editingPersona.id && (
                    <button onClick={() => deletePersona(editingPersona.id)}
                      className="ml-auto rounded-lg px-4 py-2 text-xs text-danger/70 hover:bg-danger-subtle hover:text-danger">
                      {t("chat.deletePersona")}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {personas.map((p) => (
                  <div key={p.id} className={`flex items-center justify-between rounded-lg border px-3 py-2 ${
                    activePersona?.id === p.id ? "border-accent bg-accent-subtle" : "border-border bg-bg-primary"
                  }`}>
                    <button onClick={() => { setActivePersona(p); setShowPersonaModal(false); }}
                      className="flex-1 text-left">
                      <div className="text-sm font-medium text-text-primary">
                        {p.name} {p.isDefault && <span className="text-[10px] text-accent">★ {t("chat.default")}</span>}
                      </div>
                      {p.description && <div className="mt-0.5 truncate text-xs text-text-tertiary">{p.description}</div>}
                    </button>
                    <div className="ml-2 flex gap-1">
                      {!p.isDefault && (
                        <button onClick={async () => {
                          await api.personaSetDefault(p.id);
                          setPersonas((prev) => prev.map((x) => ({ ...x, isDefault: x.id === p.id })));
                        }}
                          className="rounded-md px-2 py-1 text-[10px] text-text-tertiary hover:bg-bg-hover hover:text-accent">
                          {t("chat.setDefault")}
                        </button>
                      )}
                      <button onClick={() => setEditingPersona(p)}
                        className="rounded-md px-2 py-1 text-[10px] text-text-tertiary hover:bg-bg-hover hover:text-text-secondary">
                        {t("chat.edit")}
                      </button>
                    </div>
                  </div>
                ))}
                <button onClick={() => setEditingPersona({ id: "", name: "", description: "", personality: "", scenario: "", isDefault: false, createdAt: "" })}
                  className="w-full rounded-lg border border-dashed border-border px-3 py-2 text-xs text-text-tertiary hover:bg-bg-hover hover:text-text-secondary">
                  + {t("chat.newPersona")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <ThreePanelLayout
        left={
          <>
            <PanelTitle
              action={
                <div className="flex gap-1">
                  <button onClick={() => setShowMultiCharPanel(!showMultiCharPanel)}
                    className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-hover"
                    title={t("chat.multiChar")}>
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                  </button>
                  <button onClick={() => setShowCharacterPicker(true)}
                    className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-hover"
                    title={t("chat.pickCharacter")}>
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </button>
                  <button onClick={() => handleCreateChat()}
                    className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-[11px] font-semibold text-text-inverse hover:bg-accent-hover">
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    {t("chat.new")}
                  </button>
                </div>
              }
            >
              {t("chat.title")}
            </PanelTitle>

            {showCharacterPicker && (
              <div className="mb-3 rounded-lg border border-accent-border bg-bg-primary p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{t("chat.pickCharacter")}</span>
                  <button onClick={() => setShowCharacterPicker(false)} className="text-text-tertiary hover:text-text-primary">
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                {characters.length === 0 ? (
                  <p className="text-xs text-text-tertiary">{t("chat.noCharacters")}</p>
                ) : (
                  <div className="max-h-48 space-y-1 overflow-y-auto">
                    {characters.map((char) => (
                      <button key={char.id}
                        onClick={() => handleCreateChat(char.id)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-bg-hover">
                        {char.avatarUrl ? (
                          <img src={char.avatarUrl.startsWith("http") ? char.avatarUrl : `http://localhost:3001${char.avatarUrl}`}
                            alt={char.name} className="h-6 w-6 rounded-full object-cover" />
                        ) : (
                          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-subtle text-[10px] font-bold text-accent">
                            {char.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <span className="truncate text-xs font-medium text-text-primary">{char.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                <button onClick={() => handleCreateChat()}
                  className="mt-2 w-full rounded-md border border-border px-2 py-1 text-[11px] text-text-secondary hover:bg-bg-hover">
                  {t("chat.noCharacter")}
                </button>
              </div>
            )}

            {/* Multi-character panel */}
            {showMultiCharPanel && (
              <div className="mb-3 rounded-lg border border-purple-500/30 bg-purple-500/5 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-purple-400">{t("chat.multiChar")}</span>
                  <button onClick={() => setShowMultiCharPanel(false)} className="text-text-tertiary hover:text-text-primary">
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                {chatCharacterIds.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {chatCharacterIds.map((cid) => {
                      const ch = characters.find((c) => c.id === cid);
                      if (!ch) return null;
                      return (
                        <div key={cid} className="flex items-center justify-between rounded-md bg-bg-secondary px-2 py-1">
                          <span className="text-xs text-text-primary">{ch.name}</span>
                          <button onClick={() => removeCharacterFromChat(cid)}
                            className="text-[10px] text-danger/60 hover:text-danger">{t("chat.removeCharacter")}</button>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="max-h-32 space-y-1 overflow-y-auto">
                  {characters.filter((c) => !chatCharacterIds.includes(c.id)).map((char) => (
                    <button key={char.id} onClick={() => addCharacterToChat(char.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-text-secondary hover:bg-bg-hover">
                      <span>+</span>
                      <span>{char.name}</span>
                    </button>
                  ))}
                </div>

                {chatCharacterIds.length >= 2 && (
                  <button onClick={() => {
                    const multiIds = [...chatCharacterIds];
                    setShowMultiCharPanel(false);
                    handleCreateChat(multiIds[0], multiIds);
                  }}
                    className="mt-2 w-full rounded-md bg-purple-500/20 px-2 py-1.5 text-[11px] font-medium text-purple-300 hover:bg-purple-500/30">
                    Create Multi-Char Chat ({chatCharacterIds.length})
                  </button>
                )}
              </div>
            )}

            <div className="flex-1 space-y-1 overflow-y-auto">
              {chats.length === 0 ? (
                <EmptyState title={t("chat.noChatYet")} description={t("chat.noChatDesc")} />
              ) : (
                chats.map((chat) => {
                  const chatChar = chat.characterId ? characters.find((c) => c.id === chat.characterId) : null;
                  const multiCount = chat.characterIds?.length || 0;
                  return (
                    <div key={chat.id}
                      className={`group relative flex items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
                        activeChat?.id === chat.id ? "bg-accent-subtle text-text-primary" : "text-text-secondary hover:bg-bg-hover"
                      }`}>
                      <button onClick={() => setActiveChat(chat)} className="flex flex-1 items-center gap-2 text-left">
                        {chatChar?.avatarUrl ? (
                          <img src={chatChar.avatarUrl.startsWith("http") ? chatChar.avatarUrl : `http://localhost:3001${chatChar.avatarUrl}`}
                            alt="" className="h-6 w-6 flex-shrink-0 rounded-full object-cover" />
                        ) : chatChar ? (
                          <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-accent-subtle text-[9px] font-bold text-accent">
                            {chatChar.name.charAt(0).toUpperCase()}
                          </div>
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{chat.title}</div>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            <span className="text-[11px] text-text-tertiary">{new Date(chat.createdAt).toLocaleTimeString()}</span>
                            {multiCount > 1 && <Badge>{multiCount} chars</Badge>}
                          </div>
                        </div>
                      </button>
                      {/* Delete button */}
                      <button onClick={(e) => { e.stopPropagation(); if (confirm(t("chat.confirmDeleteChat"))) handleDeleteChat(chat.id); }}
                        className="flex-shrink-0 rounded-md p-1 text-text-tertiary opacity-0 transition-opacity hover:bg-danger-subtle hover:text-danger group-hover:opacity-100"
                        title={t("chat.deleteChat")}>
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            {/* RP Presets — collapsible */}
            <div className="mt-3 rounded-lg border border-border-subtle bg-bg-primary p-3">
              <button onClick={() => setPresetsCollapsed(!presetsCollapsed)}
                className="flex w-full items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{t("chat.rpPresets")}</span>
                <svg className={`h-3 w-3 text-text-tertiary transition-transform ${presetsCollapsed ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {!presetsCollapsed && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {RP_PRESETS.map((preset) => (
                    <button key={preset} onClick={() => applyPreset(preset)}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors ${
                        activePreset === preset
                          ? "bg-accent text-text-inverse"
                          : "bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                      }`}>
                      {t(`preset.${preset}` as keyof typeof import("../../shared/i18n").translations.en)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* User Persona — compact, opens modal */}
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-primary px-3 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{t("chat.userPersona")}:</span>
              <span className="flex-1 truncate text-xs font-medium text-text-primary">{activePersona?.name || "User"}</span>
              <button onClick={() => setShowPersonaModal(true)}
                className="rounded-md border border-border px-2 py-0.5 text-[10px] text-text-tertiary hover:bg-bg-hover hover:text-text-secondary">
                {t("chat.edit")}
              </button>
            </div>
          </>
        }
        center={
          <>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <PanelTitle>{activeChat ? activeChat.title : t("tab.chat")}</PanelTitle>
                {totalTokens > 0 && <Badge>{totalTokens.toLocaleString()} tok</Badge>}
              </div>
              <div className="flex gap-1.5">
                {streaming && (
                  <button onClick={handleAbort}
                    className="rounded-md border border-danger-border bg-danger-subtle px-2.5 py-1 text-[11px] font-medium text-danger hover:bg-danger/20">
                    {t("chat.stop")}
                  </button>
                )}
                <button onClick={handleRegenerate}
                  disabled={streaming || !activeChat || messages.length === 0}
                  className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-40">
                  {t("chat.regenerate")}
                </button>
                <button onClick={handleCompress}
                  disabled={compressing || streaming || !activeChat || messages.length < 4}
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    compressing
                      ? "border-accent bg-accent-subtle text-accent"
                      : "border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  } disabled:cursor-not-allowed disabled:opacity-40`}>
                  {compressing ? t("chat.compressing") : t("chat.compress")}
                </button>
              </div>
            </div>

            {/* Model selector bar */}
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-primary px-3 py-2">
              {activeModelLabel ? (
                <>
                  <div className="h-1.5 w-1.5 rounded-full bg-success" />
                  <span className="text-xs text-text-secondary">{t("chat.model")}: <span className="font-medium text-text-primary">{activeModelLabel}</span></span>
                </>
              ) : (
                <>
                  <svg className="h-3.5 w-3.5 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                  <span className="text-xs text-warning">{t("chat.noModel")}</span>
                </>
              )}
              <button onClick={() => setShowModelSelector(!showModelSelector)}
                className="ml-auto rounded-md border border-border px-2 py-0.5 text-[10px] font-medium text-text-secondary hover:bg-bg-hover">
                {t("chat.selectModel")}
              </button>
            </div>

            {/* Inline model selector */}
            {showModelSelector && (
              <div className="mb-3 rounded-lg border border-accent-border bg-bg-secondary p-3">
                <div className="flex gap-2">
                  <select value={chatProviderId} onChange={(e) => setChatProviderId(e.target.value)}
                    className="flex-1 rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary">
                    <option value="">{t("settings.selectProvider")}</option>
                    {providers.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                  </select>
                  {loadingModels && <span className="flex items-center text-[10px] text-text-tertiary">Loading...</span>}
                </div>
                <div className="mt-2 flex gap-2">
                  <select value={chatModelId} onChange={(e) => setChatModelId(e.target.value)}
                    className="flex-1 rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary">
                    <option value="">{t("settings.selectModel")}</option>
                    {models.map((m) => (<option key={m.id} value={m.id}>{m.id}</option>))}
                  </select>
                  <button onClick={applyModelFromChat}
                    className="rounded-md bg-accent px-3 py-1 text-[10px] font-semibold text-text-inverse hover:bg-accent-hover">
                    OK
                  </button>
                </div>
              </div>
            )}

            {errorText && (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-danger-border bg-danger-subtle px-3 py-2">
                <span className="text-xs text-danger">{errorText}</span>
                <button onClick={() => setErrorText("")} className="ml-auto text-danger hover:text-danger/80">
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}

            {/* Multi-character bar */}
            {chatCharacters.length > 0 && (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-purple-500/20 bg-purple-500/5 px-3 py-2">
                <div className="flex items-center gap-1.5">
                  {chatCharacters.map((ch) => (
                    <div key={ch.id} className="flex items-center gap-1">
                      {ch.avatarUrl ? (
                        <img src={ch.avatarUrl.startsWith("http") ? ch.avatarUrl : `http://localhost:3001${ch.avatarUrl}`}
                          alt="" className="h-5 w-5 rounded-full object-cover" />
                      ) : (
                        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-purple-500/20 text-[9px] font-bold text-purple-400">
                          {ch.name.charAt(0).toUpperCase()}
                        </div>
                      )}
                      {chatCharacters.length > 1 && (
                        <button onClick={() => handleNextTurn(ch.name)} disabled={streaming}
                          className="rounded px-1.5 py-0.5 text-[9px] font-medium text-purple-400 hover:bg-purple-500/20 disabled:opacity-40"
                          title={`${t("chat.nextTurn")}: ${ch.name}`}>
                          {ch.name}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {chatCharacters.length > 1 && (
                  <div className="ml-auto flex items-center gap-1.5">
                    <input type="number" min={1} max={50} value={autoTurnsCount}
                      onChange={(e) => setAutoTurnsCount(Number(e.target.value))}
                      className="w-12 rounded border border-border bg-bg-primary px-1 py-0.5 text-center text-[10px] text-text-primary" />
                    <span className="text-[9px] text-text-tertiary">{t("chat.turns")}</span>
                    {autoConvoRunning ? (
                      <button onClick={stopAutoConversation}
                        className="rounded-md border border-danger-border bg-danger-subtle px-2 py-0.5 text-[10px] font-medium text-danger">
                        {t("chat.autoConvoStop")}
                      </button>
                    ) : (
                      <button onClick={startAutoConversation} disabled={streaming}
                        className="rounded-md bg-purple-500/20 px-2 py-0.5 text-[10px] font-medium text-purple-300 hover:bg-purple-500/30 disabled:opacity-40">
                        {t("chat.autoConvoStart")}
                      </button>
                    )}
                  </div>
                )}
                {chatCharacters.length === 1 && (
                  <span className="text-xs text-text-secondary">
                    {t("chat.chattingWith")} <span className="font-medium text-purple-400">{chatCharacters[0].name}</span>
                  </span>
                )}
              </div>
            )}

            <div className="chat-scroll flex-1 space-y-1.5 overflow-y-auto rounded-lg border border-border-subtle bg-bg-primary p-3">
              {messages.length === 0 && !streaming && (
                <EmptyState title={t("chat.startConvo")} description={t("chat.startConvoDesc")} />
              )}

              {messages.map((msg) => {
                const msgChar = msg.role === "assistant" ? getCharacterForMessage(msg) : null;
                return (
                  <article key={msg.id}
                    className={`chat-message group max-w-[88%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "chat-message-user ml-auto bg-accent-subtle text-text-primary"
                        : "chat-message-assistant mr-auto border border-border-subtle bg-bg-secondary text-text-primary"
                    }`}>
                    <div className="mb-1.5 flex items-center gap-2">
                      {msgChar ? (
                        <>
                          {msgChar.avatarUrl ? (
                            <img src={msgChar.avatarUrl.startsWith("http") ? msgChar.avatarUrl : `http://localhost:3001${msgChar.avatarUrl}`}
                              alt="" className="h-4 w-4 rounded-full object-cover" />
                          ) : null}
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-400">{msg.characterName || msgChar.name}</span>
                        </>
                      ) : msg.role === "user" && msg.characterName ? (
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-accent">{msg.characterName}</span>
                      ) : (
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{msg.role === "user" ? (activePersona?.name || "user") : msg.role}</span>
                      )}
                      {msg.tokenCount > 0 && <Badge>{msg.tokenCount} tok</Badge>}
                    </div>

                    {editingId === msg.id ? (
                      <div>
                        <textarea value={editingValue} onChange={(e) => setEditingValue(e.target.value)}
                          className="h-28 w-full rounded-lg border border-border bg-bg-primary p-3 text-sm text-text-primary" />
                        <div className="mt-2 flex gap-2">
                          <button onClick={() => saveEdit(msg.id)}
                            className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-text-inverse hover:bg-accent-hover">{t("chat.save")}</button>
                          <button onClick={() => setEditingId(null)}
                            className="rounded-md border border-border px-3 py-1 text-xs text-text-secondary hover:bg-bg-hover">{t("chat.cancel")}</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="prose-chat" dangerouslySetInnerHTML={{
                          __html: renderContent(
                            inPlaceTranslations[msg.id] || msg.content,
                            activeChatCharacter?.name,
                            activePersona?.name || "User"
                          )
                        }} />
                        {inPlaceTranslations[msg.id] && (
                          <button onClick={() => setInPlaceTranslations((prev) => { const n = { ...prev }; delete n[msg.id]; return n; })}
                            className="mt-1 text-[10px] text-accent hover:underline">{t("chat.showOriginal")}</button>
                        )}
                        {translatedTexts[msg.id] && (
                          <div className="mt-2 rounded-md border border-border-subtle bg-bg-tertiary p-2">
                            <span className="mb-1 block text-[10px] font-semibold uppercase text-text-tertiary">{t("chat.translate")}</span>
                            <div className="prose-chat text-xs text-text-secondary" dangerouslySetInnerHTML={{
                              __html: renderContent(translatedTexts[msg.id], activeChatCharacter?.name, activePersona?.name || "User")
                            }} />
                          </div>
                        )}
                      </>
                    )}

                    {!msg.id.startsWith("temp-") && (
                      <div className="message-actions mt-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <button onClick={() => handleFork(msg)}
                          className="rounded-md px-2 py-0.5 text-[11px] text-text-tertiary hover:bg-bg-hover hover:text-text-secondary">{t("chat.fork")}</button>
                        <button onClick={() => { setEditingId(msg.id); setEditingValue(msg.content); }}
                          className="rounded-md px-2 py-0.5 text-[11px] text-text-tertiary hover:bg-bg-hover hover:text-text-secondary">{t("chat.edit")}</button>
                        <button onClick={() => handleTranslate(msg.id, false)}
                          disabled={translatingId === msg.id}
                          className="rounded-md px-2 py-0.5 text-[11px] text-text-tertiary hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50"
                          title={t("chat.translateSide")}>
                          {translatingId === msg.id ? t("chat.translating") : t("chat.translate")}
                        </button>
                        <button onClick={() => handleTranslate(msg.id, true)}
                          disabled={translatingId === msg.id}
                          className="rounded-md px-2 py-0.5 text-[11px] text-text-tertiary hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50"
                          title={t("chat.translateInPlace")}>
                          {t("chat.translateReplace")}
                        </button>
                        <button onClick={() => handleDelete(msg.id)}
                          className="rounded-md px-2 py-0.5 text-[11px] text-danger/60 hover:bg-danger-subtle hover:text-danger">{t("chat.delete")}</button>
                      </div>
                    )}
                  </article>
                );
              })}

              {streaming && (
                <article className="chat-message chat-streaming mr-auto max-w-[88%] rounded-xl border border-accent-border bg-bg-secondary px-4 py-3 text-sm text-text-primary">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-accent">{activeChatCharacter?.name ?? "assistant"}</span>
                    <span className="flex items-center gap-1">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                      <span className="text-[10px] text-accent">{t("chat.streaming")}</span>
                    </span>
                  </div>
                  <div className="prose-chat" dangerouslySetInnerHTML={{
                    __html: streamText ? renderContent(streamText, activeChatCharacter?.name, activePersona?.name || "User") : "..."
                  }} />
                </article>
              )}

              <div ref={messagesEndRef} />
            </div>

            {attachments.length > 0 && (
              <div className="list-animate mt-2 flex flex-wrap gap-1.5">
                {attachments.map((att) => (
                  <div key={att.id} className="float-card flex items-center gap-1.5 rounded-md border border-border bg-bg-primary px-2 py-1">
                    {att.type === "image" ? (
                      <img src={`http://localhost:3001${att.url}`} alt="" className="h-6 w-6 rounded object-cover" />
                    ) : (
                      <svg className="h-3.5 w-3.5 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    )}
                    <span className="max-w-[100px] truncate text-[10px] text-text-secondary">{att.filename}</span>
                    <button onClick={() => removeAttachment(att.id)} className="text-text-tertiary hover:text-danger">
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-2 flex gap-2">
              <div className="relative flex-1">
                <textarea ref={textareaRef} value={input} onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="h-[80px] w-full resize-none rounded-xl border border-border bg-bg-primary px-4 py-2.5 pr-10 text-sm text-text-primary placeholder:text-text-tertiary"
                  placeholder={t("chat.placeholder")} />
                <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
                  className="absolute bottom-2 right-2 rounded-md p-1 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
                  title={t("chat.attachFile")}>
                  {uploading ? (
                    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                  )}
                </button>
                <input ref={fileInputRef} type="file" multiple onChange={handleFileUpload} className="hidden"
                  accept="image/*,.txt,.md,.json,.csv,.log,.xml,.html,.js,.ts,.py,.rb,.yaml,.yml" />
              </div>
              <button onClick={streaming ? handleAbort : (input.trim() ? handleSend : handleRegenerate)}
                disabled={!streaming && !input.trim() && (messages.length === 0 || messages[messages.length - 1]?.role !== "user")}
                className={`flex h-[80px] w-[80px] flex-col items-center justify-center rounded-xl text-text-inverse ${
                  streaming
                    ? "bg-danger hover:bg-danger/80"
                    : "bg-accent hover:bg-accent-hover disabled:opacity-40"
                }`}>
                {streaming ? (
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                ) : (
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-7 7m7-7l7 7" />
                  </svg>
                )}
                <span className="mt-1 text-[10px] font-semibold">{streaming ? t("chat.stop") : (input.trim() ? t("chat.send") : t("chat.resend"))}</span>
              </button>
            </div>
          </>
        }
        right={
          <div className="flex h-full flex-col gap-3 overflow-y-auto">
            <PanelTitle>{t("inspector.title")}</PanelTitle>

            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{t("inspector.authorNote")}</label>
              <textarea value={authorNote} onChange={(e) => setAuthorNote(e.target.value)}
                className="h-20 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary" />
            </div>

            {/* Scene section */}
            <div>
              <button onClick={() => toggleSection("scene")}
                className="mb-1.5 flex w-full items-center justify-between text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                {t("inspector.sceneState")}
                <svg className={`h-3 w-3 transition-transform ${inspectorSection.scene ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {inspectorSection.scene && (
                <div className="space-y-2">
                  <div>
                    <label className="mb-1 block text-[10px] text-text-tertiary">{t("inspector.mood")}</label>
                    <input value={sceneState.mood}
                      onChange={(e) => setSceneState((prev) => ({ ...prev, mood: e.target.value }))}
                      className="w-full rounded-md border border-border bg-bg-primary px-2.5 py-1.5 text-xs text-text-primary" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] text-text-tertiary">{t("inspector.pacing")}</label>
                    <select value={sceneState.pacing}
                      onChange={(e) => setSceneState((prev) => ({ ...prev, pacing: e.target.value as "slow" | "balanced" | "fast" }))}
                      className="w-full rounded-md border border-border bg-bg-primary px-2.5 py-1.5 text-xs text-text-primary">
                      <option value="slow">{t("inspector.slow")}</option>
                      <option value="balanced">{t("inspector.balanced")}</option>
                      <option value="fast">{t("inspector.fast")}</option>
                    </select>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <label className="text-[10px] text-text-tertiary">{t("inspector.intensity")}</label>
                      <span className="text-[10px] font-medium text-text-secondary">{Math.round(sceneState.intensity * 100)}%</span>
                    </div>
                    <input type="range" min={0} max={1} step={0.05} value={sceneState.intensity}
                      onChange={(e) => setSceneState((prev) => ({ ...prev, intensity: Number(e.target.value) }))}
                      className="w-full" />
                  </div>
                </div>
              )}
            </div>

            {/* Sampler section — auto-saves */}
            <div>
              <button onClick={() => toggleSection("sampler")}
                className="mb-1.5 flex w-full items-center justify-between text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                <span className="flex items-center gap-1.5">
                  {t("inspector.sampler")}
                  {samplerSaved && <span className="text-[9px] font-normal text-success">({t("chat.samplerSaved")})</span>}
                </span>
                <svg className={`h-3 w-3 transition-transform ${inspectorSection.sampler ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {inspectorSection.sampler && (
                <div className="space-y-2 rounded-lg border border-border-subtle bg-bg-primary p-2">
                  {[
                    { key: "temperature" as const, label: t("inspector.temperature"), min: 0, max: 2 },
                    { key: "topP" as const, label: t("inspector.topP"), min: 0, max: 1 },
                    { key: "frequencyPenalty" as const, label: t("inspector.freqPenalty"), min: 0, max: 2 },
                    { key: "presencePenalty" as const, label: t("inspector.presPenalty"), min: 0, max: 2 }
                  ].map(({ key, label, min, max }) => (
                    <div key={key}>
                      <div className="mb-1 flex items-center justify-between">
                        <label className="text-[10px] text-text-tertiary">{label}</label>
                        <span className="text-[10px] font-medium text-text-secondary">{samplerConfig[key].toFixed(2)}</span>
                      </div>
                      <input type="range" min={min} max={max} step={0.05} value={samplerConfig[key]}
                        onChange={(e) => setSamplerConfig((p) => ({ ...p, [key]: Number(e.target.value) }))} className="w-full" />
                    </div>
                  ))}
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <label className="text-[10px] text-text-tertiary">{t("inspector.maxTokens")}</label>
                      <input type="number" value={samplerConfig.maxTokens}
                        onChange={(e) => setSamplerConfig((p) => ({ ...p, maxTokens: Number(e.target.value) }))}
                        className="w-20 rounded border border-border bg-bg-primary px-1.5 py-0.5 text-right text-[10px] text-text-primary" />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Prompt Stack section */}
            <div>
              <button onClick={() => toggleSection("blocks")}
                className="mb-1.5 flex w-full items-center justify-between text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                {t("inspector.promptStack")}
                <svg className={`h-3 w-3 transition-transform ${inspectorSection.blocks ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {inspectorSection.blocks && (
                <div className="space-y-1 rounded-lg border border-border-subtle bg-bg-primary p-2">
                  {orderedBlocks.map((block) => (
                    <div key={block.id} draggable
                      onDragStart={() => setDraggedBlockId(block.id)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => { if (!draggedBlockId) return; moveBlock(draggedBlockId, block.id); setDraggedBlockId(null); }}
                      className={`flex cursor-grab items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px] font-medium active:cursor-grabbing ${
                        block.enabled ? "text-text-secondary" : "text-text-tertiary opacity-50"
                      } ${BLOCK_COLORS[block.kind] ?? "border-border bg-bg-tertiary"}`}>
                      <button onClick={() => toggleBlock(block.id)} className="flex-shrink-0" title={block.enabled ? "Disable" : "Enable"}>
                        {block.enabled ? (
                          <svg className="h-3 w-3 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          <svg className="h-3 w-3 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        )}
                      </button>
                      <svg className="h-3 w-3 flex-shrink-0 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 8h16M4 16h16" />
                      </svg>
                      <span className="capitalize">{block.kind.replace("_", " ")}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Compressed Context section */}
            {contextSummary && (
              <div>
                <button onClick={() => toggleSection("context")}
                  className="mb-1.5 flex w-full items-center justify-between text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                  {t("inspector.compressedContext")}
                  <svg className={`h-3 w-3 transition-transform ${inspectorSection.context ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {inspectorSection.context && (
                  <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-lg border border-border-subtle bg-bg-primary p-3 font-mono text-[11px] text-text-secondary">
                    {contextSummary}
                  </pre>
                )}
              </div>
            )}
          </div>
        }
      />
    </>
  );
}
