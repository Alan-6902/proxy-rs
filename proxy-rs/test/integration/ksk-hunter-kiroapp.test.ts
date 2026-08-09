/**
 * KiroApp 渠道的端到端验证：真实 HTTPS 上游 mock + 真实下游参考实现。
 *
 * 这里两侧都不 mock fetch：
 * - 上游起 kiroapp-mock/server.mjs（自签 TLS，因为 fetchJson 硬约束 https）
 * - 下游起 downstream-example/server.mjs
 * 中间是真实的 KskHunterManager。
 *
 * 目的：证明「查 /api/status → 认出有货 → 问下游要不要 → 下单 → 拿到 ksk → 验活 → 推送」
 * 整条链路在真实 HTTP 上确实通，而不只是单侧 mock 自说自话。
 *
 * 上游为什么是 mock 而不是真站点：不真花钱是明确要求；且真站点的下单契约拿不到
 * （/api-docs 需登录），mock 按 buildOrderRequestBody 的假设实现，拿到文档后一起改。
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { Agent, fetch as undiciFetch } from 'undici'

const { deliveryStore } = vi.hoisted(() => ({
  deliveryStore: {
    records: [] as Record<string, unknown>[],
    spend: [] as Record<string, unknown>[],
    reset(): void {
      this.records = []
      this.spend = []
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
    appendKskHunterSpend: vi.fn(async (entry: Record<string, unknown>) => {
      deliveryStore.spend.push({ ...entry })
    }),
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
  KSK_HUNTER_STORE_VERSION,
  type KskHunterConfig
} from '../../src/shared/kskHunter'
import { isValidKiroApiKey } from '../../src/shared/kiroApiKey'
import { HUNTER_REPORT_EVENT, type HunterReportEvent } from '../../src/shared/hunterReport'
import type { KskHunterFetch } from '../../src/main/kskHunter/downstreamClient'
import type { PersistedKskHunterStore } from '../../src/main/kskHunter/configStore'
import { KskHunterManager } from '../../src/main/kskHunter/hunterRunner'

const UPSTREAM_PORT = 12898
const DOWNSTREAM_PORT = 12899
const UPSTREAM_BASE = `https://127.0.0.1:${UPSTREAM_PORT}`
const DOWNSTREAM_BASE = `http://127.0.0.1:${DOWNSTREAM_PORT}`
const DOWNSTREAM_KEY = 'kiroapp-e2e-key'
const MOCK_TOKEN = 'mock-token'

const LIST_URL = `${UPSTREAM_BASE}/api/status`
const ORDER_URL = `${UPSTREAM_BASE}/api/order?token=${MOCK_TOKEN}`

let upstream: Server
let downstream: Server
let resetUpstream: (overrides?: Record<string, number>) => void
let resetDownstream: (input?: { wanted?: number }) => void
/** 自签证书要显式信任，否则 undici 直接 TLS 失败。 */
let upstreamAgent: Agent

/**
 * 上游走 undici + 自签 CA 的 dispatcher。
 *
 * 刻意不用 rejectUnauthorized:false：那样等于测试里把证书校验整个关掉，
 * 真出了证书问题也发现不了。只信任这一张 mock 证书。
 */
const upstreamFetch: KskHunterFetch = async (url, init) =>
  (await undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    dispatcher: upstreamAgent
  })) as unknown as Response

const downstreamFetch: KskHunterFetch = async (url, init) =>
  fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal
  })

/** 断言用的直接读取。KskHunterFetch 的 init 必填 headers/signal，测试里不必凑齐。 */
async function readUpstreamStatus(): Promise<Record<string, unknown>> {
  const response = await undiciFetch(LIST_URL, { dispatcher: upstreamAgent })
  return (await response.json()) as Record<string, unknown>
}

beforeAll(async () => {
  process.env.KIROAPP_MOCK_TOKEN = MOCK_TOKEN
  process.env.DOWNSTREAM_API_KEY = DOWNSTREAM_KEY

  const mock = (await import('../../kiroapp-mock/server.mjs')) as {
    startKiroAppMock: (input: { port: number }) => Promise<Server>
    resetKiroAppMockState: (overrides?: Record<string, number>) => void
    CERT_PATH: string
  }
  resetUpstream = mock.resetKiroAppMockState
  upstreamAgent = new Agent({ connect: { ca: readFileSync(mock.CERT_PATH) } })
  upstream = await mock.startKiroAppMock({ port: UPSTREAM_PORT })

  const down = (await import('../../downstream-example/server.mjs')) as {
    startDownstreamServer: (input: { port: number }) => Promise<Server>
    resetDownstreamState: (input?: { wanted?: number }) => void
  }
  resetDownstream = down.resetDownstreamState
  downstream = await down.startDownstreamServer({ port: DOWNSTREAM_PORT })
})

afterAll(async () => {
  upstream?.close()
  downstream?.close()
  await upstreamAgent?.close()
})

afterEach(() => {
  deliveryStore.reset()
})

function kiroAppStore(config: Partial<KskHunterConfig> = {}): PersistedKskHunterStore {
  return {
    version: KSK_HUNTER_STORE_VERSION,
    config: { ...DEFAULT_KSK_HUNTER_CONFIG, ...config },
    secrets: { downstreamApiKey: DOWNSTREAM_KEY, balanceUrls: {}, apiKeys: {} },
    links: [
      {
        id: 'link-kiroapp',
        name: 'KiroApp · eu',
        channel: KSK_HUNTER_CHANNEL.KIRO_APP,
        enabled: true,
        mode: KSK_HUNTER_MODE.AUTO_ORDER,
        regions: ['eu-central-1'],
        createdAt: 1,
        updatedAt: 1,
        secrets: { listUrl: LIST_URL, orderUrl: ORDER_URL }
      }
    ],
    deliveries: [],
    spend: []
  }
}

function makeManager(
  store: PersistedKskHunterStore,
  events: HunterReportEvent[],
  overrides: Partial<ConstructorParameters<typeof KskHunterManager>[0]> = {}
): KskHunterManager {
  return new KskHunterManager({
    readStore: async () => ({ ...store, deliveries: deliveryStore.records as never }),
    fetchImpl: upstreamFetch,
    downstreamFetchImpl: downstreamFetch,
    importCredential: async () => ({ added: true }),
    notifyInStock: vi.fn(),
    notifyOrdered: vi.fn(),
    notifyAccountsChanged: vi.fn(),
    notifySnapshot: vi.fn(),
    appendReportEvent: async (event) => {
      events.push(event)
    },
    readReportEvents: async () => events,
    log: vi.fn(),
    ...overrides
  })
}

describe('KiroApp 渠道端到端', () => {
  it('真实 HTTPS 拉 /api/status，认出 eu 有货与价格', async () => {
    resetUpstream({ stock_eu: 2, stock_us: 0, price_eu: 30, price_us: 50 })
    // 形状与真站点一致，字段名不能走偏
    expect(await readUpstreamStatus()).toMatchObject({
      stock_eu: 2,
      stock_us: 0,
      price_eu: 30,
      price_us: 50
    })
  })

  it('全链路：查状态 → 问下游 → 下单 → 验活 → 推送 → 下游落库', async () => {
    resetUpstream({ stock_eu: 1 })
    resetDownstream({ wanted: 1 })
    const events: HunterReportEvent[] = []
    const imported: Array<{ key: string; region: string }> = []
    const store = kiroAppStore({ downstreamEnabled: true, downstreamBaseUrl: DOWNSTREAM_BASE })
    const manager = makeManager(store, events, {
      importCredential: async (input) => {
        imported.push({ key: input.key, region: input.region })
        return { added: true }
      }
    })

    await manager.runNow()
    await vi.waitFor(() =>
      expect(deliveryStore.records[0]?.state).toBe(KSK_HUNTER_DELIVERY_STATE.DELIVERED)
    )
    manager.stop()

    // 下单拿到的是格式合法的 ksk，区域按 eu 商品解析
    expect(imported).toHaveLength(1)
    expect(isValidKiroApiKey(imported[0].key)).toBe(true)
    expect(imported[0].region).toBe('eu-central-1')

    // 花费按 price_eu 记账（渠道系数 1，原币即人民币）
    expect(deliveryStore.spend[0]).toMatchObject({
      channel: KSK_HUNTER_CHANNEL.KIRO_APP,
      amountUnit: 30,
      amountCny: 30
    })

    // 下游真的收到号且水位被消耗
    const listed = await fetch(`${DOWNSTREAM_BASE}/admin/received`, {
      headers: { 'x-api-key': DOWNSTREAM_KEY }
    })
    const received = (await listed.json()) as {
      wanted: number
      received: Array<{ maskedKey: string; region: string }>
    }
    expect(received.received).toHaveLength(1)
    expect(received.received[0].region).toBe('eu-central-1')
    expect(received.wanted).toBe(0)
    // 下游侧只留脱敏形式，不该出现完整 key
    expect(received.received[0].maskedKey).toContain('...')

    // 上游库存被真的扣掉了
    expect(await readUpstreamStatus()).toMatchObject({ stock_eu: 0 })

    // 报表事件按顺序记全
    expect(events.map((item) => item.type)).toEqual([
      HUNTER_REPORT_EVENT.RESTOCK,
      HUNTER_REPORT_EVENT.ORDERED,
      HUNTER_REPORT_EVENT.DELIVERED
    ])
    expect(events[1]).toMatchObject({ costUnit: 30, costCny: 30, unitLabel: 'CNY' })
  })

  it('无货时不下单，库存不动', async () => {
    resetUpstream({ stock_eu: 0, stock_us: 0 })
    resetDownstream({ wanted: 1 })
    const events: HunterReportEvent[] = []
    const store = kiroAppStore({ downstreamEnabled: true, downstreamBaseUrl: DOWNSTREAM_BASE })
    const manager = makeManager(store, events)

    const status = await manager.runNow()
    manager.stop()

    expect(status.totalOrdered).toBe(0)
    expect(deliveryStore.records).toHaveLength(0)
    // 无货不是错误：链接状态应当健康，只是 lastInStock 为 false
    expect(manager.linkRuntimeOf('link-kiroapp').lastInStock).toBe(false)
    expect(manager.linkRuntimeOf('link-kiroapp').lastError).toBeUndefined()
  })

  it('区域白名单只放 eu 时，us 有货也不买', async () => {
    resetUpstream({ stock_eu: 0, stock_us: 5 })
    resetDownstream({ wanted: 1 })
    const events: HunterReportEvent[] = []
    const store = kiroAppStore({ downstreamEnabled: true, downstreamBaseUrl: DOWNSTREAM_BASE })
    const manager = makeManager(store, events)

    const status = await manager.runNow()
    manager.stop()

    expect(status.totalOrdered).toBe(0)
    expect(await readUpstreamStatus()).toMatchObject({ stock_us: 5 })
  })

  it('下游说不要号时一次下单请求都不发，钱没花', async () => {
    resetUpstream({ stock_eu: 3 })
    resetDownstream({ wanted: 0 })
    const events: HunterReportEvent[] = []
    const store = kiroAppStore({ downstreamEnabled: true, downstreamBaseUrl: DOWNSTREAM_BASE })
    const manager = makeManager(store, events)

    await manager.runNow()
    manager.stop()

    expect(deliveryStore.records).toHaveLength(0)
    // 库存一个没少，说明下单请求真的没发出去
    expect(await readUpstreamStatus()).toMatchObject({ stock_eu: 3 })
  })

  it('预算不够时拦在下单前，库存不动', async () => {
    resetUpstream({ stock_eu: 2, price_eu: 30 })
    resetDownstream({ wanted: 1 })
    const events: HunterReportEvent[] = []
    // 上限 10 元、单价 30，必然拦下
    const store = kiroAppStore({
      downstreamEnabled: true,
      downstreamBaseUrl: DOWNSTREAM_BASE,
      dailyLimitCny: 10
    })
    const manager = makeManager(store, events)

    await manager.runNow()
    manager.stop()

    expect(deliveryStore.records).toHaveLength(0)
    expect(events.some((item) => item.type === HUNTER_REPORT_EVENT.BLOCKED)).toBe(true)
    expect(await readUpstreamStatus()).toMatchObject({ stock_eu: 2 })
  })

  it('下单地址 token 不对时报可读错误，且不留下交付记录', async () => {
    resetUpstream({ stock_eu: 1 })
    resetDownstream({ wanted: 1 })
    const events: HunterReportEvent[] = []
    const store = kiroAppStore({ downstreamEnabled: true, downstreamBaseUrl: DOWNSTREAM_BASE })
    store.links[0].secrets.orderUrl = `${UPSTREAM_BASE}/api/order?token=wrong`
    const manager = makeManager(store, events)

    await manager.runNow()
    manager.stop()

    expect(manager.linkRuntimeOf('link-kiroapp').lastError).toContain('401')
    expect(deliveryStore.records).toHaveLength(0)
  })

  it('验活失败的号标 dead_key，不推给下游', async () => {
    resetUpstream({ stock_eu: 1 })
    resetDownstream({ wanted: 1 })
    const events: HunterReportEvent[] = []
    const store = kiroAppStore({ downstreamEnabled: true, downstreamBaseUrl: DOWNSTREAM_BASE })
    const manager = makeManager(store, events, {
      importCredential: async () => {
        throw new Error('AccountSuspendedException')
      }
    })

    await manager.runNow()
    manager.stop()

    expect(deliveryStore.records[0]).toMatchObject({
      state: KSK_HUNTER_DELIVERY_STATE.DEAD_KEY
    })
    // 钱已经花了，账要记上
    expect(deliveryStore.spend).toHaveLength(1)
    const listed = await fetch(`${DOWNSTREAM_BASE}/admin/received`, {
      headers: { 'x-api-key': DOWNSTREAM_KEY }
    })
    expect((await listed.json()) as { received: unknown[] }).toMatchObject({ received: [] })
  })

  it('明文 HTTP 的商品地址被拒，不放行 loopback', async () => {
    resetUpstream({ stock_eu: 1 })
    const events: HunterReportEvent[] = []
    const store = kiroAppStore()
    store.links[0].secrets.listUrl = `http://127.0.0.1:${UPSTREAM_PORT}/api/status`
    const manager = makeManager(store, events)

    await manager.runNow()
    manager.stop()

    expect(manager.linkRuntimeOf('link-kiroapp').lastError).toContain('HTTPS')
  })
})
