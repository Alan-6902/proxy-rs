/**
 * 单账号推送到本机 Admin（kiro-rs /admin）的凭据映射：主进程与渲染进程共用。
 * 渲染进程用它判断按钮能否点（以及不能点的原因），主进程用同一份结果构造 POST body，
 * 避免两侧对"哪些账号能推"的判断走偏。
 */

import { isValidKiroApiKey, isValidKiroRegion } from './kiroApiKey'

/** Admin `POST /api/admin/credentials` 的 authMethod 取值。 */
export const LOCAL_ADMIN_AUTH_METHOD = {
  API_KEY: 'api_key',
  IDC: 'idc',
  SOCIAL: 'social'
} as const

export type LocalAdminAuthMethod =
  (typeof LOCAL_ADMIN_AUTH_METHOD)[keyof typeof LOCAL_ADMIN_AUTH_METHOD]

/** 新建凭据的默认优先级，与自动同步链路保持一致。 */
export const LOCAL_ADMIN_DEFAULT_PRIORITY = 0

/** 推送所需的账号凭据字段，取自 AccountCredentials 的子集。 */
export interface LocalAdminPushCandidate {
  credentialKind?: 'oauth' | 'kiro_api_key'
  kiroApiKey?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
}

/** Admin 创建凭据的请求体。 */
export interface LocalAdminCredentialPayload {
  authMethod: LocalAdminAuthMethod
  priority: number
  kiroApiKey?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  authRegion?: string
  apiRegion?: string
}

export type LocalAdminPayloadResult =
  | { ok: true; payload: LocalAdminCredentialPayload }
  | { ok: false; reason: string }

/**
 * 把账号凭据映射为 Admin 的创建请求体。
 *
 * - ksk 账号 → api_key，必须带合法区域（Admin 侧靠它决定调哪个上游端点）
 * - OAuth 账号 → clientId/Secret 齐备走 idc，都没有走 social；只有一个视为配置残缺
 * - OAuth 只传 authRegion：region 存的是 OIDC 区域，硬塞给 apiRegion 可能把 API 调用带到错误区域
 */
export function resolveLocalAdminCredentialPayload(
  candidate: LocalAdminPushCandidate
): LocalAdminPayloadResult {
  const kiroApiKey = candidate.kiroApiKey?.trim() ?? ''
  const region = candidate.region?.trim() ?? ''

  if (candidate.credentialKind === 'kiro_api_key' || kiroApiKey) {
    if (!isValidKiroApiKey(kiroApiKey)) return { ok: false, reason: '账号的 Kiro API Key 无效' }
    if (!isValidKiroRegion(region)) return { ok: false, reason: '账号缺少合法的 AWS 区域' }
    return {
      ok: true,
      payload: {
        authMethod: LOCAL_ADMIN_AUTH_METHOD.API_KEY,
        priority: LOCAL_ADMIN_DEFAULT_PRIORITY,
        kiroApiKey,
        authRegion: region,
        apiRegion: region
      }
    }
  }

  const refreshToken = candidate.refreshToken?.trim() ?? ''
  if (!refreshToken) return { ok: false, reason: '账号缺少 Refresh Token' }

  const clientId = candidate.clientId?.trim() ?? ''
  const clientSecret = candidate.clientSecret?.trim() ?? ''
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    return { ok: false, reason: 'IdC 账号需要同时提供 Client ID 和 Client Secret' }
  }

  const isIdc = Boolean(clientId)
  return {
    ok: true,
    payload: {
      authMethod: isIdc ? LOCAL_ADMIN_AUTH_METHOD.IDC : LOCAL_ADMIN_AUTH_METHOD.SOCIAL,
      priority: LOCAL_ADMIN_DEFAULT_PRIORITY,
      refreshToken,
      clientId: isIdc ? clientId : undefined,
      clientSecret: isIdc ? clientSecret : undefined,
      authRegion: isValidKiroRegion(region) ? region : undefined
    }
  }
}

/** 推送结果：created = 新建并验活，existing = Admin 已有同一凭据。 */
export interface LocalAdminPushResult {
  status: 'created' | 'existing'
  credentialId?: string
  /** 新建后余额接口是否调通；existing 时恒为 false。 */
  verified: boolean
  authMethod: LocalAdminAuthMethod
}
