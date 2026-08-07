import { createHash } from 'node:crypto'
import { isValidKiroApiKey, isValidKiroRegion } from '../../shared/kiroApiKey'
import { isPermanentKskCredentialError, type KskCredentialCleanupResult } from './credentialCleanup'

export interface LocalAdminAccount {
  kiroApiKey: string
  region: string
}

export interface LocalAdminSyncResult {
  discovered: number
  skippedExisting: number
  synced: number
  verified: number
  errors: string[]
}

export type KskAutomationFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }
) => Promise<Response>

interface RemoteCredential {
  id?: string | number
  apiKeyHash?: string
  authMethod?: string
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

function apiKeyHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function readRemoteCredentials(payload: unknown): RemoteCredential[] {
  if (typeof payload !== 'object' || payload === null) return []
  const credentials = (payload as { credentials?: unknown }).credentials
  if (!Array.isArray(credentials)) return []
  return credentials.filter(
    (item): item is RemoteCredential => typeof item === 'object' && item !== null
  )
}

async function requestJson(
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

function remoteCredentialId(credential: RemoteCredential): string | undefined {
  const value = credential.id
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

export async function cleanupInvalidLocalAdminCredentials(input: {
  baseUrl: string
  adminApiKey: string
  timeoutSeconds: number
  fetchImpl: KskAutomationFetch
}): Promise<KskCredentialCleanupResult> {
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
  const credentials = readRemoteCredentials(payload).filter(
    (credential) => credential.authMethod === 'api_key' && remoteCredentialId(credential)
  )
  const result: KskCredentialCleanupResult = {
    checked: 0,
    removed: 0,
    retainedTransient: 0,
    errors: []
  }

  for (const credential of credentials) {
    const credentialId = remoteCredentialId(credential)
    if (!credentialId) continue
    result.checked++
    try {
      await requestJson(
        input.fetchImpl,
        `${baseUrl}/credentials/${encodeURIComponent(credentialId)}/balance`,
        adminApiKey,
        timeoutMs,
        { method: 'GET' }
      )
    } catch (error) {
      if (!isPermanentKskCredentialError(error, { requireExplicitCredentialSignal: true })) {
        result.retainedTransient++
        continue
      }
      try {
        await requestJson(
          input.fetchImpl,
          `${baseUrl}/credentials/${encodeURIComponent(credentialId)}`,
          adminApiKey,
          timeoutMs,
          { method: 'DELETE' }
        )
        result.removed++
      } catch (deleteError) {
        result.errors.push(deleteError instanceof Error ? deleteError.message : String(deleteError))
      }
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
  const existingHashes = new Set(
    readRemoteCredentials(existingPayload)
      .map((credential) => credential.apiKeyHash)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  )

  const result: LocalAdminSyncResult = {
    discovered: uniqueAccounts.size,
    skippedExisting: 0,
    synced: 0,
    verified: 0,
    errors: []
  }

  for (const account of uniqueAccounts.values()) {
    const hash = apiKeyHash(account.kiroApiKey)
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
