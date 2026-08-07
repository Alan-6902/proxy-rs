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
 * KSK 没有 refresh 能力。主应用直接验活时，最终的 401/403/423 可视为永久失效；
 * 经过本机 Admin 转发时则必须同时出现明确的上游凭据语义，避免把 Admin Key 失效误判成账号失效。
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
