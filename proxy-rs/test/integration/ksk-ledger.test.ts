import { describe, expect, it, vi } from 'vitest'

/**
 * 抢号台账：消耗口径、状态判定、报表聚合，以及 runner 在什么时机记账。
 *
 * runner 侧的落盘走 deps.recordLedgerPurchase 注入内存实现，
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
  KSK_LEDGER_RETIRE_REASON,
  KSK_LEDGER_SORT,
  KSK_LEDGER_STATE,
  applyLedgerObservation,
  formatLedgerDuration,
  resolveLedgerAliveMs,
  resolveLedgerState,
  summarizeKskLedger,
  type KskLedgerEntry,
  type KskLedgerObservation
} from '../../src/shared/kskLedger'
import {
  normalizeKskLedgerEntry,
  normalizeKskLedgerPayload
} from '../../src/main/kskHunter/ledgerStore'
import {
  KSK_HUNTER_CHANNEL,
  KSK_HUNTER_DELIVERY_STATE,
  KSK_HUNTER_MODE,
  KSK_HUNTER_STORE_VERSION,
  DEFAULT_KSK_HUNTER_CONFIG,
  type KskHunterConfig
} from '../../src/shared/kskHunter'
import { KskHunterManager } from '../../src/main/kskHunter/hunterRunner'
import type {
  PersistedKskHunterLink,
  PersistedKskHunterStore
} from '../../src/main/kskHunter/configStore'

const KSK_ONE = `ksk_${'a'.repeat(40)}`
const ACCOUNT_ONE = 'acct-1'
const HOUR = 3_600_000

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0)

/** 一条最小台账记录：买到了、基线已记、还没消耗。 */
function entry(overrides: Partial<KskLedgerEntry> = {}): KskLedgerEntry {
  return {
    accountId: ACCOUNT_ONE,
    maskedKey: 'ksk_...aaaa',
    region: 'us-east-1',
    channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
    linkId: 'link-1',
    linkName: 'Kiro CEO · 美区',
    purchasedAt: NOW - 10 * HOUR,
    costUnit: 50,
    costCny: 50,
    unitLabel: '积分',
    baselineUsage: 0,
    currentUsage: 0,
    usageLimit: 10_000,
    carriedCredits: 0,
    usedCredits: 0,
    ...overrides
  }
}

function observation(overrides: Partial<KskLedgerObservation> = {}): KskLedgerObservation {
  return { accountId: ACCOUNT_ONE, currentUsage: 0, usageLimit: 10_000, ...overrides }
}

describe('台账 · 消耗口径', () => {
  it('消耗 = 当前额度 − 买入基线，二手号买来已烧的量不算到你账上', () => {
    const { entries, changed } = applyLedgerObservation({
      // 买来时这个号已经烧了 3000
      entries: [entry({ baselineUsage: 3_000, currentUsage: 3_000 })],
      observations: [observation({ currentUsage: 3_450 })],
      at: NOW
    })
    expect(changed).toBe(true)
    // 只算 450，不是 3450
    expect(entries[0].usedCredits).toBe(450)
    expect(entries[0].currentUsage).toBe(3_450)
    expect(entries[0].lastSeenAt).toBe(NOW)
  })

  it('多轮观测按当前值重算，不做逐轮累加（漏采几轮也不丢数）', () => {
    const first = applyLedgerObservation({
      entries: [entry()],
      observations: [observation({ currentUsage: 100 })],
      at: NOW
    })
    // 中间漏了几轮，直接跳到 800
    const second = applyLedgerObservation({
      entries: first.entries,
      observations: [observation({ currentUsage: 800 })],
      at: NOW + 10 * 60_000
    })
    expect(second.entries[0].usedCredits).toBe(800)
  })

  it('基线缺失的老记录用首次观测值补上，那一轮消耗记 0', () => {
    const { entries } = applyLedgerObservation({
      entries: [entry({ baselineUsage: undefined, currentUsage: undefined })],
      observations: [observation({ currentUsage: 5_000 })],
      at: NOW
    })
    expect(entries[0].baselineUsage).toBe(5_000)
    expect(entries[0].usedCredits).toBe(0)
  })

  it('额度按月重置时结转已烧的量，重置后从 0 重新累加', () => {
    // 本周期已烧到 8000
    const before = applyLedgerObservation({
      entries: [entry()],
      observations: [observation({ currentUsage: 8_000 })],
      at: NOW
    })
    expect(before.entries[0].usedCredits).toBe(8_000)

    // 跨月：上游把 current 打回 0
    const reset = applyLedgerObservation({
      entries: before.entries,
      observations: [observation({ currentUsage: 0 })],
      at: NOW + HOUR
    })
    // 重置前烧掉的 8000 是真花出去的，必须留在账上
    expect(reset.entries[0].carriedCredits).toBe(8_000)
    expect(reset.entries[0].usedCredits).toBe(8_000)
    expect(reset.entries[0].baselineUsage).toBe(0)

    // 新周期又烧了 120，要叠加在结转量之上
    const after = applyLedgerObservation({
      entries: reset.entries,
      observations: [observation({ currentUsage: 120 })],
      at: NOW + 2 * HOUR
    })
    expect(after.entries[0].usedCredits).toBe(8_120)
  })

  it('账号本轮不在库里就标下线，读取失败那轮（canRetire=false）不动', () => {
    const alive = entry()
    const stale = applyLedgerObservation({
      entries: [alive],
      observations: [],
      at: NOW,
      canRetire: false
    })
    expect(stale.entries[0].retiredAt).toBeUndefined()
    expect(stale.changed).toBe(false)

    const gone = applyLedgerObservation({
      entries: [alive],
      observations: [],
      at: NOW,
      canRetire: true
    })
    expect(gone.entries[0].retiredAt).toBe(NOW)
    expect(gone.entries[0].retireReason).toBe(KSK_LEDGER_RETIRE_REASON.VANISHED)
  })

  it('已下线的记录不被重复标记，retireReason 保持原值', () => {
    const retired = entry({
      retiredAt: NOW - HOUR,
      retireReason: KSK_LEDGER_RETIRE_REASON.EXHAUSTED
    })
    const { entries, changed } = applyLedgerObservation({
      entries: [retired],
      observations: [],
      at: NOW,
      canRetire: true
    })
    expect(entries[0].retiredAt).toBe(NOW - HOUR)
    expect(entries[0].retireReason).toBe(KSK_LEDGER_RETIRE_REASON.EXHAUSTED)
    expect(changed).toBe(false)
  })

  it('号重新回到账号库时清掉下线标记，但保留已攒的消耗', () => {
    const retired = entry({
      usedCredits: 500,
      currentUsage: 500,
      retiredAt: NOW - HOUR,
      retireReason: KSK_LEDGER_RETIRE_REASON.VANISHED
    })
    const { entries } = applyLedgerObservation({
      entries: [retired],
      observations: [observation({ currentUsage: 600 })],
      at: NOW,
      canRetire: true
    })
    expect(entries[0].retiredAt).toBeUndefined()
    expect(entries[0].retireReason).toBeUndefined()
    expect(entries[0].usedCredits).toBe(600)
  })

  it('不为陌生账号建档（只收抢号买来的号）', () => {
    const { entries } = applyLedgerObservation({
      entries: [],
      observations: [observation({ accountId: 'manually-imported' })],
      at: NOW,
      canRetire: true
    })
    expect(entries).toHaveLength(0)
  })
})

describe('台账 · 状态与存活时长', () => {
  it('没下线时刻就是「在用」', () => {
    expect(resolveLedgerState(entry())).toBe(KSK_LEDGER_STATE.ALIVE)
  })

  it('验活判死单独成一档「买到即废」，额度耗尽算「已下线」', () => {
    const doa = entry({ retiredAt: NOW, retireReason: KSK_LEDGER_RETIRE_REASON.INVALID })
    expect(resolveLedgerState(doa)).toBe(KSK_LEDGER_STATE.DEAD_ON_ARRIVAL)

    const exhausted = entry({ retiredAt: NOW, retireReason: KSK_LEDGER_RETIRE_REASON.EXHAUSTED })
    expect(resolveLedgerState(exhausted)).toBe(KSK_LEDGER_STATE.RETIRED)
  })

  it('存活时长从买入算到下线', () => {
    const row = entry({ purchasedAt: NOW - 10 * HOUR, retiredAt: NOW - 2 * HOUR })
    expect(resolveLedgerAliveMs(row, NOW)).toBe(8 * HOUR)
  })

  it('仍在用的号算到现在', () => {
    expect(resolveLedgerAliveMs(entry({ purchasedAt: NOW - 3 * HOUR }), NOW)).toBe(3 * HOUR)
  })

  it('时长格式化按分钟/小时/天三档', () => {
    expect(formatLedgerDuration(0)).toBe('—')
    expect(formatLedgerDuration(25 * 60_000)).toBe('25 分钟')
    expect(formatLedgerDuration(3 * HOUR + 15 * 60_000)).toBe('3 小时 15 分')
    expect(formatLedgerDuration(2 * 24 * HOUR + 5 * HOUR)).toBe('2 天 5 小时')
  })
})

describe('台账 · 报表聚合', () => {
  it('按 purchasedAt 过滤窗口，并算出每积分单价与平均寿命', () => {
    const report = summarizeKskLedger({
      entries: [
        // 窗口内：买 50 元，下游烧了 5000，活了 8 小时
        entry({
          purchasedAt: NOW - 2 * 24 * HOUR,
          costCny: 50,
          usedCredits: 5_000,
          currentUsage: 5_000,
          retiredAt: NOW - 2 * 24 * HOUR + 8 * HOUR,
          retireReason: KSK_LEDGER_RETIRE_REASON.EXHAUSTED
        }),
        // 窗口外：60 天前买的，不该进这次汇总
        entry({ accountId: 'acct-old', purchasedAt: NOW - 60 * 24 * HOUR, costCny: 999 })
      ],
      days: 7,
      now: NOW
    })
    expect(report.rows).toHaveLength(1)
    expect(report.totals.spendCny).toBe(50)
    expect(report.totals.usedCredits).toBe(5_000)
    expect(report.totals.retired).toBe(1)
    expect(report.totals.avgAliveMs).toBe(8 * HOUR)
    expect(report.totals.cnyPerCredit).toBeCloseTo(0.01, 6)
    expect(report.rows[0].creditsPerHour).toBeCloseTo(625, 6)
    expect(report.rows[0].usagePercent).toBeCloseTo(0.5, 6)
    // 全量历史条数不受窗口限制
    expect(report.totalEntryCount).toBe(2)
    expect(report.earliestPurchasedAt).toBe(NOW - 60 * 24 * HOUR)
  })

  it('买到即废的号计入 wasted，且照样算进每分单价的分子', () => {
    const report = summarizeKskLedger({
      entries: [
        entry({ costCny: 50, usedCredits: 1_000 }),
        entry({
          accountId: 'dead:xyz',
          costCny: 50,
          retiredAt: NOW - HOUR,
          retireReason: KSK_LEDGER_RETIRE_REASON.INVALID
        })
      ],
      days: 7,
      now: NOW
    })
    expect(report.totals.wasted).toBe(1)
    expect(report.totals.alive).toBe(1)
    expect(report.totals.spendCny).toBe(100)
    // 白买的号也花了钱，必须算进每分单价——不然 ROI 会被高估
    expect(report.totals.cnyPerCredit).toBeCloseTo(0.1, 6)
  })

  it('平均服役时长的分母是所有号，不是只算已下线的', () => {
    // 抢到的号默认不删，只算已下线的会让这个值长期是 undefined
    const report = summarizeKskLedger({
      entries: [
        entry({ accountId: 'a-1', purchasedAt: NOW - 10 * HOUR }),
        entry({ accountId: 'a-2', purchasedAt: NOW - 2 * HOUR })
      ],
      days: 7,
      now: NOW
    })
    expect(report.totals.retired).toBe(0)
    expect(report.totals.alive).toBe(2)
    expect(report.totals.avgAliveMs).toBe(6 * HOUR)
  })

  it('没有消耗时每积分单价为 undefined 而不是 Infinity', () => {
    const report = summarizeKskLedger({
      entries: [entry({ costCny: 50, usedCredits: 0 })],
      days: 7,
      now: NOW
    })
    expect(report.totals.cnyPerCredit).toBeUndefined()
    expect(report.rows[0].cnyPerCredit).toBeUndefined()
  })

  it('按每分单价排序时，算不出单价的号排最后', () => {
    const report = summarizeKskLedger({
      entries: [
        entry({ accountId: 'a-none', costCny: 50, usedCredits: 0 }),
        entry({ accountId: 'a-cheap', costCny: 50, usedCredits: 10_000 }),
        entry({ accountId: 'a-dear', costCny: 50, usedCredits: 1_000 })
      ],
      days: 7,
      sort: KSK_LEDGER_SORT.EFFICIENCY,
      now: NOW
    })
    expect(report.rows.map((row) => row.accountId)).toEqual(['a-cheap', 'a-dear', 'a-none'])
  })
})

describe('台账 · 按分组汇总', () => {
  it('按分组聚合花费与消耗，分组名按当前分组表查，按花费降序', () => {
    const report = summarizeKskLedger({
      entries: [
        entry({ accountId: 'a-1', groupId: 'g-cheap', costCny: 30, usedCredits: 6_000 }),
        entry({ accountId: 'a-2', groupId: 'g-cheap', costCny: 30, usedCredits: 4_000 }),
        entry({ accountId: 'a-3', groupId: 'g-dear', costCny: 100, usedCredits: 2_000 })
      ],
      days: 7,
      groupNames: { 'g-cheap': '下游 A', 'g-dear': '下游 B' },
      now: NOW
    })
    // 花费多的排前面
    expect(report.byGroup.map((group) => group.groupName)).toEqual(['下游 B', '下游 A'])
    const cheap = report.byGroup.find((group) => group.groupId === 'g-cheap')
    expect(cheap).toMatchObject({ entries: 2, alive: 2, spendCny: 60, usedCredits: 10_000 })
    expect(cheap?.cnyPerCredit).toBeCloseTo(0.006, 6)
    // 单号行上也带分组名，便于明细表直接展示
    expect(report.rows.find((row) => row.accountId === 'a-3')?.groupName).toBe('下游 B')
  })

  it('未分组的号归到「未分组」，分组被删掉时标注出来而不是留空白', () => {
    const report = summarizeKskLedger({
      entries: [
        entry({ accountId: 'a-1', groupId: undefined, costCny: 50 }),
        entry({ accountId: 'a-2', groupId: 'g-gone', costCny: 10 })
      ],
      days: 7,
      groupNames: {},
      now: NOW
    })
    const names = report.byGroup.map((group) => group.groupName)
    expect(names).toContain('未分组')
    expect(names.some((name) => name.startsWith('已删除的分组'))).toBe(true)
  })
})

describe('台账 · 持久化清洗', () => {
  it('缺 accountId 或 purchasedAt 的条目直接丢', () => {
    expect(normalizeKskLedgerEntry({ purchasedAt: NOW })).toBeNull()
    expect(normalizeKskLedgerEntry({ accountId: ACCOUNT_ONE })).toBeNull()
    expect(normalizeKskLedgerEntry({ accountId: ACCOUNT_ONE, purchasedAt: 0 })).toBeNull()
  })

  it('累计量的负数按 0 读入，渠道认不出时回落而不是丢整条', () => {
    const parsed = normalizeKskLedgerEntry({
      accountId: ACCOUNT_ONE,
      purchasedAt: NOW,
      channel: 'kiro_from_the_future',
      usedCredits: -5,
      baselineUsage: 120
    })
    expect(parsed?.usedCredits).toBe(0)
    expect(parsed?.baselineUsage).toBe(120)
    expect(parsed?.channel).toBe(KSK_HUNTER_CHANNEL.KIRO_MARKET)
  })

  it('同一 accountId 重复出现时保留采购更晚的那条', () => {
    const entries = normalizeKskLedgerPayload({
      version: 1,
      entries: [
        { accountId: ACCOUNT_ONE, purchasedAt: NOW - HOUR, costCny: 30 },
        { accountId: ACCOUNT_ONE, purchasedAt: NOW, costCny: 50 }
      ]
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].costCny).toBe(50)
  })

  it('坏载荷按空台账处理，不抛错', () => {
    expect(normalizeKskLedgerPayload(null)).toEqual([])
    expect(normalizeKskLedgerPayload({ entries: 'nope' })).toEqual([])
  })
})

describe('台账 · runner 记账时机', () => {
  type HunterDeps = ConstructorParameters<typeof KskHunterManager>[0]

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
      secrets: { downstreamApiKey: 'downstream-key', balanceUrls: {}, apiKeys: {} },
      links,
      deliveries: [],
      spend: []
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

  function makeDeps(
    store: PersistedKskHunterStore,
    ledger: KskLedgerEntry[],
    overrides: Partial<HunterDeps> = {}
  ): HunterDeps {
    return {
      readStore: async () => ({ ...store, deliveries: deliveryStore.records as never }),
      fetchImpl: async () => jsonResponse({ code: 0, data: [] }),
      // 默认：入库成功并回带账号 id 与买入时的额度基线
      importCredential: async () => ({
        added: true,
        accountId: ACCOUNT_ONE,
        usageCurrent: 3_000,
        usageLimit: 10_000
      }),
      notifyInStock: vi.fn(),
      notifyOrdered: vi.fn(),
      notifyAccountsChanged: vi.fn(),
      notifySnapshot: vi.fn(),
      // 报表事件流在这组用例里不关心，吞掉即可
      appendReportEvent: async () => {},
      readReportEvents: async () => [],
      recordLedgerPurchase: async (item) => {
        const index = ledger.findIndex((existing) => existing.accountId === item.accountId)
        if (index < 0) ledger.push(item)
        else ledger[index] = item
      },
      readLedger: async () => ledger,
      log: vi.fn(),
      ...overrides
    }
  }

  it('入库成功后按账号 id 建档，把入库时的额度记成买入基线', async () => {
    deliveryStore.reset()
    const ledger: KskLedgerEntry[] = []
    const store = hunterStore([hunterLink({ channel: KSK_HUNTER_CHANNEL.KIRO_DROP })], {
      billing: {
        ...DEFAULT_KSK_HUNTER_CONFIG.billing,
        [KSK_HUNTER_CHANNEL.KIRO_DROP]: {
          unitLabel: 'CRD',
          cnyPerUnit: 0.25,
          dailyLimitUnit: 0,
          lowBalanceThresholdUnit: 0
        }
      }
    })
    const manager = new KskHunterManager(makeDeps(store, ledger, { fetchImpl: inStockFetch(120) }))

    await manager.runNow()
    manager.stop()

    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      accountId: ACCOUNT_ONE,
      channel: KSK_HUNTER_CHANNEL.KIRO_DROP,
      region: 'eu-central-1',
      costUnit: 120,
      costCny: 30,
      unitLabel: 'CRD',
      linkId: 'link-1',
      // 买来时这个号已经烧了 3000，记进基线
      baselineUsage: 3_000,
      usageLimit: 10_000,
      usedCredits: 0
    })
    // 台账文件是明文 JSON，出现 ksk 明文就是凭据泄露
    expect(JSON.stringify(ledger)).not.toContain(KSK_ONE)
    expect(ledger[0].maskedKey).toBe('ksk_...aaaa')
  })

  it('把抢号配置的目标分组记进台账，报表才能按分组汇总', async () => {
    deliveryStore.reset()
    const ledger: KskLedgerEntry[] = []
    const manager = new KskHunterManager(
      makeDeps(hunterStore([hunterLink()], { targetGroupId: 'group-downstream-a' }), ledger, {
        fetchImpl: inStockFetch(10)
      })
    )

    await manager.runNow()
    manager.stop()

    expect(ledger[0].groupId).toBe('group-downstream-a')
  })

  it('重复号（没有新账号 id）不建档，避免留下一行没有主键的空数据', async () => {
    deliveryStore.reset()
    const ledger: KskLedgerEntry[] = []
    const manager = new KskHunterManager(
      makeDeps(hunterStore([hunterLink()]), ledger, {
        fetchImpl: inStockFetch(10),
        importCredential: async () => ({ added: false })
      })
    )

    await manager.runNow()
    manager.stop()

    expect(ledger).toHaveLength(0)
  })

  it('验活失败仍记这笔采购（钱花了），并立即标「买到即废」', async () => {
    deliveryStore.reset()
    const ledger: KskLedgerEntry[] = []
    const manager = new KskHunterManager(
      makeDeps(hunterStore([hunterLink()]), ledger, {
        fetchImpl: inStockFetch(10),
        importCredential: async () => {
          throw new Error('AccountSuspendedException')
        }
      })
    )

    await manager.runNow()
    manager.stop()

    expect(ledger).toHaveLength(1)
    expect(ledger[0].costCny).toBe(10)
    expect(ledger[0].retireReason).toBe(KSK_LEDGER_RETIRE_REASON.INVALID)
    expect(resolveLedgerState(ledger[0])).toBe(KSK_LEDGER_STATE.DEAD_ON_ARRIVAL)
    // 合成主键永远匹配不上真实账号，所以它不会被观测复活
    expect(ledger[0].accountId.startsWith('dead:')).toBe(true)
    expect(deliveryStore.records[0].state).toBe(KSK_HUNTER_DELIVERY_STATE.DEAD_KEY)
  })

  it('买到即废的记录不会被后续账号观测复活', async () => {
    const dead = entry({
      accountId: 'dead:delivery-1',
      retiredAt: NOW,
      retireReason: KSK_LEDGER_RETIRE_REASON.INVALID
    })
    const { entries, changed } = applyLedgerObservation({
      entries: [dead],
      observations: [observation({ accountId: ACCOUNT_ONE })],
      at: NOW + HOUR,
      canRetire: true
    })
    expect(entries[0].retiredAt).toBe(NOW)
    expect(changed).toBe(false)
  })

  it('台账写盘失败不影响抢号主流程（号已经买到了）', async () => {
    deliveryStore.reset()
    const ledger: KskLedgerEntry[] = []
    const manager = new KskHunterManager(
      makeDeps(hunterStore([hunterLink()]), ledger, {
        fetchImpl: inStockFetch(10),
        recordLedgerPurchase: async () => {
          throw new Error('ENOSPC: no space left on device')
        }
      })
    )

    await expect(manager.runNow()).resolves.toBeDefined()
    manager.stop()
    // 号仍然入了推送队列
    expect(deliveryStore.records).toHaveLength(1)
  })

  it('ledgerReport 走注入的台账读取，按窗口聚合', async () => {
    deliveryStore.reset()
    const ledger: KskLedgerEntry[] = [
      entry({ purchasedAt: Date.now() - HOUR, costCny: 50, usedCredits: 2_500 })
    ]
    const manager = new KskHunterManager(makeDeps(hunterStore([]), ledger))

    const report = await manager.ledgerReport(7)
    manager.stop()

    expect(report.rows).toHaveLength(1)
    expect(report.totals.spendCny).toBe(50)
    expect(report.totals.cnyPerCredit).toBeCloseTo(0.02, 6)
  })
})
