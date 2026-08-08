import { isValidKiroApiKey, isValidKiroRegion } from './kiroApiKey'

export const KSK_PROVIDER_POLL_INTERVAL_SECONDS = 30
export const KSK_AUTOMATION_REQUEST_TIMEOUT_SECONDS = 15
export const DEFAULT_LOCAL_ADMIN_URL = 'http://127.0.0.1:12888/admin'
export const KSK_AUTOMATION_STORE_VERSION = 2
export const KSK_AUTOMATION_TASK_TYPE = 'ksk_pull' as const

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
  lastCleanupCheckedCount: number
  lastCleanupRemovedCount: number
  lastCleanupRetainedCount: number
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
