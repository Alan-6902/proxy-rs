/**
 * 账号库行 ↔ 渲染层 Account 对象的映射。
 *
 * - toAccount：库行 → 账号卡片（凭据、额度、状态以库为准）
 * - toUiFields：账号卡片 → account_ui（proxy 唯一可写的部分）
 * - toImportRequest：尚未入库的账号 → kiro-rs `POST /accounts/import`
 *
 * 这里不引用渲染层类型（主进程不依赖 renderer），字段与 renderer/src/types/account.ts 对齐。
 */

import { parseUsageLimits } from '../../shared/usageLimitsParse'
import { resolveLocalAdminCredentialPayload } from '../../shared/localAdminPush'
import type { AccountDbRow, AccountUiFields } from './db'

/** 渲染层账号的宽松形状（完整定义见 renderer/src/types/account.ts） */
export type AccountLike = Record<string, unknown> & {
  id?: string
  email?: string
  nickname?: string
  groupId?: string
  tags?: string[]
  credentials?: Record<string, unknown>
  usage?: unknown
  subscription?: unknown
}

/** 存进 account_ui.metadata_json 的展示字段（凭据、额度、状态不在其中） */
const METADATA_KEYS = ['password', 'idp', 'visitorId', 'createdAt', 'isActive', 'userId'] as const
/** 存进 account_credentials.extra_json 的非秘密凭据配置 */
const EXTRA_CREDENTIAL_KEYS = ['csrfToken'] as const

/** 账号卡片上附带的账号库信息（渲染层可选读取） */
export interface AccountDbInfo {
  credentialId: number
  inPool: boolean
  enabled: boolean
  disabledReason: string | null
  credentialVersion: number
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function parseStringArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function defaultIdp(row: AccountDbRow): string {
  if (row.provider) return row.provider
  if (row.authKind === 'api_key') return 'BuilderId'
  return row.authMethod === 'idc' ? 'BuilderId' : 'Google'
}

function statusOf(row: AccountDbRow): { status: string; lastError?: string } {
  if (!row.enabled) {
    if (row.disabledReason === 'InvalidRefreshToken') {
      return { status: 'expired', lastError: 'Refresh Token 已失效，需要重新登录' }
    }
    // 禁用是号池内的调度状态：移出号池后不再用它给卡片标错误
    if (row.inPool) {
      return { status: 'error', lastError: `反代已禁用：${row.disabledReason ?? 'Manual'}` }
    }
  }
  if (row.status === 'needs_review') {
    return { status: 'error', lastError: row.lastError ?? '需要人工确认' }
  }
  if (row.usageSyncState === 'error' && row.usageError) {
    return { status: 'error', lastError: row.usageError }
  }
  return { status: 'active' }
}

export function toAccount(row: AccountDbRow): AccountLike {
  const metadata = parseJsonObject(row.metadataJson)
  const extra = parseJsonObject(row.extraJson)
  const observedAt = row.usageObservedAtMs ?? Date.now()

  let usage: unknown
  let subscription: unknown
  let upstreamEmail: string | undefined
  const raw = row.rawUsageJson ? parseJsonObject(row.rawUsageJson) : null
  const parsed = raw ? parseUsageLimits(raw, observedAt) : null
  if (parsed) {
    usage = parsed.usage
    subscription = parsed.subscription
    upstreamEmail = parsed.email
  } else {
    const legacy = parseJsonObject(row.legacyUsageJson)
    usage = legacy.usage
    subscription =
      legacy.subscription ??
      (row.subscriptionTitle ? { type: 'Free', title: row.subscriptionTitle } : undefined)
  }

  const isApiKey = row.authKind === 'api_key'
  const credentials: Record<string, unknown> = {
    ...extra,
    accessToken: row.accessToken ?? undefined,
    refreshToken: row.refreshToken ?? undefined,
    clientId: row.clientId ?? undefined,
    clientSecret: row.clientSecret ?? undefined,
    region: row.authRegion ?? row.region ?? undefined,
    apiRegion: row.apiRegion ?? undefined,
    startUrl: row.startUrl ?? undefined,
    expiresAt: row.expiresAtMs ?? undefined,
    authMethod: isApiKey ? undefined : row.authMethod === 'idc' ? 'IdC' : 'social',
    provider: row.provider ?? undefined,
    profileArn: row.profileArn ?? undefined,
    credentialKind: isApiKey ? 'kiro_api_key' : 'oauth',
    kiroApiKey: row.kiroApiKey ?? undefined,
    // 渲染层回传的 revision 只用于诊断；账号库模式下凭据由 kiro-rs 按版本条件写
    credentialRevision: String(row.credentialVersion)
  }

  const accountDb: AccountDbInfo = {
    credentialId: row.id,
    inPool: row.inPool,
    enabled: row.enabled,
    disabledReason: row.disabledReason,
    credentialVersion: row.credentialVersion
  }

  return {
    ...metadata,
    id: row.accountUuid,
    email: row.email ?? upstreamEmail ?? (metadata.email as string | undefined) ?? '',
    nickname: row.nickname ?? undefined,
    idp: (metadata.idp as string | undefined) ?? defaultIdp(row),
    userId: row.upstreamIdentity ?? (metadata.userId as string | undefined),
    profileArn: row.profileArn ?? undefined,
    credentials,
    subscription: subscription ?? { type: 'Free' },
    usage: usage ?? { current: 0, limit: 0, percentUsed: 0, lastUpdated: 0 },
    groupId: row.groupId ?? undefined,
    tags: parseStringArray(row.tagsJson),
    ...statusOf(row),
    isActive: metadata.isActive === true,
    createdAt: (metadata.createdAt as number | undefined) ?? row.createdAtMs,
    lastUsedAt: row.lastUsedAtMs ?? (metadata.lastUsedAt as number | undefined) ?? row.createdAtMs,
    lastCheckedAt: row.usageObservedAtMs ?? undefined,
    accountDb
  }
}

/** 账号库模式下发给渲染层的版本：去掉 token 明文，只留"有没有"（改造方案 §6.3） */
export function withoutSecrets(account: AccountLike): AccountLike {
  const credentials = { ...((account.credentials ?? {}) as Record<string, unknown>) }
  const hasAccessToken = Boolean(credentials.accessToken || credentials.kiroApiKey)
  const hasRefreshToken = Boolean(credentials.refreshToken)
  for (const key of ['accessToken', 'refreshToken', 'kiroApiKey', 'clientSecret', 'csrfToken']) {
    delete credentials[key]
  }
  return { ...account, credentials: { ...credentials, hasAccessToken, hasRefreshToken } }
}

export function toUiFields(account: AccountLike): AccountUiFields {
  const metadata: Record<string, unknown> = {}
  for (const key of METADATA_KEYS) {
    if (account[key] !== undefined) metadata[key] = account[key]
  }
  return {
    nickname: typeof account.nickname === 'string' && account.nickname ? account.nickname : null,
    groupId: typeof account.groupId === 'string' && account.groupId ? account.groupId : null,
    tags: Array.isArray(account.tags) ? account.tags.filter((t) => typeof t === 'string') : [],
    metadata
  }
}

/** 需要随凭据保存的非秘密配置（首选端点等） */
export function extraCredentialFields(
  credentials: Record<string, unknown>
): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  for (const key of EXTRA_CREDENTIAL_KEYS) {
    if (credentials[key] !== undefined) extra[key] = credentials[key]
  }
  return extra
}

export type ImportRequestResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: string }

/** 尚未入库的账号 → kiro-rs 导入请求（默认不入池） */
export function toImportRequest(account: AccountLike): ImportRequestResult {
  const credentials = (account.credentials ?? {}) as Record<string, unknown>
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined
  const resolved = resolveLocalAdminCredentialPayload({
    credentialKind: credentials.credentialKind as 'oauth' | 'kiro_api_key' | undefined,
    kiroApiKey: str(credentials.kiroApiKey),
    refreshToken: str(credentials.refreshToken),
    clientId: str(credentials.clientId),
    clientSecret: str(credentials.clientSecret),
    region: str(credentials.region),
    authMethod: credentials.authMethod as 'IdC' | 'social' | undefined,
    email: str(account.email)
  })
  if (!resolved.ok) return { ok: false, reason: resolved.reason }
  const payload = resolved.payload

  const extra = extraCredentialFields(credentials)
  const ui = toUiFields(account)
  const expiresAt = credentials.expiresAt
  return {
    ok: true,
    body: {
      accountUuid: account.id,
      inPool: false,
      authMethod: payload.authMethod,
      accessToken: str(credentials.accessToken),
      refreshToken: payload.refreshToken,
      expiresAtMs:
        typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : undefined,
      kiroApiKey: payload.kiroApiKey,
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      profileArn: str(credentials.profileArn) ?? str(account.profileArn),
      region: str(credentials.region),
      authRegion: payload.authRegion,
      apiRegion: str(credentials.apiRegion) ?? payload.apiRegion,
      // 卡片 email 可能是展示名（如 KSK 占位串），只传真邮箱
      email: payload.email ?? str(account.email),
      provider: str(credentials.provider),
      startUrl: str(credentials.startUrl),
      extra,
      nickname: ui.nickname ?? undefined,
      groupId: ui.groupId ?? undefined,
      tags: ui.tags,
      metadata: ui.metadata,
      // 上游账号身份：命中库中已有账号时 kiro-rs 视为重新登录，替换其凭据而不是新增一行
      upstreamIdentity: str(account.userId),
      legacyUsage:
        account.usage || account.subscription
          ? { usage: account.usage, subscription: account.subscription }
          : undefined
    }
  }
}
