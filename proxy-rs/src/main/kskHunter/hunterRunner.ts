/**
 * 抢号调度器。
 *
 * 每 KSK_HUNTER_POLL_INTERVAL_SECONDS 秒把所有启用链接并行查一遍。关键约束：
 * - 单链接防重入：请求超时（10s）比轮询间隔（3s）长，同一链接上轮没回来就跳过本轮，
 *   否则会给站点叠几十个并发请求，也可能把同一批货重复下单。
 * - 抢到的号先落盘再推下游：花过钱的号丢不得，重启也要能继续推。
 * - 下单前先问下游要不要号：避免下游不缺号时白买。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import {
  DEFAULT_KSK_HUNTER_CHANNEL_BILLING,
  KSK_HUNTER_BUDGET_BLOCK,
  KSK_HUNTER_CHANNEL,
  KSK_HUNTER_CHANNEL_AUTH_HEADER,
  KSK_HUNTER_CHANNEL_LABEL,
  KSK_HUNTER_CHANNEL_MIN_INTERVAL_SECONDS,
  KSK_HUNTER_CHANNEL_ORDER_MIN_INTERVAL_SECONDS,
  KSK_HUNTER_CHANNEL_REQUIRES_API_KEY,
  KSK_HUNTER_DELIVERY_MAX_ATTEMPTS,
  KSK_HUNTER_DELIVERY_STATE,
  KSK_HUNTER_MODE,
  KSK_HUNTER_POLL_INTERVAL_SECONDS,
  KSK_HUNTER_STATE,
  evaluateHunterBudget,
  exhaustedHunterChannels,
  hunterRetryDelayMs,
  hunterUnitToCny,
  isAllowedHunterEndpointUrl,
  isHunterOAuthCredential,
  isUsableHunterCredential,
  isUsableHunterOAuthCredential,
  matchesHunterRegions,
  summarizeHunterSpend,
  type HunterOrderedCredential,
  type KskHunterBudgetBlock,
  type KskHunterChannel,
  type KskHunterChannelBalance,
  type KskHunterOffer,
  type KskHunterRuntimeNotification,
  type KskHunterSpendSummary,
  type KskHunterStatus
} from '../../shared/kskHunter'
import { maskKiroApiKey } from '../../shared/kiroApiKey'
import {
  HUNTER_REPORT_EVENT,
  summarizeHunterReport,
  type HunterReport,
  type HunterReportEvent,
  type HunterReportEventType
} from '../../shared/hunterReport'
import { appendHunterReportEvent, loadHunterReportEvents } from './reportStore'
import type { DownstreamDelivery } from '../../shared/downstreamSettlement'
import { recordDownstreamDelivery } from '../downstreamSettlement/deliveryLedgerStore'
import {
  KSK_LEDGER_RETIRE_REASON,
  summarizeKskLedger,
  type KskLedgerEntry,
  type KskLedgerReport,
  type KskLedgerSort
} from '../../shared/kskLedger'
import { loadKskLedger, recordKskLedgerPurchase } from './ledgerStore'
import {
  appendKskHunterDelivery,
  appendKskHunterSpend,
  completeKskHunterPendingPurchase,
  patchKskHunterDelivery,
  setKskHunterPendingPurchase,
  toKskHunterDeliveryView,
  toKskHunterLinkView,
  toKskHunterSpendEntries,
  type KskHunterLinkRuntime,
  type KskHunterPendingPurchase,
  type PersistedKskHunterDelivery,
  type PersistedKskHunterLink,
  type PersistedKskHunterStore
} from './configStore'
import {
  assertChannelOrderAccepted,
  assertKiroConvoyCredentialMatches,
  buildConvoyCredentialUrl,
  buildOrderRequestBody,
  parseChannelOffers,
  parseKiroConvoyOrderReceipt,
  parseOrderedCredential
} from './channelAdapters'
import {
  askDownstreamNeedsAccount,
  pushKskToDownstream,
  type KskHunterFetch
} from './downstreamClient'
import { HunterBalanceCache } from './balanceClient'

/** 抢到号后的入库结果。 */
import { createHash } from 'node:crypto'

export interface HunterImportResult {
  added: boolean
  /** Existing credential was rotated or repaired in place. */
  changed?: boolean
  /**
   * 新建或更新后的账号 id。台账按它关联；完全重复且未变更时也可能返回已有 id。
   */
  accountId?: string
  /**
   * 入库时拉到的额度快照，作为「买入时基线」。
   *
   * 二手号买来可能已经烧掉一部分，记进基线才不会把前主的消耗算成下游的产出。
   */
  usageCurrent?: number
  usageLimit?: number
}

export interface KskHunterDeps {
  readStore: () => Promise<PersistedKskHunterStore>
  /** 商品站点请求走应用代理。 */
  fetchImpl: KskHunterFetch
  /** 下游是 loopback，必须直连不走代理。 */
  downstreamFetchImpl?: KskHunterFetch
  /** 发消息验活并写入账号库；抛错表示号不可用。 */
  importCredential: (
    input: HunterOrderedCredential & { groupId?: string }
  ) => Promise<HunterImportResult>
  /** 弹系统通知。 */
  notifyInStock: (input: { linkName: string; title: string; region: string }) => void
  notifyOrdered: (input: { linkName: string; maskedKey: string; region: string }) => void
  /** 当日预算用尽、自动下单被熔断时提醒一次。 */
  notifyBudgetExhausted?: (input: {
    scope: 'global' | 'channel'
    channelLabel?: string
    spentCny: number
    limitCny: number
  }) => void
  /** 余额低于阈值时提醒充值。 */
  notifyLowBalance?: (input: {
    channel: KskHunterChannel
    balanceUnit: number
    thresholdUnit: number
    unitLabel: string
  }) => void
  /** 账号库变更后让渲染进程刷新。 */
  notifyAccountsChanged: () => void
  /** 入队一份已冻结运行态，供异步快照补齐持久化字段。 */
  notifySnapshot: (runtime: KskHunterRuntimeNotification) => void
  /** 报表事件流的读写；默认落 userData 下的 JSONL，测试里可换成内存实现。 */
  appendReportEvent?: (event: HunterReportEvent) => Promise<void>
  readReportEvents?: () => Promise<HunterReportEvent[]>
  /**
   * 台账的读写。默认落 userData 下的 JSON，测试里可换成内存实现。
   *
   * 与报表事件流分开注入：事件流只追加，台账要反复更新同一条记录的累计值。
   */
  recordLedgerPurchase?: (entry: KskLedgerEntry) => Promise<void>
  readLedger?: () => Promise<KskLedgerEntry[]>
  /**
   * 记一条交付到对账账本（推送下游成功那一刻）。
   *
   * 与台账分开注入：台账是**采购**维度、按账号 id 反复更新；这里是**交付**维度、
   * 只追加，且含完整 key 必须加密落盘。默认走 userData 下的加密文件，测试换内存实现。
   */
  recordDownstreamDelivery?: (delivery: DownstreamDelivery) => Promise<void>
  /**
   * 读账号分组的 id → 名字表，供台账报表展示分组名。
   *
   * 做成注入是因为分组归本地账号库管（index.ts 的 store），把它拖进抢号模块
   * 会让这个模块在测试里必须连带 mock 整个账号存储。不注入时报表只显示 id。
   */
  readGroupNames?: () => Promise<Record<string, string>>
  log?: (message: string) => void
}

/**
 * 从推送记录还原报表事件需要的链接信息。
 *
 * 推送可能发生在链接被删掉之后（队列里的号必须继续推），所以链接查不到时
 * 用记录上冗余的 channel 与 linkName 兜底。两者都缺（v2 以前的老记录）时
 * 回落到第一个渠道：报表里错归一个渠道，比整条事件丢掉更可接受。
 */
function deliveryReportLink(
  delivery: PersistedKskHunterDelivery,
  store: PersistedKskHunterStore
): Pick<PersistedKskHunterLink, 'id' | 'name' | 'channel'> {
  const link = store.links.find((item) => item.id === delivery.linkId)
  return {
    id: delivery.linkId,
    name: link?.name ?? delivery.linkName,
    channel: link?.channel ?? delivery.channel ?? KSK_HUNTER_CHANNEL.KIRO_MARKET
  }
}

const EMPTY_STATUS: KskHunterStatus = {
  state: KSK_HUNTER_STATE.IDLE,
  running: false,
  consecutiveFailures: 0,
  totalInStockHits: 0,
  totalOrdered: 0,
  totalDelivered: 0,
  pendingDeliveries: 0,
  failedDeliveries: 0,
  budgetBlock: KSK_HUNTER_BUDGET_BLOCK.NONE,
  budgetBlockedChannels: []
}

const KIRO_CONVOY_CREDENTIAL_MAX_ATTEMPTS = 5
const KIRO_CONVOY_PLEDGE_REQUIRED_CODE = 'pledge_required'

const KIRO_CONVOY_PLEDGE_STATUS_PATTERN = /pledge|承诺|质保/i

function readKiroConvoyCredentialStatusNote(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const source = payload as Record<string, unknown>
  if (source.credential !== null) return undefined
  return typeof source.statusNote === 'string' && source.statusNote.trim()
    ? source.statusNote.trim()
    : undefined
}

class HunterHttpError extends Error {
  constructor(
    readonly status: number,
    message = `请求失败: HTTP ${status}`
  ) {
    super(message)
    this.name = 'HunterHttpError'
  }
}

function isDeterministicOrderRejection(error: unknown): boolean {
  return (
    error instanceof HunterHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408
  )
}

function fingerprintChannelApiKey(apiKey: string | undefined): string {
  return apiKey ? createHash('sha256').update(apiKey).digest('hex') : ''
}

export class KskHunterManager {
  private timer: ReturnType<typeof setTimeout> | null = null
  private deliveryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private roundPromise: Promise<void> | null = null
  /** 正在请求中的链接 id，用于单链接防重入。 */
  private readonly inFlightLinks = new Set<string>()
  /** 正在推送中的记录 id，防止定时器与手动重试重复推。 */
  private readonly inFlightDeliveries = new Set<string>()
  private readonly linkRuntime = new Map<string, KskHunterLinkRuntime>()
  /** 站点限流按渠道/API 账户生效，不能只按链接分别计算。 */
  private readonly channelLastCheckAt = new Map<KskHunterChannel, number>()
  private readonly channelLastOrderAt = new Map<KskHunterChannel, number>()
  private readonly recordedOrderIds = new Set<string>()
  /** 熔断发生在哪一天（本地日期键）。跨天后据此解除熔断，不需要额外定时器。 */
  private budgetBlockDate: string | null = null
  private readonly balanceCache = new HunterBalanceCache()
  /**
   * 已记过 blocked 事件的「日期|链接|原因」。
   *
   * 预算拦单会在每一轮（3 秒）重复触发，逐次记会把事件流刷爆且报表失真——
   * 用户想知道的是「今天这个渠道被拦过」，不是「被拦了 28800 次」。
   */
  private readonly loggedBlocks = new Set<string>()
  private status: KskHunterStatus = { ...EMPTY_STATUS }

  constructor(private readonly deps: KskHunterDeps) {}

  /**
   * 记一条报表事件。
   *
   * 刻意吞掉写盘错误：报表是观测数据，磁盘满了也不该让抢号主流程失败。
   */
  private recordReportEvent(
    type: HunterReportEventType,
    link: Pick<PersistedKskHunterLink, 'id' | 'name' | 'channel'>,
    extra: Partial<Omit<HunterReportEvent, 'at' | 'type' | 'channel' | 'linkId' | 'linkName'>> = {}
  ): void {
    const append = this.deps.appendReportEvent ?? appendHunterReportEvent
    void append({
      at: Date.now(),
      type,
      channel: link.channel,
      linkId: link.id,
      linkName: link.name,
      ...extra
    }).catch((error) => {
      this.log(`报表事件写入失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** 当前报表。days 省略时用共享层的默认窗口。 */
  async report(days?: number, store?: PersistedKskHunterStore): Promise<HunterReport> {
    const source = store ?? (await this.deps.readStore())
    const read = this.deps.readReportEvents ?? loadHunterReportEvents
    return summarizeHunterReport({
      events: await read(),
      billing: source.config.billing,
      days
    })
  }

  /** 单号台账报表：成本、存活时长、下游消耗。 */
  async ledgerReport(days?: number, sort?: KskLedgerSort): Promise<KskLedgerReport> {
    const read = this.deps.readLedger ?? loadKskLedger
    // 分组名要现查：台账只存 id，分组随时可能改名或被删
    const groupNames = await this.deps.readGroupNames?.()
    return summarizeKskLedger({ entries: await read(), days, sort, groupNames })
  }

  /**
   * 记一笔采购到台账。
   *
   * 吞掉写盘错误的理由同 recordReportEvent：台账是观测数据，磁盘满了也不该
   * 让「号已经买到了」这条主流程失败。
   */
  private recordLedgerPurchase(entry: KskLedgerEntry): void {
    const record = this.deps.recordLedgerPurchase ?? recordKskLedgerPurchase
    void record(entry).catch((error) => {
      this.log(`台账写入失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * 记一条交付到对账账本。
   *
   * 只在推送下游**成功**后调：这份账本的语义就是「交给下游的号」，是收款依据。
   * 验活判死与推送失败已由报表与台账覆盖，混进来会让对账多收钱。
   *
   * 吞掉写盘错误的理由同上：号已经交出去了，磁盘满了也不该让这条主流程失败。
   * 但这里的失败比另外两处严重（丢的是收款依据），所以日志写明要人工核对。
   */
  private recordDownstreamDelivery(
    delivery: PersistedKskHunterDelivery,
    store: PersistedKskHunterStore,
    attempts: number
  ): void {
    const record = this.deps.recordDownstreamDelivery ?? recordDownstreamDelivery
    const link = deliveryReportLink(delivery, store)
    void record({
      id: delivery.id,
      accountId: delivery.accountId,
      key: delivery.key,
      maskedKey: maskKiroApiKey(delivery.key),
      region: delivery.region,
      channel: link.channel,
      linkId: delivery.linkId,
      linkName: link.name,
      groupId: delivery.groupId,
      purchasedAt: delivery.createdAt,
      deliveredAt: Date.now(),
      attempts,
      costUnit: delivery.costUnit,
      costCny: delivery.costCny,
      unitLabel: delivery.unitLabel
    }).catch((error) => {
      this.log(
        `交付账本写入失败（${maskKiroApiKey(delivery.key)} 已交付但未记账，需人工核对）：` +
          `${error instanceof Error ? error.message : String(error)}`
      )
    })
  }

  snapshotStatus(): KskHunterStatus {
    return { ...this.status }
  }

  linkRuntimeOf(linkId: string): KskHunterLinkRuntime {
    const runtime = this.linkRuntime.get(linkId) ?? { lastInStock: false, running: false }
    return { ...runtime, running: this.inFlightLinks.has(linkId) }
  }

  async start(): Promise<void> {
    this.stopped = false
    const store = await this.deps.readStore()
    await this.refreshDeliveryCounters(store)
    if (store.links.some((link) => link.enabled)) this.scheduleNext(0)
    else this.status = { ...this.status, state: KSK_HUNTER_STATE.IDLE, running: false }
    this.scheduleDeliveryDrain(0)
    this.notifySnapshotSafely()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer)
    this.deliveryTimer = null
    this.status = { ...this.status, running: false, nextRunAt: undefined }
  }

  /** 配置或链接变更后重建调度。 */
  async reload(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // 已删除链接的运行时状态一并清掉，避免视图里留下幽灵条目
    const store = await this.deps.readStore()
    const liveIds = new Set(store.links.map((link) => link.id))
    for (const linkId of [...this.linkRuntime.keys()]) {
      if (!liveIds.has(linkId)) this.linkRuntime.delete(linkId)
    }
    await this.start()
  }

  /** 立即跑一轮，忽略定时器节奏。 */
  async runNow(): Promise<KskHunterStatus> {
    this.stopped = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.runRound()
    return this.snapshotStatus()
  }

  /** 手动重试一条推送记录。 */
  async retryDelivery(deliveryId: string): Promise<void> {
    const store = await this.deps.readStore()
    const delivery = store.deliveries.find((item) => item.id === deliveryId)
    if (!delivery) throw new Error('记录不存在或已删除')
    if (delivery.state === KSK_HUNTER_DELIVERY_STATE.DELIVERED) {
      throw new Error('该记录已交付，无需重试')
    }
    await patchKskHunterDelivery(deliveryId, {
      state: KSK_HUNTER_DELIVERY_STATE.PENDING,
      attempts: 0,
      nextAttemptAt: undefined,
      lastError: undefined
    })
    this.scheduleDeliveryDrain(0)
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.status = { ...this.status, nextRunAt: Date.now() + delayMs }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runRound()
    }, delayMs)
  }

  private runRound(): Promise<void> {
    if (this.roundPromise) return this.roundPromise
    this.roundPromise = this.executeRound().finally(() => {
      this.roundPromise = null
    })
    return this.roundPromise
  }

  private async executeRound(): Promise<void> {
    this.status = {
      ...this.status,
      state: KSK_HUNTER_STATE.RUNNING,
      running: true,
      lastRoundAt: Date.now(),
      nextRunAt: undefined,
      // 余额不足是每轮重新判定的（充值后应立刻恢复），所以每轮先清掉；
      // 预算类熔断按天锁定，由 refreshDeliveryCounters 保留。
      budgetBlock:
        this.status.budgetBlock === KSK_HUNTER_BUDGET_BLOCK.BALANCE
          ? KSK_HUNTER_BUDGET_BLOCK.NONE
          : this.status.budgetBlock
    }

    try {
      const store = await this.deps.readStore()
      const activeLinks = store.links.filter(
        (link) => link.enabled && Boolean(link.secrets.listUrl || link.pendingPurchase)
      )
      // async checkLink 会先同步建立 inFlight，再在首个 await 处挂起；统一通知可观察到整轮真实 Set。
      const checks = activeLinks.map((link) => this.checkLink(link, store))
      this.notifySnapshotSafely()
      if (activeLinks.length === 0) {
        this.status = { ...this.status, state: KSK_HUNTER_STATE.IDLE, running: false }
        return
      }

      // 并行查所有链接；单链接失败不影响其它链接
      const results = await Promise.all(checks)
      const failedCount = results.filter((ok) => !ok).length

      this.status = {
        ...this.status,
        state: failedCount > 0 ? KSK_HUNTER_STATE.DEGRADED : KSK_HUNTER_STATE.HEALTHY,
        running: false,
        consecutiveFailures:
          failedCount === activeLinks.length ? this.status.consecutiveFailures + 1 : 0,
        lastError: failedCount > 0 ? `${failedCount} 个链接本轮查询失败` : undefined
      }
      await this.refreshDeliveryCounters()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.status = {
        ...this.status,
        state: KSK_HUNTER_STATE.DEGRADED,
        running: false,
        lastError: message,
        consecutiveFailures: this.status.consecutiveFailures + 1
      }
      this.log(`轮询失败：${message}`)
    } finally {
      this.notifySnapshotSafely()
      if (!this.stopped) this.scheduleNext(KSK_HUNTER_POLL_INTERVAL_SECONDS * 1000)
    }
  }

  /** 查一条链接。返回 false 表示本轮该链接失败。 */
  private async checkLink(
    link: PersistedKskHunterLink,
    store: PersistedKskHunterStore
  ): Promise<boolean> {
    // 上轮还没回来就跳过，别给站点叠并发，也别重复下单
    if (this.inFlightLinks.has(link.id)) return true

    /*
     * Kiro 拼车的 3 秒限流属于整个渠道/API 账户；其它严格渠道维持原有逐链接节流。
     * 手动“立即查询”也不能绕过站点硬限流。
     */
    const minIntervalMs = KSK_HUNTER_CHANNEL_MIN_INTERVAL_SECONDS[link.channel] * 1000
    const enforcesMinInterval =
      minIntervalMs > KSK_HUNTER_POLL_INTERVAL_SECONDS * 1000 ||
      link.channel === KSK_HUNTER_CHANNEL.KIRO_CONVOY
    if (enforcesMinInterval) {
      const lastCheckedAt =
        link.channel === KSK_HUNTER_CHANNEL.KIRO_CONVOY
          ? this.channelLastCheckAt.get(link.channel)
          : this.linkRuntimeOf(link.id).lastCheckedAt
      if (lastCheckedAt !== undefined && Date.now() - lastCheckedAt < minIntervalMs) return true
    }

    // 要求请求头鉴权的渠道没配密钥就别发请求：必然 401，还会把密钥错误伪装成站点故障。
    const apiKey = this.channelApiKey(link.channel, store)
    if (KSK_HUNTER_CHANNEL_REQUIRES_API_KEY[link.channel] && !apiKey) {
      this.linkRuntime.set(link.id, {
        ...this.linkRuntimeOf(link.id),
        lastInStock: false,
        lastError: `${KSK_HUNTER_CHANNEL_LABEL[link.channel]} 渠道需要在设置里填写 API Key`
      })
      return false
    }

    if (link.channel === KSK_HUNTER_CHANNEL.KIRO_CONVOY) {
      // 在首个 await 前占住渠道时间窗，多个同渠道链接同轮也只会发一个请求。
      this.channelLastCheckAt.set(link.channel, Date.now())
    }
    this.inFlightLinks.add(link.id)
    try {
      /*
       * quick-board 已经成交时，优先续领凭证，绝不再查库存或重复 POST。
       * pendingPurchase 持久化在链接上，因此应用重启后仍走这里。
       */
      if (link.channel === KSK_HUNTER_CHANNEL.KIRO_CONVOY && link.pendingPurchase) {
        if (link.pendingPurchase.blockedReason) {
          throw new Error(link.pendingPurchase.blockedReason)
        }
        await this.resumeConvoyPurchase(link, store, link.pendingPurchase)
        this.linkRuntime.set(link.id, {
          ...this.linkRuntimeOf(link.id),
          lastInStock: false,
          lastCheckedAt: Date.now(),
          lastError: undefined
        })
        return true
      }

      const payload = await this.fetchJson(
        link.secrets.listUrl,
        store.config.requestTimeoutSeconds,
        { method: 'GET', apiKey, channel: link.channel }
      )
      const offers = parseChannelOffers(link.channel, payload).filter(
        (offer) =>
          offer.stock > 0 &&
          matchesHunterRegions(link.regions, offer.region) &&
          !(
            link.channel === KSK_HUNTER_CHANNEL.KIRO_CONVOY &&
            offer.goodsId === link.lastCompletedConvoyId
          )
      )
      const wasInStock = this.linkRuntimeOf(link.id).lastInStock
      this.linkRuntime.set(link.id, {
        ...this.linkRuntimeOf(link.id),
        lastInStock: offers.length > 0,
        lastCheckedAt: Date.now(),
        lastError: undefined
      })
      if (offers.length > 0 && !wasInStock) {
        this.recordReportEvent(HUNTER_REPORT_EVENT.RESTOCK, link, {
          offerCount: offers.length,
          region: offers[0].region || undefined
        })
      }
      if (offers.length === 0) return true

      this.status = {
        ...this.status,
        totalInStockHits: this.status.totalInStockHits + offers.length
      }
      await this.handleInStock(link, offers, store)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.linkRuntime.set(link.id, {
        ...this.linkRuntimeOf(link.id),
        lastInStock: false,
        lastCheckedAt: Date.now(),
        lastError: message
      })
      this.log(`链接“${link.name}”查询失败：${message}`)
      return false
    } finally {
      this.inFlightLinks.delete(link.id)
    }
  }

  private async handleInStock(
    link: PersistedKskHunterLink,
    offers: KskHunterOffer[],
    store: PersistedKskHunterStore
  ): Promise<void> {
    const shouldNotify = link.mode === KSK_HUNTER_MODE.NOTIFY || store.config.notifyOnAutoOrder
    if (shouldNotify) {
      for (const offer of offers) {
        this.deps.notifyInStock({
          linkName: link.name,
          title: offer.title || link.name,
          region: offer.region
        })
      }
    }
    if (link.mode !== KSK_HUNTER_MODE.AUTO_ORDER) return
    if (!link.secrets.orderUrl) {
      this.linkRuntime.set(link.id, {
        ...this.linkRuntimeOf(link.id),
        lastError: '该链接为自动下单模式但未配置下单地址'
      })
      return
    }

    const orderMinIntervalMs = KSK_HUNTER_CHANNEL_ORDER_MIN_INTERVAL_SECONDS[link.channel] * 1000
    const latestChannelOrderAt = (): number | undefined => {
      const inMemory = this.channelLastOrderAt.get(link.channel) ?? 0
      const persisted = store.links
        .filter((item) => item.channel === link.channel)
        .reduce((latest, item) => Math.max(latest, item.lastConvoyOrderAt ?? 0), 0)
      const latest = Math.max(inMemory, persisted)
      return latest > 0 ? latest : undefined
    }
    const lastOrderAt = latestChannelOrderAt()
    if (
      orderMinIntervalMs > 0 &&
      lastOrderAt !== undefined &&
      Date.now() - lastOrderAt < orderMinIntervalMs
    ) {
      return
    }

    // 预算检查在最前面：超限时只停下单，通知已经在上面发过了
    const spend = summarizeHunterSpend(toKskHunterSpendEntries(store), store.config)
    const balanceUnit = await this.resolveBalanceUnit(link.channel, store)
    const budget = evaluateHunterBudget({
      channel: link.channel,
      priceUnit: offers[0].price,
      config: store.config,
      spend,
      balanceUnit
    })
    if (!budget.allowed) {
      this.applyBudgetBlock(link, budget.reason, spend, store, balanceUnit)
      return
    }

    // 下游不缺号就别花钱。下游未开启时按「一直要」处理，只入库不推送。
    if (store.config.downstreamEnabled) {
      const needs = await askDownstreamNeedsAccount({
        baseUrl: store.config.downstreamBaseUrl,
        apiKey: store.secrets.downstreamApiKey,
        timeoutSeconds: store.config.requestTimeoutSeconds,
        fetchImpl: this.deps.downstreamFetchImpl ?? this.deps.fetchImpl
      })
      if (!needs) return
    }

    /*
     * 预算/下游检查都含 await；在真正下单前重新检查并同步占住渠道时间窗，
     * 保证多个同 API 账户的链接同轮最多一个 quick-board。
     */
    const latestBeforeOrder = latestChannelOrderAt()
    if (
      orderMinIntervalMs > 0 &&
      latestBeforeOrder !== undefined &&
      Date.now() - latestBeforeOrder < orderMinIntervalMs
    ) {
      return
    }
    const orderAttemptAt = Date.now()
    if (orderMinIntervalMs > 0) this.channelLastOrderAt.set(link.channel, orderAttemptAt)
    this.linkRuntime.set(link.id, {
      ...this.linkRuntimeOf(link.id),
      lastOrderAt: orderAttemptAt
    })
    if (link.channel === KSK_HUNTER_CHANNEL.KIRO_CONVOY) {
      link.lastConvoyOrderAt = orderAttemptAt
    }

    // 一轮只买一个：下游一次只说要不要，买多了没人接
    await this.orderOne(link, offers[0], store, budget)
  }

  /**
   * 取该渠道余额；未启用检查、未配地址或查询失败时返回 undefined。
   *
   * 查不到就返回 undefined（等于「不按余额拦」）：站点余额接口抖一下就把抢号
   * 整个停掉，代价比偶尔白跑一次下单请求大得多。
   */
  private async resolveBalanceUnit(
    channel: KskHunterChannel,
    store: PersistedKskHunterStore
  ): Promise<number | undefined> {
    if (!store.config.balanceCheckEnabled) return undefined
    const url = store.secrets.balanceUrls?.[channel]
    if (!url) return undefined

    const snapshot = await this.balanceCache.resolve({
      channel,
      url,
      timeoutSeconds: store.config.requestTimeoutSeconds,
      fetchImpl: this.deps.fetchImpl,
      apiKey: this.channelApiKey(channel, store)
    })
    if (snapshot.error) {
      this.log(`渠道 ${channel} 余额查询失败：${snapshot.error}`)
      return undefined
    }

    const billing = store.config.billing[channel]
    const threshold = billing?.lowBalanceThresholdUnit ?? 0
    if (snapshot.amountUnit !== undefined && threshold > 0 && snapshot.amountUnit < threshold) {
      this.deps.notifyLowBalance?.({
        channel,
        balanceUnit: snapshot.amountUnit,
        thresholdUnit: threshold,
        unitLabel: billing?.unitLabel ?? ''
      })
    }
    return snapshot.amountUnit
  }

  /** 各渠道余额快照，供 IPC 组装 UI 展示。 */
  channelBalances(store: PersistedKskHunterStore): KskHunterChannelBalance[] {
    return (Object.values(KSK_HUNTER_CHANNEL) as KskHunterChannel[]).map((channel) => {
      const billing = store.config.billing[channel] ?? DEFAULT_KSK_HUNTER_CHANNEL_BILLING
      const cached = this.balanceCache.peek(channel)
      const threshold = billing.lowBalanceThresholdUnit
      return {
        channel,
        amountUnit: cached?.amountUnit,
        unitLabel: billing.unitLabel,
        amountCny:
          cached?.amountUnit === undefined
            ? undefined
            : hunterUnitToCny(cached.amountUnit, billing.cnyPerUnit),
        lowThresholdUnit: threshold,
        isLow: cached?.amountUnit !== undefined && threshold > 0 && cached.amountUnit < threshold,
        checkedAt: cached?.checkedAt,
        error: cached?.error
      }
    })
  }

  /**
   * 同一天、同一链接、同一原因的拦单只记一条报表事件。
   *
   * 去重键带日期，所以跨天会自然重新记一次，不需要在跨天时清理这个集合。
   */
  private recordBlockOnce(
    link: PersistedKskHunterLink,
    reason: KskHunterBudgetBlock,
    date: string
  ): void {
    const dedupeKey = `${date}|${link.id}|${reason}`
    if (this.loggedBlocks.has(dedupeKey)) return
    this.loggedBlocks.add(dedupeKey)
    this.recordReportEvent(HUNTER_REPORT_EVENT.BLOCKED, link, { reason })
  }

  /** 记录熔断状态并提醒一次；通知去重由 LocalNotificationService 负责。 */
  private applyBudgetBlock(
    link: PersistedKskHunterLink,
    reason: KskHunterBudgetBlock,
    spend: KskHunterSpendSummary,
    store: PersistedKskHunterStore,
    balanceUnit?: number
  ): void {
    const billing = store.config.billing[link.channel] ?? DEFAULT_KSK_HUNTER_CHANNEL_BILLING
    this.recordBlockOnce(link, reason, spend.date)

    if (reason === KSK_HUNTER_BUDGET_BLOCK.UNKNOWN_PRICE) {
      // 未知价格是逐商品的问题，不是预算耗尽，不进熔断状态
      this.linkRuntime.set(link.id, {
        ...this.linkRuntimeOf(link.id),
        lastError: '商品未提供价格，已按设置跳过自动下单（可在配置里允许未知价格下单）'
      })
      return
    }

    if (reason === KSK_HUNTER_BUDGET_BLOCK.BALANCE) {
      // 余额不足不算预算熔断：充值后立刻能恢复，不该按天锁住
      this.linkRuntime.set(link.id, {
        ...this.linkRuntimeOf(link.id),
        lastError: `余额不足（剩 ${balanceUnit ?? 0} ${billing.unitLabel}），已跳过自动下单；充值后自动恢复`
      })
      this.status = { ...this.status, budgetBlock: KSK_HUNTER_BUDGET_BLOCK.BALANCE }
      this.log(
        `渠道 ${link.channel} 余额不足（${balanceUnit ?? 0} ${billing.unitLabel}），跳过下单`
      )
      return
    }

    this.status = {
      ...this.status,
      budgetBlock: reason,
      budgetBlockedChannels: exhaustedHunterChannels(spend)
    }
    // 记下熔断日期，跨天后 refreshDeliveryCounters 会据此解除
    this.budgetBlockDate = spend.date

    const isGlobal = reason === KSK_HUNTER_BUDGET_BLOCK.GLOBAL
    const channelSpend = spend.byChannel.find((item) => item.channel === link.channel)
    // 全局上限是人民币，渠道上限是原币，提示要分别用对应口径
    const spentCny = isGlobal ? spend.totalCny : (channelSpend?.amountUnit ?? 0)
    const limitCny = isGlobal ? spend.dailyLimitCny : billing.dailyLimitUnit
    const unit = isGlobal ? '¥' : ''
    const suffix = isGlobal ? '' : ` ${billing.unitLabel}`

    this.linkRuntime.set(link.id, {
      ...this.linkRuntimeOf(link.id),
      lastError: `${isGlobal ? '全局' : '该渠道'}当日预算已用尽（${unit}${spentCny}${suffix} / ${unit}${limitCny}${suffix}），已暂停自动下单，仍会提醒`
    })
    this.log(
      `${isGlobal ? '全局' : link.channel} 当日预算用尽（${spentCny}/${limitCny}），暂停自动下单`
    )
    this.deps.notifyBudgetExhausted?.({
      scope: isGlobal ? 'global' : 'channel',
      channelLabel: isGlobal ? undefined : link.name,
      spentCny,
      limitCny
    })
  }

  private async resumeConvoyPurchase(
    link: PersistedKskHunterLink,
    store: PersistedKskHunterStore,
    pending: KskHunterPendingPurchase
  ): Promise<void> {
    if (!link.secrets.orderUrl) throw new Error('Kiro 拼车缺少下单地址，无法推导凭证地址')
    if (pending.orderUncertain && !pending.credentialRecoveryReady) {
      const blockedReason =
        '下单进程在请求结果确认前中断；请先到拼车站点核对订单，再重新保存该链接以确认领取凭证'
      const updated = {
        ...pending,
        recoveryRequiresConfirmation: true,
        blockedReason
      }
      await setKskHunterPendingPurchase(link.id, updated)
      link.pendingPurchase = updated
      throw new Error(blockedReason)
    }
    const currentApiKey = this.channelApiKey(link.channel, store)
    if (
      pending.apiKeyFingerprint &&
      fingerprintChannelApiKey(currentApiKey) !== pending.apiKeyFingerprint
    ) {
      const blockedReason = '凭证领取已暂停：API Key 与下单时不一致，请恢复原 Key 后重试'
      const updated = { ...pending, blockedReason }
      await setKskHunterPendingPurchase(link.id, updated)
      link.pendingPurchase = updated
      throw new Error(blockedReason)
    }

    let currentPending = pending
    try {
      const payload = await this.fetchJson(
        buildConvoyCredentialUrl(
          link.secrets.orderUrl,
          currentPending.credentialEndpoint ?? 'detail'
        ),
        store.config.requestTimeoutSeconds,
        {
          method: 'GET',
          apiKey: currentApiKey,
          channel: link.channel
        }
      )
      assertKiroConvoyCredentialMatches(payload, currentPending.goodsId)
      const statusNote = readKiroConvoyCredentialStatusNote(payload)
      if (statusNote) {
        if (KIRO_CONVOY_PLEDGE_STATUS_PATTERN.test(statusNote)) {
          throw new Error(`${KIRO_CONVOY_PLEDGE_REQUIRED_CODE}: ${statusNote}`)
        }
        throw new Error(`凭证暂不可用：${statusNote}`)
      }
      const credential = parseOrderedCredential(payload, currentPending.region)
      const orderAlreadyRecorded =
        currentPending.orderRecorded === true ||
        currentPending.orderUncertain !== true ||
        this.recordedOrderIds.has(currentPending.id)
      await this.persistOrderedCredential(
        link,
        store,
        { costCny: currentPending.costCny, costUnit: currentPending.costUnit },
        credential,
        currentPending.id,
        currentPending.orderedAt,
        orderAlreadyRecorded
      )
      if (!orderAlreadyRecorded) {
        /*
         * ORDERED 事件先用稳定 purchaseId 写入，再落完成标记。若此处崩溃，重试可能
         * 再追加同 eventId，但报表聚合会去重，不会漏单或重复统计。
         */
        currentPending = { ...currentPending, orderRecorded: true }
        await setKskHunterPendingPurchase(link.id, currentPending)
        link.pendingPurchase = currentPending
      }
      await completeKskHunterPendingPurchase(link.id, currentPending.id, currentPending.goodsId)
      this.recordedOrderIds.delete(currentPending.id)
      link.pendingPurchase = undefined
      link.lastCompletedConvoyId = currentPending.goodsId
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const fallbackToCredential =
        (currentPending.credentialEndpoint ?? 'detail') === 'detail' && message.includes('HTTP 404')
      const credentialAttempts = fallbackToCredential
        ? currentPending.credentialAttempts
        : currentPending.credentialAttempts + 1
      const pledgeRequired = message.includes(KIRO_CONVOY_PLEDGE_REQUIRED_CODE)
      const exhausted =
        !fallbackToCredential && credentialAttempts >= KIRO_CONVOY_CREDENTIAL_MAX_ATTEMPTS
      const blockedReason = pledgeRequired
        ? '凭证领取已暂停：请先到拼车站点确认质保声明，再重新保存该链接以重试'
        : exhausted
          ? `凭证领取连续失败 ${credentialAttempts} 次，已暂停自动重试以避免触发站点限流`
          : undefined
      const updated: KskHunterPendingPurchase = {
        ...currentPending,
        credentialEndpoint: fallbackToCredential ? 'credential' : currentPending.credentialEndpoint,
        credentialAttempts,
        blockedReason
      }
      await setKskHunterPendingPurchase(link.id, updated)
      link.pendingPurchase = updated
      if (blockedReason) throw new Error(blockedReason)
      throw error
    }
  }

  private async persistOrderedCredential(
    link: PersistedKskHunterLink,
    store: PersistedKskHunterStore,
    budget: { costCny: number; costUnit?: number },
    credential: HunterOrderedCredential,
    purchaseId: string,
    purchasedAt: number,
    orderAlreadyRecorded: boolean
  ): Promise<void> {
    if (isHunterOAuthCredential(credential)) {
      if (!isUsableHunterOAuthCredential(credential)) {
        throw new Error('下单返回的 OAuth 凭证不完整')
      }
    } else if (!isUsableHunterCredential(credential)) {
      throw new Error('下单返回的 KSK 或区域不合法')
    }
    // 只有拿到可用凭据才结束本单；2xx 但响应不可解析时重试必须复用同一个幂等键
    this.clearIdempotencyKey(link.id)

    const unitLabel = store.config.billing[link.channel]?.unitLabel
    await appendKskHunterSpend({
      id: purchaseId,
      channel: link.channel,
      linkId: link.id,
      linkName: link.name,
      amountUnit: budget.costUnit ?? 0,
      amountCny: budget.costCny,
      at: purchasedAt
    })
    const shouldRecordOrder = !orderAlreadyRecorded && !this.recordedOrderIds.has(purchaseId)
    if (shouldRecordOrder) {
      this.status = { ...this.status, totalOrdered: this.status.totalOrdered + 1 }
      this.balanceCache.invalidate(link.channel)
      this.recordReportEvent(HUNTER_REPORT_EVENT.ORDERED, link, {
        eventId: purchaseId,
        region: credential.region,
        costUnit: budget.costUnit,
        costCny: budget.costCny,
        unitLabel
      })
      this.recordedOrderIds.add(purchaseId)
    }

    if (isHunterOAuthCredential(credential)) {
      const result = await this.deps.importCredential({
        ...credential,
        groupId: store.config.targetGroupId
      })
      if (result.added || result.changed) this.deps.notifyAccountsChanged()
      if (store.config.notifyOnAutoOrder) {
        this.deps.notifyOrdered({
          linkName: link.name,
          maskedKey: 'OAuth 凭证',
          region: credential.region
        })
      }
      if (result.accountId) {
        this.recordLedgerPurchase({
          accountId: result.accountId,
          maskedKey: 'OAuth 凭证',
          region: credential.region,
          channel: link.channel,
          linkId: link.id,
          linkName: link.name,
          groupId: store.config.targetGroupId,
          purchasedAt,
          costUnit: budget.costUnit,
          costCny: budget.costCny,
          unitLabel,
          baselineUsage: result.usageCurrent,
          currentUsage: result.usageCurrent,
          usageLimit: result.usageLimit,
          carriedCredits: 0,
          usedCredits: 0
        })
      }
      return
    }

    const maskedKey = maskKiroApiKey(credential.key)
    const delivery: PersistedKskHunterDelivery = {
      id: purchaseId,
      linkId: link.id,
      linkName: link.name,
      channel: link.channel,
      key: credential.key,
      region: credential.region,
      groupId: store.config.targetGroupId,
      state: KSK_HUNTER_DELIVERY_STATE.PENDING,
      attempts: 0,
      createdAt: purchasedAt,
      updatedAt: purchasedAt,
      costUnit: budget.costUnit,
      costCny: budget.costCny,
      unitLabel
    }
    // 稳定 purchaseId + append 去重让重启恢复不会重复落交付与花费。
    await appendKskHunterDelivery(delivery)
    if (store.config.notifyOnAutoOrder) {
      this.deps.notifyOrdered({ linkName: link.name, maskedKey, region: credential.region })
    }

    const purchase = {
      maskedKey,
      region: credential.region,
      channel: link.channel,
      linkId: link.id,
      linkName: link.name,
      groupId: store.config.targetGroupId,
      purchasedAt,
      costUnit: budget.costUnit,
      costCny: budget.costCny,
      unitLabel
    }

    try {
      const result = await this.deps.importCredential({
        ...credential,
        groupId: store.config.targetGroupId
      })
      if (result.added || result.changed) this.deps.notifyAccountsChanged()
      if (result.accountId) {
        await patchKskHunterDelivery(delivery.id, { accountId: result.accountId })
        this.recordLedgerPurchase({
          ...purchase,
          accountId: result.accountId,
          baselineUsage: result.usageCurrent,
          currentUsage: result.usageCurrent,
          usageLimit: result.usageLimit,
          carriedCredits: 0,
          usedCredits: 0
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await patchKskHunterDelivery(delivery.id, {
        state: KSK_HUNTER_DELIVERY_STATE.DEAD_KEY,
        lastError: `验活失败：${message}`
      })
      this.recordReportEvent(HUNTER_REPORT_EVENT.DEAD_KEY, link, { region: credential.region })
      this.recordLedgerPurchase({
        ...purchase,
        accountId: `dead:${delivery.id}`,
        retiredAt: Date.now(),
        retireReason: KSK_LEDGER_RETIRE_REASON.INVALID,
        carriedCredits: 0,
        usedCredits: 0
      })
      this.log(`已购 ${maskedKey} 验活失败，不推送下游：${message}`)
      await this.refreshDeliveryCounters()
      return
    }

    this.scheduleDeliveryDrain(0)
  }

  private async orderOne(
    link: PersistedKskHunterLink,
    offer: KskHunterOffer,
    store: PersistedKskHunterStore,
    budget: { costCny: number; costUnit?: number }
  ): Promise<void> {
    const apiKey = this.channelApiKey(link.channel, store)

    if (link.channel === KSK_HUNTER_CHANNEL.KIRO_CONVOY) {
      /*
       * 所有本地可判定错误都必须发生在 pending 落盘前；否则错误 URL 会被误判为
       * “可能已扣费”并永久锁住链接。
       */
      buildConvoyCredentialUrl(link.secrets.orderUrl)
      if (!isAllowedHunterEndpointUrl(link.secrets.orderUrl, link.channel)) {
        throw new Error('Kiro 拼车下单地址只允许使用 kiro.zhiqwc.top')
      }

      const orderedAt = link.lastConvoyOrderAt ?? Date.now()
      const pendingBase: KskHunterPendingPurchase = {
        id: randomUUID(),
        goodsId: offer.goodsId,
        title: offer.title,
        region: offer.region,
        price: offer.price,
        costCny: budget.costCny,
        costUnit: budget.costUnit,
        orderedAt,
        apiKeyFingerprint: fingerprintChannelApiKey(apiKey),
        credentialEndpoint: 'detail',
        credentialAttempts: 0
      }
      const attemptingPending: KskHunterPendingPurchase = {
        ...pendingBase,
        orderUncertain: true
      }
      /*
       * quick-board 没有幂等键。先持久化“准备发单”，再 POST；即使进程在远端扣费后
       * 立即崩溃，重启也只会领取凭证，不会再次付费。
       */
      await setKskHunterPendingPurchase(link.id, attemptingPending)
      link.pendingPurchase = attemptingPending

      const clearRejectedAttempt = async (): Promise<void> => {
        await setKskHunterPendingPurchase(link.id, undefined)
        link.pendingPurchase = undefined
      }
      const markCredentialRecoveryReady = async (): Promise<KskHunterPendingPurchase> => {
        const recoverablePending = {
          ...attemptingPending,
          credentialRecoveryReady: true
        }
        await setKskHunterPendingPurchase(link.id, recoverablePending)
        link.pendingPurchase = recoverablePending
        return recoverablePending
      }

      let orderPayload: unknown
      try {
        orderPayload = await this.fetchJson(
          link.secrets.orderUrl,
          store.config.requestTimeoutSeconds,
          {
            method: 'POST',
            body: buildOrderRequestBody(link.channel, offer),
            apiKey,
            channel: link.channel
          }
        )
      } catch (error) {
        if (isDeterministicOrderRejection(error)) {
          await clearRejectedAttempt()
          throw error
        }
        /*
         * 网络断开、超时、5xx 或成功响应无法解析时，服务端可能已经扣费。
         * 保留 preflight pending，后续只尝试 GET 当前 ride 的凭证。
         */
        const recoverablePending = await markCredentialRecoveryReady()
        await appendKskHunterSpend({
          id: recoverablePending.id,
          channel: link.channel,
          linkId: link.id,
          linkName: link.name,
          amountUnit: budget.costUnit ?? 0,
          amountCny: budget.costCny,
          at: orderedAt
        })
        throw new Error('quick-board 结果不确定，已停止重复下单并改为只尝试领取凭证')
      }

      try {
        assertChannelOrderAccepted(orderPayload)
      } catch (error) {
        // 收到明确业务拒绝，服务端没有成交，可安全解除 pending。
        await clearRejectedAttempt()
        throw error
      }

      let receipt: ReturnType<typeof parseKiroConvoyOrderReceipt>
      try {
        receipt = parseKiroConvoyOrderReceipt(orderPayload)
      } catch {
        // 2xx 却缺订单关联字段时仍可能已扣费，只能保留 uncertain 并转凭证恢复。
        const recoverablePending = await markCredentialRecoveryReady()
        await appendKskHunterSpend({
          id: recoverablePending.id,
          channel: link.channel,
          linkId: link.id,
          linkName: link.name,
          amountUnit: budget.costUnit ?? 0,
          amountCny: budget.costCny,
          at: orderedAt
        })
        throw new Error('quick-board 已响应但缺少订单关联字段，已停止重复下单')
      }
      const actualCostUnit = receipt.fare ?? budget.costUnit
      const actualCostCny =
        actualCostUnit === undefined
          ? budget.costCny
          : hunterUnitToCny(actualCostUnit, store.config.billing[link.channel]?.cnyPerUnit ?? 1)
      const pending: KskHunterPendingPurchase = {
        ...pendingBase,
        goodsId: receipt.convoyId,
        price: receipt.fare ?? offer.price,
        costUnit: actualCostUnit,
        costCny: actualCostCny,
        boardRecordId: receipt.boardRecordId,
        orderRecorded: true
      }
      // 将 preflight 状态升级成“已明确成交、待领凭证”。
      await setKskHunterPendingPurchase(link.id, pending)
      link.pendingPurchase = pending

      this.status = { ...this.status, totalOrdered: this.status.totalOrdered + 1 }
      this.balanceCache.invalidate(link.channel)
      await appendKskHunterSpend({
        id: pending.id,
        channel: link.channel,
        linkId: link.id,
        linkName: link.name,
        amountUnit: actualCostUnit ?? 0,
        amountCny: actualCostCny,
        at: orderedAt
      })
      this.recordReportEvent(HUNTER_REPORT_EVENT.ORDERED, link, {
        eventId: pending.id,
        region: offer.region || undefined,
        costUnit: actualCostUnit,
        costCny: actualCostCny,
        unitLabel: store.config.billing[link.channel]?.unitLabel
      })
      this.recordedOrderIds.add(pending.id)
      await this.resumeConvoyPurchase(link, store, pending)
      return
    }

    const idempotencyKey = this.resolveIdempotencyKey(link.id, offer.goodsId)
    const orderPayload = await this.fetchJson(
      link.secrets.orderUrl,
      store.config.requestTimeoutSeconds,
      {
        method: 'POST',
        body: buildOrderRequestBody(link.channel, offer, { idempotencyKey }),
        apiKey,
        channel: link.channel
      }
    )
    const credential = parseOrderedCredential(orderPayload, offer.region)
    await this.persistOrderedCredential(
      link,
      store,
      budget,
      credential,
      randomUUID(),
      Date.now(),
      false
    )
  }

  /**
   * 取（或生成）这条链接当前的下单幂等键。
   *
   * 32 位十六进制：Kiro CEO 要求这个格式，randomUUID() 带横线共 36 位，过不了它的校验。
   *
   * 键在**下单请求成功之前**一直保留，超时或 5xx 重试时复用同一个——服务端会把它识别成
   * 同一笔订单原样返回，不会重复扣费、重复发货。换 zone 则必须换键：同一个键配不同的
   * zone 会被服务端当成另一笔订单的重放，拿回来的号区域可能不是你要的。
   *
   * **只存在内存里**：进程重启后重试会变成第二笔订单（一次约 50 积分）。要修得在每次
   * 下单尝试前写盘，代价与这个风险不成比例——重启恰好卡在下单请求中间才会碰上。
   */
  private resolveIdempotencyKey(linkId: string, goodsId: string): string {
    const pending = this.linkRuntimeOf(linkId).pendingOrder
    if (pending && pending.goodsId === goodsId) return pending.key
    const key = randomBytes(16).toString('hex')
    this.linkRuntime.set(linkId, {
      ...this.linkRuntimeOf(linkId),
      pendingOrder: { goodsId, key }
    })
    return key
  }

  private clearIdempotencyKey(linkId: string): void {
    const runtime = this.linkRuntimeOf(linkId)
    if (!runtime.pendingOrder) return
    this.linkRuntime.set(linkId, { ...runtime, pendingOrder: undefined })
  }

  /** 该渠道的请求头密钥；未配置或不需要时为 undefined。 */
  private channelApiKey(
    channel: KskHunterChannel,
    store: PersistedKskHunterStore
  ): string | undefined {
    if (!KSK_HUNTER_CHANNEL_REQUIRES_API_KEY[channel]) return undefined
    return store.secrets.apiKeys?.[channel] || undefined
  }

  private async fetchJson(
    url: string,
    timeoutSeconds: number,
    init: { method: string; body?: unknown; apiKey?: string; channel?: KskHunterChannel } = {
      method: 'GET'
    }
  ): Promise<unknown> {
    const parsed = new URL(url)
    if (!isAllowedHunterEndpointUrl(parsed.toString(), init.channel)) {
      throw new Error(
        init.channel === KSK_HUNTER_CHANNEL.KIRO_CONVOY
          ? 'Kiro 拼车接口只允许访问 kiro.zhiqwc.top'
          : '商品站点接口必须使用 HTTPS'
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(3, timeoutSeconds) * 1000)
    try {
      const response = await this.deps.fetchImpl(parsed.toString(), {
        method: init.method,
        headers: {
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(init.apiKey ? { [KSK_HUNTER_CHANNEL_AUTH_HEADER]: init.apiKey } : {})
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal
      })
      const text = await response.text()
      let payload: unknown = {}
      if (text) {
        try {
          payload = JSON.parse(text) as unknown
        } catch (error) {
          // 错误响应常是纯文本；此时 HTTP 状态比 JSON 解析异常更有诊断价值。
          if (response.ok) throw error
        }
      }
      if (!response.ok) {
        const errorPayload =
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as Record<string, unknown>).error
            : undefined
        const code =
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? String(
                (payload as Record<string, unknown>).code ??
                  (errorPayload && typeof errorPayload === 'object' && !Array.isArray(errorPayload)
                    ? (errorPayload as Record<string, unknown>).type
                    : '')
              )
            : ''
        if (response.status === 403 && code === 'pledge_required') {
          throw new HunterHttpError(
            response.status,
            '凭证领取需要先在站点确认质保声明（pledge_required）'
          )
        }
        throw new HunterHttpError(
          response.status,
          code ? `请求失败: HTTP ${response.status} (${code})` : undefined
        )
      }
      return payload
    } finally {
      clearTimeout(timer)
    }
  }

  private scheduleDeliveryDrain(delayMs: number): void {
    if (this.stopped) return
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer)
    this.deliveryTimer = setTimeout(() => {
      this.deliveryTimer = null
      void this.drainDeliveries()
    }, delayMs)
  }

  /** 推送所有到期的待交付记录，然后按最近的下次重试时间重新排班。 */
  private async drainDeliveries(): Promise<void> {
    try {
      const store = await this.deps.readStore()
      if (!store.config.downstreamEnabled) {
        await this.refreshDeliveryCounters(store)
        return
      }
      const now = Date.now()
      const due = store.deliveries.filter(
        (delivery) =>
          delivery.state === KSK_HUNTER_DELIVERY_STATE.PENDING &&
          (delivery.nextAttemptAt ?? 0) <= now &&
          !this.inFlightDeliveries.has(delivery.id)
      )
      for (const delivery of due) await this.deliverOne(delivery, store)
      await this.refreshDeliveryCounters()
    } catch (error) {
      this.log(`推送队列处理失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.notifySnapshotSafely()
      await this.rescheduleDeliveryDrain()
    }
  }

  private async deliverOne(
    delivery: PersistedKskHunterDelivery,
    store: PersistedKskHunterStore
  ): Promise<void> {
    this.inFlightDeliveries.add(delivery.id)
    const attempts = delivery.attempts + 1
    try {
      await pushKskToDownstream(
        {
          baseUrl: store.config.downstreamBaseUrl,
          apiKey: store.secrets.downstreamApiKey,
          timeoutSeconds: store.config.requestTimeoutSeconds,
          fetchImpl: this.deps.downstreamFetchImpl ?? this.deps.fetchImpl
        },
        { key: delivery.key, region: delivery.region }
      )
      await patchKskHunterDelivery(delivery.id, {
        state: KSK_HUNTER_DELIVERY_STATE.DELIVERED,
        attempts,
        nextAttemptAt: undefined,
        lastError: undefined
      })
      this.recordReportEvent(HUNTER_REPORT_EVENT.DELIVERED, deliveryReportLink(delivery, store), {
        region: delivery.region || undefined
      })
      this.recordDownstreamDelivery(delivery, store, attempts)
      this.status = { ...this.status, totalDelivered: this.status.totalDelivered + 1 }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const exhausted = attempts >= KSK_HUNTER_DELIVERY_MAX_ATTEMPTS
      await patchKskHunterDelivery(delivery.id, {
        state: exhausted ? KSK_HUNTER_DELIVERY_STATE.FAILED : KSK_HUNTER_DELIVERY_STATE.PENDING,
        attempts,
        nextAttemptAt: exhausted ? undefined : Date.now() + hunterRetryDelayMs(attempts),
        lastError: message
      })
      // 只在重试耗尽时记事件：每次失败都记会把一条号的 6 次重试算成 6 次失败
      if (exhausted) {
        this.recordReportEvent(
          HUNTER_REPORT_EVENT.DELIVERY_FAILED,
          deliveryReportLink(delivery, store),
          { region: delivery.region || undefined }
        )
      }
      this.log(
        `推送 ${maskKiroApiKey(delivery.key)} 失败（第 ${attempts} 次）：${message}` +
          (exhausted ? ' · 重试已耗尽，需人工处理' : '')
      )
    } finally {
      this.inFlightDeliveries.delete(delivery.id)
    }
  }

  /** 按队列里最近的一个 nextAttemptAt 排下一次 drain。 */
  private async rescheduleDeliveryDrain(): Promise<void> {
    if (this.stopped) return
    const store = await this.deps.readStore()
    const pendingTimes = store.deliveries
      .filter((delivery) => delivery.state === KSK_HUNTER_DELIVERY_STATE.PENDING)
      .map((delivery) => delivery.nextAttemptAt ?? Date.now())
    if (pendingTimes.length === 0) return
    const nextAt = Math.min(...pendingTimes)
    this.scheduleDeliveryDrain(Math.max(0, nextAt - Date.now()))
  }

  private async refreshDeliveryCounters(store?: PersistedKskHunterStore): Promise<void> {
    const source = store ?? (await this.deps.readStore())
    const spend = summarizeHunterSpend(toKskHunterSpendEntries(source), source.config)
    const globalExhausted = spend.dailyLimitCny > 0 && spend.totalCny >= spend.dailyLimitCny
    const exhaustedChannels = exhaustedHunterChannels(spend)

    /*
     * 熔断状态的口径要和拦下单一致：拦下单看的是「已花 + 这单」，这里如果只看
     * 「已花是否见底」，就会把刚刚因为「买不下这一单」而熔断的状态覆盖成 none
     * （典型：上限 20、已花 15、单价 10）。所以本轮判定出的熔断要保留，
     * 只在账本按新日期重算后（跨天，花费归零）才自然解除。
     */
    const dateChanged = this.budgetBlockDate !== null && this.budgetBlockDate !== spend.date
    /*
     * 熔断状态的口径要和拦下单一致：拦下单看「已花 + 这单」，这里如果只看
     * 「已花是否见底」，就会把刚因为「买不下这一单」而熔断的状态覆盖成 none
     * （典型：上限 20、已花 15、单价 10）。所以本轮判定出的熔断要保留。
     *
     * BALANCE 也保留（否则 UI 拿不到「余额不足」状态），但它不按天锁定：
     * executeRound 每轮开始时会先把它清掉，充值后下一轮自然恢复。
     * 预算类熔断则靠 budgetBlockDate 锁到跨天。
     */
    const isBalanceBlock = this.status.budgetBlock === KSK_HUNTER_BUDGET_BLOCK.BALANCE
    const keepBlock =
      !dateChanged &&
      this.status.budgetBlock !== KSK_HUNTER_BUDGET_BLOCK.NONE &&
      (isBalanceBlock || this.budgetBlockDate !== null)
    const blockedChannels = keepBlock
      ? [...new Set([...this.status.budgetBlockedChannels, ...exhaustedChannels])]
      : exhaustedChannels
    const budgetBlock = globalExhausted
      ? KSK_HUNTER_BUDGET_BLOCK.GLOBAL
      : keepBlock
        ? this.status.budgetBlock
        : blockedChannels.length > 0
          ? KSK_HUNTER_BUDGET_BLOCK.CHANNEL
          : KSK_HUNTER_BUDGET_BLOCK.NONE
    if (budgetBlock === KSK_HUNTER_BUDGET_BLOCK.NONE) this.budgetBlockDate = null

    this.status = {
      ...this.status,
      pendingDeliveries: source.deliveries.filter(
        (delivery) => delivery.state === KSK_HUNTER_DELIVERY_STATE.PENDING
      ).length,
      failedDeliveries: source.deliveries.filter(
        (delivery) =>
          delivery.state === KSK_HUNTER_DELIVERY_STATE.FAILED ||
          delivery.state === KSK_HUNTER_DELIVERY_STATE.DEAD_KEY
      ).length,
      budgetBlock,
      budgetBlockedChannels: blockedChannels
    }
  }

  /** 当前账本的当日统计，供 IPC 组装快照。 */
  async spendSummary(store?: PersistedKskHunterStore): Promise<KskHunterSpendSummary> {
    const source = store ?? (await this.deps.readStore())
    return summarizeHunterSpend(toKskHunterSpendEntries(source), source.config)
  }

  private snapshotRuntimeNotification(): KskHunterRuntimeNotification {
    const status = this.snapshotStatus()
    const frozenStatus = Object.freeze({
      ...status,
      budgetBlockedChannels: Object.freeze([...status.budgetBlockedChannels])
    })
    return Object.freeze({
      status: frozenStatus,
      runningLinkIds: Object.freeze(Array.from(this.inFlightLinks))
    })
  }

  private notifySnapshotSafely(): void {
    try {
      this.deps.notifySnapshot(this.snapshotRuntimeNotification())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        this.log(`快照通知失败：${message}`)
      } catch {
        // 通知与日志都不能影响轮询主流程
      }
    }
  }

  private log(message: string): void {
    ;(this.deps.log ?? ((text) => console.log(text)))(`[KskHunter] ${message}`)
  }
}

/** 组装完整快照，IPC 与事件推送共用。 */
export function buildKskHunterSnapshotParts(
  store: PersistedKskHunterStore,
  manager: KskHunterManager,
  runtime?: KskHunterRuntimeNotification
): {
  links: ReturnType<typeof toKskHunterLinkView>[]
  deliveries: ReturnType<typeof toKskHunterDeliveryView>[]
} {
  const runningLinkIds = runtime ? new Set(runtime.runningLinkIds) : undefined
  return {
    links: store.links.map((link) => {
      const linkRuntime = manager.linkRuntimeOf(link.id)
      const capturedRuntime = runningLinkIds
        ? { ...linkRuntime, running: runningLinkIds.has(link.id) }
        : linkRuntime
      return toKskHunterLinkView(link, capturedRuntime)
    }),
    deliveries: [...store.deliveries]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toKskHunterDeliveryView)
  }
}
