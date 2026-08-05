import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { streamMock, requestMock } = vi.hoisted(() => ({ streamMock: vi.fn(), requestMock: vi.fn() }))

vi.mock('../../src/main/proxy/kiroApi', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/main/proxy/kiroApi')>(),
  callKiroApi: requestMock,
  callKiroApiStream: streamMock
}))

import { ProxyServer } from '../../src/main/proxy/proxyServer'
import { makeApiKey } from '../helpers/proxyFixtures'

const LOOPBACK_HOST = '127.0.0.1'
const API_KEY = 'sk_test_truncation'

/** 从 SSE 文本里按顺序抽出 event: 名称 */
function eventSequence(sse: string): string[] {
  return sse
    .split('\n')
    .filter((line) => line.startsWith('event: '))
    .map((line) => line.slice('event: '.length).trim())
}

/** 取某个事件的第一个 data JSON */
function firstDataOf(sse: string, eventName: string): Record<string, unknown> | null {
  const lines = sse.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== `event: ${eventName}`) continue
    const dataLine = lines.slice(i + 1).find((l) => l.startsWith('data: '))
    if (!dataLine) return null
    try {
      return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return null
}

describe('流式响应中途失败的收尾', () => {
  let server: ProxyServer

  beforeEach(async () => {
    streamMock.mockReset()
    requestMock.mockReset()
    server = new ProxyServer({
      host: LOOPBACK_HOST,
      port: 0,
      logRequests: false,
      maxRetries: 0,
      apiKeys: [makeApiKey({ key: API_KEY })]
    })
    // 单账号：确保没有可切换的备选，走"已发内容 + 无法重试"分支
    server.getAccountPool().addAccount({ id: 'account-1', accessToken: 'fake-token' })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  async function claudeStream(): Promise<string> {
    const response = await fetch(
      `http://${LOOPBACK_HOST}:${server.getListeningPort()}/v1/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4',
          stream: true,
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }]
        })
      }
    )
    expect(response.status).toBe(200)
    return response.text()
  }

  describe('Anthropic /v1/messages', () => {
    it('已吐出内容后失败：补齐 content_block_stop 与 message_delta 再报错', async () => {
      streamMock.mockImplementation(async (_a, _p, onChunk, _onComplete, onError) => {
        await onChunk('partial answer')
        await onError(new Error('upstream exploded mid-stream'))
      })

      const sse = await claudeStream()
      const events = eventSequence(sse)

      // 开了 content block 就必须闭合，否则客户端拿到未闭合的流
      expect(events).toContain('content_block_start')
      expect(events).toContain('content_block_stop')
      // 收尾顺序：内容块先闭合，再 message_delta，最后才是 error
      const stopIdx = events.indexOf('content_block_stop')
      const deltaIdx = events.indexOf('message_delta')
      const errorIdx = events.indexOf('error')
      expect(stopIdx).toBeGreaterThan(-1)
      expect(deltaIdx).toBeGreaterThan(stopIdx)
      expect(errorIdx).toBeGreaterThan(deltaIdx)
    })

    it('截断的 message_delta 用 stop_reason: error，与正常 end_turn 区分', async () => {
      streamMock.mockImplementation(async (_a, _p, onChunk, _onComplete, onError) => {
        await onChunk('partial')
        await onError(new Error('boom'))
      })

      const sse = await claudeStream()
      const delta = firstDataOf(sse, 'message_delta')
      expect((delta?.delta as Record<string, unknown> | undefined)?.stop_reason).toBe('error')
    })

    it('仍然发出 error 事件，且上游原始信息不外泄', async () => {
      streamMock.mockImplementation(async (_a, _p, onChunk, _onComplete, onError) => {
        await onChunk('partial')
        await onError(new Error('upstream exploded at /internal/path'))
      })

      const sse = await claudeStream()
      const error = firstDataOf(sse, 'error')
      expect((error?.error as Record<string, unknown> | undefined)?.type).toBe('api_error')
      // normalizeKiroUpstreamError 会归一为通用文案，不透出上游内部细节
      expect(sse).not.toContain('/internal/path')
    })

    it('一个字都没发就失败：不补收尾帧，只报错', async () => {
      streamMock.mockImplementation(async (_a, _p, _onChunk, _onComplete, onError) => {
        await onError(new Error('failed before any content'))
      })

      const sse = await claudeStream()
      const events = eventSequence(sse)
      // 没开过 content block，不该凭空造一个 stop
      expect(events).not.toContain('content_block_stop')
      expect(events).toContain('error')
    })

    it('正常完成的流不受影响：stop_reason 为 end_turn 且有 message_stop', async () => {
      streamMock.mockImplementation(async (_a, _p, onChunk, onComplete) => {
        await onChunk('all good')
        await onComplete({ inputTokens: 10, outputTokens: 2, credits: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
      })

      const sse = await claudeStream()
      const events = eventSequence(sse)
      expect(events).toContain('content_block_stop')
      expect(events).toContain('message_stop')
      const delta = firstDataOf(sse, 'message_delta')
      expect((delta?.delta as Record<string, unknown> | undefined)?.stop_reason).toBe('end_turn')
      expect(sse).not.toContain('event: error')
    })
  })

  describe('OpenAI 路径已自带合法终止符（回归）', () => {
    it('/v1/chat/completions 中途失败仍以 [DONE] 收尾', async () => {
      streamMock.mockImplementation(async (_a, _p, onChunk, _onComplete, onError) => {
        await onChunk('partial')
        await onError(new Error('mid-stream failure'))
      })

      const response = await fetch(
        `http://${LOOPBACK_HOST}:${server.getListeningPort()}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4',
            stream: true,
            messages: [{ role: 'user', content: 'hello' }]
          })
        }
      )
      const sse = await response.text()
      expect(sse).toContain('data: [DONE]')
      expect(sse).toContain('"error"')
    })
  })
})
