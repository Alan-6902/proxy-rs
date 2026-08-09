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
  /** 账号登记的认证方式；决定 Admin 该用 social 还是 OIDC 端点刷这个 refreshToken。 */
  authMethod?: 'IdC' | 'social'
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
 * - OAuth 账号 → 以账号自己的 authMethod 为准（与本地 refreshTokenByMethod 同一判据）：
 *   social 直接走 social；IdC 必须齐备 clientId/Secret，缺一半就拒推而不是降级成 social。
 *   authMethod 缺失时（SSO Token 导入等老路径不写）按 clientId/Secret 存在性推断。
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

  // 账号自己声明的 authMethod 是权威来源：本地刷新链路（refreshTokenByMethod）就按它选
  // social / OIDC 端点，推给 Admin 必须用同一判据，否则 Admin 会拿错端点去刷这个 token。
  if (candidate.authMethod === 'social') {
    return {
      ok: true,
      payload: {
        authMethod: LOCAL_ADMIN_AUTH_METHOD.SOCIAL,
        priority: LOCAL_ADMIN_DEFAULT_PRIORITY,
        refreshToken,
        authRegion: isValidKiroRegion(region) ? region : undefined
      }
    }
  }

  // authMethod 缺失时退回按 clientId/Secret 存在性推断：SSO Token 导入等老路径不写该字段。
  const isIdc = candidate.authMethod === 'IdC' || Boolean(clientId) || Boolean(clientSecret)
  if (isIdc && !(clientId && clientSecret)) {
    return { ok: false, reason: 'IdC 账号需要同时提供 Client ID 和 Client Secret' }
  }

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

/**
 * 推送后发消息验活的结论。与 KSK_PROBE_VERDICT 同口径，独立定义是因为
 * 这个类型要跨 preload 给渲染进程用，不该把主进程的清理模块拖进渲染层。
 */
export const LOCAL_ADMIN_PROBE_VERDICT = {
  ALIVE: 'alive',
  PERMANENTLY_INVALID: 'permanently_invalid',
  TRANSIENT: 'transient',
  /** 没跑验活：Admin 已有同一凭据，或调用方没提供验活能力。 */
  SKIPPED: 'skipped'
} as const

export type LocalAdminProbeVerdict =
  (typeof LOCAL_ADMIN_PROBE_VERDICT)[keyof typeof LOCAL_ADMIN_PROBE_VERDICT]

/**
 * 推送结果。
 *
 * created 是硬承诺：凭据已进 Admin 且验证过能出活。验不过的一律不返回结果，
 * 而是删掉凭据并抛错——「推过去就一定能用」比「推进去了但可能不能用」有用得多。
 */
export interface LocalAdminPushResult {
  status: 'created' | 'existing'
  credentialId?: string
  /**
   * 新建后余额接口是否调通。existing 时恒为 false。
   *
   * created 时通常为 true，但有一个例外：上游拒绝该身份查额度（Enterprise 号实测会吃
   * 403 `User is not authorized to make this call.`）时余额门禁被放过，此时为 false，
   * 凭据的可用性由发消息验活背书。
   */
  verified: boolean
  authMethod: LocalAdminAuthMethod
  /**
   * 发消息验活的结论。created 时为 alive（未注入探针则为 skipped，表示只过了余额门禁），
   * existing 时为 skipped。验不过的不会返回结果，所以这里永远不会是失败类结论。
   */
  probeVerdict: LocalAdminProbeVerdict
}
