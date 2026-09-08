/**
 * Cursor 官方接口客户端：换 token、拉用户信息、拉订阅、拉用量。
 *
 * 端点与请求方式移植自 cockpit-tools 的 cursor_account.rs，与 Cursor 客户端自身的行为一致：
 * 用量接口不认 Bearer，只认 `WorkosCursorSessionToken` cookie，cookie 由 JWT 的 sub 拼出来。
 */

import { fetch as undiciFetch, type Dispatcher } from 'undici'
import { getSystemProxy, safeCreateProxyAgent } from '../proxy/systemProxy'

const CURSOR_USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary'
/** 预付 credit 余额；cursor.com 网页接口，与用量接口同样走 session cookie。 */
const CURSOR_CREDIT_GRANTS_BALANCE_URL =
  'https://cursor.com/api/dashboard/get-credit-grants-balance'
const CURSOR_GET_USER_META_URL = 'https://api2.cursor.sh/aiserver.v1.AuthService/GetUserMeta'
/** Grok Bot 周额度，与 cursor.com 仪表盘同一条接口；Connect 协议端点，要带协议版本头。 */
const CURSOR_SAND_USAGE_STATUS_URL =
  'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus'
const CONNECT_PROTOCOL_VERSION_HEADER = { 'Connect-Protocol-Version': '1' }
const CURSOR_FULL_STRIPE_PROFILE_URL = 'https://api2.cursor.sh/auth/full_stripe_profile'
const CURSOR_STRIPE_PROFILE_URL = 'https://api2.cursor.sh/auth/stripe_profile'
/** 与官方客户端一致：用 api2.cursor.sh/oauth/token 和内置 client_id 换新 token。 */
const CURSOR_OAUTH_TOKEN_URL = 'https://api2.cursor.sh/oauth/token'
const CURSOR_AUTH_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB'
const CURSOR_USAGE_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'

const REQUEST_TIMEOUT_MS = 15_000
/** access token 距过期不足这个时长就先换一次，避免刷新流程中途失效。 */
const ACCESS_TOKEN_REFRESH_THRESHOLD_MS = 5 * 60_000

export const CURSOR_SESSION_EXPIRED_MESSAGE = 'Cursor 会话已过期或未认证，请重新登录或导入账号'

export interface CursorUserMeta {
  email?: string
  signUpType?: string
  workosId?: string
}

export interface CursorStripeProfile {
  membershipType?: string
  individualMembershipType?: string
  subscriptionStatus?: string
  teamMembershipType?: string
  isTeamMember?: boolean
  isEnterprise?: boolean
}

export interface CursorRefreshedTokens {
  accessToken: string
  refreshToken?: string
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const decoded = Buffer.from(parts[1], 'base64url').toString('utf-8')
    const parsed: unknown = JSON.parse(decoded)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function readNonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** JWT 的 sub 形如 `auth0|user_xxx`，整段就是 Cursor 的 authId。 */
export function extractAuthIdFromAccessToken(accessToken: string): string | undefined {
  return readNonEmpty(decodeJwtPayload(accessToken)?.sub)
}

/** 只取 sub 里 `|` 之后的 `user_xxx`，用量接口的 cookie 只认这一段。 */
export function extractWorkosUserId(accessToken: string): string | undefined {
  const sub = extractAuthIdFromAccessToken(accessToken)
  if (!sub) return undefined
  const userId = sub.split('|').pop() ?? sub
  return userId.startsWith('user_') ? userId : undefined
}

export function extractAccessTokenExpiresAt(accessToken: string): number | undefined {
  const exp = decodeJwtPayload(accessToken)?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
}

/** 解析不出 exp 一律当需要刷新处理，宁可多换一次。 */
export function accessTokenNeedsRefresh(accessToken: string, now = Date.now()): boolean {
  const expiresAt = extractAccessTokenExpiresAt(accessToken)
  if (expiresAt === undefined) return true
  return expiresAt <= now + ACCESS_TOKEN_REFRESH_THRESHOLD_MS
}

export function buildSessionCookie(accessToken: string): string | undefined {
  const userId = extractWorkosUserId(accessToken)
  if (!userId) return undefined
  return `WorkosCursorSessionToken=${userId}%3A%3A${accessToken}`
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** 环境变量代理优先，其次系统代理；与 Kiro 接口的取法一致。 */
function resolveDispatcher(): Dispatcher | undefined {
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  return safeCreateProxyAgent(envProxy) ?? safeCreateProxyAgent(getSystemProxy())
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause
    const causeText = cause instanceof Error ? cause.message : cause ? String(cause) : ''
    return causeText && causeText !== error.message
      ? `${error.message} (${causeText})`
      : error.message
  }
  return String(error)
}

export interface CursorHttpResponse {
  status: number
  text: string
}

/** 带超时与代理的裸请求；只做传输层错误包装，状态码交给调用方判断。 */
export async function cursorFetch(
  url: string,
  init: { method?: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  what: string
): Promise<CursorHttpResponse> {
  let response: Awaited<ReturnType<typeof undiciFetch>>
  try {
    response = await undiciFetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      dispatcher: resolveDispatcher(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    throw new Error(`请求 ${what} 失败: ${describeFetchError(error)}`)
  }
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw new Error(`读取 ${what} 响应失败: ${describeFetchError(error)}`)
  }
  return { status: response.status, text }
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`解析 ${what} JSON 失败: ${describeFetchError(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`解析 ${what} 失败: 响应不是对象`)
  }
  return parsed as Record<string, unknown>
}

function isUnauthorized(status: number): boolean {
  return status === 401 || status === 403
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readNonEmpty(record[key])
    if (value) return value
  }
  return undefined
}

function pickBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export async function exchangeRefreshToken(refreshToken: string): Promise<CursorRefreshedTokens> {
  const what = 'Cursor token 刷新接口'
  const { status, text } = await cursorFetch(
    CURSOR_OAUTH_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CURSOR_AUTH_CLIENT_ID,
        refresh_token: refreshToken
      })
    },
    what
  )
  if (isUnauthorized(status)) {
    throw new Error('Cursor refresh token 已过期或无效，请重新登录或导入账号')
  }
  if (status !== 200) {
    throw new Error(`${what}返回异常状态码: ${status}`)
  }
  const record = parseJsonObject(text, what)
  if (record.should_logout === true || record.shouldLogout === true) {
    throw new Error('Cursor refresh token 已失效，请重新登录或导入账号')
  }
  const accessToken = pickString(record, 'access_token', 'accessToken')
  if (!accessToken) throw new Error(`${what}响应缺少 access_token`)
  return { accessToken, refreshToken: pickString(record, 'refresh_token', 'refreshToken') }
}

export async function fetchUserMeta(accessToken: string): Promise<CursorUserMeta> {
  const what = 'Cursor user meta'
  const { status, text } = await cursorFetch(
    CURSOR_GET_USER_META_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: '{}'
    },
    what
  )
  if (isUnauthorized(status)) throw new Error(CURSOR_SESSION_EXPIRED_MESSAGE)
  if (status !== 200) throw new Error(`${what} API 返回异常状态码: ${status}`)
  const record = parseJsonObject(text, what)
  return {
    email: pickString(record, 'email'),
    signUpType: pickString(record, 'signUpType', 'sign_up_type'),
    workosId: pickString(record, 'workosId', 'workos_id')
  }
}

function parseStripeProfile(record: Record<string, unknown>): CursorStripeProfile {
  return {
    membershipType: pickString(record, 'membershipType', 'membership_type'),
    individualMembershipType: pickString(
      record,
      'individualMembershipType',
      'individual_membership_type'
    ),
    subscriptionStatus: pickString(record, 'subscriptionStatus', 'subscription_status'),
    teamMembershipType: pickString(record, 'teamMembershipType', 'team_membership_type'),
    isTeamMember: pickBoolean(record, 'isTeamMember', 'is_team_member'),
    isEnterprise: pickBoolean(record, 'isEnterprise', 'is_enterprise')
  }
}

/**
 * 先打完整版接口，非 200 再回落到精简版。精简版有时返回一个非空字符串而不是对象，
 * 官方客户端把这种情况当 Pro 处理，这里沿用。
 */
export async function fetchStripeProfile(accessToken: string): Promise<CursorStripeProfile | null> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }

  const full = await cursorFetch(
    CURSOR_FULL_STRIPE_PROFILE_URL,
    { headers },
    'Cursor full stripe profile'
  )
  if (isUnauthorized(full.status)) throw new Error(CURSOR_SESSION_EXPIRED_MESSAGE)
  if (full.status === 200) {
    return parseStripeProfile(parseJsonObject(full.text, 'Cursor full stripe profile'))
  }

  const fallback = await cursorFetch(
    CURSOR_STRIPE_PROFILE_URL,
    { headers },
    'Cursor stripe profile'
  )
  if (isUnauthorized(fallback.status)) throw new Error(CURSOR_SESSION_EXPIRED_MESSAGE)
  if (fallback.status !== 200) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(fallback.text)
  } catch (error) {
    throw new Error(`解析 Cursor stripe profile JSON 失败: ${describeFetchError(error)}`)
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parseStripeProfile(parsed as Record<string, unknown>)
  }
  if (typeof parsed === 'string') {
    return parsed.trim() ? { membershipType: 'pro' } : null
  }
  return null
}

export async function fetchUsageSummary(accessToken: string): Promise<Record<string, unknown>> {
  const cookie = buildSessionCookie(accessToken)
  if (!cookie) throw new Error('无法从 accessToken 解析 WorkOS 用户 ID')
  const what = 'Cursor usage API'
  const { status, text } = await cursorFetch(
    CURSOR_USAGE_SUMMARY_URL,
    {
      headers: { Accept: 'application/json', Cookie: cookie, 'User-Agent': CURSOR_USAGE_USER_AGENT }
    },
    what
  )
  if (isUnauthorized(status)) throw new Error(CURSOR_SESSION_EXPIRED_MESSAGE)
  if (status !== 200) throw new Error(`${what} 返回异常状态码: ${status}`)
  return parseJsonObject(text, what)
}

/** 余额接口对没有赠送额度的账号返回 `{}`，这是「余额 0」而不是失败。 */
export function parseCreditGrantsBalance(record: Record<string, unknown>): number {
  const value = record.creditBalanceCents ?? record.credit_balance_cents
  const cents = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(cents) && cents > 0 ? Math.round(cents) : 0
}

export async function fetchCreditGrantsBalance(accessToken: string): Promise<number> {
  const cookie = buildSessionCookie(accessToken)
  if (!cookie) throw new Error('无法从 accessToken 解析 WorkOS 用户 ID')
  const what = 'Cursor credit 余额'
  const { status, text } = await cursorFetch(
    CURSOR_CREDIT_GRANTS_BALANCE_URL,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard/billing',
        'User-Agent': CURSOR_USAGE_USER_AGENT
      },
      body: '{}'
    },
    what
  )
  if (isUnauthorized(status)) throw new Error(CURSOR_SESSION_EXPIRED_MESSAGE)
  if (status !== 200) throw new Error(`${what} API 返回异常状态码: ${status}`)
  return parseCreditGrantsBalance(parseJsonObject(text, what))
}

/**
 * Grok Bot 周额度。响应形如
 * `{ hasNonZeroIncludedLimit, usagePercent, currentPeriodStart, nextResetTimestampUtc, grokPlanLabel }`，
 * 原样返回交给 shared 层解析。
 */
export async function fetchSandUsageStatus(accessToken: string): Promise<Record<string, unknown>> {
  const what = 'Cursor Bot 用量'
  const { status, text } = await cursorFetch(
    CURSOR_SAND_USAGE_STATUS_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...CONNECT_PROTOCOL_VERSION_HEADER
      },
      body: '{}'
    },
    what
  )
  if (isUnauthorized(status)) throw new Error(CURSOR_SESSION_EXPIRED_MESSAGE)
  if (status !== 200) throw new Error(`${what} API 返回异常状态码: ${status}`)
  return parseJsonObject(text, what)
}

/**
 * 订阅类型的取舍：个人字段非 free 且总字段不是 enterprise 时优先个人字段，
 * 否则用总字段；两者都没有才回落到个人字段。
 */
export function resolveMembershipFromStripeProfile(
  profile: CursorStripeProfile
): string | undefined {
  const membership = readNonEmpty(profile.membershipType)
  const individual = readNonEmpty(profile.individualMembershipType)
  if (
    individual &&
    individual.toLowerCase() !== 'free' &&
    membership?.toLowerCase() !== 'enterprise'
  ) {
    return individual
  }
  return membership ?? individual
}

const SIGN_UP_TYPE_PREFIX = 'SIGN_UP_TYPE_'

/** 已知枚举保留官方写法，其余（如 GROK）去前缀后首字母大写，避免界面上出现原始枚举名。 */
export function normalizeCursorSignUpType(value: string | undefined): string | undefined {
  const raw = readNonEmpty(value)
  if (!raw) return undefined
  switch (raw) {
    case 'SIGN_UP_TYPE_AUTH_0':
      return 'Auth_0'
    case 'SIGN_UP_TYPE_GOOGLE':
      return 'Google'
    case 'SIGN_UP_TYPE_GITHUB':
      return 'Github'
    case 'SIGN_UP_TYPE_WORKOS':
      return 'WorkOS'
    default: {
      if (!raw.startsWith(SIGN_UP_TYPE_PREFIX)) return raw
      const rest = raw.slice(SIGN_UP_TYPE_PREFIX.length).toLowerCase()
      return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : raw
    }
  }
}
