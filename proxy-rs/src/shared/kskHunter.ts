/**
 * KSK 抢号（Hunter）共享契约：主进程与渲染进程共用，避免两侧字段走偏。
 *
 * 与 kskAutomation 的分工：kskAutomation 是「已有货源按固定间隔拉」，
 * Hunter 是「盯着商品聚合器等开货，抢到再下单」，轮询间隔和失败语义都不同，故独立成模块。
 */

import { isValidKiroApiKey, isValidKiroRegion } from './kiroApiKey'

/** 抢号轮询间隔：所有启用链接并行发一轮。 */
export const KSK_HUNTER_POLL_INTERVAL_SECONDS = 3

/** 单次请求超时。比轮询间隔长，因此同一链接必须防重入。 */
export const KSK_HUNTER_REQUEST_TIMEOUT_SECONDS = 10

/** store 结构版本。v2 起新增每渠道计费配置与每日花费账本。 */
export const KSK_HUNTER_STORE_VERSION = 2

/** 下游默认地址；用户在 UI 里可改。 */
export const DEFAULT_KSK_HUNTER_DOWNSTREAM_URL = 'http://127.0.0.1:12889'

/** 下游本地化接口路径约定。 */
export const KSK_HUNTER_DOWNSTREAM_PATH = {
  /** GET → { need: boolean } */
  needAccount: '/need-account',
  /** POST { key, region } → { ok: boolean } */
  pushKsk: '/ksk'
} as const

/** 下游鉴权头：与本机 Admin 保持同一风格。 */
export const KSK_HUNTER_DOWNSTREAM_AUTH_HEADER = 'x-api-key'

/** 推送失败的重试上限与退避基数（指数退避：5s/10s/20s/40s/80s/160s）。 */
export const KSK_HUNTER_DELIVERY_MAX_ATTEMPTS = 6
export const KSK_HUNTER_DELIVERY_BASE_DELAY_MS = 5_000

/** 每条链接的处置方式。 */
export const KSK_HUNTER_MODE = {
  /** 只弹系统通知提醒人工购买。 */
  NOTIFY: 'notify',
  /** 问下游要不要号 → 下单 → 验活 → 推送下游。 */
  AUTO_ORDER: 'auto_order'
} as const

export type KskHunterMode = (typeof KSK_HUNTER_MODE)[keyof typeof KSK_HUNTER_MODE]

/** 商品聚合站点。每个站点响应形状不同，由主进程各自的适配器解析。 */
export const KSK_HUNTER_CHANNEL = {
  KIRO_MARKET: 'kiro_market',
  KIRO_CEO: 'kiro_ceo',
  KIRO_DROP: 'kiro_drop'
} as const

export type KskHunterChannel = (typeof KSK_HUNTER_CHANNEL)[keyof typeof KSK_HUNTER_CHANNEL]

export const KSK_HUNTER_CHANNEL_LABEL: Record<KskHunterChannel, string> = {
  [KSK_HUNTER_CHANNEL.KIRO_MARKET]: 'Kiro Market',
  [KSK_HUNTER_CHANNEL.KIRO_CEO]: 'Kiro CEO',
  [KSK_HUNTER_CHANNEL.KIRO_DROP]: 'Kiro Drop'
}

/**
 * 每个渠道的计价单位与换算系数。
 *
 * 站点计价单位各不相同（人民币、积分、CRD 点数），统计要汇总成人民币，
 * 所以每个渠道配一个「1 单位 = 多少人民币」的系数。人民币计价的渠道系数填 1。
 *
 * 上限按**原币**填（如「每天最多 500 积分」），不按人民币填：用户脑子里的预算
 * 就是原币，按人民币填得自己先乘一遍汇率，改汇率还要回来重算上限。
 * 人民币汇总只用于跨渠道对比展示。
 */
export interface KskHunterChannelBilling {
  /** 计价单位显示名，如 'CNY' / '积分' / 'CRD'。 */
  unitLabel: string
  /** 1 个计价单位折合多少人民币元。人民币计价的渠道填 1。 */
  cnyPerUnit: number
  /** 该渠道每日花费上限，单位是该渠道的原币；0 表示不限。 */
  dailyLimitUnit: number
  /** 余额低于该值时提醒充值；0 表示不提醒。单位为原币。 */
  lowBalanceThresholdUnit: number
}

/** 计价系数上限：防止误输入把上限判断彻底失效。 */
export const KSK_HUNTER_MAX_CNY_PER_UNIT = 10_000

/** 单渠道默认计费配置：按人民币 1:1，不设上限与余额提醒。 */
export const DEFAULT_KSK_HUNTER_CHANNEL_BILLING: KskHunterChannelBilling = {
  unitLabel: 'CNY',
  cnyPerUnit: 1,
  dailyLimitUnit: 0,
  lowBalanceThresholdUnit: 0
}

/** 各渠道计费配置的默认值。汇率与上限待用户按实际情况填。 */
export const DEFAULT_KSK_HUNTER_BILLING: Record<KskHunterChannel, KskHunterChannelBilling> = {
  [KSK_HUNTER_CHANNEL.KIRO_MARKET]: {
    unitLabel: 'CNY',
    cnyPerUnit: 1,
    dailyLimitUnit: 0,
    lowBalanceThresholdUnit: 0
  },
  [KSK_HUNTER_CHANNEL.KIRO_CEO]: {
    unitLabel: 'CRD',
    cnyPerUnit: 1,
    dailyLimitUnit: 0,
    lowBalanceThresholdUnit: 0
  },
  [KSK_HUNTER_CHANNEL.KIRO_DROP]: {
    unitLabel: 'CNY',
    cnyPerUnit: 1,
    dailyLimitUnit: 0,
    lowBalanceThresholdUnit: 0
  }
}

/** 花费被拦下的原因，用于 UI 提示与状态展示。 */
export const KSK_HUNTER_BUDGET_BLOCK = {
  NONE: 'none',
  /** 全局每日上限已用尽。 */
  GLOBAL: 'global',
  /** 该渠道每日上限已用尽。 */
  CHANNEL: 'channel',
  /** 余额不足以支付这一单。 */
  BALANCE: 'balance',
  /** 商品没有价格，且用户要求未知价格不下单。 */
  UNKNOWN_PRICE: 'unknown_price'
} as const

export type KskHunterBudgetBlock =
  (typeof KSK_HUNTER_BUDGET_BLOCK)[keyof typeof KSK_HUNTER_BUDGET_BLOCK]

export const KSK_HUNTER_STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  HEALTHY: 'healthy',
  DEGRADED: 'degraded'
} as const

export type KskHunterState = (typeof KSK_HUNTER_STATE)[keyof typeof KSK_HUNTER_STATE]

/** 推送任务的生命周期。 */
export const KSK_HUNTER_DELIVERY_STATE = {
  /** 等待推送或等待下一次重试。 */
  PENDING: 'pending',
  /** 下游已确认接收。 */
  DELIVERED: 'delivered',
  /** 重试次数耗尽，需要人工处理。 */
  FAILED: 'failed',
  /** 号已买到但验活不通过，不推给下游。 */
  DEAD_KEY: 'dead_key'
} as const

export type KskHunterDeliveryState =
  (typeof KSK_HUNTER_DELIVERY_STATE)[keyof typeof KSK_HUNTER_DELIVERY_STATE]

/** 一条被监控的商品链接。 */
export interface KskHunterLink {
  id: string
  /** 展示名，例如「Kiro Drop · eu-central-1」。 */
  name: string
  channel: KskHunterChannel
  enabled: boolean
  mode: KskHunterMode
  /** 只抢这些区域；空数组表示不限区域。 */
  regions: string[]
  createdAt: number
  updatedAt: number
}

/** 链接的密钥（列表 URL 与下单 URL 都可能带 token，整体按密钥处理）。 */
export interface KskHunterLinkSecrets {
  /** 商品列表接口完整地址。 */
  listUrl: string
  /** 下单接口完整地址；模式为 notify 时可留空。 */
  orderUrl: string
}

/** 渲染进程可见的链接视图：不含密钥明文。 */
export interface KskHunterLinkView extends KskHunterLink {
  hasListUrl: boolean
  listUrlHint?: string
  hasOrderUrl: boolean
  orderUrlHint?: string
  /** 上轮该链接是否发现有货。 */
  lastInStock: boolean
  lastCheckedAt?: number
  lastError?: string
}

/** 链接的可写字段；密钥字段省略表示保留，空串表示清除。 */
export interface KskHunterLinkInput {
  name: string
  channel: KskHunterChannel
  enabled?: boolean
  mode: KskHunterMode
  regions?: string[]
  listUrl?: string
  orderUrl?: string
}

export interface KskHunterConfig {
  /** 抢到号后自动写入的账号分组；空表示未分组。 */
  targetGroupId?: string
  requestTimeoutSeconds: number
  /** 模式 auto_order 是否也弹通知。 */
  notifyOnAutoOrder: boolean
  downstreamEnabled: boolean
  downstreamBaseUrl: string
  /**
   * 全局每日花费上限，单位人民币元；0 表示不限。
   * 跨渠道汇总只能用统一货币，所以这一层必须是人民币；
   * 单渠道上限按各自原币填（见 KskHunterChannelBilling.dailyLimitUnit）。
   */
  dailyLimitCny: number
  /** 每个渠道的计价单位、换算系数、原币上限与余额提醒阈值。 */
  billing: Record<KskHunterChannel, KskHunterChannelBilling>
  /** 商品没有价格时是否仍然下单。关掉更安全：算不出花费就不花钱。 */
  allowUnknownPriceOrder: boolean
  /** 是否启用余额查询。关掉则不查余额、不按余额拦单。 */
  balanceCheckEnabled: boolean
}

export interface KskHunterSecretInput {
  downstreamApiKey?: string
  /**
   * 每渠道的余额查询地址（含 token，按密钥处理）。
   * 键为渠道，值省略表示保留、空串表示清除。
   * 余额是渠道级而非链接级：同一渠道的多条链接共用一个账户。
   */
  balanceUrls?: Partial<Record<KskHunterChannel, string>>
}

export interface KskHunterConfigView extends KskHunterConfig {
  pollIntervalSeconds: number
  encryptionAvailable: boolean
  hasDownstreamApiKey: boolean
  downstreamApiKeyTail?: string
  /** 各渠道是否已配置余额地址，以及脱敏后的展示形式。 */
  balanceUrlHints: Record<KskHunterChannel, string | undefined>
}

/** 某个渠道的余额快照。查询失败时 error 有值、amountUnit 为 undefined。 */
export interface KskHunterChannelBalance {
  channel: KskHunterChannel
  /** 余额（原币）。未配置地址或查询失败时为 undefined。 */
  amountUnit?: number
  unitLabel: string
  /** 折合人民币元，便于跨渠道对比。 */
  amountCny?: number
  /** 低于该阈值就提醒充值；0 表示不提醒。 */
  lowThresholdUnit: number
  /** 是否已低于阈值。 */
  isLow: boolean
  checkedAt?: number
  error?: string
}

/** 某个渠道当日的花费汇总。 */
export interface KskHunterChannelSpend {
  channel: KskHunterChannel
  /** 原币金额（该渠道计价单位）。 */
  amountUnit: number
  unitLabel: string
  /** 折合人民币元。 */
  amountCny: number
  orderCount: number
  /** 该渠道的每日上限，单位为原币；0 表示不限。 */
  dailyLimitUnit: number
  /** 该渠道剩余额度（原币）；不限时为 undefined。 */
  remainingUnit?: number
}

/** 当日花费统计。日切以本地自然日 00:00 为界。 */
export interface KskHunterSpendSummary {
  /** 统计所属的本地日期，格式 YYYY-MM-DD。 */
  date: string
  totalCny: number
  orderCount: number
  /** 全局每日上限；0 表示不限。 */
  dailyLimitCny: number
  /** 全局上限的剩余额度；不限时为 undefined。 */
  remainingCny?: number
  byChannel: KskHunterChannelSpend[]
}

export interface KskHunterStatus {
  state: KskHunterState
  running: boolean
  nextRunAt?: number
  lastRoundAt?: number
  lastError?: string
  consecutiveFailures: number
  /** 累计发现有货次数。 */
  totalInStockHits: number
  /** 累计下单成功数。 */
  totalOrdered: number
  /** 累计推送下游成功数。 */
  totalDelivered: number
  /** 当前待推送（含等待重试）条数。 */
  pendingDeliveries: number
  /** 重试耗尽或验活失败、需要人工处理的条数。 */
  failedDeliveries: number
  /** 当日花费是否已把自动下单熔断，以及原因。 */
  budgetBlock: KskHunterBudgetBlock
  /** 被熔断的渠道；budgetBlock 为 channel 时有值。 */
  budgetBlockedChannels: KskHunterChannel[]
}

/** 一次抢号结果的落库记录；key 只以脱敏形式暴露给渲染进程。 */
export interface KskHunterDeliveryView {
  id: string
  linkId: string
  linkName: string
  maskedKey: string
  region: string
  state: KskHunterDeliveryState
  attempts: number
  createdAt: number
  updatedAt: number
  nextAttemptAt?: number
  lastError?: string
  /** 该单花费的原币金额；商品无价格时为 undefined。 */
  costUnit?: number
  /** 该单折合人民币元。 */
  costCny?: number
  unitLabel?: string
}

export interface KskHunterSnapshot {
  config: KskHunterConfigView
  links: KskHunterLinkView[]
  status: KskHunterStatus
  deliveries: KskHunterDeliveryView[]
  spend: KskHunterSpendSummary
  balances: KskHunterChannelBalance[]
}

export interface KskHunterStatusEvent {
  status: KskHunterStatus
  links: KskHunterLinkView[]
  deliveries: KskHunterDeliveryView[]
  spend: KskHunterSpendSummary
  balances: KskHunterChannelBalance[]
}

/** 抢到的一个 KSK。 */
export interface HunterKskCredential {
  key: string
  region: string
}

/** 商品列表里的一个条目，由各站点适配器归一化后产出。 */
export interface KskHunterOffer {
  /** 站点内的商品标识，下单时回传。 */
  goodsId: string
  title: string
  /** 已归一化的 AWS 区域；无法识别时为空串。 */
  region: string
  /** 库存数；站点只给「有/无」时用 0/1 表示。 */
  stock: number
  price?: number
}

export const DEFAULT_KSK_HUNTER_CONFIG: KskHunterConfig = {
  targetGroupId: undefined,
  requestTimeoutSeconds: KSK_HUNTER_REQUEST_TIMEOUT_SECONDS,
  notifyOnAutoOrder: true,
  downstreamEnabled: false,
  downstreamBaseUrl: DEFAULT_KSK_HUNTER_DOWNSTREAM_URL,
  dailyLimitCny: 0,
  billing: DEFAULT_KSK_HUNTER_BILLING,
  allowUnknownPriceOrder: false,
  balanceCheckEnabled: false
}

/** 抢到的号是否落在该链接的区域白名单内。空白名单表示不限。 */
export function matchesHunterRegions(regions: readonly string[], region: string): boolean {
  if (regions.length === 0) return true
  return regions.includes(region)
}

/** 校验一个抢号结果是否可用；不可用的不写库也不推下游。 */
export function isUsableHunterCredential(credential: HunterKskCredential): boolean {
  return isValidKiroApiKey(credential.key) && isValidKiroRegion(credential.region)
}

/** 第 attempt 次（1 基）失败后到下次重试的延迟。 */
export function hunterRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1)
  return KSK_HUNTER_DELIVERY_BASE_DELAY_MS * 2 ** exponent
}

/** URL 脱敏展示：保留 origin + path，token 只留尾部。 */
export function hunterUrlHint(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    const parsed = new URL(trimmed)
    const token = parsed.searchParams.get('token') || parsed.searchParams.get('key') || ''
    const tokenHint = token ? ` · token ••••${token.slice(-4)}` : ''
    return `${parsed.origin}${parsed.pathname}${tokenHint}`
  } catch {
    return '已配置（地址格式待校验）'
  }
}

/** 展示用脱敏：与 maskKiroApiKey 保持一致的形状，但此处只需尾部。 */
export function maskHunterSecretTail(value: string, visible = 4): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return `••••${trimmed.slice(-visible)}`
}

/**
 * 本地自然日的日期键，格式 YYYY-MM-DD。
 *
 * 刻意不用 toISOString()——那个按 UTC 算，东八区凌晨 0-8 点会被归到前一天，
 * 导致「每日上限」在半夜提前重置。这里按本地时区取年月日。
 */
export function hunterLocalDateKey(at: number = Date.now()): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 金额按分四舍五入，避免浮点累加漂移出 0.0000001 这种尾巴。 */
export function roundCny(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 把原币金额折成人民币。
 *
 * 系数非正或非有限一律按 0 处理：宁可把花费记成 0（配合
 * allowUnknownPriceOrder=false 会直接拦下单），也不能把上限判断算错后狂买。
 */
export function hunterUnitToCny(amountUnit: number, cnyPerUnit: number): number {
  if (!Number.isFinite(amountUnit) || amountUnit < 0) return 0
  if (!Number.isFinite(cnyPerUnit) || cnyPerUnit <= 0) return 0
  return roundCny(amountUnit * cnyPerUnit)
}

/** 单条花费记录：主进程账本与统计汇总共用的最小形状。 */
export interface KskHunterSpendEntry {
  channel: KskHunterChannel
  amountUnit: number
  amountCny: number
  at: number
}

/**
 * 汇总某一天的花费。
 *
 * 只统计 date 当天的记录；跨天的旧记录由调用方按 date 过滤后传入或在此被忽略。
 */
export function summarizeHunterSpend(
  entries: readonly KskHunterSpendEntry[],
  config: Pick<KskHunterConfig, 'dailyLimitCny' | 'billing'>,
  date: string = hunterLocalDateKey()
): KskHunterSpendSummary {
  const today = entries.filter((entry) => hunterLocalDateKey(entry.at) === date)
  const byChannel = (Object.values(KSK_HUNTER_CHANNEL) as KskHunterChannel[]).map((channel) => {
    const billing = config.billing[channel] ?? DEFAULT_KSK_HUNTER_CHANNEL_BILLING
    const channelEntries = today.filter((entry) => entry.channel === channel)
    const amountUnit = roundCny(channelEntries.reduce((sum, entry) => sum + entry.amountUnit, 0))
    return {
      channel,
      amountUnit,
      unitLabel: billing.unitLabel,
      amountCny: roundCny(channelEntries.reduce((sum, entry) => sum + entry.amountCny, 0)),
      orderCount: channelEntries.length,
      dailyLimitUnit: billing.dailyLimitUnit,
      remainingUnit:
        billing.dailyLimitUnit > 0
          ? roundCny(Math.max(0, billing.dailyLimitUnit - amountUnit))
          : undefined
    }
  })
  const totalCny = roundCny(today.reduce((sum, entry) => sum + entry.amountCny, 0))
  return {
    date,
    totalCny,
    orderCount: today.length,
    dailyLimitCny: config.dailyLimitCny,
    remainingCny:
      config.dailyLimitCny > 0 ? roundCny(Math.max(0, config.dailyLimitCny - totalCny)) : undefined,
    byChannel
  }
}

/**
 * 判断这一单能不能买。
 *
 * 三层检查，哪层先到哪层先拦：全局人民币上限 → 渠道原币上限 → 余额是否够付。
 * 上限判断用「已花 + 这单」而不是「已花是否超上限」——后者会允许最后一单
 * 大幅冲破预算（上限 100、已花 99 时还能买一个 500 的）。
 */
export function evaluateHunterBudget(input: {
  channel: KskHunterChannel
  /** 这一单的原币价格；商品没给价格时传 undefined。 */
  priceUnit?: number
  config: Pick<KskHunterConfig, 'dailyLimitCny' | 'billing' | 'allowUnknownPriceOrder'>
  spend: KskHunterSpendSummary
  /** 该渠道当前余额（原币）；未启用余额检查或查不到时传 undefined。 */
  balanceUnit?: number
}): { allowed: boolean; reason: KskHunterBudgetBlock; costCny: number; costUnit?: number } {
  const billing = input.config.billing[input.channel] ?? DEFAULT_KSK_HUNTER_CHANNEL_BILLING

  if (input.priceUnit === undefined || !Number.isFinite(input.priceUnit)) {
    return input.config.allowUnknownPriceOrder
      ? { allowed: true, reason: KSK_HUNTER_BUDGET_BLOCK.NONE, costCny: 0, costUnit: undefined }
      : {
          allowed: false,
          reason: KSK_HUNTER_BUDGET_BLOCK.UNKNOWN_PRICE,
          costCny: 0,
          costUnit: undefined
        }
  }

  const costUnit = input.priceUnit
  const costCny = hunterUnitToCny(costUnit, billing.cnyPerUnit)
  const blocked = (
    reason: KskHunterBudgetBlock
  ): { allowed: false; reason: KskHunterBudgetBlock; costCny: number; costUnit: number } => ({
    allowed: false,
    reason,
    costCny,
    costUnit
  })

  const globalLimit = input.config.dailyLimitCny
  if (globalLimit > 0 && roundCny(input.spend.totalCny + costCny) > globalLimit) {
    return blocked(KSK_HUNTER_BUDGET_BLOCK.GLOBAL)
  }

  // 渠道上限按原币比，不换算成人民币：用户填的就是原币额度
  const channelLimit = billing.dailyLimitUnit
  if (channelLimit > 0) {
    const channelSpentUnit =
      input.spend.byChannel.find((item) => item.channel === input.channel)?.amountUnit ?? 0
    if (roundCny(channelSpentUnit + costUnit) > channelLimit) {
      return blocked(KSK_HUNTER_BUDGET_BLOCK.CHANNEL)
    }
  }

  // 余额不够就别白跑一轮下单请求
  if (input.balanceUnit !== undefined && input.balanceUnit < costUnit) {
    return blocked(KSK_HUNTER_BUDGET_BLOCK.BALANCE)
  }

  return { allowed: true, reason: KSK_HUNTER_BUDGET_BLOCK.NONE, costCny, costUnit }
}

/** 已经把额度用尽的渠道列表，用于状态展示。 */
export function exhaustedHunterChannels(spend: KskHunterSpendSummary): KskHunterChannel[] {
  return spend.byChannel
    .filter((item) => item.dailyLimitUnit > 0 && item.amountUnit >= item.dailyLimitUnit)
    .map((item) => item.channel)
}

/** 余额解析时认这些字段名，按顺序取第一个能用的数字。 */
const BALANCE_FIELD_NAMES = [
  'balance',
  'points',
  'point',
  'credit',
  'credits',
  'remain',
  'remaining',
  'amount',
  'available'
]

/**
 * 从余额接口响应里挖出余额数字。
 *
 * 只认已知字段名（balance / points / credit …），递归下钻时也只找这些名字。
 * 刻意不做「兜底取第一个数字」：那会把 `{ code: 0, msg: 'ok' }` 的 code 当成余额 0，
 * 进而让抢号器误判余额耗尽、永久拒绝下单。认不出就返回 undefined，
 * 由调用方按「查不到余额就不拦」处理。
 */
export function parseHunterBalance(payload: unknown, depth = 0): number | undefined {
  if (depth > 6) return undefined

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = parseHunterBalance(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }

  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>

  for (const field of BALANCE_FIELD_NAMES) {
    const value = record[field]
    const numberValue =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
    if (Number.isFinite(numberValue)) return numberValue
  }

  // 本层没有已知字段名，往下钻一层继续找同样的字段名
  for (const value of Object.values(record)) {
    if (typeof value !== 'object' || value === null) continue
    const found = parseHunterBalance(value, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}
