/**
 * Kiro 自动车（拼车）凭证同步：主进程与渲染进程共用的常量、类型与纯函数。
 *
 * 边界：本文件不含任何网络与文件 IO，也不持有凭证明文以外的状态，
 * 保证渲染进程可以安全 import（打包进 web bundle 也不会带上 node 依赖）。
 *
 * 金额一律用「分」（整数）传递与累计：上游返回的是十进制金额，
 * 二进制浮点累加会积累误差，计费上限判断不能用它。
 */

/** 上游接口路径（相对于 base URL） */
export const CONVOY_ENDPOINT = {
  /** 概览：不含凭证明文，可安全高频调用 */
  summary: '/me/auto-ride',
  /** 完整凭证明文：可能产生计费 */
  credentials: '/me/auto-ride/credentials'
} as const

/** 上游 `/api/user` 基础地址默认值（当前站点仅提供明文 HTTP） */
export const DEFAULT_CONVOY_BASE_URL = 'http://kiro.zhiqwc.top/api/user'

/** 常规轮询间隔 */
export const DEFAULT_POLL_INTERVAL_SECONDS = 60

/** 接口冷却约 3s，低于此值直接拒绝 */
export const MIN_POLL_INTERVAL_SECONDS = 3

/** 单次 HTTP 超时 */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 15

/** 失败退避序列（秒），与方案第 10 节一致；超出后维持最后一档 */
export const CONVOY_BACKOFF_SECONDS = [5, 15, 30, 60] as const

/** 退避抖动比例：在退避基数上下浮动 ±20%，避免多实例同刻重试 */
export const CONVOY_BACKOFF_JITTER_RATIO = 0.2

/** 429 未给 Retry-After 时的最小等待 */
export const CONVOY_RATE_LIMIT_FALLBACK_SECONDS = 60

/** 连续失败多少轮触发告警 */
export const CONVOY_FAILURE_ALERT_THRESHOLD = 3

/** 自动车拉取的凭证注入账号池时的 ID 前缀，避免与用户账号撞号 */
export const CONVOY_ACCOUNT_ID_PREFIX = 'convoy:'

/** 手填 Kiro API Key 注入账号池时的 ID 前缀 */
export const CONVOY_MANUAL_ACCOUNT_ID_PREFIX = 'convoy-manual:'

/** 计费门禁默认值（金额单位：分）。生产必须按真实车费与预算调整 */
export const CONVOY_BILLING_DEFAULTS = {
  maxNewCredentialsPerPull: 5,
  maxChargePerPullCents: 2000,
  dailyChargeLimitCents: 10000,
  minBalanceAlertCents: 2000
} as const

/** 快照版本展示长度：日志与 UI 只暴露前 8 位 */
export const CONVOY_VERSION_DISPLAY_LENGTH = 8

/** 同步器状态机 */
export const CONVOY_STATE = {
  /** 未配置登录 Key，或用户主动停用 */
  IDLE: 'idle',
  /** 正常运行，最近一轮成功 */
  HEALTHY: 'healthy',
  /** 拉取失败中，仍在退避重试；旧快照按各条目有效期继续可用 */
  DEGRADED: 'degraded',
  /** 未在自动车上：不再调用计费接口 */
  NOT_ON_BOARD: 'not_on_board',
  /** 登录 Key 失效（401）或无权限（403）：暂停拉取等人工处理 */
  UNAUTHORIZED: 'unauthorized',
  /** 计费门禁阻断：等待管理员放行或调整上限 */
  BLOCKED: 'blocked'
} as const

export type ConvoyState = (typeof CONVOY_STATE)[keyof typeof CONVOY_STATE]

/** 单条凭证在内部池中的状态 */
export const CONVOY_CREDENTIAL_STATUS = {
  /** 有明文、未过期，可分配 */
  ACTIVE: 'active',
  /** 有明文但已超过 aliveSecs 推算的过期时间 */
  EXPIRED: 'expired',
  /** 上游未提供明文（失效或余额不足未发放） */
  UNAVAILABLE: 'unavailable'
} as const

export type ConvoyCredentialStatus =
  (typeof CONVOY_CREDENTIAL_STATUS)[keyof typeof CONVOY_CREDENTIAL_STATUS]

/** 上游 credential 对象支持的类型 */
export const CONVOY_CREDENTIAL_TYPE = {
  API_KEY: 'api_key',
  OAUTH: 'oauth'
} as const

// ============ 配置 ============

/** 同步器配置。登录 Key 不在此结构中，由主进程加密存储单独持有 */
export interface ConvoySyncConfig {
  /** 是否启用每分钟自动拉取 */
  enabled: boolean
  /** 上游 `/api/user` 基础地址 */
  baseUrl: string
  pollIntervalSeconds: number
  requestTimeoutSeconds: number
  /** 明确允许通过明文 HTTP 发送登录 Key */
  allowInsecureHttp: boolean
  /** 允许首次拉取产生未知计费；默认 false，先只做预估 */
  allowInitialCharge: boolean
  maxNewCredentialsPerPull: number
  maxChargePerPullCents: number
  dailyChargeLimitCents: number
  minBalanceAlertCents: number
}

export const DEFAULT_CONVOY_SYNC_CONFIG: ConvoySyncConfig = {
  enabled: false,
  baseUrl: DEFAULT_CONVOY_BASE_URL,
  pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
  requestTimeoutSeconds: DEFAULT_REQUEST_TIMEOUT_SECONDS,
  allowInsecureHttp: false,
  allowInitialCharge: false,
  maxNewCredentialsPerPull: CONVOY_BILLING_DEFAULTS.maxNewCredentialsPerPull,
  maxChargePerPullCents: CONVOY_BILLING_DEFAULTS.maxChargePerPullCents,
  dailyChargeLimitCents: CONVOY_BILLING_DEFAULTS.dailyChargeLimitCents,
  minBalanceAlertCents: CONVOY_BILLING_DEFAULTS.minBalanceAlertCents
}

// ============ 手填 Key ============

/**
 * 手填的一条上游 Kiro API Key。region 非必填：留空时由主进程按候选区域探测，
 * 哪个先返回 200 就用哪个，探测结果回填到 resolvedRegion。
 */
export interface ManualConvoyKey {
  /** 稳定 ID，便于 UI 增删与结果回填 */
  id: string
  key: string
  /** 用户显式指定的区域；留空表示自动探测 */
  region?: string
}

/** 手填 Key 的验活与区域探测结果 */
export interface ManualConvoyKeyResult {
  id: string
  /** 脱敏后的 key，用于 UI 展示 */
  maskedKey: string
  ok: boolean
  /** 最终生效区域：显式指定或探测命中 */
  resolvedRegion?: string
  /** 探测过程中尝试过的区域，按顺序 */
  probedRegions?: string[]
  email?: string
  error?: string
}

// ============ 快照 ============

/** 内部凭证条目。payload 只在主进程内流转，不经 IPC 下发到渲染进程 */
export interface ManagedConvoyCredential {
  id: string
  status: ConvoyCredentialStatus
  /** 凭证类型（api_key / oauth），来自上游 credential.type */
  type: string
  /** 上游凭证明文对象，主进程内部使用 */
  payload: Record<string, unknown>
  /** 从 payload 提取出的上游 Kiro API Key（type=api_key 时） */
  apiKey?: string
  /** 从 payload 提取出的 accessToken（type=oauth 时） */
  accessToken?: string
  /** 凭证生效区域：payload 里带就用它，否则由探测填入 */
  region?: string
  fetchedAt: number
  /** 由 aliveSecs 推算的过期时间；上游未给 aliveSecs 时为 undefined */
  expiresAt?: number
  /** 规范化 payload 的 SHA-256，用于识别同 ID 内容变化 */
  contentHash: string
}

/** 完整快照：原子替换的最小单位 */
export interface ConvoyCredentialSnapshot {
  /** 全部凭证内容的规范化 SHA-256 */
  version: string
  fetchedAt: number
  autoConvoyId?: string
  autoConvoyTitle?: string
  credentials: ManagedConvoyCredential[]
  newlyChargedCount: number
  /** 本轮实际计费（分） */
  totalChargedCents: number
  /** 计费后余额（分）；上游未给时为 undefined */
  balanceAfterCents?: number
  insufficientCount: number
}

/** 下发到渲染进程的脱敏快照视图：不含任何凭证明文 */
export interface ConvoySnapshotView {
  version: string
  /** 版本前 8 位，UI 直接展示 */
  versionShort: string
  fetchedAt: number
  autoConvoyId?: string
  autoConvoyTitle?: string
  /** 可分配（active 且未过期）的凭证数 */
  activeCount: number
  /** 快照内全部条目数，含失效与未发放 */
  totalCount: number
  credentials: {
    id: string
    status: ConvoyCredentialStatus
    type: string
    maskedCredential: string
    region?: string
    expiresAt?: number
  }[]
  newlyChargedCount: number
  totalChargedCents: number
  balanceAfterCents?: number
  insufficientCount: number
}

// ============ 运行状态 ============

/** 同步器健康状态，供 UI 与告警消费；不含凭证明文 */
export interface ConvoySyncStatus {
  state: ConvoyState
  enabled: boolean
  /** 登录 Key 是否已配置（只报布尔，不回传 Key 本身） */
  hasConvoyKey: boolean
  /** 登录 Key 尾 4 位，便于用户确认填的是哪一把 */
  convoyKeyTail?: string
  lastAttemptAt?: number
  lastSuccessAt?: number
  consecutiveFailures: number
  /** 最近一次失败原因（已脱敏） */
  lastError?: string
  /** 下一轮预计执行时间 */
  nextRunAt?: number
  /** 当日累计计费（分），按本地日历日滚动 */
  todayChargedCents: number
  /** 当日计费统计所属日期，格式 YYYY-MM-DD */
  todayChargeDate?: string
  /** 累计新计费凭证数 */
  totalNewlyChargedCount: number
  /** 最近一次已知余额（分） */
  balanceAfterCents?: number
  /** 门禁阻断原因（state=blocked 时） */
  blockedReason?: string
  /** 待管理员确认的首次计费预估 */
  pendingInitialEstimate?: {
    credentialCount: number
    estimatedChargeCents: number
  }
  /** 当前快照的脱敏视图；无快照时为 null */
  snapshot: ConvoySnapshotView | null
  /** 手填 Key 当前的注入结果 */
  manualKeys: ManualConvoyKeyResult[]
  /** 累计告警（最新在前，主进程截断长度） */
  alerts: ConvoyAlert[]
}

/** 告警条目 */
export interface ConvoyAlert {
  at: number
  kind: ConvoyAlertKind
  /** 已脱敏的可读描述 */
  message: string
}

export const CONVOY_ALERT_KIND = {
  PULL_FAILED: 'pull_failed',
  UNAUTHORIZED: 'unauthorized',
  NOT_ON_BOARD: 'not_on_board',
  INSUFFICIENT: 'insufficient',
  LOW_BALANCE: 'low_balance',
  BILLING_LIMIT: 'billing_limit',
  SNAPSHOT_STALE: 'snapshot_stale',
  SNAPSHOT_EMPTY: 'snapshot_empty',
  INSECURE_HTTP: 'insecure_http'
} as const

export type ConvoyAlertKind = (typeof CONVOY_ALERT_KIND)[keyof typeof CONVOY_ALERT_KIND]

// ============ 金额：一律用「分」做整数运算 ============

/**
 * 上游十进制金额 → 分。字符串优先按字面量解析，避免先转 double 再乘 100
 * 造成 2.675 → 267 这类舍入偏差。
 */
export function toCents(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0
    return Math.round(value * 100)
  }
  if (typeof value !== 'string') return 0
  const trimmed = value.trim()
  const matched = /^(-?)(\d*)(?:\.(\d*))?$/.exec(trimmed)
  if (!matched || (!matched[2] && !matched[3])) return 0
  const [, sign, whole = '', fraction = ''] = matched
  // 只取前两位小数，第三位起做四舍五入
  const cents = Number(whole || '0') * 100 + Number((fraction + '00').slice(0, 2))
  const rounding = fraction.length > 2 && Number(fraction[2]) >= 5 ? 1 : 0
  const total = cents + rounding
  return sign === '-' ? -total : total
}

/** 分 → 展示用字符串，保留两位小数 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

// ============ 时间语义 ============

/**
 * 由 aliveSecs 推算过期时间。方案第 5.2 节：未确认语义前只当「从拉取时刻起的
 * 剩余存活秒数」，不得当绝对时间戳。非正数或非法值返回 undefined（视为不设过期）。
 */
export function resolveExpiresAt(fetchedAt: number, aliveSecs: unknown): number | undefined {
  const secs = typeof aliveSecs === 'number' ? aliveSecs : Number(aliveSecs)
  if (!Number.isFinite(secs) || secs <= 0) return undefined
  return fetchedAt + Math.floor(secs) * 1000
}

/** 条目在给定时刻是否仍可分配 */
export function isCredentialUsable(
  credential: Pick<ManagedConvoyCredential, 'status' | 'expiresAt'>,
  now: number
): boolean {
  if (credential.status !== CONVOY_CREDENTIAL_STATUS.ACTIVE) return false
  return credential.expiresAt === undefined || credential.expiresAt > now
}

// ============ 安全 ============

/** 只暴露尾 4 位，用于登录 Key 与凭证的 UI 展示 */
export function maskSecretTail(value: string, tail = 4): string {
  if (!value) return ''
  return value.length <= tail ? '***' : `***${value.slice(-tail)}`
}

/**
 * HTTPS 门禁：默认拒绝向 http:// 发送登录 Key。
 * 返回 null 表示通过，否则返回拒绝原因。
 */
export function checkBaseUrlSecurity(
  baseUrl: string,
  allowInsecureHttp: boolean
): string | null {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return 'base URL 必须是有效的 http/https 地址'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'base URL 必须是有效的 http/https 地址'
  }
  if (!parsed.hostname) return 'base URL 缺少主机名'
  if (parsed.protocol === 'http:' && !allowInsecureHttp) {
    return '上游为明文 HTTP，默认拒绝发送登录 Key。确认风险后请显式开启「允许明文 HTTP」'
  }
  return null
}

/** 拼接 base URL 与 endpoint，容忍两侧多余的斜杠 */
export function joinConvoyUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`
}

// ============ 计费门禁 ============

/** 计费门禁判定输入 */
export interface BillingGuardInput {
  /** 预估本轮新增凭证数 */
  estimatedNewCount: number
  /** 单个新凭证车费（分）；未知时传 undefined */
  farePerCredentialCents?: number
  /** 当日已累计计费（分） */
  todayChargedCents: number
  /** 本地是否已有已获取凭证记录（用于识别首次启动） */
  hasAcquiredHistory: boolean
  config: Pick<
    ConvoySyncConfig,
    | 'allowInitialCharge'
    | 'maxNewCredentialsPerPull'
    | 'maxChargePerPullCents'
    | 'dailyChargeLimitCents'
  >
}

export interface BillingGuardDecision {
  allowed: boolean
  /** 被拒原因；allowed=true 时为 undefined */
  reason?: string
  /** 本轮预估费用（分） */
  estimatedChargeCents: number
}

/**
 * 计费预检。只使用概览数据做估算，最终以完整接口返回的权威字段为准（方案 9.3）。
 * 预估新增为 0 时一律放行：重复拉取不重复计费。
 */
export function evaluateBillingGuard(input: BillingGuardInput): BillingGuardDecision {
  const { estimatedNewCount, farePerCredentialCents, todayChargedCents, config } = input
  const estimatedChargeCents = Math.max(
    0,
    estimatedNewCount * Math.max(0, farePerCredentialCents ?? 0)
  )

  if (estimatedNewCount <= 0) return { allowed: true, estimatedChargeCents: 0 }

  if (!input.hasAcquiredHistory && !config.allowInitialCharge) {
    return {
      allowed: false,
      estimatedChargeCents,
      reason: `首次拉取预计新增 ${estimatedNewCount} 个凭证、约 ${formatCents(estimatedChargeCents)} 元。默认阻止未知费用，确认后请开启「允许首次计费」`
    }
  }
  if (estimatedNewCount > config.maxNewCredentialsPerPull) {
    return {
      allowed: false,
      estimatedChargeCents,
      reason: `预计新增 ${estimatedNewCount} 个凭证，超过单次上限 ${config.maxNewCredentialsPerPull}`
    }
  }
  if (estimatedChargeCents > config.maxChargePerPullCents) {
    return {
      allowed: false,
      estimatedChargeCents,
      reason: `预计费用 ${formatCents(estimatedChargeCents)} 元，超过单次上限 ${formatCents(config.maxChargePerPullCents)} 元`
    }
  }
  if (todayChargedCents + estimatedChargeCents > config.dailyChargeLimitCents) {
    return {
      allowed: false,
      estimatedChargeCents,
      reason: `当日累计 ${formatCents(todayChargedCents)} 元 + 本轮预计 ${formatCents(estimatedChargeCents)} 元，超过每日上限 ${formatCents(config.dailyChargeLimitCents)} 元`
    }
  }
  return { allowed: true, estimatedChargeCents }
}

/** 退避等待毫秒数：按连续失败次数取序列值，叠加 ±20% 抖动 */
export function backoffDelayMs(consecutiveFailures: number, random = Math.random): number {
  const index = Math.min(
    Math.max(consecutiveFailures, 1) - 1,
    CONVOY_BACKOFF_SECONDS.length - 1
  )
  const baseMs = CONVOY_BACKOFF_SECONDS[index] * 1000
  const jitter = baseMs * CONVOY_BACKOFF_JITTER_RATIO * (random() * 2 - 1)
  return Math.max(1000, Math.round(baseMs + jitter))
}

/** 本地日历日键，用于每日计费统计滚动 */
export function localDateKey(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

// ============ 区域探测 ============

/**
 * 区域未指定时的探测候选，按顺序试到第一个返回 200 为止。
 *
 * 只列 us-east-1 / eu-central-1：Kiro REST 端点（q.{region}.amazonaws.com）
 * 官方插件仅这两个区域可用，其余区域在主进程侧也会被映射到这两个之一，
 * 多试没有意义还会白等超时。
 */
export const CONVOY_REGION_PROBE_ORDER = ['us-east-1', 'eu-central-1'] as const

/**
 * 计算某个 key 的探测顺序：显式区域优先且只试它；
 * 未指定时按 CONVOY_REGION_PROBE_ORDER 全试一遍。
 */
export function resolveRegionProbeOrder(explicitRegion?: string): string[] {
  const normalized = explicitRegion?.trim().toLowerCase()
  if (normalized) return [normalized]
  return [...CONVOY_REGION_PROBE_ORDER]
}
