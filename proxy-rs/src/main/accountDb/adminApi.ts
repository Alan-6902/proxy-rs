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

export interface AdoptCredentialResult {
  /** adopted：已换成外部这份；current：库里已是这份；stale：外部更旧；not_found：不在库中 */
  outcome: 'adopted' | 'current' | 'stale' | 'not_found'
  credentialId?: number | null
  credentialVersion?: number | null
}

/** 让 kiro-rs 收编 kiro-cli 自行刷新得到的凭据（按上游身份认账号） */
export function adoptCredential(
  target: KiroRsAdminTarget,
  body: {
    accountUuid?: string
    authMethod: 'social' | 'idc'
    accessToken: string
    refreshToken: string
    expiresAtMs?: number
    clientId?: string
    clientSecret?: string
    profileArn?: string
    region?: string
  },
  fetchImpl?: AdminFetch
): Promise<AdoptCredentialResult> {
  return adminRequest(target, '/accounts/adopt', { method: 'POST', body }, fetchImpl)
}

/**
 * 指定由 kiro-cli 刷新的账号（proxy 侧账号 ID，null 取消）。
 * kiro-rs 不再刷新它，只用收编进来的 token；返回生效的凭据 ID。
 */
export function setExternalRefreshAccount(
  target: KiroRsAdminTarget,
  accountUuid: string | null,
  fetchImpl?: AdminFetch
): Promise<{ credentialId: number | null }> {
  return adminRequest(
    target,
    '/accounts/external-refresh',
    { method: 'PUT', body: { accountUuid } },
    fetchImpl
  )
}
