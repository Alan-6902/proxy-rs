// Kiro 请求负载与账号类型定义（openaiToKiro 输入 → KiroPayload）

// ============ OpenAI 兼容格式 ============
export interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  stream?: boolean
  tools?: OpenAITool[]
  tool_choice?: string | { type: string; function: { name: string } }
  response_format?: { type: string; json_schema?: unknown }
  conversation_id?: string
  metadata?: Record<string, unknown>
  kiro_context?: KiroRequestContext
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max' | string
  thinking?:
    | { type: 'enabled'; budget_tokens?: number }
    | { type: 'adaptive' }
    | { type: 'disabled' }
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[]
  reasoning_content?: string
  name?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  cache_control?: ClaudeCacheControl
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url' | 'file' | 'document'
  text?: string
  image_url?: { url: string; detail?: string }
  file?: { filename?: string; file_data?: string }
  source?: ClaudeDocumentSource
  name?: string
  cache_control?: ClaudeCacheControl
}

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
  cache_control?: ClaudeCacheControl
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

// ============ Claude 内容块（文档 source 解析复用） ============
export interface ClaudeContentBlock {
  type:
    | 'text'
    | 'image'
    | 'document'
    | 'tool_use'
    | 'tool_result'
    | 'thinking'
    | 'redacted_thinking'
  text?: string
  thinking?: string
  signature?: string
  data?: string
  source?:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
    | ClaudeDocumentSource
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | ClaudeContentBlock[]
  cache_control?: ClaudeCacheControl
}

export type ClaudeDocumentSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'text'; media_type?: string; data: string }

export interface ClaudeCacheControl {
  type: string
}

// ============ Kiro API 格式 ============
export interface KiroPayload {
  conversationState: KiroConversationState
  profileArn?: string
  inferenceConfig?: KiroInferenceConfig
  additionalModelRequestFields?: Record<string, unknown>
}

export interface KiroConversationState {
  agentContinuationId?: string
  agentTaskType?: string
  chatTriggerType: 'MANUAL'
  conversationId: string
  currentMessage: KiroCurrentMessage
  history?: KiroHistoryMessage[]
}

export interface KiroCurrentMessage {
  userInputMessage: KiroUserInputMessage
}

export interface KiroUserInputMessage {
  content: string
  modelId?: string // 可选，占位消息不需要
  origin: string
  images?: KiroImage[]
  documents?: KiroDocument[]
  cachePoint?: KiroCachePoint
  clientCacheConfig?: unknown
  userInputMessageContext?: KiroUserInputMessageContext
}

export interface KiroImage {
  format: string
  source: { bytes: string }
}

export interface KiroDocument {
  format: string
  name: string
  source: { bytes: string }
}

export interface KiroUserInputMessageContext {
  toolResults?: KiroToolResult[]
  tools?: KiroToolWrapper[]
  editorState?: unknown
  shellState?: unknown
  gitState?: unknown
  envState?: unknown
  additionalContext?: unknown
}

export interface KiroToolResult {
  content: { text: string }[]
  status: 'success' | 'error'
  toolUseId: string
}

export type KiroToolWrapper =
  | {
      toolSpecification: {
        name: string
        description: string
        inputSchema: { json: unknown }
      }
    }
  | {
      cachePoint: KiroCachePoint
    }

export interface KiroHistoryMessage {
  userInputMessage?: KiroUserInputMessage
  assistantResponseMessage?: KiroAssistantResponseMessage
}

export interface KiroAssistantResponseMessage {
  content: string
  cachePoint?: KiroCachePoint
  reasoningContent?: KiroReasoningContent
  toolUses?: KiroToolUse[]
}

export interface KiroToolUse {
  toolUseId: string
  name: string
  input: Record<string, unknown>
}

export interface KiroInferenceConfig {
  maxTokens?: number
  temperature?: number
  topP?: number
}

export interface KiroCachePoint {
  type: 'default'
}

export interface KiroReasoningContent {
  reasoningText?: {
    text: string
    signature?: string
  }
  redactedContent?: string
}

export interface KiroRequestContext {
  editorState?: unknown
  shellState?: unknown
  gitState?: unknown
  envState?: unknown
  additionalContext?: unknown
}

export interface KiroUsage {
  inputTokens: number
  outputTokens: number
  credits: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  /** Context usage breakdown（来自后端 ContextUsageEvent） */
  contextUsage?: {
    percentage: number
    breakdown?: {
      conversation?: number
      mcpTools?: number
      steeringFiles?: number
    }
  }
}

// ============ 账号和代理配置 ============
export interface ProxyAccount {
  id: string
  email?: string
  /** IPC 同步资格；旧渲染进程传入封禁账号时主进程必须拒绝入池。 */
  status?: string
  accessToken?: string
  /** 上游 Kiro API Key；仅 credentialKind='kiro_api_key' 时使用。 */
  kiroApiKey?: string
  credentialKind?: 'oauth' | 'kiro_api_key'
  refreshToken?: string
  credentialRevision?: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: 'social' | 'idc' | 'IdC' | 'external_idp'
  provider?: string
  profileArn?: string
  expiresAt?: number
  /** 账号绑定的出口代理 URL（http/https）；为空则使用全局代理逻辑 */
  proxyUrl?: string
  /** 强制直连，禁止继承 App 全局代理或系统代理。 */
  bypassAppProxy?: boolean
  /** 账号所属分组 ID；与 multiAccountSelectionMode='groups' + multiAccountGroupIds 配合做轮询分组过滤 */
  groupId?: string
  // 运行时状态
  lastUsed?: number
  requestCount?: number
  errorCount?: number
  isAvailable?: boolean
  cooldownUntil?: number
  // 配额追踪
  quotaUsed?: number
  quotaLimit?: number
  quotaExhaustedAt?: number // 配额耗尽时间戳
  quotaResetAt?: number // 下次配额重置时间
  // 长期封禁追踪（区分于临时 errorCount 冷却）
  // Kiro 后端 TEMPORARILY_SUSPENDED / AccountSuspendedException 等风控触发时设置
  // 需要联系 AWS Support 人工解封，账号池会持续跳过直到 clearSuspended
  suspendedAt?: number // 封禁时间戳
  suspendReason?: string // 封禁原因 (如 'TEMPORARILY_SUSPENDED')
  suspendMessage?: string // 封禁完整错误消息 (含联系链接)
}

import { resolveBackgroundRefreshPlan } from '../../shared/upstreamKiroCredentials'

export interface BackgroundRefreshPlan {
  credentialKind: 'oauth' | 'kiro_api_key'
  accessToken?: string
  kiroApiKey?: string
  shouldRefreshToken: boolean
  shouldFetchUserInfo: boolean
}

export function buildBackgroundRefreshPlan(
  credentials: Pick<ProxyAccount, 'credentialKind' | 'accessToken' | 'kiroApiKey' | 'refreshToken'>,
  needsTokenRefresh: boolean
): BackgroundRefreshPlan {
  return resolveBackgroundRefreshPlan(credentials, needsTokenRefresh)
}
