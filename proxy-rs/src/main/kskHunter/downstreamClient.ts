/**
 * 下游本地化接口客户端。
 *
 * 契约（用户定义）：
 *   GET  {base}/need-account → 200 { need: boolean }
 *   POST {base}/ksk          → 200 { ok: boolean }，body { key, region }
 * 两个接口都带 header `x-api-key: <配置的 key>`。
 */

import {
  KSK_HUNTER_DOWNSTREAM_AUTH_HEADER,
  KSK_HUNTER_DOWNSTREAM_PATH,
  type HunterKskCredential
} from '../../shared/kskHunter'

export type KskHunterFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }
) => Promise<Response>

export interface DownstreamRequestOptions {
  baseUrl: string
  apiKey: string
  timeoutSeconds: number
  fetchImpl: KskHunterFetch
}

/** 日志与错误里不得出现 ksk 明文或 api key。 */
function redactDownstreamDetail(value: string): string {
  return value
    .replace(/ksk_[A-Za-z0-9_-]+/g, 'ksk_••••')
    .replace(/("?(?:key|apiKey|api_key|token)"?\s*[:=]\s*")([^"]+)(")/gi, '$1••••$3')
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

/**
 * 归一化下游 base 地址。
 * 明文 HTTP 只对 loopback 放行，避免把 ksk 通过明文发到公网。
 */
export function resolveDownstreamBase(value: string): string {
  const parsed = new URL(value.trim())
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))
  ) {
    throw new Error('下游接口仅允许 loopback HTTP；远程地址必须使用 HTTPS')
  }
  parsed.search = ''
  parsed.hash = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString().replace(/\/$/, '')
}

async function requestDownstream(
  options: DownstreamRequestOptions,
  path: string,
  init: { method: string; body?: unknown }
): Promise<unknown> {
  const base = resolveDownstreamBase(options.baseUrl)
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new Error('未配置下游 API Key')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(3, options.timeoutSeconds) * 1000)
  try {
    const response = await options.fetchImpl(`${base}${path}`, {
      method: init.method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        [KSK_HUNTER_DOWNSTREAM_AUTH_HEADER]: apiKey
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal
    })
    const text = await response.text()
    if (!response.ok) {
      const detail = redactDownstreamDetail(text.replace(/\s+/g, ' ').trim()).slice(0, 300)
      throw new Error(`下游请求失败: HTTP ${response.status}${detail ? ` · ${detail}` : ''}`)
    }
    return text ? (JSON.parse(text) as unknown) : {}
  } finally {
    clearTimeout(timer)
  }
}

function readBooleanField(payload: unknown, field: string): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  if (typeof value === 'number') return value === 1
  return false
}

/** 问下游现在要不要号。 */
export async function askDownstreamNeedsAccount(
  options: DownstreamRequestOptions
): Promise<boolean> {
  const payload = await requestDownstream(options, KSK_HUNTER_DOWNSTREAM_PATH.needAccount, {
    method: 'GET'
  })
  return readBooleanField(payload, 'need')
}

/** 把抢到的 ksk 推给下游；下游未回 ok:true 视为失败，交由重试。 */
export async function pushKskToDownstream(
  options: DownstreamRequestOptions,
  credential: HunterKskCredential
): Promise<void> {
  const payload = await requestDownstream(options, KSK_HUNTER_DOWNSTREAM_PATH.pushKsk, {
    method: 'POST',
    body: { key: credential.key, region: credential.region }
  })
  if (!readBooleanField(payload, 'ok')) {
    throw new Error('下游未确认接收（响应中 ok 不为 true）')
  }
}
