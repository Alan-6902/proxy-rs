/**
 * Kiro 自动车上游客户端（方案 3.1 / 3.2）
 *
 * 职责边界：只负责「发请求 + 解析 JSON + 把错误映射成明确类型」。
 * 不做调度、不做计费判断、不持久化，也不打印响应体——登录 Key 与凭证明文
 * 绝不能进日志，所以这里所有错误信息都只带状态码与上游 error.message。
 *
 * fetch 由外部注入：主进程注入统一的 fetchWithAppProxy（走用户/系统代理），
 * 测试注入桩函数，避免这里直接依赖 undici 与 Electron。
 */

import {
  CONVOY_ENDPOINT,
  CONVOY_RATE_LIMIT_FALLBACK_SECONDS,
  checkBaseUrlSecurity,
  joinConvoyUrl,
  toCents
} from '../../shared/convoyCredentials'

/** 客户端错误分类，决定上层的退避与状态迁移 */
export const CONVOY_ERROR = {
  /** 网络异常、超时、5xx：可重试 */
  TRANSIENT: 'transient',
  /** 401：登录 Key 失效 */
  UNAUTHORIZED: 'unauthorized',
  /** 403：无权限或账号受限 */
  FORBIDDEN: 'forbidden',
  /** 404 not_on_board：未在自动车上 */
  NOT_ON_BOARD: 'not_on_board',
  /** 429：限流 */
  RATE_LIMITED: 'rate_limited',
  /** 响应不是合法 JSON 或结构不符合契约 */
  MALFORMED: 'malformed',
  /** 配置问题（明文 HTTP 未放行、URL 非法、缺 Key） */
  CONFIG: 'config'
} as const

export type ConvoyErrorKind = (typeof CONVOY_ERROR)[keyof typeof CONVOY_ERROR]

export class ConvoyClientError extends Error {
  readonly kind: ConvoyErrorKind
  readonly statusCode?: number
  /** 429 场景下上游要求的等待毫秒数 */
  readonly retryAfterMs?: number

  constructor(kind: ConvoyErrorKind, message: string, statusCode?: number, retryAfterMs?: number) {
    super(message)
    this.name = 'ConvoyClientError'
    this.kind = kind
    this.statusCode = statusCode
    this.retryAfterMs = retryAfterMs
  }
}

/** 注入的 fetch 形状，与 undici / DOM fetch 兼容的最小子集 */
export type ConvoyFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal }
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

export interface ConvoyClientOptions {
  baseUrl: string
  /** 拼车登录 Key，作为 x-api-key 发送；仅在内存中流转 */
  convoyKey: string
  requestTimeoutSeconds: number
  allowInsecureHttp: boolean
  fetchImpl: ConvoyFetch
}

/** 概览响应中的凭证摘要项（不含明文） */
export interface ConvoySummaryCredential {
  credentialId: string
  status: string
  addedAt?: string
}

export interface ConvoyAutoRideSummary {
  onBoard: boolean
  autoConvoyId?: string
  autoConvoyTitle?: string
  /** 单个凭证车费（分）；上游未给时为 undefined */
  farePerCredentialCents?: number
  credentialSummary: ConvoySummaryCredential[]
}

/** 完整凭证响应中的一条原始记录 */
export interface RawConvoyCredentialItem {
  credentialId: string
  status: string
  newlyCharged: boolean
  /** 该条计费金额（分） */
  chargedCents: number
  aliveSecs?: number
  addedAt?: string
  /** 上游凭证明文；未发放时为 null */
  credential: Record<string, unknown> | null
}

export interface ConvoyCredentialsResponse {
  autoConvoyId?: string
  autoConvoyTitle?: string
  credentials: RawConvoyCredentialItem[]
  newlyChargedCount: number
  totalChargedCents: number
  balanceAfterCents?: number
  insufficientCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 上游可能把 ID 给成数字或字符串，统一成字符串；空值返回 '' 让调用方拒绝 */
function readId(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function readNonNegativeInt(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0
}

/**
 * 从上游错误响应里挖出可安全展示的 message。
 * 只取 error.message / message 字段，绝不回传完整 body。
 */
function extractErrorMessage(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as unknown
    if (!isRecord(parsed)) return undefined
    const nested = isRecord(parsed.error) ? parsed.error : undefined
    const message = nested?.message ?? parsed.message
    return typeof message === 'string' && message.trim() ? message.trim() : undefined
  } catch {
    return undefined
  }
}

/** 上游 404 是否为「未上车」。兼容 code / error.code / message 三种位置 */
function isNotOnBoardBody(bodyText: string): boolean {
  if (!bodyText) return false
  if (/not_on_board/i.test(bodyText)) return true
  try {
    const parsed = JSON.parse(bodyText) as unknown
    if (!isRecord(parsed)) return false
    const nested = isRecord(parsed.error) ? parsed.error : undefined
    const code = nested?.code ?? parsed.code
    return typeof code === 'string' && code.toLowerCase() === 'not_on_board'
  } catch {
    return false
  }
}

/** Retry-After 支持秒数与 HTTP-date 两种格式 */
function parseRetryAfterMs(header: string | null, now: number): number {
  const fallbackMs = CONVOY_RATE_LIMIT_FALLBACK_SECONDS * 1000
  if (!header) return fallbackMs
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(fallbackMs, Math.round(seconds * 1000))
  }
  const dateMs = Date.parse(header)
  if (Number.isFinite(dateMs)) return Math.max(fallbackMs, dateMs - now)
  return fallbackMs
}

export class ConvoyCredentialClient {
  constructor(private readonly options: ConvoyClientOptions) {}

  /** 概览：不含明文，可安全高频调用，用于计费预检 */
  async fetchSummary(): Promise<ConvoyAutoRideSummary> {
    const payload = await this.requestJson(CONVOY_ENDPOINT.summary)
    return parseSummary(payload)
  }

  /** 完整凭证明文：可能计费，调用前必须先过门禁 */
  async fetchCredentials(): Promise<ConvoyCredentialsResponse> {
    const payload = await this.requestJson(CONVOY_ENDPOINT.credentials)
    return parseCredentialsResponse(payload)
  }

  private async requestJson(endpoint: string): Promise<Record<string, unknown>> {
    const { baseUrl, convoyKey, allowInsecureHttp, requestTimeoutSeconds, fetchImpl } = this.options
    if (!convoyKey.trim()) {
      throw new ConvoyClientError(CONVOY_ERROR.CONFIG, '未配置自动车登录 Key')
    }
    const securityIssue = checkBaseUrlSecurity(baseUrl, allowInsecureHttp)
    if (securityIssue) {
      throw new ConvoyClientError(CONVOY_ERROR.CONFIG, securityIssue)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, requestTimeoutSeconds) * 1000)
    let response: Awaited<ReturnType<ConvoyFetch>>
    try {
      response = await fetchImpl(joinConvoyUrl(baseUrl, endpoint), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-api-key': convoyKey,
          'User-Agent': 'proxy-rs-convoy-sync/1.0'
        },
        signal: controller.signal
      })
    } catch (err) {
      const aborted = controller.signal.aborted
      const detail = aborted
        ? `请求超时（${requestTimeoutSeconds}s）`
        : err instanceof Error
          ? err.message
          : String(err)
      throw new ConvoyClientError(CONVOY_ERROR.TRANSIENT, `网络请求失败: ${detail}`)
    } finally {
      clearTimeout(timer)
    }

    // 错误体可能带可读原因，但绝不整体回传：只取 error.message
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      throw this.mapHttpError(response.status, response.headers.get('retry-after'), bodyText)
    }

    const bodyText = await response.text().catch(() => '')
    let parsed: unknown
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      throw new ConvoyClientError(CONVOY_ERROR.MALFORMED, '上游返回的不是有效 JSON')
    }
    if (!isRecord(parsed)) {
      throw new ConvoyClientError(CONVOY_ERROR.MALFORMED, '上游返回的 JSON 顶层不是对象')
    }
    return parsed
  }

  private mapHttpError(status: number, retryAfter: string | null, bodyText: string): ConvoyClientError {
    const detail = extractErrorMessage(bodyText)
    const suffix = detail ? `: ${detail}` : ''
    if (status === 401) {
      return new ConvoyClientError(
        CONVOY_ERROR.UNAUTHORIZED,
        // 上游对「没带 Key」和「Key 不被认可」都回 401，把它的 message 带出来，
        // 否则用户无法区分是本地没发出去还是服务端拒绝了这把 Key
        `登录 Key 未通过上游校验（HTTP 401）${suffix || '：上游未给出原因'}`,
        status
      )
    }
    if (status === 403) {
      return new ConvoyClientError(
        CONVOY_ERROR.FORBIDDEN,
        `无权限或账号受限（HTTP 403）${suffix}`,
        status
      )
    }
    if (status === 404 && isNotOnBoardBody(bodyText)) {
      return new ConvoyClientError(CONVOY_ERROR.NOT_ON_BOARD, `当前不在自动车上${suffix}`, status)
    }
    if (status === 429) {
      return new ConvoyClientError(
        CONVOY_ERROR.RATE_LIMITED,
        `上游限流（HTTP 429）${suffix}`,
        status,
        parseRetryAfterMs(retryAfter, Date.now())
      )
    }
    if (status >= 500) {
      return new ConvoyClientError(CONVOY_ERROR.TRANSIENT, `上游服务异常（HTTP ${status}）${suffix}`, status)
    }
    return new ConvoyClientError(CONVOY_ERROR.MALFORMED, `HTTP ${status}${suffix}`, status)
  }
}

/**
 * 解析概览响应。onBoard 缺失时按「未上车」处理：宁可少调一次计费接口，
 * 也不要因为字段名漂移而误触发计费。
 */
export function parseSummary(payload: Record<string, unknown>): ConvoyAutoRideSummary {
  const rawSummary = payload.credentialSummary
  if (rawSummary !== undefined && rawSummary !== null && !Array.isArray(rawSummary)) {
    throw new ConvoyClientError(CONVOY_ERROR.MALFORMED, 'credentialSummary 格式异常')
  }
  const credentialSummary: ConvoySummaryCredential[] = []
  for (const item of Array.isArray(rawSummary) ? rawSummary : []) {
    if (!isRecord(item)) continue
    const credentialId = readId(item.credentialId)
    if (!credentialId) continue
    credentialSummary.push({
      credentialId,
      status: typeof item.status === 'string' ? item.status : '',
      addedAt: typeof item.addedAt === 'string' ? item.addedAt : undefined
    })
  }

  // 车费可能挂在 convoy.fare / autoConvoy.fare / 顶层 fare 上，逐一尝试
  const convoy = isRecord(payload.convoy)
    ? payload.convoy
    : isRecord(payload.autoConvoy)
      ? payload.autoConvoy
      : undefined
  const rawFare = convoy?.fare ?? convoy?.price ?? payload.fare

  return {
    onBoard: payload.onBoard === true,
    autoConvoyId: readId(payload.autoConvoyId ?? convoy?.id) || undefined,
    autoConvoyTitle:
      typeof payload.autoConvoyTitle === 'string'
        ? payload.autoConvoyTitle
        : typeof convoy?.title === 'string'
          ? convoy.title
          : undefined,
    farePerCredentialCents: rawFare === undefined ? undefined : toCents(rawFare),
    credentialSummary
  }
}

/**
 * 解析完整凭证响应。单条不符合契约（缺 credentialId）时整体拒绝——
 * 方案第 10 节：宁可保留旧快照，也不接受结构可疑的候选快照。
 */
export function parseCredentialsResponse(
  payload: Record<string, unknown>
): ConvoyCredentialsResponse {
  const rawItems = payload.credentials
  if (rawItems !== undefined && rawItems !== null && !Array.isArray(rawItems)) {
    throw new ConvoyClientError(CONVOY_ERROR.MALFORMED, 'credentials 格式异常')
  }
  const credentials: RawConvoyCredentialItem[] = []
  const seenIds = new Set<string>()

  for (const item of Array.isArray(rawItems) ? rawItems : []) {
    if (!isRecord(item)) {
      throw new ConvoyClientError(CONVOY_ERROR.MALFORMED, 'credentials 数组包含非对象元素')
    }
    const credentialId = readId(item.credentialId)
    if (!credentialId) {
      throw new ConvoyClientError(CONVOY_ERROR.MALFORMED, '存在缺少 credentialId 的凭证条目')
    }
    if (seenIds.has(credentialId)) {
      throw new ConvoyClientError(
        CONVOY_ERROR.MALFORMED,
        `credentialId ${credentialId} 在同一响应中重复`
      )
    }
    seenIds.add(credentialId)

    const credential = isRecord(item.credential) ? item.credential : null
    credentials.push({
      credentialId,
      status: typeof item.status === 'string' ? item.status : '',
      newlyCharged: item.newlyCharged === true,
      chargedCents: toCents(item.charged),
      aliveSecs:
        typeof item.aliveSecs === 'number' && Number.isFinite(item.aliveSecs)
          ? item.aliveSecs
          : undefined,
      addedAt: typeof item.addedAt === 'string' ? item.addedAt : undefined,
      credential
    })
  }

  return {
    autoConvoyId: readId(payload.autoConvoyId) || undefined,
    autoConvoyTitle:
      typeof payload.autoConvoyTitle === 'string' ? payload.autoConvoyTitle : undefined,
    credentials,
    newlyChargedCount: readNonNegativeInt(payload.newlyChargedCount),
    totalChargedCents: toCents(payload.totalCharged),
    balanceAfterCents:
      payload.balanceAfter === undefined || payload.balanceAfter === null
        ? undefined
        : toCents(payload.balanceAfter),
    insufficientCount: readNonNegativeInt(payload.insufficientCount)
  }
}
