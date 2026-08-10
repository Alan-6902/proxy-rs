import { describe, expect, it, vi } from 'vitest'

/**
 * 下游对账：积分区间口径、CSV 生成、小时聚合，以及 runner 在什么时机记交付。
 *
 * runner 侧的落盘走 deps.recordDownstreamDelivery 注入内存实现，
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
  CSV_BOM,
  DOWNSTREAM_CSV_HEADERS,
  buildDownstreamCsv,
  computeDownstreamSettlement,
  downstreamCsvFileName,
  downstreamDateKeyToStart,
  downstreamPendingCredits,
  escapeCsvField,
  pruneDownstreamSettlements,
  summarizeDownstreamDaily,
  summarizeDownstreamDay,
  type DownstreamCsvRow,
  type DownstreamDelivery,
  type DownstreamDaySettlement,
  type DownstreamLedgerUsage
} from '../../src/shared/downstreamSettlement'
import { KSK_LEDGER_STATE } from '../../src/shared/kskLedger'
import {
  normalizeDeliveryLedgerPayload,
  normalizeDownstreamDelivery,
  normalizeDownstreamSettlement
} from '../../src/main/downstreamSettlement/deliveryLedgerStore'
import {
  DEFAULT_KSK_HUNTER_CONFIG,
  KSK_HUNTER_CHANNEL,
  KSK_HUNTER_DELIVERY_MAX_ATTEMPTS,
  KSK_HUNTER_DELIVERY_STATE,
  KSK_HUNTER_MODE,
  KSK_HUNTER_STORE_VERSION
} from '../../src/shared/kskHunter'
import { KskHunterManager } from '../../src/main/kskHunter/hunterRunner'
import type { PersistedKskHunterStore } from '../../src/main/kskHunter/configStore'

/** 一个合法的 ksk（归一化会校验格式，随手写的字符串过不了）。 */
const VALID_KEY = 'ksk_AbCdEf0123456789abcdef'

function at(date: string, hour = 0, minute = 0): number {
  const start = downstreamDateKeyToStart(date)
  if (start === undefined) throw new Error(`bad date: ${date}`)
  return start + hour * 3_600_000 + minute * 60_000
}

function makeDelivery(overrides: Partial<DownstreamDelivery> = {}): DownstreamDelivery {
  return {
    id: 'd1',
    accountId: 'acc-1',
    key: VALID_KEY,
    maskedKey: 'ksk_...cdef',
    region: 'eu-central-1',
    channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
    linkId: 'link-1',
    linkName: 'Kiro Market · eu',
    groupId: 'group-1',
    purchasedAt: at('2026-08-01', 10),
    deliveredAt: at('2026-08-01', 10, 5),
    attempts: 1,
    costUnit: 35,
    costCny: 30,
    unitLabel: '积分',
    ...overrides
  }
}

function makeUsage(
  entries: { accountId: string; usedCredits: number }[]
): Record<string, DownstreamLedgerUsage> {
  return Object.fromEntries(
    entries.map((entry) => [
      entry.accountId,
      {
        accountId: entry.accountId,
        usedCredits: entry.usedCredits,
        usageLimit: 1000,
        state: KSK_LEDGER_STATE.ALIVE
      }
    ])
  )
}

describe('积分区间口径', () => {
  it('未结算过时按「从买入到现在」的全部消耗算', () => {
    const delivery = makeDelivery()
    const usage = makeUsage([{ accountId: 'acc-1', usedCredits: 120 }])
    expect(downstreamPendingCredits(delivery, usage['acc-1'])).toBe(120)
  })

  it('结算过之后只算锚点之后的增量', () => {
    const delivery = makeDelivery({ settledCredits: 120, settledAt: at('2026-08-02') })
    const usage = makeUsage([{ accountId: 'acc-1', usedCredits: 200 }])
    expect(downstreamPendingCredits(delivery, usage['acc-1'])).toBe(80)
  })

  it('台账查不到该号时返回 undefined 而不是 0', () => {
    // 显示成 0 等于告诉用户「这个号没烧」，对账会少收钱；undefined 才提示去核
    expect(downstreamPendingCredits(makeDelivery(), undefined)).toBeUndefined()
  })

  it('台账累计值低于锚点时记 0，不出现负数', () => {
    // 台账被清空后重建基线才会撞上，记负数只会污染账目
    const delivery = makeDelivery({ settledCredits: 500 })
    const usage = makeUsage([{ accountId: 'acc-1', usedCredits: 30 }])
    expect(downstreamPendingCredits(delivery, usage['acc-1'])).toBe(0)
  })
})

describe('日结算', () => {
  it('推进锚点到台账当前值，并记下区间起止', () => {
    const delivery = makeDelivery()
    const now = at('2026-08-02', 0, 30)
    const result = computeDownstreamSettlement({
      deliveries: [delivery],
      usage: makeUsage([{ accountId: 'acc-1', usedCredits: 150 }]),
      date: '2026-08-01',
      at: now
    })

    expect(result.settlement.credits).toBe(150)
    expect(result.settlement.deliveries).toBe(1)
    expect(result.settlement.spendCny).toBe(30)
    expect(result.settlement.perAccount).toEqual([
      { accountId: 'acc-1', creditsDelta: 150, fromAt: delivery.purchasedAt, toAt: now }
    ])
    expect(result.deliveries[0].settledCredits).toBe(150)
    expect(result.deliveries[0].settledAt).toBe(now)
  })

  it('再结算一次不重复计数：锚点已推进，增量为 0', () => {
    const first = computeDownstreamSettlement({
      deliveries: [makeDelivery()],
      usage: makeUsage([{ accountId: 'acc-1', usedCredits: 150 }]),
      date: '2026-08-01',
      at: at('2026-08-02', 0, 30)
    })
    const second = computeDownstreamSettlement({
      deliveries: first.deliveries,
      usage: makeUsage([{ accountId: 'acc-1', usedCredits: 150 }]),
      date: '2026-08-01',
      at: at('2026-08-02', 1)
    })
    expect(second.settlement.credits).toBe(0)
    expect(second.settlement.perAccount).toEqual([])
  })

  it('关机几天后一次补齐：区间跨多天，起止如实反映跨度', () => {
    // 8/1 交付，8/2-8/4 应用没开，8/5 才结算 8/1 那天
    const delivery = makeDelivery()
    const settleAt = at('2026-08-05', 9)
    const result = computeDownstreamSettlement({
      deliveries: [delivery],
      usage: makeUsage([{ accountId: 'acc-1', usedCredits: 400 }]),
      date: '2026-08-01',
      at: settleAt
    })
    const entry = result.settlement.perAccount[0]
    expect(entry.creditsDelta).toBe(400)
    expect(entry.fromAt).toBe(delivery.purchasedAt)
    expect(entry.toAt).toBe(settleAt)
    // 区间跨了 4 天，不是单日——CSV 会把这两列写出来，读的人看得见
    expect(entry.toAt - entry.fromAt).toBeGreaterThan(3 * 24 * 3_600_000)
  })

  it('台账查不到的号不推进锚点，下轮台账恢复后能补上', () => {
    const delivery = makeDelivery()
    const result = computeDownstreamSettlement({
      deliveries: [delivery],
      usage: {},
      date: '2026-08-01',
      at: at('2026-08-02')
    })
    expect(result.settlement.credits).toBe(0)
    expect(result.deliveries[0].settledCredits).toBeUndefined()
    expect(result.deliveries[0].settledAt).toBeUndefined()

    // 台账恢复后，那段消耗仍然算得出来
    const recovered = computeDownstreamSettlement({
      deliveries: result.deliveries,
      usage: makeUsage([{ accountId: 'acc-1', usedCredits: 90 }]),
      date: '2026-08-02',
      at: at('2026-08-03')
    })
    expect(recovered.settlement.credits).toBe(90)
  })

  it('没有 accountId 的交付不参与积分，但仍计进交付数与花费', () => {
    const result = computeDownstreamSettlement({
      deliveries: [makeDelivery({ accountId: undefined })],
      usage: makeUsage([{ accountId: 'acc-1', usedCredits: 150 }]),
      date: '2026-08-01',
      at: at('2026-08-02')
    })
    expect(result.settlement.deliveries).toBe(1)
    expect(result.settlement.spendCny).toBe(30)
    expect(result.settlement.credits).toBe(0)
  })
})

describe('日报表聚合', () => {
  it('按本地小时分桶，不按 UTC', () => {
    // 东八区凌晨 1 点按 UTC 会落到前一天 17 点，那样柱状图整体错位
    const report = summarizeDownstreamDay({
      deliveries: [
        makeDelivery({ id: 'd1', deliveredAt: at('2026-08-01', 1, 30) }),
        makeDelivery({ id: 'd2', accountId: 'acc-2', deliveredAt: at('2026-08-01', 1, 45) }),
        makeDelivery({ id: 'd3', accountId: 'acc-3', deliveredAt: at('2026-08-01', 23, 10) })
      ],
      settlements: [],
      date: '2026-08-01',
      now: at('2026-08-01', 23, 59)
    })
    expect(report.deliveriesByHour[1]).toBe(2)
    expect(report.deliveriesByHour[23]).toBe(1)
    expect(report.deliveriesByHour).toHaveLength(24)
    expect(report.deliveries).toBe(3)
  })

  it('日界是闭开区间：前一天 23:59 与次日 00:00 都不算进来', () => {
    const report = summarizeDownstreamDay({
      deliveries: [
        makeDelivery({ id: 'before', deliveredAt: at('2026-07-31', 23, 59) }),
        makeDelivery({ id: 'inside', accountId: 'acc-2', deliveredAt: at('2026-08-01', 0, 0) }),
        makeDelivery({ id: 'after', accountId: 'acc-3', deliveredAt: at('2026-08-02', 0, 0) })
      ],
      settlements: [],
      date: '2026-08-01',
      now: at('2026-08-02', 12)
    })
    expect(report.deliveries).toBe(1)
    expect(report.rows.filter((row) => row.deliveredToday).map((row) => row.id)).toEqual(['inside'])
  })

  it('行集是两个集合的并：当日交付 + 当日仍在烧积分的往期号', () => {
    const report = summarizeDownstreamDay({
      deliveries: [
        // 8/1 交付、8/5 还在烧
        makeDelivery({
          id: 'old',
          accountId: 'acc-old',
          deliveredAt: at('2026-08-01', 10),
          settledCredits: 100,
          settledAt: at('2026-08-05')
        }),
        // 8/5 当天交付
        makeDelivery({ id: 'new', accountId: 'acc-new', deliveredAt: at('2026-08-05', 14) })
      ],
      settlements: [],
      usage: makeUsage([
        { accountId: 'acc-old', usedCredits: 160 },
        { accountId: 'acc-new', usedCredits: 20 }
      ]),
      date: '2026-08-05',
      now: at('2026-08-05', 20)
    })

    // 当日交付数只算 new；但行集两个都在
    expect(report.deliveries).toBe(1)
    expect(report.rows).toHaveLength(2)
    const old = report.rows.find((row) => row.id === 'old')
    const fresh = report.rows.find((row) => row.id === 'new')
    expect(old?.deliveredToday).toBe(false)
    expect(old?.creditsDelta).toBe(60)
    expect(fresh?.deliveredToday).toBe(true)
    expect(fresh?.creditsDelta).toBe(20)
    expect(report.credits).toBe(80)
    // 花费只算当日交付的那个，往期号的钱在它自己交付那天已经记过
    expect(report.spendCny).toBe(30)
  })

  it('已定稿的日子读结算记录，不回头用台账减', () => {
    const settlement: DownstreamDaySettlement = {
      date: '2026-08-01',
      settledAt: at('2026-08-02', 0, 30),
      deliveries: 1,
      spendCny: 30,
      credits: 150,
      perAccount: [
        {
          accountId: 'acc-1',
          creditsDelta: 150,
          fromAt: at('2026-08-01', 10),
          toAt: at('2026-08-02', 0, 30)
        }
      ]
    }
    const report = summarizeDownstreamDay({
      deliveries: [makeDelivery({ settledCredits: 150, settledAt: settlement.settledAt })],
      settlements: [settlement],
      // 定稿之后又烧了 900：这部分属于后面的日子，不能算进 8/1
      usage: makeUsage([{ accountId: 'acc-1', usedCredits: 1050 }]),
      date: '2026-08-01',
      now: at('2026-08-06')
    })
    expect(report.settled).toBe(true)
    expect(report.credits).toBe(150)
    expect(report.rows[0].creditsDelta).toBe(150)
  })

  it('过去某天没定稿时积分留空，不拿今天的实时值顶上', () => {
    // 待结算的积分会被记到最早那个未结算日，其余日子归 0。给每个未定稿的
    // 过去日都显示同一个实时值，等 tick 跑完就变 0，用户会以为账目自己变了。
    const report = summarizeDownstreamDay({
      deliveries: [makeDelivery({ deliveredAt: at('2026-08-01', 10) })],
      settlements: [],
      usage: makeUsage([{ accountId: 'acc-1', usedCredits: 300 }]),
      date: '2026-08-01',
      now: at('2026-08-05', 12)
    })
    expect(report.settled).toBe(false)
    expect(report.credits).toBe(0)
    expect(report.rows[0].creditsDelta).toBeUndefined()
    // 交付数与花费是精确的自然日口径，不受结算状态影响
    expect(report.deliveries).toBe(1)
    expect(report.spendCny).toBe(30)
  })

  it('当天未定稿则用实时台账估算，让人看得到进展', () => {
    const report = summarizeDownstreamDay({
      deliveries: [makeDelivery({ deliveredAt: at('2026-08-05', 9) })],
      settlements: [],
      usage: makeUsage([{ accountId: 'acc-1', usedCredits: 45 }]),
      date: '2026-08-05',
      now: at('2026-08-05', 20)
    })
    expect(report.settled).toBe(false)
    expect(report.credits).toBe(45)
  })

  it('分组名现查，未分组与已删分组都不显示成空白', () => {
    const report = summarizeDownstreamDay({
      deliveries: [
        makeDelivery({ id: 'd1', groupId: 'group-1' }),
        makeDelivery({ id: 'd2', accountId: 'acc-2', groupId: 'gone' }),
        makeDelivery({ id: 'd3', accountId: 'acc-3', groupId: undefined })
      ],
      settlements: [],
      groupNames: { 'group-1': '下游A' },
      date: '2026-08-01',
      now: at('2026-08-01', 23)
    })
    const byId = new Map(report.rows.map((row) => [row.id, row]))
    expect(byId.get('d1')?.groupName).toBe('下游A')
    // 分组被删或未分组都回 undefined，由 UI 显示成「未分组」
    expect(byId.get('d2')?.groupName).toBeUndefined()
    expect(byId.get('d3')?.groupName).toBeUndefined()
  })

  it('全量统计不受所查日期影响', () => {
    const report = summarizeDownstreamDay({
      deliveries: [
        makeDelivery({ id: 'd1', deliveredAt: at('2026-07-01', 10), costCny: 20 }),
        makeDelivery({
          id: 'd2',
          accountId: 'acc-2',
          deliveredAt: at('2026-08-01', 10),
          costCny: 30
        })
      ],
      settlements: [],
      date: '2026-08-01',
      now: at('2026-08-01', 23)
    })
    expect(report.totalDeliveryCount).toBe(2)
    expect(report.totalSpendCny).toBe(50)
    expect(report.earliestDeliveredAt).toBe(at('2026-07-01', 10))
  })
})

describe('按天汇总', () => {
  it('缺数据的天也保留一行，曲线不会把缺口连成直线', () => {
    const daily = summarizeDownstreamDaily({
      deliveries: [makeDelivery({ deliveredAt: at('2026-08-03', 10) })],
      settlements: [],
      days: 5,
      now: at('2026-08-05', 12)
    })
    expect(daily).toHaveLength(5)
    expect(daily.map((day) => day.date)).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05'
    ])
    expect(daily.find((day) => day.date === '2026-08-03')?.deliveries).toBe(1)
    expect(daily.find((day) => day.date === '2026-08-02')?.deliveries).toBe(0)
  })

  it('定稿日读记录、当天用台账估算', () => {
    const daily = summarizeDownstreamDaily({
      deliveries: [
        makeDelivery({
          deliveredAt: at('2026-08-04', 10),
          settledCredits: 100,
          settledAt: at('2026-08-05')
        })
      ],
      settlements: [
        {
          date: '2026-08-04',
          settledAt: at('2026-08-05'),
          deliveries: 1,
          spendCny: 30,
          credits: 100,
          perAccount: []
        }
      ],
      usage: makeUsage([{ accountId: 'acc-1', usedCredits: 175 }]),
      days: 2,
      now: at('2026-08-05', 12)
    })
    const settled = daily.find((day) => day.date === '2026-08-04')
    const today = daily.find((day) => day.date === '2026-08-05')
    expect(settled?.settled).toBe(true)
    expect(settled?.credits).toBe(100)
    expect(today?.settled).toBe(false)
    expect(today?.credits).toBe(75)
  })
})

describe('CSV 生成', () => {
  const csvRow = (overrides: Partial<DownstreamCsvRow> = {}): DownstreamCsvRow => ({
    id: 'd1',
    accountId: 'acc-1',
    key: VALID_KEY,
    maskedKey: 'ksk_...cdef',
    region: 'eu-central-1',
    channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
    linkName: 'Kiro Market · eu',
    groupName: '下游A',
    deliveredAt: at('2026-08-01', 14, 30),
    hour: 14,
    attempts: 1,
    costUnit: 35,
    costCny: 30,
    unitLabel: '积分',
    deliveredToday: true,
    creditsDelta: 60,
    creditsFromAt: at('2026-08-01', 10),
    creditsToAt: at('2026-08-02', 0, 30),
    totalCredits: 160,
    state: KSK_LEDGER_STATE.ALIVE,
    ...overrides
  })

  it('带 UTF-8 BOM，Excel 打开中文表头不乱码', () => {
    const csv = buildDownstreamCsv([csvRow()], '2026-08-01')
    expect(csv.startsWith(CSV_BOM)).toBe(true)
  })

  it('列序稳定，且完整 key 在第 4 列', () => {
    const csv = buildDownstreamCsv([csvRow()], '2026-08-01')
    const [header, row] = csv
      .replace(/^\ufeff/, '')
      .trim()
      .split('\n')
    expect(header.split(',')).toEqual([...DOWNSTREAM_CSV_HEADERS])
    const cells = row.split(',')
    expect(cells[0]).toBe('2026-08-01')
    expect(cells[2]).toBe('14')
    expect(cells[3]).toBe(VALID_KEY)
    expect(cells[12]).toBe('是')
    expect(cells[13]).toBe('60')
  })

  it('含逗号与引号的链接名被正确转义，不会把一列撑成两列', () => {
    const csv = buildDownstreamCsv([csvRow({ linkName: 'Kiro, "特惠" 区' })], '2026-08-01')
    const row = csv
      .replace(/^\ufeff/, '')
      .trim()
      .split('\n')[1]
    expect(row).toContain('"Kiro, ""特惠"" 区"')
    // 解析回来列数应与表头一致
    const cells = row.match(/("([^"]|"")*"|[^,]*)/g)?.filter((_, index) => index % 2 === 0)
    expect(cells?.length).toBe(DOWNSTREAM_CSV_HEADERS.length)
  })

  it('没有行时仍写表头：空文件与缺文件要能区分', () => {
    const csv = buildDownstreamCsv([], '2026-08-01')
    expect(
      csv
        .replace(/^\ufeff/, '')
        .trim()
        .split('\n')
    ).toHaveLength(1)
  })

  it('缺失的数值列留空而不是 0：未知与零不是一回事', () => {
    const csv = buildDownstreamCsv(
      [
        csvRow({
          costUnit: undefined,
          costCny: undefined,
          creditsDelta: undefined,
          state: undefined
        })
      ],
      '2026-08-01'
    )
    const cells = csv
      .replace(/^\ufeff/, '')
      .trim()
      .split('\n')[1]
      .split(',')
    expect(cells[9]).toBe('')
    expect(cells[11]).toBe('')
    expect(cells[13]).toBe('')
    expect(cells[17]).toBe('')
  })

  it('往期号标「否」，并带上跨天的积分区间', () => {
    const csv = buildDownstreamCsv([csvRow({ deliveredToday: false })], '2026-08-05')
    const cells = csv
      .replace(/^\ufeff/, '')
      .trim()
      .split('\n')[1]
      .split(',')
    expect(cells[12]).toBe('否')
    expect(cells[14]).toContain('2026-08-01')
    expect(cells[15]).toContain('2026-08-02')
  })

  it('文件名按日期', () => {
    expect(downstreamCsvFileName('2026-08-01')).toBe('downstream-2026-08-01.csv')
  })

  it('前后空格也套引号，避免被 Excel 吞掉', () => {
    expect(escapeCsvField(' 前导空格')).toBe('" 前导空格"')
    expect(escapeCsvField('正常')).toBe('正常')
  })
})

describe('账本归一化', () => {
  it('key 格式不合法的记录直接丢：对不了账的记录留着只会误导', () => {
    expect(normalizeDownstreamDelivery({ ...makeDelivery(), key: 'not-a-key' })).toBeNull()
    expect(normalizeDownstreamDelivery({ ...makeDelivery(), key: '' })).toBeNull()
  })

  it('缺 id 或交付时刻的记录丢掉', () => {
    expect(normalizeDownstreamDelivery({ ...makeDelivery(), id: '' })).toBeNull()
    expect(normalizeDownstreamDelivery({ ...makeDelivery(), deliveredAt: 0 })).toBeNull()
  })

  it('脱敏 key 从明文重算，不信文件里那份', () => {
    const entry = normalizeDownstreamDelivery({ ...makeDelivery(), maskedKey: '伪造的' })
    expect(entry?.maskedKey).toBe('ksk_...cdef')
  })

  it('认不出的渠道回落而不是丢整条：成本与 key 仍然有效', () => {
    const entry = normalizeDownstreamDelivery({ ...makeDelivery(), channel: 'unknown_shop' })
    expect(entry?.channel).toBe(KSK_HUNTER_CHANNEL.KIRO_MARKET)
    expect(entry?.costCny).toBe(30)
  })

  it('按 id 去重，保留交付更晚的那条', () => {
    const state = normalizeDeliveryLedgerPayload({
      deliveries: [
        makeDelivery({ id: 'dup', deliveredAt: at('2026-08-01', 10) }),
        makeDelivery({ id: 'dup', deliveredAt: at('2026-08-01', 12) })
      ]
    })
    expect(state.deliveries).toHaveLength(1)
    expect(state.deliveries[0].deliveredAt).toBe(at('2026-08-01', 12))
  })

  it('整份读坏时按空账本，不抛错', () => {
    expect(normalizeDeliveryLedgerPayload(null).deliveries).toEqual([])
    expect(normalizeDeliveryLedgerPayload({ deliveries: 'nope' }).deliveries).toEqual([])
  })

  it('结算记录的日期键格式不对就丢：那是它的主键', () => {
    expect(normalizeDownstreamSettlement({ date: '2026-8-1' })).toBeNull()
    expect(normalizeDownstreamSettlement({ date: '2026-08-01' })?.date).toBe('2026-08-01')
  })

  it('结算记录按保留期裁剪', () => {
    const now = at('2026-08-10', 12)
    const kept = pruneDownstreamSettlements(
      [
        {
          date: '2026-08-09',
          settledAt: now,
          deliveries: 0,
          spendCny: 0,
          credits: 0,
          perAccount: []
        },
        {
          date: '2026-01-01',
          settledAt: now,
          deliveries: 0,
          spendCny: 0,
          credits: 0,
          perAccount: []
        }
      ],
      now,
      30
    )
    expect(kept.map((item) => item.date)).toEqual(['2026-08-09'])
  })
})

describe('runner 记交付的时机', () => {
  type HunterDeps = ConstructorParameters<typeof KskHunterManager>[0]

  function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  function hunterStore(
    config: Partial<typeof DEFAULT_KSK_HUNTER_CONFIG> = {}
  ): PersistedKskHunterStore {
    return {
      version: KSK_HUNTER_STORE_VERSION,
      config: { ...DEFAULT_KSK_HUNTER_CONFIG, downstreamEnabled: true, ...config },
      secrets: { downstreamApiKey: 'downstream-key', balanceUrls: {}, apiKeys: {} },
      links: [
        {
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
          }
        }
      ],
      deliveries: [],
      spend: []
    }
  }

  function makeDeps(
    store: ReturnType<typeof hunterStore>,
    recorded: DownstreamDelivery[],
    overrides: Partial<HunterDeps> = {}
  ): HunterDeps {
    return {
      readStore: async () => ({ ...store, deliveries: deliveryStore.records as never }),
      fetchImpl: async (_url, init) =>
        init.method === 'POST'
          ? jsonResponse({ code: 0, data: { key: VALID_KEY, region: 'eu-central-1' } })
          : jsonResponse({
              code: 0,
              data: [{ id: 'g1', title: 'Kiro Key', tag: '#key-eu', stock: 1, price: 10 }]
            }),
      downstreamFetchImpl: async (url) =>
        jsonResponse(url.endsWith('/need-account') ? { need: true } : { ok: true }),
      importCredential: async () => ({ added: true, accountId: 'acc-1', usageCurrent: 5 }),
      notifyInStock: vi.fn(),
      notifyOrdered: vi.fn(),
      notifyAccountsChanged: vi.fn(),
      notifySnapshot: vi.fn(),
      appendReportEvent: async () => undefined,
      readReportEvents: async () => [],
      recordLedgerPurchase: async () => undefined,
      readLedger: async () => [],
      recordDownstreamDelivery: async (delivery) => {
        recorded.push(delivery)
      },
      log: vi.fn(),
      ...overrides
    }
  }

  it('推送成功后记一条，带完整 key、分组与账号 id', async () => {
    deliveryStore.reset()
    const recorded: DownstreamDelivery[] = []
    const manager = new KskHunterManager(
      makeDeps(hunterStore({ targetGroupId: 'group-1' }), recorded)
    )

    await manager.runNow()
    await vi.waitFor(() => expect(recorded).toHaveLength(1))
    manager.stop()

    expect(recorded[0]).toMatchObject({
      key: VALID_KEY,
      maskedKey: 'ksk_...cdef',
      region: 'eu-central-1',
      channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
      linkName: 'Kiro Market · eu',
      // 分组与账号 id 是对账的关联键，缺了积分就归不到号上
      groupId: 'group-1',
      accountId: 'acc-1',
      attempts: 1,
      costCny: 10
    })
    expect(recorded[0].deliveredAt).toBeGreaterThan(0)
  })

  it('验活判死不记：钱花了但号没交出去，不该出现在收款依据里', async () => {
    deliveryStore.reset()
    const recorded: DownstreamDelivery[] = []
    const manager = new KskHunterManager(
      makeDeps(hunterStore(), recorded, {
        importCredential: async () => {
          throw new Error('发消息验活未通过')
        }
      })
    )

    const status = await manager.runNow()
    manager.stop()

    // 号买到了、记录标成 dead_key，但交付账本是空的
    expect(status.totalOrdered).toBe(1)
    expect(deliveryStore.records[0]?.state).toBe(KSK_HUNTER_DELIVERY_STATE.DEAD_KEY)
    expect(recorded).toEqual([])
  })

  it('推送重试耗尽不记', async () => {
    deliveryStore.reset()
    const recorded: DownstreamDelivery[] = []
    deliveryStore.records.push({
      id: 'd1',
      linkId: 'link-1',
      linkName: 'Kiro Market · eu',
      channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
      key: VALID_KEY,
      region: 'eu-central-1',
      state: KSK_HUNTER_DELIVERY_STATE.PENDING,
      attempts: KSK_HUNTER_DELIVERY_MAX_ATTEMPTS - 1,
      createdAt: 1,
      updatedAt: 1
    })
    const manager = new KskHunterManager(
      makeDeps(hunterStore(), recorded, {
        downstreamFetchImpl: async () => new Response('down', { status: 503 })
      })
    )

    await manager.start()
    await vi.waitFor(() =>
      expect(deliveryStore.records[0]?.state).toBe(KSK_HUNTER_DELIVERY_STATE.FAILED)
    )
    manager.stop()

    expect(recorded).toEqual([])
  })

  it('重试后终于成功也只记一条，attempts 反映真实次数', async () => {
    deliveryStore.reset()
    const recorded: DownstreamDelivery[] = []
    deliveryStore.records.push({
      id: 'd1',
      linkId: 'link-1',
      linkName: 'Kiro Market · eu',
      channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
      key: VALID_KEY,
      region: 'eu-central-1',
      accountId: 'acc-1',
      state: KSK_HUNTER_DELIVERY_STATE.PENDING,
      attempts: 2,
      createdAt: 1,
      updatedAt: 1
    })
    const manager = new KskHunterManager(
      makeDeps(hunterStore(), recorded, {
        // 列表查不到货，只跑推送队列，避免又买一个混进来
        fetchImpl: async () => jsonResponse({ code: 0, data: [] })
      })
    )

    await manager.start()
    await vi.waitFor(() => expect(recorded).toHaveLength(1))
    manager.stop()

    expect(recorded[0].attempts).toBe(3)
    expect(recorded[0].accountId).toBe('acc-1')
  })

  it('交付账本写盘失败不打断抢号主流程', async () => {
    deliveryStore.reset()
    const recorded: DownstreamDelivery[] = []
    const manager = new KskHunterManager(
      makeDeps(hunterStore(), recorded, {
        recordDownstreamDelivery: async () => {
          throw new Error('disk full')
        }
      })
    )

    const status = await manager.runNow()
    await vi.waitFor(() =>
      expect(deliveryStore.records[0]?.state).toBe(KSK_HUNTER_DELIVERY_STATE.DELIVERED)
    )
    manager.stop()

    // 号照样买到、照样推给了下游
    expect(status.totalOrdered).toBe(1)
  })

  it('下单时把目标分组写进推送记录，之后改配置不影响已买的号', async () => {
    deliveryStore.reset()
    const recorded: DownstreamDelivery[] = []
    const store = hunterStore({ targetGroupId: 'group-1', downstreamEnabled: false })
    const manager = new KskHunterManager(makeDeps(store, recorded))

    await manager.runNow()
    manager.stop()

    expect(deliveryStore.records[0]).toMatchObject({
      groupId: 'group-1',
      accountId: 'acc-1'
    })
  })
})
