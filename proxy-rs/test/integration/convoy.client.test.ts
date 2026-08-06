// 上游客户端契约：请求头、超时、错误码映射、响应解析

import { describe, expect, it } from 'vitest'
import {
  CONVOY_ERROR,
  ConvoyClientError,
  ConvoyCredentialClient,
  parseCredentialsResponse,
  parseSummary,
  type ConvoyFetch
} from '../../src/main/convoy/client'

const BASE_URL = 'http://kiro.example.com/api/user'
const CONVOY_KEY = 'convoy-login-key-1234'

interface StubResponse {
  status?: number
  body?: unknown
  bodyText?: string
  headers?: Record<string, string>
}

function stubFetch(responses: StubResponse | StubResponse[]): {
  fetchImpl: ConvoyFetch
  calls: { url: string; headers: Record<string, string>; method: string }[]
} {
  const queue = Array.isArray(responses) ? [...responses] : [responses]
  const calls: { url: string; headers: Record<string, string>; method: string }[] = []
  const fetchImpl: ConvoyFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, method: init.method })
    const next = queue.length > 1 ? queue.shift()! : queue[0]
    const status = next.status ?? 200
    const text = next.bodyText ?? JSON.stringify(next.body ?? {})
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => next.headers?.[name.toLowerCase()] ?? null },
      text: async () => text
    }
  }
  return { fetchImpl, calls }
}

function makeClient(fetchImpl: ConvoyFetch, overrides: Partial<{ allowInsecureHttp: boolean; baseUrl: string; convoyKey: string }> = {}): ConvoyCredentialClient {
  return new ConvoyCredentialClient({
    baseUrl: overrides.baseUrl ?? BASE_URL,
    convoyKey: overrides.convoyKey ?? CONVOY_KEY,
    requestTimeoutSeconds: 15,
    allowInsecureHttp: overrides.allowInsecureHttp ?? true,
    fetchImpl
  })
}

describe('请求构造', () => {
  it('以 x-api-key 发送登录 Key 并请求 JSON', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { onBoard: true, credentialSummary: [] } })
    await makeClient(fetchImpl).fetchSummary()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE_URL}/me/auto-ride`)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].headers['x-api-key']).toBe(CONVOY_KEY)
    expect(calls[0].headers.Accept).toBe('application/json')
    // 登录 Key 不得出现在 Authorization 等其它位置
    expect(calls[0].headers.Authorization).toBeUndefined()
  })

  it('完整凭证接口走独立路径', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { credentials: [] } })
    await makeClient(fetchImpl).fetchCredentials()
    expect(calls[0].url).toBe(`${BASE_URL}/me/auto-ride/credentials`)
  })

  it('默认拒绝向明文 HTTP 发送登录 Key', async () => {
    const { fetchImpl, calls } = stubFetch({ body: {} })
    await expect(
      makeClient(fetchImpl, { allowInsecureHttp: false }).fetchSummary()
    ).rejects.toMatchObject({ kind: CONVOY_ERROR.CONFIG })
    // 门禁必须在发请求之前拦下
    expect(calls).toHaveLength(0)
  })

  it('未配置登录 Key 时不发请求', async () => {
    const { fetchImpl, calls } = stubFetch({ body: {} })
    await expect(makeClient(fetchImpl, { convoyKey: '  ' }).fetchSummary()).rejects.toMatchObject({
      kind: CONVOY_ERROR.CONFIG
    })
    expect(calls).toHaveLength(0)
  })

  it('超时映射为可重试错误', async () => {
    const client = new ConvoyCredentialClient({
      baseUrl: BASE_URL,
      convoyKey: CONVOY_KEY,
      requestTimeoutSeconds: 1,
      allowInsecureHttp: true,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    })
    const error = await client.fetchSummary().catch((err) => err)
    expect(error).toBeInstanceOf(ConvoyClientError)
    expect(error.kind).toBe(CONVOY_ERROR.TRANSIENT)
    expect(error.message).toContain('超时')
  })
})

describe('HTTP 错误码映射', () => {
  const cases: { status: number; body?: unknown; expected: string }[] = [
    { status: 401, expected: CONVOY_ERROR.UNAUTHORIZED },
    { status: 403, expected: CONVOY_ERROR.FORBIDDEN },
    { status: 429, expected: CONVOY_ERROR.RATE_LIMITED },
    { status: 500, expected: CONVOY_ERROR.TRANSIENT },
    { status: 503, expected: CONVOY_ERROR.TRANSIENT },
    { status: 400, expected: CONVOY_ERROR.MALFORMED }
  ]

  for (const item of cases) {
    it(`HTTP ${item.status} → ${item.expected}`, async () => {
      const { fetchImpl } = stubFetch({ status: item.status, body: item.body ?? {} })
      await expect(makeClient(fetchImpl).fetchSummary()).rejects.toMatchObject({
        kind: item.expected,
        statusCode: item.status
      })
    })
  }

  it('404 + not_on_board 映射为未上车', async () => {
    const { fetchImpl } = stubFetch({
      status: 404,
      body: { error: { code: 'not_on_board', message: '未上车' } }
    })
    await expect(makeClient(fetchImpl).fetchSummary()).rejects.toMatchObject({
      kind: CONVOY_ERROR.NOT_ON_BOARD
    })
  })

  it('普通 404 不当成未上车', async () => {
    const { fetchImpl } = stubFetch({ status: 404, body: { error: { message: 'no route' } } })
    await expect(makeClient(fetchImpl).fetchSummary()).rejects.toMatchObject({
      kind: CONVOY_ERROR.MALFORMED
    })
  })

  it('429 的 Retry-After 秒数生效，且不低于兜底 60s', async () => {
    const { fetchImpl } = stubFetch({ status: 429, body: {}, headers: { 'retry-after': '120' } })
    const error = await makeClient(fetchImpl).fetchSummary().catch((err) => err)
    expect(error.retryAfterMs).toBe(120_000)

    const { fetchImpl: shortFetch } = stubFetch({
      status: 429,
      body: {},
      headers: { 'retry-after': '5' }
    })
    const shortError = await makeClient(shortFetch).fetchSummary().catch((err) => err)
    expect(shortError.retryAfterMs).toBe(60_000)
  })

  it('429 未给 Retry-After 时至少等 60s', async () => {
    const { fetchImpl } = stubFetch({ status: 429, body: {} })
    const error = await makeClient(fetchImpl).fetchSummary().catch((err) => err)
    expect(error.retryAfterMs).toBe(60_000)
  })

  it('错误信息只带上游 message，不回传完整 body', async () => {
    const { fetchImpl } = stubFetch({
      status: 401,
      body: { error: { message: 'key expired' }, debugKey: 'super-secret-value' }
    })
    const error = await makeClient(fetchImpl).fetchSummary().catch((err) => err)
    expect(error.message).toContain('key expired')
    expect(error.message).not.toContain('super-secret-value')
  })

  it('非 JSON 与空 Body 被拒绝', async () => {
    const { fetchImpl: htmlFetch } = stubFetch({ bodyText: '<html>oops</html>' })
    await expect(makeClient(htmlFetch).fetchSummary()).rejects.toMatchObject({
      kind: CONVOY_ERROR.MALFORMED
    })

    const { fetchImpl: emptyFetch } = stubFetch({ bodyText: '' })
    await expect(makeClient(emptyFetch).fetchSummary()).rejects.toMatchObject({
      kind: CONVOY_ERROR.MALFORMED
    })
  })

  it('顶层不是对象的 JSON 被拒绝', async () => {
    const { fetchImpl } = stubFetch({ bodyText: '[1,2,3]' })
    await expect(makeClient(fetchImpl).fetchSummary()).rejects.toMatchObject({
      kind: CONVOY_ERROR.MALFORMED
    })
  })
})

describe('概览解析', () => {
  it('提取活跃凭证 ID 与车费', () => {
    const summary = parseSummary({
      onBoard: true,
      autoConvoyId: 42,
      autoConvoyTitle: '示例自动车',
      convoy: { fare: 2.0 },
      credentialSummary: [
        { credentialId: 9, status: 'active' },
        { credentialId: 10, status: 'expired' },
        { credentialId: 11, status: 'active' }
      ]
    })

    expect(summary.onBoard).toBe(true)
    expect(summary.autoConvoyId).toBe('42')
    expect(summary.autoConvoyTitle).toBe('示例自动车')
    expect(summary.farePerCredentialCents).toBe(200)
    expect(summary.credentialSummary.filter((c) => c.status === 'active').map((c) => c.credentialId))
      .toEqual(['9', '11'])
  })

  it('onBoard 缺失时按未上车处理，不触发计费接口', () => {
    expect(parseSummary({ credentialSummary: [] }).onBoard).toBe(false)
    expect(parseSummary({ onBoard: 'yes', credentialSummary: [] }).onBoard).toBe(false)
  })

  it('credentialSummary 类型异常时拒绝', () => {
    expect(() => parseSummary({ onBoard: true, credentialSummary: 'nope' })).toThrow(
      ConvoyClientError
    )
  })

  it('缺 credentialId 的摘要项被跳过而非整体失败', () => {
    const summary = parseSummary({
      onBoard: true,
      credentialSummary: [{ status: 'active' }, { credentialId: '7', status: 'active' }, 'junk']
    })
    expect(summary.credentialSummary.map((c) => c.credentialId)).toEqual(['7'])
  })

  it('车费未给时为 undefined，不当成 0 元', () => {
    expect(parseSummary({ onBoard: true, credentialSummary: [] }).farePerCredentialCents)
      .toBeUndefined()
  })
})

describe('完整凭证响应解析', () => {
  const validResponse = {
    autoConvoyId: 42,
    autoConvoyTitle: '示例自动车',
    credentials: [
      {
        credentialId: 9,
        status: 'active',
        newlyCharged: true,
        charged: 2.0,
        aliveSecs: 120,
        addedAt: '2026-08-06T12:00:00+08:00',
        credential: { type: 'api_key', apiKey: 'ksk_abcdef123456' }
      }
    ],
    newlyChargedCount: 1,
    totalCharged: 2.0,
    balanceAfter: 97.0,
    insufficientCount: 0
  }

  it('权威计费字段全部换成分', () => {
    const parsed = parseCredentialsResponse(validResponse)
    expect(parsed.newlyChargedCount).toBe(1)
    expect(parsed.totalChargedCents).toBe(200)
    expect(parsed.balanceAfterCents).toBe(9700)
    expect(parsed.insufficientCount).toBe(0)
    expect(parsed.credentials[0].chargedCents).toBe(200)
    expect(parsed.credentials[0].credentialId).toBe('9')
  })

  it('credential=null 保留条目但明文为空', () => {
    const parsed = parseCredentialsResponse({
      ...validResponse,
      credentials: [{ credentialId: '9', status: 'expired', newlyCharged: false, charged: 0, credential: null }]
    })
    expect(parsed.credentials[0].credential).toBeNull()
  })

  it('缺 credentialId 时整体拒绝', () => {
    expect(() =>
      parseCredentialsResponse({
        ...validResponse,
        credentials: [{ status: 'active', newlyCharged: false, charged: 0, credential: {} }]
      })
    ).toThrow(ConvoyClientError)
  })

  it('同一响应内 credentialId 重复时整体拒绝', () => {
    expect(() =>
      parseCredentialsResponse({
        ...validResponse,
        credentials: [
          { credentialId: '9', status: 'active', newlyCharged: false, charged: 0, credential: {} },
          { credentialId: '9', status: 'active', newlyCharged: false, charged: 0, credential: {} }
        ]
      })
    ).toThrow(/重复/)
  })

  it('credentials 不是数组时拒绝', () => {
    expect(() => parseCredentialsResponse({ credentials: 'nope' })).toThrow(ConvoyClientError)
  })

  it('部分发放响应仍能提取已发放凭证', () => {
    const parsed = parseCredentialsResponse({
      credentials: [
        { credentialId: '1', status: 'active', newlyCharged: true, charged: 2, credential: { type: 'api_key', apiKey: 'ksk_a1' } },
        { credentialId: '2', status: 'active', newlyCharged: false, charged: 0, credential: null }
      ],
      newlyChargedCount: 1,
      totalCharged: 2,
      balanceAfter: 0,
      insufficientCount: 1
    })
    expect(parsed.credentials.filter((c) => c.credential !== null)).toHaveLength(1)
    expect(parsed.insufficientCount).toBe(1)
    expect(parsed.balanceAfterCents).toBe(0)
  })

  it('balanceAfter 缺失时为 undefined，不误报余额 0', () => {
    const parsed = parseCredentialsResponse({ credentials: [] })
    expect(parsed.balanceAfterCents).toBeUndefined()
  })

  it('合法空列表被接受', () => {
    const parsed = parseCredentialsResponse({ credentials: [], newlyChargedCount: 0, totalCharged: 0 })
    expect(parsed.credentials).toEqual([])
  })
})
