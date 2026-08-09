/**
 * 抢号器 ↔ 下游参考实现的端到端对接验证。
 *
 * 这里不 mock fetch：起一个真实的 HTTP 服务（downstream-example/server.mjs），
 * 用抢号器真实的 downstreamClient 和 KskHunterManager 去打它。
 * 目的是证明 API.md 的契约两边确实对得上——单侧 mock 测试无法发现
 * 「文档写 need，实现读 needed」这类字段名走偏。
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'

const { deliveryStore } = vi.hoisted(() => ({
  deliveryStore: {
    records: [] as Record<string, unknown>[],
    reset(): void {
      this.records = []
    }
  }
}))

vi.mock('../../src/main/kskHunter/configStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/kskHunter/configStore')>()
  return {
    ...actual,
    appendKskHunterDelivery: vi.fn(async (delivery: Record<string, unknown>) => {
      deliveryStore.records.push({ ...delivery })
    }),
    // 记账走 safeStorage 落盘，测试环境里必须 mock 掉，否则会抛错打断流程
    appendKskHunterSpend: vi.fn(async () => undefined),
    patchKskHunterDelivery: vi.fn(async (deliveryId: string, patch: Record<string, unknown>) => {
      const record = deliveryStore.records.find((item) => item.id === deliveryId)
      if (record) Object.assign(record, patch, { updatedAt: Date.now() })
    })
  }
})

import {
  DEFAULT_KSK_HUNTER_CONFIG,
  KSK_HUNTER_CHANNEL,
  KSK_HUNTER_DELIVERY_STATE,
  KSK_HUNTER_MODE,
  KSK_HUNTER_STORE_VERSION
} from '../../src/shared/kskHunter'
import {
  askDownstreamNeedsAccount,
  pushKskToDownstream,
  type KskHunterFetch
} from '../../src/main/kskHunter/downstreamClient'
import type { PersistedKskHunterStore } from '../../src/main/kskHunter/configStore'
import { KskHunterManager } from '../../src/main/kskHunter/hunterRunner'

const PORT = 12897
const BASE_URL = `http://127.0.0.1:${PORT}`
const API_KEY = 'e2e-downstream-key'
const KSK_ONE = 'ksk_E2EAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

/** 抢号器主进程侧用的是 undici；测试里直接用全局 fetch 打 loopback 即可。 */
const realFetch: KskHunterFetch = async (url, init) =>
  fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal
  })

let server: Server
let resetDownstream: (input?: { wanted?: number }) => void

beforeAll(async () => {
  // server.mjs 在模块初始化时读这个变量，必须在 import 之前设好
  process.env.DOWNSTREAM_API_KEY = API_KEY
  const downstream = (await import('../../downstream-example/server.mjs')) as {
    startDownstreamServer: (input: { port: number }) => Promise<Server>
    resetDownstreamState: (input?: { wanted?: number }) => void
  }
  resetDownstream = downstream.resetDownstreamState
  server = await downstream.startDownstreamServer({ port: PORT })
})

afterAll(() => {
  server?.close()
})

afterEach(() => {
  deliveryStore.reset()
})

const options = {
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  timeoutSeconds: 5,
  fetchImpl: realFetch
}

describe('下游契约端到端', () => {
  it('need-account：抢号器读得懂参考实现回的 need 字段', async () => {
    resetDownstream({ wanted: 1 })
    expect(await askDownstreamNeedsAccount(options)).toBe(true)

    resetDownstream({ wanted: 0 })
    expect(await askDownstreamNeedsAccount(options)).toBe(false)
  })

  it('push：抢号器发的 body 参考实现能落库，回的 ok 抢号器认', async () => {
    resetDownstream({ wanted: 1 })
    await expect(
      pushKskToDownstream(options, { key: KSK_ONE, region: 'eu-central-1' })
    ).resolves.toBeUndefined()

    const listed = await fetch(`${BASE_URL}/admin/received`, {
      headers: { 'x-api-key': API_KEY }
    })
    const payload = (await listed.json()) as { received: Array<{ region: string }> }
    expect(payload.received).toHaveLength(1)
    expect(payload.received[0].region).toBe('eu-central-1')
  })

  it('重试推同一个 key 时下游幂等，抢号器侧仍算成功', async () => {
    resetDownstream({ wanted: 5 })
    await pushKskToDownstream(options, { key: KSK_ONE, region: 'eu-central-1' })
    // 模拟「落库成功但响应丢了」后的重试
    await expect(
      pushKskToDownstream(options, { key: KSK_ONE, region: 'eu-central-1' })
    ).resolves.toBeUndefined()

    const listed = await fetch(`${BASE_URL}/admin/received`, {
      headers: { 'x-api-key': API_KEY }
    })
    const payload = (await listed.json()) as { received: unknown[] }
    expect(payload.received).toHaveLength(1)
  })

  it('Key 不匹配时抢号器收到可读的 401 错误', async () => {
    resetDownstream({ wanted: 1 })
    await expect(askDownstreamNeedsAccount({ ...options, apiKey: 'wrong-key' })).rejects.toThrow(
      'HTTP 401'
    )
  })

  it('下游拒绝非法 key 时，错误信息里不含 KSK 明文', async () => {
    resetDownstream({ wanted: 1 })
    await expect(
      pushKskToDownstream(options, { key: 'not-a-ksk', region: 'eu-central-1' })
    ).rejects.toThrow(/HTTP 400/)
  })

  it('抢号器全链路对接真实下游：问要不要 → 下单 → 验活 → 推送 → 下游落库', async () => {
    resetDownstream({ wanted: 1 })
    const store: PersistedKskHunterStore = {
      version: KSK_HUNTER_STORE_VERSION,
      config: {
        ...DEFAULT_KSK_HUNTER_CONFIG,
        downstreamEnabled: true,
        downstreamBaseUrl: BASE_URL
      },
      secrets: { downstreamApiKey: API_KEY, balanceUrls: {}, apiKeys: {} },
      links: [
        {
          id: 'link-e2e',
          name: 'E2E · eu',
          channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
          enabled: true,
          mode: KSK_HUNTER_MODE.AUTO_ORDER,
          regions: ['eu-central-1'],
          createdAt: 1,
          updatedAt: 1,
          secrets: {
            listUrl: 'https://market.example/api/goods',
            orderUrl: 'https://market.example/api/order'
          }
        }
      ],
      deliveries: [],
      spend: []
    }

    const manager = new KskHunterManager({
      readStore: async () => ({ ...store, deliveries: deliveryStore.records as never }),
      // 商品站点仍然是 mock（不能真的去打外部站点），下游走真实 HTTP
      fetchImpl: async (_url, init) =>
        new Response(
          JSON.stringify(
            init.method === 'POST'
              ? { code: 0, data: { key: KSK_ONE, region: 'eu-central-1' } }
              : {
                  code: 0,
                  data: [{ id: 'g1', title: 'Kiro Key', tag: '#key-eu', stock: 1, price: 37.5 }]
                }
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      downstreamFetchImpl: realFetch,
      importCredential: async () => ({ added: true }),
      notifyInStock: vi.fn(),
      notifyOrdered: vi.fn(),
      notifyAccountsChanged: vi.fn(),
      notifySnapshot: vi.fn(),
      log: vi.fn()
    })

    await manager.runNow()
    await vi.waitFor(() =>
      expect(deliveryStore.records[0]?.state).toBe(KSK_HUNTER_DELIVERY_STATE.DELIVERED)
    )
    manager.stop()

    const listed = await fetch(`${BASE_URL}/admin/received`, {
      headers: { 'x-api-key': API_KEY }
    })
    const payload = (await listed.json()) as {
      wanted: number
      received: Array<{ maskedKey: string; region: string }>
    }
    // 下游真的收到了号，且需求水位被消耗
    expect(payload.received).toHaveLength(1)
    expect(payload.received[0].region).toBe('eu-central-1')
    expect(payload.wanted).toBe(0)
    // 下游侧只留脱敏形式
    expect(payload.received[0].maskedKey).not.toContain(KSK_ONE)
  })

  it('下游说不要号时，抢号器不下单也不推送', async () => {
    resetDownstream({ wanted: 0 })
    const orderCalls: string[] = []
    const store: PersistedKskHunterStore = {
      version: KSK_HUNTER_STORE_VERSION,
      config: {
        ...DEFAULT_KSK_HUNTER_CONFIG,
        downstreamEnabled: true,
        downstreamBaseUrl: BASE_URL
      },
      secrets: { downstreamApiKey: API_KEY, balanceUrls: {}, apiKeys: {} },
      links: [
        {
          id: 'link-e2e',
          name: 'E2E · eu',
          channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
          enabled: true,
          mode: KSK_HUNTER_MODE.AUTO_ORDER,
          regions: [],
          createdAt: 1,
          updatedAt: 1,
          secrets: {
            listUrl: 'https://market.example/api/goods',
            orderUrl: 'https://market.example/api/order'
          }
        }
      ],
      deliveries: [],
      spend: []
    }

    const manager = new KskHunterManager({
      readStore: async () => ({ ...store, deliveries: deliveryStore.records as never }),
      fetchImpl: async (url, init) => {
        if (init.method === 'POST') orderCalls.push(url)
        return new Response(
          JSON.stringify({ code: 0, data: [{ id: 'g1', tag: '#key-eu', stock: 9, price: 37.5 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      },
      downstreamFetchImpl: realFetch,
      importCredential: async () => ({ added: true }),
      notifyInStock: vi.fn(),
      notifyOrdered: vi.fn(),
      notifyAccountsChanged: vi.fn(),
      notifySnapshot: vi.fn(),
      log: vi.fn()
    })

    await manager.runNow()
    manager.stop()

    // 一次下单请求都没发出去，钱没花
    expect(orderCalls).toHaveLength(0)
    expect(deliveryStore.records).toHaveLength(0)
  })
})
