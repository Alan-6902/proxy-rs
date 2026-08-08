/**
 * 抢号报表的共享契约：主进程记事件、渲染进程出报表，聚合口径只有这一份。
 *
 * 为什么不复用 kskHunter 的 spend / deliveries：
 * - `spend` 只保留 14 天（SPEND_RETENTION_DAYS），`deliveries` 只留最近 200 条，
 *   两者都是「够用就裁」的运行态，撑不起历史报表；
 * - 报表要的是成果口径（放货、下单、交付、验活失败、拦单），不只是金额。
 *
 * 所以另存一份只追加的事件流（见 main/kskHunter/reportStore），永久保留。
 * 事件里刻意不含 KSK 明文，也不含脱敏 key —— 那份文件是明文 JSONL。
 */

import {
  DEFAULT_KSK_HUNTER_CHANNEL_BILLING,
  KSK_HUNTER_CHANNEL,
  hunterLocalDateKey,
  roundCny,
  type KskHunterBudgetBlock,
  type KskHunterChannel,
  type KskHunterChannelBilling
} from './kskHunter'

/** 报表默认展示的天数。事件本身全量保留，这里只决定看多久。 */
export const HUNTER_REPORT_WINDOW_DAYS = 30

/** UI 上可切换的时间跨度。 */
export const HUNTER_REPORT_WINDOW_OPTIONS = [7, 30] as const

/** 一天的毫秒数，日粒度聚合与横轴刻度共用。 */
export const HUNTER_REPORT_DAY_MS = 24 * 60 * 60_000

/**
 * 记进事件流的节点。只记低频且确定的成果节点，不记每轮轮询：
 * 3 秒一轮如果每轮都记，一天就是几万行。
 */
export const HUNTER_REPORT_EVENT = {
  /** 链接由无货变有货的那一刻（放货时刻），不是每轮有货都记。 */
  RESTOCK: 'restock',
  /** 下单成功，钱已花出去。 */
  ORDERED: 'ordered',
  /** 已购但验活不通过，钱花了号不能用。 */
  DEAD_KEY: 'dead_key',
  /** 推送下游成功。 */
  DELIVERED: 'delivered',
  /** 推送重试耗尽，需人工处理。 */
  DELIVERY_FAILED: 'delivery_failed',
  /** 预算或余额拦下了一次自动下单。按「日期 + 渠道 + 原因」去重后才记。 */
  BLOCKED: 'blocked'
} as const

export type HunterReportEventType = (typeof HUNTER_REPORT_EVENT)[keyof typeof HUNTER_REPORT_EVENT]

/** 事件流里的一条记录。字段随类型可选，聚合时按类型取用。 */
export interface HunterReportEvent {
  at: number
  type: HunterReportEventType
  channel: KskHunterChannel
  linkId: string
  linkName: string
  region?: string
  /** restock：这次边沿发现的在售商品数。 */
  offerCount?: number
  /** ordered：该单原币金额；商品无价格时为 undefined。 */
  costUnit?: number
  /** ordered：该单折合人民币元。 */
  costCny?: number
  unitLabel?: string
  /** blocked：被拦下的原因。 */
  reason?: KskHunterBudgetBlock
}

/** 各类事件的计次，总览与分维度行共用同一组字段名。 */
export interface HunterReportCounts {
  restocks: number
  orders: number
  delivered: number
  deliveryFailed: number
  deadKeys: number
  blocks: number
}

export interface HunterReportDay extends HunterReportCounts {
  /** 本地日期键 YYYY-MM-DD。 */
  date: string
  /** 该本地日 00:00 的时间戳，供趋势图当横轴。 */
  at: number
  spendCny: number
}

export interface HunterReportChannelRow extends HunterReportCounts {
  channel: KskHunterChannel
  unitLabel: string
  spendUnit: number
  spendCny: number
  /** 有价格的订单的均价；全是未知价格时为 undefined。 */
  avgCostUnit?: number
  avgCostCny?: number
  lastOrderedAt?: number
}

export interface HunterReportLinkRow extends HunterReportCounts {
  linkId: string
  linkName: string
  channel: KskHunterChannel
  unitLabel: string
  spendUnit: number
  spendCny: number
  lastOrderedAt?: number
}

export interface HunterReportTotals extends HunterReportCounts {
  spendCny: number
  /** 有价格订单的人民币均价；无此类订单时 undefined。 */
  avgCostCny?: number
  /** 放货 → 下单的转化率；窗口内没放过货时 undefined。 */
  orderRate?: number
  /** 下单 → 交付成功率；没下过单时 undefined。 */
  deliverRate?: number
  /** 下单 → 验活失败率；没下过单时 undefined。 */
  deadKeyRate?: number
  /** 窗口内有下单的天数，用于算日均。 */
  activeDays: number
}

export interface HunterReport {
  generatedAt: number
  days: number
  fromDate: string
  toDate: string
  totals: HunterReportTotals
  daily: HunterReportDay[]
  byChannel: HunterReportChannelRow[]
  byLink: HunterReportLinkRow[]
  /** 放货时段分布：24 个桶，索引为本地小时，值为 restock 次数。 */
  restockByHour: number[]
  /** 事件流里最早一条的时间；用来说明历史攒了多久。 */
  earliestEventAt?: number
  /** 事件流总条数（不受窗口限制）。 */
  totalEventCount: number
}

function emptyCounts(): HunterReportCounts {
  return { restocks: 0, orders: 0, delivered: 0, deliveryFailed: 0, deadKeys: 0, blocks: 0 }
}

/** 把一条事件计进一组计次里。 */
function countEvent(counts: HunterReportCounts, type: HunterReportEventType): void {
  switch (type) {
    case HUNTER_REPORT_EVENT.RESTOCK:
      counts.restocks++
      break
    case HUNTER_REPORT_EVENT.ORDERED:
      counts.orders++
      break
    case HUNTER_REPORT_EVENT.DELIVERED:
      counts.delivered++
      break
    case HUNTER_REPORT_EVENT.DELIVERY_FAILED:
      counts.deliveryFailed++
      break
    case HUNTER_REPORT_EVENT.DEAD_KEY:
      counts.deadKeys++
      break
    case HUNTER_REPORT_EVENT.BLOCKED:
      counts.blocks++
      break
  }
}

/**
 * 本地日 00:00 的时间戳。
 *
 * 刻意按本地年月日重新构造 Date，而不是 `at - at % DAY_MS`：后者按 UTC 切，
 * 东八区会把凌晨 0-8 点划到前一天，日粒度曲线整体错位一格。
 */
export function hunterReportDayStart(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 生成窗口内连续的日期序列（含首尾）。缺数据的天也要在，否则曲线会把缺口连成直线。 */
export function hunterReportDateRange(days: number, now: number): { date: string; at: number }[] {
  const span = Math.max(1, Math.floor(days))
  const todayStart = hunterReportDayStart(now)
  const result: { date: string; at: number }[] = []
  for (let offset = span - 1; offset >= 0; offset--) {
    const date = new Date(todayStart)
    // 按「日」加减而不是减毫秒：跨夏令时的地区减 24h 会落到前一天 23:00
    date.setDate(date.getDate() - offset)
    const at = date.getTime()
    result.push({ date: hunterLocalDateKey(at), at })
  }
  return result
}

/**
 * 聚合报表。
 *
 * 传入全量事件（主进程读整个事件流），窗口过滤在函数内做：
 * totalEventCount 与 earliestEventAt 要反映全部历史，不能只看窗口。
 */
export function summarizeHunterReport(input: {
  events: readonly HunterReportEvent[]
  /** 渠道计价单位；事件自带 unitLabel 时优先用事件里的历史值。 */
  billing?: Partial<Record<KskHunterChannel, KskHunterChannelBilling>>
  days?: number
  now?: number
}): HunterReport {
  const now = input.now ?? Date.now()
  const days = Math.max(1, Math.floor(input.days ?? HUNTER_REPORT_WINDOW_DAYS))
  const dateRange = hunterReportDateRange(days, now)
  const fromAt = dateRange[0].at
  const windowed = input.events.filter((event) => event.at >= fromAt)

  const dayByDate = new Map<string, HunterReportDay>()
  for (const entry of dateRange) {
    dayByDate.set(entry.date, { ...emptyCounts(), date: entry.date, at: entry.at, spendCny: 0 })
  }

  const totals: HunterReportTotals = { ...emptyCounts(), spendCny: 0, activeDays: 0 }
  const restockByHour = Array.from({ length: 24 }, () => 0)
  const channelRows = new Map<KskHunterChannel, HunterReportChannelRow>()
  const linkRows = new Map<string, HunterReportLinkRow>()
  /** 均价只算有价格的单，未知价格的不能按 0 拉低均价。 */
  let pricedOrders = 0
  let pricedCostCny = 0
  const pricedByChannel = new Map<KskHunterChannel, { count: number; unit: number; cny: number }>()

  const channelRow = (event: HunterReportEvent): HunterReportChannelRow => {
    let row = channelRows.get(event.channel)
    if (!row) {
      row = {
        ...emptyCounts(),
        channel: event.channel,
        unitLabel:
          input.billing?.[event.channel]?.unitLabel ?? DEFAULT_KSK_HUNTER_CHANNEL_BILLING.unitLabel,
        spendUnit: 0,
        spendCny: 0
      }
      channelRows.set(event.channel, row)
    }
    return row
  }

  const linkRow = (event: HunterReportEvent): HunterReportLinkRow => {
    let row = linkRows.get(event.linkId)
    if (!row) {
      row = {
        ...emptyCounts(),
        linkId: event.linkId,
        linkName: event.linkName,
        channel: event.channel,
        unitLabel: channelRow(event).unitLabel,
        spendUnit: 0,
        spendCny: 0
      }
      linkRows.set(event.linkId, row)
    }
    // 链接改过名时按最新一次事件展示
    row.linkName = event.linkName
    return row
  }

  for (const event of windowed) {
    const day = dayByDate.get(hunterLocalDateKey(event.at))
    const channel = channelRow(event)
    const link = linkRow(event)
    countEvent(totals, event.type)
    countEvent(channel, event.type)
    countEvent(link, event.type)
    if (day) countEvent(day, event.type)

    // 事件自带的单位是下单当时的口径，比现在的配置更接近事实
    if (event.unitLabel) {
      channel.unitLabel = event.unitLabel
      link.unitLabel = event.unitLabel
    }

    if (event.type === HUNTER_REPORT_EVENT.RESTOCK) {
      restockByHour[new Date(event.at).getHours()]++
    }

    if (event.type !== HUNTER_REPORT_EVENT.ORDERED) continue

    const costCny = event.costCny ?? 0
    totals.spendCny = roundCny(totals.spendCny + costCny)
    channel.spendCny = roundCny(channel.spendCny + costCny)
    channel.spendUnit = roundCny(channel.spendUnit + (event.costUnit ?? 0))
    link.spendCny = roundCny(link.spendCny + costCny)
    link.spendUnit = roundCny(link.spendUnit + (event.costUnit ?? 0))
    if (day) day.spendCny = roundCny(day.spendCny + costCny)
    channel.lastOrderedAt = Math.max(channel.lastOrderedAt ?? 0, event.at)
    link.lastOrderedAt = Math.max(link.lastOrderedAt ?? 0, event.at)

    if (event.costUnit !== undefined) {
      pricedOrders++
      pricedCostCny = roundCny(pricedCostCny + costCny)
      const priced = pricedByChannel.get(event.channel) ?? { count: 0, unit: 0, cny: 0 }
      priced.count++
      priced.unit = roundCny(priced.unit + event.costUnit)
      priced.cny = roundCny(priced.cny + costCny)
      pricedByChannel.set(event.channel, priced)
    }
  }

  const daily = dateRange.map((entry) => dayByDate.get(entry.date) as HunterReportDay)
  totals.activeDays = daily.filter((day) => day.orders > 0).length
  totals.avgCostCny = pricedOrders > 0 ? roundCny(pricedCostCny / pricedOrders) : undefined
  totals.orderRate = totals.restocks > 0 ? totals.orders / totals.restocks : undefined
  totals.deliverRate = totals.orders > 0 ? totals.delivered / totals.orders : undefined
  totals.deadKeyRate = totals.orders > 0 ? totals.deadKeys / totals.orders : undefined

  for (const [channel, priced] of pricedByChannel) {
    const row = channelRows.get(channel)
    if (!row || priced.count === 0) continue
    row.avgCostUnit = roundCny(priced.unit / priced.count)
    row.avgCostCny = roundCny(priced.cny / priced.count)
  }

  // 渠道行按枚举顺序输出，UI 上顺序稳定不随事件先后跳动
  const byChannel = (Object.values(KSK_HUNTER_CHANNEL) as KskHunterChannel[])
    .map((channel) => channelRows.get(channel))
    .filter((row): row is HunterReportChannelRow => row !== undefined)

  const byLink = [...linkRows.values()].sort(
    (a, b) => b.orders - a.orders || b.restocks - a.restocks || a.linkName.localeCompare(b.linkName)
  )

  return {
    generatedAt: now,
    days,
    fromDate: dateRange[0].date,
    toDate: dateRange[dateRange.length - 1].date,
    totals,
    daily,
    byChannel,
    byLink,
    restockByHour,
    earliestEventAt:
      input.events.length > 0 ? Math.min(...input.events.map((event) => event.at)) : undefined,
    totalEventCount: input.events.length
  }
}

export const EMPTY_HUNTER_REPORT_TOTALS: HunterReportTotals = {
  ...emptyCounts(),
  spendCny: 0,
  activeDays: 0
}
