import { createHash } from 'node:crypto'
import { isValidKiroApiKey, isValidKiroRegion } from '../../shared/kiroApiKey'
import {
  LOCAL_ADMIN_AUTH_METHOD,
  LOCAL_ADMIN_PROBE_VERDICT,
  resolveLocalAdminCredentialPayload,
  type LocalAdminProbeVerdict,
  type LocalAdminPushCandidate,
  type LocalAdminPushResult
} from '../../shared/localAdminPush'
import type { KskCredentialCleanupResult } from './credentialCleanup'

export interface LocalAdminAccount {
  kiroApiKey: string
  region: string
}

/** 发消息验活的结论 + 失败时的错误摘要。 */
export interface LocalAdminProbeOutcome {
  verdict: LocalAdminProbeVerdict
  error?: string
}

export interface LocalAdminSyncResult {
  discovered: number
  skippedExisting: number
  synced: number
  verified: number
  /** 本次删掉的「Admin 有、本地同步分组没有」的残留 api_key 凭据数量。 */
  pruned: number
  /** 被删掉的残留凭据脱敏 Key，供日志展示；Admin 不回明文，只能用它的 maskedApiKey。 */
  prunedMaskedKeys: string[]
  errors: string[]
}

export type KskAutomationFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }
) => Promise<Response>

/**
 * `GET /api/admin/credentials` 单条凭据。Admin 只回哈希与脱敏 Key，不回明文。
 * 字段按 kiro-rs 实测响应列全，统计页要读计数与状态，同步链路只用哈希判重。
 */
export interface RemoteCredential {
  id?: string | number
  apiKeyHash?: string | null
  refreshTokenHash?: string | null
  authMethod?: string
  maskedApiKey?: string
  endpoint?: string
  email?: string | null
  subscriptionTitle?: string | null
  priority?: number
  disabled?: boolean
  isCurrent?: boolean
  successCount?: number
  failureCount?: number
  refreshFailureCount?: number
  /** 经本机反代累计的 tokens，需 kiro-rs 支持；旧版本不返回该字段 */
  inputTokens?: number
  outputTokens?: number
  /** 经本机反代消耗的 Kiro 积分累计值（估算），需 kiro-rs 支持 */
  usedCredits?: number
  lastUsedAt?: string | number | null
  expiresAt?: string | number | null
  hasProfileArn?: boolean
  hasProxy?: boolean
}

function redactAdminErrorDetail(value: string): string {
  return value
    .replace(/ksk_[A-Za-z0-9_-]+/g, 'ksk_••••')
    .replace(/("?(?:token|apiKey|kiroApiKey)"?\s*[:=]\s*")([^"]+)(")/gi, '$1••••$3')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '••••@••••')
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

/** 接受用户看到的 /admin 地址，归一化为后端 /api/admin。 */
export function resolveLocalAdminApiBase(value: string): string {
  const parsed = new URL(value.trim())
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))
  ) {
    throw new Error('本机 Admin 仅允许 loopback HTTP；远程地址必须使用 HTTPS')
  }
  parsed.search = ''
  parsed.hash = ''
  const path = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = path.endsWith('/api/admin') ? path : '/api/admin'
  return parsed.toString().replace(/\/$/, '')
}

/**
 * Admin 侧凭据哈希的算法。
 *
 * 导出是因为「按 id 删 Admin 凭据后要找出本地对应账号」这条反向匹配也得用它：
 * Admin 只回哈希，本地只有明文，两边靠同一个算法碰。改这里就得改 Admin，别单独动。
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 从 Admin 响应里取出 credentials 数组，非法结构一律当空。 */
export function readRemoteCredentials(payload: unknown): RemoteCredential[] {
  if (typeof payload !== 'object' || payload === null) return []
  const credentials = (payload as { credentials?: unknown }).credentials
  if (!Array.isArray(credentials)) return []
  return credentials.filter(
    (item): item is RemoteCredential => typeof item === 'object' && item !== null
  )
}

/** 统一的 Admin 请求：注入 x-api-key、超时中断，并在报错时脱敏响应体。 */
export async function requestJson(
  fetchImpl: KskAutomationFetch,
  url: string,
  apiKey: string,
  timeoutMs: number,
  init: { method: string; body?: unknown }
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: init.method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal
    })
    const text = await response.text()
    if (!response.ok) {
      const detail = redactAdminErrorDetail(text.replace(/\s+/g, ' ').trim()).slice(0, 300)
      throw new Error(`本机 Admin 请求失败: HTTP ${response.status}${detail ? ` · ${detail}` : ''}`)
    }
    return text ? (JSON.parse(text) as unknown) : {}
  } finally {
    clearTimeout(timer)
  }
}

/** 取出 Admin 侧凭据 id，统一成字符串（Admin 用数字，本地按字符串传）。 */
export function remoteCredentialId(credential: RemoteCredential): string | undefined {
  const value = credential.id
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

/**
 * 删除 Admin 上的一条凭据。
 *
 * Admin 只收已禁用的凭据（`DELETE` 未禁用的会返回 400「只能删除已禁用的凭据」），
 * 所以启用中的先 POST /disabled 再删。少了这一步，凡是仍处于启用状态的凭据
 * 都永远删不掉——本地已经判死或已经删掉的号会一直赖在反代池子里。
 *
 * `disabled` 传 Admin 列表里读到的状态；不确定时传 false 走两步，多一个幂等请求而已。
 */
async function deleteRemoteCredential(input: {
  baseUrl: string
  adminApiKey: string
  timeoutMs: number
  credentialId: string
  disabled: boolean
  fetchImpl: KskAutomationFetch
}): Promise<void> {
  const target = `${input.baseUrl}/credentials/${encodeURIComponent(input.credentialId)}`
  if (!input.disabled) {
    await requestJson(input.fetchImpl, `${target}/disabled`, input.adminApiKey, input.timeoutMs, {
      method: 'POST',
      body: { disabled: true }
    })
  }
  await requestJson(input.fetchImpl, target, input.adminApiKey, input.timeoutMs, {
    method: 'DELETE'
  })
}

/**
 * 按本地验活结论删除本机 Admin（kiro-rs 反代）上的对应凭据。
 *
 * 判定权全部在本地：这里只负责「本地已经判死的这些 key，在 Admin 上也删掉」。
 * 不再去打 Admin 的 balance 接口自行判活——那条路口径与本地发消息验活不一致
 * （超额号 balance 照样通），而且 Admin 侧错误经过序列化后拿不到结构化 statusCode，
 * 只能靠正则猜，容易把 Admin Key 自身的问题当成账号失效。
 *
 * Admin 只回 apiKeyHash 不回明文，所以本地按同样的 sha256(key) 算一遍来匹配。
 */
export async function deleteLocalAdminCredentialsByKey(input: {
  keys: readonly string[]
  baseUrl: string
  adminApiKey: string
  timeoutSeconds: number
  fetchImpl: KskAutomationFetch
}): Promise<KskCredentialCleanupResult> {
  const result: KskCredentialCleanupResult = {
    checked: 0,
    removed: 0,
    retainedTransient: 0,
    errors: []
  }
  const targetHashes = new Map(input.keys.map((key) => [sha256Hex(key), key]))
  if (targetHashes.size === 0) return result

  const baseUrl = resolveLocalAdminApiBase(input.baseUrl)
  const adminApiKey = input.adminApiKey.trim()
  if (!adminApiKey) throw new Error('未配置本机 Admin API Key')
  const timeoutMs = Math.max(3, input.timeoutSeconds) * 1000

  const payload = await requestJson(
    input.fetchImpl,
    `${baseUrl}/credentials`,
    adminApiKey,
    timeoutMs,
    { method: 'GET' }
  )
  const doomed = readRemoteCredentials(payload).filter(
    (credential) =>
      credential.authMethod === 'api_key' &&
      credential.apiKeyHash &&
      targetHashes.has(credential.apiKeyHash) &&
      remoteCredentialId(credential)
  )
  result.checked = doomed.length

  for (const credential of doomed) {
    const credentialId = remoteCredentialId(credential)
    if (!credentialId) continue
    try {
      await deleteRemoteCredential({
        baseUrl,
        adminApiKey,
        timeoutMs,
        credentialId,
        disabled: credential.disabled === true,
        fetchImpl: input.fetchImpl
      })
      result.removed++
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return result
}

/** 按 id 删除时的单条结果，供调用方对齐本地账号库。 */
export interface LocalAdminDeletedCredential {
  credentialId: string
  /** Admin 侧的 sha256(明文 key)。本地按同样算法反查出是哪个账号。 */
  apiKeyHash?: string
  maskedApiKey?: string
}

export interface LocalAdminDeleteByIdResult {
  deleted: LocalAdminDeletedCredential[]
  errors: string[]
}

/**
 * 按 Admin 侧的 id 删除凭据。
 *
 * 与 deleteLocalAdminCredentialsByKey 的分工：那个函数的输入是本地明文 key（本地先判死，
 * 再去 Admin 找对应哈希）；这个函数的输入是已经从 Admin 列表里挑好的 id——额度耗尽是
 * 从 Admin 的 balance 读出来的，本地压根不知道是哪个 key，只能反过来按 id 删、再把
 * 删掉的 apiKeyHash 回给调用方去对齐本地账号库。
 *
 * 单条失败不影响其余条目：一条删不掉就把它记进 errors，剩下的照删。
 */
export async function deleteLocalAdminCredentialsById(input: {
  credentials: ReadonlyArray<{ credentialId: string; disabled?: boolean }>
  baseUrl: string
  adminApiKey: string
  timeoutSeconds: number
  fetchImpl: KskAutomationFetch
}): Promise<LocalAdminDeleteByIdResult> {
  const result: LocalAdminDeleteByIdResult = { deleted: [], errors: [] }
  if (input.credentials.length === 0) return result

  const baseUrl = resolveLocalAdminApiBase(input.baseUrl)
  const adminApiKey = input.adminApiKey.trim()
  if (!adminApiKey) throw new Error('未配置本机 Admin API Key')
  const timeoutMs = Math.max(3, input.timeoutSeconds) * 1000

  /*
   * 删之前先读一遍列表：要拿 apiKeyHash 才能对齐本地账号库，而 disabled 状态也可能
   * 在统计采样之后被改过（用户手动禁用了）。传进来的 disabled 只当兜底。
   */
  const remoteById = new Map<string, RemoteCredential>()
  try {
    const payload = await requestJson(
      input.fetchImpl,
      `${baseUrl}/credentials`,
      adminApiKey,
      timeoutMs,
      { method: 'GET' }
    )
    for (const credential of readRemoteCredentials(payload)) {
      const id = remoteCredentialId(credential)
      if (id) remoteById.set(id, credential)
    }
  } catch (error) {
    throw new Error(
      `读取本机 Admin 凭据列表失败：${error instanceof Error ? error.message : String(error)}`
    )
  }

  for (const target of input.credentials) {
    const remote = remoteById.get(target.credentialId)
    // 列表里已经没有了：可能被别的链路先删了，算成功而不是报错
    if (!remote) continue
    try {
      await deleteRemoteCredential({
        baseUrl,
        adminApiKey,
        timeoutMs,
        credentialId: target.credentialId,
        disabled: remote.disabled === true,
        fetchImpl: input.fetchImpl
      })
      result.deleted.push({
        credentialId: target.credentialId,
        apiKeyHash: remote.apiKeyHash ?? undefined,
        maskedApiKey: remote.maskedApiKey
      })
    } catch (error) {
      result.errors.push(
        `删除凭据 ${remote.maskedApiKey || `#${target.credentialId}`} 失败：${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
  return result
}

function readCredentialId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const direct = record.credentialId ?? record.id
  if (typeof direct === 'string' || typeof direct === 'number') return String(direct)
  const nested = record.credential
  if (typeof nested !== 'object' || nested === null) return undefined
  const nestedId = (nested as Record<string, unknown>).id
  return typeof nestedId === 'string' || typeof nestedId === 'number' ? String(nestedId) : undefined
}

export async function syncKskAccountsToLocalAdmin(input: {
  accounts: LocalAdminAccount[]
  baseUrl: string
  adminApiKey: string
  timeoutSeconds: number
  fetchImpl: KskAutomationFetch
}): Promise<LocalAdminSyncResult> {
  const baseUrl = resolveLocalAdminApiBase(input.baseUrl)
  const adminApiKey = input.adminApiKey.trim()
  if (!adminApiKey) throw new Error('未配置本机 Admin API Key')
  const timeoutMs = Math.max(3, input.timeoutSeconds) * 1000
  const uniqueAccounts = new Map<string, LocalAdminAccount>()
  for (const account of input.accounts) {
    if (!isValidKiroApiKey(account.kiroApiKey) || !isValidKiroRegion(account.region)) continue
    uniqueAccounts.set(account.kiroApiKey, account)
  }

  const existingPayload = await requestJson(
    input.fetchImpl,
    `${baseUrl}/credentials`,
    adminApiKey,
    timeoutMs,
    { method: 'GET' }
  )
  const existingCredentials = readRemoteCredentials(existingPayload)
  const existingHashes = new Set(
    existingCredentials
      .map((credential) => credential.apiKeyHash)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  )

  const result: LocalAdminSyncResult = {
    discovered: uniqueAccounts.size,
    skippedExisting: 0,
    synced: 0,
    verified: 0,
    pruned: 0,
    prunedMaskedKeys: [],
    errors: []
  }

  /*
   * 先删残留，再推新号：本地已经删掉的号必须尽快从反代摘掉，
   * 而下面的 POST 可能因为网络问题卡住甚至中断，把删除排在后面就等于随时可能不执行。
   */
  const localHashes = new Set([...uniqueAccounts.keys()].map((kiroApiKey) => sha256Hex(kiroApiKey)))
  for (const credential of existingCredentials) {
    // 只对齐 api_key：oauth 凭据（social / IdC）不在本函数的输入里，无从判断本地是否还存在
    if (credential.authMethod !== 'api_key') continue
    const hash = credential.apiKeyHash
    if (!hash || localHashes.has(hash)) continue
    const credentialId = remoteCredentialId(credential)
    if (!credentialId) continue
    try {
      await deleteRemoteCredential({
        baseUrl,
        adminApiKey,
        timeoutMs,
        credentialId,
        disabled: credential.disabled === true,
        fetchImpl: input.fetchImpl
      })
      result.pruned++
      result.prunedMaskedKeys.push(credential.maskedApiKey || `#${credentialId}`)
      existingHashes.delete(hash)
    } catch (error) {
      result.errors.push(
        `删除残留凭据 ${credential.maskedApiKey || `#${credentialId}`} 失败：${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  for (const account of uniqueAccounts.values()) {
    const hash = sha256Hex(account.kiroApiKey)
    if (existingHashes.has(hash)) {
      result.skippedExisting++
      continue
    }
    try {
      const created = await requestJson(
        input.fetchImpl,
        `${baseUrl}/credentials`,
        adminApiKey,
        timeoutMs,
        {
          method: 'POST',
          body: {
            authMethod: 'api_key',
            kiroApiKey: account.kiroApiKey,
            authRegion: account.region,
            apiRegion: account.region,
            priority: 0
          }
        }
      )
      const credentialId = readCredentialId(created)
      if (!credentialId) throw new Error('本机 Admin 未返回 credentialId')
      result.synced++
      await requestJson(
        input.fetchImpl,
        `${baseUrl}/credentials/${encodeURIComponent(credentialId)}/balance`,
        adminApiKey,
        timeoutMs,
        { method: 'GET' }
      )
      result.verified++
      existingHashes.add(hash)
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return result
}

/** 验活结论转成给用户看的说法，探针没给具体错误时兜底。 */
function describeProbeVerdict(verdict: LocalAdminProbeVerdict): string {
  if (verdict === LOCAL_ADMIN_PROBE_VERDICT.PERMANENTLY_INVALID) {
    return '账号已失效（认证失败 / 封禁 / 配额耗尽）'
  }
  if (verdict === LOCAL_ADMIN_PROBE_VERDICT.TRANSIENT) {
    return '暂时无法确认（超时 / 限流 / 上游 5xx），请稍后重推'
  }
  return '未验证'
}

/**
 * 跑一道门禁；不通过就删掉刚创建的凭据并抛错。
 *
 * 删除失败要在错误信息里说清楚：那种情况下 Admin 里留了一条验不过的凭据，
 * 用户必须知道得手动清，不能让它悄悄留在池子里。
 */
async function verifyOrRollback(
  context: {
    baseUrl: string
    adminApiKey: string
    timeoutMs: number
    credentialId: string
    fetchImpl: KskAutomationFetch
  },
  verify: () => Promise<void>,
  describe: (detail: string) => string,
  /**
   * 判定这次失败是否应当放过（不回滚）。
   *
   * 只有在「失败本身并不证明凭据不可用」时才该放过，见 isBalanceQueryUnauthorized。
   */
  tolerate?: (detail: string) => boolean
): Promise<void> {
  try {
    await verify()
    return
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (tolerate?.(detail)) return
    let removed = false
    try {
      // 刚 POST 出来的凭据一定是启用状态，所以这里必须走「先禁用再删」的两步
      await deleteRemoteCredential({
        baseUrl: context.baseUrl,
        adminApiKey: context.adminApiKey,
        timeoutMs: context.timeoutMs,
        credentialId: context.credentialId,
        disabled: false,
        fetchImpl: context.fetchImpl
      })
      removed = true
    } catch {
      removed = false
    }
    throw new Error(
      removed
        ? `${describe(detail)}；已从 Admin 删除该凭据`
        : `${describe(detail)}；且删除凭据 #${context.credentialId} 失败，需要手动清理`
    )
  }
}

/**
 * 余额查询是否因「上游不允许这个身份查额度」而失败（而非凭据不可用）。
 *
 * Enterprise 账号实测：Admin 用它的 refreshToken 刷出 token 后调 getUsageLimits 会吃
 * 403 `User is not authorized to make this call.`，但同一条凭据在反代里发消息完全正常
 * （successCount 照涨）。也就是说这个 403 只说明「查不到额度」，不说明「凭据不能用」，
 * 拿它否决推送会把可用的号判死。
 *
 * Admin 侧把「权限不足」归类成 UpstreamError → HTTP 502（见后端 classify_balance_error），
 * 所以这里按响应体里的特征串匹配，而不是只看状态码：502 也可能是真的上游挂了。
 */
function isBalanceQueryUnauthorized(detail: string): boolean {
  return detail.includes('权限不足') || detail.includes('User is not authorized to make this call')
}

/**
 * 把单个账号推送到本机 Admin，并保证「推成功 = 反代真能用」。
 *
 * 与批量同步的差别：不限 credentialKind（social / idc / api_key 都收），
 * 并且 Admin 已有同一凭据时返回 existing 而不是静默跳过——手动点按钮的人
 * 需要知道"没新增"这个结果。
 *
 * 返回 created 即代表两道门禁都过了（Admin 能用这条凭据问到余额 + 真发消息出活）。
 * 任一关不过都会删掉凭据并抛错，绝不返回「推进去了但不确定能不能用」的结果。
 */
export async function pushAccountToLocalAdmin(input: {
  candidate: LocalAdminPushCandidate
  baseUrl: string
  adminApiKey: string
  timeoutSeconds: number
  fetchImpl: KskAutomationFetch
  /**
   * 发消息验活：推进 Admin 之后用同一份凭据真发一条消息，确认这个号真能出活。
   *
   * 不注入时跳过这一关（只保留 balance 门禁）。之所以做成注入而不是在这里直接调
   * callKiroApi：这个模块跑在测试里也要能用假 fetch 走完整流程，不该把上游 SDK 拖进来。
   */
  probeLiveness?: (candidate: LocalAdminPushCandidate) => Promise<LocalAdminProbeOutcome>
}): Promise<LocalAdminPushResult> {
  const resolved = resolveLocalAdminCredentialPayload(input.candidate)
  if (!resolved.ok) throw new Error(resolved.reason)

  const baseUrl = resolveLocalAdminApiBase(input.baseUrl)
  const adminApiKey = input.adminApiKey.trim()
  if (!adminApiKey) throw new Error('未配置本机 Admin API Key')
  const timeoutMs = Math.max(3, input.timeoutSeconds) * 1000

  const payload = resolved.payload
  const isApiKey = payload.authMethod === LOCAL_ADMIN_AUTH_METHOD.API_KEY
  // Admin 只回哈希，不回明文，所以本地按同样的 sha256 算一遍来判重
  const hash = sha256Hex(isApiKey ? payload.kiroApiKey! : payload.refreshToken!)
  const existing = readRemoteCredentials(
    await requestJson(input.fetchImpl, `${baseUrl}/credentials`, adminApiKey, timeoutMs, {
      method: 'GET'
    })
  ).find((credential) => (isApiKey ? credential.apiKeyHash : credential.refreshTokenHash) === hash)
  if (existing) {
    return {
      status: 'existing',
      credentialId: remoteCredentialId(existing),
      verified: false,
      authMethod: payload.authMethod,
      probeVerdict: LOCAL_ADMIN_PROBE_VERDICT.SKIPPED
    }
  }

  const created = await requestJson(
    input.fetchImpl,
    `${baseUrl}/credentials`,
    adminApiKey,
    timeoutMs,
    { method: 'POST', body: payload }
  )
  const credentialId = readCredentialId(created)
  if (!credentialId) throw new Error('本机 Admin 未返回 credentialId')

  /*
   * 两道门禁，任一不过就把刚建的凭据删掉并抛错：调用方要的是「推过去就一定能用」，
   * 留一条不确定的凭据在池子里，等于把问题推迟到真实请求时才炸。
   *
   * 1) balance：让 Admin 用这条凭据去问余额，验的是 Admin 侧接线
   *    （authMethod 解析对不对、它能不能拿这份凭据刷出 token）。
   *    例外见 isBalanceQueryUnauthorized：上游拒绝这个身份查额度时，
   *    这一关证明不了任何事，放过去交给发消息验活定生死。
   * 2) 发消息：balance 通不代表能出活（超额号 balance 照样通，
   *    见 credentialCleanup 的注释），所以还要真发一条消息。
   *
   * transient（超时 / 限流 / 5xx）在这里也算不通过。它确实可能冤枉好号，
   * 但「推送失败可以重推」比「推进去了但可能不能用」代价小。
   */
  let balanceVerified = true
  await verifyOrRollback(
    { baseUrl, adminApiKey, timeoutMs, credentialId, fetchImpl: input.fetchImpl },
    async () => {
      await requestJson(
        input.fetchImpl,
        `${baseUrl}/credentials/${encodeURIComponent(credentialId)}/balance`,
        adminApiKey,
        timeoutMs,
        { method: 'GET' }
      )
    },
    (detail) => `本机 Admin 无法使用该凭据（余额接口失败）：${detail}`,
    (detail) => {
      if (!isBalanceQueryUnauthorized(detail)) return false
      balanceVerified = false
      return true
    }
  )

  if (input.probeLiveness) {
    await verifyOrRollback(
      { baseUrl, adminApiKey, timeoutMs, credentialId, fetchImpl: input.fetchImpl },
      async () => {
        const outcome = await input.probeLiveness!(input.candidate)
        if (outcome.verdict === LOCAL_ADMIN_PROBE_VERDICT.ALIVE) return
        throw new Error(outcome.error || describeProbeVerdict(outcome.verdict))
      },
      (detail) => `发消息验活未通过：${detail}`
    )
  }

  return {
    status: 'created',
    credentialId,
    /*
     * verified 说的是「余额接口调通了」。上游拒绝这个身份查额度时这一关被放过，
     * 那就不能报 true——此时凭据的可用性是发消息验活背书的，不是余额接口背书的。
     */
    verified: balanceVerified,
    authMethod: payload.authMethod,
    // 没注入探针时只过了 balance 那一关，别谎报 alive
    probeVerdict: input.probeLiveness
      ? LOCAL_ADMIN_PROBE_VERDICT.ALIVE
      : LOCAL_ADMIN_PROBE_VERDICT.SKIPPED
  }
}
