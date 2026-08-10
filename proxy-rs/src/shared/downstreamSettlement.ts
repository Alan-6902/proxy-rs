/**
 * 下游对账的共享契约：主进程记交付、渲染进程出报表、结算写 CSV，口径只有这一份。
 *
 * 要回答的问题：**这段时间我交给下游哪些号、下游拿它们烧了多少积分**，用来对账收款。
 * 现有三份数据都答不了：
 * - 抢号报表（`hunterReport`）只到渠道/链接维度，且事件流刻意不含 key，看不出是哪个号；
 * - 运行态推送队列（`configStore` 的 `deliveries`）只留最近 200 条，会被裁掉；
 * - 抢号台账（`kskLedger`）是**采购**维度，没有交付时刻，也不区分交付成功与验活判死。
 *
 * 所以另存一份交付账本（见 main/downstreamSettlement/deliveryLedgerStore），
 * 只在推送下游成功那一刻记一条，只追加、不裁剪。
 *
 * ## 两种口径，不要混
 *
 * - **交付数与花费是精确的自然日口径**：`deliveredAt` 是精确时间戳，按本地自然日过滤即可。
 * - **积分是区间口径**：上游只给累计值，要得到「某个自然日烧了多少」必须在日界那一刻
 *   正好采样，而桌面应用可能整天没开。所以积分按「上次结算到本次结算」的区间记账，
 *   区间起止一并落进 CSV 与结算记录，不假装是单日。结算 tick 是 30 分钟一轮，
 *   正常情况下区间紧贴日界，误差在半小时内；应用关了几天则会并成一个长区间。
 */

import { hunterLocalDateKey, roundCny, type KskHunterChannel } from './kskHunter'
import type { KskLedgerState } from './kskLedger'

/** CSV 默认落在 userData 下的这个子目录；用户可在对账页改成任意目录。 */
export const DOWNSTREAM_CSV_DIR_NAME = 'downstream-csv'

/** CSV 文件名前缀，完整形如 `downstream-2026-08-10.csv`。 */
export const DOWNSTREAM_CSV_FILE_PREFIX = 'downstream-'

/**
 * 结算记录保留天数。
 *
 * 这是「历史某天积分」的可查镜像；CSV 才是无界存档。90 天 × 50 个在用号
 * 约 180KB，够翻一个季度的账，再往前就去看 CSV。
 */
export const DOWNSTREAM_SETTLEMENT_RETENTION_DAYS = 90

/** 结算调度间隔（分钟）。tick 时补齐所有未结算的过去日期，不做午夜定时。 */
export const DOWNSTREAM_SETTLEMENT_TICK_MINUTES = 30

/** 按天汇总表可切换的跨度。 */
export const DOWNSTREAM_REPORT_WINDOW_OPTIONS = [7, 30] as const

/** 按天汇总表默认跨度。 */
export const DOWNSTREAM_REPORT_WINDOW_DAYS = 30

/** 「全天」在小时筛选里的取值。 */
export const DOWNSTREAM_ALL_HOURS = 'all'

export type DownstreamReportHour = number | typeof DOWNSTREAM_ALL_HOURS

/**
 * 一条交付记录：一个号在某一刻被成功交给下游。
 *
 * **含完整 key**，所以落盘那份必须加密（见 deliveryLedgerStore）。
 * 完整 key 只出现在两处：加密的交付账本，和用户主动要求的 CSV。
 * 发给渲染进程的视图（`DownstreamDeliveryRow`）只带脱敏 key。
 *
 * 对账必需的列（分组、买入价、渠道）在这里自带一份快照，不回查台账：
 * 台账允许被用户清空（`clearKskLedger`），清了之后这些列不能跟着消失。
 * 只有积分必然依赖台账——它是持续更新的观测量，没法在交付那一刻定格。
 */
export interface DownstreamDelivery {
  /** 复用推送记录的 id，据此去重（重试成功可能重复触发一次记账）。 */
  id: string
  /**
   * 本地账号库的账号 id，用来关联台账取积分消耗。
   *
   * 下单时还没有（要等验活入库才拿到），所以是可选的。缺失时该号的积分列显示未知，
   * 而不是 0——把「查不到」显示成「没烧」会让对账少收钱。
   */
  accountId?: string
  /** Kiro API Key 明文。 */
  key: string
  /** 展示用脱敏 key（`ksk_...abcd`）。 */
  maskedKey: string
  region: string

  /* ---- 来源快照 ---- */
  channel: KskHunterChannel
  linkId: string
  linkName: string
  /** 交付时所属的账号分组 id；未分组时 undefined。不同分组通常对应不同下游。 */
  groupId?: string

  /* ---- 时间与成本 ---- */
  /** 下单成功的时刻。 */
  purchasedAt: number
  /** 推送下游成功的时刻，也是这条记录归入哪个自然日的依据。 */
  deliveredAt: number
  /** 推送尝试次数，1 表示一次就成。 */
  attempts: number
  /** 该单原币金额；商品未给价格时 undefined。 */
  costUnit?: number
  costCny?: number
  unitLabel?: string

  /* ---- 结算锚点 ---- */
  /**
   * 上次结算时该号的累计消耗积分（台账的 `usedCredits`）。
   *
   * 日增量 = 台账当前累计 − 这个锚点。用锚点差而不是逐日快照表：累计值本身单调
   * （台账已处理按月重置的结转），直接减就是这段区间的消耗，O(1) 且不怕漏采几轮。
   * 还没结算过时 undefined，第一次结算按「从交付到现在」的全部消耗算。
   */
  settledCredits?: number
  /** 上次结算的时刻，也是下一个积分区间的起点。 */
  settledAt?: number
}

/**
 * 某个号在一次结算里的积分增量。
 *
 * 区间起止都记下来：应用关机几天后再开，一次结算会并掉那几天，
 * 只写一个「当日积分」会让人以为那是单日消耗。
 */
export interface DownstreamCreditDelta {
  accountId: string
  /** 本区间新增的消耗积分。 */
  creditsDelta: number
  /** 区间起点（上次结算时刻；首次结算时为交付时刻）。 */
  fromAt: number
  /** 区间止点（本次结算时刻）。 */
  toAt: number
}

/**
 * 一天的结算定稿。
 *
 * 这是 UI 查「历史某天积分」的唯一来源——台账只有当前累计值，
 * 减不出过去某一天的增量。
 */
export interface DownstreamDaySettlement {
  /** 本地日期键 YYYY-MM-DD。 */
  date: string
  /** 结算执行的时刻。 */
  settledAt: number
  /** 当日交付的号数。 */
  deliveries: number
  /** 当日交付的花费合计（人民币元）。 */
  spendCny: number
  /** 本次结算归到这一天的积分合计。 */
  credits: number
  /** 逐号的积分增量，供 CSV 与页面按号展开。 */
  perAccount: DownstreamCreditDelta[]
}

/**
 * 台账里能查到的当前消耗，按账号 id 索引。
 *
 * 做成入参而不是让本模块去读台账：这里是纯函数层，读盘归 main 侧。
 */
export interface DownstreamLedgerUsage {
  accountId: string
  /** 台账累计消耗积分（`KskLedgerEntry.usedCredits`）。 */
  usedCredits: number
  usageLimit?: number
  state: KskLedgerState
}

/**
 * 报表里的一行：一个号在某一天的对账数据。
 *
 * **刻意不含完整 key**：这个类型会经 IPC 发到渲染进程，页面上只显示脱敏 key。
 * 完整 key 只走 CSV（`DownstreamCsvRow`）。
 */
export interface DownstreamDeliveryRow {
  id: string
  accountId?: string
  maskedKey: string
  region: string
  channel: KskHunterChannel
  linkName: string
  /** 分组展示名，出报表时按当前分组表查得；未分组或分组已删时 undefined。 */
  groupName?: string
  deliveredAt: number
  /** 交付时刻所属的本地小时（0-23），供小时筛选与柱状图用。 */
  hour: number
  attempts: number
  costUnit?: number
  costCny?: number
  unitLabel?: string
  /** 是否在所查日期当天交付。false 表示更早交付、当天仍在烧积分。 */
  deliveredToday: boolean
  /** 该日（区间）新增积分；台账查不到该号时 undefined。 */
  creditsDelta?: number
  /** 积分区间起止；未结算过的当天为 undefined。 */
  creditsFromAt?: number
  creditsToAt?: number
  /** 台账里的累计消耗；查不到时 undefined。 */
  totalCredits?: number
  /** 台账里的号状态；查不到时 undefined。 */
  state?: KskLedgerState
}

/** 按天汇总的一行，用来快速定位要对账的日子。 */
export interface DownstreamDayRow {
  date: string
  /** 该本地日 00:00 的时间戳。 */
  at: number
  deliveries: number
  spendCny: number
  /** 该日积分；未结算的当天按实时台账估算。 */
  credits: number
  /** 该日是否已结算定稿。未定稿的当天数字仍会变。 */
  settled: boolean
}

export interface DownstreamDayReport {
  generatedAt: number
  /** 所查的本地日期键。 */
  date: string
  /** 该日是否已结算定稿。 */
  settled: boolean
  settledAt?: number
  /** 当日交付数。 */
  deliveries: number
  /** 当日交付花费合计（人民币元）。 */
  spendCny: number
  /** 当日积分合计。 */
  credits: number
  /** 当日交付明细 + 当日仍在烧积分的更早交付号。 */
  rows: DownstreamDeliveryRow[]
  /** 24 个桶，索引为本地小时，值为该小时交付的号数。 */
  deliveriesByHour: number[]
  /** 交付账本总条数（不受日期限制）。 */
  totalDeliveryCount: number
  /** 账本里最早一条交付的时间。 */
  earliestDeliveredAt?: number
  /** 累计交付数与花费，用于页面顶部的「历史总计」。 */
  totalSpendCny: number
}

export interface DownstreamReport extends DownstreamDayReport {
  /** 按天汇总，最近 `days` 天，含没有数据的天（曲线不能把缺口连成直线）。 */
  daily: DownstreamDayRow[]
  /** 按天汇总的跨度。 */
  days: number
  /** CSV 导出目录的绝对路径，供页面展示与「打开目录」。 */
  csvDir: string
}

/** 本地日 00:00 的时间戳。按本地年月日重构 Date，不用取模——那样按 UTC 切会整体错位。 */
export function downstreamDayStart(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 本地日期键 YYYY-MM-DD 转成该日 00:00 的时间戳；格式不合法时返回 undefined。 */
export function downstreamDateKeyToStart(date: string): number | undefined {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (!matched) return undefined
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  const parsed = new Date(year, month - 1, day)
  // 构造回来对不上说明日期不存在（如 2026-02-30），别把它当合法日期
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return undefined
  }
  return parsed.getTime()
}

/**
 * 生成连续的日期序列（含首尾），最后一天是 `now` 所在的本地日。
 *
 * 按「日」加减而不是减毫秒：跨夏令时的地区减 24h 会落到前一天 23:00。
 */
export function downstreamDateRange(days: number, now: number): { date: string; at: number }[] {
  const span = Math.max(1, Math.floor(days))
  const todayStart = downstreamDayStart(now)
  const result: { date: string; at: number }[] = []
  for (let offset = span - 1; offset >= 0; offset--) {
    const date = new Date(todayStart)
    date.setDate(date.getDate() - offset)
    const at = date.getTime()
    result.push({ date: hunterLocalDateKey(at), at })
  }
  return result
}

/**
 * 某个号截至现在的未结算积分增量。
 *
 * 台账查不到该号时返回 undefined（不是 0）：可能是台账被清空、或号还没入库，
 * 显示成 0 会让对账少收钱，显示「未知」才提示人去核。
 *
 * 台账累计值低于锚点时记 0：正常不会发生（累计值单调，按月重置已由台账的
 * `applyLedgerObservation` 结转成 `carriedCredits`），真撞上说明台账被清空后
 * 重新建了基线，此时记负数只会污染账目。
 */
export function downstreamPendingCredits(
  delivery: DownstreamDelivery,
  usage: DownstreamLedgerUsage | undefined
): number | undefined {
  if (!usage) return undefined
  const anchor = delivery.settledCredits ?? 0
  return Math.max(0, usage.usedCredits - anchor)
}

export interface DownstreamDayInput {
  /** 全量交付记录。窗口过滤在函数内做，`totalDeliveryCount` 要反映全部历史。 */
  deliveries: readonly DownstreamDelivery[]
  /** 已定稿的结算记录。 */
  settlements: readonly DownstreamDaySettlement[]
  /** 台账当前消耗，按账号 id 索引。 */
  usage?: Readonly<Record<string, DownstreamLedgerUsage>>
  /** 分组 id → 名字。交付记录只存 id（分组可改名），出报表时现查。 */
  groupNames?: Readonly<Record<string, string>>
  /** 要看哪一天，本地日期键。省略时看 `now` 所在的当天。 */
  date?: string
  now?: number
}

/**
 * 聚合某一天的对账数据。
 *
 * 行集是**两个集合的并**：当天交付的号，加上当天有积分增量的号（可能是更早交付的）。
 * 这正是「按交付数收」与「按积分收」两种口径都能对上的形状。
 *
 * 已定稿的日子读结算记录（积分是历史增量，台账现在减不出来）；
 * 未定稿的当天用实时台账估算，页面上标出「未定稿」。
 */
export function summarizeDownstreamDay(input: DownstreamDayInput): DownstreamDayReport {
  const now = input.now ?? Date.now()
  const date = input.date ?? hunterLocalDateKey(now)
  const dayStart = downstreamDateKeyToStart(date) ?? downstreamDayStart(now)
  const nextDayStart = new Date(dayStart)
  nextDayStart.setDate(nextDayStart.getDate() + 1)
  const dayEnd = nextDayStart.getTime()

  const usage = input.usage ?? {}
  const groupNames = input.groupNames ?? {}
  const settlement = input.settlements.find((item) => item.date === date)
  const deliveryById = new Map(input.deliveries.map((item) => [item.id, item]))

  /*
   * 积分来源二选一：定稿日读结算记录里的历史增量，**当天**用实时台账估算。
   *
   * 定稿日不能回头用台账减——台账只有当前累计值，那样会把定稿之后新烧的量
   * 也算进这一天。
   *
   * 过去某天却没定稿（应用关了几天、结算 tick 还没跑）时积分留空，不拿实时值顶上：
   * 待结算的积分会被 `computeDownstreamSettlement` 记到**最早**那个未结算日，
   * 其余日子归 0。此时给每个未定稿的过去日都显示同一个实时值，等 tick 跑完
   * 就会变成 0，用户会以为账目自己变了。留空 + 「未定稿」标记才是实话。
   */
  const isToday = date === hunterLocalDateKey(now)
  const creditsByAccount = new Map<string, DownstreamCreditDelta>()
  if (settlement) {
    for (const entry of settlement.perAccount) creditsByAccount.set(entry.accountId, entry)
  } else if (isToday) {
    for (const delivery of input.deliveries) {
      if (!delivery.accountId) continue
      const pending = downstreamPendingCredits(delivery, usage[delivery.accountId])
      if (pending === undefined || pending <= 0) continue
      creditsByAccount.set(delivery.accountId, {
        accountId: delivery.accountId,
        creditsDelta: pending,
        fromAt: delivery.settledAt ?? delivery.purchasedAt,
        toAt: now
      })
    }
  }

  const toRow = (delivery: DownstreamDelivery, deliveredToday: boolean): DownstreamDeliveryRow => {
    const accountUsage = delivery.accountId ? usage[delivery.accountId] : undefined
    const delta = delivery.accountId ? creditsByAccount.get(delivery.accountId) : undefined
    return {
      id: delivery.id,
      accountId: delivery.accountId,
      maskedKey: delivery.maskedKey,
      region: delivery.region,
      channel: delivery.channel,
      linkName: delivery.linkName,
      groupName: delivery.groupId ? groupNames[delivery.groupId] : undefined,
      deliveredAt: delivery.deliveredAt,
      hour: new Date(delivery.deliveredAt).getHours(),
      attempts: delivery.attempts,
      costUnit: delivery.costUnit,
      costCny: delivery.costCny,
      unitLabel: delivery.unitLabel,
      deliveredToday,
      creditsDelta: delta?.creditsDelta,
      creditsFromAt: delta?.fromAt,
      creditsToAt: delta?.toAt,
      totalCredits: accountUsage?.usedCredits,
      state: accountUsage?.state
    }
  }

  const rows: DownstreamDeliveryRow[] = []
  const deliveriesByHour = Array.from({ length: 24 }, () => 0)
  let deliveries = 0
  let spendCny = 0
  const includedIds = new Set<string>()

  for (const delivery of input.deliveries) {
    if (delivery.deliveredAt < dayStart || delivery.deliveredAt >= dayEnd) continue
    deliveries++
    spendCny = roundCny(spendCny + (delivery.costCny ?? 0))
    deliveriesByHour[new Date(delivery.deliveredAt).getHours()]++
    rows.push(toRow(delivery, true))
    includedIds.add(delivery.id)
  }

  /*
   * 补上「更早交付、当天仍在烧积分」的号。用交付记录里 accountId 最新的那条：
   * 同一个账号 id 正常只有一条交付记录，真重复时取更晚的更接近当前状态。
   */
  for (const [accountId, delta] of creditsByAccount) {
    if (delta.creditsDelta <= 0) continue
    let candidate: DownstreamDelivery | undefined
    for (const delivery of deliveryById.values()) {
      if (delivery.accountId !== accountId) continue
      if (!candidate || delivery.deliveredAt > candidate.deliveredAt) candidate = delivery
    }
    if (!candidate || includedIds.has(candidate.id)) continue
    rows.push(toRow(candidate, false))
    includedIds.add(candidate.id)
  }

  const credits = settlement
    ? settlement.credits
    : [...creditsByAccount.values()].reduce((sum, item) => sum + item.creditsDelta, 0)

  rows.sort((a, b) => b.deliveredAt - a.deliveredAt || a.maskedKey.localeCompare(b.maskedKey))

  return {
    generatedAt: now,
    date,
    settled: settlement !== undefined,
    settledAt: settlement?.settledAt,
    deliveries,
    spendCny,
    credits,
    rows,
    deliveriesByHour,
    totalDeliveryCount: input.deliveries.length,
    earliestDeliveredAt:
      input.deliveries.length > 0
        ? Math.min(...input.deliveries.map((item) => item.deliveredAt))
        : undefined,
    totalSpendCny: roundCny(input.deliveries.reduce((sum, item) => sum + (item.costCny ?? 0), 0))
  }
}

/**
 * 按天汇总最近 `days` 天。
 *
 * 交付数与花费直接从交付记录按日切；积分优先读定稿记录，当天（还没定稿）用实时台账估算。
 * 缺数据的天也保留一行，否则曲线会把缺口连成直线。
 */
export function summarizeDownstreamDaily(input: {
  deliveries: readonly DownstreamDelivery[]
  settlements: readonly DownstreamDaySettlement[]
  usage?: Readonly<Record<string, DownstreamLedgerUsage>>
  days?: number
  now?: number
}): DownstreamDayRow[] {
  const now = input.now ?? Date.now()
  const days = Math.max(1, Math.floor(input.days ?? DOWNSTREAM_REPORT_WINDOW_DAYS))
  const range = downstreamDateRange(days, now)
  const settlementByDate = new Map(input.settlements.map((item) => [item.date, item]))
  const usage = input.usage ?? {}

  const rowByDate = new Map<string, DownstreamDayRow>()
  for (const entry of range) {
    const settlement = settlementByDate.get(entry.date)
    rowByDate.set(entry.date, {
      date: entry.date,
      at: entry.at,
      deliveries: 0,
      spendCny: 0,
      credits: settlement?.credits ?? 0,
      settled: settlement !== undefined
    })
  }

  for (const delivery of input.deliveries) {
    const row = rowByDate.get(hunterLocalDateKey(delivery.deliveredAt))
    if (!row) continue
    row.deliveries++
    row.spendCny = roundCny(row.spendCny + (delivery.costCny ?? 0))
  }

  // 未定稿的那天（正常就是今天）用实时台账估算积分，让页面当天也有数
  const today = hunterLocalDateKey(now)
  const todayRow = rowByDate.get(today)
  if (todayRow && !todayRow.settled) {
    let credits = 0
    for (const delivery of input.deliveries) {
      if (!delivery.accountId) continue
      const pending = downstreamPendingCredits(delivery, usage[delivery.accountId])
      if (pending !== undefined) credits += pending
    }
    todayRow.credits = credits
  }

  return range.map((entry) => rowByDate.get(entry.date) as DownstreamDayRow)
}

/**
 * 算出一次日结算：定稿记录 + 推进后的交付记录。
 *
 * 纯函数，落盘归 main 侧。返回的 `deliveries` 是推进过锚点的新数组（不改原数组）。
 *
 * 锚点推进到「台账当前累计值」而不是「本日末的值」：台账只有当前值，没有历史。
 * 代价是结算时刻之后到真正跨日之间那点消耗会被算进前一天——tick 是 30 分钟一轮，
 * 正常误差在半小时内，且区间起止都写进了记录，看得出来。
 *
 * 台账查不到的号不推进锚点：可能是台账被清空或还没入库，推进会把「未知」永久
 * 定格成 0，之后再也算不回来。
 */
export function computeDownstreamSettlement(input: {
  deliveries: readonly DownstreamDelivery[]
  usage: Readonly<Record<string, DownstreamLedgerUsage>>
  /** 要结算哪一天，本地日期键。 */
  date: string
  /** 结算执行时刻。 */
  at: number
}): { settlement: DownstreamDaySettlement; deliveries: DownstreamDelivery[] } {
  const dayStart = downstreamDateKeyToStart(input.date)
  const perAccount: DownstreamCreditDelta[] = []
  let credits = 0
  let deliveries = 0
  let spendCny = 0

  const next = input.deliveries.map((delivery) => {
    if (dayStart !== undefined && hunterLocalDateKey(delivery.deliveredAt) === input.date) {
      deliveries++
      spendCny = roundCny(spendCny + (delivery.costCny ?? 0))
    }

    if (!delivery.accountId) return delivery
    const accountUsage = input.usage[delivery.accountId]
    const pending = downstreamPendingCredits(delivery, accountUsage)
    // 查不到台账：保持锚点不动，下次结算还能补上
    if (pending === undefined || accountUsage === undefined) return delivery

    if (pending > 0) {
      perAccount.push({
        accountId: delivery.accountId,
        creditsDelta: pending,
        fromAt: delivery.settledAt ?? delivery.purchasedAt,
        toAt: input.at
      })
      credits += pending
    }

    return { ...delivery, settledCredits: accountUsage.usedCredits, settledAt: input.at }
  })

  return {
    settlement: {
      date: input.date,
      settledAt: input.at,
      deliveries,
      spendCny,
      credits,
      perAccount
    },
    deliveries: next
  }
}

/** 结算记录只留最近 N 天，更早的去看 CSV。 */
export function pruneDownstreamSettlements(
  settlements: readonly DownstreamDaySettlement[],
  now: number,
  retentionDays = DOWNSTREAM_SETTLEMENT_RETENTION_DAYS
): DownstreamDaySettlement[] {
  const cutoff = new Date(downstreamDayStart(now))
  cutoff.setDate(cutoff.getDate() - Math.max(1, retentionDays))
  const cutoffAt = cutoff.getTime()
  return settlements
    .filter((item) => (downstreamDateKeyToStart(item.date) ?? 0) >= cutoffAt)
    .sort((a, b) => a.date.localeCompare(b.date))
}

/* ------------------------------------------------------------------
 * CSV 存档
 *
 * ⚠️ CSV 里带**完整 key**（用户明确要求，便于与下游精确对账）。这份文件泄露
 * 等于号被直接拿走，所以：写盘权限 0o600；页面与日志一律只显示脱敏 key；
 * 导出目录若指向云同步盘，完整 key 会被上传，UI 上有提示。
 * ------------------------------------------------------------------ */

/**
 * UTF-8 BOM。
 *
 * Excel 不认无 BOM 的 UTF-8，中文表头会乱码。写成转义而不是字面量：
 * 字面 BOM 是不可见字符，编辑器里看不出来，也过不了 no-irregular-whitespace。
 */
export const CSV_BOM = '\ufeff'

/** CSV 表头。顺序即列序，改动会让历史文件与新文件列对不上，所以视为契约。 */
export const DOWNSTREAM_CSV_HEADERS = [
  '日期',
  '交付时刻',
  '交付小时',
  '完整Key',
  '脱敏Key',
  'Region',
  '渠道',
  '链接',
  '分组',
  '买入价',
  '计价单位',
  '买入价CNY',
  '是否当日交付',
  '当日新增积分',
  '积分区间起',
  '积分区间止',
  '累计消耗积分',
  '号状态'
] as const

/** 一行 CSV 的原始数据：报表行 + 完整 key。 */
export interface DownstreamCsvRow extends DownstreamDeliveryRow {
  key: string
}

/**
 * CSV 字段转义。
 *
 * 含逗号、引号、换行或前后空格时套引号并把内部引号翻倍（RFC 4180）。
 * 链接名是用户自己填的，出现逗号很正常，不转义会把一列撑成两列。
 */
export function escapeCsvField(value: string): string {
  return /[",\n\r]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value
}

/** 时间戳转本地「YYYY-MM-DD HH:mm:ss」，Excel 与 awk 都好读。 */
function formatCsvTimestamp(at?: number): string {
  if (at === undefined) return ''
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

function formatCsvNumber(value?: number): string {
  return value === undefined ? '' : String(value)
}

/** 一行报表数据转成 CSV 的各列。 */
export function toDownstreamCsvFields(row: DownstreamCsvRow, date: string): string[] {
  return [
    date,
    formatCsvTimestamp(row.deliveredAt),
    String(row.hour).padStart(2, '0'),
    row.key,
    row.maskedKey,
    row.region,
    row.channel,
    row.linkName,
    row.groupName ?? '',
    formatCsvNumber(row.costUnit),
    row.unitLabel ?? '',
    formatCsvNumber(row.costCny),
    row.deliveredToday ? '是' : '否',
    formatCsvNumber(row.creditsDelta),
    formatCsvTimestamp(row.creditsFromAt),
    formatCsvTimestamp(row.creditsToAt),
    formatCsvNumber(row.totalCredits),
    row.state ?? ''
  ]
}

/**
 * 生成一天的 CSV 全文。
 *
 * 带 UTF-8 BOM：Excel 不认无 BOM 的 UTF-8，中文表头会乱码（沿用账号导出的做法）。
 * 没有任何行时仍然写表头——空文件比缺文件好判断，「那天确实没交付」和
 * 「导出失败了」不该长得一样。
 */
export function buildDownstreamCsv(rows: readonly DownstreamCsvRow[], date: string): string {
  const lines = [DOWNSTREAM_CSV_HEADERS.map(escapeCsvField).join(',')]
  for (const row of rows) {
    lines.push(toDownstreamCsvFields(row, date).map(escapeCsvField).join(','))
  }
  return `${CSV_BOM}${lines.join('\n')}\n`
}

/** 某个日期的 CSV 文件名。 */
export function downstreamCsvFileName(date: string): string {
  return `${DOWNSTREAM_CSV_FILE_PREFIX}${date}.csv`
}
