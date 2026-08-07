import { normalizeKiroUpstreamError, UpstreamRetryCategory, type KiroModel } from '../proxy/kiroApi'

export interface KskCredentialCleanupResult {
  checked: number
  removed: number
  retainedTransient: number
  errors: string[]
}

export const KSK_CREDENTIAL_VALIDATION_CONCURRENCY = 4

export interface StoredKskAccountForCleanup {
  groupId?: string
  credentials?: {
    credentialKind?: string
    kiroApiKey?: string
  }
}

export interface StoredKskAccountDataForCleanup<TAccount extends StoredKskAccountForCleanup> {
  accounts?: Record<string, TAccount>
  activeAccountId?: string | null
  accountProxyBindings?: Record<string, string>
  [key: string]: unknown
}

export interface InvalidKskAccountIdentity {
  key: string
  groupId?: string
}

const PERMANENT_HTTP_STATUSES = new Set([401, 403, 423])
const CREDENTIAL_SPECIFIC_PERMANENT_PATTERNS = [
  /AccountSuspendedException/i,
  /temporarily[_ -]?suspended/i,
  /account[^\n]{0,40}suspended/i,
  /invalid[^\n]{0,24}(?:api[ _-]?key|credential|token)/i,
  /(?:api[ _-]?key|credential|token)[^\n]{0,24}invalid/i
]
const GENERIC_PERMANENT_PATTERNS = [
  /UnauthorizedException/i,
  /AccessDeniedException/i,
  /ExpiredTokenException/i
]
const CREDENTIAL_CONTEXT_PATTERN = /(?:kiro|upstream|account|api[ _-]?key|credential|token)/i

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 验活兜底模型：拉不到上游模型列表时用它。Haiku 是当前最便宜的一档，
 * 与 LIVENESS_MODELS 里的候选保持同名（见 renderer/src/hooks/useLivenessModels.ts）。
 */
export const KSK_CLEANUP_FALLBACK_MODEL = 'claude-haiku-4.5'

/** 验活请求的最大输出 token：只要上游肯回一个字就够，不必让它写完整句。 */
export const KSK_CLEANUP_MAX_OUTPUT_TOKENS = 8

/** 验活提示词：让模型只回一个短 token，尽量少耗 credits。 */
export const KSK_CLEANUP_PROBE_MESSAGE = 'Hi, reply with "pong" only.'

/** 单个账号验活的超时；超时按 transient 处理（保留账号），不作为失效证据。 */
export const KSK_CLEANUP_PROBE_TIMEOUT_MS = 45_000

/**
 * 从上游模型列表里挑最便宜的一个。
 *
 * `rateMultiplier` 是 Kiro 自己标的 credits 倍率（Haiku 通常 < 1，Opus 远大于 1），
 * 直接按它排序即可，不必在本地维护一份会过期的价目表。倍率缺失的模型排在最后，
 * 避免把未知成本的模型当便宜货。同倍率时按 modelId 排序，保证选择稳定可复现。
 */
export function pickCheapestModelId(models: readonly KiroModel[]): string | undefined {
  const usable = models.filter((model) => model.modelId && model.status !== 'DEPRECATED')
  if (usable.length === 0) return undefined
  const cheapest = usable.reduce((best, candidate) => {
    const bestRate = best.rateMultiplier ?? Number.POSITIVE_INFINITY
    const candidateRate = candidate.rateMultiplier ?? Number.POSITIVE_INFINITY
    if (candidateRate !== bestRate) return candidateRate < bestRate ? candidate : best
    return candidate.modelId < best.modelId ? candidate : best
  })
  return cheapest.modelId
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++
        results[index] = await worker(items[index], index)
      }
    })
  )
  return results
}

export function removeMatchingInvalidKskAccounts<TAccount extends StoredKskAccountForCleanup>(
  current: StoredKskAccountDataForCleanup<TAccount>,
  invalidAccounts: ReadonlyMap<string, InvalidKskAccountIdentity>
): { data: StoredKskAccountDataForCleanup<TAccount>; removedIds: string[] } {
  const accounts = { ...(current.accounts ?? {}) }
  const bindings = { ...(current.accountProxyBindings ?? {}) }
  const removedIds: string[] = []
  for (const [accountId, expected] of invalidAccounts) {
    const account = accounts[accountId]
    if (
      !account ||
      account.groupId !== expected.groupId ||
      account.credentials?.credentialKind !== 'kiro_api_key' ||
      account.credentials.kiroApiKey !== expected.key
    ) {
      continue
    }
    delete accounts[accountId]
    delete bindings[accountId]
    removedIds.push(accountId)
  }
  if (removedIds.length === 0) return { data: current, removedIds }
  return {
    data: {
      ...current,
      accounts,
      accountProxyBindings: bindings,
      activeAccountId: removedIds.includes(current.activeAccountId ?? '')
        ? null
        : current.activeAccountId
    },
    removedIds
  }
}

/**
 * 发消息验活的判定结果。
 * - `alive`：上游正常返回，账号可用。
 * - `permanently_invalid`：当下不可用且不会自愈（认证失败 / 封禁 / 配额耗尽），应删除。
 * - `transient`：超时、限流、5xx、模型 ID 不对等，无法据此判定账号，保留。
 */
export const KSK_PROBE_VERDICT = {
  ALIVE: 'alive',
  PERMANENTLY_INVALID: 'permanently_invalid',
  TRANSIENT: 'transient'
} as const

export type KskProbeVerdict = (typeof KSK_PROBE_VERDICT)[keyof typeof KSK_PROBE_VERDICT]

/**
 * 按上游错误分类判定 KSK 是否永久失效。
 *
 * 比对 message 做正则更可靠：`KiroUpstreamError.retryCategory` 是在 HTTP 边界上按
 * statusCode/reason 算出来的，不受错误文案变动影响。
 *
 * 归为永久失效的三类：
 * - AUTHENTICATION（401/403）：KSK 无 refresh 能力，认证失败就是废了。TEMPORARILY_SUSPENDED
 *   虽然字面上「临时」，但上游返 403，风控解除时间不可预期，按失效处理。
 * - MONTHLY_QUOTA（402 MONTHLY_REQUEST_COUNT）：配额耗尽，当下不能用即视为失效。
 * - NONE 且是 4xx：请求被上游明确拒绝且不可重试。但 400 通常是我们自己的请求有问题
 *   （典型是 INVALID_MODEL_ID），不能算到账号头上，见 isRequestSideRejection。
 */
export function classifyKskProbeError(error: unknown): KskProbeVerdict {
  const upstream = normalizeKiroUpstreamError(error)
  if (
    upstream.retryCategory === UpstreamRetryCategory.AUTHENTICATION ||
    upstream.retryCategory === UpstreamRetryCategory.MONTHLY_QUOTA
  ) {
    return KSK_PROBE_VERDICT.PERMANENTLY_INVALID
  }
  if (
    upstream.retryCategory === UpstreamRetryCategory.NONE &&
    upstream.statusCode !== undefined &&
    upstream.statusCode >= 400 &&
    upstream.statusCode < 500 &&
    !isRequestSideRejection(upstream.statusCode)
  ) {
    return KSK_PROBE_VERDICT.PERMANENTLY_INVALID
  }
  return KSK_PROBE_VERDICT.TRANSIENT
}

/** 400 是我们发的 payload 有问题（模型 ID 不存在等），与账号有效性无关。 */
function isRequestSideRejection(statusCode: number): boolean {
  return statusCode === 400
}

/**
 * KSK 没有 refresh 能力。主应用直接验活时，最终的 401/403/423 可视为永久失效；
 * 经过本机 Admin 转发时则必须同时出现明确的上游凭据语义，避免把 Admin Key 失效误判成账号失效。
 *
 * 仅用于本机 Admin 转发路径（错误已被序列化成字符串，拿不到结构化 statusCode）。
 * 主应用直连路径请用 classifyKskProbeError。
 */
export function isPermanentKskCredentialError(
  error: unknown,
  options: { requireExplicitCredentialSignal?: boolean } = {}
): boolean {
  const message = errorMessage(error)
  if (CREDENTIAL_SPECIFIC_PERMANENT_PATTERNS.some((pattern) => pattern.test(message))) return true
  const hasGenericPermanentSignal = GENERIC_PERMANENT_PATTERNS.some((pattern) =>
    pattern.test(message)
  )
  if (options.requireExplicitCredentialSignal) {
    return hasGenericPermanentSignal && CREDENTIAL_CONTEXT_PATTERN.test(message)
  }
  if (hasGenericPermanentSignal) return true
  const status = message.match(/(?:HTTP|status(?: code)?)\s*[:=]?\s*(\d{3})/i)?.[1]
  return status ? PERMANENT_HTTP_STATUSES.has(Number(status)) : false
}
