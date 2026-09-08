/**
 * Cursor 登录握手（PKCE）。
 *
 * 流程与 Cursor 客户端一致：本地生成 code_verifier / challenge / uuid，把用户送到
 * cursor.com/loginDeepControl；用户在浏览器里登录后，客户端拿 uuid + verifier 轮询
 * api2.cursor.sh/auth/poll，直到拿到 token。同一时刻只保留一个交互式登录会话。
 *
 * 另一条路是不开浏览器：已经拿到 WorkosCursorSessionToken cookie 时，直接带 cookie 调
 * loginDeepControl 页面背后的 loginDeepCallbackControl 接口，等价于用户在页面上点了「确认
 * 登录」，随后 poll 立刻返回一对正式 token。这就是把「无痕窗口贴 cookie → 浏览器链接导入」
 * 那套手工流程自动化。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { CursorOAuthStartResult } from '../../shared/cursorAccounts'
import type { CursorImportPayload } from './accountStore'
import { cursorFetch, extractWorkosUserId } from './cursorApi'

const CURSOR_LOGIN_URL = 'https://cursor.com/loginDeepControl'
const CURSOR_LOGIN_CALLBACK_URL = 'https://cursor.com/api/auth/loginDeepCallbackControl'
const CURSOR_POLL_ENDPOINT = 'https://api2.cursor.sh/auth/poll'
const OAUTH_POLL_INTERVAL_MS = 2_000
const OAUTH_MAX_POLLS = 150
const OAUTH_SESSION_TTL_MS = 300_000
/** cookie 握手后 token 几乎立刻可取，短轮询即可。 */
const COOKIE_HANDSHAKE_POLL_INTERVAL_MS = 1_000
const COOKIE_HANDSHAKE_MAX_POLLS = 8
const CURSOR_WEB_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
const SESSION_COOKIE_NAME = 'WorkosCursorSessionToken'

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/
/** cookie 值形如 `user_xxx::<jwt>`，浏览器里看到的是 URL 编码过的 `%3A%3A`。 */
const SESSION_COOKIE_VALUE_PATTERN = new RegExp(
  `(user_[A-Za-z0-9]+)(?:::|%3A%3A)(${JWT_PATTERN.source})`,
  'i'
)

interface PendingOAuthState {
  loginId: string
  uuid: string
  codeVerifier: string
  expiresAt: number
  cancelled: boolean
}

interface PkceChallenge {
  uuid: string
  codeVerifier: string
  codeChallenge: string
}

let pending: PendingOAuthState | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function createPkceChallenge(): PkceChallenge {
  const codeVerifier = randomBytes(32).toString('base64url')
  return {
    uuid: randomUUID(),
    codeVerifier,
    codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url')
  }
}

function buildPollUrl(uuid: string, codeVerifier: string): string {
  return `${CURSOR_POLL_ENDPOINT}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(codeVerifier)}`
}

/**
 * 轮询 auth/poll 直到拿到 token。404 表示用户还没完成登录；`shouldStop` 每轮调用，
 * 交互式登录用它检查取消/过期。拿不到返回 null，网络错误只记日志继续。
 */
async function pollForTokens(
  uuid: string,
  codeVerifier: string,
  options: { maxPolls: number; intervalMs: number; shouldStop?: () => void }
): Promise<CursorImportPayload | null> {
  const pollUrl = buildPollUrl(uuid, codeVerifier)
  for (let attempt = 0; attempt < options.maxPolls; attempt += 1) {
    options.shouldStop?.()

    let response: Awaited<ReturnType<typeof cursorFetch>>
    try {
      response = await cursorFetch(
        pollUrl,
        { headers: { Accept: 'application/json' } },
        'Cursor 登录轮询'
      )
    } catch (error) {
      console.warn(
        `[CursorOAuth] 轮询请求失败，将重试: ${error instanceof Error ? error.message : String(error)}`
      )
      await sleep(options.intervalMs * 2)
      continue
    }

    if (response.status === 404) {
      await sleep(options.intervalMs)
      continue
    }
    if (response.status !== 200) {
      console.warn(`[CursorOAuth] 轮询返回异常状态码: ${response.status}`)
      await sleep(options.intervalMs)
      continue
    }

    let data: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(response.text)
      data = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      throw new Error('解析 Cursor 登录轮询响应失败')
    }

    const accessToken = readString(data.accessToken ?? data.access_token)
    const refreshToken = readString(data.refreshToken ?? data.refresh_token)
    const authId = readString(data.authId ?? data.auth_id)
    if (!accessToken || !refreshToken) {
      console.warn('[CursorOAuth] 轮询成功但响应缺少 token')
      await sleep(options.intervalMs)
      continue
    }

    const authRaw: Record<string, unknown> = { accessToken, refreshToken }
    if (authId) authRaw.authId = authId
    return {
      // 轮询接口的 authId 偶尔就是邮箱；不是邮箱时留空，等刷新用户信息时补
      email: authId && authId.includes('@') ? authId : '',
      authId,
      accessToken,
      refreshToken,
      authRaw
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Interactive browser login
// ---------------------------------------------------------------------------

export function startCursorOAuthLogin(): CursorOAuthStartResult {
  const { uuid, codeVerifier, codeChallenge } = createPkceChallenge()
  const now = Date.now()

  pending = {
    loginId: uuid,
    uuid,
    codeVerifier,
    expiresAt: now + OAUTH_SESSION_TTL_MS,
    cancelled: false
  }
  console.log(`[CursorOAuth] 登录会话已创建: loginId=${uuid}`)

  return {
    loginId: uuid,
    verificationUri: `${CURSOR_LOGIN_URL}?challenge=${codeChallenge}&uuid=${uuid}&mode=login`,
    expiresIn: OAUTH_SESSION_TTL_MS / 1000,
    intervalSeconds: OAUTH_POLL_INTERVAL_MS / 1000
  }
}

function assertSessionAlive(loginId: string): PendingOAuthState {
  if (!pending || pending.loginId !== loginId) {
    throw new Error('没有进行中的 Cursor 登录会话')
  }
  if (pending.cancelled) {
    pending = null
    throw new Error('登录已取消')
  }
  if (Date.now() > pending.expiresAt) {
    pending = null
    throw new Error('登录会话已过期')
  }
  return pending
}

/** 阻塞到用户在浏览器完成登录、会话取消或超时。 */
export async function completeCursorOAuthLogin(loginId: string): Promise<CursorImportPayload> {
  const state = assertSessionAlive(loginId)
  console.log(`[CursorOAuth] 开始轮询: loginId=${loginId}`)

  const payload = await pollForTokens(state.uuid, state.codeVerifier, {
    maxPolls: OAUTH_MAX_POLLS,
    intervalMs: OAUTH_POLL_INTERVAL_MS,
    shouldStop: () => {
      assertSessionAlive(loginId)
    }
  })
  pending = null
  if (!payload) throw new Error('Cursor 登录轮询超时，请重试')
  console.log('[CursorOAuth] 登录成功，已获取 token')
  return payload
}

/**
 * 不传 loginId 表示取消任何进行中的会话。
 * 只打标记不清空：让正在轮询的 complete 看到标记后以「登录已取消」收尾，再由它清空。
 */
export function cancelCursorOAuthLogin(loginId?: string): void {
  if (pending && (!loginId || pending.loginId === loginId)) {
    pending.cancelled = true
    console.log(`[CursorOAuth] 登录已取消: loginId=${pending.loginId}`)
  }
}

// ---------------------------------------------------------------------------
// Session-cookie login (no browser)
// ---------------------------------------------------------------------------

export interface CursorSessionCredential {
  /** WorkOS 用户 id（`user_xxx`）；只给了 JWT 时从 sub 推。 */
  userId?: string
  /** session 类型的 JWT，既是 cookie 里那一段，也能直接当 access token 用。 */
  token: string
}

function collectCookieValuesFromJson(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCookieValuesFromJson(item, out)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const name = readString(record.name)
  const cookieValue = readString(record.value)
  if (name === SESSION_COOKIE_NAME && cookieValue) out.push(cookieValue)
  // 有些导出把 cookie 塞在 cookies 字段里
  if (record.cookies !== undefined) collectCookieValuesFromJson(record.cookies, out)
}

function parseCredential(text: string): CursorSessionCredential | null {
  const cookieMatch = text.match(SESSION_COOKIE_VALUE_PATTERN)
  if (cookieMatch) return { userId: cookieMatch[1], token: cookieMatch[2] }
  const jwtMatch = text.match(JWT_PATTERN)
  if (jwtMatch) return { userId: extractWorkosUserId(jwtMatch[0]), token: jwtMatch[0] }
  return null
}

/**
 * 从用户粘贴的任何形态里挑出会话凭据，每行一条：
 *   - `user_xxx::eyJ…` / `user_xxx%3A%3AeyJ…`（cookie 值）
 *   - `WorkosCursorSessionToken=…`，或整段 Cookie 请求头
 *   - 裸 access token（`eyJ…`）
 *   - 浏览器插件导出的 cookie JSON（数组或对象，认 name/value）
 * 解析不出的行原样放进 `unrecognized`，让界面能指出是哪一行。
 */
export function parseCursorSessionCredentials(input: string): {
  credentials: CursorSessionCredential[]
  unrecognized: string[]
} {
  const trimmed = input.trim()
  if (!trimmed) return { credentials: [], unrecognized: [] }

  let lines: string[]
  try {
    const parsed: unknown = JSON.parse(trimmed)
    const values: string[] = []
    collectCookieValuesFromJson(parsed, values)
    if (values.length === 0) throw new Error('no cookie in json')
    lines = values
  } catch {
    lines = trimmed.split(/\r?\n/)
  }

  const credentials: CursorSessionCredential[] = []
  const unrecognized: string[] = []
  const seen = new Set<string>()
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const credential = parseCredential(line)
    if (!credential) {
      unrecognized.push(line)
      continue
    }
    if (seen.has(credential.token)) continue
    seen.add(credential.token)
    credentials.push(credential)
  }
  return { credentials, unrecognized }
}

/**
 * 拿 session cookie 走一遍 Cursor 的登录握手，换回一对正式 token（含 refresh token）。
 * 等价于用户在已登录的浏览器里打开 loginDeepControl 并点确认。
 */
export async function loginWithCursorSessionCookie(
  credential: CursorSessionCredential
): Promise<CursorImportPayload> {
  const userId = credential.userId ?? extractWorkosUserId(credential.token)
  if (!userId) throw new Error('无法从凭据里解析 WorkOS 用户 ID')
  const cookie = `${SESSION_COOKIE_NAME}=${userId}%3A%3A${credential.token}`
  const { uuid, codeVerifier, codeChallenge } = createPkceChallenge()

  const callback = await cursorFetch(
    CURSOR_LOGIN_CALLBACK_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: cookie,
        Origin: 'https://cursor.com',
        Referer: `${CURSOR_LOGIN_URL}?challenge=${codeChallenge}&uuid=${uuid}&mode=login`,
        'User-Agent': CURSOR_WEB_USER_AGENT
      },
      body: JSON.stringify({ uuid, challenge: codeChallenge })
    },
    'Cursor 登录确认'
  )
  if (callback.status === 401 || callback.status === 403) {
    throw new Error('cookie 已失效或无效，请重新获取 WorkosCursorSessionToken')
  }
  if (callback.status !== 200) {
    throw new Error(`Cursor 登录确认接口返回异常状态码: ${callback.status}`)
  }

  const payload = await pollForTokens(uuid, codeVerifier, {
    maxPolls: COOKIE_HANDSHAKE_MAX_POLLS,
    intervalMs: COOKIE_HANDSHAKE_POLL_INTERVAL_MS
  })
  if (!payload) throw new Error('登录确认已通过，但没有轮询到 token，请重试')
  console.log(`[CursorOAuth] cookie 握手成功: userId=${userId}`)
  return payload
}
