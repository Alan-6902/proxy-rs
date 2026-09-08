/**
 * Cursor 账号的业务编排：刷新、导入、登录收尾、切号。
 *
 * 刷新一个号 = 必要时换 access token → 拉用户信息 → 拉订阅 → 拉用量。前三步失败只记
 * 日志继续跑（能拿多少拿多少），用量失败记到 quotaQueryLastError 给界面看。
 */

import {
  isCursorAccountBanned,
  type CursorAccount,
  type CursorCredentialImportSummary,
  type CursorInjectOptions,
  type CursorInjectResult,
  type CursorRefreshAllSummary
} from '../../shared/cursorAccounts'
import { mapWithConcurrency } from '../kskAutomation/credentialCleanup'
import {
  exportCursorAccountsJson,
  findCursorAccountByIdentity,
  loadCursorAccounts,
  mutateCursorAccounts,
  parseCursorImportJson,
  upsertCursorAccount,
  upsertCursorAccounts,
  type CursorImportPayload
} from './accountStore'
import {
  accessTokenNeedsRefresh,
  exchangeRefreshToken,
  fetchCreditGrantsBalance,
  fetchSandUsageStatus,
  fetchStripeProfile,
  fetchUsageSummary,
  fetchUserMeta,
  normalizeCursorSignUpType,
  resolveMembershipFromStripeProfile
} from './cursorApi'
import {
  isCursorRunning,
  launchCursor,
  quitCursor,
  readLocalCursorAuth,
  writeLocalCursorAuth
} from './cursorLocalState'
import {
  completeCursorOAuthLogin,
  loginWithCursorSessionCookie,
  parseCursorSessionCredentials,
  type CursorSessionCredential
} from './cursorOAuth'

/** 批量刷新并发数。Cursor 接口对单账号限流，跨账号小并发即可。 */
const REFRESH_ALL_CONCURRENCY = 3

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function setAuthRaw(
  account: CursorAccount,
  key: string,
  value: string | boolean | undefined
): void {
  if (value === undefined || value === '') return
  account.authRaw = { ...(account.authRaw ?? {}), [key]: value }
}

async function findAccountOrThrow(id: string): Promise<CursorAccount> {
  const account = (await loadCursorAccounts()).find((item) => item.id === id)
  if (!account) throw new Error(`Cursor 账号不存在: ${id}`)
  return account
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/** 拉一遍远端信息，把结果写回一个账号副本；不落盘。 */
async function collectRemoteState(source: CursorAccount): Promise<CursorAccount> {
  const account: CursorAccount = { ...source, authRaw: { ...(source.authRaw ?? {}) } }
  const tag = `[CursorRefresh] id=${account.id}`

  if (account.refreshToken && accessTokenNeedsRefresh(account.accessToken)) {
    try {
      const refreshed = await exchangeRefreshToken(account.refreshToken)
      account.accessToken = refreshed.accessToken
      account.refreshToken = refreshed.refreshToken ?? account.refreshToken
      setAuthRaw(account, 'accessToken', account.accessToken)
      setAuthRaw(account, 'refreshToken', account.refreshToken)
      console.log(`${tag} access token 已换新`)
    } catch (error) {
      console.warn(`${tag} access token 换新失败，继续用现有 token: ${errorMessage(error)}`)
    }
  }

  try {
    const meta = await fetchUserMeta(account.accessToken)
    const email = meta.email?.toLowerCase()
    if (email?.includes('@')) {
      account.email = email
      setAuthRaw(account, 'cachedEmail', email)
    }
    const signUpType = normalizeCursorSignUpType(meta.signUpType)
    if (signUpType) {
      account.signUpType = signUpType
      setAuthRaw(account, 'cachedSignUpType', signUpType)
    }
    setAuthRaw(account, 'workosId', meta.workosId)
    if (!account.authId && meta.workosId) account.authId = meta.workosId
  } catch (error) {
    console.warn(`${tag} 用户信息拉取失败: ${errorMessage(error)}`)
  }

  try {
    const profile = await fetchStripeProfile(account.accessToken)
    if (profile) {
      const membershipType = resolveMembershipFromStripeProfile(profile)
      if (membershipType) {
        account.membershipType = membershipType
        setAuthRaw(account, 'stripeMembershipType', membershipType)
      }
      if (profile.subscriptionStatus) account.subscriptionStatus = profile.subscriptionStatus
      setAuthRaw(account, 'stripeSubscriptionStatus', profile.subscriptionStatus)
      setAuthRaw(account, 'teamMembershipType', profile.teamMembershipType)
      setAuthRaw(account, 'isTeamMember', profile.isTeamMember)
      setAuthRaw(account, 'isEnterprise', profile.isEnterprise)
    } else {
      console.warn(`${tag} 未获取到订阅信息`)
    }
  } catch (error) {
    console.warn(`${tag} 订阅信息拉取失败: ${errorMessage(error)}`)
  }

  const now = Date.now()
  try {
    const usage = await fetchUsageSummary(account.accessToken)
    const membershipType = usage.membershipType
    if (typeof membershipType === 'string' && membershipType.trim()) {
      account.membershipType = membershipType.trim()
    }
    account.usageRaw = usage
    account.usageUpdatedAt = now
    account.quotaQueryLastError = undefined
    account.quotaQueryLastErrorAt = undefined
  } catch (error) {
    console.warn(`${tag} 用量拉取失败: ${errorMessage(error)}`)
    account.quotaQueryLastError = errorMessage(error)
    account.quotaQueryLastErrorAt = now
  }

  // Bot 额度与 credit 余额是附加项：拉不到只记日志，保留上一次的值，不影响主用量的成败判定
  try {
    account.botUsageRaw = await fetchSandUsageStatus(account.accessToken)
  } catch (error) {
    console.warn(`${tag} Bot 用量拉取失败: ${errorMessage(error)}`)
  }
  try {
    account.creditBalanceCents = await fetchCreditGrantsBalance(account.accessToken)
  } catch (error) {
    console.warn(`${tag} credit 余额拉取失败: ${errorMessage(error)}`)
  }

  account.lastUsed = now
  return account
}

/**
 * 只把远端拿回来的字段合并到库里当前那条记录上，标签、备注这类本地字段以库里为准，
 * 避免刷新期间用户改的标签被旧副本覆盖。
 */
function mergeRefreshed(stored: CursorAccount, refreshed: CursorAccount): void {
  stored.email = refreshed.email
  stored.authId = refreshed.authId
  stored.accessToken = refreshed.accessToken
  stored.refreshToken = refreshed.refreshToken
  stored.membershipType = refreshed.membershipType
  stored.subscriptionStatus = refreshed.subscriptionStatus
  stored.signUpType = refreshed.signUpType
  stored.authRaw = refreshed.authRaw
  stored.usageRaw = refreshed.usageRaw
  stored.botUsageRaw = refreshed.botUsageRaw
  stored.creditBalanceCents = refreshed.creditBalanceCents
  stored.usageUpdatedAt = refreshed.usageUpdatedAt
  stored.quotaQueryLastError = refreshed.quotaQueryLastError
  stored.quotaQueryLastErrorAt = refreshed.quotaQueryLastErrorAt
  stored.lastUsed = refreshed.lastUsed
}

export async function refreshCursorAccount(id: string): Promise<CursorAccount> {
  const source = await findAccountOrThrow(id)
  const refreshed = await collectRemoteState(source)
  return mutateCursorAccounts((accounts) => {
    const stored = accounts.find((item) => item.id === id)
    if (!stored) throw new Error(`Cursor 账号已被删除: ${id}`)
    mergeRefreshed(stored, refreshed)
    return stored
  })
}

/** 已封禁的号不刷：接口只会再返回一次 403。 */
export async function refreshAllCursorAccounts(): Promise<CursorRefreshAllSummary> {
  const targets = (await loadCursorAccounts()).filter((account) => !isCursorAccountBanned(account))
  const failed: CursorRefreshAllSummary['failed'] = []
  await mapWithConcurrency(targets, REFRESH_ALL_CONCURRENCY, async (account) => {
    try {
      await refreshCursorAccount(account.id)
    } catch (error) {
      failed.push({ id: account.id, email: account.email, error: errorMessage(error) })
    }
  })
  return { total: targets.length, success: targets.length - failed.length, failed }
}

/**
 * 新号先拉远端信息再入库：握手 / 裸 token 进来时往往没有邮箱，先拿到邮箱去重才准
 * （同一个号在不同入口的 WorkOS id 可能不同），而且只落一次盘。远端拉不到也照样入库。
 */
async function enrichAndUpsert(payload: CursorImportPayload): Promise<CursorAccount> {
  const now = Date.now()
  const draft: CursorAccount = {
    id: 'pending',
    email: payload.email,
    authId: payload.authId,
    name: payload.name,
    tags: payload.tags ?? [],
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    membershipType: payload.membershipType,
    subscriptionStatus: payload.subscriptionStatus,
    signUpType: payload.signUpType,
    authRaw: payload.authRaw,
    usageRaw: payload.usageRaw,
    botUsageRaw: payload.botUsageRaw,
    creditBalanceCents: payload.creditBalanceCents,
    status: payload.status,
    statusReason: payload.statusReason,
    createdAt: payload.createdAt ?? now,
    lastUsed: now
  }
  const enriched = await collectRemoteState(draft)
  return upsertCursorAccount({
    ...payload,
    email: enriched.email,
    authId: enriched.authId,
    accessToken: enriched.accessToken,
    refreshToken: enriched.refreshToken,
    membershipType: enriched.membershipType,
    subscriptionStatus: enriched.subscriptionStatus,
    signUpType: enriched.signUpType,
    authRaw: enriched.authRaw,
    usageRaw: enriched.usageRaw,
    botUsageRaw: enriched.botUsageRaw,
    creditBalanceCents: enriched.creditBalanceCents,
    quotaQueryLastError: enriched.quotaQueryLastError,
    quotaQueryLastErrorAt: enriched.quotaQueryLastErrorAt
  })
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export async function importCursorAccountsFromJson(json: string): Promise<CursorAccount[]> {
  return upsertCursorAccounts(parseCursorImportJson(json))
}

export async function importCursorAccountFromLocal(): Promise<CursorAccount> {
  const payload = readLocalCursorAuth()
  if (!payload) throw new Error('未找到本机 Cursor 的登录信息，请先在 Cursor 里登录一次')
  return enrichAndUpsert(payload)
}

/** 日志与结果里不放整段凭据：有 userId 用 userId，否则只露 token 开头。 */
function credentialLabel(credential: CursorSessionCredential): string {
  return credential.userId ?? `${credential.token.slice(0, 12)}…`
}

/**
 * 单条凭据入库：先走登录握手换正式 token 对；握手不通（比如给的是客户端 access token 而不是
 * 网页 session）就退回按 access token 入库，但退回前先用它拉一次用户信息验真，避免把一个
 * 已失效的 token 存成僵尸账号。
 */
async function importCredential(
  credential: CursorSessionCredential
): Promise<CursorCredentialImportSummary['added'][number]> {
  try {
    const payload = await loginWithCursorSessionCookie(credential)
    return { account: await enrichAndUpsert(payload), viaHandshake: true }
  } catch (handshakeError) {
    console.warn(
      `[CursorAccounts] cookie 握手失败，尝试按 access token 入库: ${credentialLabel(credential)}, ${errorMessage(handshakeError)}`
    )
    try {
      await fetchUserMeta(credential.token)
    } catch {
      throw handshakeError
    }
    return {
      account: await enrichAndUpsert({ email: '', accessToken: credential.token }),
      viaHandshake: false
    }
  }
}

/**
 * 粘贴 WorkosCursorSessionToken cookie / access token 批量入库，每行一条。
 * 逐条处理、互不影响，最后一起汇报成功与失败。
 */
export async function addCursorAccountsFromCredentials(
  input: string
): Promise<CursorCredentialImportSummary> {
  const { credentials, unrecognized } = parseCursorSessionCredentials(input)
  if (credentials.length === 0 && unrecognized.length === 0) {
    throw new Error('请粘贴 WorkosCursorSessionToken 的 cookie 值或 access token')
  }
  const summary: CursorCredentialImportSummary = {
    added: [],
    failed: unrecognized.map((line) => ({
      label: `${line.slice(0, 24)}${line.length > 24 ? '…' : ''}`,
      error: '无法识别，需要 user_xxx::eyJ… 或 eyJ… 形式'
    }))
  }
  for (const credential of credentials) {
    try {
      summary.added.push(await importCredential(credential))
    } catch (error) {
      summary.failed.push({ label: credentialLabel(credential), error: errorMessage(error) })
    }
  }
  return summary
}

export async function finishCursorOAuthLogin(loginId: string): Promise<CursorAccount> {
  return enrichAndUpsert(await completeCursorOAuthLogin(loginId))
}

export async function exportCursorAccounts(ids: string[]): Promise<string> {
  const selected = new Set(ids)
  const accounts = (await loadCursorAccounts()).filter((account) => selected.has(account.id))
  return exportCursorAccountsJson(accounts)
}

// ---------------------------------------------------------------------------
// Current account / inject
// ---------------------------------------------------------------------------

/** 本机 Cursor 当前登录的号对应库里哪一条；读不到或没匹配上返回 null。 */
export async function resolveCurrentCursorAccountId(): Promise<string | null> {
  let local: CursorImportPayload | null
  try {
    local = readLocalCursorAuth()
  } catch (error) {
    console.warn(`[CursorAccounts] 读取本机登录态失败: ${errorMessage(error)}`)
    return null
  }
  if (!local) return null
  const matched = findCursorAccountByIdentity(await loadCursorAccounts(), {
    authId: local.authId,
    email: local.email,
    accessToken: local.accessToken
  })
  return matched?.id ?? null
}

export async function injectCursorAccount(
  id: string,
  options: CursorInjectOptions = {}
): Promise<CursorInjectResult> {
  const account = await findAccountOrThrow(id)
  const running = await isCursorRunning()
  if (running && !options.closeCursor) {
    return { status: 'needsClose', email: account.email }
  }
  if (running) await quitCursor()

  writeLocalCursorAuth(account)
  await mutateCursorAccounts((accounts) => {
    const stored = accounts.find((item) => item.id === id)
    if (stored) stored.lastUsed = Date.now()
  })
  console.log(`[CursorSwitch] 已写入本机登录态: id=${account.id}, email=${account.email}`)

  let relaunched = false
  if (running) {
    try {
      await launchCursor()
      relaunched = true
    } catch (error) {
      console.warn(`[CursorSwitch] 重新启动 Cursor 失败: ${errorMessage(error)}`)
    }
  }
  return { status: 'done', email: account.email, relaunched }
}
