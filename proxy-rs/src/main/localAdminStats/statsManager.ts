/**
 * 反代统计的采集调度。
 *
 * 每轮固定间隔（60 秒）拉一次 GET /credentials 取计数，并逐条拉 balance 取用量，
 * 然后往趋势快照追加采样点、把增量并入按小时的消耗桶。
 *
 * 用量为什么可以跟着轮询一起采：实测 kiro-rs 的 balance 有约 300 秒本地缓存
 * （config/kiro_balance_cache.json），60 秒来一轮时绝大多数请求命中缓存、
 * 不打上游；真正落到 AWS 的频率由那个 TTL 决定，与轮询间隔无关。这个接口是
 * 只读计量（AWS UsageLimitsResponse），本身不消耗额度。
 *
 * 不自动采就没有按小时的消耗报表：Admin 只回累计值，历史全靠本地差分攒。
 *
 * 未配置本机 Admin 不是错误：状态标成 unconfigured，页面提示去任务管理配置即可，
 * 不刷错误红条也不重试。
 */

import {
  LOCAL_ADMIN_STATS_MAX_SAMPLES,
  LOCAL_ADMIN_STATS_POLL_INTERVAL_SECONDS,
  LOCAL_ADMIN_STATS_STATE,
  EMPTY_LOCAL_ADMIN_EXHAUSTED_CLEANUP,
  accumulateHourlyUsage,
  aggregateLocalAdminStats,
  selectExhaustedLocalAdminCredentials,
  type LocalAdminCredentialStats,
  type LocalAdminExhaustedCleanupSummary,
  type LocalAdminCredentialUsage,
  type LocalAdminCumulativeCursor,
  type LocalAdminHourlyBucket,
  type LocalAdminStatsSample,
  type LocalAdminStatsSnapshot,
  type LocalAdminStatsStatus,
  type LocalAdminUsageRefreshSummary
} from '../../shared/localAdminStats'
import {
  resolveLocalAdminApiBase,
  type KskAutomationFetch
} from '../kskAutomation/localAdminClient'
import {
  appendLocalAdminStatsSample,
  clearLocalAdminStatsSamples,
  clearLocalAdminUsageBuckets,
  loadLocalAdminStatsState
} from './samplesStore'
import {
  fetchLocalAdminCredentialStats,
  fetchLocalAdminUsage,
  type LocalAdminStatsTarget
} from './statsClient'

/** 未配置 Admin 时的轮询退避：不打请求，只是周期性回看配置有没有填上。 */
const UNCONFIGURED_RECHECK_INTERVAL_MS = 60_000

export interface LocalAdminStatsTargetConfig {
  baseUrl: string
  adminApiKey: string
  timeoutSeconds: number
  /** 采到用量后自动删掉额度耗尽的凭据。未配置时按不自动处理。 */
  autoDeleteExhausted?: boolean
}

export interface LocalAdminStatsManagerDeps {
  /** 读本机 Admin 连接信息；未配置时返回 undefined 而不是抛错 */
  readTarget: () => Promise<LocalAdminStatsTargetConfig | undefined>
  /** 直连 loopback 的 fetch，不走系统代理 */
  fetchImpl: KskAutomationFetch
  /**
   * 删掉额度耗尽的凭据（Admin 与本地账号库两边）。
   *
   * 做成注入而不是在这里直接删：本地账号库归 index.ts 的 store 管，把它拖进统计模块
   * 会让这个模块在测试里没法用假 fetch 跑完整流程。不注入时自动清理整块跳过。
   */
  cleanupExhausted?: (
    credentials: readonly LocalAdminCredentialStats[]
  ) => Promise<LocalAdminExhaustedCleanupSummary>
  notifySnapshot: (snapshot: LocalAdminStatsSnapshot) => void
  log?: (message: string) => void
}

export class LocalAdminStatsManager {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private roundPromise: Promise<void> | null = null
  private usagePromise: Promise<LocalAdminUsageRefreshSummary> | null = null
  private cleanupPromise: Promise<LocalAdminExhaustedCleanupSummary> | null = null
  private lastCleanup: LocalAdminExhaustedCleanupSummary = EMPTY_LOCAL_ADMIN_EXHAUSTED_CLEANUP
  private credentials: LocalAdminCredentialStats[] = []
  private samples: LocalAdminStatsSample[] = []
  private buckets: LocalAdminHourlyBucket[] = []
  private cursors: LocalAdminCumulativeCursor[] = []
  private readonly usageCache = new Map<string, LocalAdminCredentialUsage>()
  private status: LocalAdminStatsStatus = {
    state: LOCAL_ADMIN_STATS_STATE.UNCONFIGURED,
    lastUsageErrorCount: 0
  }

  constructor(private readonly deps: LocalAdminStatsManagerDeps) {}

  snapshot(): LocalAdminStatsSnapshot {
    return {
      status: { ...this.status },
      totals: aggregateLocalAdminStats(this.credentials),
      credentials: this.credentials.map((item) => ({ ...item, alerts: [...item.alerts] })),
      samples: [...this.samples],
      buckets: this.buckets.map((bucket) => ({
        hour: bucket.hour,
        credentials: bucket.credentials.map((item) => ({ ...item }))
      }))
    }
  }

  async start(): Promise<void> {
    this.stop()
    this.stopped = false
    const state = await loadLocalAdminStatsState()
    this.samples = state.samples
    this.buckets = state.buckets
    this.cursors = state.cursors
    this.scheduleNext(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** 立刻抓一轮计数类统计，供页面下拉刷新与打开页面时调用。 */
  async refreshNow(): Promise<LocalAdminStatsSnapshot> {
    this.stopped = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.runRound()
    return this.snapshot()
  }

  /**
   * 手动刷新用量：逐条查余额。并发调用合并到同一次执行，
   * 避免用户连点两下按钮就把上游请求数翻倍。
   */
  async refreshUsageNow(): Promise<LocalAdminUsageRefreshSummary> {
    if (this.usagePromise) return this.usagePromise
    this.usagePromise = this.executeUsageRefresh().finally(() => {
      this.usagePromise = null
    })
    return this.usagePromise
  }

  /**
   * 手动清理额度耗尽的凭据。
   *
   * 先拉一轮用量再判：页面上的用量可能是几分钟前采的，那之后可能已经重置了。
   * balance 有约 300 秒本地缓存，多这一次请求基本不打上游。
   */
  async cleanupExhaustedNow(): Promise<LocalAdminExhaustedCleanupSummary> {
    if (this.cleanupPromise) return this.cleanupPromise
    this.cleanupPromise = this.executeManualCleanup().finally(() => {
      this.cleanupPromise = null
    })
    return this.cleanupPromise
  }

  private async executeManualCleanup(): Promise<LocalAdminExhaustedCleanupSummary> {
    if (!this.deps.cleanupExhausted) throw new Error('当前构建未接入凭据清理能力')
    await this.refreshUsageNow()
    const summary = await this.runExhaustedCleanup(this.credentials)
    return summary ? this.lastCleanup : EMPTY_LOCAL_ADMIN_EXHAUSTED_CLEANUP
  }

  /**
   * 跑一次额度耗尽清理，返回删除后重新抓到的凭据列表（没删任何东西时返回 undefined）。
   *
   * 清理失败不能把整轮采集判成失败：统计本身已经拿到了，标个 lastError 让用户看见即可。
   */
  private async runExhaustedCleanup(
    credentials: readonly LocalAdminCredentialStats[]
  ): Promise<LocalAdminCredentialStats[] | undefined> {
    if (!this.deps.cleanupExhausted) return undefined
    if (selectExhaustedLocalAdminCredentials(credentials).length === 0) return undefined
    try {
      const summary = await this.deps.cleanupExhausted(credentials)
      this.lastCleanup = summary
      this.status = {
        ...this.status,
        lastCleanupAt: Date.now(),
        lastCleanupRemovedCount: summary.removed
      }
      if (summary.removed > 0) {
        this.log(
          `已清理 ${summary.removed} 个额度耗尽的凭据（本地账号 ${summary.removedLocalAccounts} 个）：` +
            summary.removedMaskedKeys.join('、')
        )
      }
      for (const issue of summary.errors) this.log(`清理额度耗尽凭据：${issue}`)
      if (summary.errors.length > 0) {
        this.status = { ...this.status, lastError: summary.errors.join('；') }
      }
      if (summary.removed === 0) return undefined
      // 删完重新抓一遍：不然页面上那几条已删的凭据要等下一轮才消失
      const target = await this.resolveTarget()
      if (!target) return undefined
      return await fetchLocalAdminCredentialStats(target, this.usageCache)
    } catch (error) {
      this.status = { ...this.status, lastError: this.message(error) }
      this.log(`清理额度耗尽凭据失败: ${this.message(error)}`)
      return undefined
    }
  }

  /** 清空本地趋势快照。上游没有历史，清掉就真没了，由调用方做二次确认。 */
  async clearSamples(): Promise<LocalAdminStatsSnapshot> {
    await clearLocalAdminStatsSamples()
    this.samples = []
    this.pushSnapshot()
    return this.snapshot()
  }

  private async resolveTarget(): Promise<LocalAdminStatsTarget | undefined> {
    const config = await this.deps.readTarget()
    if (!config?.adminApiKey.trim() || !config.baseUrl.trim()) return undefined
    return { ...config, fetchImpl: this.deps.fetchImpl }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
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
    let target: LocalAdminStatsTarget | undefined
    try {
      target = await this.resolveTarget()
    } catch (error) {
      this.log(`读取本机 Admin 配置失败: ${this.message(error)}`)
    }

    if (!target) {
      this.credentials = []
      this.status = {
        ...this.status,
        state: LOCAL_ADMIN_STATS_STATE.UNCONFIGURED,
        baseUrl: undefined,
        lastError: undefined
      }
      this.pushSnapshot()
      this.scheduleNext(UNCONFIGURED_RECHECK_INTERVAL_MS)
      return
    }

    // baseUrl 归一化失败（地址填错）算配置问题，不该把它当抓取失败反复重试
    let displayBaseUrl: string
    try {
      displayBaseUrl = resolveLocalAdminApiBase(target.baseUrl)
    } catch (error) {
      this.status = {
        ...this.status,
        state: LOCAL_ADMIN_STATS_STATE.UNCONFIGURED,
        baseUrl: undefined,
        lastError: this.message(error)
      }
      this.pushSnapshot()
      this.scheduleNext(UNCONFIGURED_RECHECK_INTERVAL_MS)
      return
    }

    this.status = {
      ...this.status,
      state: LOCAL_ADMIN_STATS_STATE.RUNNING,
      baseUrl: displayBaseUrl,
      lastAttemptAt: Date.now()
    }
    this.pushSnapshot()

    try {
      let credentials = await fetchLocalAdminCredentialStats(target, this.usageCache)
      this.pruneUsageCache(credentials)

      // 顺带采一轮用量：balance 有约 300 秒本地缓存，60 秒一轮基本都命中缓存。
      // 单条失败不影响计数类结果，所以整段用 try 包住只记日志。
      try {
        const { usage, errors } = await fetchLocalAdminUsage(
          target,
          credentials.map((item) => item.id)
        )
        for (const [id, value] of usage) this.usageCache.set(id, value)
        if (usage.size > 0) {
          credentials = await fetchLocalAdminCredentialStats(target, this.usageCache)
        }
        if (errors.length > 0) {
          this.status = { ...this.status, lastUsageErrorCount: errors.length }
          this.log(`本轮有 ${errors.length} 条用量拉取失败: ${errors[0]}`)
        } else if (usage.size > 0) {
          this.status = { ...this.status, lastUsageRefreshAt: Date.now(), lastUsageErrorCount: 0 }
        }
      } catch (error) {
        this.log(`本轮用量采集失败（计数已正常入库）: ${this.message(error)}`)
      }

      this.credentials = credentials
      /*
       * 差分先记账再清理：删掉的凭据这一小时已经产生的消耗必须留在报表里，
       * 顺序反了那段消耗就查无对证了（accumulateHourlyUsage 只记它当轮看见的凭据）。
       */
      await this.recordSample(credentials)

      /*
       * healthy 先落地，再跑清理：清理的报错要留在 lastError 里，而这里的
       * `lastError: undefined` 会把它抹掉。采集本身已经成功了，顺序不能反。
       */
      this.status = {
        ...this.status,
        state: LOCAL_ADMIN_STATS_STATE.HEALTHY,
        lastSuccessAt: Date.now(),
        lastError: undefined
      }

      if (target.autoDeleteExhausted && this.deps.cleanupExhausted) {
        const remaining = await this.runExhaustedCleanup(credentials)
        if (remaining) {
          this.credentials = remaining
          this.pruneUsageCache(remaining)
        }
      }
    } catch (error) {
      this.status = {
        ...this.status,
        state: LOCAL_ADMIN_STATS_STATE.FAILED,
        lastError: this.message(error)
      }
      this.log(`拉取反代统计失败: ${this.message(error)}`)
    }

    this.pushSnapshot()
    this.scheduleNext(LOCAL_ADMIN_STATS_POLL_INTERVAL_SECONDS * 1000)
  }

  private async executeUsageRefresh(): Promise<LocalAdminUsageRefreshSummary> {
    const target = await this.resolveTarget()
    if (!target) {
      throw new Error(
        '未找到可用的本机 Admin 配置，请先在任务管理里开启「同步到本机 Admin」并填写 Admin API Key'
      )
    }
    // 先抓一轮拿到最新凭据列表，避免对已删除的凭据发余额请求
    const credentials = await fetchLocalAdminCredentialStats(target, this.usageCache)
    this.credentials = credentials
    this.pruneUsageCache(credentials)

    const { usage, errors } = await fetchLocalAdminUsage(
      target,
      credentials.map((item) => item.id)
    )
    for (const [id, value] of usage) this.usageCache.set(id, value)

    // 用量变了，告警与总览都要跟着重算：重跑一次映射比手改字段可靠
    this.credentials = await fetchLocalAdminCredentialStats(target, this.usageCache)
    await this.recordSample(this.credentials)
    this.status = {
      ...this.status,
      state: LOCAL_ADMIN_STATS_STATE.HEALTHY,
      lastSuccessAt: Date.now(),
      lastError: undefined,
      lastUsageRefreshAt: Date.now(),
      lastUsageErrorCount: errors.length
    }
    this.pushSnapshot()
    return { refreshed: usage.size, failed: errors.length, errors }
  }

  /**
   * 追加一个趋势采样点。
   *
   * 落盘失败只记日志：趋势是可再生的观测数据，不该让它把已经抓到的
   * KPI 与凭据明细一起判成采集失败。内存里的 samples 仍然更新，
   * 这样即使磁盘不可写，本次会话的曲线照样能看。
   */
  private async recordSample(credentials: LocalAdminCredentialStats[]): Promise<void> {
    const at = Date.now()
    const sample = this.buildSample(credentials, at)
    // 差分先在内存里算好：即使落盘失败，本次会话的报表也是连续的
    const accumulated = accumulateHourlyUsage({
      buckets: this.buckets,
      cursors: this.cursors,
      credentials,
      at
    })
    this.buckets = accumulated.buckets
    this.cursors = accumulated.cursors
    try {
      const state = await appendLocalAdminStatsSample({
        sample,
        buckets: accumulated.buckets,
        cursors: accumulated.cursors
      })
      this.samples = state.samples
      this.buckets = state.buckets
      this.cursors = state.cursors
    } catch (error) {
      this.samples = [...this.samples, sample].slice(-LOCAL_ADMIN_STATS_MAX_SAMPLES)
      this.log(`趋势采样落盘失败（已保留内存中的曲线）: ${this.message(error)}`)
    }
  }

  /** 清空消耗报表。与清趋势分开：两者粒度不同，用户可能只想清一个。 */
  async clearUsageBuckets(): Promise<LocalAdminStatsSnapshot> {
    await clearLocalAdminUsageBuckets()
    this.buckets = []
    this.cursors = []
    this.pushSnapshot()
    return this.snapshot()
  }

  /** Admin 里已删除的凭据，其用量缓存要一起丢，否则 id 复用时会串数据。 */
  private pruneUsageCache(credentials: LocalAdminCredentialStats[]): void {
    const alive = new Set(credentials.map((item) => item.id))
    for (const id of [...this.usageCache.keys()]) {
      if (!alive.has(id)) this.usageCache.delete(id)
    }
  }

  private buildSample(credentials: LocalAdminCredentialStats[], at: number): LocalAdminStatsSample {
    const totals = aggregateLocalAdminStats(credentials)
    return {
      at,
      successCount: totals.successCount,
      failureCount: totals.failureCount,
      refreshFailureCount: totals.refreshFailureCount,
      credentials: totals.credentials,
      available: totals.available,
      // 没查过用量时不写 0，否则趋势图会出现一段假的「用量归零」
      usageCurrent: totals.usageSampleCount > 0 ? totals.usageCurrent : undefined,
      usageLimit: totals.usageSampleCount > 0 ? totals.usageLimit : undefined,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens
    }
  }

  private pushSnapshot(): void {
    this.deps.notifySnapshot(this.snapshot())
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private log(message: string): void {
    this.deps.log?.(`[LocalAdminStats] ${message}`)
  }
}
