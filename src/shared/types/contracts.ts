export type Id = string;

export type CensorshipMode = "Filtered" | "Unfiltered";

export interface ProviderProfile {
  id: Id;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  proxyUrl?: string | null;
  fullLocalOnly: boolean;
  providerType?: "openai" | "koboldcpp";
}

export interface ProviderModel {
  id: string;
}

export interface SamplerConfig {
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  maxTokens: number;
  stop: string[];
  topK?: number;
  topA?: number;
  minP?: number;
  typical?: number;
  tfs?: number;
  nSigma?: number;
  repetitionPenalty?: number;
  repetitionPenaltyRange?: number;
  repetitionPenaltySlope?: number;
  samplerOrder?: number[];
  koboldMemory?: string;
  koboldBannedPhrases?: string[];
  koboldUseDefaultBadwords?: boolean;
}

export interface OpenAiApiParamPolicy {
  sendSampler: boolean;
  temperature: boolean;
  topP: boolean;
  frequencyPenalty: boolean;
  presencePenalty: boolean;
  maxTokens: boolean;
  stop: boolean;
}

export interface KoboldApiParamPolicy {
  sendSampler: boolean;
  memory: boolean;
  maxTokens: boolean;
  temperature: boolean;
  topP: boolean;
  topK: boolean;
  topA: boolean;
  minP: boolean;
  typical: boolean;
  tfs: boolean;
  nSigma: boolean;
  repetitionPenalty: boolean;
  repetitionPenaltyRange: boolean;
  repetitionPenaltySlope: boolean;
  samplerOrder: boolean;
  stop: boolean;
  phraseBans: boolean;
  useDefaultBadwords: boolean;
}

export interface ApiParamPolicy {
  openai: OpenAiApiParamPolicy;
  kobold: KoboldApiParamPolicy;
}

export interface PromptBlock {
  id: Id;
  kind: "system" | "jailbreak" | "character" | "author_note" | "lore" | "scene" | "history";
  enabled: boolean;
  order: number;
  content: string;
}

export interface ChatMessage {
  id: Id;
  chatId: Id;
  branchId: Id;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tokenCount: number;
  createdAt: string;
  parentId?: Id | null;
  characterName?: string;
  attachments?: FileAttachment[];
}

export interface BranchNode {
  id: Id;
  chatId: Id;
  name: string;
  parentMessageId?: Id | null;
  createdAt: string;
}

export interface ChatSession {
  id: Id;
  title: string;
  characterId?: Id | null;
  characterIds?: Id[];
  lorebookId?: Id | null;
  autoConversation?: boolean;
  createdAt: string;
}

export interface CharacterCardV2 {
  spec: "chara_card_v2";
  spec_version: string;
  data: Record<string, unknown>;
}

export interface RpSceneState {
  chatId: Id;
  variables: Record<string, string>;
  mood: string;
  pacing: "slow" | "balanced" | "fast";
  intensity: number;
  pureChatMode?: boolean;
}

export interface RpPreset {
  id: Id;
  name: string;
  description: string;
  styleHints: string[];
}

export interface WriterStyleProfile {
  id: Id;
  name: string;
  tone: string;
  pov: string;
  constraints: string[];
}

export interface BookProject {
  id: Id;
  name: string;
  description: string;
  characterIds: Id[];
  notes?: WriterProjectNotes;
  createdAt: string;
}

export interface WriterProjectNotes {
  premise: string;
  styleGuide: string;
  characterNotes: string;
  worldRules: string;
  contextMode: "economy" | "balanced" | "rich";
  summary: string;
}

export interface WriterDocxImportResult {
  ok: boolean;
  chaptersCreated: number;
  scenesCreated: number;
  chapterTitles: string[];
}

export interface WriterProjectSummaryResult {
  summary: string;
  cached: boolean;
  chapterCount: number;
}

export interface WriterChapterSettings {
  tone: string;
  pacing: "slow" | "balanced" | "fast";
  pov: "first_person" | "third_limited" | "third_omniscient";
  creativity: number;
  tension: number;
  detail: number;
  dialogue: number;
}

export interface WriterCharacterAdvancedOptions {
  name?: string;
  role?: string;
  personality?: string;
  scenario?: string;
  greetingStyle?: string;
  systemPrompt?: string;
  tags?: string;
  notes?: string;
}

export interface WriterCharacterGenerateRequest {
  description: string;
  mode?: "basic" | "advanced";
  advanced?: WriterCharacterAdvancedOptions;
}

export type WriterCharacterEditField =
  | "name"
  | "description"
  | "personality"
  | "scenario"
  | "greeting"
  | "systemPrompt"
  | "mesExample"
  | "creatorNotes"
  | "tags";

export interface WriterCharacterEditRequest {
  instruction: string;
  fields?: WriterCharacterEditField[];
}

export interface WriterCharacterEditResponse {
  character: CharacterDetail;
  changedFields: WriterCharacterEditField[];
}

export interface Chapter {
  id: Id;
  projectId: Id;
  title: string;
  position: number;
  settings: WriterChapterSettings;
  createdAt: string;
}

export interface Scene {
  id: Id;
  chapterId: Id;
  title: string;
  content: string;
  goals: string;
  conflicts: string;
  outcomes: string;
  createdAt: string;
}

export interface BeatNode {
  id: Id;
  projectId: Id;
  label: string;
  beatType: "setup" | "inciting" | "midpoint" | "climax" | "resolution";
  sequence: number;
}

export interface ConsistencyIssue {
  id: Id;
  projectId: Id;
  severity: "low" | "medium" | "high";
  category: "names" | "facts" | "timeline" | "pov";
  message: string;
}

export interface PromptTemplates {
  jailbreak: string;
  compressSummary: string;
  writerGenerate: string;
  writerExpand: string;
  writerRewrite: string;
  writerSummarize: string;
  creativeWriting: string;
}

export interface RpPresetConfig {
  id: string;
  name: string;
  description: string;
  mood: string;
  pacing: "slow" | "balanced" | "fast";
  intensity: number;
  dialogueStyle?: "teasing" | "playful" | "dominant" | "tender" | "formal" | "chaotic";
  initiative?: number;
  descriptiveness?: number;
  unpredictability?: number;
  emotionalDepth?: number;
  jailbreakOverride?: string;
}

export interface FileAttachment {
  id: string;
  filename: string;
  type: "image" | "text";
  url: string;
  mimeType?: string;
  dataUrl?: string;
  content?: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string;
  env: string;
  enabled: boolean;
  timeoutMs: number;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpDiscoveredTool {
  serverId: string;
  serverName: string;
  toolName: string;
  callName: string;
  description: string;
}

export interface McpServerTestResult {
  ok: boolean;
  tools: McpToolInfo[];
  error?: string;
}

export interface McpImportResult {
  ok: boolean;
  servers: McpServerConfig[];
  sourceType: "url" | "json";
  error?: string;
}

export interface McpDiscoverResult {
  ok: boolean;
  tools: McpDiscoveredTool[];
  error?: string;
}

export interface AppSettings {
  onboardingCompleted: boolean;
  theme: "dark" | "light" | "custom";
  fontScale: number;
  density: "comfortable" | "compact";
  censorshipMode: CensorshipMode;
  fullLocalMode: boolean;
  responseLanguage: string;
  translateLanguage: string;
  translateProviderId?: string | null;
  translateModel?: string | null;
  interfaceLanguage: "en" | "ru" | "zh" | "ja";
  activeProviderId?: string | null;
  activeModel?: string | null;
  ttsBaseUrl: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoice: string;
  compressProviderId?: string | null;
  compressModel?: string | null;
  mergeConsecutiveRoles: boolean;
  samplerConfig: SamplerConfig;
  apiParamPolicy: ApiParamPolicy;
  defaultSystemPrompt: string;
  contextWindowSize: number;
  contextTailBudgetWithSummaryPercent: number;
  contextTailBudgetWithoutSummaryPercent: number;
  promptTemplates: PromptTemplates;
  toolCallingEnabled: boolean;
  toolCallingPolicy: "conservative" | "balanced" | "aggressive";
  mcpAutoAttachTools: boolean;
  maxToolCallsPerTurn: number;
  mcpToolAllowlist: string[];
  mcpToolDenylist: string[];
  mcpDiscoveredTools: McpDiscoveredTool[];
  mcpToolStates: Record<string, boolean>;
  mcpServers: McpServerConfig[];
}

export interface ChatCharacterLink {
  characterId: Id;
  displayName: string;
  avatarUrl: string | null;
  order: number;
}

export interface UserPersona {
  id: Id;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  isDefault: boolean;
  createdAt: string;
}

export interface CharacterListItem {
  id: Id;
  name: string;
  avatarUrl: string | null;
  lorebookId?: Id | null;
  tags: string[];
  greeting: string;
  systemPrompt: string;
  createdAt: string;
}

export interface CharacterDetail extends CharacterListItem {
  description: string;
  personality: string;
  scenario: string;
  mesExample: string;
  creatorNotes: string;
  cardJson: string;
}

export interface LoreBookEntry {
  id: string;
  name: string;
  keys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  position: string;
  insertionOrder: number;
}

export interface LoreBook {
  id: Id;
  name: string;
  description: string;
  entries: LoreBookEntry[];
  sourceCharacterId?: Id | null;
  createdAt: string;
  updatedAt: string;
}
