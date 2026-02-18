import type {
  AppSettings,
  BookProject,
  BranchNode,
  Chapter,
  CharacterDetail,
  CharacterListItem,
  ChatMessage,
  ChatSession,
  ConsistencyIssue,
  FileAttachment,
  PromptBlock,
  ProviderModel,
  ProviderProfile,
  RpSceneState,
  Scene,
  SamplerConfig,
  UserPersona
} from "./types/contracts";

const BASE = import.meta.env.DEV ? "http://localhost:3001/api" : "/api";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

async function get<T>(path: string): Promise<T> {
  return request<T>("GET", path);
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("POST", path, body);
}

async function patchReq<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("PATCH", path, body);
}

async function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("PUT", path, body);
}

async function del<T>(path: string): Promise<T> {
  return request<T>("DELETE", path);
}

export type StreamCallbacks = {
  onDelta?: (delta: string) => void;
  onDone?: () => void;
};

async function streamPost(
  path: string,
  body: unknown,
  callbacks: StreamCallbacks
): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let doneEmitted = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const parsed = JSON.parse(trimmed.slice(6)) as { type: string; delta?: string };
          if (parsed.type === "delta" && parsed.delta) {
            callbacks.onDelta?.(parsed.delta);
          } else if (parsed.type === "done") {
            doneEmitted = true;
            callbacks.onDone?.();
          }
        } catch { /* skip */ }
      }
    }

    if (!doneEmitted) callbacks.onDone?.();
  } else {
    callbacks.onDone?.();
  }
}

export const api = {
  // --- Account ---
  accountCreate: (password: string, recoveryKey?: string) =>
    post<string>("/account/create", { password, recoveryKey }),

  accountUnlock: (password: string, recoveryKey?: string) =>
    post<boolean>("/account/unlock", { password, recoveryKey }),

  // --- Settings ---
  settingsGet: () => get<AppSettings>("/settings"),
  settingsUpdate: (patchData: Partial<AppSettings>) => patchReq<AppSettings>("/settings", patchData),
  settingsReset: () => post<AppSettings>("/settings/reset"),

  // --- Providers ---
  providerUpsert: (profile: Omit<ProviderProfile, "apiKeyMasked"> & { apiKey: string }) =>
    post<ProviderProfile>("/providers", profile),
  providerList: () => get<ProviderProfile[]>("/providers"),
  providerFetchModels: (providerId: string) => get<ProviderModel[]>(`/providers/${providerId}/models`),
  providerSetActive: (providerId: string, modelId: string) =>
    post<AppSettings>("/providers/set-active", { providerId, modelId }),
  providerTestConnection: (providerId: string) => post<boolean>(`/providers/${providerId}/test`),

  // --- Chats ---
  chatCreate: (title: string, characterId?: string, characterIds?: string[]) =>
    post<ChatSession>("/chats", { title, characterId, characterIds }),
  chatAbort: (chatId: string) => post<{ ok: boolean; interrupted: boolean }>(`/chats/${chatId}/abort`),
  chatDelete: (chatId: string) => del<{ ok: boolean }>(`/chats/${chatId}`),
  chatUpdateCharacters: (chatId: string, characterIds: string[]) =>
    patchReq<{ ok: boolean }>(`/chats/${chatId}/characters`, { characterIds }),
  chatNextTurn: async (chatId: string, characterName: string, branchId?: string, callbacks?: StreamCallbacks, isAutoConvo?: boolean, userName?: string): Promise<ChatMessage[]> => {
    if (callbacks) {
      await streamPost(`/chats/${chatId}/next-turn`, { characterName, branchId, isAutoConvo, userName }, callbacks);
      return api.chatTimeline(chatId, branchId);
    }
    return post<ChatMessage[]>(`/chats/${chatId}/next-turn`, { characterName, branchId, isAutoConvo, userName });
  },
  chatList: () => get<ChatSession[]>("/chats"),
  chatTimeline: (chatId: string, branchId?: string) =>
    get<ChatMessage[]>(`/chats/${chatId}/timeline${branchId ? `?branchId=${branchId}` : ""}`),

  chatSend: async (
    chatId: string,
    content: string,
    branchId?: string,
    callbacks?: StreamCallbacks,
    userName?: string
  ): Promise<ChatMessage[]> => {
    if (callbacks) {
      await streamPost(`/chats/${chatId}/send`, { content, branchId, userName }, callbacks);
      return api.chatTimeline(chatId, branchId);
    }
    return post<ChatMessage[]>(`/chats/${chatId}/send`, { content, branchId, userName });
  },

  chatRegenerate: async (chatId: string, branchId?: string, callbacks?: StreamCallbacks): Promise<ChatMessage[]> => {
    if (callbacks) {
      await streamPost(`/chats/${chatId}/regenerate`, { branchId }, callbacks);
      return api.chatTimeline(chatId, branchId);
    }
    return post<ChatMessage[]>(`/chats/${chatId}/regenerate`, { branchId });
  },

  chatCompressContext: (chatId: string, branchId?: string) =>
    post<{ summary: string }>(`/chats/${chatId}/compress`, { branchId }),

  chatFork: (chatId: string, parentMessageId: string, name: string) =>
    post<BranchNode>(`/chats/${chatId}/fork`, { parentMessageId, name }),
  chatEditMessage: (messageId: string, content: string) =>
    patchReq<{ ok: boolean; timeline: ChatMessage[] }>(`/messages/${messageId}`, { content }),
  chatDeleteMessage: (messageId: string) =>
    del<{ ok: boolean; timeline: ChatMessage[] }>(`/messages/${messageId}`),
  chatTranslateMessage: (messageId: string, targetLanguage?: string) =>
    post<{ translation: string }>(`/chats/messages/${messageId}/translate`, { targetLanguage }),
  chatSaveSampler: (chatId: string, samplerConfig: SamplerConfig) =>
    patchReq<{ ok: boolean }>(`/chats/${chatId}/sampler`, { samplerConfig }),
  chatGetSampler: (chatId: string) =>
    get<SamplerConfig | null>(`/chats/${chatId}/sampler`),
  chatSavePreset: (chatId: string, presetId: string | null) =>
    patchReq<{ ok: boolean }>(`/chats/${chatId}/preset`, { presetId }),

  // --- RP ---
  rpSetSceneState: (state: RpSceneState) => post<void>("/rp/scene-state", state),
  rpUpdateAuthorNote: (chatId: string, authorNote: string) =>
    post<void>("/rp/author-note", { chatId, authorNote }),
  rpApplyStylePreset: (chatId: string, presetId: string) =>
    post<void>("/rp/apply-preset", { chatId, presetId }),
  rpGetBlocks: (chatId: string) => get<PromptBlock[]>(`/rp/blocks/${chatId}`),
  rpSaveBlocks: (chatId: string, blocks: PromptBlock[]) =>
    put<void>(`/rp/blocks/${chatId}`, { blocks }),

  // --- Characters ---
  characterList: () => get<CharacterDetail[]>("/characters"),
  characterGet: (id: string) => get<CharacterDetail>(`/characters/${id}`),
  characterImportV2: (rawJson: string) => post<CharacterDetail>("/characters/import", { rawJson }),
  characterValidateV2: (rawJson: string) =>
    post<{ valid: boolean; errors: string[] }>("/characters/validate", { rawJson }),
  characterUpdate: (id: string, data: Partial<CharacterDetail>) => put<CharacterDetail>(`/characters/${id}`, data),
  characterDelete: (id: string) => del<void>(`/characters/${id}`),
  characterUploadAvatar: (id: string, base64Data: string, filename: string) =>
    post<{ avatarUrl: string }>(`/characters/${id}/avatar`, { base64Data, filename }),

  // --- Writer ---
  writerProjectCreate: (name: string, description: string) =>
    post<BookProject>("/writer/projects", { name, description }),
  writerProjectList: () => get<BookProject[]>("/writer/projects"),
  writerProjectOpen: (projectId: string) =>
    get<{ project: BookProject; chapters: Chapter[]; scenes: Scene[] }>(`/writer/projects/${projectId}`),
  writerChapterCreate: (projectId: string, title: string) =>
    post<Chapter>("/writer/chapters", { projectId, title }),
  writerGenerateDraft: (chapterId: string, prompt: string) =>
    post<Scene>(`/writer/chapters/${chapterId}/generate-draft`, { prompt }),
  writerSceneExpand: (sceneId: string) => post<Scene>(`/writer/scenes/${sceneId}/expand`),
  writerSceneRewrite: (sceneId: string, tone: string) =>
    post<Scene>(`/writer/scenes/${sceneId}/rewrite`, { tone }),
  writerSceneSummarize: (sceneId: string) => get<string>(`/writer/scenes/${sceneId}/summarize`),
  writerConsistencyRun: (projectId: string) =>
    post<ConsistencyIssue[]>(`/writer/projects/${projectId}/consistency`),
  writerExportMarkdown: (projectId: string) =>
    post<string>(`/writer/projects/${projectId}/export/markdown`),
  writerExportDocx: (projectId: string) =>
    post<string>(`/writer/projects/${projectId}/export/docx`),
  writerSceneUpdate: (sceneId: string, data: Partial<Scene>) =>
    patchReq<Scene>(`/writer/scenes/${sceneId}`, data),

  // --- User Personas ---
  personaList: () => get<UserPersona[]>("/personas"),
  personaCreate: (data: Partial<UserPersona>) => post<UserPersona>("/personas", data),
  personaUpdate: (id: string, data: Partial<UserPersona>) => put<UserPersona>(`/personas/${id}`, data),
  personaDelete: (id: string) => del<void>(`/personas/${id}`),
  personaSetDefault: (id: string) => post<{ ok: boolean }>(`/personas/${id}/set-default`),

  // --- File Upload ---
  uploadFile: (base64Data: string, filename: string) =>
    post<FileAttachment>("/upload", { base64Data, filename })
};
