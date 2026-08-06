// Kiro Proxy HTTP/HTTPS 服务器
import http from 'http'
import https from 'https'
import fs from 'fs'
import crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import type { Socket } from 'net'
import type {
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAIResponseOutputItem,
  OpenAIResponsesRequest,
  ClaudeRequest,
  ClaudeContentBlock,
  ClaudeCacheControl,
  ProxyConfig,
  ProxyStats,
  ProxyAccount,
  TokenRefreshCallback
} from './types'
import { AccountPool, ErrorType, classifyError } from './accountPool'
import { assertDistinctAdminApiKey } from './adminApiKey'
import { ClaudeCodeStreamBuffer } from './claudeCodeStreamBuffer'
import {
  callKiroApiStream,
  callKiroApi,
  callKiroMcpWebSearch,
  isKiroApiKeyAccount,
  isMonthlyRequestQuotaError,
  KiroMcpWebSearchError,
  normalizeKiroUpstreamError,
  UpstreamRetryCategory,
  fetchKiroModels,
  setModelContextWindow,
  mapModelId,
  detectModelRemap,
  MODEL_REMAP_HEADER,
  type KiroModel,
  type KiroWebSearchResult
} from './kiroApi'
import { proxyLogger } from './logger'
import {
  openaiToKiro,
  claudeToKiro,
  kiroToOpenaiResponse,
  type ThinkingConfig,
  kiroToClaudeResponse,
  createOpenaiStreamChunk,
  createClaudeStreamEvent,
  responsesToOpenAIChat,
  openAIChatToResponsesResponse
} from './translator'
import { ToolNameRegistry } from './toolNameRegistry'
import { promptCacheTracker } from './promptCacheTracker'

export interface ProxyServerEvents {
  onRequest?: (info: { path: string; method: string; accountId?: string }) => void
  onResponse?: (info: {
    path: string
    model?: string
    status: number
    tokens?: number
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
    credits?: number
    responseTime?: number
    error?: string
  }) => void
  onError?: (error: Error) => void
  onConfigChanged?: (config: ProxyConfig) => void // API Key 用量更新时触发
  onStatusChange?: (running: boolean, port: number) => void
  onTokenRefresh?: TokenRefreshCallback
  onAccountUpdate?: (account: ProxyAccount) => void
  // 账号被 Kiro 后端长期封禁（如 TEMPORARILY_SUSPENDED / AccountSuspendedException）
  // 不同于临时 token 失效，需人工解封
  onAccountSuspended?: (info: {
    accountId: string
    email?: string
    reason: string
    message: string
  }) => void
  onAllAccountsExhausted?: () => void
  onTokenRefreshFailed?: (accountId: string) => void
  onCreditsUpdate?: (totalCredits: number) => void
  onTokensUpdate?: (inputTokens: number, outputTokens: number) => void
  onRequestStatsUpdate?: (
    totalRequests: number,
    successRequests: number,
    failedRequests: number
  ) => void
  onPoolEmpty?: () => Promise<void> // 账号池为空时触发（冷启动懒加载）
  onUnexpectedClose?: () => Promise<void>
}

type ModelModality = 'text' | 'audio' | 'image' | 'video' | 'pdf'

type ClientModel = {
  id: string
  object: 'model'
  created: number
  owned_by: string
  name: string
  description: string
  model_name?: string
  family: string
  release_date: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  interleaved: boolean | { field: 'reasoning_content' }
  cost: { input: number; output: number; cache_read: number; cache_write: number }
  limit: { context: number; input?: number; output: number }
  modalities: { input: ModelModality[]; output: ModelModality[] }
  capabilities: {
    temperature: boolean
    reasoning: boolean
    attachment: boolean
    toolcall: boolean
    input: Record<ModelModality, boolean>
    output: Record<ModelModality, boolean>
    interleaved: boolean | { field: 'reasoning_content' }
  }
  context_length: number
  max_tokens: number
  max_input_tokens?: number
  max_output_tokens: number
  inputTypes?: string[]
  rateMultiplier?: number
  rateUnit?: string
  supportsThinking?: boolean
  thinkingEfforts?: string[]
  thinkingSchemaPath?: 'output_config' | 'reasoning'
  supportsPromptCaching?: boolean
  modelProvider?: string
  permission: unknown[]
  root: string
  parent: null
}

function modelDisplayName(id: string, modelName?: string): string {
  if (modelName?.trim()) return modelName
  return id
    .split('-')
    .filter(Boolean)
    .map((part) =>
      part === 'gpt' ? 'GPT' : part === 'ai' ? 'AI' : part[0]?.toUpperCase() + part.slice(1)
    )
    .join(' ')
}

function modelFamily(id: string): string {
  const lower = id.toLowerCase()
  if (lower.includes('opus')) return 'claude-opus'
  if (lower.includes('sonnet')) return 'claude-sonnet'
  if (lower.includes('haiku')) return 'claude-haiku'
  if (lower.includes('gpt-4o')) return 'gpt-4o'
  if (lower.includes('gpt-4')) return 'gpt-4'
  if (lower.includes('gpt-3.5')) return 'gpt-3.5'
  if (lower.includes('glm')) return 'glm'
  if (lower === 'auto') return 'auto'
  return lower.split(/[.-]/).slice(0, 2).join('-') || lower
}

function modelOutputLimit(id: string, output?: number | null): number {
  if (typeof output === 'number' && output > 0) return output
  const lower = id.toLowerCase()
  if (lower.includes('haiku') || lower.includes('gpt-3.5')) return 8192
  return 32000
}

function modelInputModalities(inputTypes?: string[]): ModelModality[] {
  const values = new Set<ModelModality>(['text'])
  for (const item of inputTypes ?? []) {
    const lower = item.toLowerCase()
    if (lower.includes('image')) values.add('image')
    if (lower.includes('pdf') || lower.includes('document') || lower.includes('file'))
      values.add('pdf')
    if (lower.includes('audio')) values.add('audio')
    if (lower.includes('video')) values.add('video')
  }
  return Array.from(values)
}

function modelCapabilityMap(modalities: ModelModality[]): Record<ModelModality, boolean> {
  return {
    text: modalities.includes('text'),
    audio: modalities.includes('audio'),
    image: modalities.includes('image'),
    video: modalities.includes('video'),
    pdf: modalities.includes('pdf')
  }
}

function extractThinkingSchema(
  schema?: Record<string, unknown> | null
): { efforts?: string[]; schemaPath?: 'output_config' | 'reasoning' } | undefined {
  if (!schema) return undefined
  const props = schema.properties as Record<string, unknown> | undefined
  if (!props) return undefined
  // output_config 路径（Claude 4.6+ 新模型）
  if (props.output_config) {
    const effortField = (props.output_config as Record<string, unknown>)?.properties as
      | Record<string, unknown>
      | undefined
    const effortEnum = (effortField?.effort as Record<string, unknown> | undefined)?.enum as
      | string[]
      | undefined
    if (effortEnum && effortEnum.length > 0) {
      return { efforts: effortEnum, schemaPath: 'output_config' }
    }
  }
  // reasoning 路径（备用）
  if (props.reasoning) {
    const reasoningProps = (props.reasoning as Record<string, unknown>)?.properties as
      | Record<string, unknown>
      | undefined
    const effortEnum = (reasoningProps?.effort as Record<string, unknown> | undefined)?.enum as
      | string[]
      | undefined
    if (effortEnum && effortEnum.length > 0) {
      return { efforts: effortEnum, schemaPath: 'reasoning' }
    }
  }
  return undefined
}

function buildClientModel(input: {
  id: string
  created: number
  ownedBy: string
  description?: string
  modelName?: string
  supportedInputTypes?: string[]
  maxInputTokens?: number | null
  maxOutputTokens?: number | null
  rateMultiplier?: number
  rateUnit?: string
  promptCaching?: {
    supportsPromptCaching: boolean
    maximumCacheCheckpointsPerRequest?: number | null
    minimumTokensPerCacheCheckpoint?: number | null
  } | null
  additionalModelRequestFieldsSchema?: Record<string, unknown> | null
  modelProvider?: string | null
}): ClientModel {
  const name = modelDisplayName(input.id, input.modelName)
  const inputModalities = modelInputModalities(input.supportedInputTypes)
  const outputModalities: ModelModality[] = ['text']
  const output = modelOutputLimit(input.id, input.maxOutputTokens)
  const context =
    typeof input.maxInputTokens === 'number' && input.maxInputTokens > 0
      ? input.maxInputTokens
      : 200000
  const hasThinking =
    !!(input.additionalModelRequestFieldsSchema?.properties as Record<string, unknown> | undefined)
      ?.thinking ||
    !!(input.additionalModelRequestFieldsSchema?.properties as Record<string, unknown> | undefined)
      ?.output_config
  const reasoning = hasThinking
  const interleaved = hasThinking ? { field: 'reasoning_content' as const } : false

  return {
    id: input.id,
    object: 'model',
    created: input.created,
    owned_by: input.ownedBy,
    name,
    description: input.description || name,
    model_name: input.modelName || name,
    family: modelFamily(input.id),
    release_date: '',
    attachment: inputModalities.some((item) => item !== 'text'),
    reasoning,
    temperature: true,
    tool_call: true,
    interleaved,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: {
      context,
      ...(typeof input.maxInputTokens === 'number' && input.maxInputTokens > 0
        ? { input: input.maxInputTokens }
        : {}),
      output
    },
    modalities: { input: inputModalities, output: outputModalities },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: inputModalities.some((item) => item !== 'text'),
      toolcall: true,
      input: modelCapabilityMap(inputModalities),
      output: modelCapabilityMap(outputModalities),
      interleaved
    },
    context_length: context,
    max_tokens: output,
    ...(typeof input.maxInputTokens === 'number' && input.maxInputTokens > 0
      ? { max_input_tokens: input.maxInputTokens }
      : {}),
    max_output_tokens: output,
    inputTypes: input.supportedInputTypes,
    rateMultiplier: input.rateMultiplier,
    rateUnit: input.rateUnit,
    supportsThinking:
      !!(
        input.additionalModelRequestFieldsSchema?.properties as Record<string, unknown> | undefined
      )?.thinking ||
      !!(
        input.additionalModelRequestFieldsSchema?.properties as Record<string, unknown> | undefined
      )?.output_config,
    thinkingEfforts: extractThinkingSchema(input.additionalModelRequestFieldsSchema)?.efforts,
    thinkingSchemaPath: extractThinkingSchema(input.additionalModelRequestFieldsSchema)?.schemaPath,
    supportsPromptCaching: input.promptCaching?.supportsPromptCaching || false,
    modelProvider: input.modelProvider || undefined,
    permission: [],
    root: input.id,
    parent: null
  }
}

// 请求体超限错误（统一识别用，触发 413 响应）
class BodyTooLargeError extends Error {
  constructor(
    public readonly received: number,
    public readonly limit: number
  ) {
    super(`Request body too large: ${received} bytes exceeds limit of ${limit} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

class RetryExhaustedError extends Error {
  constructor(
    readonly upstreamError: Error,
    readonly accountId: string
  ) {
    super(upstreamError.message)
    this.name = 'RetryExhaustedError'
  }
}

const ADMIN_RATE_LIMIT_BUCKET = 'admin:control'
const API_KEY_RATE_LIMIT_PREFIX = 'api-key:'
const IP_RATE_LIMIT_PREFIX = 'ip:'
const WEB_SEARCH_TOOL_NAME = 'web_search'
const WEB_SEARCH_QUERY_PREFIX = 'Perform a web search for the query: '
const WEB_SEARCH_ATTEMPTS_PER_ACCOUNT = 3
const WEB_SEARCH_MAX_ATTEMPTS = 9
const WEB_SEARCH_RETRY_BASE_MS = 200
const WEB_SEARCH_RETRY_MAX_MS = 2000
const WEB_SEARCH_SNIPPET_LIMIT = 200
const WEB_SEARCH_SUMMARY_CHUNK_SIZE = 100
const WEB_SEARCH_MESSAGE_ID_LENGTH = 24

function* chunkCodePoints(text: string, size: number): Generator<string> {
  const characters = Array.from(text)
  for (let index = 0; index < characters.length; index += size) {
    yield characters.slice(index, index + size).join('')
  }
}

export class ProxyServer {
  private server: http.Server | https.Server | null = null
  private fallbackServer: http.Server | null = null // HTTPS 启用时同时监听 HTTP（可选）
  private accountPool: AccountPool
  private config: ProxyConfig
  private stats: ProxyStats
  private sessionStats: {
    totalRequests: number
    successRequests: number
    failedRequests: number
    startTime: number
  }
  private events: ProxyServerEvents
  private refreshingTokens: Map<string, Promise<boolean>> = new Map() // 在途刷新去重（并发方共享同一结果）
  private isHttps: boolean = false
  private isStopping: boolean = false
  private stopPromise: Promise<void> | null = null
  private activeRequests: Set<AbortController> = new Set()
  private sockets: Set<Socket> = new Set()
  /** P1-7 按 API Key/IP 的滑动窗口限流（每分钟桶） */
  private rateLimitBuckets: Map<string, { count: number; windowStart: number }> = new Map()
  /** P1-8 会话粘性：session hint → accountId 的映射（10 分钟 TTL） */
  private sessionAffinity: Map<string, { accountId: string; lastAt: number }> = new Map()
  /** P2-17 审计日志（最近 200 条） */
  private auditLog: Array<{ ts: number; type: string; data: Record<string, unknown> }> = []
  /** 定期清理 timer */
  private cleanupTimer: NodeJS.Timeout | null = null

  /**
   * 从请求中提取 session hint，用于稳定 conversationId
   * 优先级 1：显式稳定 ID（header）
   * 优先级 2：请求体中的会话相关字段（body）
   * 优先级 3：返回 undefined（由 kiroApi 用 history fingerprint 兜底）
   */
  static extractSessionHint(req: http.IncomingMessage, body: unknown): string | undefined {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    const h = req.headers
    // 优先级 1：显式稳定 header
    const headerHint =
      (h['x-claude-code-session-id'] as string) ||
      (h['x-opencode-session'] as string) ||
      (h['x-session-affinity'] as string) ||
      (h['x-conversation-id'] as string)
    if (headerHint) return headerHint

    // 优先级 2：body 中可靠的会话字段
    const bodyHint =
      (b.prompt_cache_key as string) ||
      (b.promptCacheKey as string) ||
      (b.conversation_id as string) ||
      (b.conversationId as string) ||
      (b.thread_id as string) ||
      (b.threadId as string) ||
      (b.session_id as string) ||
      (b.sessionId as string)
    if (bodyHint) return bodyHint

    // 优先级 2.5：metadata 中的 session/conversation
    const metadata = b.metadata as Record<string, unknown> | undefined
    if (metadata) {
      const metaHint = (metadata.session_id as string) || (metadata.conversation_id as string)
      if (metaHint) return metaHint
    }

    // 优先级 3：无显式 ID，返回 undefined（kiroApi 用 history fingerprint 兜底）
    return undefined
  }

  private accountedUpstreamErrors: WeakMap<Error, Set<string>> = new WeakMap()

  constructor(config: Partial<ProxyConfig> = {}, events: ProxyServerEvents = {}) {
    this.config = {
      enabled: false,
      port: 5580,
      host: '127.0.0.1',
      enableMultiAccount: true,
      selectedAccountIds: [],
      logRequests: true,
      maxConcurrent: 10,
      maxRetries: 3,
      retryDelayMs: 1000,
      tokenRefreshBeforeExpiry: 300, // 5分钟提前刷新
      autoStart: false, // 是否自动启动
      clientDrivenToolExecution: true,
      ...config
    }
    assertDistinctAdminApiKey(this.config)
    this.accountPool = new AccountPool()
    this.accountPool.setStrategy(this.config.accountSelectionStrategy || 'round-robin')
    this.stats = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      totalTokens: 0,
      totalCredits: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      startTime: Date.now(),
      accountStats: new Map(),
      endpointStats: new Map(),
      modelStats: new Map(),
      recentRequests: []
    }
    this.sessionStats = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      startTime: 0
    }
    this.events = events
  }

  /**
   * 检测当前绑定地址是否会暴露到本机以外
   * 0.0.0.0 / :: / 网卡地址 → true；127.0.0.1 / ::1 / localhost → false
   */
  private isBindingExternal(host?: string): boolean {
    if (!host) return false
    const h = host.toLowerCase().trim()
    return (
      h === '0.0.0.0' ||
      h === '::' ||
      h === '*' ||
      (h !== '127.0.0.1' && h !== '::1' && h !== 'localhost')
    )
  }

  // 启动服务器
  async start(): Promise<void> {
    if (this.server) {
      console.log('[ProxyServer] Server already running')
      return
    }

    // P0-2 安全护栏：外网绑定 + 无 API Key → 拒绝启动（用户可以显式 allowExternalWithoutApiKey 解除）
    if (this.isBindingExternal(this.config.host)) {
      const hasAnyKey =
        (this.config.apiKeys?.some((k) => k.enabled && k.key) ?? false) || !!this.config.apiKey
      if (!hasAnyKey && !this.config.allowExternalWithoutApiKey) {
        const err = new Error(
          `[Security] Refused to start: host=${this.config.host} exposes to network but no API Key configured. ` +
            `Set at least one API Key, or change host to 127.0.0.1, or set allowExternalWithoutApiKey=true (NOT RECOMMENDED).`
        )
        console.error('[ProxyServer]', err.message)
        this.events.onError?.(err)
        throw err
      }
      if (!hasAnyKey) {
        console.warn(
          `[ProxyServer] [Security] WARNING: binding to ${this.config.host} without API Key (allowExternalWithoutApiKey=true). This exposes your accounts to the network!`
        )
      }
    }

    return new Promise((resolve, reject) => {
      this.isStopping = false
      const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
        void this.handleRequest(req, res).catch(() => {
          try {
            if (!res.headersSent && !res.writableEnded)
              this.sendError(res, 500, 'Internal server error')
            else if (!res.writableEnded) res.end()
          } catch {
            if (!res.destroyed) res.destroy()
          }
        })
      }

      // 检查是否启用 TLS
      if (this.config.tls?.enabled) {
        try {
          const tlsOptions = this.getTlsOptions()
          this.server = https.createServer(tlsOptions, requestHandler)
          this.isHttps = true
        } catch (error) {
          reject(new Error(`TLS configuration error: ${(error as Error).message}`))
          return
        }
      } else {
        this.server = http.createServer(requestHandler)
        this.isHttps = false
      }

      const startingServer = this.server
      startingServer.on('error', (error: NodeJS.ErrnoException) => {
        if (!startingServer.listening) {
          if (this.server === startingServer) this.server = null
          if (this.cleanupTimer !== null) {
            clearInterval(this.cleanupTimer)
            this.cleanupTimer = null
          }
          const failedFallback = this.fallbackServer
          failedFallback?.close()
          if (this.fallbackServer === failedFallback) this.fallbackServer = null
        }
        if (error.code === 'EADDRINUSE') {
          console.error(`[ProxyServer] Port ${this.config.port} is already in use`)
          reject(new Error(`Port ${this.config.port} is already in use`))
        } else {
          console.error('[ProxyServer] Server error:', error)
          reject(error)
        }
        this.events.onError?.(error)
      })

      startingServer.on('connection', (socket: Socket) => {
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
        // P1-10 backpressure 监控：socket 写入缓冲区超过 1MB 时记录警告
        socket.on('drain', () => {
          if (socket.writableLength > 0) {
            proxyLogger.debug('ProxyServer', `Socket drain: bufferedLen=${socket.writableLength}`)
          }
        })
      })

      // 主进程决定意外关闭后的恢复，避免绕过统一生命周期 gate。
      const closingServer = startingServer
      startingServer.on('close', () => {
        if (this.server !== closingServer) return
        this.server = null
        if (this.isStopping) return
        if (this.cleanupTimer !== null) {
          clearInterval(this.cleanupTimer)
          this.cleanupTimer = null
        }
        const closingFallback = this.fallbackServer
        closingFallback?.close()
        if (this.fallbackServer === closingFallback) this.fallbackServer = null
        this.events.onStatusChange?.(false, this.config.port)
        if (this.config.autoStart && this.config.enabled) {
          void this.events.onUnexpectedClose?.().catch((err) => {
            console.error('[ProxyServer] Unexpected-close restart failed:', err)
          })
        }
      })

      // P1-11 keep-alive / headers 空闲超时（避免长连接占用资源）
      const keepAliveMs = this.config.keepAliveTimeoutMs ?? 65_000
      const headersMs = this.config.headersTimeoutMs ?? 60_000
      startingServer.keepAliveTimeout = keepAliveMs
      startingServer.headersTimeout = Math.max(headersMs, keepAliveMs + 1000) // headers 必须 > keepAlive，否则 Node 会 warn
      startingServer.requestTimeout = 0 // 流式响应可能很长，禁用 request 总超时

      // 启动定期清理（每 5 分钟）
      if (this.cleanupTimer !== null) clearInterval(this.cleanupTimer)
      this.cleanupTimer = setInterval(() => this.cleanupExpiredCaches(), 5 * 60_000)
      // 让 timer 在 Node 退出时不阻塞
      this.cleanupTimer.unref?.()

      const protocol = this.isHttps ? 'https' : 'http'
      startingServer.listen(this.config.port, this.config.host, () => {
        proxyLogger.info(
          'ProxyServer',
          `Started on ${protocol}://${this.config.host}:${this.config.port} (keepAlive=${keepAliveMs}ms)`
        )
        this.stats.startTime = Date.now()
        // 重置会话统计
        this.sessionStats = {
          totalRequests: 0,
          successRequests: 0,
          failedRequests: 0,
          startTime: Date.now()
        }
        this.events.onStatusChange?.(true, this.config.port)
        resolve()
      })

      // D4 启用 TLS 时同时监听 HTTP fallback 端口（如果配置了 fallbackPort）
      if (
        this.isHttps &&
        this.config.fallbackPort &&
        this.config.fallbackPort !== this.config.port
      ) {
        const fallback = http.createServer(requestHandler)
        fallback.keepAliveTimeout = keepAliveMs
        fallback.headersTimeout = Math.max(headersMs, keepAliveMs + 1000)
        fallback.requestTimeout = 0
        fallback.on('connection', (socket) => {
          this.sockets.add(socket)
          socket.on('close', () => this.sockets.delete(socket))
        })
        fallback.on('error', (err) =>
          proxyLogger.warn('ProxyServer', `Fallback HTTP error: ${err.message}`)
        )
        fallback.listen(this.config.fallbackPort, this.config.host, () => {
          proxyLogger.info(
            'ProxyServer',
            `Fallback HTTP listening on http://${this.config.host}:${this.config.fallbackPort}`
          )
        })
        this.fallbackServer = fallback
      }
    })
  }

  // 获取 TLS 配置选项
  // P1-13 当 tls.enabled 但未提供 cert/key 时，自动生成自签证书
  private getTlsOptions(): https.ServerOptions {
    const tls = this.config.tls!

    let cert: string
    let key: string

    // 优先使用直接提供的 PEM 内容
    if (tls.cert && tls.key) {
      cert = tls.cert
      key = tls.key
    } else if (tls.certPath && tls.keyPath) {
      // 从文件读取
      cert = fs.readFileSync(tls.certPath, 'utf8')
      key = fs.readFileSync(tls.keyPath, 'utf8')
    } else {
      // 自动生成自签证书（位于 userData/proxy-tls/）
      try {
        const { app } = require('electron')
        const { ensureProxySelfSignedCert } = require('./selfSignedCert')
        const hostnames = [this.config.host || '127.0.0.1']
        const result = ensureProxySelfSignedCert(app.getPath('userData'), hostnames)
        proxyLogger.info(
          'ProxyServer',
          `Using self-signed TLS cert (SAN=${result.altNames.join(',')}, fingerprint=${result.fingerprint.slice(0, 19)}...)`
        )
        cert = result.cert
        key = result.key
      } catch (err) {
        throw new Error(
          `TLS enabled but no certificate/key provided and auto-generation failed: ${(err as Error).message}`
        )
      }
    }

    return { cert, key }
  }

  /**
   * 获取（或生成）反代自签证书信息（供 UI 显示/导出 PEM）
   */
  getSelfSignedCertInfo(): import('./selfSignedCert').ProxySelfSignedCert | null {
    try {
      const { app } = require('electron')
      const { ensureProxySelfSignedCert } = require('./selfSignedCert')
      return ensureProxySelfSignedCert(app.getPath('userData'), [this.config.host || '127.0.0.1'])
    } catch (err) {
      proxyLogger.warn('ProxyServer', `getSelfSignedCertInfo failed: ${(err as Error).message}`)
      return null
    }
  }

  /** 强制重新生成自签证书（用户在 UI 上点"重新生成"） */
  regenerateSelfSignedCert(): import('./selfSignedCert').ProxySelfSignedCert | null {
    try {
      const { app } = require('electron')
      const { ensureProxySelfSignedCert } = require('./selfSignedCert')
      this.appendAuditLog('regenerate_self_signed_cert', { host: this.config.host })
      return ensureProxySelfSignedCert(
        app.getPath('userData'),
        [this.config.host || '127.0.0.1'],
        true
      )
    } catch (err) {
      proxyLogger.warn('ProxyServer', `regenerateSelfSignedCert failed: ${(err as Error).message}`)
      return null
    }
  }

  /**
   * 优雅停止服务器
   * - 立刻拒绝新连接（server.close）
   * - 给正在进行中的请求 5 秒完成；超时后强制 destroy socket
   * - 同时停 fallback HTTP 服务器
   */
  async stop(gracefulMs: number = 5000): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    if (!this.server) return

    this.isStopping = true
    const main = this.server
    const fallback = this.fallbackServer
    const sockets = new Set(this.sockets)
    const cleanupTimer = this.cleanupTimer
    let forceTimer: NodeJS.Timeout | undefined
    this.stopPromise = new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        if (forceTimer !== undefined) clearTimeout(forceTimer)
        proxyLogger.info('ProxyServer', 'Stopped')
        if (this.server === main) this.server = null
        if (this.fallbackServer === fallback) this.fallbackServer = null
        this.isStopping = false
        for (const socket of sockets) this.sockets.delete(socket)
        if (this.cleanupTimer === cleanupTimer && cleanupTimer !== null) {
          clearInterval(cleanupTimer)
          this.cleanupTimer = null
        }
        this.events.onStatusChange?.(false, this.config.port)
        resolve()
      }

      main.close(() => {
        fallback?.close(() => finish()) || finish()
      })
      fallback?.close()
      this.activeRequests.forEach((controller) => {
        try {
          controller.abort(new Error('Proxy server stopped'))
        } catch {
          /* ignore */
        }
      })
      forceTimer = setTimeout(
        () => {
          if (done) return
          for (const socket of sockets) {
            try {
              socket.destroy()
            } catch {
              /* ignore */
            }
          }
          finish()
        },
        Math.max(0, gracefulMs)
      )
      if (done && forceTimer !== undefined) clearTimeout(forceTimer)
    }).finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise!
  }

  // 更新配置
  // P2-18 检测到 port/host/tls 变更时，标记 needsRestart=true，UI 可读取并提示
  private _needsRestart = false
  updateConfig(config: Partial<ProxyConfig>): void {
    const nextConfig = { ...this.config, ...config }
    assertDistinctAdminApiKey(nextConfig)
    // 标记需要重启的字段
    const restartTriggerFields: Array<keyof ProxyConfig> = ['port', 'host', 'tls', 'fallbackPort']
    const willRestart = restartTriggerFields.some(
      (k) => k in config && JSON.stringify(this.config[k]) !== JSON.stringify(config[k])
    )
    if (willRestart && this.isRunning()) {
      this._needsRestart = true
      proxyLogger.warn(
        'ProxyServer',
        `Config change requires restart: ${restartTriggerFields.filter((k) => k in config).join(', ')}`
      )
    }
    this.appendAuditLog('config_changed', {
      fields: Object.keys(config),
      needsRestart: willRestart
    })
    this.config = nextConfig
    // 同步账号选择策略到 accountPool
    if (config.accountSelectionStrategy !== undefined) {
      this.accountPool.setStrategy(this.config.accountSelectionStrategy || 'round-robin')
    }
  }

  /** UI 可用此判断是否需提示用户重启 */
  needsRestart(): boolean {
    return this._needsRestart
  }

  /** 重启后调用清除 needsRestart 标记 */
  async restartServer(): Promise<void> {
    if (!this.isRunning()) {
      await this.start()
      this._needsRestart = false
      return
    }
    await this.stop()
    await this.start()
    this._needsRestart = false
  }

  // 获取配置
  getConfig(): ProxyConfig {
    return {
      ...this.config,
      apiKeys: this.config.apiKeys?.map((apiKey) => ({
        ...apiKey,
        usage: {
          ...apiKey.usage,
          daily: { ...apiKey.usage.daily },
          byModel: apiKey.usage.byModel ? { ...apiKey.usage.byModel } : undefined
        },
        usageHistory: apiKey.usageHistory ? [...apiKey.usageHistory] : undefined
      }))
    }
  }

  private validateCacheControl(cacheControl?: ClaudeCacheControl): void {
    if (!cacheControl) return
    if (cacheControl.type !== 'ephemeral') {
      throw new Error(`Unsupported cache_control type: ${cacheControl.type}`)
    }
  }

  private validateClaudeContentBlocks(blocks: ClaudeContentBlock[]): void {
    blocks.forEach((block) => {
      this.validateCacheControl(block.cache_control)
      if (Array.isArray(block.content)) {
        this.validateClaudeContentBlocks(block.content)
      }
    })
  }

  private validateOpenAICacheControls(request: OpenAIChatRequest): void {
    request.messages.forEach((message) => {
      this.validateCacheControl(message.cache_control)
      if (Array.isArray(message.content)) {
        message.content.forEach((part) => this.validateCacheControl(part.cache_control))
      }
    })
    request.tools?.forEach((tool) => this.validateCacheControl(tool.cache_control))
  }

  private validateClaudeCacheControls(request: ClaudeRequest): void {
    if (Array.isArray(request.system)) {
      request.system.forEach((block) => this.validateCacheControl(block.cache_control))
    }
    request.messages.forEach((message) => {
      this.validateCacheControl(message.cache_control)
      if (Array.isArray(message.content)) {
        this.validateClaudeContentBlocks(message.content)
      }
    })
    request.tools?.forEach((tool) => this.validateCacheControl(tool.cache_control))
  }

  private async downloadImageDataUrl(url: string, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const abort = () => controller.abort(this.getAbortError(signal))
    try {
      if (signal?.aborted) throw this.getAbortError(signal)
      signal?.addEventListener('abort', abort, { once: true })
      const agent = (() => {
        const { getSystemProxy, safeCreateProxyAgent } = require('./systemProxy')
        const envProxy =
          process.env.HTTPS_PROXY ||
          process.env.https_proxy ||
          process.env.HTTP_PROXY ||
          process.env.http_proxy
        const envAgent = safeCreateProxyAgent(envProxy)
        if (envAgent) return envAgent
        return safeCreateProxyAgent(getSystemProxy())
      })()
      const { fetch: undiciFetch } = require('undici')
      const response = agent
        ? ((await undiciFetch(url, {
            signal: controller.signal,
            dispatcher: agent
          })) as unknown as globalThis.Response)
        : await fetch(url, { signal: controller.signal })
      if (!response.ok) {
        throw new Error(`Failed to download image: HTTP ${response.status}`)
      }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.toLowerCase()
      if (
        !contentType ||
        !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(contentType)
      ) {
        throw new Error(`Unsupported image content-type: ${contentType || 'unknown'}`)
      }
      const arrayBuffer = await response.arrayBuffer()
      if (arrayBuffer.byteLength > 10 * 1024 * 1024) {
        throw new Error('Image exceeds 10MB limit')
      }
      return `data:${contentType};base64,${Buffer.from(arrayBuffer).toString('base64')}`
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }

  private async resolveOpenAIHttpImages(
    request: OpenAIChatRequest,
    signal?: AbortSignal
  ): Promise<OpenAIChatRequest> {
    await Promise.all(
      request.messages.map(async (message) => {
        if (!Array.isArray(message.content)) return
        await Promise.all(
          message.content.map(async (part) => {
            if (part.type !== 'image_url' || !part.image_url?.url.startsWith('http')) return
            part.image_url.url = await this.downloadImageDataUrl(part.image_url.url, signal)
          })
        )
      })
    )
    return request
  }

  private async resolveClaudeHttpImages(
    request: ClaudeRequest,
    signal?: AbortSignal
  ): Promise<ClaudeRequest> {
    await Promise.all(
      request.messages.map(async (message) => {
        if (!Array.isArray(message.content)) return
        await Promise.all(
          message.content.map(async (block) => {
            if (block.type !== 'image' || block.source?.type !== 'url') return
            const dataUrl = await this.downloadImageDataUrl(block.source.url, signal)
            const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
            if (!match) {
              throw new Error('Downloaded image produced invalid data URL')
            }
            block.source = { type: 'base64', media_type: match[1], data: match[2] }
          })
        )
      })
    )
    return request
  }

  private prepareOpenAIRequest(request: OpenAIChatRequest): OpenAIChatRequest {
    this.validateOpenAICacheControls(request)

    if (this.config.disableTools || request.tool_choice === 'none') {
      return { ...request, tools: undefined, tool_choice: undefined }
    }

    if (
      request.tool_choice &&
      typeof request.tool_choice === 'object' &&
      request.tool_choice.type === 'function' &&
      !request.tool_choice.function?.name
    ) {
      throw new Error('tool_choice function requires a tool name')
    }

    if (
      request.tool_choice &&
      typeof request.tool_choice === 'object' &&
      request.tool_choice.function?.name
    ) {
      const selectedToolName = request.tool_choice.function.name
      if (!request.tools?.some((tool) => tool.function.name === selectedToolName)) {
        throw new Error(`tool_choice references unknown tool: ${selectedToolName}`)
      }
      return {
        ...request,
        tools: request.tools?.filter((tool) => tool.function.name === selectedToolName)
      }
    }

    return request
  }

  private prepareClaudeRequest(request: ClaudeRequest): ClaudeRequest {
    this.validateClaudeCacheControls(request)

    if (this.config.disableTools || request.tool_choice?.type === 'none') {
      return { ...request, tools: undefined, tool_choice: undefined }
    }

    if (request.tool_choice?.type === 'tool' && !request.tool_choice.name) {
      throw new Error('tool_choice tool requires a tool name')
    }

    if (request.tool_choice?.name) {
      const selectedToolName = request.tool_choice.name
      if (!request.tools?.some((tool) => tool.name === selectedToolName)) {
        throw new Error(`tool_choice references unknown tool: ${selectedToolName}`)
      }
      return {
        ...request,
        tools: request.tools?.filter((tool) => tool.name === selectedToolName)
      }
    }

    return request
  }

  // 获取统计信息
  getStats(): ProxyStats {
    // 返回可序列化的统计信息（Map 对象在 IPC 中无法正确序列化）
    return {
      totalRequests: this.stats.totalRequests,
      successRequests: this.stats.successRequests,
      failedRequests: this.stats.failedRequests,
      totalTokens: this.stats.totalTokens,
      totalCredits: this.stats.totalCredits,
      inputTokens: this.stats.inputTokens,
      outputTokens: this.stats.outputTokens,
      cacheReadTokens: this.stats.cacheReadTokens,
      cacheWriteTokens: this.stats.cacheWriteTokens,
      reasoningTokens: this.stats.reasoningTokens,
      startTime: this.stats.startTime,
      accountStats: this.stats.accountStats,
      endpointStats: this.stats.endpointStats,
      modelStats: this.stats.modelStats,
      recentRequests: this.stats.recentRequests
    }
  }

  // 获取账号池
  getAccountPool(): AccountPool {
    return this.accountPool
  }

  // 设置初始累计 credits（用于从持久化存储恢复）
  setTotalCredits(credits: number): void {
    this.stats.totalCredits = credits
  }

  // 重置累计 credits
  resetTotalCredits(): void {
    this.stats.totalCredits = 0
    this.events.onCreditsUpdate?.(0)
  }

  // 设置初始累计 tokens（用于从持久化存储恢复）
  setTotalTokens(inputTokens: number, outputTokens: number): void {
    this.stats.inputTokens = inputTokens
    this.stats.outputTokens = outputTokens
    this.stats.totalTokens = inputTokens + outputTokens
  }

  // 重置累计 tokens
  resetTotalTokens(): void {
    this.stats.inputTokens = 0
    this.stats.outputTokens = 0
    this.stats.totalTokens = 0
  }

  // 设置请求统计（用于从持久化存储恢复）
  setRequestStats(totalRequests: number, successRequests: number, failedRequests: number): void {
    this.stats.totalRequests = totalRequests
    this.stats.successRequests = successRequests
    this.stats.failedRequests = failedRequests
  }

  // 重置请求统计
  resetRequestStats(): void {
    this.stats.totalRequests = 0
    this.stats.successRequests = 0
    this.stats.failedRequests = 0
    this.notifyRequestStatsUpdate()
  }

  // 通知请求统计更新
  private notifyRequestStatsUpdate(): void {
    this.notifyEventSafely(() =>
      this.events.onRequestStatsUpdate?.(
        this.stats.totalRequests,
        this.stats.successRequests,
        this.stats.failedRequests
      )
    )
  }

  private notifyEventSafely(callback: () => void): void {
    try {
      callback()
    } catch {
      proxyLogger.warn('ProxyServer', 'Proxy event hook failed')
    }
  }

  // 记录请求成功
  private recordRequestSuccess(): void {
    this.stats.successRequests++
    this.sessionStats.successRequests++
    this.notifyRequestStatsUpdate()
  }

  // 记录请求失败
  private recordRequestFailed(): void {
    this.stats.failedRequests++
    this.sessionStats.failedRequests++
    this.notifyRequestStatsUpdate()
  }

  // 记录新请求
  private recordNewRequest(): void {
    this.stats.totalRequests++
    this.sessionStats.totalRequests++
    this.notifyRequestStatsUpdate()
  }

  // 获取会话统计（当前服务运行期间的统计）
  getSessionStats(): {
    totalRequests: number
    successRequests: number
    failedRequests: number
    startTime: number
  } {
    return { ...this.sessionStats }
  }

  // 是否运行中
  isRunning(): boolean {
    return this.server !== null
  }

  /** 仅供隔离集成测试读取实际绑定的临时端口。 */
  getListeningPort(): number {
    const address = this.server?.address()
    return typeof address === 'object' && address ? address.port : 0
  }

  private getAbortError(signal?: AbortSignal): Error {
    if (signal?.reason instanceof Error) return signal.reason
    if (signal?.reason) return new Error(String(signal.reason))
    return new Error('Request aborted')
  }

  private isAbortError(error: unknown, signal?: AbortSignal): boolean {
    return (
      signal?.aborted === true ||
      (error instanceof Error &&
        (error.message.includes('Client disconnected') ||
          error.message.includes('Proxy server stopped')))
    )
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw this.getAbortError(signal)
  }

  private throwIfResponseClosed(res: http.ServerResponse, signal?: AbortSignal): void {
    this.throwIfAborted(signal)
    if (res.writableEnded || res.destroyed) throw new Error('Client disconnected')
  }

  private isResponseClosed(res: http.ServerResponse): boolean {
    return res.writableEnded || res.destroyed
  }

  /**
   * SSE 背压：res.write 缓冲打满（writableNeedDrain）时返回等待 drain 的 promise，
   * 上游流解析 await 它暂停拉取，避免慢客户端导致内存无限堆积。
   * 同时监听 close/error，客户端断开时立刻放行（防止 promise 永久挂起）。
   * 缓冲未满时返回 undefined（零开销快路径）。
   */
  private waitForDrain(res: http.ServerResponse): Promise<void> | undefined {
    if (!res.writableNeedDrain || res.destroyed || res.writableEnded) return undefined
    return new Promise<void>((resolve) => {
      const done = (): void => {
        res.off('drain', done)
        res.off('close', done)
        res.off('error', done)
        resolve()
      }
      res.once('drain', done)
      res.once('close', done)
      res.once('error', done)
    })
  }

  // 检测错误消息中是否包含账号被长期封禁的特征
  // 返回 { reason, message } 表示需要标记 suspended；返回 null 表示非封禁错误
  // 覆盖：
  //   - Kiro 后端 HTTP 403 + body: { reason: "TEMPORARILY_SUSPENDED", message: "..." }
  //   - CodeWhisperer AccountSuspendedException
  //   - 423 Locked
  private detectSuspendedError(errMsg: string): { reason: string; message: string } | null {
    if (!errMsg) return null
    if (['TEMPORARILY_SUSPENDED', 'ACCOUNT_SUSPENDED', 'PERMANENTLY_SUSPENDED'].includes(errMsg)) {
      return { reason: errMsg, message: errMsg }
    }

    // 1) 显式 reason: "TEMPORARILY_SUSPENDED" (Kiro 风控)
    const reasonMatch = errMsg.match(
      /"reason"\s*:\s*"(TEMPORARILY_SUSPENDED|ACCOUNT_SUSPENDED|PERMANENTLY_SUSPENDED)"/i
    )
    if (reasonMatch) {
      // 尝试提取 message 字段
      const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]+)"/)
      return { reason: reasonMatch[1].toUpperCase(), message: msgMatch?.[1] || errMsg }
    }

    // 2) 文本特征 "temporarily suspended" / "user id is ... suspended"
    if (
      /User\s+ID\s+is\s+(temporarily\s+)?suspended/i.test(errMsg) ||
      /temporarily\s+suspended/i.test(errMsg)
    ) {
      const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]+)"/)
      return { reason: 'TEMPORARILY_SUSPENDED', message: msgMatch?.[1] || errMsg }
    }

    // 3) AccountSuspendedException (CodeWhisperer)
    if (errMsg.includes('AccountSuspendedException') || errMsg.includes('Account suspended')) {
      const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]+)"/)
      return { reason: 'AccountSuspendedException', message: msgMatch?.[1] || errMsg }
    }

    // 4) HTTP 423 Locked
    if (/\b423\b/.test(errMsg) && /locked|suspended/i.test(errMsg)) {
      return { reason: 'ACCOUNT_LOCKED', message: errMsg }
    }

    return null
  }

  private waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }, ms)
      const abort = () => {
        clearTimeout(timeout)
        reject(this.getAbortError(signal))
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private async abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    this.throwIfAborted(signal)
    if (!signal) return promise
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        const abort = () => reject(this.getAbortError(signal))
        signal.addEventListener('abort', abort, { once: true })
        promise.then(
          () => signal.removeEventListener('abort', abort),
          () => signal.removeEventListener('abort', abort)
        )
      })
    ])
  }

  // 清除模型缓存，强制下次请求重新获取
  clearModelCache(): void {
    this.modelCache = null
    console.log('[ProxyServer] Model cache cleared')
  }

  // 从模型缓存查找指定模型的 thinking 配置
  private getThinkingConfig(modelId: string): ThinkingConfig | undefined {
    if (!this.modelCache) return undefined
    const lower = modelId.toLowerCase()
    const model = this.modelCache.models.find((m) => m.modelId.toLowerCase() === lower)
    if (!model) return undefined
    const schema = extractThinkingSchema(model.additionalModelRequestFieldsSchema)
    if (!schema?.schemaPath || !schema.efforts?.length) return undefined
    return { schemaPath: schema.schemaPath, efforts: schema.efforts }
  }

  // 获取可用模型列表
  private static mapKiroModelToApi(m: KiroModel) {
    return {
      id: m.modelId,
      name: m.modelName,
      description: m.description,
      inputTypes: m.supportedInputTypes,
      maxInputTokens: m.tokenLimits?.maxInputTokens,
      maxOutputTokens: m.tokenLimits?.maxOutputTokens,
      rateMultiplier: m.rateMultiplier,
      rateUnit: m.rateUnit,
      supportsThinking:
        !!(m.additionalModelRequestFieldsSchema?.properties as Record<string, unknown> | undefined)
          ?.thinking ||
        !!(m.additionalModelRequestFieldsSchema?.properties as Record<string, unknown> | undefined)
          ?.output_config,
      thinkingEfforts: extractThinkingSchema(m.additionalModelRequestFieldsSchema)?.efforts,
      thinkingSchemaPath: extractThinkingSchema(m.additionalModelRequestFieldsSchema)?.schemaPath,
      supportsPromptCaching: m.promptCaching?.supportsPromptCaching || false,
      modelProvider: m.modelProvider || undefined
    }
  }

  async getAvailableModels(
    signal?: AbortSignal
  ): Promise<{ models: ReturnType<typeof ProxyServer.mapKiroModelToApi>[]; fromCache: boolean }> {
    const now = Date.now()

    let kiroModels: KiroModel[]
    let fromCache = false

    if (this.modelCache && now - this.modelCache.timestamp < this.MODEL_CACHE_TTL) {
      kiroModels = this.modelCache.models
      fromCache = true
    } else {
      this.throwIfAborted(signal)
      const account = await this.getAvailableAccount(signal)
      this.throwIfAborted(signal)
      if (!account) {
        return { models: [], fromCache: false }
      }

      try {
        kiroModels = await fetchKiroModels(account, signal)
        if (kiroModels.length > 0) {
          this.modelCache = { models: kiroModels, timestamp: now }
          // 同步到 kiroApi 的 ctx cache, 供 token 裁剪逻辑使用
          for (const m of kiroModels) {
            if (m.tokenLimits?.maxInputTokens) {
              setModelContextWindow(m.modelId, m.tokenLimits.maxInputTokens)
            }
          }
        }
      } catch (error) {
        if (this.isAbortError(error, signal)) throw error
        console.error('[ProxyServer] Failed to fetch models:', error)
        return { models: [], fromCache: false }
      }
    }

    // 合并隐藏模型（与 /v1/models 端点一致）
    const modelIds = new Set(kiroModels.map((m) => m.modelId))
    const hiddenModels: KiroModel[] = [
      {
        modelId: 'claude-3.7-sonnet',
        modelName: 'Claude 3.7 Sonnet',
        description: 'Claude 3.7 Sonnet (hidden)',
        supportedInputTypes: ['TEXT', 'IMAGE'],
        tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 }
      } as KiroModel,
      {
        modelId: 'simple-task',
        modelName: 'Simple Task',
        description: 'Kiro fast model (routes to Haiku)',
        supportedInputTypes: ['TEXT'],
        tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 4096 }
      } as KiroModel,
      {
        modelId: 'CLAUDE_SONNET_4_20250514_V1_0',
        modelName: 'Claude Sonnet 4 (CW)',
        description: 'CodeWhisperer internal ID',
        supportedInputTypes: ['TEXT', 'IMAGE'],
        tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 }
      } as KiroModel,
      {
        modelId: 'CLAUDE_HAIKU_4_5_20251001_V1_0',
        modelName: 'Claude Haiku 4.5 (CW)',
        description: 'CodeWhisperer internal ID',
        supportedInputTypes: ['TEXT', 'IMAGE'],
        tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 }
      } as KiroModel,
      {
        modelId: 'CLAUDE_3_7_SONNET_20250219_V1_0',
        modelName: 'Claude 3.7 Sonnet (CW)',
        description: 'CodeWhisperer internal ID',
        supportedInputTypes: ['TEXT', 'IMAGE'],
        tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 }
      } as KiroModel
    ]
    const merged = [...kiroModels, ...hiddenModels.filter((m) => !modelIds.has(m.modelId))]

    return { models: merged.map(ProxyServer.mapKiroModelToApi), fromCache }
  }

  // 检查 Token 是否需要刷新
  private isTokenExpiringSoon(account: ProxyAccount): boolean {
    if (isKiroApiKeyAccount(account) || !account.expiresAt) return false
    const refreshBeforeMs = (this.config.tokenRefreshBeforeExpiry || 300) * 1000
    return Date.now() + refreshBeforeMs >= account.expiresAt
  }

  // 刷新 Token
  private async refreshToken(account: ProxyAccount, signal?: AbortSignal): Promise<boolean> {
    this.throwIfAborted(signal)
    if (isKiroApiKeyAccount(account)) {
      this.accountPool.updateAccount(account.id, { isAvailable: false })
      return false
    }
    if (!this.events.onTokenRefresh) {
      console.warn('[ProxyServer] No token refresh callback configured')
      return false
    }

    // 并发去重：等待在途刷新并复用其真实结果。
    // 旧实现固定等 1 秒后按过期时间"猜"结果，慢刷新（网络抖动/慢代理）会被误判失败导致多余切号。
    const existing = this.refreshingTokens.get(account.id)
    if (existing) {
      console.log(
        `[ProxyServer] Token refresh already in progress for ${account.email || account.id}, awaiting result`
      )
      try {
        return await this.abortable(existing, signal)
      } catch {
        // 只有"本请求自己"被中止才向上抛；在途刷新因发起方中止/失败时，对本请求按刷新失败处理
        if (signal?.aborted) throw this.getAbortError(signal)
        return false
      }
    }

    const task = this.doRefreshToken(account, signal)
    this.refreshingTokens.set(account.id, task)
    try {
      return await task
    } finally {
      this.refreshingTokens.delete(account.id)
    }
  }

  /** 实际执行 Token 刷新（由 refreshToken 包裹在途去重后调用） */
  private async doRefreshToken(account: ProxyAccount, signal?: AbortSignal): Promise<boolean> {
    console.log(`[ProxyServer] Refreshing token for ${account.email || account.id}`)

    try {
      // 随机延迟 0-3 秒，避免多账号同时刷新被识别为批量操作
      const jitter = Math.floor(Math.random() * 3000)
      if (jitter > 0) await this.waitForRetry(jitter, signal)

      const result = await this.abortable(this.events.onTokenRefresh!(account), signal)
      if (result.success && result.accessToken) {
        // 更新账号池中的 Token
        this.accountPool.updateAccount(account.id, {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken || account.refreshToken,
          expiresAt: result.expiresAt,
          credentialRevision: result.credentialRevision
        })
        // 通知外部更新
        this.events.onAccountUpdate?.({
          ...account,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken || account.refreshToken,
          expiresAt: result.expiresAt,
          credentialRevision: result.credentialRevision
        })
        console.log(`[ProxyServer] Token refreshed for ${account.email || account.id}`)
        return true
      } else {
        console.error(
          `[ProxyServer] Token refresh failed for ${account.email || account.id}: ${result.error}`
        )
        this.accountPool.markNeedsRefresh(account.id)
        this.events.onTokenRefreshFailed?.(account.id)
        return false
      }
    } catch (error) {
      if (this.isAbortError(error, signal)) throw error
      console.error(`[ProxyServer] Token refresh error for ${account.email || account.id}:`, error)
      this.accountPool.markNeedsRefresh(account.id)
      this.events.onTokenRefreshFailed?.(account.id)
      return false
    }
  }

  /**
   * 计算 API Key 允许使用的账号 ID 集合（P2-21）
   * 返回 undefined = 不限制（允许所有账号）
   */
  private getAllowedAccountIds(apiKeyId?: string): Set<string> | undefined {
    if (!apiKeyId) return undefined
    const bindings = this.config.apiKeyAccountBindings?.[apiKeyId]
    if (!bindings || bindings.length === 0) return undefined
    return new Set(bindings)
  }

  // 获取可用账号（包含 Token 刷新检查）
  // P1-8 sessionHint：相同会话尽量复用同一账号（命中 prompt cache + 防风控）
  // P2-21 apiKeyId：用于过滤 API Key 允许使用的账号子集
  private isAccountAllowed(account: ProxyAccount, apiKeyId?: string): boolean {
    const allowedIds = this.getAllowedAccountIds(apiKeyId)
    if (allowedIds && !allowedIds.has(account.id)) return false
    if (this.config.multiAccountSelectionMode === 'groups') {
      const allowedGroups = new Set(this.config.multiAccountGroupIds || [])
      if (!allowedGroups.has(account.groupId || '__ungrouped__')) return false
    }
    return (
      account.isAvailable !== false &&
      !this.accountPool.isSuspended(account) &&
      !this.accountPool.isQuotaExhausted(account) &&
      (!account.cooldownUntil || account.cooldownUntil <= Date.now())
    )
  }

  private getScopedNextAccount(
    apiKeyId?: string,
    excludeIds: Set<string> = new Set()
  ): ProxyAccount | null {
    const candidates = this.accountPool
      .getAllAccounts()
      .filter((account) => !excludeIds.has(account.id) && this.isAccountAllowed(account, apiKeyId))
    if (!candidates.length) return null

    if (!this.config.enableMultiAccount) {
      const selectedId = this.config.selectedAccountIds?.[0]
      const selected = selectedId
        ? candidates.find((account) => account.id === selectedId)
        : undefined
      if (selected) return selected
      return this.config.autoSwitchOnQuotaExhausted || !selectedId ? candidates[0] : null
    }

    const excluded = new Set(
      this.accountPool
        .getAllAccounts()
        .filter((account) => !candidates.some((candidate) => candidate.id === account.id))
        .map((account) => account.id)
    )
    for (const id of excludeIds) excluded.add(id)
    const selected = this.accountPool.getNextAccount(excluded)
    return selected && candidates.some((candidate) => candidate.id === selected.id)
      ? selected
      : candidates[0]
  }

  private recordUpstreamAccountErrorOnce(account: { id: string }, error: Error): void {
    let recordedAccountIds = this.accountedUpstreamErrors.get(error)
    if (!recordedAccountIds) {
      recordedAccountIds = new Set()
      this.accountedUpstreamErrors.set(error, recordedAccountIds)
    }
    if (recordedAccountIds.has(account.id)) return
    recordedAccountIds.add(account.id)

    const upstreamError = normalizeKiroUpstreamError(error)
    const statusCode =
      upstreamError.retryCategory === UpstreamRetryCategory.AUTHENTICATION
        ? 401
        : upstreamError.statusCode || 500
    this.accountPool.recordError(
      account.id,
      classifyError(statusCode, upstreamError.reason || upstreamError.code),
      isMonthlyRequestQuotaError(upstreamError) ? 402 : undefined
    )
  }

  private getTerminalRetryFailure(
    error: Error,
    fallbackAccount: ProxyAccount
  ): { account: ProxyAccount; error: Error } {
    if (error instanceof RetryExhaustedError) {
      return {
        account: this.accountPool.getAccount(error.accountId) || fallbackAccount,
        error: error.upstreamError
      }
    }
    return { account: fallbackAccount, error }
  }

  private async getAvailableAccount(
    signal?: AbortSignal,
    sessionHint?: string,
    apiKeyId?: string
  ): Promise<ProxyAccount | null> {
    this.throwIfAborted(signal)
    if (this.accountPool.size === 0 && this.events.onPoolEmpty) {
      await this.abortable(this.events.onPoolEmpty(), signal)
    }
    this.throwIfAborted(signal)

    if (this.config.sessionAffinityEnabled && sessionHint) {
      const sticky = this.pickAccountWithAffinity(sessionHint)
      if (sticky && this.isAccountAllowed(sticky, apiKeyId)) {
        if (!this.isTokenExpiringSoon(sticky)) return sticky
        if (await this.refreshToken(sticky, signal)) {
          return this.accountPool.getAccount(sticky.id) || sticky
        }
      }
    }

    let account = this.getScopedNextAccount(apiKeyId)
    if (!account) return null

    if (this.isTokenExpiringSoon(account)) {
      if (await this.refreshToken(account, signal)) {
        account = this.accountPool.getAccount(account.id) || account
      } else {
        account = this.getScopedNextAccount(apiKeyId, new Set([account.id]))
        if (!account) return null
      }
    }

    if (sessionHint) this.rememberAffinity(sessionHint, account.id)
    return account
  }

  // 带重试的 API 调用
  private async getStreamRetryAccount(
    currentAccount: ProxyAccount,
    error: Error,
    apiKeyId: string | undefined,
    state: { triedIds: Set<string>; refreshedAccountIds: Set<string> },
    signal?: AbortSignal
  ): Promise<ProxyAccount | null> {
    const upstreamError = normalizeKiroUpstreamError(error)
    const canSwitch = this.config.enableMultiAccount || this.config.autoSwitchOnQuotaExhausted
    if (
      !canSwitch ||
      (upstreamError.retryCategory !== UpstreamRetryCategory.AUTHENTICATION &&
        !isMonthlyRequestQuotaError(upstreamError))
    ) {
      return null
    }

    if (
      upstreamError.retryCategory === UpstreamRetryCategory.AUTHENTICATION &&
      !isKiroApiKeyAccount(currentAccount) &&
      !state.refreshedAccountIds.has(currentAccount.id)
    ) {
      state.refreshedAccountIds.add(currentAccount.id)
      if (await this.refreshToken(currentAccount, signal)) {
        return this.accountPool.getAccount(currentAccount.id) || currentAccount
      }
    }

    if (
      upstreamError.retryCategory === UpstreamRetryCategory.AUTHENTICATION &&
      isKiroApiKeyAccount(currentAccount)
    ) {
      this.accountPool.updateAccount(currentAccount.id, { isAvailable: false })
    }
    this.recordUpstreamAccountErrorOnce(currentAccount, error)

    state.triedIds.add(currentAccount.id)
    const nextAccount = this.getScopedNextAccount(apiKeyId, state.triedIds)
    if (nextAccount && !this.config.enableMultiAccount) {
      this.config.selectedAccountIds = [nextAccount.id]
      this.events.onAccountUpdate?.(nextAccount)
    }
    return nextAccount
  }

  private async callWithRetry<T>(
    account: ProxyAccount,
    apiCall: (acc: ProxyAccount, endpointIndex: number) => Promise<T>,
    _path: string,
    signal?: AbortSignal,
    apiKeyId?: string
  ): Promise<{ result: T; account: ProxyAccount }> {
    const maxRetries = this.config.maxRetries || 3
    const retryDelay = this.config.retryDelayMs || 1000
    let lastError: Error | null = null
    let currentAccount = account
    let endpointIndex = 0
    // 本次请求累计已尝试的账号 ID，避免重试时循环命中已经失败过的账号
    const triedIds = new Set<string>([account.id])
    /** 初选与重试共用同一 API Key/分组范围，避免重试越权到未绑定账号。 */
    const switchToNextAccount = (): ProxyAccount | null =>
      this.getScopedNextAccount(apiKeyId, triedIds)

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      this.throwIfAborted(signal)
      try {
        const result = await apiCall(currentAccount, endpointIndex)
        return { result, account: currentAccount }
      } catch (error) {
        if (this.isAbortError(error, signal)) throw error
        lastError = error instanceof Error ? error : new Error('Upstream Kiro API request failed')
        const upstreamError = normalizeKiroUpstreamError(lastError)
        const errMsg = upstreamError.message

        console.log(
          `[ProxyServer] API call failed (attempt ${attempt + 1}/${maxRetries}): HTTP ${upstreamError.statusCode || 'unknown'}`
        )

        // 优先检测账号被长期封禁（不是 token 问题，刷新也没用）
        // 特征：HTTP 403 + reason: "TEMPORARILY_SUSPENDED" 或 AccountSuspendedException / 423
        const suspendInfo = this.detectSuspendedError(
          upstreamError.reason || upstreamError.code || errMsg
        )
        if (suspendInfo) {
          const newlyMarked = this.accountPool.markSuspended(
            currentAccount.id,
            suspendInfo.reason,
            suspendInfo.message
          )
          if (newlyMarked) {
            this.events.onAccountSuspended?.({
              accountId: currentAccount.id,
              email: currentAccount.email,
              reason: suspendInfo.reason,
              message: suspendInfo.message
            })
            this.appendAuditLog('account_suspended', {
              accountId: currentAccount.id,
              email: currentAccount.email,
              reason: suspendInfo.reason
            })
          }
          console.warn(
            `[ProxyServer] Account ${currentAccount.email || currentAccount.id} suspended (${suspendInfo.reason}), switching to next available account`
          )
          // 切到下个可用账号（跳过被 suspended 的 + 本请求已试过的）
          const nextAccount = switchToNextAccount()
          if (nextAccount && !triedIds.has(nextAccount.id)) {
            currentAccount = nextAccount
            triedIds.add(nextAccount.id)
            if (!this.config.enableMultiAccount) {
              this.config.selectedAccountIds = [nextAccount.id]
              this.events.onAccountUpdate?.(nextAccount)
            }
            continue
          }
          // 无可切换的账号 → 直接抛出错误给客户端
          break
        }

        // 401/403: 尝试刷新 Token
        if (upstreamError.retryCategory === UpstreamRetryCategory.AUTHENTICATION) {
          if (isKiroApiKeyAccount(currentAccount)) {
            this.accountPool.updateAccount(currentAccount.id, { isAvailable: false })
          } else {
            console.log('[ProxyServer] Auth error, attempting token refresh')
            const refreshed = await this.refreshToken(currentAccount, signal)
            if (refreshed) {
              currentAccount = this.accountPool.getAccount(currentAccount.id) || currentAccount
              continue
            }
          }
          // 认证失败或刷新失败 → 记账一次并切到没试过的下个账号。
          this.recordUpstreamAccountErrorOnce(currentAccount, lastError)
          const nextAccount = switchToNextAccount()
          if (nextAccount && !triedIds.has(nextAccount.id)) {
            currentAccount = nextAccount
            triedIds.add(nextAccount.id)
            continue
          }
        }

        // 仅明确的月请求额度耗尽才隔离账号；其他 402 不改变账号状态。
        if (upstreamError.retryCategory === UpstreamRetryCategory.MONTHLY_QUOTA) {
          this.recordUpstreamAccountErrorOnce(currentAccount, lastError)
          endpointIndex = (endpointIndex + 1) % 2
          if (endpointIndex === 0) {
            const nextAccount = switchToNextAccount()
            if (nextAccount && !triedIds.has(nextAccount.id)) {
              currentAccount = nextAccount
              triedIds.add(nextAccount.id)
              if (!this.config.enableMultiAccount) {
                this.config.selectedAccountIds = [nextAccount.id]
                this.events.onAccountUpdate?.(nextAccount)
              }
            }
          }
          continue
        }

        if (upstreamError.statusCode === 402) break

        if (upstreamError.retryCategory === UpstreamRetryCategory.RATE_LIMIT) {
          this.recordUpstreamAccountErrorOnce(currentAccount, lastError)
          await this.waitForRetry(
            Math.min(
              upstreamError.retryAfterMs ?? retryDelay * (attempt + 1),
              WEB_SEARCH_RETRY_MAX_MS
            ),
            signal
          )
          continue
        }

        // 5xx: 同账号短退避重试一次；再次 5xx 直接 fallback 到没试过的账号（瞬时故障跨账号绕过）
        if (upstreamError.retryCategory === UpstreamRetryCategory.TRANSIENT) {
          console.log('[ProxyServer] Server error, retrying')
          // 第二次及以后的 5xx → 切换账号（旧逻辑会同账号撞死）
          if (attempt > 0) {
            const nextAccount = switchToNextAccount()
            if (nextAccount && !triedIds.has(nextAccount.id)) {
              console.log(
                `[ProxyServer] Persistent 5xx on ${currentAccount.email || currentAccount.id.slice(0, 8)}, switching account`
              )
              currentAccount = nextAccount
              triedIds.add(nextAccount.id)
              continue
            }
          }
          await this.waitForRetry(retryDelay * (attempt + 1), signal)
          continue
        }

        // 其他错误，不重试
        break
      }
    }

    throw new RetryExhaustedError(lastError || new Error('Unknown error'), currentAccount.id)
  }

  /**
   * 常数时间字符串比较（防时序攻击）
   * 长度不同时返回 false 但仍走一次 timingSafeEqual 防止旁路
   */
  private safeStringEq(a: string, b: string): boolean {
    // Buffer.from 处理 UTF-8 编码
    const ab = Buffer.from(a, 'utf8')
    const bb = Buffer.from(b, 'utf8')
    if (ab.length !== bb.length) {
      // 仍执行一次比较保证常数时间（用 a 自身比，结果不影响）
      try {
        crypto.timingSafeEqual(ab, ab)
      } catch {
        /* ignore */
      }
      return false
    }
    try {
      return crypto.timingSafeEqual(ab, bb)
    } catch {
      return false
    }
  }

  // 验证 API Key 并返回匹配的 Key（用于统计）
  // P0-3 使用 timingSafeEqual 防止时序攻击逐字猜 Key
  private extractProvidedApiKey(req: http.IncomingMessage): string {
    const authHeader = req.headers.authorization || ''
    const apiKeyHeader = req.headers['x-api-key']
    if (authHeader.startsWith('Bearer ')) return authHeader.slice(7)
    return typeof apiKeyHeader === 'string' ? apiKeyHeader : ''
  }

  private validateAdminApiKey(req: http.IncomingMessage): boolean {
    const configuredKey = this.config.adminApiKey
    const providedKey = this.extractProvidedApiKey(req)
    return !!configuredKey && !!providedKey && this.safeStringEq(configuredKey, providedKey)
  }

  private validateApiKey(req: http.IncomingMessage): {
    valid: boolean
    apiKey?: import('./types').ApiKey
    reason?: string
  } {
    // 如果没有配置任何业务 API Key，则跳过业务路由验证。
    // 管理员密钥绝不计入这里，避免管理员凭证获得业务代理权限。
    const hasApiKeys = this.config.apiKeys && this.config.apiKeys.length > 0
    const hasLegacyKey = !!this.config.apiKey
    if (!hasApiKeys && !hasLegacyKey) return { valid: true }

    const providedKey = this.extractProvidedApiKey(req)
    if (!providedKey) return { valid: false }

    if (hasApiKeys) {
      let matched: import('./types').ApiKey | undefined
      for (const k of this.config.apiKeys!) {
        if (!k.enabled || !k.key) continue
        if (this.safeStringEq(k.key, providedKey)) matched = k
      }
      if (matched) {
        if (matched.creditsLimit && matched.usage.totalCredits >= matched.creditsLimit) {
          return { valid: false, reason: 'Credits limit exceeded' }
        }
        return { valid: true, apiKey: matched }
      }
    }

    if (hasLegacyKey && this.safeStringEq(this.config.apiKey!, providedKey)) return { valid: true }
    return { valid: false }
  }

  /**
   * P0-4 IP 访问控制
   * - deniedIPs 优先：命中即拒绝
   * - allowedIPs 配置后：必须在列表内（白名单模式）
   * - 都未配置：允许
   * 支持单 IP 和 CIDR（IPv4 / IPv6 简化处理）
   */
  private isClientIPAllowed(clientIP: string): { allowed: boolean; reason?: string } {
    if (!clientIP) return { allowed: true }
    // 规范化（::ffff:1.2.3.4 → 1.2.3.4）
    const ip = clientIP.startsWith('::ffff:') ? clientIP.slice(7) : clientIP

    const matchEntry = (entry: string): boolean => {
      const e = entry.trim()
      if (!e) return false
      // CIDR
      if (e.includes('/')) {
        return this.ipInCidr(ip, e)
      }
      return e === ip
    }

    const denied = this.config.deniedIPs?.find(matchEntry)
    if (denied) return { allowed: false, reason: `IP ${ip} matches denied entry ${denied}` }

    const allowList = this.config.allowedIPs
    if (allowList && allowList.length > 0) {
      const allowed = allowList.some(matchEntry)
      if (!allowed) return { allowed: false, reason: `IP ${ip} not in allowed list` }
    }
    return { allowed: true }
  }

  /**
   * 简化 IPv4/IPv6 CIDR 匹配（不依赖外部库）
   * IPv4 CIDR：1.2.3.0/24；IPv6 CIDR：仅前缀逐 bit 比较
   */
  private ipInCidr(ip: string, cidr: string): boolean {
    const [range, bitsStr] = cidr.split('/')
    const bits = parseInt(bitsStr, 10)
    if (!Number.isFinite(bits)) return false

    const isV4 = ip.includes('.') && range.includes('.')
    if (isV4) {
      const ipNum = this.ipv4ToInt(ip)
      const rangeNum = this.ipv4ToInt(range)
      if (ipNum < 0 || rangeNum < 0) return false
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
      return (ipNum & mask) === (rangeNum & mask)
    }
    // IPv6 简化：转字节数组 + 前缀逐 bit 比较
    const ipBytes = this.ipv6ToBytes(ip)
    const rangeBytes = this.ipv6ToBytes(range)
    if (!ipBytes || !rangeBytes) return false
    let bitsLeft = bits
    for (let i = 0; i < 16 && bitsLeft > 0; i++) {
      if (bitsLeft >= 8) {
        if (ipBytes[i] !== rangeBytes[i]) return false
        bitsLeft -= 8
      } else {
        const mask = (0xff << (8 - bitsLeft)) & 0xff
        if ((ipBytes[i] & mask) !== (rangeBytes[i] & mask)) return false
        bitsLeft = 0
      }
    }
    return true
  }

  private ipv4ToInt(ip: string): number {
    const parts = ip.split('.').map((p) => parseInt(p, 10))
    if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return -1
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  }

  private ipv6ToBytes(ip: string): Uint8Array | null {
    try {
      // 简化处理：支持 :: 缩写
      const parts = ip.split('::')
      let head: string[] = []
      let tail: string[] = []
      if (parts.length === 1) {
        head = parts[0].split(':')
      } else if (parts.length === 2) {
        head = parts[0] ? parts[0].split(':') : []
        tail = parts[1] ? parts[1].split(':') : []
      } else {
        return null
      }
      const missing = 8 - head.length - tail.length
      if (missing < 0) return null
      const segments = [...head, ...new Array(missing).fill('0'), ...tail]
      const bytes = new Uint8Array(16)
      for (let i = 0; i < 8; i++) {
        const v = parseInt(segments[i] || '0', 16)
        if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null
        bytes[i * 2] = (v >> 8) & 0xff
        bytes[i * 2 + 1] = v & 0xff
      }
      return bytes
    } catch {
      return null
    }
  }

  /** 取客户端真实 IP（不信任 X-Forwarded-For，仅取 socket address） */
  private getClientIP(req: http.IncomingMessage): string {
    return req.socket.remoteAddress || ''
  }

  // 记录 API Key 用量
  recordApiKeyUsage(
    apiKeyId: string,
    credits: number,
    inputTokens: number,
    outputTokens: number,
    model?: string,
    path?: string
  ): void {
    if (!this.config.apiKeys) return
    const apiKey = this.config.apiKeys.find((k) => k.id === apiKeyId)
    if (!apiKey) return

    const today = new Date().toISOString().split('T')[0]
    const now = Date.now()

    apiKey.usage.totalRequests++
    apiKey.usage.totalCredits += credits
    apiKey.usage.totalInputTokens += inputTokens
    apiKey.usage.totalOutputTokens += outputTokens
    apiKey.lastUsedAt = now

    if (!apiKey.usage.daily[today]) {
      apiKey.usage.daily[today] = { requests: 0, credits: 0, inputTokens: 0, outputTokens: 0 }
    }
    apiKey.usage.daily[today].requests++
    apiKey.usage.daily[today].credits += credits
    apiKey.usage.daily[today].inputTokens += inputTokens
    apiKey.usage.daily[today].outputTokens += outputTokens

    if (model) {
      if (!apiKey.usage.byModel) {
        apiKey.usage.byModel = {}
      }
      if (!apiKey.usage.byModel[model]) {
        apiKey.usage.byModel[model] = { requests: 0, credits: 0, inputTokens: 0, outputTokens: 0 }
      }
      apiKey.usage.byModel[model].requests++
      apiKey.usage.byModel[model].credits += credits
      apiKey.usage.byModel[model].inputTokens += inputTokens
      apiKey.usage.byModel[model].outputTokens += outputTokens
    }

    if (!apiKey.usageHistory) {
      apiKey.usageHistory = []
    }
    apiKey.usageHistory.unshift({
      timestamp: now,
      model: model || 'unknown',
      inputTokens,
      outputTokens,
      credits,
      path: path || 'unknown'
    })
    if (apiKey.usageHistory.length > 100) {
      apiKey.usageHistory = apiKey.usageHistory.slice(0, 100)
    }

    this.notifyEventSafely(() => this.events.onConfigChanged?.(this.config))
  }

  // 应用模型映射
  private applyModelMapping(requestedModel: string, apiKeyId?: string): string {
    const mappings = this.config.modelMappings
    if (!mappings || mappings.length === 0) return requestedModel

    // 按优先级排序（数字越小优先级越高）
    const sortedMappings = [...mappings].sort((a, b) => a.priority - b.priority)

    for (const rule of sortedMappings) {
      // 检查规则是否启用
      if (!rule.enabled) continue

      // 检查是否适用于当前 API Key
      if (rule.apiKeyIds && rule.apiKeyIds.length > 0 && apiKeyId) {
        if (!rule.apiKeyIds.includes(apiKeyId)) continue
      }

      // 检查源模型是否匹配（支持通配符 *）
      const sourcePattern = rule.sourceModel.replace(/\*/g, '.*')
      const regex = new RegExp(`^${sourcePattern}$`, 'i')
      if (!regex.test(requestedModel)) continue

      // 匹配成功，根据类型选择目标模型
      const validTargets = rule.targetModels.filter((t) => t.trim())
      if (validTargets.length === 0) continue

      let targetModel: string

      if (rule.type === 'loadbalance' && validTargets.length > 1) {
        // 负载均衡：根据权重随机选择
        const weights = rule.weights || validTargets.map(() => 1)
        const totalWeight = weights.reduce((a, b) => a + b, 0)
        let random = Math.random() * totalWeight
        let selectedIndex = 0
        for (let i = 0; i < weights.length; i++) {
          random -= weights[i]
          if (random <= 0) {
            selectedIndex = i
            break
          }
        }
        targetModel = validTargets[selectedIndex]
      } else {
        // replace 或 alias：直接使用第一个目标
        targetModel = validTargets[0]
      }

      proxyLogger.info(
        'ProxyServer',
        `Model mapping applied: ${requestedModel} -> ${targetModel} (rule: ${rule.name}, type: ${rule.type})`
      )
      return targetModel
    }

    return requestedModel
  }

  /**
   * 检测并暴露「内置模型降级」：客户端点的模型被 MODEL_ID_MAP 静默换成了另一个模型时，
   * 加响应头 + warn 日志，避免客户端以为自己在用 gpt-4 / claude-3-opus。
   *
   * 与 applyModelMapping（用户显式配置的映射规则）区分：那是用户自己配的，已有 info 日志；
   * 这里针对的是代码内置、用户无从得知的兜底替换。
   *
   * 必须在任何 writeHead 之前调用（setHeader 会被 writeHead 合并，不会丢）。
   */
  private annotateModelRemap(res: http.ServerResponse, requestedModel: string): void {
    if (!requestedModel) return
    const remap = detectModelRemap(requestedModel, mapModelId(requestedModel))
    if (!remap) return
    try {
      if (!res.headersSent) res.setHeader(MODEL_REMAP_HEADER, `${remap.from} -> ${remap.to}`)
    } catch {
      /* 头已发送/连接已断，不影响主流程 */
    }
    proxyLogger.warn(
      'ProxyServer',
      `Model remapped: "${remap.from}" -> "${remap.to}" (built-in fallback, client not notified via body)`
    )
  }

  // 处理请求
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rawUrl = req.url || '/'
    let path = '/'
    const method = req.method || 'GET'
    const clientIP = this.getClientIP(req)
    const controller = new AbortController()
    const abortRequest = () => {
      if (!this.isStopping && res.writableEnded) return
      if (!controller.signal.aborted)
        controller.abort(
          new Error(this.isStopping ? 'Proxy server stopped' : 'Client disconnected')
        )
    }
    this.activeRequests.add(controller)
    req.on('aborted', abortRequest)
    res.on('close', abortRequest)

    try {
      this.setCorsHeaders(res)
      try {
        path = new URL(rawUrl, 'http://proxy.local').pathname
      } catch {
        this.sendError(res, 400, 'Bad Request')
        return
      }

      // 所有请求均先通过 IP 闸门，避免 OPTIONS/管理路径绕过。
      const ipCheck = this.isClientIPAllowed(clientIP)
      if (!ipCheck.allowed) {
        proxyLogger.warn('ProxyServer', `Blocked request from ${clientIP}: ${ipCheck.reason}`)
        this.appendAuditLog('ip_blocked', { ip: clientIP, path, reason: ipCheck.reason })
        this.sendError(res, 403, 'Forbidden')
        return
      }

      if (method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      const isAdminPath = path.startsWith('/admin/')
      if (path !== '/health' && path !== '/') {
        if (isAdminPath) {
          // Admin API 一律 fail-closed：未配置和错误凭证响应完全一致。
          if (!this.validateAdminApiKey(req)) {
            this.sendError(res, 401, 'Unauthorized')
            return
          }
          const adminRateLimit = this.checkRateLimit(ADMIN_RATE_LIMIT_BUCKET)
          if (!adminRateLimit.allowed) {
            res.setHeader('Retry-After', String(Math.ceil(adminRateLimit.retryAfterMs / 1000)))
            res.setHeader('X-RateLimit-Limit', String(this.config.rateLimitPerKeyPerMinute || 0))
            res.setHeader('X-RateLimit-Remaining', '0')
            this.sendError(res, 429, 'Rate limit exceeded')
            return
          }
        } else {
          const authResult = this.validateApiKey(req)
          if (!authResult.valid) {
            const errorMsg = authResult.reason || 'Invalid or missing API key'
            const statusCode = authResult.reason === 'Credits limit exceeded' ? 429 : 401
            this.sendError(
              res,
              statusCode,
              statusCode === 401 ? 'Unauthorized' : errorMsg,
              this.isAnthropicPath(path) ? 'anthropic' : 'openai'
            )
            return
          }
          ;(req as unknown as { matchedApiKey?: import('./types').ApiKey }).matchedApiKey =
            authResult.apiKey

          const rateLimitId = authResult.apiKey
            ? `${API_KEY_RATE_LIMIT_PREFIX}${authResult.apiKey.id}`
            : `${IP_RATE_LIMIT_PREFIX}${clientIP || 'unknown'}`
          const rl = this.checkRateLimit(rateLimitId)
          if (!rl.allowed) {
            res.setHeader('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)))
            res.setHeader('X-RateLimit-Limit', String(this.config.rateLimitPerKeyPerMinute || 0))
            res.setHeader('X-RateLimit-Remaining', '0')
            this.sendError(
              res,
              429,
              'Rate limit exceeded',
              this.isAnthropicPath(path) ? 'anthropic' : 'openai'
            )
            return
          }
        }
      }

      if (this.config.logRequests) proxyLogger.info('ProxyServer', `${method} ${path}`)

      const isClaudeCodePath = path === '/cc/v1/messages' || path === '/cc/v1/messages/count_tokens'
      if (isClaudeCodePath && method !== 'POST') {
        res.setHeader('Allow', 'POST')
        this.sendError(res, 405, 'Method not allowed', 'anthropic')
        return
      }

      if (path === '/v1/models' || path === '/models') {
        await this.handleModels(res, controller.signal)
      } else if (path === '/v1/chat/completions' || path === '/chat/completions') {
        await this.handleOpenAIChat(req, res, controller.signal)
      } else if (path === '/v1/responses' || path === '/responses') {
        await this.handleOpenAIResponses(req, res, controller.signal)
      } else if (
        path === '/v1/messages' ||
        path === '/messages' ||
        path === '/anthropic/v1/messages' ||
        path === '/cc/v1/messages'
      ) {
        await this.handleClaudeMessages(req, res, controller.signal, path === '/cc/v1/messages')
      } else if (
        path === '/v1/messages/count_tokens' ||
        path === '/messages/count_tokens' ||
        path === '/cc/v1/messages/count_tokens'
      ) {
        await this.handleCountTokens(req, res, controller.signal)
      } else if (path === '/api/event_logging/batch') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      } else if (path.startsWith('/v1beta/models/')) {
        await this.handleGeminiRequest(req, res, path, controller.signal)
      } else if (path === '/v1beta/models') {
        await this.handleGeminiModels(res, controller.signal)
      } else if (path === '/health' || path === '/') {
        this.handleHealth(res)
      } else if (path === '/metrics' && this.config.enableMetrics) {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
        res.end(this.renderPrometheusMetrics())
      } else if (isAdminPath) {
        await this.handleAdminApi(req, res, path, controller.signal)
      } else {
        console.log(`[ProxyServer] Unknown path: ${path} (method: ${method})`)
        this.sendError(res, 404, `Not Found: ${path}`)
      }
    } catch (error) {
      if (this.isAbortError(error, controller.signal)) {
        proxyLogger.info('ProxyServer', `Request aborted: ${method} ${path}`)
        return
      }
      if (error instanceof BodyTooLargeError) {
        proxyLogger.warn(
          'ProxyServer',
          `Body too large from ${clientIP}: ${error.received}/${error.limit} bytes (${path})`
        )
        this.sendError(
          res,
          413,
          `Request body too large (max ${error.limit} bytes)`,
          this.isAnthropicPath(path) ? 'anthropic' : 'openai'
        )
        return
      }
      console.error('[ProxyServer] Request error:', error)
      this.sendError(
        res,
        500,
        'Internal server error',
        this.isAnthropicPath(path) ? 'anthropic' : 'openai'
      )
      this.events.onError?.(error as Error)
    } finally {
      req.off('aborted', abortRequest)
      res.off('close', abortRequest)
      this.activeRequests.delete(controller)
    }
  }

  // 管理 API 端点
  private async handleAdminApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    signal?: AbortSignal
  ): Promise<void> {
    const method = req.method || 'GET'

    // 鉴权和独立限流已在 handleRequest 完成，避免普通 API Key 访问管理面。
    if (path === '/admin/stats' && method === 'GET') {
      this.handleAdminStats(res)
    } else if (path === '/admin/accounts' && method === 'GET') {
      this.handleAdminAccounts(res)
    } else if (path === '/admin/config' && method === 'GET') {
      this.handleAdminConfig(res)
    } else if (path === '/admin/config' && method === 'POST') {
      const body = await this.readBody(req, signal)
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(body)
      } catch {
        this.sendError(res, 400, 'Invalid JSON body')
        return
      }
      const safeUpdate = this.filterAdminConfigUpdate(parsed)
      this.updateConfig(safeUpdate)
      this.appendAuditLog('config_updated', { fields: Object.keys(safeUpdate) })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          success: true,
          applied: Object.keys(safeUpdate),
          config: this.handleAdminConfigPayload()
        })
      )
    } else if (path === '/admin/audit' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ entries: this.auditLog.slice(-100) }))
    } else if (path === '/admin/logs' && method === 'GET') {
      this.handleAdminLogs(res)
    } else if (path === '/admin/cache/clear' && method === 'POST') {
      const { clearAllCaches } = require('./kiroApi')
      const cleared = clearAllCaches()
      const promptCacheCleared = promptCacheTracker.clear()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({ success: true, cleared: { ...cleared, promptCache: promptCacheCleared } })
      )
    } else {
      this.sendError(res, 404, 'Admin endpoint not found')
    }
  }

  // 管理 API - 详细统计
  private handleAdminStats(res: http.ServerResponse): void {
    const stats = this.getStats()
    const accountStats: Record<string, unknown> = {}
    stats.accountStats.forEach((v, k) => {
      accountStats[k] = v
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        totalRequests: stats.totalRequests,
        successRequests: stats.successRequests,
        failedRequests: stats.failedRequests,
        totalTokens: stats.totalTokens,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        uptime: Date.now() - stats.startTime,
        startTime: stats.startTime,
        accountStats,
        recentRequests: stats.recentRequests.slice(-50)
      })
    )
  }

  // 管理 API - 账号列表
  private handleAdminAccounts(res: http.ServerResponse): void {
    const accounts = this.accountPool.getAllAccounts().map((acc) => ({
      id: acc.id,
      email: acc.email,
      isAvailable: acc.isAvailable !== false,
      lastUsed: acc.lastUsed,
      requestCount: acc.requestCount || 0,
      errorCount: acc.errorCount || 0,
      expiresAt: acc.expiresAt,
      authMethod: acc.authMethod
    }))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        total: accounts.length,
        available: accounts.filter((a) => a.isAvailable).length,
        accounts
      })
    )
  }

  /**
   * P1-12 构造脱敏后的配置（apiKeys[].key 全部脱敏，tls 私钥不返回）
   * 暴露给 /admin/config GET
   */
  private handleAdminConfigPayload(): Record<string, unknown> {
    const config = this.getConfig()
    const maskKey = (k: string | undefined): string | undefined => {
      if (!k) return undefined
      if (k.length <= 8) return '***'
      return `${k.slice(0, 4)}***${k.slice(-4)}`
    }
    const { adminApiKey: _adminApiKey, ...safeConfig } = config
    return {
      ...safeConfig,
      apiKey: maskKey(config.apiKey),
      apiKeys: config.apiKeys?.map((k) => ({ ...k, key: maskKey(k.key) || '***' })),
      adminApiKeyConfigured: !!config.adminApiKey,
      tls: config.tls
        ? {
            enabled: config.tls.enabled,
            hasCert: !!(config.tls.cert || config.tls.certPath),
            hasKey: !!(config.tls.key || config.tls.keyPath)
          }
        : undefined
    }
  }

  // 管理 API - 配置
  private handleAdminConfig(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(this.handleAdminConfigPayload()))
  }

  /**
   * P1-9 admin/config POST 字段白名单过滤
   * 仅允许"可远程改"的字段；apiKeys/apiKey 等敏感字段必须通过本地 IPC 改
   */
  private filterAdminConfigUpdate(input: Record<string, unknown>): Partial<ProxyConfig> {
    const allowed: Array<keyof ProxyConfig> = [
      'enabled',
      'enableMultiAccount',
      'logRequests',
      'logStreamEvents',
      'maxConcurrent',
      'maxRetries',
      'retryDelayMs',
      'preferredEndpoint',
      'tokenRefreshBeforeExpiry',
      'autoStart',
      'clientDrivenToolExecution',
      'disableTools',
      'payloadSizeLimitKB',
      'enableTokenBufferReserve',
      'tokenBufferReserve',
      'autoSwitchOnQuotaExhausted',
      'accountSelectionStrategy',
      'multiAccountSelectionMode',
      'multiAccountGroupIds',
      'modelMappings',
      'maxRequestBodyBytes',
      'allowedIPs',
      'deniedIPs',
      'rateLimitPerKeyPerMinute',
      'sessionAffinityEnabled',
      'keepAliveTimeoutMs',
      'headersTimeoutMs',
      'recentRequestsLimit',
      'enableMetrics',
      'apiKeyGroupBindings',
      'enableAuditLog'
      // 故意排除：port / host / apiKey / apiKeys / tls / fallbackPort / allowExternalWithoutApiKey
      // 这些字段会改变监听行为或安全策略，必须本地 IPC 改
    ]
    const out: Partial<ProxyConfig> = {}
    for (const key of allowed) {
      if (key in input) {
        ;(out as Record<string, unknown>)[key] = input[key as string]
      }
    }
    return out
  }

  // 管理 API - 日志
  private handleAdminLogs(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        recentRequests: this.stats.recentRequests.slice(-100)
      })
    )
  }

  // 设置 CORS 头
  private setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Api-Key, anthropic-version, anthropic-beta, x-api-key, x-stainless-os, x-stainless-lang, x-stainless-package-version, x-stainless-runtime, x-stainless-runtime-version, x-stainless-arch'
    )
    res.setHeader(
      'Access-Control-Expose-Headers',
      `x-request-id, x-ratelimit-limit-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-requests, x-ratelimit-remaining-tokens, x-ratelimit-reset-requests, x-ratelimit-reset-tokens, ${MODEL_REMAP_HEADER}`
    )
  }

  private isAnthropicPath(path: string): boolean {
    const pathWithoutQuery = path.split('?')[0]
    return (
      pathWithoutQuery === '/v1/messages' ||
      pathWithoutQuery === '/messages' ||
      pathWithoutQuery === '/anthropic/v1/messages' ||
      pathWithoutQuery === '/v1/messages/count_tokens' ||
      pathWithoutQuery === '/messages/count_tokens' ||
      pathWithoutQuery === '/cc/v1/messages' ||
      pathWithoutQuery === '/cc/v1/messages/count_tokens'
    )
  }

  private getAnthropicErrorType(status: number): string {
    if (status === 400 || status === 405) return 'invalid_request_error'
    if (status === 401) return 'authentication_error'
    if (status === 403) return 'permission_error'
    if (status === 404) return 'not_found_error'
    if (status === 429) return 'rate_limit_error'
    return 'api_error'
  }

  private buildClaudeUsage(
    usage: {
      inputTokens: number
      outputTokens: number
      cacheWriteTokens?: number
      cacheReadTokens?: number
    },
    simulatedCache?: { cacheCreationInputTokens: number; cacheReadInputTokens: number }
  ): {
    input_tokens?: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  } {
    // 优先使用 Kiro 后端返回的真实 cache tokens，否则用模拟器的值
    const cacheWrite = usage.cacheWriteTokens || simulatedCache?.cacheCreationInputTokens || 0
    const cacheRead = usage.cacheReadTokens || simulatedCache?.cacheReadInputTokens || 0
    // Kiro 的 inputTokens 是全量（含缓存），Anthropic API 规范中 input_tokens 不含缓存部分
    // 需要扣除 cache tokens 避免客户端双重计费
    const adjustedInput = Math.max(0, usage.inputTokens - cacheWrite - cacheRead)
    return {
      input_tokens: adjustedInput,
      output_tokens: usage.outputTokens,
      ...(cacheWrite ? { cache_creation_input_tokens: cacheWrite } : {}),
      ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {})
    }
  }

  private estimateTokenCount(value: unknown): number {
    if (value === null || value === undefined) return 0
    if (typeof value === 'string') return Math.ceil(value.length / 4)
    if (typeof value === 'number' || typeof value === 'boolean') return 1
    if (Array.isArray(value)) {
      return value.reduce<number>((total, item) => total + this.estimateTokenCount(item), 0)
    }
    if (typeof value !== 'object') return 0
    const record = value as Record<string, unknown>
    if (record.type === 'text' || record.type === 'input_text' || record.type === 'output_text')
      return this.estimateTokenCount(record.text) + 4
    if (record.type === 'thinking')
      return (
        this.estimateTokenCount(record.thinking) + this.estimateTokenCount(record.signature) + 4
      )
    if (record.type === 'redacted_thinking') return 8
    if (record.type === 'image' || record.type === 'input_image') return 170
    if (record.type === 'document' || record.type === 'input_file')
      return (
        this.estimateTokenCount(record.title) +
        this.estimateTokenCount(record.name) +
        this.estimateTokenCount(record.filename) +
        this.estimateTokenCount(record.source) +
        this.estimateTokenCount(record.file_data) +
        120
      )
    if (record.type === 'tool_use')
      return this.estimateTokenCount(record.name) + this.estimateTokenCount(record.input) + 12
    if (record.type === 'tool_result') return this.estimateTokenCount(record.content) + 8
    if (typeof record.role === 'string' && 'content' in record)
      return this.estimateTokenCount(record.content) + 4
    if (typeof record.name === 'string' && 'input_schema' in record)
      return (
        this.estimateTokenCount(record.name) +
        this.estimateTokenCount(record.description) +
        this.estimateTokenCount(record.input_schema) +
        32
      )
    return Object.entries(record).reduce<number>(
      (total, [key, item]) =>
        key === 'cache_control' ? total : total + this.estimateTokenCount(item),
      0
    )
  }

  // 健康检查
  private handleHealth(res: http.ServerResponse): void {
    const stats = this.getStats()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'ok',
        version: '1.0.0',
        accounts: this.accountPool.size,
        availableAccounts: this.accountPool.availableCount,
        stats: {
          totalRequests: stats.totalRequests,
          successRequests: stats.successRequests,
          failedRequests: stats.failedRequests,
          totalTokens: stats.totalTokens,
          uptime: Date.now() - stats.startTime
        }
      })
    )
  }

  // Claude Code token 计数（模拟响应）
  private async handleCountTokens(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    signal?: AbortSignal
  ): Promise<void> {
    let body: string
    try {
      this.throwIfAborted(signal)
      body = await this.readBody(req, signal)
      this.throwIfAborted(signal)
    } catch (error) {
      if (this.isAbortError(error, signal)) return
      if (error instanceof BodyTooLargeError) throw error
      this.sendError(
        res,
        400,
        error instanceof Error ? error.message : 'Invalid request body',
        'anthropic'
      )
      return
    }

    try {
      const request = JSON.parse(body) as Partial<ClaudeRequest>
      if (!Array.isArray(request.messages)) throw new Error('count_tokens requires messages')
      const estimatedTokens = Math.max(
        1,
        this.estimateTokenCount(request.system) +
          this.estimateTokenCount(request.messages) +
          this.estimateTokenCount(request.tools)
      )
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: estimatedTokens }))
    } catch (error) {
      if (this.isAbortError(error, signal)) return
      this.sendError(
        res,
        400,
        error instanceof Error ? error.message : 'Invalid request body',
        'anthropic'
      )
    }
  }

  // Gemini v1beta 模型列表
  private async handleGeminiModels(res: http.ServerResponse, signal?: AbortSignal): Promise<void> {
    const result = await this.getAvailableModels(signal)
    const geminiModels = result.models.map((m) => ({
      name: `models/${m.id}`,
      version: '001',
      displayName: m.name || m.id,
      description: m.description || '',
      inputTokenLimit: m.maxInputTokens || 200000,
      outputTokenLimit: m.maxOutputTokens || 64000,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent']
    }))
    this.throwIfResponseClosed(res, signal)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ models: geminiModels }))
  }

  // Gemini v1beta generateContent / streamGenerateContent
  private async handleGeminiRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    signal?: AbortSignal
  ): Promise<void> {
    const body = await this.readBody(req, signal)
    this.throwIfAborted(signal)
    const geminiReq = JSON.parse(body)
    const matchedApiKey = (req as unknown as { matchedApiKey?: import('./types').ApiKey })
      .matchedApiKey

    // 解析路径: /v1beta/models/{model}:{method}
    const match = path.match(/\/v1beta\/models\/([^:]+):(\w+)/)
    if (!match) {
      this.sendError(res, 400, 'Invalid Gemini endpoint path')
      return
    }
    const [, modelId, method] = match
    const isStream = method === 'streamGenerateContent'

    // 将 Gemini 请求转为 OpenAI 格式
    const messages: OpenAIMessage[] = []
    if (geminiReq.systemInstruction?.parts) {
      const sysText = geminiReq.systemInstruction.parts
        .map((p: { text?: string }) => p.text || '')
        .join('\n')
      if (sysText) messages.push({ role: 'system', content: sysText })
    }
    for (const content of geminiReq.contents || []) {
      const role = content.role === 'model' ? 'assistant' : 'user'
      const text = (content.parts || []).map((p: { text?: string }) => p.text || '').join('')
      if (text) messages.push({ role: role as 'user' | 'assistant', content: text })
    }
    if (messages.length === 0) {
      messages.push({ role: 'user', content: 'Hello' })
    }

    const mappedGeminiModel = this.applyModelMapping(modelId, matchedApiKey?.id)
    this.annotateModelRemap(res, mappedGeminiModel)

    const openaiRequest: OpenAIChatRequest = {
      model: mappedGeminiModel,
      messages,
      stream: isStream,
      temperature: geminiReq.generationConfig?.temperature,
      top_p: geminiReq.generationConfig?.topP,
      max_tokens: geminiReq.generationConfig?.maxOutputTokens
    }

    // 复用 OpenAI 流程
    const startTime = Date.now()
    this.recordNewRequest()
    this.throwIfAborted(signal)
    const account = await this.getAvailableAccount(signal, undefined, matchedApiKey?.id)
    this.throwIfAborted(signal)
    if (!account) {
      this.sendError(res, 503, 'No available accounts')
      return
    }

    try {
      const toolNameRegistry = new ToolNameRegistry()
      const kiroPayload = openaiToKiro(
        openaiRequest,
        account.profileArn,
        toolNameRegistry,
        this.getThinkingConfig(openaiRequest.model)
      )

      if (isStream) {
        // SSE 流式
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
        return new Promise<void>((resolve) => {
          callKiroApiStream(
            account as ProxyAccount,
            kiroPayload,
            (text) => {
              if (signal?.aborted || this.isResponseClosed(res)) return
              if (text) {
                const chunk = {
                  candidates: [
                    { content: { parts: [{ text }], role: 'model' }, finishReason: null }
                  ]
                }
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
              }
              return this.waitForDrain(res)
            },
            (usage) => {
              if (signal?.aborted || this.isResponseClosed(res)) {
                resolve()
                return
              }
              const finalChunk = {
                candidates: [
                  { content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP' }
                ],
                usageMetadata: {
                  promptTokenCount: usage.inputTokens,
                  candidatesTokenCount: usage.outputTokens,
                  totalTokenCount: usage.inputTokens + usage.outputTokens
                }
              }
              res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
              res.end()
              this.recordRequestSuccess()
              this.stats.totalTokens += usage.inputTokens + usage.outputTokens
              this.stats.inputTokens += usage.inputTokens
              this.stats.outputTokens += usage.outputTokens
              this.stats.totalCredits += usage.credits || 0
              this.accountPool.recordSuccess(account.id, usage.inputTokens + usage.outputTokens)
              resolve()
            },
            (error) => {
              if (this.isAbortError(error, signal) || this.isResponseClosed(res)) {
                resolve()
                return
              }
              res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
              res.end()
              this.recordRequestFailed()
              resolve()
            },
            signal,
            this.config.preferredEndpoint
          ).catch((error) => {
            if (!this.isAbortError(error, signal) && !this.isResponseClosed(res)) {
              res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
              res.end()
              this.recordRequestFailed()
            }
            resolve()
          })
        })
      } else {
        // 非流式
        const result = await callKiroApi(account as ProxyAccount, kiroPayload, signal)
        this.throwIfResponseClosed(res, signal)
        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: result.content }], role: 'model' },
                finishReason: 'STOP'
              }
            ],
            usageMetadata: {
              promptTokenCount: result.usage.inputTokens,
              candidatesTokenCount: result.usage.outputTokens,
              totalTokenCount: result.usage.inputTokens + result.usage.outputTokens
            }
          })
        )
      }
    } catch (error) {
      this.handleApiError(res, account, error as Error, '/v1beta', modelId, startTime, signal)
    }
  }

  // 模型列表缓存
  private modelCache: { models: KiroModel[]; timestamp: number } | null = null
  private readonly MODEL_CACHE_TTL = 5 * 60 * 1000 // 5 分钟缓存

  // 模型列表
  private async handleModels(res: http.ServerResponse, signal?: AbortSignal): Promise<void> {
    const now = Date.now()

    // Kiro 官方模型（与 UI 保持一致）
    const kiroOfficialModels = [
      buildClientModel({
        id: 'auto',
        created: now,
        ownedBy: 'kiro-api',
        description: 'Auto select best model'
      }),
      buildClientModel({
        id: 'claude-sonnet-4.5',
        created: now,
        ownedBy: 'kiro-api',
        description: 'The latest Claude Sonnet model'
      }),
      buildClientModel({
        id: 'claude-sonnet-4',
        created: now,
        ownedBy: 'kiro-api',
        description: 'Hybrid reasoning and coding'
      }),
      buildClientModel({
        id: 'claude-haiku-4.5',
        created: now,
        ownedBy: 'kiro-api',
        description: 'The latest Claude Haiku model'
      }),
      buildClientModel({
        id: 'claude-opus-4.5',
        created: now,
        ownedBy: 'kiro-api',
        description: 'The most powerful model'
      })
    ]

    // 隐藏模型（未在官方 ListAvailableModels 中返回，但后端可能支持）
    const hiddenModels = [
      buildClientModel({
        id: 'claude-3.7-sonnet',
        created: now,
        ownedBy: 'kiro-api',
        description: 'Claude 3.7 Sonnet (hidden)',
        modelName: 'Claude 3.7 Sonnet',
        supportedInputTypes: ['TEXT', 'IMAGE'],
        maxInputTokens: 200000,
        maxOutputTokens: 64000
      }),
      buildClientModel({
        id: 'simple-task',
        created: now,
        ownedBy: 'kiro-api',
        description:
          'Kiro fast model for intent classification and lightweight tasks (routes to Haiku)',
        modelName: 'Simple Task',
        supportedInputTypes: ['TEXT'],
        maxInputTokens: 200000,
        maxOutputTokens: 4096
      }),
      buildClientModel({
        id: 'CLAUDE_SONNET_4_20250514_V1_0',
        created: now,
        ownedBy: 'kiro-api',
        description: 'Claude Sonnet 4 (CodeWhisperer internal ID)',
        modelName: 'Claude Sonnet 4 (CW)',
        supportedInputTypes: ['TEXT', 'IMAGE'],
        maxInputTokens: 200000,
        maxOutputTokens: 64000
      }),
      buildClientModel({
        id: 'CLAUDE_HAIKU_4_5_20251001_V1_0',
        created: now,
        ownedBy: 'kiro-api',
        description: 'Claude Haiku 4.5 (CodeWhisperer internal ID)',
        modelName: 'Claude Haiku 4.5 (CW)',
        supportedInputTypes: ['TEXT', 'IMAGE'],
        maxInputTokens: 200000,
        maxOutputTokens: 64000
      }),
      buildClientModel({
        id: 'CLAUDE_3_7_SONNET_20250219_V1_0',
        created: now,
        ownedBy: 'kiro-api',
        description: 'Claude 3.7 Sonnet (CodeWhisperer internal ID)',
        modelName: 'Claude 3.7 Sonnet (CW)',
        supportedInputTypes: ['TEXT', 'IMAGE'],
        maxInputTokens: 200000,
        maxOutputTokens: 64000
      })
    ]

    // 预设模型（GPT 兼容别名）
    const presetModels = [
      buildClientModel({
        id: 'gpt-4o',
        created: now,
        ownedBy: 'kiro-proxy',
        description: 'GPT-compatible alias for Kiro'
      }),
      buildClientModel({
        id: 'gpt-4',
        created: now,
        ownedBy: 'kiro-proxy',
        description: 'GPT-compatible alias for Kiro'
      }),
      buildClientModel({
        id: 'gpt-4-turbo',
        created: now,
        ownedBy: 'kiro-proxy',
        description: 'GPT-compatible alias for Kiro'
      }),
      buildClientModel({
        id: 'gpt-3.5-turbo',
        created: now,
        ownedBy: 'kiro-proxy',
        description: 'GPT-compatible alias for Kiro'
      })
    ]

    // 尝试从 Kiro API 获取动态模型
    let kiroModels: KiroModel[] = []

    // 检查缓存
    if (this.modelCache && now - this.modelCache.timestamp < this.MODEL_CACHE_TTL) {
      kiroModels = this.modelCache.models
    } else {
      // 获取一个可用账号来请求模型列表
      const account = this.accountPool.getNextAccount()
      if (account) {
        try {
          kiroModels = await fetchKiroModels(account, signal)
          if (kiroModels.length > 0) {
            this.modelCache = { models: kiroModels, timestamp: now }
            // 同步到 kiroApi 的 ctx cache, 供 token 裁剪逻辑使用
            for (const m of kiroModels) {
              if (m.tokenLimits?.maxInputTokens) {
                setModelContextWindow(m.modelId, m.tokenLimits.maxInputTokens)
              }
            }
            proxyLogger.info('ProxyServer', `Fetched ${kiroModels.length} models from Kiro API`)
          }
        } catch (error) {
          if (this.isAbortError(error, signal)) throw error
          console.error('[ProxyServer] Failed to fetch Kiro models:', error)
        }
      }
    }

    // 转换 Kiro 模型为 OpenAI 格式（保持原始 modelId）
    const dynamicModels = kiroModels.map((m) =>
      buildClientModel({
        id: m.modelId,
        created: now,
        ownedBy: 'kiro-api',
        description: m.description,
        modelName: m.modelName,
        supportedInputTypes: m.supportedInputTypes,
        maxInputTokens: m.tokenLimits?.maxInputTokens,
        maxOutputTokens: m.tokenLimits?.maxOutputTokens,
        rateMultiplier: m.rateMultiplier,
        rateUnit: m.rateUnit,
        promptCaching: m.promptCaching,
        additionalModelRequestFieldsSchema: m.additionalModelRequestFieldsSchema,
        modelProvider: m.modelProvider
      })
    )

    // 合并模型列表，去重
    const modelIds = new Set<string>()
    const allModels: ClientModel[] = []

    // 1. 优先添加动态模型（从 API 获取的，包含真实 token limit / input types）
    for (const m of dynamicModels) {
      if (!modelIds.has(m.id)) {
        modelIds.add(m.id)
        allModels.push(m)
      }
    }

    // 2. 添加隐藏模型（未在官方 ListAvailableModels 中返回，但后端可能支持）
    for (const m of hiddenModels) {
      if (!modelIds.has(m.id)) {
        modelIds.add(m.id)
        allModels.push(m)
      }
    }

    // 3. 动态模型缺失时才添加静态兜底
    if (dynamicModels.length === 0) {
      for (const m of [...kiroOfficialModels, ...presetModels]) {
        if (!modelIds.has(m.id)) {
          modelIds.add(m.id)
          allModels.push(m)
        }
      }
    }

    this.throwIfResponseClosed(res, signal)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: allModels }))
  }

  // 处理 OpenAI Chat Completions 请求
  private async handleOpenAIChat(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    signal?: AbortSignal
  ): Promise<void> {
    const body = await this.readBody(req, signal)
    this.throwIfAborted(signal)
    const request: OpenAIChatRequest = JSON.parse(body)
    const matchedApiKey = (req as unknown as { matchedApiKey?: import('./types').ApiKey })
      .matchedApiKey

    // 提取 session hint（用于稳定 conversationId），拼入 API Key hash 隔离不同用户
    const rawHintChat = ProxyServer.extractSessionHint(req, request)
    if (!request.conversation_id && rawHintChat) {
      const keyPrefix = matchedApiKey?.id?.slice(0, 8) || 'default'
      request.conversation_id = `${keyPrefix}:${rawHintChat}`
    }
    const affinityHintChat = request.conversation_id

    // 应用模型映射
    request.model = this.applyModelMapping(request.model, matchedApiKey?.id)
    this.annotateModelRemap(res, request.model)

    const startTime = Date.now()

    this.recordNewRequest()
    this.events.onRequest?.({ path: '/v1/chat/completions', method: 'POST' })

    let processedRequest: OpenAIChatRequest
    try {
      processedRequest = await this.resolveOpenAIHttpImages(
        this.prepareOpenAIRequest(request),
        signal
      )
    } catch (error) {
      if (this.isAbortError(error, signal)) return
      this.recordRequestFailed()
      const message = error instanceof Error ? error.message : 'Invalid request'
      this.sendError(res, 400, message)
      this.events.onResponse?.({
        path: '/v1/chat/completions',
        model: request.model,
        status: 400,
        error: message
      })
      this.recordRequest({
        path: '/v1/chat/completions',
        model: request.model,
        responseTime: Date.now() - startTime,
        success: false,
        error: message
      })
      return
    }

    // 获取账号（包含 Token 刷新检查 + 会话粘性 + API Key 账号白名单）
    this.throwIfAborted(signal)
    const account = await this.getAvailableAccount(signal, affinityHintChat, matchedApiKey?.id)
    this.throwIfAborted(signal)
    if (!account) {
      this.recordRequestFailed()
      const quotaStatus = this.accountPool.getQuotaStatus()
      const errorMsg =
        quotaStatus.exhausted > 0 && quotaStatus.available === 0
          ? `All accounts quota exhausted (${quotaStatus.exhausted}/${quotaStatus.total} exhausted, ${quotaStatus.cooldown} in cooldown)`
          : 'No available accounts'
      this.sendError(res, 503, errorMsg)
      this.events.onResponse?.({
        path: '/v1/chat/completions',
        model: request.model,
        status: 503,
        error: errorMsg
      })
      this.recordRequest({
        path: '/v1/chat/completions',
        model: request.model,
        success: false,
        error: errorMsg
      })
      return
    }

    this.events.onRequest?.({ path: '/v1/chat/completions', method: 'POST', accountId: account.id })

    try {
      const toolNameRegistry = new ToolNameRegistry()

      // 转换为 Kiro 格式
      const thinkingConfig = this.getThinkingConfig(processedRequest.model)
      const kiroPayload = openaiToKiro(
        processedRequest,
        account.profileArn,
        toolNameRegistry,
        thinkingConfig
      )

      // 记录请求详情到日志
      if (this.config.logRequests) {
        const userInput = kiroPayload.conversationState.currentMessage?.userInputMessage
        const contentLength = typeof userInput?.content === 'string' ? userInput.content.length : 0
        const toolsCount = userInput?.userInputMessageContext?.tools?.length || 0
        const historyLength = kiroPayload.conversationState.history?.length || 0
        const hasImages = (userInput?.images?.length || 0) > 0

        proxyLogger.info('ProxyServer', `OpenAI API: ${request.model}`, {
          model: request.model,
          stream: request.stream,
          contentLength,
          toolsCount,
          historyLength,
          hasImages,
          accountId: account.id
        })
      }

      if (request.stream) {
        // 流式响应（流式不使用重试机制，错误由流处理）
        await this.handleOpenAIStream(
          res,
          account,
          kiroPayload,
          request.model,
          startTime,
          0,
          undefined,
          false,
          matchedApiKey,
          toolNameRegistry,
          signal
        )
      } else {
        // 非流式响应（带重试机制）
        const { result, account: usedAccount } = await this.callWithRetry(
          account,
          async (acc) => {
            const retryPayload = openaiToKiro(
              processedRequest,
              acc.profileArn,
              toolNameRegistry,
              thinkingConfig
            )
            return callKiroApi(acc, retryPayload, signal)
          },
          '/v1/chat/completions',
          signal,
          matchedApiKey?.id
        )
        const response = kiroToOpenaiResponse(
          result.content,
          result.toolUses,
          result.usage,
          request.model,
          toolNameRegistry,
          result.reasoningContent
        )

        this.throwIfResponseClosed(res, signal)
        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        this.stats.inputTokens += result.usage.inputTokens
        this.stats.outputTokens += result.usage.outputTokens
        this.accountPool.recordSuccess(
          usedAccount.id,
          result.usage.inputTokens + result.usage.outputTokens
        )

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
        const respTime = Date.now() - startTime
        this.events.onResponse?.({
          path: '/v1/chat/completions',
          model: request.model,
          status: 200,
          tokens: result.usage.inputTokens + result.usage.outputTokens,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          reasoningTokens: result.usage.reasoningTokens,
          credits: result.usage.credits,
          responseTime: respTime
        })
        this.recordRequest({
          path: '/v1/chat/completions',
          model: request.model,
          accountId: usedAccount.id,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          credits: result.usage.credits,
          responseTime: respTime,
          success: true
        })
        // 记录 API Key 用量
        if (matchedApiKey) {
          this.recordApiKeyUsage(
            matchedApiKey.id,
            result.usage.credits || 0,
            result.usage.inputTokens,
            result.usage.outputTokens,
            request.model,
            '/v1/chat/completions'
          )
        }
      }
    } catch (error) {
      const failure = this.getTerminalRetryFailure(error as Error, account)
      this.handleApiError(
        res,
        failure.account,
        failure.error,
        '/v1/chat/completions',
        request.model,
        startTime,
        signal
      )
    }
  }

  private async handleOpenAIResponses(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    signal?: AbortSignal
  ): Promise<void> {
    const body = await this.readBody(req, signal)
    this.throwIfAborted(signal)
    const matchedApiKey = (req as unknown as { matchedApiKey?: import('./types').ApiKey })
      .matchedApiKey
    const startTime = Date.now()

    this.recordNewRequest()
    this.events.onRequest?.({ path: '/v1/responses', method: 'POST' })

    let responseRequest: OpenAIResponsesRequest
    let chatRequest: OpenAIChatRequest
    let processedRequest: OpenAIChatRequest
    let affinityHintResp: string | undefined
    try {
      responseRequest = JSON.parse(body)
      chatRequest = responsesToOpenAIChat(responseRequest)
      // session hint：用于会话粘性
      const rawHintResp = ProxyServer.extractSessionHint(req, responseRequest)
      if (rawHintResp) {
        const keyPrefix = matchedApiKey?.id?.slice(0, 8) || 'default'
        affinityHintResp = `${keyPrefix}:${rawHintResp}`
      }
      chatRequest.model = this.applyModelMapping(chatRequest.model, matchedApiKey?.id)
      this.annotateModelRemap(res, chatRequest.model)
      processedRequest = await this.resolveOpenAIHttpImages(
        this.prepareOpenAIRequest(chatRequest),
        signal
      )
    } catch (error) {
      if (this.isAbortError(error, signal)) return
      this.recordRequestFailed()
      const message = error instanceof Error ? error.message : 'Invalid request'
      this.sendError(res, 400, message)
      this.events.onResponse?.({ path: '/v1/responses', status: 400, error: message })
      this.recordRequest({
        path: '/v1/responses',
        responseTime: Date.now() - startTime,
        success: false,
        error: message
      })
      return
    }

    this.throwIfAborted(signal)
    const account = await this.getAvailableAccount(signal, affinityHintResp, matchedApiKey?.id)
    this.throwIfAborted(signal)
    if (!account) {
      this.recordRequestFailed()
      const quotaStatus = this.accountPool.getQuotaStatus()
      const errorMsg =
        quotaStatus.exhausted > 0 && quotaStatus.available === 0
          ? `All accounts quota exhausted (${quotaStatus.exhausted}/${quotaStatus.total} exhausted, ${quotaStatus.cooldown} in cooldown)`
          : 'No available accounts'
      this.sendError(res, 503, errorMsg)
      this.events.onResponse?.({
        path: '/v1/responses',
        model: chatRequest.model,
        status: 503,
        error: errorMsg
      })
      this.recordRequest({
        path: '/v1/responses',
        model: chatRequest.model,
        success: false,
        error: 'No available accounts'
      })
      return
    }

    this.events.onRequest?.({ path: '/v1/responses', method: 'POST', accountId: account.id })

    try {
      const toolNameRegistry = new ToolNameRegistry()
      if (processedRequest.stream) {
        await this.handleOpenAIResponsesStream(
          res,
          account,
          processedRequest,
          chatRequest.model,
          responseRequest.previous_response_id,
          startTime,
          matchedApiKey,
          toolNameRegistry,
          signal
        )
        return
      }

      const { result, account: usedAccount } = await this.callWithRetry(
        account,
        async (acc) => {
          const retryPayload = openaiToKiro(
            processedRequest,
            acc.profileArn,
            toolNameRegistry,
            this.getThinkingConfig(processedRequest.model)
          )
          return callKiroApi(acc, retryPayload, signal)
        },
        '/v1/responses',
        signal,
        matchedApiKey?.id
      )
      const chatResponse = kiroToOpenaiResponse(
        result.content,
        result.toolUses,
        result.usage,
        chatRequest.model,
        toolNameRegistry,
        result.reasoningContent
      )
      this.throwIfResponseClosed(res, signal)
      const response = openAIChatToResponsesResponse(
        chatResponse,
        responseRequest.previous_response_id
      )

      this.recordRequestSuccess()
      this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
      this.stats.inputTokens += result.usage.inputTokens
      this.stats.outputTokens += result.usage.outputTokens
      this.accountPool.recordSuccess(
        usedAccount.id,
        result.usage.inputTokens + result.usage.outputTokens
      )

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))
      const respTime = Date.now() - startTime
      this.events.onResponse?.({
        path: '/v1/responses',
        model: chatRequest.model,
        status: 200,
        tokens: result.usage.inputTokens + result.usage.outputTokens,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        reasoningTokens: result.usage.reasoningTokens,
        credits: result.usage.credits,
        responseTime: respTime
      })
      this.recordRequest({
        path: '/v1/responses',
        model: chatRequest.model,
        accountId: usedAccount.id,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        credits: result.usage.credits,
        responseTime: respTime,
        success: true
      })
      if (matchedApiKey) {
        this.recordApiKeyUsage(
          matchedApiKey.id,
          result.usage.credits || 0,
          result.usage.inputTokens,
          result.usage.outputTokens,
          chatRequest.model,
          '/v1/responses'
        )
      }
    } catch (error) {
      const failure = this.getTerminalRetryFailure(error as Error, account)
      this.handleApiError(
        res,
        failure.account,
        failure.error,
        '/v1/responses',
        chatRequest.model,
        startTime,
        signal
      )
    }
  }

  // 处理 OpenAI 流式响应
  private async handleOpenAIResponsesStream(
    res: http.ServerResponse,
    initialAccount: ProxyAccount,
    processedRequest: OpenAIChatRequest,
    model: string,
    previousResponseId: string | undefined,
    startTime: number,
    matchedApiKey: import('./types').ApiKey | undefined,
    toolNameRegistry: ToolNameRegistry,
    signal?: AbortSignal
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })

    const responseId = `resp_${uuidv4()}`
    const createdAt = Math.floor(Date.now() / 1000)
    const output: OpenAIResponseOutputItem[] = []
    let sequenceNumber = 0
    let textItem: Extract<OpenAIResponseOutputItem, { type: 'message' }> | undefined
    let textOutputIndex = -1
    const streamRetryState = {
      triedIds: new Set([initialAccount.id]),
      refreshedAccountIds: new Set<string>()
    }
    const writeEvent = (event: Record<string, unknown> & { type: string }): void => {
      res.write(
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequenceNumber++ })}\n\n`
      )
    }
    const ensureTextItem = (): Extract<OpenAIResponseOutputItem, { type: 'message' }> => {
      if (textItem) return textItem
      textItem = {
        type: 'message',
        id: `msg_${uuidv4()}`,
        role: 'assistant',
        content: [{ type: 'output_text', text: '' }]
      }
      textOutputIndex = output.length
      output.push(textItem)
      writeEvent({
        type: 'response.output_item.added',
        output_index: textOutputIndex,
        item: { ...textItem, content: [] }
      })
      writeEvent({
        type: 'response.content_part.added',
        item_id: textItem.id,
        output_index: textOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      })
      return textItem
    }

    writeEvent({
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'in_progress',
        model,
        output: [],
        ...(previousResponseId !== undefined ? { previous_response_id: previousResponseId } : {})
      }
    })

    const runAttempt = (account: ProxyAccount): Promise<void> =>
      new Promise((resolve) => {
        let settled = false
        let hasWrittenUpstreamChunk = false
        const kiroPayload = openaiToKiro(
          processedRequest,
          account.profileArn,
          toolNameRegistry,
          this.getThinkingConfig(processedRequest.model)
        )

        callKiroApiStream(
          account,
          kiroPayload,
          (text, toolUse, isThinking) => {
            if (settled || signal?.aborted || this.isResponseClosed(res)) return
            if (text && !isThinking) {
              hasWrittenUpstreamChunk = true
              const item = ensureTextItem()
              item.content[0].text += text
              writeEvent({
                type: 'response.output_text.delta',
                item_id: item.id,
                output_index: textOutputIndex,
                content_index: 0,
                delta: text
              })
            }
            if (toolUse) {
              hasWrittenUpstreamChunk = true
              const restoredToolUse = toolNameRegistry.restoreToolUse(toolUse)
              const argumentsJson = JSON.stringify(restoredToolUse.input)
              const item: Extract<OpenAIResponseOutputItem, { type: 'function_call' }> = {
                type: 'function_call',
                id: `fc_${uuidv4()}`,
                call_id: restoredToolUse.toolUseId,
                name: restoredToolUse.name,
                arguments: argumentsJson
              }
              const outputIndex = output.length
              output.push(item)
              writeEvent({
                type: 'response.output_item.added',
                output_index: outputIndex,
                item: { ...item, arguments: '' }
              })
              if (argumentsJson) {
                writeEvent({
                  type: 'response.function_call_arguments.delta',
                  item_id: item.id,
                  output_index: outputIndex,
                  delta: argumentsJson
                })
              }
              writeEvent({
                type: 'response.function_call_arguments.done',
                item_id: item.id,
                output_index: outputIndex,
                name: item.name,
                arguments: argumentsJson
              })
              writeEvent({ type: 'response.output_item.done', output_index: outputIndex, item })
            }
            return this.waitForDrain(res)
          },
          (usage) => {
            if (settled) return
            settled = true
            try {
              if (signal?.aborted || this.isResponseClosed(res)) return
              if (output.length === 0) ensureTextItem()
              if (textItem) {
                const part = {
                  type: 'output_text',
                  text: textItem.content[0].text,
                  annotations: []
                }
                writeEvent({
                  type: 'response.output_text.done',
                  item_id: textItem.id,
                  output_index: textOutputIndex,
                  content_index: 0,
                  text: textItem.content[0].text
                })
                writeEvent({
                  type: 'response.content_part.done',
                  item_id: textItem.id,
                  output_index: textOutputIndex,
                  content_index: 0,
                  part
                })
                writeEvent({
                  type: 'response.output_item.done',
                  output_index: textOutputIndex,
                  item: textItem
                })
              }

              const responseUsage = {
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                total_tokens: usage.inputTokens + usage.outputTokens,
                ...(usage.cacheReadTokens
                  ? { input_tokens_details: { cached_tokens: usage.cacheReadTokens } }
                  : {}),
                ...(usage.reasoningTokens
                  ? { output_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
                  : {})
              }
              writeEvent({
                type: 'response.completed',
                response: {
                  id: responseId,
                  object: 'response',
                  created_at: createdAt,
                  status: 'completed',
                  model,
                  output,
                  usage: responseUsage,
                  ...(previousResponseId !== undefined
                    ? { previous_response_id: previousResponseId }
                    : {})
                }
              })
              res.end()

              this.recordRequestSuccess()
              this.stats.totalTokens += usage.inputTokens + usage.outputTokens
              this.stats.inputTokens += usage.inputTokens
              this.stats.outputTokens += usage.outputTokens
              this.stats.cacheReadTokens += usage.cacheReadTokens || 0
              this.stats.cacheWriteTokens += usage.cacheWriteTokens || 0
              this.stats.reasoningTokens += usage.reasoningTokens || 0
              this.stats.totalCredits += usage.credits || 0
              this.notifyEventSafely(() => this.events.onCreditsUpdate?.(this.stats.totalCredits))
              this.notifyEventSafely(() =>
                this.events.onTokensUpdate?.(this.stats.inputTokens, this.stats.outputTokens)
              )
              this.accountPool.recordSuccess(account.id, usage.inputTokens + usage.outputTokens)
              const responseTime = Date.now() - startTime
              this.notifyEventSafely(() =>
                this.events.onResponse?.({
                  path: '/v1/responses',
                  model,
                  status: 200,
                  tokens: usage.inputTokens + usage.outputTokens,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  cacheReadTokens: usage.cacheReadTokens,
                  reasoningTokens: usage.reasoningTokens,
                  credits: usage.credits,
                  responseTime
                })
              )
              this.recordRequest({
                path: '/v1/responses',
                model,
                accountId: account.id,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                credits: usage.credits,
                responseTime,
                success: true
              })
              if (matchedApiKey) {
                this.recordApiKeyUsage(
                  matchedApiKey.id,
                  usage.credits || 0,
                  usage.inputTokens,
                  usage.outputTokens,
                  model,
                  '/v1/responses'
                )
              }
            } finally {
              resolve()
            }
          },
          async (error) => {
            if (settled) return
            settled = true
            if (this.isAbortError(error, signal) || this.isResponseClosed(res)) {
              resolve()
              return
            }
            if (!hasWrittenUpstreamChunk) {
              const nextAccount = await this.getStreamRetryAccount(
                account,
                error,
                matchedApiKey?.id,
                streamRetryState,
                signal
              )
              if (nextAccount) {
                await runAttempt(nextAccount)
                resolve()
                return
              }
            }
            this.handleApiError(res, account, error, '/v1/responses', model, startTime, signal)
            resolve()
          },
          signal,
          this.config.preferredEndpoint
        ).catch((error: unknown) => {
          if (settled) return
          settled = true
          const streamError = error instanceof Error ? error : new Error(String(error))
          this.handleApiError(res, account, streamError, '/v1/responses', model, startTime, signal)
          resolve()
        })
      })

    await runAttempt(initialAccount)
  }

  private async handleOpenAIStream(
    res: http.ServerResponse,
    account: ProxyAccount,
    kiroPayload: ReturnType<typeof openaiToKiro>,
    model: string,
    startTime: number,
    currentRound: number = 0,
    streamId?: string,
    headersSent: boolean = false,
    matchedApiKey?: import('./types').ApiKey,
    toolNameRegistry: ToolNameRegistry = new ToolNameRegistry(),
    signal?: AbortSignal,
    streamRetryState: { triedIds: Set<string>; refreshedAccountIds: Set<string> } = {
      triedIds: new Set([account.id]),
      refreshedAccountIds: new Set()
    }
  ): Promise<void> {
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
    }

    const id = streamId || `chatcmpl-${uuidv4()}`
    let toolCallIndex = 0
    const pendingToolCalls: Map<string, { index: number; name: string; arguments: string }> =
      new Map()
    let collectedContent = ''
    // 发送初始 chunk（仅首轮）
    if (currentRound === 0) {
      const initialChunk = createOpenaiStreamChunk(id, model, { role: 'assistant' })
      res.write(`data: ${JSON.stringify(initialChunk)}\n\n`)
    }

    let hasWrittenUpstreamChunk = false
    return new Promise((resolve) => {
      callKiroApiStream(
        account as any,
        kiroPayload,
        (text, toolUse, isThinking) => {
          if (signal?.aborted || this.isResponseClosed(res)) return
          hasWrittenUpstreamChunk = true
          if (text && text.trim()) {
            if (isThinking) {
              // 原生 thinking 内容 → 输出为 reasoning_content
              const chunk = createOpenaiStreamChunk(id, model, { reasoning_content: text })
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            } else {
              // 普通文本内容
              collectedContent += text
              const chunk = createOpenaiStreamChunk(id, model, { content: text })
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }
          }
          if (toolUse) {
            const idx = toolCallIndex++
            const restoredToolUse = toolNameRegistry.restoreToolUse(toolUse)
            pendingToolCalls.set(toolUse.toolUseId, {
              index: idx,
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input)
            })
            const toolChunk = createOpenaiStreamChunk(id, model, {
              tool_calls: [
                {
                  index: idx,
                  id: toolUse.toolUseId,
                  type: 'function',
                  function: {
                    name: restoredToolUse.name,
                    arguments: JSON.stringify(toolUse.input)
                  }
                }
              ]
            })
            res.write(`data: ${JSON.stringify(toolChunk)}\n\n`)
          }
          return this.waitForDrain(res)
        },
        async (usage) => {
          if (signal?.aborted || this.isResponseClosed(res)) {
            resolve()
            return
          }

          this.recordRequestSuccess()
          this.stats.totalTokens += usage.inputTokens + usage.outputTokens
          this.stats.inputTokens += usage.inputTokens
          this.stats.outputTokens += usage.outputTokens
          this.stats.cacheReadTokens += usage.cacheReadTokens || 0
          this.stats.cacheWriteTokens += usage.cacheWriteTokens || 0
          this.stats.reasoningTokens += usage.reasoningTokens || 0
          this.stats.totalCredits += usage.credits || 0
          this.events.onCreditsUpdate?.(this.stats.totalCredits)
          this.events.onTokensUpdate?.(this.stats.inputTokens, this.stats.outputTokens)
          this.accountPool.recordSuccess(account.id, usage.inputTokens + usage.outputTokens)
          const oaiRespTime = Date.now() - startTime
          this.events.onResponse?.({
            path: '/v1/chat/completions',
            model,
            status: 200,
            tokens: usage.inputTokens + usage.outputTokens,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            reasoningTokens: usage.reasoningTokens,
            credits: usage.credits,
            responseTime: oaiRespTime
          })
          this.recordRequest({
            path: '/v1/chat/completions',
            model,
            accountId: account.id,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            credits: usage.credits,
            responseTime: oaiRespTime,
            success: true
          })
          // 记录 API Key 用量
          if (matchedApiKey) {
            this.recordApiKeyUsage(
              matchedApiKey.id,
              usage.credits || 0,
              usage.inputTokens,
              usage.outputTokens,
              model,
              '/v1/chat/completions'
            )
          }

          // 发送结束 chunk（包含完整 usage 信息）
          const hasToolCalls = pendingToolCalls.size > 0
          const finishReason = hasToolCalls ? 'tool_calls' : 'stop'
          const usageInfo: {
            prompt_tokens: number
            completion_tokens: number
            total_tokens: number
            prompt_tokens_details?: { cached_tokens?: number }
            completion_tokens_details?: { reasoning_tokens?: number }
          } = {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens
          }
          // 添加 cache tokens 详情
          if (usage.cacheReadTokens && usage.cacheReadTokens > 0) {
            usageInfo.prompt_tokens_details = { cached_tokens: usage.cacheReadTokens }
          }
          // 添加 reasoning tokens 详情
          if (usage.reasoningTokens && usage.reasoningTokens > 0) {
            usageInfo.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens }
          }
          const finalChunk = createOpenaiStreamChunk(id, model, {}, finishReason, usageInfo)
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          resolve()
        },
        (error) => {
          if (this.isAbortError(error, signal) || this.isResponseClosed(res)) {
            resolve()
            return
          }
          if (!hasWrittenUpstreamChunk) {
            this.getStreamRetryAccount(account, error, matchedApiKey?.id, streamRetryState, signal)
              .then(async (nextAccount) => {
                if (nextAccount) {
                  await this.handleOpenAIStream(
                    res,
                    nextAccount,
                    kiroPayload,
                    model,
                    startTime,
                    currentRound + 1,
                    id,
                    true,
                    matchedApiKey,
                    toolNameRegistry,
                    signal,
                    streamRetryState
                  )
                  resolve()
                  return
                }
                this.handleApiError(
                  res,
                  account,
                  error,
                  '/v1/chat/completions',
                  model,
                  startTime,
                  signal
                )
                resolve()
              })
              .catch(() => {
                this.handleApiError(
                  res,
                  account,
                  error,
                  '/v1/chat/completions',
                  model,
                  startTime,
                  signal
                )
                resolve()
              })
            return
          }

          this.handleApiError(res, account, error, '/v1/chat/completions', model, startTime, signal)
          resolve()
        },
        signal,
        this.config.preferredEndpoint
      ).catch((error) => {
        if (!this.isAbortError(error, signal) && !this.isResponseClosed(res)) {
          res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
          res.end()
          this.recordRequestFailed()
        }
        resolve()
      })
    })
  }

  // 处理 Claude Messages 请求
  private isWebSearchRequest(
    originalRequest: ClaudeRequest,
    processedRequest: ClaudeRequest
  ): boolean {
    const hasOnlyWebSearchTool = (tools?: ClaudeRequest['tools']): boolean =>
      tools?.length === 1 && tools[0]?.name === WEB_SEARCH_TOOL_NAME
    return (
      hasOnlyWebSearchTool(originalRequest.tools) && hasOnlyWebSearchTool(processedRequest.tools)
    )
  }

  private extractWebSearchQuery(request: ClaudeRequest): string | null {
    const content = request.messages[0]?.content
    const rawQuery =
      typeof content === 'string' ? content : content?.find((block) => block.type === 'text')?.text
    if (typeof rawQuery !== 'string') return null
    const query = rawQuery.startsWith(WEB_SEARCH_QUERY_PREFIX)
      ? rawQuery.slice(WEB_SEARCH_QUERY_PREFIX.length)
      : rawQuery
    return query.trim() || null
  }

  private buildWebSearchSummary(query: string, results: KiroWebSearchResult[]): string {
    const resultLines = results
      .map((result, index) => {
        const characters = Array.from(result.encrypted_content)
        const snippet =
          characters.length > WEB_SEARCH_SNIPPET_LIMIT
            ? `${characters.slice(0, WEB_SEARCH_SNIPPET_LIMIT).join('')}...`
            : result.encrypted_content
        return `${index + 1}. **${result.title}**\n   ${snippet}\n   Source: ${result.url}\n\n`
      })
      .join('')
    return `Here are the search results for "${query}":\n\n${resultLines}Please note that these are web search results and may not be fully accurate or up-to-date.`
  }

  private async callWebSearchWithRetry(
    initialAccount: ProxyAccount,
    query: string,
    matchedApiKey: import('./types').ApiKey | undefined,
    signal?: AbortSignal
  ): Promise<{ results: KiroWebSearchResult[]; account: ProxyAccount }> {
    const allowedAccountIds = this.getAllowedAccountIds(matchedApiKey?.id)
    const groupMode = this.config.multiAccountSelectionMode === 'groups'
    const allowedGroupIds = groupMode ? new Set(this.config.multiAccountGroupIds || []) : null
    const isConfiguredCandidate = (account: ProxyAccount): boolean => {
      if (allowedAccountIds && !allowedAccountIds.has(account.id)) return false
      if (allowedGroupIds) {
        const groupId = account.groupId || '__ungrouped__'
        if (!allowedGroupIds.has(groupId)) return false
      }
      return true
    }
    const isLiveCandidate = (account: ProxyAccount): boolean => {
      if (!isConfiguredCandidate(account)) return false
      if (
        account.isAvailable === false ||
        account.suspendedAt ||
        this.accountPool.isQuotaExhausted(account)
      )
        return false
      if (account.cooldownUntil && account.cooldownUntil > Date.now()) return false
      return true
    }
    const allowAccountSwitch =
      this.config.enableMultiAccount || this.config.autoSwitchOnQuotaExhausted
    const initialLiveAccount = this.accountPool.getAccount(initialAccount.id)
    const candidateIds = (
      allowAccountSwitch
        ? this.accountPool.getAllAccounts()
        : initialLiveAccount
          ? [initialLiveAccount]
          : []
    )
      .filter(isLiveCandidate)
      .map((account) => account.id)
    const permanentlyExcluded = new Set<string>()
    const refreshedAccountIds = new Set<string>()
    const attemptsByAccount = new Map<string, number>()
    const maxAttempts = Math.min(
      candidateIds.length * WEB_SEARCH_ATTEMPTS_PER_ACCOUNT,
      WEB_SEARCH_MAX_ATTEMPTS
    )
    let attempts = 0
    let currentAccountId = initialAccount.id
    let lastError: Error = new KiroMcpWebSearchError()

    const getCurrentCandidate = (accountId: string): ProxyAccount | null => {
      if (permanentlyExcluded.has(accountId) || !candidateIds.includes(accountId)) return null
      const account = this.accountPool.getAccount(accountId)
      return account && isLiveCandidate(account) ? account : null
    }

    const pickNextCandidate = (afterAccountId?: string): ProxyAccount | null => {
      if (!candidateIds.length) return null
      const afterIndex = afterAccountId ? candidateIds.indexOf(afterAccountId) : -1
      for (let offset = 1; offset <= candidateIds.length; offset++) {
        const accountId = candidateIds[(Math.max(afterIndex, -1) + offset) % candidateIds.length]
        if ((attemptsByAccount.get(accountId) || 0) >= WEB_SEARCH_ATTEMPTS_PER_ACCOUNT) continue
        const account = getCurrentCandidate(accountId)
        if (account) return account
      }
      return null
    }

    while (attempts < maxAttempts) {
      this.throwIfAborted(signal)
      let currentAccount = getCurrentCandidate(currentAccountId)
      if (
        !currentAccount ||
        (attemptsByAccount.get(currentAccount.id) || 0) >= WEB_SEARCH_ATTEMPTS_PER_ACCOUNT
      ) {
        currentAccount = pickNextCandidate(currentAccountId)
        if (!currentAccount) break
        currentAccountId = currentAccount.id
      }

      attempts += 1
      attemptsByAccount.set(currentAccount.id, (attemptsByAccount.get(currentAccount.id) || 0) + 1)
      try {
        const results = await callKiroMcpWebSearch(currentAccount, query, signal)
        return { results, account: currentAccount }
      } catch (error) {
        if (this.isAbortError(error, signal)) throw error
        lastError = error instanceof Error ? error : new KiroMcpWebSearchError()
        const upstreamError = normalizeKiroUpstreamError(lastError)
        const statusCode = upstreamError.statusCode

        if (statusCode === 401 || statusCode === 403) {
          if (!isKiroApiKeyAccount(currentAccount) && !refreshedAccountIds.has(currentAccount.id)) {
            refreshedAccountIds.add(currentAccount.id)
            if (await this.refreshToken(currentAccount, signal)) {
              currentAccountId = currentAccount.id
              continue
            }
          }
          if (isKiroApiKeyAccount(currentAccount)) {
            this.accountPool.updateAccount(currentAccount.id, { isAvailable: false })
          }
          this.accountPool.recordError(currentAccount.id, ErrorType.RECOVERABLE, statusCode)
          permanentlyExcluded.add(currentAccount.id)
          const nextAccount = pickNextCandidate(currentAccount.id)
          if (!nextAccount) break
          currentAccountId = nextAccount.id
          continue
        }

        if (statusCode === 402) {
          if (isMonthlyRequestQuotaError(upstreamError)) {
            this.recordUpstreamAccountErrorOnce(currentAccount, lastError)
            permanentlyExcluded.add(currentAccount.id)
            const nextAccount = pickNextCandidate(currentAccount.id)
            if (!nextAccount) break
            currentAccountId = nextAccount.id
            continue
          }
          break
        }

        const retryable = error instanceof KiroMcpWebSearchError ? error.retryable : true
        if (!retryable || attempts >= maxAttempts) break
        this.accountPool.recordError(currentAccount.id, ErrorType.RECOVERABLE)

        const backoff = Math.min(
          WEB_SEARCH_RETRY_BASE_MS * 2 ** (attempts - 1),
          WEB_SEARCH_RETRY_MAX_MS
        )
        const retryDelay = backoff + Math.floor(Math.random() * (Math.floor(backoff / 4) + 1))
        await this.waitForRetry(
          upstreamError.retryCategory === UpstreamRetryCategory.RATE_LIMIT
            ? Math.min(upstreamError.retryAfterMs ?? retryDelay, WEB_SEARCH_RETRY_MAX_MS)
            : retryDelay,
          signal
        )

        // 429 必须同账号退避重试；其它瞬态错误维持原有候选切换策略。
        if (upstreamError.retryCategory === UpstreamRetryCategory.RATE_LIMIT) {
          currentAccountId = currentAccount.id
          continue
        }
        const nextAccount = pickNextCandidate(currentAccount.id)
        if (!nextAccount) break
        currentAccountId = nextAccount.id
      }
    }

    throw lastError
  }

  private async sendWebSearchSse(
    res: http.ServerResponse,
    request: ClaudeRequest,
    query: string,
    results: KiroWebSearchResult[]
  ): Promise<number> {
    const messageId = `msg_${uuidv4().replace(/-/g, '').slice(0, WEB_SEARCH_MESSAGE_ID_LENGTH)}`
    const serverToolUseId = `srvtoolu_${uuidv4().replace(/-/g, '')}`
    const inputTokens = Math.max(
      1,
      Math.round(
        JSON.stringify({
          messages: request.messages,
          system: request.system,
          tools: request.tools
        }).length / 3
      )
    )
    const summary = this.buildWebSearchSummary(query, results)
    const outputTokens = Math.ceil(Buffer.byteLength(summary, 'utf-8') / 4)
    const write = async (
      type: Parameters<typeof createClaudeStreamEvent>[0],
      data?: Record<string, unknown>
    ): Promise<void> => {
      this.throwIfResponseClosed(res)
      const event = createClaudeStreamEvent(type, data)
      res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)
      await this.waitForDrain(res)
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    await write('message_start', {
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: request.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      }
    })
    await write('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    await write('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: `I'll search for "${query}".` }
    })
    await write('content_block_stop', { index: 0 })
    await write('content_block_start', {
      index: 1,
      content_block: {
        type: 'server_tool_use',
        id: serverToolUseId,
        name: WEB_SEARCH_TOOL_NAME,
        input: { query }
      }
    })
    await write('content_block_stop', { index: 1 })
    await write('content_block_start', {
      index: 2,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: serverToolUseId,
        content: results
      }
    })
    await write('content_block_stop', { index: 2 })
    await write('content_block_start', { index: 3, content_block: { type: 'text', text: '' } })
    for (const characters of chunkCodePoints(summary, WEB_SEARCH_SUMMARY_CHUNK_SIZE)) {
      await write('content_block_delta', {
        index: 3,
        delta: { type: 'text_delta', text: characters }
      })
    }
    await write('content_block_stop', { index: 3 })
    await write('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: {
        output_tokens: outputTokens,
        server_tool_use: { web_search_requests: 1 }
      }
    })
    await write('message_stop')
    res.end()
    return outputTokens
  }

  private async handleClaudeMessages(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    signal?: AbortSignal,
    isClaudeCode: boolean = false
  ): Promise<void> {
    let request: ClaudeRequest
    try {
      const body = await this.readBody(req, signal)
      this.throwIfAborted(signal)
      request = JSON.parse(body) as ClaudeRequest
    } catch (error) {
      if (this.isAbortError(error, signal)) return
      if (error instanceof BodyTooLargeError) throw error
      this.sendError(res, 400, 'Invalid request body', 'anthropic')
      return
    }
    const matchedApiKey = (req as unknown as { matchedApiKey?: import('./types').ApiKey })
      .matchedApiKey

    // 提取 session hint（用于稳定 conversationId），拼入 API Key hash 隔离不同用户
    const rawHint = ProxyServer.extractSessionHint(req, request)
    if (!request.conversation_id && rawHint) {
      const keyPrefix = matchedApiKey?.id?.slice(0, 8) || 'default'
      request.conversation_id = `${keyPrefix}:${rawHint}`
    }
    // P1-8 会话粘性使用 conversation_id 作为粘性 key（已包含 API Key 前缀）
    const affinityHint = request.conversation_id

    // 应用模型映射
    request.model = this.applyModelMapping(request.model, matchedApiKey?.id)
    this.annotateModelRemap(res, request.model)

    const startTime = Date.now()

    this.recordNewRequest()
    this.notifyEventSafely(() => this.events.onRequest?.({ path: '/v1/messages', method: 'POST' }))

    let processedRequest: ClaudeRequest
    try {
      processedRequest = await this.resolveClaudeHttpImages(
        this.prepareClaudeRequest(request),
        signal
      )
    } catch (error) {
      if (this.isAbortError(error, signal)) return
      this.recordRequestFailed()
      const message = error instanceof Error ? error.message : 'Invalid request'
      this.sendError(res, 400, message, 'anthropic')
      this.events.onResponse?.({
        path: '/v1/messages',
        model: request.model,
        status: 400,
        error: message
      })
      this.recordRequest({
        path: '/v1/messages',
        model: request.model,
        responseTime: Date.now() - startTime,
        success: false,
        error: message
      })
      return
    }

    const isWebSearch = this.isWebSearchRequest(request, processedRequest)
    const webSearchQuery = isWebSearch ? this.extractWebSearchQuery(request) : null
    if (isWebSearch && !webSearchQuery) {
      this.recordRequestFailed()
      const message = 'A non-empty web search query is required'
      this.sendError(res, 400, message, 'anthropic')
      this.events.onResponse?.({
        path: '/v1/messages',
        model: request.model,
        status: 400,
        error: message
      })
      this.recordRequest({
        path: '/v1/messages',
        model: request.model,
        responseTime: Date.now() - startTime,
        success: false,
        error: message
      })
      return
    }

    // 获取账号（包含 Token 刷新检查 + 会话粘性 + API Key 账号白名单）
    this.throwIfAborted(signal)
    const account = await this.getAvailableAccount(signal, affinityHint, matchedApiKey?.id)
    this.throwIfAborted(signal)
    if (!account) {
      this.recordRequestFailed()
      const quotaStatus = this.accountPool.getQuotaStatus()
      const errorMsg =
        quotaStatus.exhausted > 0 && quotaStatus.available === 0
          ? `All accounts quota exhausted (${quotaStatus.exhausted}/${quotaStatus.total} exhausted, ${quotaStatus.cooldown} in cooldown)`
          : 'No available accounts'
      this.sendError(res, 503, errorMsg, 'anthropic')
      this.events.onResponse?.({
        path: '/v1/messages',
        model: request.model,
        status: 503,
        error: errorMsg
      })
      this.recordRequest({
        path: '/v1/messages',
        model: request.model,
        success: false,
        error: errorMsg
      })
      return
    }

    this.notifyEventSafely(() =>
      this.events.onRequest?.({ path: '/v1/messages', method: 'POST', accountId: account.id })
    )

    if (isWebSearch && webSearchQuery) {
      let settled = false
      const settle = (success: boolean, settledAccount: ProxyAccount, error?: string): void => {
        if (settled) return
        settled = true
        const responseTime = Date.now() - startTime
        if (success) {
          this.recordRequestSuccess()
          this.accountPool.recordSuccess(settledAccount.id, 0)
          this.recordRequest({
            path: '/v1/messages',
            model: request.model,
            accountId: settledAccount.id,
            inputTokens: 0,
            outputTokens: 0,
            responseTime,
            success: true
          })
          return
        }

        this.recordRequestFailed()
        this.recordRequest({
          path: '/v1/messages',
          model: request.model,
          accountId: settledAccount.id,
          responseTime,
          success: false,
          error
        })
      }

      try {
        const { results, account: usedAccount } = await this.callWebSearchWithRetry(
          account,
          webSearchQuery,
          matchedApiKey,
          signal
        )
        this.throwIfResponseClosed(res, signal)
        await this.sendWebSearchSse(res, processedRequest, webSearchQuery, results)
        settle(true, usedAccount)
        if (matchedApiKey) {
          this.recordApiKeyUsage(matchedApiKey.id, 0, 0, 0, request.model, '/v1/messages')
        }
        this.notifyEventSafely(() =>
          this.events.onResponse?.({
            path: '/v1/messages',
            model: request.model,
            status: 200,
            tokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            responseTime: Date.now() - startTime
          })
        )
      } catch (error) {
        if (this.isAbortError(error, signal) || this.isResponseClosed(res)) {
          settle(false, account, 'Web search request aborted')
          return
        }
        if (res.headersSent) {
          settle(false, account, 'Web search response interrupted')
          res.destroy(error instanceof Error ? error : undefined)
          return
        }
        const safeMessage = 'Web search is unavailable'
        settle(false, account, safeMessage)
        this.sendError(res, 502, safeMessage, 'anthropic')
        this.notifyEventSafely(() =>
          this.events.onResponse?.({
            path: '/v1/messages',
            model: request.model,
            status: 502,
            error: safeMessage
          })
        )
      }
      return
    }

    try {
      const toolNameRegistry = new ToolNameRegistry()

      const claudeThinkingConfig = this.getThinkingConfig(processedRequest.model)
      const kiroPayload = claudeToKiro(
        processedRequest,
        account.profileArn,
        toolNameRegistry,
        claudeThinkingConfig
      )

      // 构建 prompt cache profile（用于模拟缓存 usage）
      const estimatedInputTokens = Math.max(1, Math.round(JSON.stringify(kiroPayload).length * 0.3))
      const cacheProfile = promptCacheTracker.buildClaudeProfile(
        processedRequest.system,
        processedRequest.messages,
        processedRequest.tools,
        estimatedInputTokens,
        processedRequest.model
      )
      const cacheUsage = promptCacheTracker.compute(account.id, cacheProfile)

      if (cacheProfile) {
        proxyLogger.info(
          'ProxyServer',
          `Prompt cache: ${cacheProfile.breakpoints.length} breakpoints, creation=${cacheUsage.cacheCreationInputTokens}, read=${cacheUsage.cacheReadInputTokens}`
        )
      }

      // 记录请求详情到日志
      if (this.config.logRequests) {
        const userInput = kiroPayload.conversationState.currentMessage?.userInputMessage
        const contentLength = typeof userInput?.content === 'string' ? userInput.content.length : 0
        const toolsCount = userInput?.userInputMessageContext?.tools?.length || 0
        const historyLength = kiroPayload.conversationState.history?.length || 0
        const hasImages = (userInput?.images?.length || 0) > 0

        proxyLogger.info('ProxyServer', `Claude API: ${request.model}`, {
          model: request.model,
          stream: request.stream,
          contentLength,
          toolsCount,
          historyLength,
          hasImages,
          accountId: account.id.substring(0, 8) + '...'
        })
      }

      if (request.stream) {
        // 流式响应（流式不使用重试机制，错误由流处理）
        await this.handleClaudeStream(
          res,
          account,
          kiroPayload,
          request.model,
          startTime,
          0,
          undefined,
          false,
          0,
          matchedApiKey,
          toolNameRegistry,
          signal,
          cacheProfile ? { ...cacheUsage, cacheProfile, accountId: account.id } : undefined,
          isClaudeCode
        )
      } else {
        // 非流式响应（带重试机制）
        const { result, account: usedAccount } = await this.callWithRetry(
          account,
          async (acc) => {
            const retryPayload = claudeToKiro(
              processedRequest,
              acc.profileArn,
              toolNameRegistry,
              claudeThinkingConfig
            )
            return callKiroApi(acc, retryPayload, signal)
          },
          '/v1/messages',
          signal,
          matchedApiKey?.id
        )
        const response = kiroToClaudeResponse(
          result.content,
          result.toolUses,
          result.usage,
          request.model,
          toolNameRegistry,
          result.reasoningContent
        )

        // 用缓存模拟的 usage 覆盖（如果有 cache profile）
        if (cacheProfile && cacheUsage) {
          if (cacheUsage.cacheCreationInputTokens > 0)
            response.usage.cache_creation_input_tokens = cacheUsage.cacheCreationInputTokens
          if (cacheUsage.cacheReadInputTokens > 0)
            response.usage.cache_read_input_tokens = cacheUsage.cacheReadInputTokens
          promptCacheTracker.update(usedAccount.id, cacheProfile)
        }

        this.throwIfResponseClosed(res, signal)
        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        this.stats.inputTokens += result.usage.inputTokens
        this.stats.outputTokens += result.usage.outputTokens
        this.accountPool.recordSuccess(
          usedAccount.id,
          result.usage.inputTokens + result.usage.outputTokens
        )

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
        const respTime = Date.now() - startTime
        this.events.onResponse?.({
          path: '/v1/messages',
          model: request.model,
          status: 200,
          tokens: result.usage.inputTokens + result.usage.outputTokens,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          reasoningTokens: result.usage.reasoningTokens,
          credits: result.usage.credits,
          responseTime: respTime
        })
        this.recordRequest({
          path: '/v1/messages',
          model: request.model,
          accountId: usedAccount.id,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          credits: result.usage.credits,
          responseTime: respTime,
          success: true
        })
      }
    } catch (error) {
      const failure = this.getTerminalRetryFailure(error as Error, account)
      this.handleApiError(
        res,
        failure.account,
        failure.error,
        '/v1/messages',
        request.model,
        startTime,
        signal
      )
    }
  }

  // 处理 Claude 流式响应
  private async handleClaudeStream(
    res: http.ServerResponse,
    account: ProxyAccount,
    kiroPayload: ReturnType<typeof claudeToKiro>,
    model: string,
    startTime: number,
    currentRound: number = 0,
    msgId?: string,
    headersSent: boolean = false,
    contentBlockIndex: number = 0,
    matchedApiKey?: import('./types').ApiKey,
    toolNameRegistry: ToolNameRegistry = new ToolNameRegistry(),
    signal?: AbortSignal,
    simulatedCacheUsage?: {
      cacheCreationInputTokens: number
      cacheReadInputTokens: number
      cacheProfile?: unknown
      accountId?: string
    },
    isClaudeCode: boolean = false,
    streamRetryState: { triedIds: Set<string>; refreshedAccountIds: Set<string> } = {
      triedIds: new Set([account.id]),
      refreshedAccountIds: new Set()
    }
  ): Promise<void> {
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
    }

    const writeSse = async (frame: string): Promise<void> => {
      if (signal?.aborted || this.isResponseClosed(res)) return
      res.write(frame)
      await this.waitForDrain(res)
    }
    // 先发送 HTTP headers，Claude Code 的业务 SSE 仍严格缓冲到 contextUsageEvent。
    if (isClaudeCode) res.flushHeaders()
    const estimatedInputTokens = Math.max(1, Math.round(JSON.stringify(kiroPayload).length / 3))
    const claudeCodeBuffer = isClaudeCode
      ? new ClaudeCodeStreamBuffer(
          writeSse,
          () => signal?.aborted === true || this.isResponseClosed(res),
          estimatedInputTokens
        )
      : undefined
    const emitSse = async (frame: string): Promise<void> => {
      if (claudeCodeBuffer) await claudeCodeBuffer.write(frame)
      else await writeSse(frame)
    }
    res.once('close', () => claudeCodeBuffer?.discard())

    const id = msgId || `msg_${uuidv4()}`
    let currentBlockIndex = contentBlockIndex
    let hasStartedTextBlock = false
    let hasStartedThinkingBlock = false
    let pendingThinkingSignature: string | undefined
    let collectedContent = ''
    const pendingToolCalls: Map<string, { name: string; input: Record<string, unknown> }> =
      new Map()

    const flushThinkingSignature = async (): Promise<void> => {
      if (!pendingThinkingSignature) return
      const signatureDelta = createClaudeStreamEvent('content_block_delta', {
        index: currentBlockIndex,
        delta: { type: 'signature_delta', signature: pendingThinkingSignature }
      })
      await emitSse(`event: content_block_delta\ndata: ${JSON.stringify(signatureDelta)}\n\n`)
      pendingThinkingSignature = undefined
    }

    // estimatedInputTokens 同时作为 Claude Code 缓冲超限/超时的安全回退值。

    // 发送 message_start（仅首轮）
    if (currentRound === 0) {
      const messageStart = createClaudeStreamEvent('message_start', {
        message: {
          id,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimatedInputTokens, output_tokens: 0 }
        }
      })
      await emitSse(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`)
    }

    let hasWrittenUpstreamChunk = false

    /**
     * 上游中途失败、已经吐出部分内容且无法重试时，把 SSE 流合法收尾。
     *
     * 已发送 message_start + content_block_delta 后直接 res.end() 会留下未闭合的
     * content block：宽容的客户端认下 error 事件，严格的会挂在解析上。这里补齐
     * content_block_stop 与 message_delta(stop_reason: 'error')，让流符合协议，
     * 客户端能明确区分"截断"与"正常结束"。
     */
    const closeTruncatedStream = async (): Promise<void> => {
      if (hasStartedThinkingBlock) {
        await flushThinkingSignature()
        const blockStop = createClaudeStreamEvent('content_block_stop', {
          index: currentBlockIndex
        })
        await emitSse(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
        currentBlockIndex++
        hasStartedThinkingBlock = false
      }
      if (hasStartedTextBlock) {
        const blockStop = createClaudeStreamEvent('content_block_stop', {
          index: currentBlockIndex
        })
        await emitSse(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
        currentBlockIndex++
        hasStartedTextBlock = false
      }
      // stop_reason 用 'error' 明确告知这是截断而非 end_turn
      const messageDelta = createClaudeStreamEvent('message_delta', {
        delta: { stop_reason: 'error', stop_sequence: null } as any,
        usage: { output_tokens: 0 }
      })
      await emitSse(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`)
    }

    return new Promise((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const closeFailedStream = (error: unknown): void => {
        claudeCodeBuffer?.discard()
        if (!res.writableEnded && !res.destroyed) {
          res.destroy(error instanceof Error ? error : undefined)
        }
      }
      callKiroApiStream(
        account as any,
        kiroPayload,
        async (text, toolUse, isThinking, reasoningSignature, redactedContent) => {
          if (signal?.aborted || this.isResponseClosed(res)) return
          hasWrittenUpstreamChunk = true
          // 优先处理 redacted_thinking（加密的 thinking 块，需单独 content_block）
          if (redactedContent) {
            if (hasStartedTextBlock) {
              const blockStop = createClaudeStreamEvent('content_block_stop', {
                index: currentBlockIndex
              })
              await emitSse(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
              hasStartedTextBlock = false
            }
            if (hasStartedThinkingBlock) {
              await flushThinkingSignature()
              const blockStop = createClaudeStreamEvent('content_block_stop', {
                index: currentBlockIndex
              })
              await emitSse(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
              hasStartedThinkingBlock = false
            }
            const blockStart = createClaudeStreamEvent('content_block_start', {
              index: currentBlockIndex,
              content_block: { type: 'redacted_thinking', data: redactedContent }
            })
            await emitSse(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
            const blockStop = createClaudeStreamEvent('content_block_stop', {
              index: currentBlockIndex
            })
            await emitSse(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
            currentBlockIndex++
            return this.waitForDrain(res)
          }
          if (text && text.trim()) {
            if (isThinking) {
              // 原生 thinking 内容 → 输出为 Anthropic thinking block
              if (hasStartedTextBlock) {
                const blockStop = createClaudeStreamEvent('content_block_stop', {
                  index: currentBlockIndex
                })
                await emitSse(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
                currentBlockIndex++
                hasStartedTextBlock = false
              }
              if (!hasStartedThinkingBlock) {
                const blockStart = createClaudeStreamEvent('content_block_start', {
                  index: currentBlockIndex,
                  content_block: { type: 'thinking', thinking: '' }
                })
                await emitSse(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
                hasStartedThinkingBlock = true
              }
              const delta = createClaudeStreamEvent('content_block_delta', {
                index: currentBlockIndex,
                delta: { type: 'thinking_delta', thinking: text }
              })
              await emitSse(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`)
              if (reasoningSignature) {
                pendingThinkingSignature = reasoningSignature
              }
            } else {
              // 普通文本内容
              if (hasStartedThinkingBlock) {
                await flushThinkingSignature()
                const blockStop = createClaudeStreamEvent('content_block_stop', {
                  index: currentBlockIndex
                })
                await emitSse(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
                currentBlockIndex++
                hasStartedThinkingBlock = false
              }
              collectedContent += text
              if (!hasStartedTextBlock) {
                const blockStart = createClaudeStreamEvent('content_block_start', {
                  index: currentBlockIndex,
                  content_block: { type: 'text', text: '' }
                })
                await emitSse(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
                hasStartedTextBlock = true
              }
              const delta = createClaudeStreamEvent('content_block_delta', {
                index: currentBlockIndex,
                delta: { type: 'text_delta', text }
              })
              await emitSse(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`)
            }
          } else if (isThinking && reasoningSignature) {
            if (!hasStartedThinkingBlock) {
              const blockStart = createClaudeStreamEvent('content_block_start', {
                index: currentBlockIndex,
                content_block: { type: 'thinking', thinking: '' }
              })
              await emitSse(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
              hasStartedThinkingBlock = true
            }
            pendingThinkingSignature = reasoningSignature
          }
          if (toolUse) {
            const restoredToolUse = toolNameRegistry.restoreToolUse(toolUse)
            if (hasStartedThinkingBlock) {
              await flushThinkingSignature()
              const blockStop = createClaudeStreamEvent('content_block_stop', {
                index: currentBlockIndex
              })
              await emitSse(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
              hasStartedThinkingBlock = false
            }
            // 结束之前的文本块
            if (hasStartedTextBlock) {
              const blockStop = createClaudeStreamEvent('content_block_stop', {
                index: currentBlockIndex
              })
              await emitSse(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
              hasStartedTextBlock = false
            }
            // 记录工具调用
            pendingToolCalls.set(toolUse.toolUseId, { name: toolUse.name, input: toolUse.input })
            // 开始工具块
            const toolBlockStart = createClaudeStreamEvent('content_block_start', {
              index: currentBlockIndex,
              content_block: {
                type: 'tool_use',
                id: toolUse.toolUseId,
                name: restoredToolUse.name,
                input: {}
              }
            })
            await emitSse(`event: content_block_start\ndata: ${JSON.stringify(toolBlockStart)}\n\n`)
            // 发送工具输入
            const toolDelta = createClaudeStreamEvent('content_block_delta', {
              index: currentBlockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(toolUse.input)
              } as any
            })
            await emitSse(`event: content_block_delta\ndata: ${JSON.stringify(toolDelta)}\n\n`)
            // 结束工具块
            const toolBlockStop = createClaudeStreamEvent('content_block_stop', {
              index: currentBlockIndex
            })
            await emitSse(`event: content_block_stop\ndata: ${JSON.stringify(toolBlockStop)}\n\n`)
            currentBlockIndex++
          }
          return this.waitForDrain(res)
        },
        async (usage) => {
          try {
            if (signal?.aborted || this.isResponseClosed(res)) {
              claudeCodeBuffer?.discard()
              settle()
              return
            }
            // 未收到 contextUsageEvent 时，保留原先 payload 估算作为 Claude Code 首帧 usage。
            await claudeCodeBuffer?.release(estimatedInputTokens)
            if (hasStartedThinkingBlock) {
              await flushThinkingSignature()
              const blockStop = createClaudeStreamEvent('content_block_stop', {
                index: currentBlockIndex
              })
              await emitSse(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
              hasStartedThinkingBlock = false
            }

            // 结束最后的文本块
            if (hasStartedTextBlock) {
              const blockStop = createClaudeStreamEvent('content_block_stop', {
                index: currentBlockIndex
              })
              await emitSse(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
            }

            this.recordRequestSuccess()
            this.stats.totalTokens += usage.inputTokens + usage.outputTokens
            this.stats.inputTokens += usage.inputTokens
            this.stats.outputTokens += usage.outputTokens
            this.stats.totalCredits += usage.credits || 0
            this.events.onCreditsUpdate?.(this.stats.totalCredits)
            this.events.onTokensUpdate?.(this.stats.inputTokens, this.stats.outputTokens)
            this.accountPool.recordSuccess(account.id, usage.inputTokens + usage.outputTokens)
            this.stats.cacheReadTokens +=
              usage.cacheReadTokens || simulatedCacheUsage?.cacheReadInputTokens || 0
            this.stats.cacheWriteTokens +=
              usage.cacheWriteTokens || simulatedCacheUsage?.cacheCreationInputTokens || 0
            this.stats.reasoningTokens += usage.reasoningTokens || 0
            const respTime = Date.now() - startTime
            this.events.onResponse?.({
              path: '/v1/messages',
              model,
              status: 200,
              tokens: usage.inputTokens + usage.outputTokens,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens || simulatedCacheUsage?.cacheReadInputTokens,
              reasoningTokens: usage.reasoningTokens,
              credits: usage.credits,
              responseTime: respTime
            })
            this.recordRequest({
              path: '/v1/messages',
              model,
              accountId: account.id,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              credits: usage.credits,
              responseTime: respTime,
              success: true
            })
            // 记录 API Key 用量
            if (matchedApiKey) {
              this.recordApiKeyUsage(
                matchedApiKey.id,
                usage.credits || 0,
                usage.inputTokens,
                usage.outputTokens,
                model,
                '/v1/messages'
              )
            }

            // 成功后更新 prompt cache tracker
            if (simulatedCacheUsage?.cacheProfile && simulatedCacheUsage?.accountId) {
              promptCacheTracker.update(
                simulatedCacheUsage.accountId,
                simulatedCacheUsage.cacheProfile as any
              )
            }
            // 发送 message_delta（包含完整 usage 信息）
            const hasToolCalls = pendingToolCalls.size > 0
            const stopReason = hasToolCalls ? 'tool_use' : 'end_turn'
            const messageDelta = createClaudeStreamEvent('message_delta', {
              delta: { stop_reason: stopReason, stop_sequence: null } as any,
              usage: this.buildClaudeUsage(usage, simulatedCacheUsage)
            })
            await emitSse(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`)
            // 发送 message_stop
            const messageStop = createClaudeStreamEvent('message_stop')
            await emitSse(`event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`)
            res.end()
          } catch (callbackError) {
            proxyLogger.warn(
              'ProxyServer',
              'Claude stream completion callback failed',
              callbackError
            )
            closeFailedStream(callbackError)
          } finally {
            settle()
          }
        },
        async (error) => {
          try {
            if (this.isAbortError(error, signal) || this.isResponseClosed(res)) {
              claudeCodeBuffer?.discard()
              settle()
              return
            }
            if (!hasWrittenUpstreamChunk) {
              const nextAccount = await this.getStreamRetryAccount(
                account,
                error,
                matchedApiKey?.id,
                streamRetryState,
                signal
              )
              if (nextAccount) {
                claudeCodeBuffer?.discard()
                await this.handleClaudeStream(
                  res,
                  nextAccount,
                  kiroPayload,
                  model,
                  startTime,
                  currentRound + 1,
                  id,
                  true,
                  contentBlockIndex,
                  matchedApiKey,
                  toolNameRegistry,
                  signal,
                  simulatedCacheUsage,
                  isClaudeCode,
                  streamRetryState
                )
                settle()
                return
              }
            }
            const upstreamError = normalizeKiroUpstreamError(error)
            console.error(
              `[ProxyServer] Stream error: HTTP ${upstreamError.statusCode || 'unknown'}`
            )
            // 已吐出部分内容且无法重试：先把 content block 闭合再报错，避免客户端
            // 收到未闭合的流。必须在 discard 之前做，否则这些帧会被一起丢掉。
            //
            // Claude Code 缓冲未释放时跳过：那种情况下 discard 会连 message_start
            // 一起丢，客户端本就收不到任何内容帧，补收尾无意义。
            if (hasWrittenUpstreamChunk && (!claudeCodeBuffer || claudeCodeBuffer.isReleased)) {
              try {
                await closeTruncatedStream()
              } catch (closeError) {
                proxyLogger.warn(
                  'ProxyServer',
                  'Failed to close truncated Claude stream',
                  closeError
                )
              }
            }
            claudeCodeBuffer?.discard()
            const errorEvent = createClaudeStreamEvent('error', {
              error: { type: 'api_error', message: upstreamError.message }
            })
            await writeSse(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`)
            res.end()

            this.recordRequestFailed()
            const statusCode = upstreamError.statusCode || 500
            this.recordUpstreamAccountErrorOnce(account, error)
            this.events.onResponse?.({
              path: '/v1/messages',
              model,
              status: statusCode,
              error: upstreamError.message
            })
            this.recordRequest({
              path: '/v1/messages',
              model,
              accountId: account.id,
              responseTime: Date.now() - startTime,
              success: false,
              error: upstreamError.message
            })
          } catch (callbackError) {
            proxyLogger.warn('ProxyServer', 'Claude stream error callback failed', callbackError)
            closeFailedStream(callbackError)
          } finally {
            settle()
          }
        },
        signal,
        this.config.preferredEndpoint,
        async (usage) => {
          if (claudeCodeBuffer && !signal?.aborted && !this.isResponseClosed(res)) {
            await claudeCodeBuffer.release(usage.inputTokens)
          }
        }
      ).catch(async (error) => {
        try {
          claudeCodeBuffer?.discard()
          if (!this.isAbortError(error, signal) && !this.isResponseClosed(res)) {
            const errorEvent = createClaudeStreamEvent('error', {
              error: { type: 'api_error', message: error.message }
            })
            await writeSse(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`)
            res.end()
            this.recordRequestFailed()
          }
        } catch (callbackError) {
          proxyLogger.warn(
            'ProxyServer',
            'Claude stream fallback error callback failed',
            callbackError
          )
          closeFailedStream(callbackError)
        } finally {
          settle()
        }
      })
    })
  }

  // 处理 API 错误
  private handleApiError(
    res: http.ServerResponse,
    account: { id: string },
    error: Error,
    path: string,
    model?: string,
    startTime?: number,
    signal?: AbortSignal
  ): void {
    if (this.isAbortError(error, signal) || this.isResponseClosed(res)) return
    this.recordRequestFailed()
    const upstreamError = normalizeKiroUpstreamError(error)
    const statusCode =
      upstreamError.retryCategory === UpstreamRetryCategory.AUTHENTICATION
        ? 401
        : upstreamError.statusCode || 500
    this.recordUpstreamAccountErrorOnce(account, error)

    if (res.headersSent) {
      if (!this.isResponseClosed(res)) {
        if (path === '/v1/chat/completions') {
          res.write(
            `data: ${JSON.stringify({ error: { message: upstreamError.message, type: 'api_error', code: statusCode } })}\n\n`
          )
          res.write('data: [DONE]\n\n')
        } else if (path === '/v1/responses' || path === '/responses') {
          res.write(
            `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', error: { type: 'api_error', message: upstreamError.message } })}\n\n`
          )
        }
        res.end()
      }
      this.events.onResponse?.({ path, status: statusCode, error: upstreamError.message })
      this.recordRequest({
        path,
        model,
        accountId: account.id,
        responseTime: startTime ? Date.now() - startTime : 0,
        success: false,
        error: upstreamError.message
      })
      return
    }

    this.sendError(
      res,
      statusCode,
      upstreamError.message,
      this.isAnthropicPath(path) ? 'anthropic' : 'openai'
    )
    this.events.onResponse?.({ path, status: statusCode, error: upstreamError.message })
    this.recordRequest({
      path,
      model,
      accountId: account.id,
      responseTime: startTime ? Date.now() - startTime : 0,
      success: false,
      error: upstreamError.message
    })
  }

  // 读取请求体
  /**
   * 读取请求体，限制最大字节数以防 DoS
   * - Content-Length 头超限：立即 reject
   * - 流式累加超限：销毁连接并 reject
   * 触发 BodyTooLarge 错误时上层会发 413 Payload Too Large
   */
  private readBody(req: http.IncomingMessage, signal?: AbortSignal): Promise<string> {
    const maxBytes = Math.max(1024, this.config.maxRequestBodyBytes ?? 10 * 1024 * 1024)

    // 优先用 Content-Length 提前拒绝（避免分配缓冲）
    const declaredLen = parseInt(req.headers['content-length'] || '0', 10)
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      return Promise.reject(new BodyTooLargeError(declaredLen, maxBytes))
    }

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      const cleanup = () => {
        req.off('data', onData)
        req.off('end', onEnd)
        req.off('error', onError)
        req.off('aborted', onAborted)
        signal?.removeEventListener('abort', onAbort)
      }
      const onData = (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) {
          cleanup()
          try {
            req.destroy()
          } catch {
            /* ignore */
          }
          reject(new BodyTooLargeError(total, maxBytes))
          return
        }
        chunks.push(chunk)
      }
      const onEnd = () => {
        cleanup()
        resolve(Buffer.concat(chunks, total).toString('utf8'))
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onAborted = () => {
        cleanup()
        reject(new Error('Client disconnected'))
      }
      const onAbort = () => {
        cleanup()
        reject(this.getAbortError(signal))
      }
      if (signal?.aborted) {
        reject(this.getAbortError(signal))
        return
      }
      req.on('data', onData)
      req.on('end', onEnd)
      req.on('error', onError)
      req.on('aborted', onAborted)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  // 发送错误响应
  // P0-5 自动 sanitize：500 类不吐 message 详情；4xx 客户端错误正常返回
  private sendError(
    res: http.ServerResponse,
    status: number,
    message: string,
    format: 'openai' | 'anthropic' = 'openai'
  ): void {
    if (res.writableEnded || res.destroyed) return
    // 500-599 强制使用通用消息（防止泄露内部信息）
    const safeMessage =
      status >= 500 && status < 600
        ? this.sanitizeErrorMessage(message) || 'Internal server error'
        : message
    // 503 时记录账号池耗尽事件并通知主进程。
    if (status === 503) {
      this.notifyAllAccountsExhausted('unknown')
    }
    res.writeHead(status, { 'Content-Type': 'application/json' })
    if (format === 'anthropic') {
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: this.getAnthropicErrorType(status),
            message: safeMessage
          }
        })
      )
      return
    }
    res.end(JSON.stringify({ error: { message: safeMessage, type: 'error', code: status } }))
  }

  /**
   * P0-5 / P2-19 错误消息脱敏（移除可能含的 Bearer/Token/路径等敏感信息）
   * 用于错误响应和日志输出
   */
  private sanitizeErrorMessage(msg: string): string {
    if (!msg) return ''
    return (
      msg
        // Bearer xxxx → Bearer ***
        .replace(/Bearer\s+[A-Za-z0-9\-_.~+/]+=*/gi, 'Bearer ***')
        // access_token / refresh_token / api_key / x-api-key 字段值
        .replace(
          /(access[_-]?token|refresh[_-]?token|api[_-]?key|x-api-key)["'\s:=]+[^"',\s}]+/gi,
          '$1=***'
        )
        // 长 base64/JWT（>= 40 chars）替换为占位
        .replace(/eyJ[A-Za-z0-9\-_]{20,}/g, 'eyJ***')
        // Windows 用户路径
        .replace(/C:\\Users\\[^\\/\s]+/gi, 'C:\\Users\\***')
        // Linux/Mac home 路径
        .replace(/\/home\/[^\s/]+/g, '/home/***')
        .replace(/\/Users\/[^\s/]+/g, '/Users/***')
    )
  }

  /**
   * P1-7 滑动窗口限流：每分钟 N 次（按 API Key id 或 IP）
   * 0 = 不限制
   */
  private checkRateLimit(id: string): { allowed: boolean; retryAfterMs: number } {
    const limit = this.config.rateLimitPerKeyPerMinute || 0
    if (limit <= 0) return { allowed: true, retryAfterMs: 0 }

    const now = Date.now()
    const bucket = this.rateLimitBuckets.get(id)
    if (!bucket || now - bucket.windowStart >= 60_000) {
      this.rateLimitBuckets.set(id, { count: 1, windowStart: now })
      return { allowed: true, retryAfterMs: 0 }
    }
    if (bucket.count >= limit) {
      return { allowed: false, retryAfterMs: 60_000 - (now - bucket.windowStart) }
    }
    bucket.count++
    return { allowed: true, retryAfterMs: 0 }
  }

  /** 定期清理过期的限流桶 / 会话粘性条目（避免内存泄漏） */
  private cleanupExpiredCaches(): void {
    const now = Date.now()
    // 限流桶过期 2 分钟
    for (const [key, bucket] of this.rateLimitBuckets) {
      if (now - bucket.windowStart > 120_000) this.rateLimitBuckets.delete(key)
    }
    // 粘性会话过期 10 分钟
    for (const [key, entry] of this.sessionAffinity) {
      if (now - entry.lastAt > 600_000) this.sessionAffinity.delete(key)
    }
    // 审计日志最多 200 条
    if (this.auditLog.length > 200) {
      this.auditLog = this.auditLog.slice(-200)
    }
  }

  /**
   * P1-8 会话粘性账号选择：相同 session hint 优先复用同一账号
   * 实现方式：用 sessionHint hash 索引到固定账号；账号失效时自动失效粘性
   */
  private pickAccountWithAffinity(sessionHint: string | undefined): ProxyAccount | null {
    if (!this.config.sessionAffinityEnabled || !sessionHint) return null
    const entry = this.sessionAffinity.get(sessionHint)
    if (entry) {
      const account = this.accountPool.getAccount(entry.accountId)
      // 校验账号仍可用且未被封禁
      if (account && !this.accountPool.isSuspended(account) && account.isAvailable !== false) {
        entry.lastAt = Date.now()
        return account
      }
      // 已失效 → 清掉粘性
      this.sessionAffinity.delete(sessionHint)
    }
    return null
  }

  /** 记录粘性映射 */
  private rememberAffinity(sessionHint: string | undefined, accountId: string): void {
    if (!this.config.sessionAffinityEnabled || !sessionHint) return
    this.sessionAffinity.set(sessionHint, { accountId, lastAt: Date.now() })
  }

  /** P2-17 审计日志 */
  private appendAuditLog(type: string, data: Record<string, unknown>): void {
    if (!this.config.enableAuditLog) return
    this.auditLog.push({ ts: Date.now(), type, data })
    if (this.auditLog.length > 200) this.auditLog.shift()
  }

  /** 获取审计日志（供管理 API） */
  getAuditLog(): ReadonlyArray<{ ts: number; type: string; data: Record<string, unknown> }> {
    return this.auditLog
  }

  /** 全员配额耗尽时保留审计记录并通知主进程。 */
  private notifyAllAccountsExhausted(path: string, model?: string): void {
    const quota = this.accountPool.getQuotaStatus()
    if (quota.available !== 0) return
    this.appendAuditLog('all_accounts_exhausted', { path, model, ...quota })
    this.events.onAllAccountsExhausted?.()
  }

  /** P2-16 Prometheus metrics 文本 */
  private renderPrometheusMetrics(): string {
    const s = this.stats
    const ap = this.accountPool
    const lines: string[] = []
    lines.push('# HELP kiro_proxy_requests_total Total requests handled')
    lines.push('# TYPE kiro_proxy_requests_total counter')
    lines.push(`kiro_proxy_requests_total ${s.totalRequests}`)
    lines.push('# HELP kiro_proxy_requests_success_total Total successful requests')
    lines.push('# TYPE kiro_proxy_requests_success_total counter')
    lines.push(`kiro_proxy_requests_success_total ${s.successRequests}`)
    lines.push('# HELP kiro_proxy_requests_failed_total Total failed requests')
    lines.push('# TYPE kiro_proxy_requests_failed_total counter')
    lines.push(`kiro_proxy_requests_failed_total ${s.failedRequests}`)
    lines.push('# HELP kiro_proxy_tokens_total Total tokens consumed')
    lines.push('# TYPE kiro_proxy_tokens_total counter')
    lines.push(`kiro_proxy_tokens_total{type="input"} ${s.inputTokens}`)
    lines.push(`kiro_proxy_tokens_total{type="output"} ${s.outputTokens}`)
    lines.push(`kiro_proxy_tokens_total{type="cache_read"} ${s.cacheReadTokens}`)
    lines.push(`kiro_proxy_tokens_total{type="cache_write"} ${s.cacheWriteTokens}`)
    lines.push('# HELP kiro_proxy_credits_total Total credits consumed')
    lines.push('# TYPE kiro_proxy_credits_total counter')
    lines.push(`kiro_proxy_credits_total ${s.totalCredits}`)
    lines.push('# HELP kiro_proxy_accounts Accounts by status')
    lines.push('# TYPE kiro_proxy_accounts gauge')
    const quota = ap.getQuotaStatus()
    lines.push(`kiro_proxy_accounts{status="total"} ${quota.total}`)
    lines.push(`kiro_proxy_accounts{status="available"} ${quota.available}`)
    lines.push(`kiro_proxy_accounts{status="exhausted"} ${quota.exhausted}`)
    lines.push(`kiro_proxy_accounts{status="cooldown"} ${quota.cooldown}`)
    lines.push('# HELP kiro_proxy_uptime_seconds Server uptime in seconds')
    lines.push('# TYPE kiro_proxy_uptime_seconds gauge')
    lines.push(`kiro_proxy_uptime_seconds ${Math.floor((Date.now() - s.startTime) / 1000)}`)
    return lines.join('\n') + '\n'
  }

  // 记录请求到 recentRequests
  private recordRequest(log: {
    path: string
    model?: string
    accountId?: string
    inputTokens?: number
    outputTokens?: number
    credits?: number
    responseTime?: number
    success: boolean
    error?: string
  }): void {
    this.stats.recentRequests.push({
      timestamp: Date.now(),
      path: log.path,
      model: log.model || 'unknown',
      accountId: log.accountId || 'unknown',
      inputTokens: log.inputTokens || 0,
      outputTokens: log.outputTokens || 0,
      credits: log.credits,
      responseTime: log.responseTime || 0,
      success: log.success,
      // P2-19 错误消息脱敏
      error: log.error ? this.sanitizeErrorMessage(log.error).slice(0, 500) : undefined
    })
    // P2-15 可配置上限（默认 100，最多 10000）
    const limit = Math.min(10000, Math.max(20, this.config.recentRequestsLimit || 100))
    if (this.stats.recentRequests.length > limit) {
      this.stats.recentRequests = this.stats.recentRequests.slice(-limit)
    }
  }
}
