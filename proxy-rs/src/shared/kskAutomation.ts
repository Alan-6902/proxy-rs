import { isValidKiroApiKey, isValidKiroRegion } from './kiroApiKey'

export const KSK_PROVIDER_POLL_INTERVAL_SECONDS = 30
export const KSK_AUTOMATION_REQUEST_TIMEOUT_SECONDS = 15
export const DEFAULT_LOCAL_ADMIN_URL = 'http://127.0.0.1:12888/admin'
export const KSK_AUTOMATION_STORE_VERSION = 2
export const KSK_AUTOMATION_TASK_TYPE = 'ksk_pull' as const

/**
 * 周期性全量验活的默认间隔（分钟）。
 *
 * 全量验活每个号要烧几个 token，间隔太短纯属浪费；但号池挂号（封禁、订阅到期）
 * 只能靠它抓出来，间隔太长反代就会长时间拿着废号打上游。30 分钟是个折中。
 *
 * 额度耗尽这种最常见的失效不依赖它——那条走 balance，由反代统计每 60 秒免费采一次。
 */
export const KSK_CLEANUP_INTERVAL_MINUTES = 30

/** 周期性全量验活的间隔上下限：低于 5 分钟纯烧 credits，高于 24 小时等于没开。 */
export const KSK_CLEANUP_INTERVAL_MIN_MINUTES = 5
export const KSK_CLEANUP_INTERVAL_MAX_MINUTES = 1440

/**
 * 验活提示词：让模型只回一个短 token，尽量少耗 credits。
 *
 * 放在 shared 而不是 main：账号页的手动批量验活面板与 KSK 任务的自动验活必须是同一句话，
 * 否则两边的「验活」结果不可比较。
 */
export const KSK_LIVENESS_PROBE_MESSAGE = 'Hi, reply with "pong" only.'

export const KSK_AUTOMATION_STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  BLOCKED: 'blocked'
} as const

export type KskAutomationState = (typeof KSK_AUTOMATION_STATE)[keyof typeof KSK_AUTOMATION_STATE]

export interface KskAutomationConfig {
  providerEnabled: boolean
  providerGroupId?: string
  requestTimeoutSeconds: number
  cleanupInvalidOnAdd: boolean
  /**
   * 不依赖「本轮有新增」的周期性全量验活。
   *
   * cleanupInvalidOnAdd 只在有新号入库那一刻触发，号池干涸时一次都不跑，
   * 已入库的号后来挂掉就没人管。开这个才能定期复查。
   */
  cleanupPeriodicEnabled: boolean
  /** 周期性全量验活的间隔（分钟）。 */
  cleanupIntervalMinutes: number
  /**
   * 反代统计每轮采到用量后，自动删掉额度已耗尽的凭据（含本地账号库里的对应账号）。
   *
   * 与全量验活互补：这条免费（balance 是只读计量）、60 秒就能发现，但只认额度耗尽；
   * 封禁与认证失效仍要靠发消息验活。
   */
  autoDeleteExhausted: boolean
  /** 验活模型 ID；留空表示自动挑最便宜的可用模型。 */
  livenessModel: string
  /** 验活测试消息；留空表示用 KSK_LIVENESS_PROBE_MESSAGE。 */
  livenessMessage: string
  emailEnabled: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUsername: string
  smtpFrom: string
  smtpTo: string
  localAdminEnabled: boolean
  localAdminGroupId?: string
  localAdminBaseUrl: string
}

export interface KskAutomationSecretInput {
  /** 省略表示保留；空串表示清除。URL 的 query 里通常含 token，按密钥处理。 */
  providerUrl?: string
  smtpPassword?: string
  localAdminApiKey?: string
}

export interface KskAutomationConfigView extends KskAutomationConfig {
  pollIntervalSeconds: number
  encryptionAvailable: boolean
  hasProviderUrl: boolean
  providerUrlHint?: string
  hasSmtpPassword: boolean
  hasLocalAdminApiKey: boolean
  localAdminApiKeyTail?: string
}

export const KSK_AUTOMATION_LOG_LEVEL = {
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error'
} as const

export type KskAutomationLogLevel =
  (typeof KSK_AUTOMATION_LOG_LEVEL)[keyof typeof KSK_AUTOMATION_LOG_LEVEL]

/**
 * 每个任务在内存里保留的运行日志条数上限。
 *
 * 轮询是 30 秒一轮、每轮至少一条汇总，100 条约等于最近 50 分钟；
 * 日志随 status 事件整体推给渲染层，条数再大就是白占 IPC 带宽。
 */
export const KSK_AUTOMATION_LOG_LIMIT = 100

export interface KskAutomationLogEntry {
  at: number
  level: KskAutomationLogLevel
  message: string
}

export interface KskAutomationStatus {
  state: KskAutomationState
  running: boolean
  nextRunAt?: number
  lastAttemptAt?: number
  lastSuccessAt?: number
  lastError?: string
  consecutiveFailures: number
  lastFetchedCount: number
  lastAddedCount: number
  totalAddedCount: number
  /** 上一轮在入库验活阶段被判失效、直接拒收的 KSK 数量。 */
  lastRejectedCount: number
  lastEmailedCount: number
  lastLocalAdminSyncedCount: number
  lastLocalAdminVerifiedCount: number
  /** 上一轮从本机 Admin 删掉的「本地已不存在」的残留凭据数量。 */
  lastLocalAdminPrunedCount: number
  lastCleanupCheckedCount: number
  lastCleanupRemovedCount: number
  lastCleanupRetainedCount: number
  /** 上一次全量验活的完成时间，用来区分「从没跑过」和「跑了但没删东西」。 */
  lastCleanupAt?: number
  /** 下一次周期性全量验活的预定时间；未开启周期清理时为 undefined。 */
  nextCleanupAt?: number
  /** 最近的运行日志，按时间正序；仅存在内存里，应用重启后清空。 */
  logs: KskAutomationLogEntry[]
}

export interface KskAutomationTaskView {
  id: string
  name: string
  type: typeof KSK_AUTOMATION_TASK_TYPE
  enabled: boolean
  createdAt: number
  updatedAt: number
  config: KskAutomationConfigView
  status: KskAutomationStatus
}

export interface KskAutomationStatusEvent {
  taskId: string
  status: KskAutomationStatus
}

export interface KskAutomationTaskInput {
  name: string
  enabled?: boolean
  config: Partial<KskAutomationConfig>
  secrets?: KskAutomationSecretInput
}

export interface ProviderKskCredential {
  key: string
  region: string
  claimId?: string
}

/**
 * 发消息验活的参数。两处都用它：入库前的逐个验活、入库后的全量验活。
 * 字段留空即用默认（模型自动挑最便宜的，消息用 KSK_LIVENESS_PROBE_MESSAGE）。
 */
export interface KskLivenessOptions {
  model?: string
  message?: string
}

export interface ProviderKskParseResult {
  message?: string
  credentials: ProviderKskCredential[]
  rejectedCount: number
}

export const DEFAULT_KSK_AUTOMATION_CONFIG: KskAutomationConfig = {
  providerEnabled: false,
  providerGroupId: undefined,
  requestTimeoutSeconds: KSK_AUTOMATION_REQUEST_TIMEOUT_SECONDS,
  cleanupInvalidOnAdd: true,
  cleanupPeriodicEnabled: true,
  cleanupIntervalMinutes: KSK_CLEANUP_INTERVAL_MINUTES,
  autoDeleteExhausted: true,
  livenessModel: '',
  livenessMessage: '',
  emailEnabled: false,
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  smtpUsername: '',
  smtpFrom: '',
  smtpTo: '',
  localAdminEnabled: false,
  localAdminGroupId: undefined,
  localAdminBaseUrl: DEFAULT_LOCAL_ADMIN_URL
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function resolveProviderRegion(account: Record<string, unknown>): string {
  const awsRegion = readString(account.aws_region)
  if (isValidKiroRegion(awsRegion)) return awsRegion

  const zone = readString(account.zone).toLowerCase()
  const zoneRegion =
    zone === 'us'
      ? 'us-east-1'
      : zone === 'eu'
        ? 'eu-central-1'
        : zone === 'ap'
          ? 'ap-southeast-1'
          : ''
  return isValidKiroRegion(zoneRegion) ? zoneRegion : ''
}

/** 解析 car provider 的响应，只接受 active KSK 与可识别 AWS 区域。 */
export function parseKskProviderResponse(payload: unknown): ProviderKskParseResult {
  if (!isRecord(payload)) throw new Error('KSK 提供接口返回的不是 JSON 对象')
  if (payload.code !== 0) {
    throw new Error(readString(payload.msg) || `KSK 提供接口返回 code=${String(payload.code)}`)
  }
  if (!Array.isArray(payload.data)) throw new Error('KSK 提供接口 data 不是数组')

  const credentials: ProviderKskCredential[] = []
  const seen = new Set<string>()
  let rejectedCount = 0

  for (const item of payload.data) {
    if (!isRecord(item) || !isRecord(item.account)) {
      rejectedCount++
      continue
    }
    const key = readString(item.account.key)
    const status = readString(item.account.status).toLowerCase()
    const region = resolveProviderRegion(item.account)
    if (!isValidKiroApiKey(key) || status !== 'active' || !region || seen.has(key)) {
      rejectedCount++
      continue
    }
    seen.add(key)
    const rawClaimId = item.claimId
    credentials.push({
      key,
      region,
      claimId:
        typeof rawClaimId === 'string' || typeof rawClaimId === 'number'
          ? String(rawClaimId)
          : undefined
    })
  }

  return {
    message: readString(payload.msg) || undefined,
    credentials,
    rejectedCount
  }
}

export function maskSecretTail(value: string, visible = 4): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return `••••${trimmed.slice(-visible)}`
}

export function providerUrlHint(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    return `${parsed.origin}${parsed.pathname} · token ${maskSecretTail(parsed.searchParams.get('token') || '') ?? '已配置'}`
  } catch {
    return value.trim() ? '已配置（地址格式待校验）' : undefined
  }
}
