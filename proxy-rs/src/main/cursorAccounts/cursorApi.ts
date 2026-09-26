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
/** Grok Bot 客户端跟 Bot 对话走的同一组云端接口：列出该号的 Bot、给 Bot 发一条用户消息。 */
const CURSOR_GROK_BOT_LIST_AGENTS_URL =
  'https://api2.cursor.sh/aiserver.v1.GrokBotService/ListGrokBotAgents'
const CURSOR_GROK_BOT_SEND_MESSAGE_URL =
  'https://api2.cursor.sh/aiserver.v1.GrokBotService/SendGrokBotUserMessage'
const CURSOR_GROK_BOT_TRANSCRIPT_URL =
  'https://api2.cursor.sh/aiserver.v1.GrokBotService/ListGrokBotTranscriptEntries'
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

/** Connect 协议的 JSON 单次调用：Bearer + 协议版本头，请求体和响应体都是 proto 的 JSON 映射。 */
async function connectUnaryJson(
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
  what: string
): Promise<Record<string, unknown>> {
  const { status, text } = await cursorFetch(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...CONNECT_PROTOCOL_VERSION_HEADER
      },
      body: JSON.stringify(body)
    },
    what
  )
  if (isUnauthorized(status)) throw new Error(CURSOR_SESSION_EXPIRED_MESSAGE)
  if (status !== 200) throw new Error(`${what} API 返回异常状态码: ${status}`)
  return parseJsonObject(text, what)
}

/** 云端 GrokBotAgent 里切号自动化用得上的几个字段；agentId 才是发消息用的 id，id 是服务端主键。 */
export interface GrokBotAgentSummary {
  agentId: string
  name: string
  /** 运行载体：box（跑在该号的 Box 里）或 temporal（云端工作流）。 */
  harness: string
  updatedAtMs: number
  viewerIsOwner: boolean
}

/** 把 ListGrokBotAgents 的 JSON 响应收成摘要列表；proto 的 int64 在 JSON 里是字符串，这里统一转数字。 */
export function parseGrokBotAgents(record: Record<string, unknown>): GrokBotAgentSummary[] {
  const agents = Array.isArray(record.agents) ? record.agents : []
  const result: GrokBotAgentSummary[] = []
  for (const item of agents) {
    if (!item || typeof item !== 'object') continue
    const agent = item as Record<string, unknown>
    const agentId = readNonEmpty(agent.agentId)
    if (!agentId) continue
    const updatedRaw = agent.updatedAtMs
    const updatedAtMs =
      typeof updatedRaw === 'number'
        ? updatedRaw
        : typeof updatedRaw === 'string' && /^\d+$/.test(updatedRaw)
          ? Number(updatedRaw)
          : 0
    result.push({
      agentId,
      name: readNonEmpty(agent.name) ?? agentId,
      harness: readNonEmpty(agent.harness) ?? '',
      updatedAtMs,
      viewerIsOwner: agent.viewerIsOwner !== false
    })
  }
  return result
}

/** 列出这个号能看到的 Grok Bot（含团队共享的）。 */
export async function listGrokBotAgents(accessToken: string): Promise<GrokBotAgentSummary[]> {
  const record = await connectUnaryJson(
    CURSOR_GROK_BOT_LIST_AGENTS_URL,
    accessToken,
    { includeTeamAgents: true },
    'Grok Bot 列表'
  )
  return parseGrokBotAgents(record)
}

/**
 * SendGrokBotUserMessage 响应里 delivery 的枚举。Connect JSON 给的是 proto 全名，个别实现会给数字，
 * 两种都认。与 Grok 客户端同口径：ACCEPTED_BOX / ACCEPTED_TEMPORAL / DUPLICATE 都算接下了，
 * REFUSED 才是拒绝；`dispatched` 字段不是判据。
 */
const GROK_BOT_DELIVERY_NAMES: Record<number, string> = {
  1: 'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_BOX',
  2: 'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL',
  3: 'GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE',
  4: 'GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED'
}
const GROK_BOT_DELIVERY_ACCEPTED = new Set([
  GROK_BOT_DELIVERY_NAMES[1],
  GROK_BOT_DELIVERY_NAMES[2],
  GROK_BOT_DELIVERY_NAMES[3]
])
const GROK_BOT_DELIVERY_REFUSED = GROK_BOT_DELIVERY_NAMES[4]

export interface GrokBotSendOutcome {
  /** 云端是否接下了这条消息（delivery 为 ACCEPTED_* 或 DUPLICATE）。 */
  accepted: boolean
  /** delivery 枚举名，接受与否都带上，便于排查。 */
  delivery?: string
  /** 被拒或无法判定时的说明。 */
  refusal?: string
}

/** 把 SendGrokBotUserMessage 的 JSON 响应归一成结果；纯函数，便于单测。 */
export function parseGrokBotSendOutcome(record: Record<string, unknown>): GrokBotSendOutcome {
  const rawDelivery = record.delivery
  const delivery =
    typeof rawDelivery === 'number'
      ? GROK_BOT_DELIVERY_NAMES[rawDelivery]
      : readNonEmpty(rawDelivery)
  const refusalRecord =
    record.refusal && typeof record.refusal === 'object'
      ? (record.refusal as Record<string, unknown>)
      : undefined
  const refusal = refusalRecord
    ? pickString(refusalRecord, 'message', 'failureCode', 'failure_code')
    : readNonEmpty(record.refusal)
  if (delivery && GROK_BOT_DELIVERY_ACCEPTED.has(delivery)) {
    return { accepted: true, delivery }
  }
  if (delivery === GROK_BOT_DELIVERY_REFUSED) {
    return { accepted: false, delivery, refusal: refusal ?? '云端拒绝了这条消息' }
  }
  // 没有 delivery 的老响应只能看 dispatched
  if (record.dispatched === true) return { accepted: true, delivery }
  return {
    accepted: false,
    delivery,
    refusal: refusal ?? `云端没有给出投递结果（delivery=${delivery ?? '空'}）`
  }
}

/** Bot 对话里的一条可读消息；工具调用、扣费记录等非文本条目不在此列。 */
export interface GrokBotTranscriptMessage {
  seq: number
  role: 'user' | 'bot'
  text: string
  timestampMs?: number
}

/** 对话记录里用户消息与 Bot 回复的 entry_kind；其余（spend-initiation 等）没有可读文本。 */
const GROK_BOT_TRANSCRIPT_KIND_USER = 'message'
const GROK_BOT_TRANSCRIPT_KIND_BOT = 'send-message'

function readTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return undefined
}

/**
 * 把 ListGrokBotTranscriptEntries 的响应收成按 seq 升序的可读消息。entry.body 是 base64 的 JSON：
 * 用户消息形如 `{kind:'message', role:'user', content, timestampMs}`，Bot 回复形如
 * `{kind:'send-message', message:{type:'text', content} | {type:'widget', widget:{prompt}}}`。
 * 大消息只给 blobHash 不给 body，这里直接跳过——排查进度只需要短句。纯函数，便于单测。
 */
export function parseGrokBotTranscript(
  record: Record<string, unknown>
): GrokBotTranscriptMessage[] {
  const entries = Array.isArray(record.entries) ? record.entries : []
  const messages: GrokBotTranscriptMessage[] = []
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const seq = readTimestamp(entry.seq)
    const body = typeof entry.body === 'string' ? entry.body : undefined
    if (seq === undefined || !body || entry.bodyOmitted === true) continue
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(body, 'base64').toString('utf-8'))
    } catch {
      continue
    }
    if (!decoded || typeof decoded !== 'object') continue
    const payload = decoded as Record<string, unknown>
    const timestampMs = readTimestamp(payload.timestampMs)
    if (entry.entryKind === GROK_BOT_TRANSCRIPT_KIND_USER) {
      const text = readNonEmpty(payload.content)
      if (text) messages.push({ seq, role: 'user', text, timestampMs })
      continue
    }
    if (entry.entryKind === GROK_BOT_TRANSCRIPT_KIND_BOT) {
      const message =
        payload.message && typeof payload.message === 'object'
          ? (payload.message as Record<string, unknown>)
          : undefined
      const widget =
        message?.widget && typeof message.widget === 'object'
          ? (message.widget as Record<string, unknown>)
          : undefined
      const text = readNonEmpty(message?.content) ?? readNonEmpty(widget?.prompt)
      if (text) messages.push({ seq, role: 'bot', text, timestampMs })
    }
  }
  return messages.sort((a, b) => a.seq - b.seq)
}

/** 拉某个 Bot 最近的对话记录（含用户消息与 Bot 回复），按时间升序。 */
export async function listGrokBotTranscript(
  accessToken: string,
  input: { agentId: string; limit: number }
): Promise<GrokBotTranscriptMessage[]> {
  const record = await connectUnaryJson(
    CURSOR_GROK_BOT_TRANSCRIPT_URL,
    accessToken,
    { agentId: input.agentId, limit: input.limit, sessionId: '' },
    'Grok Bot 对话记录'
  )
  return parseGrokBotTranscript(record)
}

/**
 * 以用户身份给某个 Bot 发一条消息，等价于在 Grok Bot 客户端聊天框里输入。messageId 由调用方决定，
 * 便于重发时幂等。
 */
export async function sendGrokBotUserMessage(
  accessToken: string,
  input: { agentId: string; messageId: string; text: string }
): Promise<GrokBotSendOutcome> {
  const record = await connectUnaryJson(
    CURSOR_GROK_BOT_SEND_MESSAGE_URL,
    accessToken,
    {
      agentId: input.agentId,
      messageId: input.messageId,
      text: input.text,
      sentAtMs: String(Date.now())
    },
    'Grok Bot 发消息'
  )
  return parseGrokBotSendOutcome(record)
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
