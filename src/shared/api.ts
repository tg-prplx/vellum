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
  LoreBook,
  McpDiscoverResult,
  McpImportResult,
  McpServerConfig,
  McpServerTestResult,
  PromptBlock,
  ProviderModel,
  ProviderProfile,
  RpSceneState,
  Scene,
  SamplerConfig,
  WriterChapterSettings,
  WriterCharacterEditRequest,
  WriterCharacterEditResponse,
  WriterCharacterGenerateRequest,
  WriterDocxImportResult,
  WriterProjectNotes,
  WriterProjectSummaryResult,
  UserPersona
} from "./types/contracts";

type UserPersonaPayload = Pick<UserPersona, "name" | "description" | "personality" | "scenario">;

const BASE = import.meta.env.DEV ? "http://localhost:3001/api" : "/api";
const PROD_FALLBACK_BASES = ["http://127.0.0.1:3001/api", "http://localhost:3001/api"];

function requestBases(): string[] {
  return import.meta.env.DEV ? [BASE] : [BASE, ...PROD_FALLBACK_BASES];
}

export function resolveApiAssetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) {
    return url;
  }
  // In prod the renderer is served by the same backend, so relative URLs are correct.
  if (!import.meta.env.DEV) return url;
  return `http://localhost:3001${url}`;
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Browser fetch network failure is usually TypeError; keep message checks as backup.
  return (
    err.name === "TypeError" ||
    /failed to fetch|networkerror|network error|load failed/i.test(err.message)
  );
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const bases = requestBases();
  let lastErr: unknown = new Error("Request failed");

  for (const base of bases) {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      if (!isNetworkError(err) || import.meta.env.DEV) {
        throw err;
      }
    }
  }

  throw lastErr;
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

async function requestBlob(method: string, path: string, body?: unknown): Promise<Blob> {
  const bases = requestBases();
  let lastErr: unknown = new Error("Request failed");

  for (const base of bases) {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      return await res.blob();
    } catch (err) {
      lastErr = err;
      if (!isNetworkError(err) || import.meta.env.DEV) {
        throw err;
      }
    }
  }

  throw lastErr;
}

export type StreamCallbacks = {
  onDelta?: (delta: string) => void;
  onToolEvent?: (event: {
    phase: "start" | "delta" | "done";
    callId: string;
    name: string;
    args?: string;
    result?: string;
  }) => void;
  onDone?: () => void;
};

async function streamPost(
  path: string,
  body: unknown,
  callbacks: StreamCallbacks
): Promise<void> {
  let res: Response | null = null;
  let lastErr: unknown = new Error("Request failed");

  for (const base of requestBases()) {
    try {
      const candidate = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!candidate.ok) {
        const text = await candidate.text();
        throw new Error(text || `HTTP ${candidate.status}`);
      }
      res = candidate;
      break;
    } catch (err) {
      lastErr = err;
      if (!isNetworkError(err) || import.meta.env.DEV) {
        throw err;
      }
    }
  }

  if (!res) {
    throw lastErr;
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
          const parsed = JSON.parse(trimmed.slice(6)) as {
            type: string;
            delta?: string;
            phase?: "start" | "delta" | "done";
            callId?: string;
            name?: string;
            args?: string;
            result?: string;
          };
          if (parsed.type === "delta" && parsed.delta) {
            callbacks.onDelta?.(parsed.delta);
          } else if (parsed.type === "tool" && parsed.phase && parsed.callId && parsed.name) {
            callbacks.onToolEvent?.({
              phase: parsed.phase,
              callId: parsed.callId,
              name: parsed.name,
              args: parsed.args,
              result: parsed.result
            });
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
  settingsFetchTtsModels: (baseUrl?: string, apiKey?: string) =>
    post<ProviderModel[]>("/settings/tts/models", { baseUrl, apiKey }),
  settingsFetchTtsVoices: (baseUrl?: string, apiKey?: string) =>
    post<ProviderModel[]>("/settings/tts/voices", { baseUrl, apiKey }),
  settingsTestMcpServer: (server: McpServerConfig) => post<McpServerTestResult>("/settings/mcp/test", { server }),
  settingsImportMcpSource: (source: string) => post<McpImportResult>("/settings/mcp/import", { source }),
  settingsDiscoverMcpTools: (serverIds?: string[]) => post<McpDiscoverResult>("/settings/mcp/discover", { serverIds }),

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
  chatRename: (chatId: string, title: string) =>
    patchReq<{ ok: boolean; title: string }>(`/chats/${chatId}`, { title }),
  chatAbort: (chatId: string) => post<{ ok: boolean; interrupted: boolean }>(`/chats/${chatId}/abort`),
  chatDelete: (chatId: string) => del<{ ok: boolean }>(`/chats/${chatId}`),
  chatBranches: (chatId: string) => get<BranchNode[]>(`/chats/${chatId}/branches`),
  chatUpdateCharacters: (chatId: string, characterIds: string[]) =>
    patchReq<{ ok: boolean; characterIds: string[]; characterId: string | null }>(`/chats/${chatId}/characters`, { characterIds }),
  chatNextTurn: async (chatId: string, characterName: string, branchId?: string, callbacks?: StreamCallbacks, isAutoConvo?: boolean, userPersona?: UserPersonaPayload | null): Promise<ChatMessage[]> => {
    if (callbacks) {
      await streamPost(`/chats/${chatId}/next-turn`, { characterName, branchId, isAutoConvo, userPersona }, callbacks);
      return api.chatTimeline(chatId, branchId);
    }
    return post<ChatMessage[]>(`/chats/${chatId}/next-turn`, { characterName, branchId, isAutoConvo, userPersona });
  },
  chatList: () => get<ChatSession[]>("/chats"),
  chatTimeline: (chatId: string, branchId?: string) =>
    get<ChatMessage[]>(`/chats/${chatId}/timeline${branchId ? `?branchId=${branchId}` : ""}`),

  chatSend: async (
    chatId: string,
    content: string,
    branchId?: string,
    callbacks?: StreamCallbacks,
    userPersona?: UserPersonaPayload | null,
    attachments?: FileAttachment[]
  ): Promise<ChatMessage[]> => {
    if (callbacks) {
      await streamPost(`/chats/${chatId}/send`, { content, branchId, userPersona, attachments }, callbacks);
      return api.chatTimeline(chatId, branchId);
    }
    return post<ChatMessage[]>(`/chats/${chatId}/send`, { content, branchId, userPersona, attachments });
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
  chatTtsMessage: (messageId: string) =>
    requestBlob("POST", `/chats/messages/${messageId}/tts`),
  chatSaveSampler: (chatId: string, samplerConfig: SamplerConfig) =>
    patchReq<{ ok: boolean }>(`/chats/${chatId}/sampler`, { samplerConfig }),
  chatGetSampler: (chatId: string) =>
    get<SamplerConfig | null>(`/chats/${chatId}/sampler`),
  chatSavePreset: (chatId: string, presetId: string | null) =>
    patchReq<{ ok: boolean }>(`/chats/${chatId}/preset`, { presetId }),
  chatGetPreset: (chatId: string) =>
    get<{ presetId: string | null }>(`/chats/${chatId}/preset`),
  chatSaveLorebook: (chatId: string, lorebookId: string | null) =>
    patchReq<{ ok: boolean; lorebookId: string | null }>(`/chats/${chatId}/lorebook`, { lorebookId }),
  chatGetLorebook: (chatId: string) =>
    get<{ lorebookId: string | null }>(`/chats/${chatId}/lorebook`),

  // --- RP ---
  rpSetSceneState: (state: RpSceneState) => post<void>("/rp/scene-state", state),
  rpGetSceneState: (chatId: string) => get<RpSceneState | null>(`/rp/scene-state/${chatId}`),
  rpUpdateAuthorNote: (chatId: string, authorNote: string) =>
    post<void>("/rp/author-note", { chatId, authorNote }),
  rpGetAuthorNote: (chatId: string) =>
    get<{ authorNote: string }>(`/rp/author-note/${chatId}`),
  rpApplyStylePreset: (chatId: string, presetId: string) =>
    post<{ ok: boolean; sceneState: RpSceneState; presetId: string }>("/rp/apply-preset", { chatId, presetId }),
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

  // --- LoreBooks ---
  lorebookList: () => get<LoreBook[]>("/lorebooks"),
  lorebookGet: (id: string) => get<LoreBook>(`/lorebooks/${id}`),
  lorebookCreate: (data: Partial<LoreBook>) => post<LoreBook>("/lorebooks", data),
  lorebookUpdate: (id: string, data: Partial<LoreBook>) => put<LoreBook>(`/lorebooks/${id}`, data),
  lorebookDelete: (id: string) => del<{ ok: boolean }>(`/lorebooks/${id}`),

  // --- Writer ---
  writerProjectCreate: (name: string, description: string, characterIds: string[] = []) =>
    post<BookProject>("/writer/projects", { name, description, characterIds }),
  writerProjectList: () => get<BookProject[]>("/writer/projects"),
  writerProjectUpdate: (projectId: string, data: { name?: string; description?: string }) =>
    patchReq<BookProject>(`/writer/projects/${projectId}`, data),
  writerProjectDelete: (projectId: string) =>
    del<{ ok: boolean; id: string }>(`/writer/projects/${projectId}`),
  writerProjectSetCharacters: (projectId: string, characterIds: string[]) =>
    patchReq<BookProject>(`/writer/projects/${projectId}/characters`, { characterIds }),
  writerProjectOpen: (projectId: string) =>
    get<{ project: BookProject; chapters: Chapter[]; scenes: Scene[] }>(`/writer/projects/${projectId}`),
  writerProjectUpdateNotes: (projectId: string, notes: Partial<WriterProjectNotes>) =>
    patchReq<{ project: BookProject }>(`/writer/projects/${projectId}/notes`, { notes }),
  writerProjectImportDocx: (projectId: string, base64Data: string, filename: string) =>
    post<WriterDocxImportResult>(`/writer/projects/${projectId}/import/docx`, { base64Data, filename }),
  writerProjectSummarize: (projectId: string, force = false) =>
    post<WriterProjectSummaryResult>(`/writer/projects/${projectId}/summarize`, { force }),
  writerChapterCreate: (projectId: string, title: string) =>
    post<Chapter>("/writer/chapters", { projectId, title }),
  writerChapterUpdateSettings: (chapterId: string, settings: WriterChapterSettings) =>
    patchReq<Chapter>(`/writer/chapters/${chapterId}/settings`, { settings }),
  writerGenerateDraft: (chapterId: string, prompt: string) =>
    post<Scene>(`/writer/chapters/${chapterId}/generate-draft`, { prompt }),
  writerSceneExpand: (sceneId: string) => post<Scene>(`/writer/scenes/${sceneId}/expand`),
  writerSceneRewrite: (sceneId: string, tone?: string) =>
    post<Scene>(`/writer/scenes/${sceneId}/rewrite`, tone ? { tone } : {}),
  writerSceneSummarize: (sceneId: string) => get<string>(`/writer/scenes/${sceneId}/summarize`),
  writerConsistencyRun: (projectId: string) =>
    post<ConsistencyIssue[]>(`/writer/projects/${projectId}/consistency`),
  writerExportMarkdown: (projectId: string) =>
    post<string>(`/writer/projects/${projectId}/export/markdown`),
  writerExportDocx: (projectId: string) =>
    post<string>(`/writer/projects/${projectId}/export/docx`),
  writerSceneUpdate: (sceneId: string, data: Partial<Scene>) =>
    patchReq<Scene>(`/writer/scenes/${sceneId}`, data),
  writerGenerateCharacter: (payload: WriterCharacterGenerateRequest) =>
    post<CharacterDetail>("/writer/characters/generate", payload),
  writerEditCharacter: (characterId: string, payload: WriterCharacterEditRequest) =>
    post<WriterCharacterEditResponse>(`/writer/characters/${characterId}/edit`, payload),

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
