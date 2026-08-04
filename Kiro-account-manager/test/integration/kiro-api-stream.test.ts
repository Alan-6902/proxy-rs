import { afterEach, describe, expect, it, vi } from 'vitest'
import { callKiroApiStream } from '../../src/main/proxy/kiroApi'

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
