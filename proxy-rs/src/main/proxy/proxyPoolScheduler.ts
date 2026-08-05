/**
 * 代理池后台定时验活调度器（主进程常驻）
 *
 * 背景：定时验活原先写在渲染进程 ProxyPoolPage 的 useEffect 里，定时器随组件生命周期存在——
 * 用户切走页面组件卸载，定时器就没了；进程重启也不恢复。所谓「后台定时验活」实际只在
 * 用户盯着代理池页面时才跑。搬到主进程后才真正常驻。
 *
 * 职责边界：
 *   - 本模块只负责「何时验活哪些代理」以及「把结果写回 store」
 *   - 实际网络验活复用 validateProxyEntry（与 IPC proxy-pool:validate 同一实现）
 *   - 写盘必须经由注入的 mutate 回调走 accountStoreCoordinator 的同一把锁，
 *     否则会和渲染进程的 saveToStorage 互相覆盖
 */

import type { ProxyEntry, ProxyPoolConfig, ProxyValidationResult } from '../../shared/proxyPool'
import { DEFAULT_PROXY_POOL_CONFIG, applyValidationResult } from '../../shared/proxyPool'

/** 调度器的心跳间隔：每分钟检查一次是否到了该验活的时间点 */
const TICK_INTERVAL_MS = 60_000

/** 单次验活默认超时，与渲染进程/IPC 默认值保持一致 */
const DEFAULT_TIMEOUT_MS = 8_000

/** 默认并发数，与渲染进程 validateProxiesBatch 的默认值保持一致 */
const DEFAULT_CONCURRENCY = 5

/** 调度器读写 store 所需的最小账号数据形状 */
export interface ProxyPoolStoreSlice {
  proxyPool?: Record<string, ProxyEntry>
  proxyPoolConfig?: Partial<ProxyPoolConfig>
}

export interface ProxyPoolSchedulerDeps {
  /**
   * 以独占方式读改写 accountData。实现方需保证与渲染进程 save-accounts 走同一把锁。
   * mutator 返回 null 表示无需写盘。
   */
  mutateStore: (mutator: (data: ProxyPoolStoreSlice) => ProxyPoolStoreSlice | null) => Promise<void>
  /** 只读取当前 accountData 快照，不加写锁 */
  readStore: () => Promise<ProxyPoolStoreSlice | null>
  /** 执行一次真实网络验活 */
  validate: (params: { url: string; testUrl: string; timeoutMs: number; upstreamProxy?: string }) => Promise<ProxyValidationResult>
  /** 验活结果落盘后通知渲染进程刷新 UI */
  notifyRenderer: (payload: { entries: ProxyEntry[] }) => void
  /** 代理可用性变化后，同步绑定该代理的账号在反代账号池里的 proxyUrl */
  syncBoundAccounts: (proxyId: string) => void
  log?: (message: string) => void
}

export class ProxyPoolScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastRunAt = 0
  /** 防重入：一轮验活未跑完时下一次 tick 直接跳过 */
  private running = false

  constructor(private readonly deps: ProxyPoolSchedulerDeps) {}

  /**
   * 从 store 读取配置并按需启动。autoValidateIntervalMin <= 0 时保持停止状态。
   * 幂等：重复调用先停旧的再按新配置起。
   */
  async start(): Promise<void> {
    this.stop()
    const data = await this.deps.readStore()
    const config = { ...DEFAULT_PROXY_POOL_CONFIG, ...(data?.proxyPoolConfig || {}) }
    if (!config.autoValidateIntervalMin || config.autoValidateIntervalMin <= 0) {
      this.log('Auto-validate disabled')
      return
    }
    this.timer = setInterval(() => { void this.tick() }, TICK_INTERVAL_MS)
    // Electron 主进程里 setInterval 返回 Node Timeout，unref 避免定时器把进程留住
    this.timer.unref?.()
    this.log(`Auto-validate scheduled every ${config.autoValidateIntervalMin} min`)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 配置变更后重启调度（渲染进程改了 autoValidateIntervalMin 时调用） */
  async restart(): Promise<void> {
    await this.start()
  }

  get isRunning(): boolean {
    return this.timer !== null
  }

  /**
   * 到点则跑一轮验活。间隔判定放在 tick 里而不是靠 setInterval 的周期，
   * 这样改配置不必重算下次触发时间，且不会因为进程睡眠错过整个周期。
   *
   * 公开以便测试直接驱动一次心跳，无需等真实的 60s。
   */
  async tick(): Promise<void> {
    if (this.running) return
    const data = await this.deps.readStore()
    const config = { ...DEFAULT_PROXY_POOL_CONFIG, ...(data?.proxyPoolConfig || {}) }
    const intervalMin = config.autoValidateIntervalMin
    if (!intervalMin || intervalMin <= 0) {
      // 配置在运行期间被关掉了，自行停表
      this.stop()
      return
    }
    if (Date.now() - this.lastRunAt < intervalMin * 60_000) return
    this.lastRunAt = Date.now()
    await this.runOnce(config, data)
  }

  /** 立即跑一轮验活（供 tick 与手动触发共用） */
  async runOnce(configOverride?: ProxyPoolConfig, dataOverride?: ProxyPoolStoreSlice | null): Promise<number> {
    if (this.running) return 0
    this.running = true
    try {
      const data = dataOverride !== undefined ? dataOverride : await this.deps.readStore()
      const config = configOverride || { ...DEFAULT_PROXY_POOL_CONFIG, ...(data?.proxyPoolConfig || {}) }
      const pool = data?.proxyPool || {}
      const targets = Object.values(pool).filter((p) => p && p.enabled)
      if (targets.length === 0) return 0

      this.log(`Auto-validate ${targets.length} proxies`)
      const concurrency = Math.max(1, Math.min(config.autoValidateConcurrency || DEFAULT_CONCURRENCY, targets.length))
      const results = new Map<string, ProxyValidationResult>()

      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < targets.length) {
          const entry = targets[cursor++]
          try {
            const result = await this.deps.validate({
              url: entry.url,
              testUrl: config.testUrl || DEFAULT_PROXY_POOL_CONFIG.testUrl,
              timeoutMs: config.testTimeoutMs || DEFAULT_TIMEOUT_MS,
              upstreamProxy: config.upstreamProxy
            })
            results.set(entry.id, result)
          } catch (err) {
            results.set(entry.id, { success: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()))
      if (results.size === 0) return 0

      // 结果统一在写锁内应用：以盘上最新的 proxyPool 为基准，避免覆盖验活期间
      // 渲染进程的增删改（例如用户手动删了某条代理）
      const updated: ProxyEntry[] = []
      await this.deps.mutateStore((current) => {
        const currentPool = current.proxyPool || {}
        const currentConfig = { ...DEFAULT_PROXY_POOL_CONFIG, ...(current.proxyPoolConfig || {}) }
        const nextPool: Record<string, ProxyEntry> = { ...currentPool }
        let changed = false
        for (const [id, result] of results) {
          const existing = nextPool[id]
          if (!existing) continue // 验活期间被删除，丢弃该结果
          const next = applyValidationResult(existing, result, currentConfig, Object.values(currentPool))
          nextPool[id] = next
          updated.push(next)
          changed = true
        }
        if (!changed) return null
        return { ...current, proxyPool: nextPool }
      })

      if (updated.length > 0) {
        this.deps.notifyRenderer({ entries: updated })
        // 状态变化（alive/slow/dead、enabled）会影响绑定账号能否走该代理
        for (const entry of updated) this.deps.syncBoundAccounts(entry.id)
      }
      return updated.length
    } finally {
      this.running = false
    }
  }

  private log(message: string): void {
    this.deps.log?.(`[ProxyPoolScheduler] ${message}`)
  }
}
