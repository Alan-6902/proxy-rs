/**
 * 「账号已交给本机反代托管」的登记与判定。
 *
 * 背景：Kiro 的 refreshToken 是轮换制的，一次刷新作废旧的。proxy-rs 与本机
 * 反代若同时持有同一账号的 refreshToken 并各自刷新，必然有一方拿旧值去刷，
 * 换来 401 Bad credentials，最终把号烧掉。解法是让反代成为唯一刷新者，
 * proxy-rs 对已推送的账号停止本地刷新。
 *
 * 关键约束：托管关系一旦建立，本地那份 refreshToken 就随时可能被反代轮换掉，
 * 因而永久失去权威性——**不能用它做任何比对**。唯一可信的锚点是
 * accountId → credentialId，而 credentialId 是否仍然有效，只能拿反代自己
 * 返回的 hash 来校验（防 id 复用）。
 */

export type AdminManagedAuthMethod = 'api_key' | 'idc' | 'social'

/**
 * 托管账号的刷新被闸门拦下时返回的错误码。
 *
 * 主进程与渲染进程共用：渲染层据此把「无需刷新」与「刷新失败」区分开，
 * 不把卡片标红——对托管账号来说「刷新被拦下」是预期行为，不是故障。
 */
export const ADMIN_MANAGED_REFRESH_SUPPRESSED = 'ADMIN_MANAGED_REFRESH_SUPPRESSED'

export interface AdminManagedAccountEntry {
  /** 本地账号 id，托管判定的主键 */
  accountId: string
  /** 反代返回的凭据 id，托管关系的唯一可信锚点 */
  credentialId: string
  authMethod: AdminManagedAuthMethod
  /** 登记时从反代读到的 kiroApiKey 哈希，仅用于校验 credentialId 未被复用 */
  remoteApiKeyHash?: string
  /** 登记时从反代读到的 refreshToken 哈希，同上 */
  remoteRefreshTokenHash?: string
  pushedAt: number
  /** 每次在反代凭据列表里仍能看到该 credentialId 时刷新为当前时间 */
  lastSeenRemoteAt?: number
  /** 由 email 兜底认领（迁移期），未经强校验，UI 需提示复核 */
  adoptedByEmail?: boolean
}

export interface AdminManagedReconcileDrop {
  accountId: string
  credentialId: string
  /** missing = 反代已无此凭据；hash_changed = 该 id 已被别的凭据复用 */
  reason: 'missing' | 'hash_changed'
}

export interface AdminManagedReconcileResult {
  kept: AdminManagedAccountEntry[]
  dropped: AdminManagedReconcileDrop[]
}

/** 反代凭据列表里本模块关心的字段（结构与 RemoteCredential 兼容）。 */
export interface AdminManagedRemoteCredential {
  id: string
  apiKeyHash?: string | null
  refreshTokenHash?: string | null
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function isAuthMethod(value: unknown): value is AdminManagedAuthMethod {
  return value === 'api_key' || value === 'idc' || value === 'social'
}

/** 清洗单条登记记录；缺 accountId / credentialId / authMethod 的一律丢弃。 */
export function normalizeAdminManagedEntry(value: unknown): AdminManagedAccountEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>

  const accountId = asNonEmptyString(raw.accountId)
  const credentialId = asNonEmptyString(raw.credentialId)
  if (!accountId || !credentialId) return null
  if (!isAuthMethod(raw.authMethod)) return null

  const pushedAt = asTimestamp(raw.pushedAt)
  if (pushedAt === undefined) return null

  return {
    accountId,
    credentialId,
    authMethod: raw.authMethod,
    remoteApiKeyHash: asNonEmptyString(raw.remoteApiKeyHash),
    remoteRefreshTokenHash: asNonEmptyString(raw.remoteRefreshTokenHash),
    pushedAt,
    lastSeenRemoteAt: asTimestamp(raw.lastSeenRemoteAt),
    adoptedByEmail: raw.adoptedByEmail === true ? true : undefined
  }
}

/**
 * 清洗整份登记表：逐条归一化，并按 accountId 去重（同一账号保留 pushedAt 最新的一条）。
 *
 * 接受裸数组与 `{ entries: [...] }` 两种形状，便于落盘格式演进。
 */
export function normalizeAdminManagedPayload(payload: unknown): AdminManagedAccountEntry[] {
  let list: unknown[] = []
  if (Array.isArray(payload)) {
    list = payload
  } else if (typeof payload === 'object' && payload !== null) {
    const entries = (payload as { entries?: unknown }).entries
    if (Array.isArray(entries)) list = entries
  }

  const byAccount = new Map<string, AdminManagedAccountEntry>()
  for (const item of list) {
    const entry = normalizeAdminManagedEntry(item)
    if (!entry) continue
    const existing = byAccount.get(entry.accountId)
    if (!existing || entry.pushedAt >= existing.pushedAt) byAccount.set(entry.accountId, entry)
  }
  return [...byAccount.values()]
}

/**
 * 该账号的本地 token 刷新是否应当被抑制。
 *
 * 白名单语义：只有明确登记过托管的账号才返回 true。registry 尚未就绪、条目
 * 损坏或 accountId 缺失时一律 false（fail-open）——fail-closed 的代价是未托管
 * 账号全线停刷、token 过期、服务不可用，远大于「多刷一次」。
 */
export function shouldSuppressKiroRefresh(
  managedIds: ReadonlySet<string>,
  accountId?: string
): boolean {
  if (!accountId) return false
  return managedIds.has(accountId)
}

/**
 * 按反代当前的凭据列表核对登记表。
 *
 * - credentialId 已不在远端 → dropped('missing')，该账号恢复本地刷新；
 * - id 还在但两个 hash 都对不上 → dropped('hash_changed')。反代删掉旧凭据后
 *   新建的凭据可能拿到同一个 id，不校验就会把新凭据误当成托管对象，永久停掉
 *   本地刷新，形成死角；
 * - 对得上 → kept，并把 lastSeenRemoteAt 刷新为 now。
 */
export function reconcileAdminManagedEntries(
  entries: readonly AdminManagedAccountEntry[],
  remote: readonly AdminManagedRemoteCredential[],
  now: number
): AdminManagedReconcileResult {
  const byId = new Map(remote.map((item) => [item.id, item]))
  const kept: AdminManagedAccountEntry[] = []
  const dropped: AdminManagedReconcileDrop[] = []

  for (const entry of entries) {
    const found = byId.get(entry.credentialId)
    if (!found) {
      dropped.push({
        accountId: entry.accountId,
        credentialId: entry.credentialId,
        reason: 'missing'
      })
      continue
    }

    const matchesApiKey =
      Boolean(entry.remoteApiKeyHash) && found.apiKeyHash === entry.remoteApiKeyHash
    const matchesRefresh =
      Boolean(entry.remoteRefreshTokenHash) &&
      found.refreshTokenHash === entry.remoteRefreshTokenHash

    if (!matchesApiKey && !matchesRefresh) {
      dropped.push({
        accountId: entry.accountId,
        credentialId: entry.credentialId,
        reason: 'hash_changed'
      })
      continue
    }

    kept.push({ ...entry, lastSeenRemoteAt: now })
  }

  return { kept, dropped }
}

/** 认领用的本地账号视图。哈希由调用方预先算好，shared 不依赖 node:crypto。 */
export interface AdoptionLocalAccount {
  id: string
  email?: string
  refreshTokenHash?: string
  kiroApiKeyHash?: string
}

/** 认领用的远端凭据视图（与反代 `GET /credentials` 的字段兼容）。 */
export interface AdoptionRemoteCredential {
  id: string
  email?: string | null
  authMethod?: string | null
  apiKeyHash?: string | null
  refreshTokenHash?: string | null
}

export interface AdoptionResult {
  claimed: AdminManagedAccountEntry[]
  /** email 在本地不唯一、无法安全认领的远端凭据 */
  ambiguousEmail: string[]
}

function toManagedAuthMethod(value: string | null | undefined): AdminManagedAuthMethod {
  if (value === 'api_key') return 'api_key'
  if (value === 'idc') return 'idc'
  return 'social'
}

function buildAdoptionEntry(
  account: AdoptionLocalAccount,
  credential: AdoptionRemoteCredential,
  now: number,
  adoptedByEmail: boolean
): AdminManagedAccountEntry {
  return {
    accountId: account.id,
    credentialId: credential.id,
    authMethod: toManagedAuthMethod(credential.authMethod),
    remoteApiKeyHash: credential.apiKeyHash ?? undefined,
    remoteRefreshTokenHash: credential.refreshTokenHash ?? undefined,
    pushedAt: now,
    lastSeenRemoteAt: now,
    adoptedByEmail: adoptedByEmail ? true : undefined
  }
}

/**
 * 把反代里已有的凭据认领回本地账号，生成托管登记。
 *
 * 用于升级：改造前推给反代的账号在登记表里没有条目，升级后会立刻恢复本地刷新、
 * 重新开始双边抢刷。必须先把它们认回来。
 *
 * 两级匹配：
 * - 强匹配：本地 token 的 sha256 与反代返回的哈希相等，口径与推送判重一致。
 *   注意**已被反代轮换过的号必然强匹配失败**——本地那份 token 早已作废。
 * - 弱匹配（email 兜底）：仅在 email 于本地唯一时采用，条目打 adoptedByEmail
 *   标记以便 UI 提示复核。
 *
 * 弱匹配失败时**不**默认「未托管」：那等于默认让这个号继续被双边抢刷，而烧号
 * 不可逆。宁可多认领（用户可一键取消），也不要漏认。
 */
export function matchRemoteCredentialToLocalAccount(input: {
  accounts: readonly AdoptionLocalAccount[]
  remote: readonly AdoptionRemoteCredential[]
  now: number
}): AdoptionResult {
  const byRefreshHash = new Map<string, AdoptionLocalAccount>()
  const byApiKeyHash = new Map<string, AdoptionLocalAccount>()
  const byEmail = new Map<string, AdoptionLocalAccount[]>()
  const duplicateEmail = new Set<string>()

  for (const account of input.accounts) {
    if (account.refreshTokenHash) byRefreshHash.set(account.refreshTokenHash, account)
    if (account.kiroApiKeyHash) byApiKeyHash.set(account.kiroApiKeyHash, account)
    const email = account.email?.trim().toLowerCase()
    if (!email) continue
    if (byEmail.has(email)) duplicateEmail.add(email)
    byEmail.set(email, [...(byEmail.get(email) ?? []), account])
  }

  const claimed: AdminManagedAccountEntry[] = []
  const ambiguousEmail: string[] = []
  const claimedAccountIds = new Set<string>()

  for (const credential of input.remote) {
    const strong =
      (credential.refreshTokenHash && byRefreshHash.get(credential.refreshTokenHash)) ||
      (credential.apiKeyHash && byApiKeyHash.get(credential.apiKeyHash)) ||
      undefined
    if (strong && !claimedAccountIds.has(strong.id)) {
      claimedAccountIds.add(strong.id)
      claimed.push(buildAdoptionEntry(strong, credential, input.now, false))
      continue
    }

    const email = credential.email?.trim().toLowerCase()
    if (!email) continue
    const candidates = (byEmail.get(email) ?? []).filter(
      (candidate) => !claimedAccountIds.has(candidate.id)
    )
    if (candidates.length === 0) continue
    // email 在本地撞车时不敢认：认错了会让另一个号的刷新被误停
    if (duplicateEmail.has(email) || candidates.length > 1) {
      if (!ambiguousEmail.includes(email)) ambiguousEmail.push(email)
      continue
    }
    claimedAccountIds.add(candidates[0].id)
    claimed.push(buildAdoptionEntry(candidates[0], credential, input.now, true))
  }

  return { claimed, ambiguousEmail }
}
