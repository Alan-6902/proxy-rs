/**
 * 账号库模式下 proxy-rs 调 kiro-rs 的控制接口。数据从库里读，这里只发命令。
 */

export interface KiroRsAdminTarget {
  /** 形如 http://127.0.0.1:12888/api/admin */
  baseUrl: string
  adminApiKey: string
  timeoutMs: number
}

export type AdminFetch = typeof fetch

export class KiroRsAdminError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

export async function adminRequest<T>(
  target: KiroRsAdminTarget,
  path: string,
  init: { method: string; body?: unknown } = { method: 'GET' },
  fetchImpl: AdminFetch = fetch
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), target.timeoutMs)
  try {
    const response = await fetchImpl(`${target.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': target.adminApiKey
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal
    })
    const text = await response.text()
    const payload = text ? (JSON.parse(text) as unknown) : null
    if (!response.ok) {
      const message =
        (payload as { error?: { message?: string } } | null)?.error?.message ??
        `HTTP ${response.status}`
      throw new KiroRsAdminError(message, response.status)
    }
    return payload as T
  } catch (error) {
    if (error instanceof KiroRsAdminError) throw error
    throw new KiroRsAdminError(
      `kiro-rs Admin 不可达：${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    clearTimeout(timer)
  }
}

export interface StoreInfo {
  enabled: boolean
  databaseId?: string | null
  path?: string | null
}

export function fetchStoreInfo(
  target: KiroRsAdminTarget,
  fetchImpl?: AdminFetch
): Promise<StoreInfo> {
  return adminRequest<StoreInfo>(target, '/store/info', { method: 'GET' }, fetchImpl)
}

export function importAccount(
  target: KiroRsAdminTarget,
  body: Record<string, unknown>,
  fetchImpl?: AdminFetch
): Promise<{ credentialId: number; created: boolean }> {
  return adminRequest(target, '/accounts/import', { method: 'POST', body }, fetchImpl)
}

export async function purgeAccount(
  target: KiroRsAdminTarget,
  credentialId: number,
  fetchImpl?: AdminFetch
): Promise<void> {
  await adminRequest(
    target,
    `/credentials/${credentialId}?purge=true`,
    { method: 'DELETE' },
    fetchImpl
  )
}

export async function setInPool(
  target: KiroRsAdminTarget,
  credentialId: number,
  inPool: boolean,
  fetchImpl?: AdminFetch
): Promise<void> {
  await adminRequest(
    target,
    `/credentials/${credentialId}/pool`,
    { method: 'POST', body: { inPool } },
    fetchImpl
  )
}

export async function setProxy(
  target: KiroRsAdminTarget,
  credentialId: number,
  proxyUrl: string | null,
  fetchImpl?: AdminFetch
): Promise<void> {
  await adminRequest(
    target,
    `/credentials/${credentialId}/proxy`,
    { method: 'POST', body: { proxyUrl } },
    fetchImpl
  )
}

export function ensureFresh(
  target: KiroRsAdminTarget,
  credentialId: number,
  expectedCredentialVersion?: number,
  force = false,
  fetchImpl?: AdminFetch
): Promise<{ credentialVersion: number }> {
  return adminRequest(
    target,
    `/credentials/${credentialId}/ensure-fresh`,
    { method: 'POST', body: { expectedCredentialVersion, force } },
    fetchImpl
  )
}
