// AWS API 调用层
//
// 端点/协议来源分两类：
//   1. 公开 API（identitystore / sso-admin）：target 前缀与 json 版本取自 botocore service model，
//      稳定，AWS 有向后兼容承诺。
//   2. 内部 API（SWBUPService / AmazonQDeveloperService / AWSZornControlPlaneService）：
//      botocore 里没有对应 service model，是 kiro-community/bulk-create-users 通过
//      流量分析得到的。AWS 可随时变更且无通知，调用失败要能明确报出来而不是静默吞掉。

import { fetch as undiciFetch } from 'undici'
import { signJsonRequest, type JsonProtocolVersion } from './sigv4'
import type { IdcUser, ResolvedCredentials } from './types'

export type { IdcUser }

// ============ 端点与协议常量 ============

/** identitystore：公开 API，botocore targetPrefix=AWSIdentityStore, jsonVersion=1.1, signingName=identitystore */
const IDENTITYSTORE = {
  host: (region: string) => `https://identitystore.${region}.amazonaws.com/`,
  signingName: 'identitystore',
  targetPrefix: 'AWSIdentityStore',
  jsonVersion: '1.1' as JsonProtocolVersion
}

/** sso-admin：公开 API，botocore targetPrefix=SWBExternalService, signingName=sso, endpointPrefix=sso */
const SSO_ADMIN = {
  host: (region: string) => `https://sso.${region}.amazonaws.com/`,
  signingName: 'sso',
  targetPrefix: 'SWBExternalService',
  jsonVersion: '1.1' as JsonProtocolVersion
}

/**
 * 内部 API：发密码设置邮件。
 * 主机是 identitystore，但 signing name 是 userpool —— 二者不一致，别「修正」。
 */
const USERPOOL = {
  host: (region: string) => `https://identitystore.${region}.amazonaws.com/`,
  signingName: 'userpool',
  target: 'SWBUPService.UpdatePassword',
  jsonVersion: '1.0' as JsonProtocolVersion
}

/** 内部 API：Kiro 订阅增删改。主机 codewhisperer，signing name q */
const Q_DEVELOPER = {
  host: (region: string) => `https://codewhisperer.${region}.amazonaws.com/`,
  signingName: 'q',
  targetPrefix: 'AmazonQDeveloperService',
  jsonVersion: '1.0' as JsonProtocolVersion
}

/** 内部 API：查询订阅列表 */
const USER_SUBSCRIPTIONS = {
  host: (region: string) => `https://service.user-subscriptions.${region}.amazonaws.com/`,
  signingName: 'user-subscriptions',
  targetPrefix: 'AWSZornControlPlaneService',
  jsonVersion: '1.0' as JsonProtocolVersion
}

const REQUEST_TIMEOUT_MS = 30_000
const MAX_THROTTLE_RETRIES = 5
const THROTTLE_BASE_DELAY_MS = 2_000
const THROTTLE_MAX_DELAY_MS = 60_000

// ============ 错误类型 ============

/** AWS 返回的结构化错误，保留 code 便于区分「已存在」这种可忽略的情况 */
export class AwsApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
    readonly target: string
  ) {
    super(message)
    this.name = 'AwsApiError'
  }

  /** 资源已存在 / 唯一性冲突，多数场景可当「跳过」处理 */
  get isConflict(): boolean {
    return this.code === 'ConflictException'
  }

  get isNotFound(): boolean {
    return this.code === 'ResourceNotFoundException'
  }

  get isAccessDenied(): boolean {
    return this.code === 'AccessDeniedException'
  }

  get isThrottling(): boolean {
    return (
      this.code === 'ThrottlingException' ||
      this.code === 'TooManyRequestsException' ||
      this.httpStatus === 429
    )
  }
}

/** 从 AWS JSON 错误响应里抽取 code。__type 形如 "com.amazonaws.xxx#ConflictException" */
function extractErrorCode(headers: Headers | undefined, bodyText: string): string {
  const headerCode = headers?.get('x-amzn-errortype')
  if (headerCode) return headerCode.split(':')[0].split('#').pop() || headerCode
  try {
    const parsed = JSON.parse(bodyText) as { __type?: string; code?: string; Code?: string }
    const raw = parsed.__type || parsed.code || parsed.Code || ''
    if (raw) return raw.split('#').pop() || raw
  } catch {
    /* 非 JSON 错误体，走下面的 unknown */
  }
  return 'Unknown'
}

function extractErrorMessage(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { message?: string; Message?: string }
    return parsed.message || parsed.Message || bodyText
  } catch {
    return bodyText
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ============ 通用调用 ============

async function callAws<T>(opts: {
  url: string
  service: string
  target: string
  payload: unknown
  credentials: ResolvedCredentials
  jsonVersion: JsonProtocolVersion
  /** 限流重试次数，0 表示不重试 */
  retries?: number
}): Promise<T> {
  const retries = opts.retries ?? MAX_THROTTLE_RETRIES

  for (let attempt = 0; ; attempt++) {
    // 每次重试都要重新签名：SigV4 时间戳有 15 分钟窗口，退避后旧签名可能已过期
    const signed = signJsonRequest({
      url: opts.url,
      service: opts.service,
      target: opts.target,
      payload: opts.payload,
      credentials: opts.credentials,
      jsonVersion: opts.jsonVersion
    })

    let response: Awaited<ReturnType<typeof undiciFetch>>
    try {
      response = await undiciFetch(signed.url, {
        method: 'POST',
        headers: signed.headers,
        body: signed.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (err) {
      // 网络层失败也值得重试，可能是瞬时抖动
      if (attempt < retries) {
        await sleep(Math.min(THROTTLE_BASE_DELAY_MS * 2 ** attempt, THROTTLE_MAX_DELAY_MS))
        continue
      }
      const msg = err instanceof Error ? err.message : String(err)
      throw new AwsApiError(`请求 ${opts.target} 失败：${msg}`, 'NetworkError', 0, opts.target)
    }

    const text = await response.text()

    if (response.ok) {
      if (!text) return {} as T
      try {
        return JSON.parse(text) as T
      } catch {
        throw new AwsApiError(
          `${opts.target} 返回了非 JSON 响应：${text.slice(0, 200)}`,
          'InvalidResponse',
          response.status,
          opts.target
        )
      }
    }

    const code = extractErrorCode(response.headers as unknown as Headers, text)
    const error = new AwsApiError(extractErrorMessage(text), code, response.status, opts.target)

    if (error.isThrottling && attempt < retries) {
      await sleep(Math.min(THROTTLE_BASE_DELAY_MS * 2 ** attempt, THROTTLE_MAX_DELAY_MS))
      continue
    }
    throw error
  }
}

// ============ Identity Center 实例 ============

export interface SsoInstance {
  identityStoreId: string
  instanceArn: string
}

/** 取第一个 Identity Center 实例。一个账号一个 region 只能有一个 */
export async function listInstances(credentials: ResolvedCredentials): Promise<SsoInstance> {
  const resp = await callAws<{ Instances?: { IdentityStoreId: string; InstanceArn: string }[] }>({
    url: SSO_ADMIN.host(credentials.region),
    service: SSO_ADMIN.signingName,
    target: `${SSO_ADMIN.targetPrefix}.ListInstances`,
    payload: {},
    credentials,
    jsonVersion: SSO_ADMIN.jsonVersion
  })
  const first = resp.Instances?.[0]
  if (!first) {
    throw new AwsApiError(
      `region ${credentials.region} 下未找到 Identity Center 实例，请确认已启用且 region 选对`,
      'NoInstance',
      200,
      'ListInstances'
    )
  }
  return { identityStoreId: first.IdentityStoreId, instanceArn: first.InstanceArn }
}

// ============ 用户 CRUD ============

export async function createUser(
  credentials: ResolvedCredentials,
  identityStoreId: string,
  user: {
    username: string
    givenName: string
    familyName: string
    displayName: string
    email: string
  }
): Promise<string> {
  const resp = await callAws<{ UserId: string }>({
    url: IDENTITYSTORE.host(credentials.region),
    service: IDENTITYSTORE.signingName,
    target: `${IDENTITYSTORE.targetPrefix}.CreateUser`,
    payload: {
      IdentityStoreId: identityStoreId,
      UserName: user.username,
      Name: {
        GivenName: user.givenName || user.username,
        FamilyName: user.familyName || user.username
      },
      DisplayName: user.displayName || user.username,
      Emails: [{ Value: user.email, Type: 'work', Primary: true }]
    },
    credentials,
    jsonVersion: IDENTITYSTORE.jsonVersion
  })
  return resp.UserId
}

export async function deleteUser(
  credentials: ResolvedCredentials,
  identityStoreId: string,
  userId: string
): Promise<void> {
  await callAws({
    url: IDENTITYSTORE.host(credentials.region),
    service: IDENTITYSTORE.signingName,
    target: `${IDENTITYSTORE.targetPrefix}.DeleteUser`,
    payload: { IdentityStoreId: identityStoreId, UserId: userId },
    credentials,
    jsonVersion: IDENTITYSTORE.jsonVersion
  })
}

/** 分页列出全部用户 */
export async function listAllUsers(
  credentials: ResolvedCredentials,
  identityStoreId: string
): Promise<IdcUser[]> {
  const users: IdcUser[] = []
  let nextToken: string | undefined

  do {
    const resp = await callAws<{
      Users?: {
        UserId: string
        UserName?: string
        DisplayName?: string
        Emails?: { Value?: string; Primary?: boolean }[]
      }[]
      NextToken?: string
    }>({
      url: IDENTITYSTORE.host(credentials.region),
      service: IDENTITYSTORE.signingName,
      target: `${IDENTITYSTORE.targetPrefix}.ListUsers`,
      payload: {
        IdentityStoreId: identityStoreId,
        MaxResults: 100,
        ...(nextToken ? { NextToken: nextToken } : {})
      },
      credentials,
      jsonVersion: IDENTITYSTORE.jsonVersion
    })

    for (const u of resp.Users ?? []) {
      const primaryEmail = u.Emails?.find((e) => e.Primary)?.Value || u.Emails?.[0]?.Value || ''
      users.push({
        userId: u.UserId,
        username: u.UserName || '',
        email: primaryEmail,
        displayName: u.DisplayName || ''
      })
    }
    nextToken = resp.NextToken
  } while (nextToken)

  return users
}

// ============ 密码设置邮件（内部 API） ============

/**
 * 触发 AWS 给用户发密码设置邮件。链接 1 小时过期，过期后重发即可。
 * 内部 API：SWBUPService.UpdatePassword。
 */
export async function sendPasswordResetEmail(
  credentials: ResolvedCredentials,
  userId: string
): Promise<void> {
  await callAws({
    url: USERPOOL.host(credentials.region),
    service: USERPOOL.signingName,
    target: USERPOOL.target,
    payload: { UserId: userId, PasswordMode: 'EMAIL' },
    credentials,
    jsonVersion: USERPOOL.jsonVersion
  })
}

// ============ Kiro 订阅（内部 API） ============

export type PrincipalType = 'USER' | 'GROUP'

/** 挂档位。已订阅时抛 ConflictException */
export async function createAssignment(
  credentials: ResolvedCredentials,
  principalId: string,
  subscriptionType: string,
  principalType: PrincipalType = 'USER'
): Promise<void> {
  await callAws({
    url: Q_DEVELOPER.host(credentials.region),
    service: Q_DEVELOPER.signingName,
    target: `${Q_DEVELOPER.targetPrefix}.CreateAssignment`,
    payload: { principalId, principalType, subscriptionType },
    credentials,
    jsonVersion: Q_DEVELOPER.jsonVersion
  })
}

/** 原地改档位，无需先取消再订阅 */
export async function updateAssignment(
  credentials: ResolvedCredentials,
  principalId: string,
  subscriptionType: string,
  principalType: PrincipalType = 'USER'
): Promise<void> {
  await callAws({
    url: Q_DEVELOPER.host(credentials.region),
    service: Q_DEVELOPER.signingName,
    target: `${Q_DEVELOPER.targetPrefix}.UpdateAssignment`,
    payload: { principalId, principalType, subscriptionType },
    credentials,
    jsonVersion: Q_DEVELOPER.jsonVersion
  })
}

/** 取消订阅，释放席位费用 */
export async function deleteAssignment(
  credentials: ResolvedCredentials,
  principalId: string,
  principalType: PrincipalType = 'USER'
): Promise<void> {
  await callAws({
    url: Q_DEVELOPER.host(credentials.region),
    service: Q_DEVELOPER.signingName,
    target: `${Q_DEVELOPER.targetPrefix}.DeleteAssignment`,
    payload: { principalId, principalType },
    credentials,
    jsonVersion: Q_DEVELOPER.jsonVersion
  })
}

export interface RawSubscription {
  userId: string
  subscriptionType: string
  status: string
  activationDate: string
}

/** 查询全部用户订阅。内部 API：AWSZornControlPlaneService.ListUserSubscriptions */
export async function listUserSubscriptions(
  credentials: ResolvedCredentials,
  instanceArn: string
): Promise<RawSubscription[]> {
  const results: RawSubscription[] = []
  let nextToken: string | undefined

  do {
    const resp = await callAws<{
      subscriptions?: {
        principal?: { user?: string }
        type?: { amazonQ?: string }
        status?: string
        activationDate?: string
      }[]
      nextToken?: string
    }>({
      url: USER_SUBSCRIPTIONS.host(credentials.region),
      service: USER_SUBSCRIPTIONS.signingName,
      target: `${USER_SUBSCRIPTIONS.targetPrefix}.ListUserSubscriptions`,
      payload: {
        instanceArn,
        maxResults: 100,
        subscriptionRegion: credentials.region,
        ...(nextToken ? { nextToken } : {})
      },
      credentials,
      jsonVersion: USER_SUBSCRIPTIONS.jsonVersion
    })

    for (const sub of resp.subscriptions ?? []) {
      const userId = sub.principal?.user
      if (!userId) continue
      results.push({
        userId,
        subscriptionType: sub.type?.amazonQ || '',
        status: sub.status || '',
        activationDate: sub.activationDate || ''
      })
    }
    nextToken = resp.nextToken
  } while (nextToken)

  return results
}
