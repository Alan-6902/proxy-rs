/**
 * 反代统计的采集调度。
 *
 * 计数类免费，所以固定间隔轮询 GET /credentials，顺手往趋势快照里追加一个采样点。
 * 用量类会打上游 AWS，只在 refreshUsageNow 被显式调用（用户点按钮）时逐条串行拉，
 * 拉到的用量缓存在内存里，后续轮询继续挂在凭据上，直到用户再刷新一次。
 *
 * 未配置本机 Admin 不是错误：状态标成 unconfigured，页面提示去任务管理配置即可，
 * 不刷错误红条也不重试。
 */

import {
  LOCAL_ADMIN_STATS_MAX_SAMPLES,
  LOCAL_ADMIN_STATS_POLL_INTERVAL_SECONDS,
  LOCAL_ADMIN_STATS_STATE,
  aggregateLocalAdminStats,
  type LocalAdminCredentialStats,
  type LocalAdminCredentialUsage,
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
  loadLocalAdminStatsSamples
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
}

export interface LocalAdminStatsManagerDeps {
  /** 读本机 Admin 连接信息；未配置时返回 undefined 而不是抛错 */
  readTarget: () => Promise<LocalAdminStatsTargetConfig | undefined>
  /** 直连 loopback 的 fetch，不走系统代理 */
  fetchImpl: KskAutomationFetch
  notifySnapshot: (snapshot: LocalAdminStatsSnapshot) => void
  log?: (message: string) => void
}

export class LocalAdminStatsManager {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private roundPromise: Promise<void> | null = null
  private usagePromise: Promise<LocalAdminUsageRefreshSummary> | null = null
  private credentials: LocalAdminCredentialStats[] = []
  private samples: LocalAdminStatsSample[] = []
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
      samples: [...this.samples]
    }
  }

  async start(): Promise<void> {
    this.stop()
    this.stopped = false
    this.samples = await loadLocalAdminStatsSamples()
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
      const credentials = await fetchLocalAdminCredentialStats(target, this.usageCache)
      this.credentials = credentials
      this.pruneUsageCache(credentials)
      await this.recordSample(credentials)
      this.status = {
        ...this.status,
        state: LOCAL_ADMIN_STATS_STATE.HEALTHY,
        lastSuccessAt: Date.now(),
        lastError: undefined
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
    const sample = this.buildSample(credentials)
    try {
      this.samples = await appendLocalAdminStatsSample(sample)
    } catch (error) {
      this.samples = [...this.samples, sample].slice(-LOCAL_ADMIN_STATS_MAX_SAMPLES)
      this.log(`趋势采样落盘失败（已保留内存中的曲线）: ${this.message(error)}`)
    }
  }

  /** Admin 里已删除的凭据，其用量缓存要一起丢，否则 id 复用时会串数据。 */
  private pruneUsageCache(credentials: LocalAdminCredentialStats[]): void {
    const alive = new Set(credentials.map((item) => item.id))
    for (const id of [...this.usageCache.keys()]) {
      if (!alive.has(id)) this.usageCache.delete(id)
    }
  }

  private buildSample(credentials: LocalAdminCredentialStats[]): LocalAdminStatsSample {
    const totals = aggregateLocalAdminStats(credentials)
    return {
      at: Date.now(),
      successCount: totals.successCount,
      failureCount: totals.failureCount,
      refreshFailureCount: totals.refreshFailureCount,
      credentials: totals.credentials,
      available: totals.available,
      // 没查过用量时不写 0，否则趋势图会出现一段假的「用量归零」
      usageCurrent: totals.usageSampleCount > 0 ? totals.usageCurrent : undefined,
      usageLimit: totals.usageSampleCount > 0 ? totals.usageLimit : undefined
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
