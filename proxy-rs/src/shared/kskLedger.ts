/**
 * 抢号台账的共享契约：主进程记账、渲染进程出报表，口径只有这一份。
 *
 * 要回答的问题：**这个号花多少钱买的、活了多长时间、下游拿它烧了多少积分**。
 * 现有两份报表都答不了：
 * - 抢号报表（`hunterReport`）只到渠道/链接维度，成本落不到具体号上；
 * - 反代报表（`localAdminStats`）只统计走**本机反代**的请求，而这些号是交给
 *   下游去用的，本机反代根本看不见它们的消耗。
 *
 * ## 消耗从哪来
 *
 * 号买来是独占给下游的，所以「这个号的全部额度消耗」就等于「下游烧的量」。
 * 该数据不经反代 Admin，直接来自上游 `GetUsageLimits`（`kiro_api_key` 可直接调，
 * 见 main/index.ts 的 getUsageAndLimits）：
 * - 入库时已经拉过一次，那个值就是**买入时的额度基线**（二手号买来可能已经
 *   烧掉一部分，记进基线才不会把前主的消耗算到你账上）；
 * - 账号页默认开启 5 分钟一轮的自动刷新，会持续更新每个账号的 `usage.current`。
 *
 * 于是「下游烧了多少」= 当前 `usage.current` − 买入时基线。
 *
 * ## 关联键
 *
 * 用本地账号库的账号 id。曾经用过 `sha256(ksk 明文)`（为了跟 Admin 的 apiKeyHash
 * 对碰），但消耗数据换成本地 usage 之后就不需要绕哈希了——本地账号库里有明文，
 * 直接按 id 关联更直接。台账里仍然只存脱敏 key，不存明文。
 *
 * 只收抢号买来的号：手动推送与自动同步进来的号没有采购记录，算不出成本与 ROI。
 * 所以 `applyLedgerObservation` 只更新已有条目，不为陌生账号建档。
 */

import type { KskHunterChannel } from './kskHunter'

/** 一小时的毫秒数，存活时长与每小时产出共用。 */
export const KSK_LEDGER_HOUR_MS = 3_600_000

/** 台账状态：号还在服役，还是已经下线了。 */
export const KSK_LEDGER_STATE = {
  /** 还在账号库里服役。 */
  ALIVE: 'alive',
  /** 已经从账号库消失（被清理、被删）。 */
  RETIRED: 'retired',
  /** 买到但发消息验活没过：钱花了，号从没用上。 */
  DEAD_ON_ARRIVAL: 'dead_on_arrival'
} as const

export type KskLedgerState = (typeof KSK_LEDGER_STATE)[keyof typeof KSK_LEDGER_STATE]

export const KSK_LEDGER_STATE_LABEL: Record<KskLedgerState, string> = {
  [KSK_LEDGER_STATE.ALIVE]: '在用',
  [KSK_LEDGER_STATE.RETIRED]: '已下线',
  [KSK_LEDGER_STATE.DEAD_ON_ARRIVAL]: '买到即废'
}

/** 号下线的原因，用来区分「烧干了」和「白买了」。 */
export const KSK_LEDGER_RETIRE_REASON = {
  /** 额度耗尽被自动/手动清理。这是号的正常寿终。 */
  EXHAUSTED: 'exhausted',
  /** 发消息验活判永久失效（封号、认证失败）。 */
  INVALID: 'invalid',
  /**
   * 从账号库消失了但没人报告过原因。
   *
   * 用户手动删了账号、或换了一份账号库都会走到这里。
   */
  VANISHED: 'vanished'
} as const

export type KskLedgerRetireReason =
  (typeof KSK_LEDGER_RETIRE_REASON)[keyof typeof KSK_LEDGER_RETIRE_REASON]

export const KSK_LEDGER_RETIRE_REASON_LABEL: Record<KskLedgerRetireReason, string> = {
  [KSK_LEDGER_RETIRE_REASON.EXHAUSTED]: '额度耗尽',
  [KSK_LEDGER_RETIRE_REASON.INVALID]: '验活判死',
  [KSK_LEDGER_RETIRE_REASON.VANISHED]: '已从账号库删除'
}

/** 台账保留条数上限。一条约 300 字节，5000 条约 1.5MB，够记一年多的采购。 */
export const KSK_LEDGER_MAX_ENTRIES = 5_000

/** 报表可切换的时间跨度（天）。 */
export const KSK_LEDGER_WINDOW_OPTIONS = [7, 30, 90] as const

/** 报表默认窗口。 */
export const KSK_LEDGER_DEFAULT_WINDOW_DAYS = 30

/**
 * 一条台账记录：一个买来的号，从下单到下线的全过程。
 *
 * 刻意不含 ksk 明文，只留 `maskedKey`——这份文件是明文 JSON，
 * 存了明文就等于把已购的号裸奔在磁盘上。
 */
export interface KskLedgerEntry {
  /** 本地账号库的账号 id，这条记录的主键。 */
  accountId: string
  /** 展示用脱敏 key（`ksk_...abcd`），下单时本地算好存下来。 */
  maskedKey: string
  region: string

  /* ---- 采购 ---- */
  channel: KskHunterChannel
  linkId: string
  linkName: string
  /**
   * 抢到时落进的账号分组 id（抢号配置里的 targetGroupId）；未分组时为 undefined。
   *
   * 记下来是因为不同分组通常对应不同下游，按它汇总才看得出「哪一路的号更划算」。
   * 存 id 而不是名字：分组可以改名，名字在出报表时按当前分组表现查。
   */
  groupId?: string
  /** 下单成功的时刻，也是存活时长的起点。 */
  purchasedAt: number
  /** 该单原币金额；商品未给价格时为 undefined。 */
  costUnit?: number
  /** 该单折合人民币元。 */
  costCny?: number
  unitLabel?: string

  /* ---- 生命周期 ---- */
  /** 最后一次在账号库里观测到的时刻。 */
  lastSeenAt?: number
  /** 从账号库消失（或被判死）的时刻；仍在用时为 undefined。 */
  retiredAt?: number
  retireReason?: KskLedgerRetireReason

  /* ---- 消耗 ---- */
  /**
   * 当前计费周期的额度基线（上游累计 `usage.current`）。
   *
   * 二手号买来时可能已经烧掉一部分，记住这个基线才不会把前主的消耗
   * 算成下游的产出。入库时拉的那次 usage 就是它的初值。
   *
   * 额度按月重置时这个基线会跟着降到新值，同时把本周期已烧的量结转进
   * `carriedCredits`，见 applyLedgerObservation。
   */
  baselineUsage?: number
  /** 最后一次观测到的累计额度消耗。 */
  currentUsage?: number
  /** 该号的额度上限，用来显示水位。 */
  usageLimit?: number
  /**
   * 已结转的历史消耗：额度重置之前那些周期烧掉的量之和。
   *
   * 单独存是因为重置会把上游的 `usage.current` 打回 0，只靠「当前 − 基线」
   * 算不出重置前的那部分，而那是真花出去的钱，不能抹掉。
   */
  carriedCredits?: number
  /**
   * 下游总共烧掉的积分 = `carriedCredits + (currentUsage − baselineUsage)`。
   *
   * 存成字段而不是每次现算：号被删掉之后 `currentUsage` 就再也拉不到了，
   * 但这个数得留在账上。
   */
  usedCredits: number
}

/**
 * 一轮观测里的单个账号，取自本地账号库。
 *
 * 只要 usage：token 与成功次数是反代口径的东西，号交给下游用之后本地拿不到，
 * 硬留字段只会在页面上显示成 0 误导人。
 */
export interface KskLedgerObservation {
  accountId: string
  /** 上游累计已用额度（`account.usage.current`）。 */
  currentUsage?: number
  usageLimit?: number
}

/** 报表里的一行：台账记录 + 算出来的派生量。 */
export interface KskLedgerRow extends KskLedgerEntry {
  state: KskLedgerState
  /** 存活毫秒数：买入到下线（仍在用时算到 now）。 */
  aliveMs: number
  /** 每积分成本（人民币元）；没花钱或没产出时为 undefined。 */
  cnyPerCredit?: number
  /** 每小时产出的积分；存活不足一分钟或没产出时为 undefined。 */
  creditsPerHour?: number
  /** 额度用掉的比例（0-1）；拿不到上限时为 undefined。 */
  usagePercent?: number
  /** 分组展示名，出报表时按当前分组表查得；分组已删或未分组时为 undefined。 */
  groupName?: string
}

export interface KskLedgerTotals {
  entries: number
  alive: number
  retired: number
  /** 买到即废：钱花了但号从没用上。 */
  wasted: number
  spendCny: number
  /** 有价格记录的订单数，均价的分母。 */
  pricedOrders: number
  usedCredits: number
  /**
   * 全部号的平均存活时长（毫秒）。
   *
   * 分母是所有号，不是只算已下线的：抢到的号默认不删，一直留在账号库里，
   * 只统计已下线的会让这个值长期是 undefined。在用的号按「到现在」计时，
   * 所以这个数会随时间自然增长，读作「这批号平均已经服役多久」。
   */
  avgAliveMs?: number
  /** 整体每积分成本（人民币元）；没产出时为 undefined。 */
  cnyPerCredit?: number
  /** 单号平均花费（人民币元）；没有带价订单时为 undefined。 */
  avgCostCny?: number
}

/** 按分组汇总的一行。不同分组通常对应不同下游，用它对比哪一路更划算。 */
export interface KskLedgerGroupRow {
  /** 分组 id；未分组的号归到 undefined 这一档。 */
  groupId?: string
  groupName: string
  entries: number
  alive: number
  spendCny: number
  usedCredits: number
  /** 每积分成本（人民币元）；没产出时为 undefined。 */
  cnyPerCredit?: number
  /** 该组号的平均存活时长（毫秒）。 */
  avgAliveMs?: number
}

export interface KskLedgerReport {
  generatedAt: number
  days: number
  /** 窗口起点（按 purchasedAt 过滤，闭区间起点）。 */
  from: number
  rows: KskLedgerRow[]
  totals: KskLedgerTotals
  /** 按分组汇总，按花费从多到少排。 */
  byGroup: KskLedgerGroupRow[]
  /** 台账总条数（不受窗口限制），用来说明历史攒了多久。 */
  totalEntryCount: number
  /** 台账里最早一条采购的时间。 */
  earliestPurchasedAt?: number
}

export const EMPTY_KSK_LEDGER_TOTALS: KskLedgerTotals = {
  entries: 0,
  alive: 0,
  retired: 0,
  wasted: 0,
  spendCny: 0,
  pricedOrders: 0,
  usedCredits: 0
}

/** 报表行的排序维度。 */
export const KSK_LEDGER_SORT = {
  PURCHASED: 'purchased',
  COST: 'cost',
  CREDITS: 'credits',
  ALIVE: 'alive',
  EFFICIENCY: 'efficiency'
} as const

export type KskLedgerSort = (typeof KSK_LEDGER_SORT)[keyof typeof KSK_LEDGER_SORT]

/**
 * 判定一条记录当前处于哪个状态。
 *
 * 验活判死单独成一档「买到即废」：那是钱花了号从没用上，与「用到额度耗尽」
 * 是两种完全不同的结果，混在「已下线」里会让白买的号看不出来。
 */
export function resolveLedgerState(entry: KskLedgerEntry): KskLedgerState {
  if (entry.retiredAt === undefined) return KSK_LEDGER_STATE.ALIVE
  return entry.retireReason === KSK_LEDGER_RETIRE_REASON.INVALID
    ? KSK_LEDGER_STATE.DEAD_ON_ARRIVAL
    : KSK_LEDGER_STATE.RETIRED
}

/**
 * 存活时长：买入到下线，仍在用时算到 now。
 *
 * 起点用 `purchasedAt`：号是买来交给下游用的，从付钱那一刻就开始计寿命，
 * 「什么时候被下游真正拿去用」本地观测不到（下游是独立服务）。
 */
export function resolveLedgerAliveMs(entry: KskLedgerEntry, now: number): number {
  const end = entry.retiredAt ?? now
  return Math.max(0, end - entry.purchasedAt)
}

/** 台账条目转报表行，补上派生量。 */
export function toKskLedgerRow(entry: KskLedgerEntry, now: number): KskLedgerRow {
  const aliveMs = resolveLedgerAliveMs(entry, now)
  const aliveHours = aliveMs / KSK_LEDGER_HOUR_MS
  return {
    ...entry,
    state: resolveLedgerState(entry),
    aliveMs,
    // 分母是产出，产出为 0 时「每积分成本」是无穷大，报 undefined 让 UI 显示「—」
    cnyPerCredit:
      entry.costCny !== undefined && entry.costCny > 0 && entry.usedCredits > 0
        ? entry.costCny / entry.usedCredits
        : undefined,
    // 存活不足一分钟时样本太少，算出来的时均没有意义
    creditsPerHour:
      aliveMs >= 60_000 && entry.usedCredits > 0 ? entry.usedCredits / aliveHours : undefined,
    usagePercent:
      entry.usageLimit !== undefined && entry.usageLimit > 0 && entry.currentUsage !== undefined
        ? entry.currentUsage / entry.usageLimit
        : undefined
  }
}

/** 报表行排序。同键时按采购时间倒序，保证顺序稳定可复现。 */
export function compareKskLedgerRows(
  a: KskLedgerRow,
  b: KskLedgerRow,
  sort: KskLedgerSort
): number {
  switch (sort) {
    case KSK_LEDGER_SORT.COST:
      return (b.costCny ?? -1) - (a.costCny ?? -1) || b.purchasedAt - a.purchasedAt
    case KSK_LEDGER_SORT.CREDITS:
      return b.usedCredits - a.usedCredits || b.purchasedAt - a.purchasedAt
    case KSK_LEDGER_SORT.ALIVE:
      return b.aliveMs - a.aliveMs || b.purchasedAt - a.purchasedAt
    case KSK_LEDGER_SORT.EFFICIENCY:
      // 每积分成本越低越划算，所以升序；算不出的排最后而不是当成 0 顶在最前
      return (
        (a.cnyPerCredit ?? Number.POSITIVE_INFINITY) -
          (b.cnyPerCredit ?? Number.POSITIVE_INFINITY) || b.purchasedAt - a.purchasedAt
      )
    default:
      return b.purchasedAt - a.purchasedAt
  }
}

/** 汇总总览。全部由行算出，避免两处口径不一致。 */
export function aggregateKskLedger(rows: readonly KskLedgerRow[]): KskLedgerTotals {
  const totals: KskLedgerTotals = { ...EMPTY_KSK_LEDGER_TOTALS }
  let aliveMsSum = 0
  for (const row of rows) {
    totals.entries++
    if (row.state === KSK_LEDGER_STATE.ALIVE) totals.alive++
    if (row.state === KSK_LEDGER_STATE.RETIRED) totals.retired++
    if (row.state === KSK_LEDGER_STATE.DEAD_ON_ARRIVAL) totals.wasted++
    // 分母是所有号：抢到的号默认不删，只算已下线的会让这个值长期算不出来
    aliveMsSum += row.aliveMs
    totals.spendCny += row.costCny ?? 0
    if (row.costUnit !== undefined) totals.pricedOrders++
    totals.usedCredits += row.usedCredits
  }
  totals.spendCny = Math.round(totals.spendCny * 100) / 100
  totals.avgAliveMs = totals.entries > 0 ? aliveMsSum / totals.entries : undefined
  totals.cnyPerCredit =
    totals.usedCredits > 0 && totals.spendCny > 0 ? totals.spendCny / totals.usedCredits : undefined
  totals.avgCostCny =
    totals.pricedOrders > 0
      ? Math.round((totals.spendCny / totals.pricedOrders) * 100) / 100
      : undefined
  return totals
}

/**
 * 按分组汇总。
 *
 * 分组名由调用方给的 `groupNames` 查得（分组可以改名，台账只存 id）。
 * 查不到的分组说明已被删掉，标注出来而不是显示成空白——那样看不出这批号
 * 到底属于哪儿。
 */
export function aggregateKskLedgerByGroup(
  rows: readonly KskLedgerRow[],
  groupNames: Readonly<Record<string, string>> = {}
): KskLedgerGroupRow[] {
  const byGroup = new Map<string, { row: KskLedgerGroupRow; aliveMsSum: number }>()
  for (const row of rows) {
    // Map 的键不能是 undefined，未分组统一用空串占位，输出时再还原
    const key = row.groupId ?? ''
    let bucket = byGroup.get(key)
    if (!bucket) {
      bucket = {
        row: {
          groupId: row.groupId,
          groupName: row.groupId
            ? (groupNames[row.groupId] ?? `已删除的分组（${row.groupId.slice(0, 8)}）`)
            : '未分组',
          entries: 0,
          alive: 0,
          spendCny: 0,
          usedCredits: 0
        },
        aliveMsSum: 0
      }
      byGroup.set(key, bucket)
    }
    bucket.row.entries++
    if (row.state === KSK_LEDGER_STATE.ALIVE) bucket.row.alive++
    bucket.row.spendCny += row.costCny ?? 0
    bucket.row.usedCredits += row.usedCredits
    bucket.aliveMsSum += row.aliveMs
  }

  return [...byGroup.values()]
    .map(({ row, aliveMsSum }) => ({
      ...row,
      spendCny: Math.round(row.spendCny * 100) / 100,
      cnyPerCredit:
        row.usedCredits > 0 && row.spendCny > 0 ? row.spendCny / row.usedCredits : undefined,
      avgAliveMs: row.entries > 0 ? aliveMsSum / row.entries : undefined
    }))
    .sort((a, b) => b.spendCny - a.spendCny || b.entries - a.entries)
}

/**
 * 聚合台账报表。
 *
 * 窗口按 `purchasedAt` 过滤（「这段时间买的号表现如何」），不按最后活跃时间——
 * 后者会让一个上月买、这月还在跑的号突然出现在本月采购里，成本被重复计入。
 * 传入全量条目，窗口过滤在函数内做：`totalEntryCount` 要反映全部历史。
 */
export function summarizeKskLedger(input: {
  entries: readonly KskLedgerEntry[]
  days?: number
  sort?: KskLedgerSort
  /** 分组 id → 名字。台账只存 id（分组可改名），出报表时按当前分组表查。 */
  groupNames?: Readonly<Record<string, string>>
  now?: number
}): KskLedgerReport {
  const now = input.now ?? Date.now()
  const days = Math.max(1, Math.floor(input.days ?? KSK_LEDGER_DEFAULT_WINDOW_DAYS))
  // 按「日」回退而不是减毫秒：跨夏令时的地区减 24h 会落到前一天 23:00
  const fromDate = new Date(now)
  fromDate.setHours(0, 0, 0, 0)
  fromDate.setDate(fromDate.getDate() - (days - 1))
  const from = fromDate.getTime()

  const groupNames = input.groupNames ?? {}
  const rows = input.entries
    .filter((entry) => entry.purchasedAt >= from)
    .map((entry) => ({
      ...toKskLedgerRow(entry, now),
      groupName: entry.groupId ? groupNames[entry.groupId] : undefined
    }))
    .sort((a, b) => compareKskLedgerRows(a, b, input.sort ?? KSK_LEDGER_SORT.PURCHASED))

  return {
    generatedAt: now,
    days,
    from,
    rows,
    totals: aggregateKskLedger(rows),
    byGroup: aggregateKskLedgerByGroup(rows, groupNames),
    totalEntryCount: input.entries.length,
    earliestPurchasedAt:
      input.entries.length > 0
        ? Math.min(...input.entries.map((entry) => entry.purchasedAt))
        : undefined
  }
}

/**
 * 把一轮账号库观测并入台账。
 *
 * 纯函数：主进程每次账号刷新后调它，测试直接喂序列验口径。返回新的条目数组
 * （不改原数组），以及本轮是否有变化——没变化就不必落盘。
 *
 * 消耗口径是 **当前额度 − 买入基线**，不是逐轮差分累加：
 * - 上游的 `usage.current` 本身就是单调累计值，直接减基线就是这个号被用掉的量，
 *   比逐轮累加少一层误差，也不怕漏采几轮；
 * - 基线缺失时（老记录、或入库时没拉到 usage）用首次观测值补上，那一轮记 0。
 *
 * 额度按月重置会让 `usage.current` 回落到 0。此时把基线跟着降到新值、并把已经
 * 攒下的 `usedCredits` 留住：重置前烧掉的量是真花出去的，不能因为上游清零就抹掉。
 *
 * 只更新已有条目：陌生账号（手动导入、自动同步进来的号）没有采购记录，
 * 建档只会得到一堆空成本列，见文件头说明。
 */
export function applyLedgerObservation(input: {
  entries: readonly KskLedgerEntry[]
  observations: readonly KskLedgerObservation[]
  at: number
  /** 观测集合是否可信到能据此判下线。读账号库失败那轮传 false，否则会把全部标成删除。 */
  canRetire?: boolean
}): { entries: KskLedgerEntry[]; changed: boolean } {
  const seen = new Map(input.observations.map((item) => [item.accountId, item]))
  let changed = false

  const entries = input.entries.map((entry) => {
    const observation = seen.get(entry.accountId)

    if (!observation) {
      // 已经下线的不重复标；读取失败那轮一律不动
      if (!input.canRetire || entry.retiredAt !== undefined) return entry
      changed = true
      return {
        ...entry,
        retiredAt: input.at,
        retireReason: entry.retireReason ?? KSK_LEDGER_RETIRE_REASON.VANISHED
      }
    }

    const current = observation.currentUsage
    // 入库时没拉到 usage 的老记录，用首次观测值当基线（那一轮消耗记 0）
    let baseline = entry.baselineUsage ?? current
    let carried = entry.carriedCredits ?? 0

    /*
     * 额度按月重置：上游把 usage.current 打回 0（或一个更小的值）。
     * 把本周期已烧的量结转进 carried，再把基线降到新值——这样重置前的
     * 消耗留在账上，重置后的新增也能从 0 正常累加。
     *
     * 判据是「相对上一次观测值回落」，不是「低于基线」：`usage.current` 在
     * 同一周期内单调递增，任何回落都只可能是重置。拿基线当判据会漏掉
     * 「基线本就是 0、重置后又回到 0」这种情形（0 < 0 为假），那一轮
     * inPeriod 归零，本周期已烧的量会凭空消失。
     */
    const previous = entry.currentUsage
    if (current !== undefined && previous !== undefined && current < previous) {
      carried += Math.max(0, previous - (baseline ?? previous))
      baseline = current
    }

    const inPeriod =
      current !== undefined && baseline !== undefined ? Math.max(0, current - baseline) : 0

    const next: KskLedgerEntry = {
      ...entry,
      lastSeenAt: input.at,
      // 号回到账号库（重新导入同一个号）就清掉下线标记
      retiredAt: undefined,
      retireReason: undefined,
      baselineUsage: baseline,
      currentUsage: current ?? entry.currentUsage,
      usageLimit: observation.usageLimit ?? entry.usageLimit,
      carriedCredits: carried,
      usedCredits: carried + inPeriod
    }
    changed = true
    return next
  })

  return { entries, changed }
}

/** 存活时长的人话表达。天/小时/分钟三档，够看不啰嗦。 */
export function formatLedgerDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}
