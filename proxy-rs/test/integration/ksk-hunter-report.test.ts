import { describe, expect, it, vi } from 'vitest'

/**
 * 抢号报表：聚合口径、事件流解析，以及 runner 在什么时机记事件。
 *
 * runner 侧的落盘走 deps.appendReportEvent 注入内存实现，
 * 既不碰 safeStorage 也不写真实文件。
 */

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
  HUNTER_REPORT_EVENT,
  HUNTER_REPORT_WINDOW_DAYS,
  hunterReportDateRange,
  hunterReportDayStart,
  summarizeHunterReport,
  type HunterReportEvent
} from '../../src/shared/hunterReport'
import {
  KSK_HUNTER_BUDGET_BLOCK,
  KSK_HUNTER_CHANNEL,
  KSK_HUNTER_DELIVERY_MAX_ATTEMPTS,
  KSK_HUNTER_DELIVERY_STATE,
  KSK_HUNTER_MODE,
  KSK_HUNTER_STORE_VERSION,
  DEFAULT_KSK_HUNTER_CONFIG,
  type KskHunterConfig
} from '../../src/shared/kskHunter'
import {
  normalizeHunterReportEvent,
  parseHunterReportEvents
} from '../../src/main/kskHunter/reportStore'
import { KskHunterManager } from '../../src/main/kskHunter/hunterRunner'
import type {
  PersistedKskHunterLink,
  PersistedKskHunterStore
} from '../../src/main/kskHunter/configStore'

const KSK_ONE = `ksk_${'a'.repeat(40)}`

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function hunterLink(overrides: Partial<PersistedKskHunterLink> = {}): PersistedKskHunterLink {
  return {
    id: 'link-1',
    name: 'Kiro Market · eu',
    channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
    enabled: true,
    mode: KSK_HUNTER_MODE.AUTO_ORDER,
    regions: [],
    createdAt: 1,
    updatedAt: 1,
    secrets: {
      listUrl: 'https://market.example/api/list',
      orderUrl: 'https://market.example/api/buy'
    },
    ...overrides
  }
}

function hunterStore(
  links: PersistedKskHunterLink[],
  config: Partial<KskHunterConfig> = {}
): PersistedKskHunterStore {
  return {
    version: KSK_HUNTER_STORE_VERSION,
    config: { ...DEFAULT_KSK_HUNTER_CONFIG, ...config },
    secrets: { downstreamApiKey: 'downstream-key', balanceUrls: {} },
    links,
    deliveries: [],
    spend: []
  }
}

function event(overrides: Partial<HunterReportEvent> = {}): HunterReportEvent {
  return {
    at: Date.now(),
    type: HUNTER_REPORT_EVENT.ORDERED,
    channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
    linkId: 'link-1',
    linkName: 'Kiro Market · eu',
    ...overrides
  }
}

describe('报表日期窗口', () => {
  it('按本地自然日切分，不受 UTC 偏移影响', () => {
    // 东八区凌晨 1 点：按 UTC 切会归到前一天
    const at = new Date(2026, 7, 8, 1, 30).getTime()
    const start = hunterReportDayStart(at)
    expect(new Date(start).getDate()).toBe(8)
    expect(new Date(start).getHours()).toBe(0)
  })

  it('日期序列含首尾且连续，缺数据的天也在', () => {
    const range = hunterReportDateRange(7, new Date(2026, 7, 8, 15, 0).getTime())
    expect(range).toHaveLength(7)
    expect(range[0].date).toBe('2026-08-02')
    expect(range[6].date).toBe('2026-08-08')
  })

  it('默认窗口是 30 天', () => {
    expect(HUNTER_REPORT_WINDOW_DAYS).toBe(30)
    const report = summarizeHunterReport({ events: [] })
    expect(report.daily).toHaveLength(30)
  })
})

describe('报表聚合', () => {
  const now = new Date(2026, 7, 8, 12, 0).getTime()
  const dayMs = 24 * 60 * 60_000

  it('按天汇总计次与花费，空白天补 0 而不是缺项', () => {
    const report = summarizeHunterReport({
      events: [
        event({ at: now - 2 * dayMs, type: HUNTER_REPORT_EVENT.RESTOCK }),
        event({ at: now - 2 * dayMs, costUnit: 30, costCny: 30 }),
        event({ at: now, costUnit: 20, costCny: 20 })
      ],
      days: 3,
      now
    })

    expect(report.daily.map((day) => day.orders)).toEqual([1, 0, 1])
    expect(report.daily.map((day) => day.spendCny)).toEqual([30, 0, 20])
    expect(report.totals.spendCny).toBe(50)
    expect(report.totals.activeDays).toBe(2)
  })

  it('窗口外的事件不计进聚合，但仍计进总条数与最早时间', () => {
    const report = summarizeHunterReport({
      events: [
        event({ at: now - 40 * dayMs, costUnit: 99, costCny: 99 }),
        event({ at: now, costUnit: 10, costCny: 10 })
      ],
      days: 7,
      now
    })

    expect(report.totals.orders).toBe(1)
    expect(report.totals.spendCny).toBe(10)
    // 历史是全量保留的，报表要能告诉用户攒了多久
    expect(report.totalEventCount).toBe(2)
    expect(report.earliestEventAt).toBe(now - 40 * dayMs)
  })

  it('转化率按放货/下单/交付分别算，分母为 0 时给 undefined 而不是 0', () => {
    const report = summarizeHunterReport({
      events: [
        event({ type: HUNTER_REPORT_EVENT.RESTOCK, at: now }),
        event({ type: HUNTER_REPORT_EVENT.RESTOCK, at: now }),
        event({ at: now, costUnit: 10, costCny: 10 }),
        event({ at: now, type: HUNTER_REPORT_EVENT.DELIVERED })
      ],
      days: 7,
      now
    })

    expect(report.totals.orderRate).toBeCloseTo(0.5)
    expect(report.totals.deliverRate).toBe(1)
    expect(report.totals.deadKeyRate).toBe(0)

    const blank = summarizeHunterReport({ events: [], days: 7, now })
    expect(blank.totals.orderRate).toBeUndefined()
    expect(blank.totals.deliverRate).toBeUndefined()
    expect(blank.totals.avgCostCny).toBeUndefined()
  })

  it('均价只算有价格的单，未知价格的不按 0 拉低均价', () => {
    const report = summarizeHunterReport({
      events: [
        event({ at: now, costUnit: 40, costCny: 40 }),
        event({ at: now, costUnit: undefined, costCny: 0 })
      ],
      days: 7,
      now
    })

    expect(report.totals.orders).toBe(2)
    // 两单里只有一单有价格，均价必须是 40 而不是 20
    expect(report.totals.avgCostCny).toBe(40)
  })

  it('分渠道行带原币与人民币两套口径，单位取事件里的历史值', () => {
    const report = summarizeHunterReport({
      events: [
        event({
          at: now,
          channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
          costUnit: 100,
          costCny: 25,
          unitLabel: 'CRD'
        }),
        event({
          at: now,
          channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
          costUnit: 200,
          costCny: 50,
          unitLabel: 'CRD'
        })
      ],
      days: 7,
      now
    })

    const ceo = report.byChannel.find((row) => row.channel === KSK_HUNTER_CHANNEL.KIRO_CEO)
    expect(ceo).toMatchObject({
      unitLabel: 'CRD',
      spendUnit: 300,
      spendCny: 75,
      avgCostUnit: 150,
      avgCostCny: 37.5,
      orders: 2
    })
    // 没有事件的渠道不出现在明细里，不用 0 行占位
    expect(report.byChannel).toHaveLength(1)
  })

  it('分链接行按下单数降序，链接改名后取最新名字', () => {
    const report = summarizeHunterReport({
      events: [
        event({ at: now - dayMs, linkId: 'a', linkName: '旧名', costUnit: 1, costCny: 1 }),
        event({ at: now, linkId: 'a', linkName: '新名', costUnit: 1, costCny: 1 }),
        event({ at: now, linkId: 'b', linkName: 'B 链接', costUnit: 1, costCny: 1 })
      ],
      days: 7,
      now
    })

    expect(report.byLink.map((row) => row.linkId)).toEqual(['a', 'b'])
    expect(report.byLink[0].linkName).toBe('新名')
    expect(report.byLink[0].orders).toBe(2)
  })

  it('放货时段按本地小时分桶', () => {
    const report = summarizeHunterReport({
      events: [
        event({ at: new Date(2026, 7, 8, 9, 5).getTime(), type: HUNTER_REPORT_EVENT.RESTOCK }),
        event({ at: new Date(2026, 7, 8, 9, 40).getTime(), type: HUNTER_REPORT_EVENT.RESTOCK }),
        event({ at: new Date(2026, 7, 7, 21, 0).getTime(), type: HUNTER_REPORT_EVENT.RESTOCK })
      ],
      days: 7,
      now
    })

    expect(report.restockByHour).toHaveLength(24)
    expect(report.restockByHour[9]).toBe(2)
    expect(report.restockByHour[21]).toBe(1)
    expect(report.restockByHour[0]).toBe(0)
  })
})

describe('事件流解析', () => {
  it('单行损坏只丢那一行，其余历史仍可读', () => {
    const good = JSON.stringify(event({ at: 1000 }))
    const events = parseHunterReportEvents(`${good}\n{"broken":\n\n${good}\n`)
    expect(events).toHaveLength(2)
  })

  it('认不出类型或渠道的记录直接丢弃，不污染聚合', () => {
    expect(normalizeHunterReportEvent({ at: 1, type: 'nope', channel: 'kiro_market' })).toBeNull()
    expect(normalizeHunterReportEvent({ at: 1, type: 'ordered', channel: 'unknown' })).toBeNull()
    expect(
      normalizeHunterReportEvent({ at: 0, type: 'ordered', channel: 'kiro_market' })
    ).toBeNull()
    expect(normalizeHunterReportEvent(null)).toBeNull()
  })

  it('解析结果按时间升序，乱序写入也能画出正确曲线', () => {
    const raw = [
      JSON.stringify(event({ at: 3000 })),
      JSON.stringify(event({ at: 1000 })),
      JSON.stringify(event({ at: 2000 }))
    ].join('\n')
    expect(parseHunterReportEvents(raw).map((item) => item.at)).toEqual([1000, 2000, 3000])
  })

  it('保留拦单原因与放货数量这类分类型字段', () => {
    const blocked = normalizeHunterReportEvent({
      at: 5,
      type: HUNTER_REPORT_EVENT.BLOCKED,
      channel: KSK_HUNTER_CHANNEL.KIRO_DROP,
      linkId: 'l',
      linkName: 'L',
      reason: KSK_HUNTER_BUDGET_BLOCK.GLOBAL
    })
    expect(blocked?.reason).toBe(KSK_HUNTER_BUDGET_BLOCK.GLOBAL)

    const restock = normalizeHunterReportEvent({
      at: 5,
      type: HUNTER_REPORT_EVENT.RESTOCK,
      channel: KSK_HUNTER_CHANNEL.KIRO_DROP,
      linkId: 'l',
      linkName: 'L',
      offerCount: 3
    })
    expect(restock?.offerCount).toBe(3)
  })
})

describe('runner 记事件的时机', () => {
  type HunterDeps = ConstructorParameters<typeof KskHunterManager>[0]

  function makeDeps(
    store: PersistedKskHunterStore,
    events: HunterReportEvent[],
    overrides: Partial<HunterDeps> = {}
  ): HunterDeps {
    return {
      readStore: async () => ({ ...store, deliveries: deliveryStore.records as never }),
      fetchImpl: async () => jsonResponse({ code: 0, data: [] }),
      importCredential: async () => ({ added: true }),
      notifyInStock: vi.fn(),
      notifyOrdered: vi.fn(),
      notifyAccountsChanged: vi.fn(),
      notifySnapshot: vi.fn(),
      appendReportEvent: async (item) => {
        events.push(item)
      },
      readReportEvents: async () => events,
      log: vi.fn(),
      ...overrides
    }
  }

  /** 有货 + 带价格的列表，配合下单响应，构造一次完整抢号。 */
  function inStockFetch(price?: number) {
    return async (_url: string, init: { method: string }): Promise<Response> =>
      init.method === 'POST'
        ? jsonResponse({ code: 0, data: { key: KSK_ONE, region: 'eu-central-1' } })
        : jsonResponse({
            code: 0,
            data: [{ id: 'g1', title: 'Kiro Key', tag: '#key-eu', stock: 1, price }]
          })
  }

  it('放货只在无货→有货那一刻记一次，连续多轮有货不重复记', async () => {
    deliveryStore.reset()
    const events: HunterReportEvent[] = []
    const store = hunterStore([hunterLink({ mode: KSK_HUNTER_MODE.NOTIFY })])
    const manager = new KskHunterManager(
      makeDeps(store, events, {
        fetchImpl: async () =>
          jsonResponse({ code: 0, data: [{ id: 'g1', tag: '#key-eu', stock: 2 }] })
      })
    )

    await manager.runNow()
    await manager.runNow()
    await manager.runNow()
    manager.stop()

    const restocks = events.filter((item) => item.type === HUNTER_REPORT_EVENT.RESTOCK)
    expect(restocks).toHaveLength(1)
    expect(restocks[0]).toMatchObject({ linkId: 'link-1', offerCount: 1 })
  })

  it('无货一轮之后再放货，重新记一次', async () => {
    deliveryStore.reset()
    const events: HunterReportEvent[] = []
    let stock = 2
    const store = hunterStore([hunterLink({ mode: KSK_HUNTER_MODE.NOTIFY })])
    const manager = new KskHunterManager(
      makeDeps(store, events, {
        fetchImpl: async () =>
          jsonResponse({ code: 0, data: [{ id: 'g1', tag: '#key-eu', stock }] })
      })
    )

    await manager.runNow()
    stock = 0
    await manager.runNow()
    stock = 3
    await manager.runNow()
    manager.stop()

    expect(events.filter((item) => item.type === HUNTER_REPORT_EVENT.RESTOCK)).toHaveLength(2)
  })

  it('下单记 ordered 并带上花费与单位', async () => {
    deliveryStore.reset()
    const events: HunterReportEvent[] = []
    const store = hunterStore([hunterLink({ channel: KSK_HUNTER_CHANNEL.KIRO_CEO })], {
      billing: {
        ...DEFAULT_KSK_HUNTER_CONFIG.billing,
        [KSK_HUNTER_CHANNEL.KIRO_CEO]: {
          unitLabel: 'CRD',
          cnyPerUnit: 0.25,
          dailyLimitUnit: 0,
          lowBalanceThresholdUnit: 0
        }
      }
    })
    const manager = new KskHunterManager(makeDeps(store, events, { fetchImpl: inStockFetch(120) }))

    await manager.runNow()
    manager.stop()

    const ordered = events.find((item) => item.type === HUNTER_REPORT_EVENT.ORDERED)
    expect(ordered).toMatchObject({
      channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
      costUnit: 120,
      costCny: 30,
      unitLabel: 'CRD',
      region: 'eu-central-1'
    })
  })

  it('验活失败记 dead_key，不记 delivered', async () => {
    deliveryStore.reset()
    const events: HunterReportEvent[] = []
    const store = hunterStore([hunterLink()], { downstreamEnabled: true })
    const manager = new KskHunterManager(
      makeDeps(store, events, {
        fetchImpl: inStockFetch(10),
        downstreamFetchImpl: async (url) =>
          jsonResponse(url.endsWith('/need-account') ? { need: true } : { ok: true }),
        importCredential: async () => {
          throw new Error('AccountSuspendedException')
        }
      })
    )

    await manager.runNow()
    manager.stop()

    expect(events.some((item) => item.type === HUNTER_REPORT_EVENT.DEAD_KEY)).toBe(true)
    expect(events.some((item) => item.type === HUNTER_REPORT_EVENT.DELIVERED)).toBe(false)
  })

  it('推送成功记 delivered', async () => {
    deliveryStore.reset()
    const events: HunterReportEvent[] = []
    const store = hunterStore([hunterLink()], { downstreamEnabled: true })
    const manager = new KskHunterManager(
      makeDeps(store, events, {
        fetchImpl: inStockFetch(10),
        downstreamFetchImpl: async (url) =>
          jsonResponse(url.endsWith('/need-account') ? { need: true } : { ok: true })
      })
    )

    await manager.runNow()
    await vi.waitFor(() =>
      expect(events.some((item) => item.type === HUNTER_REPORT_EVENT.DELIVERED)).toBe(true)
    )
    manager.stop()
  })

  it('推送失败只在重试耗尽时记一次，中途每次失败都不记', async () => {
    deliveryStore.reset()
    const events: HunterReportEvent[] = []
    const store = hunterStore([hunterLink()], { downstreamEnabled: true })
    deliveryStore.records.push({
      id: 'd1',
      linkId: 'link-1',
      linkName: 'Kiro Market · eu',
      channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
      key: KSK_ONE,
      region: 'eu-central-1',
      state: KSK_HUNTER_DELIVERY_STATE.PENDING,
      attempts: KSK_HUNTER_DELIVERY_MAX_ATTEMPTS - 1,
      createdAt: 1,
      updatedAt: 1
    })
    const manager = new KskHunterManager(
      makeDeps(store, events, {
        downstreamFetchImpl: async () => new Response('down', { status: 503 })
      })
    )

    await manager.start()
    await vi.waitFor(() =>
      expect(deliveryStore.records[0]?.state).toBe(KSK_HUNTER_DELIVERY_STATE.FAILED)
    )
    manager.stop()

    expect(events.filter((item) => item.type === HUNTER_REPORT_EVENT.DELIVERY_FAILED)).toHaveLength(
      1
    )
  })

  it('预算拦单同日同因只记一次，不随 3 秒一轮刷爆事件流', async () => {
    deliveryStore.reset()
    const events: HunterReportEvent[] = []
    // 上限 5 元、单价 50，必然每轮都被全局预算拦下
    const store = hunterStore([hunterLink()], { dailyLimitCny: 5 })
    const manager = new KskHunterManager(makeDeps(store, events, { fetchImpl: inStockFetch(50) }))

    await manager.runNow()
    await manager.runNow()
    await manager.runNow()
    manager.stop()

    const blocks = events.filter((item) => item.type === HUNTER_REPORT_EVENT.BLOCKED)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].reason).toBe(KSK_HUNTER_BUDGET_BLOCK.GLOBAL)
    expect(events.some((item) => item.type === HUNTER_REPORT_EVENT.ORDERED)).toBe(false)
  })

  it('报表事件写盘失败不打断抢号主流程', async () => {
    deliveryStore.reset()
    const events: HunterReportEvent[] = []
    const store = hunterStore([hunterLink()])
    const manager = new KskHunterManager(
      makeDeps(store, events, {
        fetchImpl: inStockFetch(10),
        appendReportEvent: async () => {
          throw new Error('disk full')
        }
      })
    )

    const status = await manager.runNow()
    manager.stop()

    // 号照样买到并落盘了
    expect(status.totalOrdered).toBe(1)
    expect(deliveryStore.records).toHaveLength(1)
  })

  it('manager.report 用注入的事件流聚合出报表', async () => {
    deliveryStore.reset()
    const events: HunterReportEvent[] = [
      event({ at: Date.now(), costUnit: 10, costCny: 10 }),
      event({ at: Date.now(), type: HUNTER_REPORT_EVENT.RESTOCK })
    ]
    const store = hunterStore([hunterLink()])
    const manager = new KskHunterManager(makeDeps(store, events))

    const report = await manager.report(7)
    manager.stop()

    expect(report.days).toBe(7)
    expect(report.totals.orders).toBe(1)
    expect(report.totals.restocks).toBe(1)
    expect(report.totals.spendCny).toBe(10)
  })
})
