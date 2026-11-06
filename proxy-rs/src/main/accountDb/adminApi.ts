/**
 * 账号库模式下 proxy-rs 调 kiro-rs 的控制接口。数据从库里读，这里只发命令。
 *
 * 响应结构在 kiro-rs-src/src/admin/types.rs 用 Rust 定义，这里用 zod 按同样的形状校验：
 * 两边各改各的时会在第一次调用就报「响应格式不符」，而不是把 undefined 一路带进账号库。
 */
import { z, type ZodType } from 'zod'

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

/** 同 adminRequest，但响应必须符合 schema；不符合时抛 KiroRsAdminError 并带上路径与差异 */
export async function adminRequestValidated<T>(
  target: KiroRsAdminTarget,
  path: string,
  schema: ZodType<T>,
  init: { method: string; body?: unknown } = { method: 'GET' },
  fetchImpl: AdminFetch = fetch
): Promise<T> {
  const payload = await adminRequest<unknown>(target, path, init, fetchImpl)
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new KiroRsAdminError(`kiro-rs Admin 响应格式不符（${init.method} ${path}）：${issues}`)
  }
  return parsed.data
}

// ---- 响应 schema（与 admin/types.rs 的 *Response 一一对应；serde 把 Option::None 序列化为 null） ----

/** GET /store/info ↔ StoreInfoResponse */
export const StoreInfoSchema = z.object({
  enabled: z.boolean(),
  databaseId: z.string().nullish(),
  path: z.string().nullish(),
  externalRefreshCredentialId: z.number().nullish()
})
export type StoreInfo = z.infer<typeof StoreInfoSchema>

/** POST /accounts/import ↔ ImportAccountResponse */
export const ImportAccountSchema = z.object({
  credentialId: z.number(),
  created: z.boolean(),
  replaced: z.boolean()
})

/** POST /credentials/:id/ensure-fresh ↔ EnsureFreshResponse */
export const EnsureFreshSchema = z.object({ credentialVersion: z.number() })

/** POST /accounts/adopt ↔ AdoptCredentialResponse */
export const AdoptCredentialSchema = z.object({
  /** adopted：已换成外部这份；current：库里已是这份；stale：外部更旧；not_found：不在库中 */
  outcome: z.enum(['adopted', 'current', 'stale', 'not_found']),
  credentialId: z.number().nullish(),
  credentialVersion: z.number().nullish()
})
export type AdoptCredentialResult = z.infer<typeof AdoptCredentialSchema>

/** PUT /accounts/external-refresh ↔ SetExternalRefreshResponse */
export const SetExternalRefreshSchema = z.object({ credentialId: z.number().nullable() })

export function fetchStoreInfo(
  target: KiroRsAdminTarget,
  fetchImpl?: AdminFetch
): Promise<StoreInfo> {
  return adminRequestValidated(target, '/store/info', StoreInfoSchema, { method: 'GET' }, fetchImpl)
}

export function importAccount(
  target: KiroRsAdminTarget,
  body: Record<string, unknown>,
  fetchImpl?: AdminFetch
): Promise<z.infer<typeof ImportAccountSchema>> {
  return adminRequestValidated(
    target,
    '/accounts/import',
    ImportAccountSchema,
    { method: 'POST', body },
    fetchImpl
  )
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
): Promise<z.infer<typeof EnsureFreshSchema>> {
  return adminRequestValidated(
    target,
    `/credentials/${credentialId}/ensure-fresh`,
    EnsureFreshSchema,
    { method: 'POST', body: { expectedCredentialVersion, force } },
    fetchImpl
  )
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
  return adminRequestValidated(
    target,
    '/accounts/adopt',
    AdoptCredentialSchema,
    { method: 'POST', body },
    fetchImpl
  )
}

/**
 * 指定由 kiro-cli 刷新的账号（proxy 侧账号 ID，null 取消）。
 * kiro-rs 不再刷新它，只用收编进来的 token；返回生效的凭据 ID。
 */
export function setExternalRefreshAccount(
  target: KiroRsAdminTarget,
  accountUuid: string | null,
  fetchImpl?: AdminFetch
): Promise<z.infer<typeof SetExternalRefreshSchema>> {
  return adminRequestValidated(
    target,
    '/accounts/external-refresh',
    SetExternalRefreshSchema,
    { method: 'PUT', body: { accountUuid } },
    fetchImpl
  )
}
