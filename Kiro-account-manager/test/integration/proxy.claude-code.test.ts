import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeCodeStreamBuffer } from '../../src/main/proxy/claudeCodeStreamBuffer'

const { streamMock, requestMock } = vi.hoisted(() => ({ streamMock: vi.fn(), requestMock: vi.fn() }))

vi.mock('../../src/main/proxy/kiroApi', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/main/proxy/kiroApi')>(),
  callKiroApi: requestMock,
  callKiroApiStream: streamMock
}))

import { ProxyServer } from '../../src/main/proxy/proxyServer'
import { mapModelId } from '../../src/main/proxy/kiroApi'
import { getModelContextLength, setModelContextWindow } from '../../src/main/proxy/tokenCounter'
import { makeApiKey } from '../helpers/proxyFixtures'

const LOOPBACK_HOST = '127.0.0.1'
const API_KEY = 'sk_test_claude_code'
const USAGE = { inputTokens: 27, outputTokens: 3, credits: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

describe('ProxyServer Claude Code 兼容', () => {
  let server: ProxyServer

  beforeEach(async () => {
    streamMock.mockReset()
    requestMock.mockReset()
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

  async function request(path: string, body: Record<string, unknown>, key: string = API_KEY): Promise<Response> {
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
      const rejected = await fetch(`http://${LOOPBACK_HOST}:${server.getListeningPort()}/cc/v1/messages`, {
        method,
        headers: { Authorization: `Bearer ${API_KEY}` }
      })
      expect(rejected.status).toBe(405)
      expect(rejected.headers.get('allow')).toBe('POST')
      expect((await rejected.json()).error.type).toBe('invalid_request_error')
    }
    const invalidJson = await fetch(`http://${LOOPBACK_HOST}:${server.getListeningPort()}/cc/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: '{'
    })
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

  it('普通 Anthropic 流保持实时 message_start，不等待完成', async () => {
    let finish!: () => Promise<void>
    streamMock.mockImplementation(async (_account, _payload, onChunk, onComplete) => {
      await onChunk('ordinary')
      await new Promise<void>(resolve => {
        finish = async () => { await onComplete(USAGE); resolve() }
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
    ;(server as unknown as { events: { onTokensUpdate?: () => void } }).events.onTokensUpdate = () => {
      throw new Error('completion event hook failed')
    }
    streamMock.mockImplementation(async (_account, _payload, onChunk, onComplete, _onError, _signal, _endpoint, onContextUsage) => {
      await onChunk('before-completion-error')
      await onContextUsage?.(USAGE)
      await onComplete(USAGE)
      completionReturned = true
    })

    const response = await streamRequest('/cc/v1/messages')
    const outcome = await Promise.race([
      response.text().then(() => 'eof', () => 'rejected'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 200))
    ])

    expect(outcome).toBe('rejected')
    expect(completionReturned).toBe(true)
    expect(streamMock).toHaveBeenCalledTimes(1)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect((server as unknown as { activeRequests: Set<unknown> }).activeRequests.size).toBe(0)
  })

  it('错误回调写入失败时，loopback 客户端会收到连接关闭且上游只收敛一次', async () => {
    let errorReturned = false
    const target = server as unknown as { waitForDrain: () => Promise<void> }
    target.waitForDrain = async () => { throw new Error('error writer failed') }
    streamMock.mockImplementation(async (_account, _payload, _onChunk, _onComplete, onError) => {
      await onError(new Error('upstream stream failed'))
      errorReturned = true
    })

    const response = await streamRequest('/cc/v1/messages')
    const outcome = await Promise.race([
      response.text().then(() => 'eof', () => 'rejected'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 200))
    ])

    expect(outcome).toBe('rejected')
    expect(errorReturned).toBe(true)
    expect(streamMock).toHaveBeenCalledTimes(1)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect((server as unknown as { activeRequests: Set<unknown> }).activeRequests.size).toBe(0)
  })

  it('流实现自身拒绝且兜底写入失败时，loopback 客户端会关闭且请求控制器收敛', async () => {
    const target = server as unknown as { waitForDrain: () => Promise<void> }
    target.waitForDrain = async () => { throw new Error('fallback writer failed') }
    streamMock.mockRejectedValue(new Error('stream implementation rejected'))

    const response = await streamRequest('/cc/v1/messages')
    const outcome = await Promise.race([
      response.text().then(() => 'eof', () => 'rejected'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 200))
    ])

    expect(outcome).toBe('rejected')
    expect(streamMock).toHaveBeenCalledTimes(1)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect((server as unknown as { activeRequests: Set<unknown> }).activeRequests.size).toBe(0)
  })

  it('Claude Code 在 contextUsageEvent 后以准确首帧回放，并在完成前继续实时输出', async () => {
    let publishContext!: () => Promise<void>
    let finish!: () => Promise<void>
    streamMock.mockImplementation(async (_account, _payload, onChunk, onComplete, _onError, _signal, _endpoint, onContextUsage) => {
      await onChunk('before-context')
      await new Promise<void>(resolve => {
        publishContext = async () => {
          await onContextUsage?.({ ...USAGE, contextUsage: { percentage: 10 } })
          resolve()
        }
      })
      await onChunk('after-context')
      await new Promise<void>(resolve => {
        finish = async () => { await onComplete(USAGE); resolve() }
      })
    })

    const response = await streamRequest('/cc/v1/messages')
    const reader = response.body!.getReader()
    let deliveredBeforeContext = false
    const firstRead = reader.read().then(result => {
      deliveredBeforeContext = true
      return result
    })
    await new Promise<void>(resolve => setImmediate(resolve))
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
      await new Promise<void>(resolve => { unblock = resolve })
      frames.push(frame)
    })
    const buffer = new ClaudeCodeStreamBuffer(slowWriter, () => false, 41, { maxBufferBytes: 1 })
    const pending = buffer.write('event: message_start\ndata: {"message":{"usage":{"input_tokens":1}}}\n\n')
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
    await new Promise(resolve => setTimeout(resolve, 5))
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
      if (writeCount === 1) await new Promise<void>(resolve => { unblock = resolve })
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
    const buffer = new ClaudeCodeStreamBuffer(async frame => { frames.push(frame) }, () => false, 88, {
      maxWaitMs: 1,
      pingIntervalMs: 100
    })
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
