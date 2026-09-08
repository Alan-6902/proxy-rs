/**
 * Cursor 账号的后台定时刷新。
 *
 * 用 setTimeout 链而不是 setInterval：一轮刷新要串行打十几条接口，可能跑得比间隔还久，
 * 链式调度保证两轮永不重叠。间隔与开关从账号库的 settings 读，改设置后 reschedule 生效。
 */

import type { CursorAutoRefreshSettings } from '../../shared/cursorAccounts'
import { refreshAllCursorAccounts } from './accountManager'
import { loadCursorAutoRefreshSettings } from './accountStore'

/** 应用启动后先等一会再刷第一轮，别和启动期的其它网络请求抢。 */
const INITIAL_DELAY_MS = 15_000
/** 用户刚打开开关时尽快跑一轮，让人看到它真的在工作。 */
const ENABLE_KICKOFF_DELAY_MS = 3_000

export interface CursorAutoRefreshSchedulerDeps {
  /** 一轮刷新完成后通知渲染层重拉列表。 */
  onRefreshed: () => void
}

export class CursorAutoRefreshScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private started = false

  constructor(private readonly deps: CursorAutoRefreshSchedulerDeps) {}

  async start(): Promise<void> {
    this.started = true
    await this.schedule(INITIAL_DELAY_MS)
  }

  stop(): void {
    this.started = false
    this.clearTimer()
  }

  /** 设置变更后调用：关掉就停表，开着就按新间隔重排（刚开启时几秒内先跑一轮）。 */
  async applySettings(settings: CursorAutoRefreshSettings, justEnabled: boolean): Promise<void> {
    if (!this.started) return
    this.clearTimer()
    if (!settings.enabled) return
    this.arm(justEnabled ? ENABLE_KICKOFF_DELAY_MS : settings.intervalMinutes * 60_000)
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private arm(delayMs: number): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delayMs)
  }

  private async schedule(delayMs?: number): Promise<void> {
    if (!this.started) return
    let settings: CursorAutoRefreshSettings
    try {
      settings = await loadCursorAutoRefreshSettings()
    } catch (error) {
      // 账号库损坏时刷新也跑不了，等用户处理；不反复报错
      console.warn(
        `[CursorAutoRefresh] 读取设置失败，暂停调度: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }
    if (!settings.enabled) return
    this.arm(delayMs ?? settings.intervalMinutes * 60_000)
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    const startedAt = Date.now()
    try {
      const summary = await refreshAllCursorAccounts()
      if (summary.total > 0) {
        console.log(
          `[CursorAutoRefresh] 刷新完成: ${summary.success}/${summary.total} 成功, ${Date.now() - startedAt}ms`
        )
        this.deps.onRefreshed()
      }
    } catch (error) {
      console.warn(
        `[CursorAutoRefresh] 刷新失败: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      this.running = false
      await this.schedule()
    }
  }
}
