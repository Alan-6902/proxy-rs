import { describe, expect, it, vi } from 'vitest'

/**
 * 抢号台账：观测差分、状态判定、报表聚合，以及 runner 在什么时机记账。
 *
 * runner 侧的落盘走 deps.recordLedgerPurchase / markLedgerRetired 注入内存实现，
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

import { createHash } from 'node:crypto'
import {
  KSK_LEDGER_POOL_GRACE_MS,
  KSK_LEDGER_RETIRE_REASON,
  KSK_LEDGER_SORT,
  KSK_LEDGER_STATE,
  applyLedgerObservation,
  formatLedgerDuration,
  resolveLedgerAliveMs,
  resolveLedgerState,
  summarizeKskLedger,
  toLedgerObservations,
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
import type { LocalAdminCredentialStats } from '../../src/shared/localAdminStats'
import { KskHunterManager } from '../../src/main/kskHunter/hunterRunner'
import type {
  PersistedKskHunterLink,
  PersistedKskHunterStore
} from '../../src/main/kskHunter/configStore'

const KSK_ONE = `ksk_${'a'.repeat(40)}`
const HASH_ONE = createHash('sha256').update(KSK_ONE).digest('hex')
const HOUR = 3_600_000

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0)

/** 一条最小台账记录：买到了、还没进池、没有产出。 */
function entry(overrides: Partial<KskLedgerEntry> = {}): KskLedgerEntry {
  return {
    keyHash: HASH_ONE,
    maskedKey: 'ksk_...aaaa',
    region: 'us-east-1',
    channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
    linkId: 'link-1',
    linkName: 'Kiro CEO · 美区',
    purchasedAt: NOW - 10 * HOUR,
    costUnit: 50,
    costCny: 50,
    unitLabel: '积分',
    usedCredits: 0,
    inputTokens: 0,
    outputTokens: 0,
    successCount: 0,
    failureCount: 0,
    ...overrides
  }
}

function observation(overrides: Partial<KskLedgerObservation> = {}): KskLedgerObservation {
  return {
    keyHash: HASH_ONE,
    credentialId: '7',
    successCount: 0,
    failureCount: 0,
    ...overrides
  }
}

describe('台账 · 观测差分', () => {
  it('首次观测只建基线，不把入池前的历史累计算成产出', () => {
    const { entries, changed } = applyLedgerObservation({
      entries: [entry()],
      observations: [observation({ usedCredits: 8456.31, inputTokens: 320_906, successCount: 42 })],
      at: NOW
    })
    expect(changed).toBe(true)
    // 关键断言：这个号进池前已经烧了 8456 分，不能算成「我的消耗」
    expect(entries[0].usedCredits).toBe(0)
    expect(entries[0].inputTokens).toBe(0)
    expect(entries[0].successCount).toBe(0)
    expect(entries[0].firstSeenAt).toBe(NOW)
    expect(entries[0].cursor?.usedCredits).toBe(8456.31)
    expect(entries[0].credentialId).toBe('7')
  })

  it('第二轮起按相邻两次观测的差值累加', () => {
    const first = applyLedgerObservation({
      entries: [entry()],
      observations: [observation({ usedCredits: 100, inputTokens: 1_000, successCount: 5 })],
      at: NOW
    })
    const second = applyLedgerObservation({
      entries: first.entries,
      observations: [observation({ usedCredits: 175.5, inputTokens: 4_200, successCount: 9 })],
      at: NOW + 60_000
    })
    expect(second.entries[0].usedCredits).toBe(75.5)
    expect(second.entries[0].inputTokens).toBe(3_200)
    expect(second.entries[0].successCount).toBe(4)
    expect(second.entries[0].lastSeenAt).toBe(NOW + 60_000)
  })

  it('累计值回落记 0 而不是负数（kiro-rs 重启后计数从 0 起）', () => {
    const first = applyLedgerObservation({
      entries: [entry()],
      observations: [observation({ usedCredits: 500, successCount: 30 })],
      at: NOW
    })
    const restarted = applyLedgerObservation({
      entries: first.entries,
      observations: [observation({ usedCredits: 0, successCount: 0 })],
      at: NOW + 60_000
    })
    expect(restarted.entries[0].usedCredits).toBe(0)
    expect(restarted.entries[0].successCount).toBe(0)
    // 基线跟着降下来，重启后新产生的量下一轮能正常累加
    expect(restarted.entries[0].cursor?.usedCredits).toBe(0)

    const after = applyLedgerObservation({
      entries: restarted.entries,
      observations: [observation({ usedCredits: 12, successCount: 3 })],
      at: NOW + 120_000
    })
    expect(after.entries[0].usedCredits).toBe(12)
  })

  it('本轮缺某个字段时保留旧基线，不把整段累计当成新增', () => {
    const first = applyLedgerObservation({
      entries: [entry()],
      observations: [observation({ usedCredits: 200 })],
      at: NOW
    })
    // 这一轮没查到用量（balance 拉失败），usedCredits 缺失
    const missing = applyLedgerObservation({
      entries: first.entries,
      observations: [observation({ usedCredits: undefined })],
      at: NOW + 60_000
    })
    expect(missing.entries[0].cursor?.usedCredits).toBe(200)

    const back = applyLedgerObservation({
      entries: missing.entries,
      observations: [observation({ usedCredits: 230 })],
      at: NOW + 120_000
    })
    expect(back.entries[0].usedCredits).toBe(30)
  })

  it('进过池的号本轮没观测到就标下线，未进池的保持原状', () => {
    const pooled = entry({ firstSeenAt: NOW - 5 * HOUR, lastSeenAt: NOW - 60_000 })
    const notPooled = entry({ keyHash: 'hash-never' })
    const { entries } = applyLedgerObservation({
      entries: [pooled, notPooled],
      observations: [],
      at: NOW,
      canRetire: true
    })
    expect(entries[0].retiredAt).toBe(NOW)
    expect(entries[0].retireReason).toBe(KSK_LEDGER_RETIRE_REASON.VANISHED)
    // 还在推送重试队列里的号不能被误报成「已下线」
    expect(entries[1].retiredAt).toBeUndefined()
  })

  it('canRetire 为 false 时不判下线（抓取失败那轮凭据列表是空的）', () => {
    const pooled = entry({ firstSeenAt: NOW - 5 * HOUR })
    const { entries, changed } = applyLedgerObservation({
      entries: [pooled],
      observations: [],
      at: NOW,
      canRetire: false
    })
    expect(entries[0].retiredAt).toBeUndefined()
    expect(changed).toBe(false)
  })

  it('号重新回到池里时清掉下线标记', () => {
    const retired = entry({
      firstSeenAt: NOW - 5 * HOUR,
      retiredAt: NOW - HOUR,
      retireReason: KSK_LEDGER_RETIRE_REASON.VANISHED
    })
    const { entries } = applyLedgerObservation({
      entries: [retired],
      observations: [observation()],
      at: NOW,
      canRetire: true
    })
    expect(entries[0].retiredAt).toBeUndefined()
    expect(entries[0].retireReason).toBeUndefined()
    // 首次进池时刻不该被覆盖，否则存活时长会被重置
    expect(entries[0].firstSeenAt).toBe(NOW - 5 * HOUR)
  })

  it('不为陌生哈希建档（只收抢号买来的号）', () => {
    const { entries } = applyLedgerObservation({
      entries: [],
      observations: [observation({ keyHash: 'hash-of-manually-pushed' })],
      at: NOW,
      canRetire: true
    })
    expect(entries).toHaveLength(0)
  })

  it('凭据视图转观测时丢掉没有 apiKeyHash 的 oauth 条目', () => {
    const credentials: LocalAdminCredentialStats[] = [
      {
        id: '1',
        apiKeyHash: HASH_ONE,
        priority: 0,
        disabled: false,
        isCurrent: true,
        successCount: 3,
        failureCount: 0,
        refreshFailureCount: 0,
        usedCredits: 12.5,
        alerts: []
      },
      {
        id: '2',
        priority: 0,
        disabled: false,
        isCurrent: false,
        successCount: 9,
        failureCount: 1,
        refreshFailureCount: 0,
        alerts: []
      }
    ]
    const observations = toLedgerObservations(credentials)
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({ keyHash: HASH_ONE, credentialId: '1', successCount: 3 })
  })
})

describe('台账 · 状态与存活时长', () => {
  it('刚买到还没被观测到时是「待确认」，超过宽限期才算「未进池」', () => {
    const fresh = entry({ purchasedAt: NOW - 60_000 })
    expect(resolveLedgerState(fresh, NOW)).toBe(KSK_LEDGER_STATE.PENDING)

    const stale = entry({ purchasedAt: NOW - KSK_LEDGER_POOL_GRACE_MS - 1 })
    expect(resolveLedgerState(stale, NOW)).toBe(KSK_LEDGER_STATE.NEVER_POOLED)
  })

  it('验活判死且从未进池的是「买到即废」，进过池再判死的算「已下线」', () => {
    const doa = entry({ retiredAt: NOW, retireReason: KSK_LEDGER_RETIRE_REASON.INVALID })
    expect(resolveLedgerState(doa, NOW)).toBe(KSK_LEDGER_STATE.DEAD_ON_ARRIVAL)

    const bannedLater = entry({
      firstSeenAt: NOW - 5 * HOUR,
      retiredAt: NOW,
      retireReason: KSK_LEDGER_RETIRE_REASON.INVALID
    })
    expect(resolveLedgerState(bannedLater, NOW)).toBe(KSK_LEDGER_STATE.RETIRED)
  })

  it('额度耗尽被清理的号是「已下线」', () => {
    const exhausted = entry({
      firstSeenAt: NOW - 20 * HOUR,
      retiredAt: NOW,
      retireReason: KSK_LEDGER_RETIRE_REASON.EXHAUSTED
    })
    expect(resolveLedgerState(exhausted, NOW)).toBe(KSK_LEDGER_STATE.RETIRED)
  })

  it('存活时长从进池算起，不含买来放着没推进去的那段', () => {
    const row = entry({
      purchasedAt: NOW - 10 * HOUR,
      // 买了 10 小时，但 8 小时前才进池
      firstSeenAt: NOW - 8 * HOUR,
      retiredAt: NOW - 2 * HOUR
    })
    expect(resolveLedgerAliveMs(row, NOW)).toBe(6 * HOUR)
  })

  it('仍在池的号算到现在', () => {
    const alive = entry({ firstSeenAt: NOW - 3 * HOUR, lastSeenAt: NOW - 60_000 })
    expect(resolveLedgerAliveMs(alive, NOW)).toBe(3 * HOUR)
  })

  it('没进池的号存活时长是 0', () => {
    expect(resolveLedgerAliveMs(entry(), NOW)).toBe(0)
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
        // 窗口内：买 50 分，烧出 5000 额度，活了 8 小时
        entry({
          purchasedAt: NOW - 2 * 24 * HOUR,
          costCny: 50,
          usedCredits: 5_000,
          firstSeenAt: NOW - 2 * 24 * HOUR,
          retiredAt: NOW - 2 * 24 * HOUR + 8 * HOUR,
          retireReason: KSK_LEDGER_RETIRE_REASON.EXHAUSTED,
          inputTokens: 120_000,
          outputTokens: 30_000,
          successCount: 90
        }),
        // 窗口外：60 天前买的，不该进这次汇总
        entry({ keyHash: 'hash-old', purchasedAt: NOW - 60 * 24 * HOUR, costCny: 999 })
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
    expect(report.rows[0].cnyPerCredit).toBeCloseTo(0.01, 6)
    expect(report.rows[0].creditsPerHour).toBeCloseTo(625, 6)
    // 全量历史条数不受窗口限制
    expect(report.totalEntryCount).toBe(2)
    expect(report.earliestPurchasedAt).toBe(NOW - 60 * 24 * HOUR)
  })

  it('白买的号计入 wasted，但不污染均价的分母', () => {
    const report = summarizeKskLedger({
      entries: [
        entry({ costCny: 50, usedCredits: 1_000, firstSeenAt: NOW - HOUR }),
        entry({
          keyHash: 'hash-doa',
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

  it('没有产出时每积分单价为 undefined 而不是 Infinity', () => {
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
        entry({ keyHash: 'h-none', costCny: 50, usedCredits: 0 }),
        entry({ keyHash: 'h-cheap', costCny: 50, usedCredits: 10_000 }),
        entry({ keyHash: 'h-dear', costCny: 50, usedCredits: 1_000 })
      ],
      days: 7,
      sort: KSK_LEDGER_SORT.EFFICIENCY,
      now: NOW
    })
    expect(report.rows.map((row) => row.keyHash)).toEqual(['h-cheap', 'h-dear', 'h-none'])
  })

  it('存活不足一分钟时不算产出速率（样本太少没有意义）', () => {
    const report = summarizeKskLedger({
      entries: [
        entry({
          firstSeenAt: NOW - 30_000,
          usedCredits: 5,
          costCny: 50
        })
      ],
      days: 7,
      now: NOW
    })
    expect(report.rows[0].creditsPerHour).toBeUndefined()
  })
})

describe('台账 · 持久化清洗', () => {
  it('缺 keyHash 或 purchasedAt 的条目直接丢', () => {
    expect(normalizeKskLedgerEntry({ purchasedAt: NOW })).toBeNull()
    expect(normalizeKskLedgerEntry({ keyHash: HASH_ONE })).toBeNull()
    expect(normalizeKskLedgerEntry({ keyHash: HASH_ONE, purchasedAt: 0 })).toBeNull()
  })

  it('累计量的负数按 0 读入，渠道认不出时回落而不是丢整条', () => {
    const parsed = normalizeKskLedgerEntry({
      keyHash: HASH_ONE,
      purchasedAt: NOW,
      channel: 'kiro_from_the_future',
      usedCredits: -5,
      successCount: 3
    })
    expect(parsed?.usedCredits).toBe(0)
    expect(parsed?.successCount).toBe(3)
    expect(parsed?.channel).toBe(KSK_HUNTER_CHANNEL.KIRO_MARKET)
  })

  it('同一 keyHash 重复出现时保留采购更晚的那条', () => {
    const entries = normalizeKskLedgerPayload({
      version: 1,
      entries: [
        { keyHash: HASH_ONE, purchasedAt: NOW - HOUR, costCny: 30 },
        { keyHash: HASH_ONE, purchasedAt: NOW, costCny: 50 }
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
    retired: { keyHash: string; reason: string }[],
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
      // 报表事件流在这组用例里不关心，吞掉即可
      appendReportEvent: async () => {},
      readReportEvents: async () => [],
      recordLedgerPurchase: async (item) => {
        const index = ledger.findIndex((existing) => existing.keyHash === item.keyHash)
        if (index < 0) ledger.push(item)
        else ledger[index] = item
      },
      markLedgerRetired: async ({ keyHash, reason }) => {
        retired.push({ keyHash, reason })
      },
      readLedger: async () => ledger,
      log: vi.fn(),
      ...overrides
    }
  }

  it('下单成功后按 sha256(ksk) 建档，带上成本、渠道与脱敏 key，不落明文', async () => {
    deliveryStore.reset()
    const ledger: KskLedgerEntry[] = []
    const retired: { keyHash: string; reason: string }[] = []
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
    const manager = new KskHunterManager(
      makeDeps(store, ledger, retired, { fetchImpl: inStockFetch(120) })
    )

    await manager.runNow()
    manager.stop()

    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      keyHash: HASH_ONE,
      channel: KSK_HUNTER_CHANNEL.KIRO_DROP,
      region: 'eu-central-1',
      costUnit: 120,
      costCny: 30,
      unitLabel: 'CRD',
      linkId: 'link-1',
      usedCredits: 0
    })
    // 台账文件是明文 JSON，出现 ksk 明文就是凭据泄露
    expect(JSON.stringify(ledger)).not.toContain(KSK_ONE)
    expect(ledger[0].maskedKey).toBe('ksk_...aaaa')
    expect(retired).toHaveLength(0)
  })

  it('验活失败时立即标「买到即废」，不让它挂在待确认等宽限期', async () => {
    deliveryStore.reset()
    const ledger: KskLedgerEntry[] = []
    const retired: { keyHash: string; reason: string }[] = []
    const store = hunterStore([hunterLink()])
    const manager = new KskHunterManager(
      makeDeps(store, ledger, retired, {
        fetchImpl: inStockFetch(10),
        importCredential: async () => {
          throw new Error('AccountSuspendedException')
        }
      })
    )

    await manager.runNow()
    manager.stop()

    // 钱已经花出去了，采购记录必须留着
    expect(ledger).toHaveLength(1)
    expect(ledger[0].costCny).toBe(10)
    expect(retired).toEqual([{ keyHash: HASH_ONE, reason: KSK_LEDGER_RETIRE_REASON.INVALID }])
    expect(deliveryStore.records[0].state).toBe(KSK_HUNTER_DELIVERY_STATE.DEAD_KEY)
  })

  it('台账写盘失败不影响抢号主流程（号已经买到了）', async () => {
    deliveryStore.reset()
    const ledger: KskLedgerEntry[] = []
    const retired: { keyHash: string; reason: string }[] = []
    const store = hunterStore([hunterLink()])
    const manager = new KskHunterManager(
      makeDeps(store, ledger, retired, {
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
    const manager = new KskHunterManager(makeDeps(hunterStore([]), ledger, []))

    const report = await manager.ledgerReport(7)
    manager.stop()

    expect(report.rows).toHaveLength(1)
    expect(report.totals.spendCny).toBe(50)
    expect(report.totals.cnyPerCredit).toBeCloseTo(0.02, 6)
  })
})
