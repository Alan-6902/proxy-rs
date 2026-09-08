/**
 * Cursor 浏览器登录（PKCE）。
 *
 * 流程与 Cursor 客户端一致：本地生成 code_verifier / challenge / uuid，把用户送到
 * cursor.com/loginDeepControl；用户在浏览器里登录后，客户端拿 uuid + verifier 轮询
 * api2.cursor.sh/auth/poll，直到拿到 token。同一时刻只保留一个登录会话。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { CursorOAuthStartResult } from '../../shared/cursorAccounts'
import type { CursorImportPayload } from './accountStore'
import { cursorFetch } from './cursorApi'

const CURSOR_LOGIN_URL = 'https://cursor.com/loginDeepControl'
const CURSOR_POLL_ENDPOINT = 'https://api2.cursor.sh/auth/poll'
const OAUTH_POLL_INTERVAL_MS = 2_000
const OAUTH_MAX_POLLS = 150
const OAUTH_SESSION_TTL_MS = 300_000

interface PendingOAuthState {
  loginId: string
  uuid: string
  codeVerifier: string
  expiresAt: number
  cancelled: boolean
}

let pending: PendingOAuthState | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function startCursorOAuthLogin(): CursorOAuthStartResult {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const uuid = randomUUID()
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

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 阻塞到用户在浏览器完成登录、会话取消或超时。 */
export async function completeCursorOAuthLogin(loginId: string): Promise<CursorImportPayload> {
  const state = assertSessionAlive(loginId)
  const pollUrl = `${CURSOR_POLL_ENDPOINT}?uuid=${encodeURIComponent(state.uuid)}&verifier=${encodeURIComponent(state.codeVerifier)}`
  console.log(`[CursorOAuth] 开始轮询: loginId=${loginId}`)

  for (let attempt = 0; attempt < OAUTH_MAX_POLLS; attempt += 1) {
    assertSessionAlive(loginId)

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
      await sleep(OAUTH_POLL_INTERVAL_MS * 2)
      continue
    }

    if (response.status === 404) {
      await sleep(OAUTH_POLL_INTERVAL_MS)
      continue
    }
    if (response.status !== 200) {
      console.warn(`[CursorOAuth] 轮询返回异常状态码: ${response.status}`)
      await sleep(OAUTH_POLL_INTERVAL_MS)
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
      await sleep(OAUTH_POLL_INTERVAL_MS)
      continue
    }

    pending = null
    console.log('[CursorOAuth] 登录成功，已获取 token')
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

  pending = null
  throw new Error('Cursor 登录轮询超时，请重试')
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
