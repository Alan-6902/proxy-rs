/**
 * 托管账号的余额查询：逐条 GET 本机 Admin 的 `/credentials/:id/balance`。
 *
 * 托管账号的 token 只由反代持有，proxy-rs 查用量与验活都只能经这个接口。
 * 每条都会打上游 AWS，所以串行 + 间隔，单条失败只记错不中断。
 */

import {
  requestJson,
  resolveLocalAdminApiBase,
  type KskAutomationFetch
} from '../kskAutomation/localAdminClient'

/** 逐条查余额时的串行间隔（毫秒），避免瞬间打爆上游。 */
const USAGE_REQUEST_GAP_MS = 120

export interface LocalAdminBalanceTarget {
  baseUrl: string
  adminApiKey: string
  timeoutSeconds: number
  fetchImpl: KskAutomationFetch
}

export interface LocalAdminCredentialUsage {
  current: number
  limit: number
  remaining: number
  /** 0-1 小数，由 current/limit 归一化得到，不直接用上游的百分数 */
  percentUsed: number
  subscriptionTitle?: string
  /** 额度重置时间（毫秒时间戳） */
  nextResetAt?: number
  /** 本地抓到这份用量的时间（毫秒时间戳） */
  fetchedAt: number
}

export interface LocalAdminUsageRefreshResult {
  usage: Map<string, LocalAdminCredentialUsage>
  /** 逐条失败的原因，已脱敏；调用方汇总展示 */
  errors: string[]
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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

export async function fetchLocalAdminUsage(
  target: LocalAdminBalanceTarget,
  credentialIds: string[],
  fresh: boolean = false
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
        `${baseUrl}/credentials/${encodeURIComponent(credentialId)}/balance${fresh ? '?fresh=true' : ''}`,
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
    if (index < credentialIds.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, USAGE_REQUEST_GAP_MS))
    }
  }

  return { usage, errors }
}
