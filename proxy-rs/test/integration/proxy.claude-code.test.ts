import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeCodeStreamBuffer } from '../../src/main/proxy/claudeCodeStreamBuffer'

const { streamMock, requestMock, webSearchMock } = vi.hoisted(() => ({
  streamMock: vi.fn(),
  requestMock: vi.fn(),
  webSearchMock: vi.fn()
}))

vi.mock('../../src/main/proxy/kiroApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/proxy/kiroApi')>()),
  callKiroApi: requestMock,
  callKiroApiStream: streamMock,
  callKiroMcpWebSearch: webSearchMock
}))

import { ProxyServer } from '../../src/main/proxy/proxyServer'
import { KiroMcpWebSearchError, mapModelId } from '../../src/main/proxy/kiroApi'
import { getModelContextLength, setModelContextWindow } from '../../src/main/proxy/tokenCounter'
import { makeApiKey } from '../helpers/proxyFixtures'

const LOOPBACK_HOST = '127.0.0.1'
const API_KEY = 'sk_test_claude_code'
const USAGE = {
  inputTokens: 27,
  outputTokens: 3,
  credits: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0
}

describe('ProxyServer Claude Code 兼容', () => {
  let server: ProxyServer

  beforeEach(async () => {
    streamMock.mockReset()
    requestMock.mockReset()
    webSearchMock.mockReset()
    server = new ProxyServer({
      host: LOOPBACK_HOST,
      port: 0,
      logRequests: false,
      apiKeys: [makeApiKey({ key: API_KEY })]
    })
    server.getAccountPool().addAccount({ id: 'account-1', accessToken: 'fake-access-token' })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  async function request(
    path: string,
    body: Record<string, unknown>,
    key: string = API_KEY
  ): Promise<Response> {
    return fetch(`http://${LOOPBACK_HOST}:${server.getListeningPort()}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  function streamRequest(path: string): Promise<Response> {
    return request(path, {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'hello' }]
    })
  }

  it('精确支持 Claude Code 消息和计数路由，并将鉴权错误编码为 Anthropic 格式', async () => {
    const count = await request('/cc/v1/messages/count_tokens', {
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'hello' }]
    })
    expect(count.status).toBe(200)
    expect((await count.json()).input_tokens).toBeGreaterThan(0)

    const denied = await request('/cc/v1/messages/count_tokens', { messages: [] }, 'wrong-key')
    expect(denied.status).toBe(401)
    expect(denied.headers.get('content-type')).toContain('application/json')
    expect((await denied.json()).type).toBe('error')

    for (const method of ['GET', 'PUT']) {
      const rejected = await fetch(
        `http://${LOOPBACK_HOST}:${server.getListeningPort()}/cc/v1/messages`,
        {
          method,
          headers: { Authorization: `Bearer ${API_KEY}` }
        }
      )
      expect(rejected.status).toBe(405)
      expect(rejected.headers.get('allow')).toBe('POST')
      expect((await rejected.json()).error.type).toBe('invalid_request_error')
    }
    const invalidJson = await fetch(
      `http://${LOOPBACK_HOST}:${server.getListeningPort()}/cc/v1/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: '{'
      }
    )
    expect(invalidJson.status).toBe(400)
    expect((await invalidJson.json()).error.type).toBe('invalid_request_error')
  })

  it('请求体超过限制时，普通与 Claude Code 路由都保持 413 Anthropic 格式', async () => {
    server.updateConfig({ maxRequestBodyBytes: 1024 })

    for (const path of ['/v1/messages', '/cc/v1/messages', '/cc/v1/messages/count_tokens']) {
      const response = await request(path, {
        messages: [{ role: 'user', content: 'x'.repeat(2048) }]
      })
      expect(response.status).toBe(413)
      const payload = await response.json()
      expect(payload.type).toBe('error')
      expect(payload.error.type).toBe('api_error')
    }
  })

  it('普通非流式初选和重试均不越过 API Key binding 与分组', async () => {
    const apiKeyId = server.getConfig().apiKeys![0].id
    server.updateConfig({
      enableMultiAccount: true,
      multiAccountSelectionMode: 'groups',
      multiAccountGroupIds: ['allowed-group'],
      apiKeyAccountBindings: { [apiKeyId]: ['account-2', 'account-3'] },
      retryDelayMs: 1
    })
    const pool = server.getAccountPool()
    pool.addAccount({ id: 'account-2', accessToken: 'allowed-token', groupId: 'allowed-group' })
    pool.addAccount({ id: 'account-3', accessToken: 'out-of-group-token', groupId: 'other-group' })
    requestMock
      .mockRejectedValueOnce(new KiroMcpWebSearchError(500, true))
      .mockRejectedValueOnce(new KiroMcpWebSearchError(500, true))
      .mockResolvedValueOnce({ content: 'scoped', toolUses: [], usage: USAGE })

    const response = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'scope retry' }]
    })

    expect(response.status).toBe(200)
    expect(requestMock.mock.calls.map((call) => call[0].id)).toEqual([
      'account-2',
      'account-2',
      'account-2'
    ])
  })

  it('Gemini 绑定 API Key 时绝不选择未绑定账号', async () => {
    const apiKeyId = server.getConfig().apiKeys![0].id
    server.updateConfig({
      enableMultiAccount: true,
      apiKeyAccountBindings: { [apiKeyId]: ['gemini-a'] }
    })
    const pool = server.getAccountPool()
    pool.clear()
    pool.addAccount({ id: 'gemini-a', accessToken: 'allowed-token' })
    pool.addAccount({ id: 'gemini-b', accessToken: 'not-bound-token' })
    requestMock.mockResolvedValue({ content: 'gemini scoped', toolUses: [], usage: USAGE })

    const response = await request('/v1beta/models/gemini-2.0-flash:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'scope gemini' }] }]
    })

    expect(response.status).toBe(200)
    expect(requestMock.mock.calls.map((call) => call[0].id)).toEqual(['gemini-a'])
  })

  it('普通非流式 429 同账号退避且不标记 quota', async () => {
    server.updateConfig({ retryDelayMs: 1 })
    requestMock
      .mockRejectedValueOnce(new KiroMcpWebSearchError(429, true))
      .mockRejectedValueOnce(new KiroMcpWebSearchError(429, true))
      .mockRejectedValueOnce(new KiroMcpWebSearchError(429, true))

    const response = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'rate limit' }]
    })

    expect(response.status).toBe(429)
    expect(requestMock.mock.calls.map((call) => call[0].id)).toEqual([
      'account-1',
      'account-1',
      'account-1'
    ])
    expect(
      server.getAccountPool().isQuotaExhausted(server.getAccountPool().getAccount('account-1')!)
    ).toBe(false)
  })

  it('非流式切换到 B 后终态失败只记账 B', async () => {
    server.updateConfig({ enableMultiAccount: true, retryDelayMs: 1 })
    const pool = server.getAccountPool()
    pool.addAccount({ id: 'account-2', accessToken: 'fallback-token' })
    requestMock
      .mockRejectedValueOnce(new KiroMcpWebSearchError(500, true))
      .mockRejectedValueOnce(new KiroMcpWebSearchError(500, true))
      .mockRejectedValueOnce(new KiroMcpWebSearchError(500, true))

    const response = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'terminal account' }]
    })

    expect(response.status).toBe(500)
    expect(requestMock.mock.calls.map((call) => call[0].id)).toEqual([
      'account-1',
      'account-1',
      'account-2'
    ])
    expect(pool.getStats().accounts.get('account-1')?.errors).toBe(0)
    expect(pool.getStats().accounts.get('account-2')?.errors).toBe(1)
  })

  it('同一错误对象按账号去重，同账号重复不重复记账', () => {
    const pool = server.getAccountPool()
    pool.addAccount({ id: 'account-2', accessToken: 'second-token' })
    const error = new KiroMcpWebSearchError(429, true)
    const record = server as unknown as {
      recordUpstreamAccountErrorOnce: (account: { id: string }, upstreamError: Error) => void
    }

    record.recordUpstreamAccountErrorOnce({ id: 'account-1' }, error)
    record.recordUpstreamAccountErrorOnce({ id: 'account-1' }, error)
    record.recordUpstreamAccountErrorOnce({ id: 'account-2' }, error)

    expect(pool.getStats().accounts.get('account-1')?.errors).toBe(1)
    expect(pool.getStats().accounts.get('account-2')?.errors).toBe(1)
  })

  it('Claude Code 非流式消息沿用 Anthropic 响应格式', async () => {
    requestMock.mockResolvedValue({ content: 'non-stream reply', toolUses: [], usage: USAGE })

    const response = await request('/cc/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }]
    })

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.type).toBe('message')
    expect(payload.content).toEqual([{ type: 'text', text: 'non-stream reply' }])
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('Responses stream:true 在上游完成前实时转发文本 delta', async () => {
    let releaseCompletion!: () => void
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve
    })
    streamMock.mockImplementation(async (_account, _payload, onChunk, onComplete) => {
      await onChunk('first ')
      await completionGate
      await onChunk('second')
      await onComplete(USAGE)
    })

    const response = await request('/v1/responses', {
      model: 'claude-sonnet-4',
      stream: true,
      input: 'hello'
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let outputBeforeCompletion = ''
    while (!outputBeforeCompletion.includes('response.output_text.delta')) {
      const chunk = await reader.read()
      expect(chunk.done).toBe(false)
      outputBeforeCompletion += decoder.decode(chunk.value, { stream: true })
    }

    expect(response.status).toBe(200)
    expect(outputBeforeCompletion).toContain('"delta":"first "')
    expect(outputBeforeCompletion).not.toContain('response.completed')
    expect(requestMock).not.toHaveBeenCalled()

    releaseCompletion()
    let outputAfterCompletion = ''
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      outputAfterCompletion += decoder.decode(chunk.value, { stream: true })
    }
    outputAfterCompletion += decoder.decode()
    const output = outputBeforeCompletion + outputAfterCompletion
    const events = output
      .split('\n\n')
      .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
      .filter((line): line is string => line !== undefined)
      .map(
        (line) =>
          JSON.parse(line.slice('data: '.length)) as {
            type: string
            sequence_number: number
            delta?: string
          }
      )

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'response.created',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
        'response.output_text.done',
        'response.content_part.done',
        'response.output_item.done',
        'response.completed'
      ])
    )
    expect(
      events
        .filter((event) => event.type === 'response.output_text.delta')
        .map((event) => event.delta)
        .join('')
    ).toBe('first second')
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index))
    expect(streamMock).toHaveBeenCalledTimes(1)
  })

  it('OpenAI 流式首帧后失败会输出脱敏 error 和 DONE', async () => {
    streamMock.mockImplementationOnce(
      async (_account, _payload, _onChunk, _onComplete, onError) => {
        await onError(new KiroMcpWebSearchError(403, false, 'ksk_should_not_leak'))
      }
    )

    const response = await request('/v1/chat/completions', {
      model: 'claude-sonnet-4',
      stream: true,
      messages: [{ role: 'user', content: 'safe stream error' }]
    })
    const output = await response.text()

    expect(response.status).toBe(200)
    expect(output).toContain('data: {"error":')
    expect(output).toContain('data: [DONE]')
    expect(output).not.toContain('ksk_should_not_leak')
    expect(server.getAccountPool().getStats().accounts.get('account-1')?.errors).toBe(1)
  })

  it('普通 Anthropic 流保持实时 message_start，不等待完成', async () => {
    let finish!: () => Promise<void>
    streamMock.mockImplementation(async (_account, _payload, onChunk, onComplete) => {
      await onChunk('ordinary')
      await new Promise<void>((resolve) => {
        finish = async () => {
          await onComplete(USAGE)
          resolve()
        }
      })
    })

    const response = await streamRequest('/v1/messages')
    const reader = response.body!.getReader()
    const first = await reader.read()
    const output = new TextDecoder().decode(first.value)
    expect(first.done).toBe(false)
    expect(output).toContain('event: message_start')

    await finish()
    await reader.cancel()
  })

  it('完成回调内部事件 hook 抛错时，loopback 客户端会收到连接关闭且上游只收敛一次', async () => {
    let completionReturned = false
    ;(server as unknown as { events: { onTokensUpdate?: () => void } }).events.onTokensUpdate =
      () => {
        throw new Error('completion event hook failed')
      }
    streamMock.mockImplementation(
      async (
        _account,
        _payload,
        onChunk,
        onComplete,
        _onError,
        _signal,
        _endpoint,
        onContextUsage
      ) => {
        await onChunk('before-completion-error')
        await onContextUsage?.(USAGE)
        await onComplete(USAGE)
        completionReturned = true
      }
    )

    const response = await streamRequest('/cc/v1/messages')
    const outcome = await Promise.race([
      response.text().then(
        () => 'eof',
        () => 'rejected'
      ),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 200))
    ])

    expect(outcome).toBe('rejected')
    expect(completionReturned).toBe(true)
    expect(streamMock).toHaveBeenCalledTimes(1)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect((server as unknown as { activeRequests: Set<unknown> }).activeRequests.size).toBe(0)
  })

  it('错误回调写入失败时，loopback 客户端会收到连接关闭且上游只收敛一次', async () => {
    let errorReturned = false
    const target = server as unknown as { waitForDrain: () => Promise<void> }
    target.waitForDrain = async () => {
      throw new Error('error writer failed')
    }
    streamMock.mockImplementation(async (_account, _payload, _onChunk, _onComplete, onError) => {
      await onError(new Error('upstream stream failed'))
      errorReturned = true
    })

    const response = await streamRequest('/cc/v1/messages')
    const outcome = await Promise.race([
      response.text().then(
        () => 'eof',
        () => 'rejected'
      ),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 200))
    ])

    expect(outcome).toBe('rejected')
    expect(errorReturned).toBe(true)
    expect(streamMock).toHaveBeenCalledTimes(1)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect((server as unknown as { activeRequests: Set<unknown> }).activeRequests.size).toBe(0)
  })

  it('流实现自身拒绝且兜底写入失败时，loopback 客户端会关闭且请求控制器收敛', async () => {
    const target = server as unknown as { waitForDrain: () => Promise<void> }
    target.waitForDrain = async () => {
      throw new Error('fallback writer failed')
    }
    streamMock.mockRejectedValue(new Error('stream implementation rejected'))

    const response = await streamRequest('/cc/v1/messages')
    const outcome = await Promise.race([
      response.text().then(
        () => 'eof',
        () => 'rejected'
      ),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 200))
    ])

    expect(outcome).toBe('rejected')
    expect(streamMock).toHaveBeenCalledTimes(1)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect((server as unknown as { activeRequests: Set<unknown> }).activeRequests.size).toBe(0)
  })

  it('Claude Code 在 contextUsageEvent 后以准确首帧回放，并在完成前继续实时输出', async () => {
    let publishContext!: () => Promise<void>
    let finish!: () => Promise<void>
    streamMock.mockImplementation(
      async (
        _account,
        _payload,
        onChunk,
        onComplete,
        _onError,
        _signal,
        _endpoint,
        onContextUsage
      ) => {
        await onChunk('before-context')
        await new Promise<void>((resolve) => {
          publishContext = async () => {
            await onContextUsage?.({ ...USAGE, contextUsage: { percentage: 10 } })
            resolve()
          }
        })
        await onChunk('after-context')
        await new Promise<void>((resolve) => {
          finish = async () => {
            await onComplete(USAGE)
            resolve()
          }
        })
      }
    )

    const response = await streamRequest('/cc/v1/messages')
    const reader = response.body!.getReader()
    let deliveredBeforeContext = false
    const firstRead = reader.read().then((result) => {
      deliveredBeforeContext = true
      return result
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(deliveredBeforeContext).toBe(false)

    await publishContext()
    const first = await firstRead
    let output = new TextDecoder().decode(first.value)
    expect(first.done).toBe(false)
    while (!output.includes('after-context')) {
      const next = await reader.read()
      expect(next.done).toBe(false)
      output += new TextDecoder().decode(next.value)
    }
    expect(output).toContain('"input_tokens":27')
    expect(output.indexOf('event: message_start')).toBeLessThan(output.indexOf('before-context'))
    expect(output.indexOf('before-context')).toBeLessThan(output.indexOf('after-context'))

    await finish()
    await reader.cancel()
  })

  it('Claude Code 未收到 contextUsageEvent 时回退原始估算并在完成时回放', async () => {
    streamMock.mockImplementation(async (_account, _payload, onChunk, onComplete) => {
      await onChunk('fallback')
      await onComplete({ ...USAGE, inputTokens: 999 })
    })

    const response = await streamRequest('/cc/v1/messages')
    const output = await response.text()
    expect(output).toContain('event: message_start')
    expect(output).toContain('fallback')
    expect(output.split('\n\n')[0]).not.toContain('"input_tokens":999')
  })

  it('WebSearch 在 MCP 成功后合成精确 Anthropic SSE，stream:false 仍保持流式', async () => {
    webSearchMock.mockResolvedValue([
      {
        type: 'web_search_result',
        title: '搜索标题',
        url: 'https://example.test/result',
        encrypted_content: '这是一段搜索摘要',
        page_age: 'January 1, 2024'
      }
    ])

    const response = await request('/cc/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      stream: false,
      tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Perform a web search for the query: 中文 query' }]
    })
    const output = await response.text()
    const events = output
      .trim()
      .split('\n\n')
      .map((frame) =>
        JSON.parse(
          frame
            .split('\n')
            .find((line) => line.startsWith('data: '))!
            .slice(6)
        )
      )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(webSearchMock).toHaveBeenCalledTimes(1)
    expect(events.map((event) => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_stop',
      'content_block_start',
      'content_block_stop',
      'content_block_start',
      ...events.slice(9, -3).map(() => 'content_block_delta'),
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(events[0].message.id).toMatch(/^msg_[a-f0-9]{24}$/)
    expect(events[2].delta.text).toBe(`I'll search for "中文 query".`)
    expect(events[4].content_block).toMatchObject({
      type: 'server_tool_use',
      name: 'web_search',
      input: { query: '中文 query' }
    })
    expect(events[4].content_block.id).toMatch(/^srvtoolu_[a-f0-9]{32}$/)
    expect(events[6].content_block).toMatchObject({
      type: 'web_search_tool_result',
      tool_use_id: events[4].content_block.id,
      content: [
        {
          type: 'web_search_result',
          title: '搜索标题',
          url: 'https://example.test/result',
          encrypted_content: '这是一段搜索摘要',
          page_age: 'January 1, 2024'
        }
      ]
    })
    const summaryDeltas = events.filter(
      (event) => event.type === 'content_block_delta' && event.index === 3
    )
    expect(summaryDeltas.map((event) => event.delta.text).join('')).toBe(
      'Here are the search results for "中文 query":\n\n1. **搜索标题**\n   这是一段搜索摘要\n   Source: https://example.test/result\n\nPlease note that these are web search results and may not be fully accurate or up-to-date.'
    )
    expect(summaryDeltas.every((event) => Array.from(event.delta.text).length <= 100)).toBe(true)
    expect(events[events.length - 2].usage).toMatchObject({
      server_tool_use: { web_search_requests: 1 }
    })
    expect(requestMock).not.toHaveBeenCalled()
    expect(streamMock).not.toHaveBeenCalled()
  })

  it('WebSearch 对 Unicode 摘要按 200 个 codepoint 截断并精确计数 SSE token', async () => {
    const query = 'unicode-summary'
    const longSnippet = '😀'.repeat(201)
    const tools = [{ name: 'web_search', input_schema: { type: 'object' } }]
    const messages = [{ role: 'user', content: `Perform a web search for the query: ${query}` }]
    webSearchMock.mockResolvedValue([
      {
        type: 'web_search_result',
        title: 'Unicode result',
        url: 'https://example.test/unicode',
        encrypted_content: longSnippet,
        page_age: null
      }
    ])

    const response = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      stream: false,
      tools,
      messages
    })
    const events = (await response.text())
      .trim()
      .split('\n\n')
      .map((frame) =>
        JSON.parse(
          frame
            .split('\n')
            .find((line) => line.startsWith('data: '))!
            .slice(6)
        )
      )
    const summary = events
      .filter((event) => event.type === 'content_block_delta' && event.index === 3)
      .map((event) => event.delta.text)
      .join('')
    const toolUse = events.find(
      (event) => event.type === 'content_block_start' && event.index === 1
    ).content_block
    const toolResult = events.find(
      (event) => event.type === 'content_block_start' && event.index === 2
    ).content_block
    const expectedSnippet = `${'😀'.repeat(200)}...`
    const expectedSummary = `Here are the search results for "${query}":\n\n1. **Unicode result**\n   ${expectedSnippet}\n   Source: https://example.test/unicode\n\nPlease note that these are web search results and may not be fully accurate or up-to-date.`

    expect(response.status).toBe(200)
    expect(summary).toBe(expectedSummary)
    expect(Array.from(expectedSnippet).length).toBe(203)
    expect(events[0].message.usage.input_tokens).toBe(
      Math.max(1, Math.round(JSON.stringify({ messages, tools }).length / 3))
    )
    expect(events[events.length - 2].usage.output_tokens).toBe(
      Math.ceil(Buffer.byteLength(expectedSummary, 'utf-8') / 4)
    )
    expect(toolUse).toMatchObject({ type: 'server_tool_use', name: 'web_search', input: { query } })
    expect(toolResult).toMatchObject({ type: 'web_search_tool_result', tool_use_id: toolUse.id })
  })

  it('WebSearch 空结果仍返回确定 SSE，且仅精确的原始和处理后工具集合触发', async () => {
    webSearchMock.mockResolvedValue([])
    const empty = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      stream: false,
      tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Perform a web search for the query: empty' }]
    })
    const emptyOutput = await empty.text()
    const emptyEvents = emptyOutput
      .trim()
      .split('\n\n')
      .map((frame) =>
        JSON.parse(
          frame
            .split('\n')
            .find((line) => line.startsWith('data: '))!
            .slice(6)
        )
      )
    const emptySummary = emptyEvents
      .filter((event) => event.type === 'content_block_delta' && event.index === 3)
      .map((event) => event.delta.text)
      .join('')
    expect(empty.status).toBe(200)
    expect(emptySummary).toBe(
      'Here are the search results for "empty":\n\nPlease note that these are web search results and may not be fully accurate or up-to-date.'
    )

    requestMock.mockResolvedValue({ content: 'ordinary', toolUses: [], usage: USAGE })
    const multiTool = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      stream: false,
      tool_choice: { type: 'tool', name: 'web_search' },
      tools: [
        { name: 'web_search', input_schema: { type: 'object' } },
        { name: 'other_tool', input_schema: { type: 'object' } }
      ],
      messages: [
        { role: 'user', content: 'Perform a web search for the query: should not trigger' }
      ]
    })
    expect(multiTool.status).toBe(200)
    expect(webSearchMock).toHaveBeenCalledTimes(1)
    expect(requestMock).toHaveBeenCalledTimes(1)

    const disabled = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      stream: false,
      tool_choice: { type: 'none' },
      tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Perform a web search for the query: disabled' }]
    })
    expect(disabled.status).toBe(200)
    expect(webSearchMock).toHaveBeenCalledTimes(1)
    expect(requestMock).toHaveBeenCalledTimes(2)
  })

  it('WebSearch 拒绝空 query，并在 MCP 失败时在写响应头前返回安全 502', async () => {
    const empty = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Perform a web search for the query:    ' }]
    })
    expect(empty.status).toBe(400)
    expect(webSearchMock).not.toHaveBeenCalled()

    webSearchMock.mockRejectedValue(new KiroMcpWebSearchError())
    const failed = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Perform a web search for the query: do-not-leak' }]
    })
    expect(failed.status).toBe(502)
    expect(failed.headers.get('content-type')).toContain('application/json')
    const payload = await failed.json()
    expect(payload.error.message).toBe('Web search is unavailable')
    expect(JSON.stringify(payload)).not.toContain('do-not-leak')
  })

  it('WebSearch 重试后以实际成功账号计数，API Key 用量保持零 token', async () => {
    server.getAccountPool().addAccount({ id: 'account-2', accessToken: 'second-token' })
    webSearchMock
      .mockRejectedValueOnce(new KiroMcpWebSearchError(429, true))
      .mockResolvedValueOnce([])

    const response = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Perform a web search for the query: retry' }]
    })
    expect(response.status).toBe(200)
    expect(webSearchMock.mock.calls.map((call) => call[0].id)).toEqual(['account-1', 'account-1'])
    const apiKey = server.getConfig().apiKeys![0]
    expect(apiKey.usage.totalInputTokens).toBe(0)
    expect(apiKey.usage.totalOutputTokens).toBe(0)
    expect(server.getAccountPool().getStats().accounts.get('account-1')).toMatchObject({
      requests: 1,
      tokens: 0
    })
    expect(
      server.getAccountPool().isQuotaExhausted(server.getAccountPool().getAccount('account-1')!)
    ).toBe(false)
  })

  it('WebSearch 不越过分组、禁用或封禁账号', async () => {
    server.updateConfig({
      enableMultiAccount: true,
      multiAccountSelectionMode: 'groups',
      multiAccountGroupIds: ['group-a']
    })
    server
      .getAccountPool()
      .addAccount({ id: 'disabled', accessToken: 'disabled-token', groupId: 'group-a' })
    server.getAccountPool().updateAccount('disabled', { isAvailable: false })
    server.getAccountPool().addAccount({
      id: 'suspended',
      accessToken: 'suspended-token',
      groupId: 'group-a',
      suspendedAt: Date.now()
    })
    server
      .getAccountPool()
      .addAccount({ id: 'other-group', accessToken: 'other-token', groupId: 'group-b' })
    server
      .getAccountPool()
      .addAccount({ id: 'allowed', accessToken: 'allowed-token', groupId: 'group-a' })
    webSearchMock.mockResolvedValue([])

    const response = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Perform a web search for the query: scoped' }]
    })

    expect(response.status).toBe(200)
    expect(webSearchMock.mock.calls.map((call) => call[0].id)).toEqual(['allowed'])
  })

  it('WebSearch 的非月度 402 不隔离账号或切换备用账号', async () => {
    server.updateConfig({ enableMultiAccount: true })
    const pool = server.getAccountPool()
    pool.addAccount({ id: 'account-2', accessToken: 'second-token' })
    webSearchMock.mockRejectedValueOnce(new KiroMcpWebSearchError(402, false, 'PAYMENT_REQUIRED'))

    const response = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Perform a web search for the query: non-monthly-402' }]
    })

    expect(response.status).toBe(502)
    expect(webSearchMock.mock.calls.map((call) => call[0].id)).toEqual(['account-1'])
    expect(pool.isQuotaExhausted(pool.getAccount('account-1')!)).toBe(false)
    expect(pool.getAccount('account-2')?.isAvailable).toBe(true)
  })

  it('WebSearch 对 402 实时排除账号，并对认证错误每账号只刷新一次', async () => {
    server.updateConfig({ enableMultiAccount: true })
    server.getAccountPool().addAccount({ id: 'account-2', accessToken: 'second-token' })
    server.getAccountPool().addAccount({ id: 'account-3', accessToken: 'third-token' })
    const refreshToken = vi
      .spyOn(
        server as unknown as {
          refreshToken: (account: unknown, signal?: AbortSignal) => Promise<boolean>
        },
        'refreshToken'
      )
      .mockResolvedValue(true)
    webSearchMock
      .mockRejectedValueOnce(new KiroMcpWebSearchError(402, false, 'MONTHLY_REQUEST_COUNT'))
      .mockRejectedValueOnce(new KiroMcpWebSearchError(401, false))
      .mockRejectedValueOnce(new KiroMcpWebSearchError(403, false))
      .mockResolvedValueOnce([])

    const response = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Perform a web search for the query: retry-auth' }]
    })

    expect(response.status).toBe(200)
    expect(webSearchMock.mock.calls.map((call) => call[0].id)).toEqual([
      'account-1',
      'account-2',
      'account-2',
      'account-3'
    ])
    expect(refreshToken).toHaveBeenCalledTimes(1)
    refreshToken.mockRestore()
  })

  it('WebSearch 的 Kiro API key 遇到认证错误不刷新且切换账号', async () => {
    server.updateConfig({ enableMultiAccount: true })
    const pool = server.getAccountPool()
    pool.updateAccount('account-1', { isAvailable: false })
    pool.addAccount({
      id: 'kiro-api-key',
      credentialKind: 'kiro_api_key',
      kiroApiKey: 'ksk_test_redacted'
    })
    pool.addAccount({ id: 'oauth-fallback', accessToken: 'oauth-token' })
    const refreshToken = vi.spyOn(
      server as unknown as {
        refreshToken: (account: unknown, signal?: AbortSignal) => Promise<boolean>
      },
      'refreshToken'
    )
    webSearchMock
      .mockRejectedValueOnce(new KiroMcpWebSearchError(401, false))
      .mockResolvedValueOnce([])

    const response = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Perform a web search for the query: api-key-auth' }]
    })

    expect(response.status).toBe(200)
    expect(webSearchMock.mock.calls.map((call) => call[0].id)).toEqual([
      'kiro-api-key',
      'oauth-fallback'
    ])
    expect(refreshToken).not.toHaveBeenCalled()
    expect(pool.getAccount('kiro-api-key')?.isAvailable).toBe(false)
    refreshToken.mockRestore()
  })

  it('API Key 流式 403 不刷新，并在首个上游 chunk 前切换备用账号', async () => {
    server.updateConfig({ enableMultiAccount: true })
    const pool = server.getAccountPool()
    pool.updateAccount('account-1', { isAvailable: false })
    pool.addAccount({
      id: 'kiro-api-key',
      credentialKind: 'kiro_api_key',
      kiroApiKey: 'ksk_test_redacted'
    })
    pool.addAccount({ id: 'oauth-fallback', accessToken: 'oauth-token' })
    const refreshToken = vi.spyOn(
      server as unknown as {
        refreshToken: (account: unknown, signal?: AbortSignal) => Promise<boolean>
      },
      'refreshToken'
    )
    streamMock
      .mockImplementationOnce(async (_account, _payload, _onChunk, _onComplete, onError) => {
        await onError(new KiroMcpWebSearchError(403, false))
      })
      .mockImplementationOnce(async (_account, _payload, _onChunk, onComplete) => {
        await onComplete(USAGE)
      })

    const response = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'stream fallback' }]
    })

    expect(response.status).toBe(200)
    expect(streamMock.mock.calls.map((call) => call[0].id)).toEqual([
      'kiro-api-key',
      'oauth-fallback'
    ])
    expect(refreshToken).not.toHaveBeenCalled()
    expect(pool.getAccount('kiro-api-key')?.isAvailable).toBe(false)
    refreshToken.mockRestore()
  })

  it('流式已写出上游 chunk 后不重放或切换账号', async () => {
    server.updateConfig({ enableMultiAccount: true })
    server.getAccountPool().addAccount({ id: 'account-2', accessToken: 'second-token' })
    streamMock.mockImplementationOnce(async (_account, _payload, onChunk, _onComplete, onError) => {
      await onChunk('partial')
      await onError(new KiroMcpWebSearchError(403, false))
    })

    const response = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'do not replay' }]
    })

    expect(response.status).toBe(200)
    const output = await response.text()
    expect(output.match(/partial/g)).toHaveLength(1)
    expect(streamMock).toHaveBeenCalledTimes(1)
    expect(streamMock.mock.calls[0][0].id).toBe('account-1')
  })

  it('accepts a key-only account without synthesizing an OAuth access token', () => {
    const pool = server.getAccountPool()
    pool.addAccount({
      id: 'key-only-sync-input',
      credentialKind: 'kiro_api_key',
      kiroApiKey: 'ksk_test_redacted'
    })
    const account = pool.getAccount('key-only-sync-input')

    expect(account).toMatchObject({
      credentialKind: 'kiro_api_key',
      kiroApiKey: 'ksk_test_redacted'
    })
    expect(account?.accessToken).toBeUndefined()
  })

  it('WebSearch 对瞬态错误执行可控退避并在单账号上封顶', async () => {
    const waitForRetry = vi
      .spyOn(
        server as unknown as {
          waitForRetry: (ms: number, signal?: AbortSignal) => Promise<void>
        },
        'waitForRetry'
      )
      .mockResolvedValue()
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99)
    webSearchMock.mockRejectedValue(new KiroMcpWebSearchError(500, true))

    try {
      const response = await request('/v1/messages', {
        model: 'claude-sonnet-4',
        max_tokens: 16,
        tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'Perform a web search for the query: retry-cap' }]
      })

      expect(response.status).toBe(502)
      expect(webSearchMock).toHaveBeenCalledTimes(3)
      expect(waitForRetry.mock.calls.map((call) => call[0])).toEqual([250, 499])
    } finally {
      random.mockRestore()
      waitForRetry.mockRestore()
    }
  })

  it('WebSearch 在非多账号模式也会按 API Key 绑定执行自动切号', async () => {
    const apiKeyId = server.getConfig().apiKeys![0].id
    server.getAccountPool().addAccount({ id: 'bound', accessToken: 'bound-token' })
    server.getAccountPool().addAccount({ id: 'unbound', accessToken: 'unbound-token' })
    server.updateConfig({
      enableMultiAccount: false,
      autoSwitchOnQuotaExhausted: true,
      apiKeyAccountBindings: { [apiKeyId]: ['account-1', 'bound'] }
    })
    const waitForRetry = vi
      .spyOn(
        server as unknown as {
          waitForRetry: (ms: number, signal?: AbortSignal) => Promise<void>
        },
        'waitForRetry'
      )
      .mockResolvedValue()
    webSearchMock
      .mockRejectedValueOnce(new KiroMcpWebSearchError(500, true))
      .mockResolvedValueOnce([])

    try {
      const response = await request('/v1/messages', {
        model: 'claude-sonnet-4',
        max_tokens: 16,
        tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
        messages: [
          { role: 'user', content: 'Perform a web search for the query: bound-auto-switch' }
        ]
      })

      expect(response.status).toBe(200)
      expect(webSearchMock.mock.calls.map((call) => call[0].id)).toEqual(['account-1', 'bound'])
    } finally {
      waitForRetry.mockRestore()
    }
  })

  it('WebSearch 的不可用账号不会扩大重试上限', async () => {
    const apiKeyId = server.getConfig().apiKeys![0].id
    const pool = server.getAccountPool()
    pool.addAccount({ id: 'disabled', accessToken: 'disabled-token' })
    pool.updateAccount('disabled', { isAvailable: false })
    pool.addAccount({ id: 'suspended', accessToken: 'suspended-token', suspendedAt: Date.now() })
    pool.addAccount({ id: 'quota', accessToken: 'quota-token', quotaExhaustedAt: Date.now() })
    pool.addAccount({
      id: 'cooldown',
      accessToken: 'cooldown-token',
      cooldownUntil: Date.now() + 60_000
    })
    server.updateConfig({
      enableMultiAccount: false,
      autoSwitchOnQuotaExhausted: true,
      apiKeyAccountBindings: {
        [apiKeyId]: ['account-1', 'disabled', 'suspended', 'quota', 'cooldown']
      }
    })
    const waitForRetry = vi
      .spyOn(
        server as unknown as {
          waitForRetry: (ms: number, signal?: AbortSignal) => Promise<void>
        },
        'waitForRetry'
      )
      .mockResolvedValue()
    webSearchMock.mockRejectedValue(new KiroMcpWebSearchError(500, true))

    try {
      const response = await request('/v1/messages', {
        model: 'claude-sonnet-4',
        max_tokens: 16,
        tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'Perform a web search for the query: live-only' }]
      })

      expect(response.status).toBe(502)
      expect(webSearchMock.mock.calls.map((call) => call[0].id)).toEqual([
        'account-1',
        'account-1',
        'account-1'
      ])
      expect(waitForRetry).toHaveBeenCalledTimes(2)
    } finally {
      waitForRetry.mockRestore()
    }
  })

  it('WebSearch 的多账号瞬态重试全局与单账号次数均有上限', async () => {
    const pool = server.getAccountPool()
    pool.addAccount({ id: 'account-2', accessToken: 'second-token' })
    pool.addAccount({ id: 'account-3', accessToken: 'third-token' })
    pool.addAccount({ id: 'account-4', accessToken: 'fourth-token' })
    server.updateConfig({ enableMultiAccount: true })
    const waitForRetry = vi
      .spyOn(
        server as unknown as {
          waitForRetry: (ms: number, signal?: AbortSignal) => Promise<void>
        },
        'waitForRetry'
      )
      .mockResolvedValue()
    webSearchMock.mockRejectedValue(new KiroMcpWebSearchError(500, true))

    try {
      const response = await request('/v1/messages', {
        model: 'claude-sonnet-4',
        max_tokens: 16,
        tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
        messages: [
          { role: 'user', content: 'Perform a web search for the query: bounded-round-robin' }
        ]
      })
      const callsByAccount = webSearchMock.mock.calls.reduce<Record<string, number>>(
        (counts, [account]) => {
          counts[account.id] = (counts[account.id] || 0) + 1
          return counts
        },
        {}
      )

      expect(response.status).toBe(502)
      expect(webSearchMock).toHaveBeenCalledTimes(9)
      expect(Object.values(callsByAccount).every((count) => count <= 3)).toBe(true)
      expect(waitForRetry).toHaveBeenCalledTimes(8)
    } finally {
      waitForRetry.mockRestore()
    }
  })

  it('WebSearch 对 400 立即失败且不等待重试', async () => {
    const waitForRetry = vi
      .spyOn(
        server as unknown as {
          waitForRetry: (ms: number, signal?: AbortSignal) => Promise<void>
        },
        'waitForRetry'
      )
      .mockResolvedValue()
    webSearchMock.mockRejectedValue(new KiroMcpWebSearchError(400, false))

    try {
      const response = await request('/v1/messages', {
        model: 'claude-sonnet-4',
        max_tokens: 16,
        tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'Perform a web search for the query: no-retry' }]
      })

      expect(response.status).toBe(502)
      expect(webSearchMock).toHaveBeenCalledTimes(1)
      expect(waitForRetry).not.toHaveBeenCalled()
    } finally {
      waitForRetry.mockRestore()
    }
  })

  it('WebSearch 隔离统计和配置事件 hook 异常并只结算一次', async () => {
    const events = (
      server as unknown as {
        events: { onRequestStatsUpdate?: () => void; onConfigChanged?: () => void }
      }
    ).events
    events.onRequestStatsUpdate = () => {
      throw new Error('stats hook failed')
    }
    events.onConfigChanged = () => {
      throw new Error('config hook failed')
    }
    webSearchMock.mockResolvedValue([])

    const response = await request('/v1/messages', {
      model: 'claude-sonnet-4',
      max_tokens: 16,
      tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Perform a web search for the query: hooks' }]
    })

    expect(response.status).toBe(200)
    const stats = server.getStats()
    expect(stats.totalRequests).toBe(1)
    expect(stats.successRequests).toBe(1)
    expect(stats.failedRequests).toBe(0)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect((server as unknown as { activeRequests: Set<unknown> }).activeRequests.size).toBe(0)
  })
})

describe('Claude Code 首帧缓冲器', () => {
  it('在尚未释放业务帧时按可注入间隔发送 ping', async () => {
    vi.useFakeTimers()
    const writer = vi.fn(async () => undefined)
    const buffer = new ClaudeCodeStreamBuffer(writer, () => false, 12, { pingIntervalMs: 25 })
    await buffer.write('event: message_start\ndata: {}\n\n')

    await vi.advanceTimersByTimeAsync(25)
    expect(writer).toHaveBeenCalledWith('event: ping\ndata: {"type":"ping"}\n\n')
    expect(writer).not.toHaveBeenCalledWith('event: message_start\ndata: {}\n\n')

    await buffer.release(12)
    vi.useRealTimers()
  })

  it('大帧和超时会以原估算释放，慢 writer 保持帧顺序且 close 后丢弃', async () => {
    const frames: string[] = []
    let unblock!: () => void
    const slowWriter = vi.fn(async (frame: string) => {
      await new Promise<void>((resolve) => {
        unblock = resolve
      })
      frames.push(frame)
    })
    const buffer = new ClaudeCodeStreamBuffer(slowWriter, () => false, 41, { maxBufferBytes: 1 })
    const pending = buffer.write(
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":1}}}\n\n'
    )
    await Promise.resolve()
    unblock()
    await pending
    expect(frames).toHaveLength(1)
    expect(frames[0]).toContain('"input_tokens":41')

    let closed = false
    const discardedWriter = vi.fn(async () => undefined)
    const discarded = new ClaudeCodeStreamBuffer(discardedWriter, () => closed, 1, { maxWaitMs: 1 })
    await discarded.write('event: message_start\ndata: {}\n\n')
    closed = true
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(discardedWriter).not.toHaveBeenCalled()
    discarded.discard()
  })

  it('release 与已排队 ping 竞态时不丢帧也不交错', async () => {
    vi.useFakeTimers()
    const frames: string[] = []
    let unblock!: () => void
    let writeCount = 0
    const writer = vi.fn(async (frame: string) => {
      writeCount++
      if (writeCount === 1)
        await new Promise<void>((resolve) => {
          unblock = resolve
        })
      frames.push(frame)
    })
    const buffer = new ClaudeCodeStreamBuffer(writer, () => false, 73, { pingIntervalMs: 1 })
    await buffer.write('event: message_start\ndata: {"message":{"usage":{"input_tokens":1}}}\n\n')
    await buffer.write('event: content_block_delta\ndata: {"delta":{"text":"second"}}\n\n')
    const release = buffer.release(73)
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(1)
    unblock()
    await release
    await Promise.resolve()

    expect(frames).toHaveLength(2)
    expect(frames[0]).toContain('"input_tokens":73')
    expect(frames[1]).toContain('second')
    expect(frames.join('')).not.toContain('event: ping')
    buffer.discard()
    vi.useRealTimers()
  })

  it('maxWait 到期会在连接仍打开时按安全估算回放完整缓冲区', async () => {
    vi.useFakeTimers()
    const frames: string[] = []
    const buffer = new ClaudeCodeStreamBuffer(
      async (frame) => {
        frames.push(frame)
      },
      () => false,
      88,
      {
        maxWaitMs: 1,
        pingIntervalMs: 100
      }
    )
    await buffer.write('event: message_start\ndata: {"message":{"usage":{"input_tokens":1}}}\n\n')
    await buffer.write('event: content_block_delta\ndata: {"delta":{"text":"still-open"}}\n\n')

    await vi.advanceTimersByTimeAsync(1)

    expect(frames).toHaveLength(2)
    expect(frames[0]).toContain('"input_tokens":88')
    expect(frames[1]).toContain('still-open')
    buffer.discard()
    vi.useRealTimers()
  })
})

describe('模型上下文窗口与 GPT-5.6 映射', () => {
  it('动态 Kiro 模型窗口优先于静态兜底，并覆盖 Rust 已证实的模型', () => {
    setModelContextWindow('gpt-5.6-sol', 345678)
    expect(getModelContextLength('gpt-5.6-sol')).toBe(345678)
    expect(getModelContextLength('gpt-5-6-terra')).toBe(272000)
    expect(getModelContextLength('gpt-5.6-luna')).toBe(272000)
    expect(getModelContextLength('claude-opus-4.8')).toBe(1000000)
    expect(getModelContextLength('claude-sonnet-5')).toBe(1000000)
    expect(getModelContextLength('claude-sonnet-4.6')).toBe(1000000)
    expect(getModelContextLength('claude-opus-4-7')).toBe(1000000)
    expect(getModelContextLength('claude-opus-5')).toBe(1000000)
    expect(getModelContextLength('claude-sonnet-4.5')).toBe(200000)
    expect(getModelContextLength('claude-opus-4.5')).toBe(200000)
    expect(getModelContextLength('claude-haiku-4.5')).toBe(200000)
    expect(getModelContextLength('gpt-5.60-sol')).toBe(200000)
  })

  it('显式映射 GPT-5.6 别名，未知 GPT 不静默降级为 Sonnet', () => {
    expect(mapModelId('gpt-5.6')).toBe('gpt-5.6-sol')
    expect(mapModelId('gpt-5-6-sol')).toBe('gpt-5.6-sol')
    expect(mapModelId('gpt-5.6-terra')).toBe('gpt-5.6-terra')
    expect(mapModelId('gpt-unknown-future')).toBe('gpt-unknown-future')
  })
})
