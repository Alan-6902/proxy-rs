/**
 * 从本机 Admin 拉反代统计。
 *
 * 两个入口对应两种代价：
 * - fetchLocalAdminCredentialStats：一次 GET /credentials 拿全量计数，免费，可定时跑；
 * - fetchLocalAdminUsage：逐条 GET /credentials/:id/balance，每条都打上游 AWS，只在
 *   用户手动点「刷新用量」时串行跑，且单条失败不影响其余凭据。
 *
 * 请求与脱敏复用 kskAutomation/localAdminClient，不再重写一份认证与超时逻辑。
 */

import {
  readRemoteCredentials,
  remoteCredentialId,
  requestJson,
  resolveLocalAdminApiBase,
  type KskAutomationFetch,
  type RemoteCredential
} from '../kskAutomation/localAdminClient'
import {
  resolveLocalAdminAlerts,
  type LocalAdminCredentialStats,
  type LocalAdminCredentialUsage
} from '../../shared/localAdminStats'

/** 逐条查余额时的串行间隔（毫秒），避免瞬间打爆上游。 */
const USAGE_REQUEST_GAP_MS = 120

export interface LocalAdminStatsTarget {
  baseUrl: string
  adminApiKey: string
  timeoutSeconds: number
  fetchImpl: KskAutomationFetch
  /** 采到用量后自动删掉额度耗尽的凭据。这里两个抓取函数都不用它，由调度层读。 */
  autoDeleteExhausted?: boolean
}

function readCount(value: unknown): number {
  const numberValue = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : 0
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * 读一个可缺失的非负计数。
 *
 * 与 readCount 的差别：字段缺失时回 undefined 而不是 0。token 统计需要区分
 * 「这个 kiro-rs 不支持该字段」和「支持但确实是 0」——前者不该在页面上显示成
 * 「本窗口消耗 0」误导人。
 */
function readOptionalCount(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue) || numberValue < 0) return undefined
  return Math.floor(numberValue)
}

/**
 * 读一个可缺失的非负小数。
 *
 * 与 readOptionalCount 的差别：不取整。积分是小数（上游的
 * currentUsageWithPrecision，如 8456.31），取整会把零头抹掉。
 */
function readOptionalDecimal(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue) || numberValue < 0) return undefined
  return numberValue
}

/** Admin 的时间字段是 RFC3339 字符串，也可能是秒级时间戳。 */
function readTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 小于 1e12 视为秒级，Admin 的 nextResetAt 就是秒
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function readNumber(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numberValue) ? numberValue : undefined
}

/** 把 Admin 的一条凭据映射为统计视图。id 缺失的条目由调用方过滤。 */
export function toCredentialStats(
  credential: RemoteCredential,
  usage?: LocalAdminCredentialUsage
): LocalAdminCredentialStats | null {
  const id = remoteCredentialId(credential)
  if (!id) return null
  const disabled = credential.disabled === true
  const failureCount = readCount(credential.failureCount)
  const refreshFailureCount = readCount(credential.refreshFailureCount)
  return {
    id,
    maskedKey: readOptionalString(credential.maskedApiKey),
    apiKeyHash: readOptionalString(credential.apiKeyHash),
    authMethod: readOptionalString(credential.authMethod),
    endpoint: readOptionalString(credential.endpoint),
    email: readOptionalString(credential.email),
    subscriptionTitle: readOptionalString(credential.subscriptionTitle) ?? usage?.subscriptionTitle,
    priority: readCount(credential.priority),
    disabled,
    isCurrent: credential.isCurrent === true,
    successCount: readCount(credential.successCount),
    failureCount,
    refreshFailureCount,
    // 旧版 kiro-rs 不返回这两个字段，保持 undefined 以区分「不支持」与「真的是 0」
    inputTokens: readOptionalCount(credential.inputTokens),
    outputTokens: readOptionalCount(credential.outputTokens),
    // 积分是小数，不能走取整那条
    usedCredits: readOptionalDecimal(credential.usedCredits),
    lastUsedAt: readTimestamp(credential.lastUsedAt),
    usage,
    alerts: resolveLocalAdminAlerts({ disabled, failureCount, refreshFailureCount, usage })
  }
}

/** 解析 `GET /credentials/:id/balance` 的响应。上游给的是百分数，这里归一化成小数。 */
export function toCredentialUsage(
  payload: unknown,
  fetchedAt: number
): LocalAdminCredentialUsage | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  const limit = readNumber(record.usageLimit)
  const current = readNumber(record.currentUsage)
  if (limit === undefined || current === undefined) return null
  const remaining = readNumber(record.remaining) ?? Math.max(0, limit - current)
  return {
    current,
    limit,
    remaining,
    percentUsed: limit > 0 ? current / limit : 0,
    subscriptionTitle: readOptionalString(record.subscriptionTitle),
    nextResetAt: readTimestamp(record.nextResetAt),
    fetchedAt
  }
}

/**
 * 拉取全量凭据的计数类统计。
 *
 * previousUsage 是上一轮已知的用量，按凭据 id 带过来：定时轮询不重新查余额，
 * 但页面上不该因为一次轮询就把用量列清空。
 */
export async function fetchLocalAdminCredentialStats(
  target: LocalAdminStatsTarget,
  previousUsage?: Map<string, LocalAdminCredentialUsage>
): Promise<LocalAdminCredentialStats[]> {
  const baseUrl = resolveLocalAdminApiBase(target.baseUrl)
  const adminApiKey = target.adminApiKey.trim()
  if (!adminApiKey) throw new Error('未配置本机 Admin API Key')
  const payload = await requestJson(
    target.fetchImpl,
    `${baseUrl}/credentials`,
    adminApiKey,
    Math.max(3, target.timeoutSeconds) * 1000,
    { method: 'GET' }
  )
  return readRemoteCredentials(payload)
    .map((credential) => {
      const id = remoteCredentialId(credential)
      return toCredentialStats(credential, id ? previousUsage?.get(id) : undefined)
    })
    .filter((item): item is LocalAdminCredentialStats => item !== null)
}

export interface LocalAdminUsageRefreshResult {
  usage: Map<string, LocalAdminCredentialUsage>
  /** 逐条失败的原因，已脱敏；调用方汇总展示 */
  errors: string[]
}

/**
 * 逐条查余额。串行 + 间隔，单条失败只记错不中断。
 *
 * onProgress 让渲染层能看到「第几条 / 共几条」，否则十几个凭据时页面像卡住了。
 */
export async function fetchLocalAdminUsage(
  target: LocalAdminStatsTarget,
  credentialIds: string[],
  onProgress?: (done: number, total: number) => void
): Promise<LocalAdminUsageRefreshResult> {
  const baseUrl = resolveLocalAdminApiBase(target.baseUrl)
  const adminApiKey = target.adminApiKey.trim()
  if (!adminApiKey) throw new Error('未配置本机 Admin API Key')
  const timeoutMs = Math.max(3, target.timeoutSeconds) * 1000
  const usage = new Map<string, LocalAdminCredentialUsage>()
  const errors: string[] = []

  for (let index = 0; index < credentialIds.length; index++) {
    const credentialId = credentialIds[index]
    try {
      const payload = await requestJson(
        target.fetchImpl,
        `${baseUrl}/credentials/${encodeURIComponent(credentialId)}/balance`,
        adminApiKey,
        timeoutMs,
        { method: 'GET' }
      )
      const parsed = toCredentialUsage(payload, Date.now())
      if (parsed) usage.set(credentialId, parsed)
      else errors.push(`#${credentialId}: 余额响应缺少用量字段`)
    } catch (error) {
      errors.push(`#${credentialId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    onProgress?.(index + 1, credentialIds.length)
    if (index < credentialIds.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, USAGE_REQUEST_GAP_MS))
    }
  }

  return { usage, errors }
}
