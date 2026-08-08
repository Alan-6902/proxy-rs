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

function sha256Hex(value: string): string {
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
      await requestJson(
        input.fetchImpl,
        `${baseUrl}/credentials/${encodeURIComponent(credentialId)}`,
        adminApiKey,
        timeoutMs,
        { method: 'DELETE' }
      )
      result.removed++
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error))
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
      await requestJson(
        input.fetchImpl,
        `${baseUrl}/credentials/${encodeURIComponent(credentialId)}`,
        adminApiKey,
        timeoutMs,
        { method: 'DELETE' }
      )
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
  describe: (detail: string) => string
): Promise<void> {
  try {
    await verify()
    return
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    let removed = false
    try {
      await requestJson(
        context.fetchImpl,
        `${context.baseUrl}/credentials/${encodeURIComponent(context.credentialId)}`,
        context.adminApiKey,
        context.timeoutMs,
        { method: 'DELETE' }
      )
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
   * 2) 发消息：balance 通不代表能出活（超额号 balance 照样通，
   *    见 credentialCleanup 的注释），所以还要真发一条消息。
   *
   * transient（超时 / 限流 / 5xx）在这里也算不通过。它确实可能冤枉好号，
   * 但「推送失败可以重推」比「推进去了但可能不能用」代价小。
   */
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
    (detail) => `本机 Admin 无法使用该凭据（余额接口失败）：${detail}`
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
    verified: true,
    authMethod: payload.authMethod,
    // 没注入探针时只过了 balance 那一关，别谎报 alive
    probeVerdict: input.probeLiveness
      ? LOCAL_ADMIN_PROBE_VERDICT.ALIVE
      : LOCAL_ADMIN_PROBE_VERDICT.SKIPPED
  }
}
