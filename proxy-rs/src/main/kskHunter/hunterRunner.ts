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
  isUsableHunterCredential,
  matchesHunterRegions,
  summarizeHunterSpend,
  type HunterKskCredential,
  type KskHunterBudgetBlock,
  type KskHunterChannel,
  type KskHunterChannelBalance,
  type KskHunterOffer,
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
import {
  KSK_LEDGER_RETIRE_REASON,
  summarizeKskLedger,
  type KskLedgerEntry,
  type KskLedgerReport,
  type KskLedgerSort
} from '../../shared/kskLedger'
import { loadKskLedger, markKskLedgerRetired, recordKskLedgerPurchase } from './ledgerStore'
import { sha256Hex } from '../kskAutomation/localAdminClient'
import {
  appendKskHunterDelivery,
  appendKskHunterSpend,
  patchKskHunterDelivery,
  toKskHunterDeliveryView,
  toKskHunterLinkView,
  toKskHunterSpendEntries,
  type KskHunterLinkRuntime,
  type PersistedKskHunterDelivery,
  type PersistedKskHunterLink,
  type PersistedKskHunterStore
} from './configStore'
import {
  buildOrderRequestBody,
  parseChannelOffers,
  parseOrderedCredential
} from './channelAdapters'
import {
  askDownstreamNeedsAccount,
  pushKskToDownstream,
  type KskHunterFetch
} from './downstreamClient'
import { HunterBalanceCache } from './balanceClient'

/** 抢到号后的入库结果。 */
export interface HunterImportResult {
  added: boolean
}

export interface KskHunterDeps {
  readStore: () => Promise<PersistedKskHunterStore>
  /** 商品站点请求走应用代理。 */
  fetchImpl: KskHunterFetch
  /** 下游是 loopback，必须直连不走代理。 */
  downstreamFetchImpl?: KskHunterFetch
  /** 发消息验活并写入账号库；抛错表示号不可用。 */
  importCredential: (
    input: HunterKskCredential & { groupId?: string }
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
  /** 推送状态快照给渲染进程。 */
  notifySnapshot: () => void
  /** 报表事件流的读写；默认落 userData 下的 JSONL，测试里可换成内存实现。 */
  appendReportEvent?: (event: HunterReportEvent) => Promise<void>
  readReportEvents?: () => Promise<HunterReportEvent[]>
  /**
   * 台账的读写。默认落 userData 下的 JSON，测试里可换成内存实现。
   *
   * 与报表事件流分开注入：事件流只追加，台账要反复更新同一条记录的累计值。
   */
  recordLedgerPurchase?: (entry: KskLedgerEntry) => Promise<void>
  markLedgerRetired?: (input: {
    keyHash: string
    at: number
    reason: (typeof KSK_LEDGER_RETIRE_REASON)[keyof typeof KSK_LEDGER_RETIRE_REASON]
  }) => Promise<void>
  readLedger?: () => Promise<KskLedgerEntry[]>
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

  /** 单号台账报表：成本、存活时长、经本机反代的产出。 */
  async ledgerReport(days?: number, sort?: KskLedgerSort): Promise<KskLedgerReport> {
    const read = this.deps.readLedger ?? loadKskLedger
    return summarizeKskLedger({ entries: await read(), days, sort })
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

  /** 标记台账里某个号下线。同样吞掉写盘错误。 */
  private markLedgerRetired(
    keyHash: string,
    reason: (typeof KSK_LEDGER_RETIRE_REASON)[keyof typeof KSK_LEDGER_RETIRE_REASON]
  ): void {
    const mark = this.deps.markLedgerRetired ?? markKskLedgerRetired
    void mark({ keyHash, at: Date.now(), reason }).catch((error) => {
      this.log(`台账下线标记失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  snapshotStatus(): KskHunterStatus {
    return { ...this.status }
  }

  linkRuntimeOf(linkId: string): KskHunterLinkRuntime {
    return this.linkRuntime.get(linkId) ?? { lastInStock: false }
  }

  async start(): Promise<void> {
    this.stopped = false
    const store = await this.deps.readStore()
    await this.refreshDeliveryCounters(store)
    if (store.links.some((link) => link.enabled)) this.scheduleNext(0)
    else this.status = { ...this.status, state: KSK_HUNTER_STATE.IDLE, running: false }
    this.scheduleDeliveryDrain(0)
    this.deps.notifySnapshot()
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
      const activeLinks = store.links.filter((link) => link.enabled && link.secrets.listUrl)
      if (activeLinks.length === 0) {
        this.status = { ...this.status, state: KSK_HUNTER_STATE.IDLE, running: false }
        return
      }

      // 并行查所有链接；单链接失败不影响其它链接
      const results = await Promise.all(activeLinks.map((link) => this.checkLink(link, store)))
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
      this.deps.notifySnapshot()
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
     * 有的站点要求比全局轮询更长的间隔（如 Kiro CEO 的 30 秒），对这些渠道逐链接节流。
     *
     * 只对**严于全局间隔**的渠道生效：等于全局间隔的渠道不加这道门，否则手动「立即查询」
     * 撞上刚跑完的定时轮询就会静默什么都不做，用户以为按钮坏了。
     * 严格渠道则连手动查询也照样节流——绕过它就是去吃 429。
     *
     * 跳过不算失败：按站点限制节流是正常行为，算失败会把整体状态误判成 DEGRADED。
     */
    const minIntervalMs = KSK_HUNTER_CHANNEL_MIN_INTERVAL_SECONDS[link.channel] * 1000
    if (minIntervalMs > KSK_HUNTER_POLL_INTERVAL_SECONDS * 1000) {
      const lastCheckedAt = this.linkRuntimeOf(link.id).lastCheckedAt
      if (lastCheckedAt !== undefined && Date.now() - lastCheckedAt < minIntervalMs) return true
    }

    // 要求请求头鉴权的渠道没配密钥就别发请求：必然 401，还会把密钥错误伪装成站点故障。
    // 刻意不在 IPC 层硬拦——用户常先加链接再填密钥，硬拦会让人卡在表单上。
    const apiKey = this.channelApiKey(link.channel, store)
    if (KSK_HUNTER_CHANNEL_REQUIRES_API_KEY[link.channel] && !apiKey) {
      this.linkRuntime.set(link.id, {
        ...this.linkRuntimeOf(link.id),
        lastInStock: false,
        lastError: `${KSK_HUNTER_CHANNEL_LABEL[link.channel]} 渠道需要在设置里填写 API Key`
      })
      return false
    }

    this.inFlightLinks.add(link.id)
    try {
      const payload = await this.fetchJson(
        link.secrets.listUrl,
        store.config.requestTimeoutSeconds,
        { method: 'GET', apiKey }
      )
      const offers = parseChannelOffers(link.channel, payload).filter(
        (offer) => offer.stock > 0 && matchesHunterRegions(link.regions, offer.region)
      )
      // 放货只记「无货 → 有货」这一刻：一批货会被连着几十轮都发现，逐轮记会把
      // 事件流刷爆，也会让「放货次数」这个指标失去意义
      const wasInStock = this.linkRuntimeOf(link.id).lastInStock
      // 展开原有 runtime：pendingOrder 必须跨轮保留，整体替换会让下单重试换掉幂等键，
      // 变成第二笔订单（重复扣费）
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
      // 同上：保留 pendingOrder。下单失败正是要复用幂等键的场景
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

  private async orderOne(
    link: PersistedKskHunterLink,
    offer: KskHunterOffer,
    store: PersistedKskHunterStore,
    budget: { costCny: number; costUnit?: number }
  ): Promise<void> {
    const idempotencyKey = this.resolveIdempotencyKey(link.id, offer.goodsId)
    const orderPayload = await this.fetchJson(
      link.secrets.orderUrl,
      store.config.requestTimeoutSeconds,
      {
        method: 'POST',
        body: buildOrderRequestBody(link.channel, offer, { idempotencyKey }),
        apiKey: this.channelApiKey(link.channel, store)
      }
    )
    // 请求成功即弃用这个幂等键：留着会让下一单被服务端当成本单的重放而不发货
    this.clearIdempotencyKey(link.id)
    const credential = parseOrderedCredential(orderPayload, offer.region)
    if (!isUsableHunterCredential(credential)) {
      throw new Error('下单返回的 KSK 或区域不合法')
    }

    this.status = { ...this.status, totalOrdered: this.status.totalOrdered + 1 }
    // 钱已扣，余额缓存立即失效，下一单按真实余额判断
    this.balanceCache.invalidate(link.channel)
    const maskedKey = maskKiroApiKey(credential.key)
    const unitLabel = store.config.billing[link.channel]?.unitLabel

    // 钱已花出去，先落盘再做验活与推送，中途崩了也不会丢号
    const now = Date.now()
    const delivery: PersistedKskHunterDelivery = {
      id: randomUUID(),
      linkId: link.id,
      linkName: link.name,
      channel: link.channel,
      key: credential.key,
      region: credential.region,
      state: KSK_HUNTER_DELIVERY_STATE.PENDING,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      costUnit: budget.costUnit,
      costCny: budget.costCny,
      unitLabel
    }
    await appendKskHunterDelivery(delivery)

    // 钱已经花了，账必须记上。哪怕后面验活失败也算花费——这才是真实支出。
    await appendKskHunterSpend({
      id: randomUUID(),
      channel: link.channel,
      amountUnit: budget.costUnit ?? 0,
      amountCny: budget.costCny,
      at: now
    })

    this.recordReportEvent(HUNTER_REPORT_EVENT.ORDERED, link, {
      region: credential.region,
      costUnit: budget.costUnit,
      costCny: budget.costCny,
      unitLabel
    })

    /*
     * 台账建档。keyHash 用 sha256(明文) —— 与 Admin 的 apiKeyHash 同一算法，
     * 反代采样时靠它把这条采购和后续消耗焊在一起，台账文件里不留明文。
     */
    const keyHash = sha256Hex(credential.key)
    this.recordLedgerPurchase({
      keyHash,
      maskedKey,
      region: credential.region,
      channel: link.channel,
      linkId: link.id,
      linkName: link.name,
      purchasedAt: now,
      costUnit: budget.costUnit,
      costCny: budget.costCny,
      unitLabel,
      usedCredits: 0,
      inputTokens: 0,
      outputTokens: 0,
      successCount: 0,
      failureCount: 0
    })

    if (store.config.notifyOnAutoOrder) {
      this.deps.notifyOrdered({ linkName: link.name, maskedKey, region: credential.region })
    }

    // 验活兼入库：验活失败的号不推给下游，但记录保留供人工处理
    try {
      const result = await this.deps.importCredential({
        ...credential,
        groupId: store.config.targetGroupId
      })
      if (result.added) this.deps.notifyAccountsChanged()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await patchKskHunterDelivery(delivery.id, {
        state: KSK_HUNTER_DELIVERY_STATE.DEAD_KEY,
        lastError: `验活失败：${message}`
      })
      this.recordReportEvent(HUNTER_REPORT_EVENT.DEAD_KEY, link, { region: credential.region })
      // 钱花了号不能用：台账立即标死，别让它挂在「待确认」等宽限期走完
      this.markLedgerRetired(keyHash, KSK_LEDGER_RETIRE_REASON.INVALID)
      this.log(`已购 ${maskedKey} 验活失败，不推送下游：${message}`)
      await this.refreshDeliveryCounters()
      return
    }

    this.scheduleDeliveryDrain(0)
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
    init: { method: string; body?: unknown; apiKey?: string } = { method: 'GET' }
  ): Promise<unknown> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') throw new Error('商品站点接口必须使用 HTTPS')
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
      if (!response.ok) throw new Error(`请求失败: HTTP ${response.status}`)
      return text ? (JSON.parse(text) as unknown) : {}
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
      this.deps.notifySnapshot()
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

  private log(message: string): void {
    ;(this.deps.log ?? ((text) => console.log(text)))(`[KskHunter] ${message}`)
  }
}

/** 组装完整快照，IPC 与事件推送共用。 */
export function buildKskHunterSnapshotParts(
  store: PersistedKskHunterStore,
  manager: KskHunterManager
): {
  links: ReturnType<typeof toKskHunterLinkView>[]
  deliveries: ReturnType<typeof toKskHunterDeliveryView>[]
} {
  return {
    links: store.links.map((link) => toKskHunterLinkView(link, manager.linkRuntimeOf(link.id))),
    deliveries: [...store.deliveries]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toKskHunterDeliveryView)
  }
}
