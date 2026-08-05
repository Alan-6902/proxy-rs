import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProxyServer, type ProxyServerEvents } from '../../src/main/proxy/proxyServer'

const LOOPBACK_HOST = '127.0.0.1'
const runningProxies: ProxyServer[] = []

function createProxy(events: ProxyServerEvents = {}): ProxyServer {
  const proxy = new ProxyServer(
    { autoStart: true, enabled: true, host: LOOPBACK_HOST, port: 0 },
    events
  )
  runningProxies.push(proxy)
  return proxy
}

function nativeServer(proxy: ProxyServer): net.Server {
  const server = (proxy as unknown as { server: net.Server | null }).server
  if (!server) throw new Error('expected proxy server')
  return server
}

function once(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()))
}

async function closeUnexpectedly(proxy: ProxyServer): Promise<void> {
  const server = nativeServer(proxy)
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

afterEach(async () => {
  vi.useRealTimers()
  while (runningProxies.length > 0) await runningProxies.pop()!.stop(0)
})

describe('ProxyServer lifecycle isolation', () => {
  it('clears a completed stop timer before restart so it cannot reach the replacement server', async () => {
    vi.useFakeTimers()
    vi.clearAllTimers()
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    const proxy = createProxy()
    await proxy.start()
    await proxy.stop(25)
    expect((proxy as unknown as { cleanupTimer: unknown }).cleanupTimer).toBeNull()
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1)

    await proxy.start()
    const replacement = nativeServer(proxy)
    const socket = net.createConnection({ host: LOOPBACK_HOST, port: proxy.getListeningPort() })
    await once(socket, 'connect')

    await vi.advanceTimersByTimeAsync(26)

    expect(proxy.isRunning()).toBe(true)
    expect(nativeServer(proxy)).toBe(replacement)
    expect(socket.destroyed).toBe(false)
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1)
    socket.destroy()
  })

  it('delegates an unexpected native close to the main lifecycle gate, which can create a replacement', async () => {
    let replacement: ProxyServer | undefined
    let callbackFinished!: () => void
    const callbackFinishedPromise = new Promise<void>((resolve) => {
      callbackFinished = resolve
    })
    const proxy = createProxy({
      onUnexpectedClose: async () => {
        replacement = createProxy()
        await replacement.start()
        callbackFinished()
      }
    })
    await proxy.start()
    const closedServer = nativeServer(proxy)

    await closeUnexpectedly(proxy)
    await callbackFinishedPromise

    expect(proxy.isRunning()).toBe(false)
    expect(replacement).toBeDefined()
    expect(replacement).not.toBe(proxy)
    expect(replacement!.isRunning()).toBe(true)
    expect(nativeServer(replacement!)).not.toBe(closedServer)
  })

  it('leaves the proxy stopped when the main lifecycle gate blocks the unexpected-close callback', async () => {
    let gateCalled!: () => void
    const gateCalledPromise = new Promise<void>((resolve) => {
      gateCalled = resolve
    })
    const unexpectedClose = vi.fn(async () => {
      gateCalled()
    })
    const proxy = createProxy({ onUnexpectedClose: unexpectedClose })
    await proxy.start()

    await closeUnexpectedly(proxy)
    await gateCalledPromise

    expect(unexpectedClose).toHaveBeenCalledTimes(1)
    expect(proxy.isRunning()).toBe(false)
  })

  it('does not call the unexpected-close callback for a normal stop', async () => {
    const unexpectedClose = vi.fn(async () => undefined)
    const proxy = createProxy({ onUnexpectedClose: unexpectedClose })
    await proxy.start()

    await proxy.stop(0)
    await Promise.resolve()

    expect(unexpectedClose).not.toHaveBeenCalled()
    expect(proxy.isRunning()).toBe(false)
  })
})
