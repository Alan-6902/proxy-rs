/**
 * 抢号台账的共享契约：主进程记账、渲染进程出报表，口径只有这一份。
 *
 * 要回答的问题：**这个号花多少钱买的、活了多长时间、替我烧了多少积分**。
 * 现有两份报表都答不了：
 * - 抢号报表（`hunterReport`）只到渠道/链接维度，成本落不到具体号上；
 * - 反代报表（`localAdminStats`）按小时差分，桶只留 7 天，号一删就查无对证。
 *
 * 关联键是 `sha256(ksk 明文)`：Admin 的 `GET /credentials` 只回这个哈希（不回明文），
 * 而抢号下单时本地手里就是明文。两边用同一个算法碰一下就能把「买入成本」与
 * 「反代消耗」焊到同一个号上，台账文件里也就不需要出现任何明文。
 *
 * 只收抢号买来的号：手动推送与自动同步进反代的号没有采购记录，算不出成本与
 * ROI，硬塞进来只会得到一堆空列。所以 `applyLedgerObservation` 只更新已有条目，
 * 不为陌生哈希建档。
 */

import { diffLocalAdminCounter, type LocalAdminCredentialStats } from './localAdminStats'
import type { KskHunterChannel } from './kskHunter'

/** 一小时的毫秒数，存活时长与每小时产出共用。 */
export const KSK_LEDGER_HOUR_MS = 3_600_000

/** 台账状态：按「买到了吗 → 进池了吗 → 还在池里吗」三段判。 */
export const KSK_LEDGER_STATE = {
  /** 还在反代池子里服役。 */
  ALIVE: 'alive',
  /** 曾经在池里，现在没了（被清理、被删、或反代换了一批）。 */
  RETIRED: 'retired',
  /** 买到但发消息验活没过：钱花了，号从没进池。 */
  DEAD_ON_ARRIVAL: 'dead_on_arrival',
  /**
   * 买到了、验活也过了，但反代里一直没观测到。
   *
   * 常见原因是抢号的下游反代与统计监控的本机 Admin 不是同一个实例
   * （`downstreamBaseUrl` 与 Admin 地址各配一处），此时消耗数据天然拿不到。
   */
  NEVER_POOLED: 'never_pooled',
  /** 刚买到，还在等下一轮采样确认进池（见 KSK_LEDGER_POOL_GRACE_MS）。 */
  PENDING: 'pending'
} as const

export type KskLedgerState = (typeof KSK_LEDGER_STATE)[keyof typeof KSK_LEDGER_STATE]

export const KSK_LEDGER_STATE_LABEL: Record<KskLedgerState, string> = {
  [KSK_LEDGER_STATE.ALIVE]: '在池',
  [KSK_LEDGER_STATE.RETIRED]: '已下线',
  [KSK_LEDGER_STATE.DEAD_ON_ARRIVAL]: '买到即废',
  [KSK_LEDGER_STATE.NEVER_POOLED]: '未进池',
  [KSK_LEDGER_STATE.PENDING]: '待确认'
}

/**
 * 买到之后允许多久还没被观测到，仍算「待确认」而不是「未进池」。
 *
 * 取 10 分钟：反代统计每 60 秒采一轮，正常情况下一分钟内就能看到新号；
 * 但推送本身有指数退避重试（最长约 160 秒一轮、共 6 次），加上采样错峰，
 * 给到 10 分钟才不会把还在重试队列里的号早早标成「白买了」。
 */
export const KSK_LEDGER_POOL_GRACE_MS = 10 * 60_000

/** 号退出池子的原因，用来区分「烧干了」和「白买了」。 */
export const KSK_LEDGER_RETIRE_REASON = {
  /** 额度耗尽被自动/手动清理。这是号的正常寿终。 */
  EXHAUSTED: 'exhausted',
  /** 发消息验活判永久失效（封号、认证失败）。 */
  INVALID: 'invalid',
  /**
   * 在 Admin 里消失了但没人报告过原因。
   *
   * 用户手动删了凭据、或换了一个空的 Admin 实例都会走到这里。
   */
  VANISHED: 'vanished'
} as const

export type KskLedgerRetireReason =
  (typeof KSK_LEDGER_RETIRE_REASON)[keyof typeof KSK_LEDGER_RETIRE_REASON]

export const KSK_LEDGER_RETIRE_REASON_LABEL: Record<KskLedgerRetireReason, string> = {
  [KSK_LEDGER_RETIRE_REASON.EXHAUSTED]: '额度耗尽',
  [KSK_LEDGER_RETIRE_REASON.INVALID]: '验活判死',
  [KSK_LEDGER_RETIRE_REASON.VANISHED]: '已从反代消失'
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
 * 刻意不含 ksk 明文，只留 `keyHash` 与 `maskedKey`——这份文件是明文 JSON，
 * 存了明文就等于把已购的号裸奔在磁盘上。
 */
export interface KskLedgerEntry {
  /** sha256(ksk 明文)。与 Admin 的 apiKeyHash 同算法，是这条记录的主键。 */
  keyHash: string
  /** 展示用脱敏 key（`ksk_...abcd`），下单时本地算好存下来。 */
  maskedKey: string
  region: string

  /* ---- 采购 ---- */
  channel: KskHunterChannel
  linkId: string
  linkName: string
  /** 下单成功的时刻，也是存活时长的起点。 */
  purchasedAt: number
  /** 该单原币金额；商品未给价格时为 undefined。 */
  costUnit?: number
  /** 该单折合人民币元。 */
  costCny?: number
  unitLabel?: string

  /* ---- 生命周期 ---- */
  /** 首次在反代 Admin 里观测到的时刻；没进池时为 undefined。 */
  firstSeenAt?: number
  /** 最后一次在 Admin 里观测到的时刻。 */
  lastSeenAt?: number
  /** 从 Admin 消失（或被判死）的时刻；仍在池里时为 undefined。 */
  retiredAt?: number
  retireReason?: KskLedgerRetireReason
  /** 观测到的最后一个 Admin 凭据 id，便于和反代报表对照。 */
  credentialId?: string

  /* ---- 产出（累计差分，只统计走本机反代的量） ---- */
  /** 经本机反代消耗的 Kiro 积分累计（估算）。 */
  usedCredits: number
  inputTokens: number
  outputTokens: number
  successCount: number
  failureCount: number

  /* ---- 差分基线：上一次观测到的累计值 ---- */
  cursor?: KskLedgerCursor
}

/**
 * 上一次观测到的累计值。
 *
 * 与 `LocalAdminCumulativeCursor` 的差别：那份按 Admin 的凭据 id 存，id 会被复用
 * （删掉 #1 再建一条还是 #1），所以它得额外拿 maskedKey 判换号。这里按 keyHash 存，
 * 哈希天然唯一，不存在换号问题；代价是它只覆盖抢号买来的号。
 */
export interface KskLedgerCursor {
  usedCredits?: number
  inputTokens?: number
  outputTokens?: number
  successCount?: number
  failureCount?: number
  at: number
}

/** 一轮观测里的单条凭据，取自反代统计的凭据视图。 */
export interface KskLedgerObservation {
  /** Admin 回的 apiKeyHash。缺失（oauth 凭据）的条目由调用方过滤。 */
  keyHash: string
  credentialId?: string
  usedCredits?: number
  inputTokens?: number
  outputTokens?: number
  successCount: number
  failureCount: number
}

/** 报表里的一行：台账记录 + 算出来的派生量。 */
export interface KskLedgerRow extends Omit<KskLedgerEntry, 'cursor'> {
  state: KskLedgerState
  /** 存活毫秒数：进池到下线（仍在池时算到 now）。没进池的为 0。 */
  aliveMs: number
  /** 每积分成本（人民币元）；没花钱或没产出时为 undefined。 */
  cnyPerCredit?: number
  /** 每小时产出的积分；存活不足一分钟或没产出时为 undefined。 */
  creditsPerHour?: number
}

export interface KskLedgerTotals {
  entries: number
  alive: number
  retired: number
  /** 买到即废 + 未进池：花了钱但拿不到产出的号。 */
  wasted: number
  spendCny: number
  /** 有价格记录的订单数，均价的分母。 */
  pricedOrders: number
  usedCredits: number
  inputTokens: number
  outputTokens: number
  successCount: number
  failureCount: number
  /** 已下线号的平均存活时长（毫秒）；没有下线记录时为 undefined。 */
  avgAliveMs?: number
  /** 整体每积分成本（人民币元）；没产出时为 undefined。 */
  cnyPerCredit?: number
  /** 单号平均花费（人民币元）；没有带价订单时为 undefined。 */
  avgCostCny?: number
}

export interface KskLedgerReport {
  generatedAt: number
  days: number
  /** 窗口起点（按 purchasedAt 过滤，闭区间起点）。 */
  from: number
  rows: KskLedgerRow[]
  totals: KskLedgerTotals
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
  usedCredits: 0,
  inputTokens: 0,
  outputTokens: 0,
  successCount: 0,
  failureCount: 0
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
 * 顺序有讲究：先看有没有下线时刻（终态最确定），再看有没有进过池，
 * 最后才用「买了多久还没见到」来区分待确认与未进池。
 */
export function resolveLedgerState(entry: KskLedgerEntry, now: number): KskLedgerState {
  if (entry.retiredAt !== undefined) {
    return entry.retireReason === KSK_LEDGER_RETIRE_REASON.INVALID &&
      entry.firstSeenAt === undefined
      ? KSK_LEDGER_STATE.DEAD_ON_ARRIVAL
      : KSK_LEDGER_STATE.RETIRED
  }
  if (entry.firstSeenAt !== undefined) return KSK_LEDGER_STATE.ALIVE
  return now - entry.purchasedAt <= KSK_LEDGER_POOL_GRACE_MS
    ? KSK_LEDGER_STATE.PENDING
    : KSK_LEDGER_STATE.NEVER_POOLED
}

/**
 * 存活时长：进池到下线，仍在池时算到 now。
 *
 * 起点用 `firstSeenAt` 而不是 `purchasedAt`：用户要的是「这个号在池里干了多久活」，
 * 买来放着没推进去的那段时间不该算进服役时长。没进池的一律 0。
 */
export function resolveLedgerAliveMs(entry: KskLedgerEntry, now: number): number {
  if (entry.firstSeenAt === undefined) return 0
  const end = entry.retiredAt ?? Math.max(entry.lastSeenAt ?? now, now)
  return Math.max(0, end - entry.firstSeenAt)
}

/** 台账条目转报表行，补上派生量。 */
export function toKskLedgerRow(entry: KskLedgerEntry, now: number): KskLedgerRow {
  // cursor 是差分内部状态，不该出现在报表里；显式剔掉而不是解构丢弃
  const rest: Omit<KskLedgerEntry, 'cursor'> & { cursor?: never } = { ...entry, cursor: undefined }
  delete rest.cursor
  const aliveMs = resolveLedgerAliveMs(entry, now)
  const aliveHours = aliveMs / KSK_LEDGER_HOUR_MS
  return {
    ...rest,
    state: resolveLedgerState(entry, now),
    aliveMs,
    // 分母是产出，产出为 0 时「每积分成本」是无穷大，报 undefined 让 UI 显示「—」
    cnyPerCredit:
      entry.costCny !== undefined && entry.costCny > 0 && entry.usedCredits > 0
        ? entry.costCny / entry.usedCredits
        : undefined,
    // 存活不足一分钟时样本太少，算出来的时均没有意义
    creditsPerHour:
      aliveMs >= 60_000 && entry.usedCredits > 0 ? entry.usedCredits / aliveHours : undefined
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
  let retiredAliveMs = 0
  for (const row of rows) {
    totals.entries++
    if (row.state === KSK_LEDGER_STATE.ALIVE) totals.alive++
    if (row.state === KSK_LEDGER_STATE.RETIRED) {
      totals.retired++
      retiredAliveMs += row.aliveMs
    }
    if (
      row.state === KSK_LEDGER_STATE.DEAD_ON_ARRIVAL ||
      row.state === KSK_LEDGER_STATE.NEVER_POOLED
    ) {
      totals.wasted++
    }
    totals.spendCny += row.costCny ?? 0
    if (row.costUnit !== undefined) totals.pricedOrders++
    totals.usedCredits += row.usedCredits
    totals.inputTokens += row.inputTokens
    totals.outputTokens += row.outputTokens
    totals.successCount += row.successCount
    totals.failureCount += row.failureCount
  }
  totals.spendCny = Math.round(totals.spendCny * 100) / 100
  totals.avgAliveMs = totals.retired > 0 ? retiredAliveMs / totals.retired : undefined
  totals.cnyPerCredit =
    totals.usedCredits > 0 && totals.spendCny > 0 ? totals.spendCny / totals.usedCredits : undefined
  totals.avgCostCny =
    totals.pricedOrders > 0
      ? Math.round((totals.spendCny / totals.pricedOrders) * 100) / 100
      : undefined
  return totals
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
  now?: number
}): KskLedgerReport {
  const now = input.now ?? Date.now()
  const days = Math.max(1, Math.floor(input.days ?? KSK_LEDGER_DEFAULT_WINDOW_DAYS))
  // 按「日」回退而不是减毫秒：跨夏令时的地区减 24h 会落到前一天 23:00
  const fromDate = new Date(now)
  fromDate.setHours(0, 0, 0, 0)
  fromDate.setDate(fromDate.getDate() - (days - 1))
  const from = fromDate.getTime()

  const rows = input.entries
    .filter((entry) => entry.purchasedAt >= from)
    .map((entry) => toKskLedgerRow(entry, now))
    .sort((a, b) => compareKskLedgerRows(a, b, input.sort ?? KSK_LEDGER_SORT.PURCHASED))

  return {
    generatedAt: now,
    days,
    from,
    rows,
    totals: aggregateKskLedger(rows),
    totalEntryCount: input.entries.length,
    earliestPurchasedAt:
      input.entries.length > 0
        ? Math.min(...input.entries.map((entry) => entry.purchasedAt))
        : undefined
  }
}

/**
 * 把一轮反代观测并入台账。
 *
 * 纯函数：主进程每轮采样调它，测试直接喂序列验差分口径。返回新的条目数组
 * （不改原数组），以及本轮真正有变化的哈希集合——没变化就不必落盘。
 *
 * 三件事：
 * 1. 首次见到一条记录时只写基线（增量 0），否则会把它入池前的历史累计算成产出；
 * 2. 累计值回落记 0（kiro-rs 重启后计数从 0 起），交给 `diffLocalAdminCounter`；
 * 3. 本轮没观测到、但之前在池里的记录标下线。
 *
 * 只更新已有条目：陌生哈希（手动推送、自动同步进反代的号）没有采购记录，
 * 建档只会得到一堆空成本列，见文件头说明。
 */
export function applyLedgerObservation(input: {
  entries: readonly KskLedgerEntry[]
  observations: readonly KskLedgerObservation[]
  at: number
  /** 观测集合是否可信到能据此判下线。抓取失败那轮传 false，否则会把全池标成消失。 */
  canRetire?: boolean
}): { entries: KskLedgerEntry[]; changed: boolean } {
  const seen = new Map(input.observations.map((item) => [item.keyHash, item]))
  let changed = false

  const entries = input.entries.map((entry) => {
    const observation = seen.get(entry.keyHash)

    if (!observation) {
      /*
       * 没观测到就下线，但只对「进过池且还没下线」的记录动手。
       * 未进池的记录留在原状：它的状态由 resolveLedgerState 按宽限期算，
       * 在这里给它盖个 retiredAt 会把「还在重试推送」误报成「已下线」。
       */
      if (!input.canRetire) return entry
      if (entry.firstSeenAt === undefined || entry.retiredAt !== undefined) return entry
      changed = true
      return {
        ...entry,
        retiredAt: input.at,
        retireReason: entry.retireReason ?? KSK_LEDGER_RETIRE_REASON.VANISHED
      }
    }

    const cursor = entry.cursor
    const next: KskLedgerEntry = {
      ...entry,
      credentialId: observation.credentialId ?? entry.credentialId,
      firstSeenAt: entry.firstSeenAt ?? input.at,
      lastSeenAt: input.at,
      // 号回到池里（重新推送、或用户又建了同一条凭据）就清掉下线标记
      retiredAt: undefined,
      retireReason: undefined,
      successCount:
        entry.successCount + diffLocalAdminCounter(cursor?.successCount, observation.successCount),
      failureCount:
        entry.failureCount + diffLocalAdminCounter(cursor?.failureCount, observation.failureCount),
      cursor: {
        // 这一轮没拿到某个字段时保留旧基线，否则下一轮会把整段累计当成新增
        usedCredits: observation.usedCredits ?? cursor?.usedCredits,
        inputTokens: observation.inputTokens ?? cursor?.inputTokens,
        outputTokens: observation.outputTokens ?? cursor?.outputTokens,
        successCount: observation.successCount,
        failureCount: observation.failureCount,
        at: input.at
      }
    }
    if (observation.usedCredits !== undefined) {
      next.usedCredits += diffLocalAdminCounter(cursor?.usedCredits, observation.usedCredits)
    }
    if (observation.inputTokens !== undefined) {
      next.inputTokens += diffLocalAdminCounter(cursor?.inputTokens, observation.inputTokens)
    }
    if (observation.outputTokens !== undefined) {
      next.outputTokens += diffLocalAdminCounter(cursor?.outputTokens, observation.outputTokens)
    }
    changed = true
    return next
  })

  return { entries, changed }
}

/**
 * 把反代统计的凭据视图转成台账观测。
 *
 * 没有 apiKeyHash 的条目（oauth 凭据）一律丢掉：台账只认 ksk，而且没有哈希
 * 就无从与采购记录关联。
 */
export function toLedgerObservations(
  credentials: readonly LocalAdminCredentialStats[]
): KskLedgerObservation[] {
  return credentials
    .filter((credential) => Boolean(credential.apiKeyHash))
    .map((credential) => ({
      keyHash: credential.apiKeyHash as string,
      credentialId: credential.id,
      usedCredits: credential.usedCredits,
      inputTokens: credential.inputTokens,
      outputTokens: credential.outputTokens,
      successCount: credential.successCount,
      failureCount: credential.failureCount
    }))
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
