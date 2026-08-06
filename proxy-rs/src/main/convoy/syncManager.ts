/**
 * 自动车凭证同步器（方案第 4、6、11 节）
 *
 * 每轮固定延迟执行：概览预检 → 计费门禁 → 完整拉取 → 校验 → 原子替换 → 注入账号池。
 * fixed-delay 而非 fixed-rate：上一轮没跑完绝不开下一轮，避免任务重叠重复计费。
 *
 * 单实例：本应用是 Electron 桌面端，已有 app.requestSingleInstanceLock() 保证
 * 同机只有一个进程，所以不需要 Redis/Lease 那套分布式锁。进程内用 running 标志
 * 防重入即可；快照写入仍按 fetchedAt 做单调校验（见 ConvoySnapshotStore），
 * 万一并发也不会让旧响应覆盖新响应。
 */

import {
  CONVOY_STATE,
  DEFAULT_CONVOY_SYNC_CONFIG,
  MIN_POLL_INTERVAL_SECONDS,
  backoffDelayMs,
  checkBaseUrlSecurity,
  evaluateBillingGuard,
  maskSecretTail,
  sanitizeConvoyKey,
  type ConvoySyncConfig,
  type ConvoySyncStatus,
  type ManualConvoyKey,
  type ManualConvoyKeyResult
} from '../../shared/convoyCredentials'
import { CONVOY_ERROR, ConvoyClientError, ConvoyCredentialClient, type ConvoyFetch } from './client'
import { ConvoyHealthReporter } from './health'
import { probeKeyRegion, toManualKeyResult, type RegionVerifier } from './regionProbe'
import {
  ConvoySnapshotStore,
  SnapshotContractError,
  buildSnapshot,
  toSnapshotView,
  usableCredentials
} from './snapshot'

export interface ConvoySyncManagerDeps {
  /** 读取当前配置（用户可在 UI 改，每轮重新读） */
  readConfig: () => Promise<ConvoySyncConfig>
  /** 读取登录 Key（加密存储，只在主进程内解密） */
  readConvoyKey: () => Promise<string>
  /** 注入的 fetch，走应用统一代理逻辑 */
  fetchImpl: ConvoyFetch
  /** 用指定区域验活一把 Kiro API Key，用于区域探测 */
  verifyKeyRegion: RegionVerifier
  /** 快照变化后把凭证注入反代账号池 */
  applyToAccountPool: (input: {
    /** 自动车拉取的凭证 */
    credentials: { id: string; apiKey?: string; accessToken?: string; region?: string; expiresAt?: number }[]
    /** 手填并探测成功的 Key */
    manualKeys: { id: string; apiKey: string; region: string; email?: string }[]
  }) => void
  /** 状态变化后推送给渲染进程 */
  notifyStatus: (status: ConvoySyncStatus) => void
  log?: (message: string) => void
}

export class ConvoySyncManager {
  private readonly store = new ConvoySnapshotStore()
  private readonly health: ConvoyHealthReporter
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 防重入：上一轮未结束时不开新一轮 */
  private running = false
  private stopped = true
  private nextRunAt?: number
  /** 已成功取得明文的凭证 ID，用于计费预检识别「新凭证」 */
  private readonly acquiredCredentialIds = new Set<string>()
  /** 手填 Key 及其探测结果 */
  private manualKeys: ManualConvoyKey[] = []
  private manualResults: ManualConvoyKeyResult[] = []
  private pendingInitialEstimate?: { credentialCount: number; estimatedChargeCents: number }
  /** 已提示过明文 HTTP 的 baseUrl，避免每轮重复告警 */
  private insecureHttpNotifiedFor?: string
  /** 最近一次读到的轮询间隔（毫秒），用于安排下一轮 */
  private pollIntervalMs = DEFAULT_CONVOY_SYNC_CONFIG.pollIntervalSeconds * 1000

  constructor(private readonly deps: ConvoySyncManagerDeps) {
    this.health = new ConvoyHealthReporter(deps.log ?? ((message) => console.log(message)))
  }

  /** 当前快照（主进程内部消费，含明文） */
  get snapshot(): ConvoySnapshotStore['snapshot'] {
    return this.store.snapshot
  }

  /**
   * 按配置启动轮询。幂等：重复调用先停旧定时器。
   * enabled=false 或未配置登录 Key 时进入 idle，不发任何请求。
   */
  async start(): Promise<void> {
    this.stop()
    this.stopped = false
    const config = await this.deps.readConfig()
    const convoyKey = await this.deps.readConvoyKey()

    if (!config.enabled || !convoyKey.trim()) {
      this.health.markIdle()
      // 手填 Key 与自动车拉取相互独立：自动车没开也要把手填的注进池子
      this.applyToPool()
      this.pushStatus()
      return
    }

    const securityIssue = checkBaseUrlSecurity(config.baseUrl, config.allowInsecureHttp)
    if (securityIssue) {
      this.health.markFailure(securityIssue)
      this.applyToPool()
      this.pushStatus()
      return
    }

    this.pollIntervalMs = this.effectiveIntervalSeconds(config) * 1000
    this.log(`轮询启动：间隔 ${this.pollIntervalMs / 1000}s`)
    this.scheduleNext(0)
    this.pushStatus()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.nextRunAt = undefined
  }

  /** 配置变更后重启调度 */
  async restart(): Promise<void> {
    await this.start()
  }

  get isScheduled(): boolean {
    return this.timer !== null
  }

  /** 立即跑一轮（UI「立即同步」按钮）。返回本轮是否成功更新了快照 */
  async runOnce(): Promise<{ success: boolean; error?: string }> {
    if (this.running) return { success: false, error: '上一轮同步尚未结束' }
    this.running = true
    try {
      return await this.executeRound()
    } finally {
      this.running = false
      this.pushStatus()
    }
  }

  /** 替换手填 Key 列表并逐条探测区域，探测成功的注入账号池 */
  async setManualKeys(keys: ManualConvoyKey[]): Promise<ManualConvoyKeyResult[]> {
    this.manualKeys = keys
      .map((entry) => ({
        id: entry.id,
        // 与登录 Key 同样清洗：粘贴带入的零宽字符会让上游直接拒绝
        key: sanitizeConvoyKey(entry.key),
        region: entry.region?.trim().toLowerCase() || undefined
      }))
      .filter((entry) => entry.key.length > 0)

    const results: ManualConvoyKeyResult[] = []
    for (const entry of this.manualKeys) {
      const probe = await probeKeyRegion(entry.key, entry.region, this.deps.verifyKeyRegion)
      results.push(toManualKeyResult(entry.id, entry.key, probe))
    }
    this.manualResults = results
    this.applyToPool()
    this.pushStatus()
    return results
  }

  /** 清空手填 Key（同时从账号池摘掉） */
  clearManualKeys(): void {
    this.manualKeys = []
    this.manualResults = []
    this.applyToPool()
    this.pushStatus()
  }

  /** 登录 Key 变更或用户停用时清空快照，避免继续分配已不该用的凭证 */
  clearSnapshot(): void {
    this.store.clear()
    this.acquiredCredentialIds.clear()
    this.pendingInitialEstimate = undefined
    this.applyToPool()
    this.pushStatus()
  }

  /** 组装对外状态（已脱敏） */
  async buildStatus(): Promise<ConvoySyncStatus> {
    const config = await this.deps.readConfig().catch(() => DEFAULT_CONVOY_SYNC_CONFIG)
    const convoyKey = await this.deps.readConvoyKey().catch(() => '')
    return this.composeStatus(config, convoyKey)
  }

  // ---- 内部实现 ----

  /** 一轮完整同步。异常全部在内部转成状态，不向调度器抛 */
  private async executeRound(): Promise<{ success: boolean; error?: string }> {
    const now = Date.now()
    this.health.markAttempt(now)

    let config: ConvoySyncConfig
    let convoyKey: string
    try {
      config = await this.deps.readConfig()
      convoyKey = await this.deps.readConvoyKey()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.health.markFailure(`读取同步配置失败: ${message}`, now)
      return { success: false, error: message }
    }

    if (!config.enabled || !convoyKey.trim()) {
      this.health.markIdle()
      return { success: false, error: '同步未启用或未配置登录 Key' }
    }

    const securityIssue = checkBaseUrlSecurity(config.baseUrl, config.allowInsecureHttp)
    if (securityIssue) {
      this.health.markFailure(securityIssue, now)
      return { success: false, error: securityIssue }
    }
    // 明文 HTTP 已被显式放行：每次 baseUrl 变化提示一次高优先级安全告警
    if (config.baseUrl.startsWith('http://') && this.insecureHttpNotifiedFor !== config.baseUrl) {
      this.insecureHttpNotifiedFor = config.baseUrl
      this.health.markInsecureHttp(config.baseUrl, now)
    }

    // 超过两个周期没成功：先报陈旧告警，再继续尝试
    const lastSuccessAt = this.health.snapshotStatusFields().lastSuccessAt
    const intervalSeconds = this.effectiveIntervalSeconds(config)
    this.pollIntervalMs = intervalSeconds * 1000
    if (lastSuccessAt && now - lastSuccessAt > intervalSeconds * 2 * 1000) {
      this.health.markSnapshotStale(intervalSeconds, now)
    }

    const client = new ConvoyCredentialClient({
      baseUrl: config.baseUrl,
      convoyKey,
      requestTimeoutSeconds: config.requestTimeoutSeconds,
      allowInsecureHttp: config.allowInsecureHttp,
      fetchImpl: this.deps.fetchImpl
    })

    try {
      const summary = await client.fetchSummary()
      if (!summary.onBoard) {
        this.health.markNotOnBoard(now)
        // 未上车不清空快照，但过期条目会在 applyToPool 时自然被过滤掉
        this.applyToPool()
        return { success: false, error: '当前不在自动车上' }
      }

      const activeIds = summary.credentialSummary
        .filter((item) => item.status === 'active' && item.credentialId)
        .map((item) => item.credentialId)
      const estimatedNewIds = activeIds.filter((id) => !this.acquiredCredentialIds.has(id))

      const decision = evaluateBillingGuard({
        estimatedNewCount: estimatedNewIds.length,
        farePerCredentialCents: summary.farePerCredentialCents,
        todayChargedCents: this.health.todayChargedCents,
        hasAcquiredHistory: this.acquiredCredentialIds.size > 0,
        config
      })
      if (!decision.allowed) {
        this.pendingInitialEstimate = {
          credentialCount: estimatedNewIds.length,
          estimatedChargeCents: decision.estimatedChargeCents
        }
        this.health.markBlocked(decision.reason || '计费门禁阻断', now)
        return { success: false, error: decision.reason }
      }
      this.pendingInitialEstimate = undefined

      // 门禁通过：这一步可能真实计费
      const response = await client.fetchCredentials()
      const { snapshot, rejected } = buildSnapshot(response, Date.now())

      if (!this.store.replaceSnapshot(snapshot)) {
        // 候选快照比当前更旧，丢弃（并发兜底），不算失败
        this.log('候选快照较旧，已丢弃')
        return { success: false, error: '候选快照较旧，已丢弃' }
      }

      for (const credential of snapshot.credentials) {
        if (credential.apiKey || credential.accessToken) this.acquiredCredentialIds.add(credential.id)
      }

      this.applyToPool()
      this.health.markSuccess({
        at: snapshot.fetchedAt,
        activeCount: usableCredentials(snapshot, snapshot.fetchedAt).length,
        versionShort: snapshot.version.slice(0, 8),
        newlyChargedCount: snapshot.newlyChargedCount,
        totalChargedCents: snapshot.totalChargedCents,
        balanceAfterCents: snapshot.balanceAfterCents,
        insufficientCount: snapshot.insufficientCount,
        minBalanceAlertCents: config.minBalanceAlertCents
      })
      if (rejected.length > 0) {
        this.log(`本轮 ${rejected.length} 个条目未进入可分配池：${rejected.map((r) => `${r.credentialId}(${r.reason})`).join(', ')}`)
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: this.handleRoundError(err, now) }
    }
  }

  /** 把异常映射成状态迁移，返回脱敏后的错误描述 */
  private handleRoundError(err: unknown, at: number): string {
    if (err instanceof SnapshotContractError) {
      // 契约违规：拒绝整个候选快照，旧快照保持不动
      this.health.markFailure(`候选快照被拒绝: ${err.message}`, at)
      return err.message
    }
    if (err instanceof ConvoyClientError) {
      switch (err.kind) {
        case CONVOY_ERROR.UNAUTHORIZED:
        case CONVOY_ERROR.FORBIDDEN:
          this.health.markUnauthorized(err.message, at)
          return err.message
        case CONVOY_ERROR.NOT_ON_BOARD:
          this.health.markNotOnBoard(at)
          return err.message
        case CONVOY_ERROR.RATE_LIMITED:
          this.health.markFailure(err.message, at)
          // 429 遵循 Retry-After：直接改写下一轮时间，不走常规退避
          if (err.retryAfterMs) this.scheduleNext(err.retryAfterMs)
          return err.message
        default:
          this.health.markFailure(err.message, at)
          return err.message
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    this.health.markFailure(message, at)
    return message
  }

  /** 安排下一轮。delayMs 省略时按状态决定：正常用轮询间隔，失败用退避 */
  private scheduleNext(delayMs?: number): void {
    if (this.stopped) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    const resolvedDelay = delayMs ?? this.resolveDelayMs()
    this.nextRunAt = Date.now() + resolvedDelay
    this.timer = setTimeout(() => {
      void (async () => {
        if (this.stopped) return
        if (this.running) {
          // 理论上不会发生（fixed-delay），兜底重排
          this.scheduleNext()
          return
        }
        this.running = true
        try {
          await this.executeRound()
        } finally {
          this.running = false
          this.pushStatus()
          this.scheduleNext()
        }
      })()
    }, resolvedDelay)
    this.timer.unref?.()
  }

  private resolveDelayMs(): number {
    const failures = this.health.failures
    if (failures > 0) return backoffDelayMs(failures)
    // 未上车 / 门禁阻断都是稳定状态，按常规间隔复查即可
    return this.pollIntervalMs
  }

  /** 归一化轮询间隔，低于接口冷却时间的配置一律抬到下限 */
  private effectiveIntervalSeconds(config: ConvoySyncConfig): number {
    return Math.max(MIN_POLL_INTERVAL_SECONDS, Math.floor(config.pollIntervalSeconds) || 0)
  }

  /** 把快照与手填 Key 一起交给账号池注入回调 */
  private applyToPool(): void {
    const now = Date.now()
    const credentials = usableCredentials(this.store.snapshot, now).map((credential) => ({
      id: credential.id,
      apiKey: credential.apiKey,
      accessToken: credential.accessToken,
      region: credential.region,
      expiresAt: credential.expiresAt
    }))

    const manualKeys: { id: string; apiKey: string; region: string; email?: string }[] = []
    for (const result of this.manualResults) {
      if (!result.ok || !result.resolvedRegion) continue
      const source = this.manualKeys.find((entry) => entry.id === result.id)
      if (!source) continue
      manualKeys.push({
        id: result.id,
        apiKey: source.key,
        region: result.resolvedRegion,
        email: result.email
      })
    }

    try {
      this.deps.applyToAccountPool({ credentials, manualKeys })
    } catch (err) {
      this.log(`注入账号池失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private composeStatus(config: ConvoySyncConfig, convoyKey: string): ConvoySyncStatus {
    const fields = this.health.snapshotStatusFields()
    return {
      state: config.enabled ? fields.state : CONVOY_STATE.IDLE,
      enabled: config.enabled,
      hasConvoyKey: Boolean(convoyKey.trim()),
      convoyKeyTail: convoyKey.trim() ? maskSecretTail(convoyKey.trim()) : undefined,
      lastAttemptAt: fields.lastAttemptAt,
      lastSuccessAt: fields.lastSuccessAt,
      consecutiveFailures: fields.consecutiveFailures,
      lastError: fields.lastError,
      nextRunAt: this.nextRunAt,
      todayChargedCents: fields.todayChargedCents,
      todayChargeDate: fields.todayChargeDate,
      totalNewlyChargedCount: fields.totalNewlyChargedCount,
      balanceAfterCents: fields.balanceAfterCents,
      blockedReason: fields.blockedReason,
      pendingInitialEstimate: this.pendingInitialEstimate,
      snapshot: toSnapshotView(this.store.snapshot),
      manualKeys: this.manualResults,
      alerts: fields.alerts
    }
  }

  /** 推送状态给渲染进程；读配置失败不该影响主流程 */
  private pushStatus(): void {
    void this.buildStatus()
      .then((status) => this.deps.notifyStatus(status))
      .catch((err) => this.log(`推送状态失败: ${err instanceof Error ? err.message : String(err)}`))
  }

  private log(message: string): void {
    ;(this.deps.log ?? ((text: string) => console.log(text)))(`[ConvoySync] ${message}`)
  }
}
