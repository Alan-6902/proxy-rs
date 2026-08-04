import { afterEach, describe, expect, it, vi } from 'vitest'
import { callKiroApiStream, callKiroMcpWebSearch, fetchKiroModels } from '../../src/main/proxy/kiroApi'
import { buildProxyAccounts } from '../../src/main/proxy/types'

function eventStreamFrame(eventType: string, payload: unknown): Uint8Array {
  const encoder = new TextEncoder()
  const name = encoder.encode(':event-type')
  const value = encoder.encode(eventType)
  const headers = new Uint8Array(1 + name.length + 1 + 2 + value.length)
  let offset = 0
  headers[offset++] = name.length
  headers.set(name, offset)
  offset += name.length
  headers[offset++] = 7
  headers[offset++] = value.length >> 8
  headers[offset++] = value.length & 0xff
  headers.set(value, offset)
  const body = encoder.encode(JSON.stringify(payload))
  const totalLength = 12 + headers.length + body.length + 4
  const frame = new Uint8Array(totalLength)
  new DataView(frame.buffer).setUint32(0, totalLength, false)
  new DataView(frame.buffer).setUint32(4, headers.length, false)
  frame.set(headers, 12)
  frame.set(body, 12 + headers.length)
  return frame
}

function fakeResponse(frames: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame)
      controller.close()
    }
  })
  return new Response(body, { status: 200 })
}

vi.mock('../../src/main/proxy/systemProxy', async (importActual) => {
  const actual = await importActual<typeof import('../../src/main/proxy/systemProxy')>()
  return { ...actual, safeCreateProxyAgent: () => undefined }
})

const account = { id: 'stream-test', accessToken: 'fake-access-token' }
const payload = {
  conversationState: {
    currentMessage: { userInputMessage: { content: 'hello', modelId: 'gpt-5-6-terra' } },
    history: []
  }
} as any

afterEach(() => vi.unstubAllGlobals())

describe('callKiroApiStream 真实 EventStream 解析', () => {
  it('从二进制 contextUsageEvent 反推准确 inputTokens，并只完成一次', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse([
      eventStreamFrame('contextUsageEvent', { contextUsageEvent: { contextUsagePercentage: 10 } })
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const contexts: number[] = []
    const completed: number[] = []
    const errors: Error[] = []

    await callKiroApiStream(account, payload, () => undefined, usage => { completed.push(usage.inputTokens) }, error => { errors.push(error) }, undefined, 'amazonq', usage => { contexts.push(usage.inputTokens) })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(contexts).toEqual([27200])
    expect(completed).toEqual([27200])
    expect(errors).toHaveLength(0)
  })

  it('context 消费者拒绝时不重试上游且只报告一次错误', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse([
      eventStreamFrame('contextUsageEvent', { contextUsageEvent: { contextUsagePercentage: 10 } })
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const errors: Error[] = []

    await callKiroApiStream(account, payload, () => undefined, () => undefined, error => { errors.push(error) }, undefined, 'amazonq', async () => { throw new Error('consumer rejected context') })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
  })

  it('完成和错误消费者自身拒绝时，调用方仍可正常收敛', async () => {
    const completeFetch = vi.fn().mockResolvedValue(fakeResponse([
      eventStreamFrame('contextUsageEvent', { contextUsageEvent: { contextUsagePercentage: 10 } })
    ]))
    vi.stubGlobal('fetch', completeFetch)

    await expect(callKiroApiStream(
      account,
      payload,
      () => undefined,
      async () => { throw new Error('completion consumer rejected') },
      () => undefined,
      undefined,
      'amazonq'
    )).resolves.toBeUndefined()

    const errorFetch = vi.fn().mockResolvedValue(new Response('denied', { status: 401 }))
    vi.stubGlobal('fetch', errorFetch)
    await expect(callKiroApiStream(
      account,
      payload,
      () => undefined,
      () => undefined,
      async () => { throw new Error('error consumer rejected') },
      undefined,
      'amazonq'
    )).resolves.toBeUndefined()

    expect(completeFetch).toHaveBeenCalledTimes(1)
    expect(errorFetch).toHaveBeenCalledTimes(1)
  })

  it('CodeWhisperer 动态列表不支持 GPT 时不降级 Sonnet，并继续下一个端点', async () => {
    const stream = fakeResponse([eventStreamFrame('assistantResponseEvent', { assistantResponseEvent: { content: 'ok' } })])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [] }), { status: 200 }))
      .mockResolvedValueOnce(stream)
    vi.stubGlobal('fetch', fetchMock)
    const chunks: string[] = []

    await callKiroApiStream({ ...account, id: 'codewhisperer-gpt' }, payload, text => { chunks.push(text) }, () => undefined, () => undefined, undefined, 'codewhisperer')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondRequest = fetchMock.mock.calls[1][1] as RequestInit
    expect(String(secondRequest.body)).toContain('gpt-5-6-terra')
    expect(String(secondRequest.body)).not.toContain('claude-sonnet-4.5')
    expect(chunks).toEqual(['ok'])
  })

  it('鉴权错误只回调一次且 caller Promise 正常结束', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('denied', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const errors: Error[] = []

    await expect(callKiroApiStream(account, payload, () => undefined, () => undefined, error => { errors.push(error) }, undefined, 'amazonq')).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('Auth error 401')
  })

  it('OAuth 失败后切至无 ARN API key 时不携带旧 profileArn', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(fakeResponse([
        eventStreamFrame('contextUsageEvent', { contextUsageEvent: { contextUsagePercentage: 10 } })
      ]))
    vi.stubGlobal('fetch', fetchMock)
    const staleOAuthPayload = {
      ...payload,
      profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/oauth-account'
    }

    await callKiroApiStream(
      { id: 'oauth-failed', accessToken: 'oauth-token', profileArn: staleOAuthPayload.profileArn },
      staleOAuthPayload,
      () => undefined,
      () => undefined,
      () => undefined,
      undefined,
      'amazonq'
    )
    await callKiroApiStream(
      { id: 'api-key-fallback', credentialKind: 'kiro_api_key', kiroApiKey: 'ksk_test_redacted' },
      staleOAuthPayload,
      () => undefined,
      () => undefined,
      () => undefined,
      undefined,
      'amazonq'
    )

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).not.toHaveProperty('profileArn')
    expect(init.headers).toMatchObject({ tokentype: 'API_KEY' })
  })

  it('429 在同一账号按 Retry-After 退避后重试，不标记为配额错误', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(fakeResponse([eventStreamFrame('contextUsageEvent', { contextUsageEvent: { contextUsagePercentage: 10 } })]))
    vi.stubGlobal('fetch', fetchMock)
    const completed: number[] = []
    const errors: Error[] = []

    await callKiroApiStream(account, payload, () => undefined, usage => { completed.push(usage.inputTokens) }, error => { errors.push(error) }, undefined, 'amazonq')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(completed).toHaveLength(1)
    expect(errors).toHaveLength(0)
  })

  it('客户端 abort 只回调一次且不会尝试下一端点', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const errors: Error[] = []
    const pending = callKiroApiStream(account, payload, () => undefined, () => undefined, error => { errors.push(error) }, controller.signal, 'amazonq')
    await Promise.resolve()
    controller.abort(new Error('client disconnected'))

    await expect(pending).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
  })

  it('解析错误只回调一次且 caller Promise 正常结束', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse([
      eventStreamFrame('errorEvent', { error: { message: 'bad event' } })
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const errors: Error[] = []

    await expect(callKiroApiStream(account, payload, () => undefined, () => undefined, error => { errors.push(error) }, undefined, 'amazonq')).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('bad event')
  })
})

describe('Kiro MCP WebSearch', () => {
  it('使用受限区域、无 Machine ID 的认证头和 JSON-RPC 请求，并映射搜索结果', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      return new Response(JSON.stringify({
        id: request.id,
        jsonrpc: '2.0',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({ results: [{
              title: 'Result title',
              url: 'https://example.test/result',
              snippet: 'Result snippet',
              publishedDate: 1704067200000
            }] })
          }]
        }
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const results = await callKiroMcpWebSearch({
      id: 'web-search',
      accessToken: 'access-token',
      region: 'not a region',
      profileArn: ' arn:aws:codewhisperer:us-east-1:123:profile/example ',
      authMethod: 'external_idp'
    }, 'safe query')

    expect(results).toEqual([{
      type: 'web_search_result',
      title: 'Result title',
      url: 'https://example.test/result',
      encrypted_content: 'Result snippet',
      page_age: 'January 1, 2024'
    }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://q.us-east-1.amazonaws.com/mcp')
    const headers = init.headers as Record<string, string>
    expect(headers).toMatchObject({
      Authorization: 'Bearer access-token',
      TokenType: 'EXTERNAL_IDP',
      'x-amzn-kiro-profile-arn': 'arn:aws:codewhisperer:us-east-1:123:profile/example'
    })
    expect(headers).not.toHaveProperty('x-amzn-kiro-agent-mode')
    expect(Object.keys(headers).some(name => name.toLowerCase().includes('machine'))).toBe(false)
    const request = JSON.parse(String(init.body))
    expect(request).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'web_search', arguments: { query: 'safe query' } } })
    expect(request.id).toMatch(/^web_search_tooluse_[a-f0-9]{22}_\d+_[a-f0-9]{8}$/)
  })

  it('Kiro API key 在 WebSearch 和模型请求中使用 API_KEY 认证头', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.method === 'GET') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      const request = JSON.parse(String(init.body))
      return new Response(JSON.stringify({
        id: request.id,
        jsonrpc: '2.0',
        result: { content: [{ type: 'text', text: JSON.stringify({ results: [] }) }] }
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const account = {
      id: 'kiro-api-key',
      credentialKind: 'kiro_api_key' as const,
      kiroApiKey: 'ksk_test_redacted'
    }
    await callKiroMcpWebSearch(account, 'safe query')
    await fetchKiroModels(account)

    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      const headers = init.headers as Record<string, string>
      expect(headers).toMatchObject({
        Authorization: 'Bearer ksk_test_redacted',
        tokentype: 'API_KEY'
      })
      expect(headers).not.toHaveProperty('TokenType')
      expect(headers).not.toHaveProperty('cookie')
      expect(headers).not.toHaveProperty('Cookie')
    }
  })

  it('拒绝 JSON-RPC 错误和不匹配的响应，且错误不包含查询内容', async () => {
    const secretQuery = 'do-not-leak-query'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'wrong', jsonrpc: '2.0', result: { isError: true } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(callKiroMcpWebSearch(account, secretQuery)).rejects.toThrow('Web search MCP request failed')
    await expect(callKiroMcpWebSearch(account, secretQuery)).rejects.not.toThrow(secretQuery)
  })

  it('网络、408、429 和 5xx 可重试，400 立即永久失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')))
    await expect(callKiroMcpWebSearch(account, 'safe-query')).rejects.toMatchObject({ retryable: true })

    for (const status of [408, 429, 500]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })))
      await expect(callKiroMcpWebSearch(account, 'safe-query')).rejects.toMatchObject({ statusCode: status, retryable: true })
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 400 })))
    await expect(callKiroMcpWebSearch(account, 'safe-query')).rejects.toMatchObject({ statusCode: 400, retryable: false })
  })

  it('拒绝 JSON-RPC error 与错误版本', async () => {
    const malformedResponses = [
      (id: string) => ({ id, jsonrpc: '2.0', error: { code: -32000, message: 'upstream error' } }),
      (id: string) => ({ id, jsonrpc: '1.0', result: { content: [] } })
    ]
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      return new Response(JSON.stringify(malformedResponses.shift()!(request.id)), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(callKiroMcpWebSearch(account, 'safe-query')).rejects.toThrow('Web search MCP request failed')
    await expect(callKiroMcpWebSearch(account, 'safe-query')).rejects.toThrow('Web search MCP request failed')
  })

  it('仅接受首个 text 内容、严格校验结果项，并安全处理空结果和越界日期', async () => {
    const responses = [
      { result: { content: [{ type: 'image' }, { type: 'text', text: JSON.stringify({ results: [] }) }] } },
      { result: { content: [{ type: 'text', text: JSON.stringify({ results: [{}] }) }] } },
      { result: { content: [{ type: 'text', text: JSON.stringify({ results: [] }) }] } },
      {
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              results: [{
                title: 'Out of range',
                url: 'https://example.test/out-of-range',
                publishedDate: 9e15
              }]
            })
          }]
        }
      }
    ]
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ id: request.id, jsonrpc: '2.0', ...responses.shift() }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(callKiroMcpWebSearch(account, 'safe-query')).rejects.toThrow('Web search MCP request failed')
    await expect(callKiroMcpWebSearch(account, 'safe-query')).rejects.toThrow('Web search MCP request failed')
    await expect(callKiroMcpWebSearch(account, 'safe-query')).resolves.toEqual([])
    await expect(callKiroMcpWebSearch(account, 'safe-query')).resolves.toEqual([{
      type: 'web_search_result',
      title: 'Out of range',
      url: 'https://example.test/out-of-range',
      encrypted_content: '',
      page_age: null
    }])
  })

  it('拒绝 result.isError 与 HTTP 错误，且不会泄露上游响应体', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      return new Response(JSON.stringify({
        id: request.id,
        jsonrpc: '2.0',
        result: { isError: true, content: [] }
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(callKiroMcpWebSearch(account, 'safe')).rejects.toThrow('Web search MCP request failed')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream-body-must-not-leak', { status: 502 })))
    await expect(callKiroMcpWebSearch(account, 'safe')).rejects.toThrow('HTTP 502')
    await expect(callKiroMcpWebSearch(account, 'safe')).rejects.not.toThrow('upstream-body-must-not-leak')
  })

  it('客户端 abort 原样收敛，不继续发起请求', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = callKiroMcpWebSearch(account, 'abort query', controller.signal)
    await Promise.resolve()
    controller.abort(new Error('client disconnected'))

    await expect(pending).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})


describe('Kiro API key account sync signature', () => {
  it('ignores lastCheckedAt while detecting key rotation without exposing the raw key', async () => {
    const { buildAccountsSyncSignature } = await import('../../src/renderer/src/types/account')
    const base = {
      id: 'key-only-account',
      groupId: 'group-a',
      status: 'active',
      isActive: true,
      credentials: { credentialKind: 'kiro_api_key' as const, kiroApiKey: 'ksk_first_secret' }
    }
    const initial = buildAccountsSyncSignature([base])
    const checkedLater = buildAccountsSyncSignature([{ ...base, lastCheckedAt: Date.now() }])
    const rotated = buildAccountsSyncSignature([{
      ...base,
      credentials: { credentialKind: 'kiro_api_key' as const, kiroApiKey: 'ksk_rotated_secret' }
    }])

    expect(checkedLater).toBe(initial)
    expect(rotated).not.toBe(initial)
    expect(initial).not.toContain(base.credentials.kiroApiKey)
  })


  it('accepts key-only and OAuth credentials while rejecting missing credentials', async () => {
    const { hasUpstreamKiroCredential } = await import('../../src/renderer/src/types/account')

    expect(hasUpstreamKiroCredential({ credentialKind: 'kiro_api_key', kiroApiKey: 'ksk_test_redacted' })).toBe(true)
    expect(hasUpstreamKiroCredential({ accessToken: 'oauth-token' })).toBe(true)
    expect(hasUpstreamKiroCredential({})).toBe(false)
    expect(hasUpstreamKiroCredential()).toBe(false)
  })


  it('only permits OAuth credentials with a refresh token to refresh', async () => {
    const { canRefreshUpstreamCredential } = await import('../../src/renderer/src/types/account')

    expect(canRefreshUpstreamCredential({ credentialKind: 'kiro_api_key', kiroApiKey: 'ksk_test_redacted', refreshToken: 'ignored' })).toBe(false)
    expect(canRefreshUpstreamCredential({})).toBe(false)
    expect(canRefreshUpstreamCredential({ refreshToken: 'refresh-token' })).toBe(true)
  })
})

describe('主进程账号池同步', () => {
  it('跳过禁用账号，保留分组，并接纳仅 API key 的账号', () => {
    const mapped = buildProxyAccounts([
      {
        id: 'disabled',
        status: 'active',
        isActive: false,
        groupId: 'group-disabled',
        credentials: { accessToken: 'disabled-token' }
      },
      {
        id: 'oauth-group',
        status: 'active',
        groupId: 'group-a',
        credentials: { accessToken: 'oauth-token' }
      },
      {
        id: 'key-only',
        status: 'active',
        groupId: 'group-b',
        credentials: { credentialKind: 'kiro_api_key', kiroApiKey: 'ksk_test_redacted' }
      }
    ])

    expect(mapped.map(account => account.id)).toEqual(['oauth-group', 'key-only'])
    expect(mapped.find(account => account.id === 'oauth-group')?.groupId).toBe('group-a')
    expect(mapped.find(account => account.id === 'key-only')).toMatchObject({
      credentialKind: 'kiro_api_key',
      kiroApiKey: 'ksk_test_redacted',
      groupId: 'group-b'
    })
  })
})

describe('后台刷新凭据计划', () => {
  it('API key 不刷新 OAuth、不会读取残留 accessToken，且跳过用户信息', async () => {
    const { buildBackgroundRefreshPlan } = await import('../../src/main/proxy/types')
    const plan = buildBackgroundRefreshPlan({
      credentialKind: 'kiro_api_key',
      kiroApiKey: 'ksk_test_redacted',
      accessToken: 'stale-oauth-token'
    }, true)

    expect(plan).toMatchObject({
      credentialKind: 'kiro_api_key',
      kiroApiKey: 'ksk_test_redacted',
      shouldRefreshToken: false,
      shouldFetchUserInfo: false
    })
    expect(plan.accessToken).toBeUndefined()
  })

  it('OAuth 保持原有的刷新和用户信息同步计划', async () => {
    const { buildBackgroundRefreshPlan } = await import('../../src/main/proxy/types')
    const plan = buildBackgroundRefreshPlan({ accessToken: 'oauth-token' }, true)

    expect(plan).toMatchObject({
      credentialKind: 'oauth',
      accessToken: 'oauth-token',
      shouldRefreshToken: true,
      shouldFetchUserInfo: true
    })
  })

  it('IPC 形状的禁用、封禁和无凭据账号不会进入账号池', async () => {
    const { buildProxyAccounts } = await import('../../src/main/proxy/types')
    const mapped = buildProxyAccounts([
      { id: 'disabled', isActive: false, accessToken: 'token' },
      { id: 'suspended', status: 'suspended', accessToken: 'token' },
      { id: 'missing', status: 'active' },
      { id: 'key', status: 'active', groupId: 'group-key', credentialKind: 'kiro_api_key', kiroApiKey: 'ksk_test_redacted', accessToken: 'stale-oauth-token' }
    ])

    expect(mapped).toEqual([expect.objectContaining({
      id: 'key',
      groupId: 'group-key',
      credentialKind: 'kiro_api_key',
      kiroApiKey: 'ksk_test_redacted',
      accessToken: undefined
    })])
  })
})

describe('token-only 刷新生产者', () => {
  it('batchRefreshTokens 使用的资格判断会排除带残留 OAuth 字段的 API key', async () => {
    const { canRefreshUpstreamCredential } = await import('../../src/renderer/src/types/account')

    expect(canRefreshUpstreamCredential({
      credentialKind: 'kiro_api_key',
      kiroApiKey: 'ksk_test_redacted',
      refreshToken: 'stale-refresh-token'
    })).toBe(false)
    expect(canRefreshUpstreamCredential({ refreshToken: 'oauth-refresh-token' })).toBe(true)
  })

  it('主进程池计划从 API key 推断凭据类型并禁止 token 刷新和 OAuth 回写', async () => {
    const { buildBackgroundRefreshPlan } = await import('../../src/main/proxy/types')
    const plan = buildBackgroundRefreshPlan({
      kiroApiKey: 'ksk_test_redacted',
      refreshToken: 'stale-refresh-token',
      accessToken: 'stale-access-token'
    }, true)

    expect(plan).toMatchObject({
      credentialKind: 'kiro_api_key',
      kiroApiKey: 'ksk_test_redacted',
      shouldRefreshToken: false,
      shouldFetchUserInfo: false
    })
    expect(plan.accessToken).toBeUndefined()
  })
})
